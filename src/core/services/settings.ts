// Named settings (the 600+ `set` variables of the firmware CLI).
//
// Fast path: MSP2_CLI_SETTING / MSP2_CLI_SETTING_INFO (one MSP round trip per
// setting). Fallback for stock firmware: the CLI `get` command over the CliRunner.
// Every write validates against the setting's metadata first, skips unchanged values
// (idempotent), and reads the value back to verify.

import type { Session } from "../session.js";
import { MSP } from "../msp/codes.js";
import { PayloadReader } from "../msp/bytes.js";
import { BfError, ExitCode, validationError } from "../errors.js";

export type SettingScope = "global" | "pid_profile" | "rate_profile" | "battery_profile";

export interface SettingInfo {
    name: string;
    type: string;
    min?: number;
    max?: number;
    values?: string[];
    length?: number;
    minLength?: number;
    maxLength?: number;
    default?: string;
    scope?: SettingScope;
}

export interface SettingValue {
    name: string;
    value: string;
    scope?: SettingScope;
}

export interface Change {
    key: string;
    from: string;
    to: string;
}

export interface WriteResult {
    changed: Change[];
    unchanged: string[];
    dryRun: boolean;
    saved: boolean;
    rebootRequired?: boolean;
}

/** Parse the text of a CLI `get` command into entries. */
export function parseGetOutput(text: string): (SettingValue & { range?: string; allowed?: string[]; arrayLength?: number; default?: string })[] {
    const out: (SettingValue & { range?: string; allowed?: string[]; arrayLength?: number; default?: string })[] = [];
    let cur: (typeof out)[number] | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        let m: RegExpExecArray | null;
        if ((m = /^([a-z0-9_]+) = (.*)$/i.exec(line))) {
            cur = { name: m[1], value: m[2].trim(), scope: "global" };
            out.push(cur);
        } else if (!cur) {
            continue;
        } else if (/^profile \d+$/.test(line)) cur.scope = "pid_profile";
        else if (/^rateprofile \d+$/.test(line)) cur.scope = "rate_profile";
        else if (/^battery_profile \d+$/.test(line)) cur.scope = "battery_profile";
        else if ((m = /^Allowed range: (-?\d+) - (-?\d+)$/.exec(line))) cur.range = `${m[1]}..${m[2]}`;
        else if ((m = /^Allowed values: (.*)$/.exec(line))) cur.allowed = m[1].split(", ").map((s) => s.trim());
        else if ((m = /^Array length: (\d+)$/.exec(line))) cur.arrayLength = Number(m[1]);
        else if ((m = /^Default value: (.*)$/.exec(line))) cur.default = m[1].trim();
    }
    return out;
}

function parseInfoText(name: string, text: string): SettingInfo {
    const kv = Object.fromEntries(
        text
            .split("\n")
            .filter(Boolean)
            .map((l) => {
                const i = l.indexOf("=");
                return [l.slice(0, i), l.slice(i + 1)];
            }),
    );
    const num = (k: string) => (kv[k] !== undefined ? Number(kv[k]) : undefined);
    return {
        name,
        type: kv.type,
        min: num("min"),
        max: num("max"),
        values: kv.values ? kv.values.split(",") : undefined,
        length: num("length"),
        minLength: num("minlength"),
        maxLength: num("maxlength"),
        default: kv.default,
    };
}

export class SettingsService {
    private infoCache = new Map<string, SettingInfo>();
    private msp2Settings?: boolean;

    constructor(private readonly s: Session) {}

    private async hasMsp2Settings(): Promise<boolean> {
        if (this.msp2Settings === undefined) {
            const frame = await this.s.client.exclusive(() =>
                this.s.client.requestFrameUnlocked(MSP.MSP2_CLI_SETTING, [...Buffer.from("pid_process_denom", "latin1")], { retries: 1 }),
            );
            this.msp2Settings = !frame.error;
        }
        return this.msp2Settings;
    }

    /** All settings whose name contains `filter` (all settings when empty), via CLI `get`. */
    async list(filter = ""): Promise<SettingValue[]> {
        const r = await this.s.cli.exec(`get ${filter}`.trim(), { timeoutMs: 30000 });
        if (r.errors.length && !/^[a-z0-9_]* = /m.test(r.output)) return [];
        return parseGetOutput(r.output).map(({ name, value, scope }) => ({ name, value, scope }));
    }

    async get(name: string): Promise<SettingValue> {
        const n = name.trim().toLowerCase();
        if (!/^[a-z0-9_]+$/.test(n)) throw validationError(`invalid setting name '${name}'`);
        if (await this.hasMsp2Settings()) {
            const frame = await this.s.client.exclusive(() => this.s.client.requestFrameUnlocked(MSP.MSP2_CLI_SETTING, [...Buffer.from(n, "latin1")]));
            if (!frame.error) {
                const m = /^([^=]+?) = (.*)$/s.exec(Buffer.from(frame.payload).toString("latin1"));
                if (m) return { name: m[1].trim(), value: m[2].trim() };
            }
            throw await this.unknownSetting(n);
        }
        const r = await this.s.cli.exec(`get ${n}`);
        const hit = parseGetOutput(r.output).find((e) => e.name === n);
        if (!hit) throw await this.unknownSetting(n);
        return { name: hit.name, value: hit.value, scope: hit.scope };
    }

    async getMany(names: string[]): Promise<SettingValue[]> {
        const out: SettingValue[] = [];
        for (const n of names) out.push(await this.get(n));
        return out;
    }

    async info(name: string): Promise<SettingInfo> {
        const n = name.trim().toLowerCase();
        const cached = this.infoCache.get(n);
        if (cached) return cached;
        let info: SettingInfo | undefined;
        if (await this.hasMsp2Settings()) {
            info = await this.s.client.exclusive(async () => {
                let text = "";
                let total = Infinity;
                while (text.length < total) {
                    const req = [...Buffer.from(n, "latin1"), 0, text.length & 0xff, (text.length >> 8) & 0xff];
                    const frame = await this.s.client.requestFrameUnlocked(MSP.MSP2_CLI_SETTING_INFO, req);
                    if (frame.error) return undefined;
                    const r = new PayloadReader(frame.payload);
                    total = r.u16();
                    const chunk = r.restStr();
                    if (!chunk) break;
                    text += chunk;
                }
                return parseInfoText(n, text);
            });
        }
        // CLI `get` adds what SETTING_INFO lacks (scope), and is the only source on stock firmware.
        const r = await this.s.cli.exec(`get ${n}`);
        const hit = parseGetOutput(r.output).find((e) => e.name === n);
        if (!hit) throw await this.unknownSetting(n);
        if (!info) {
            const [min, max] = hit.range?.split("..").map(Number) ?? [];
            const isArray = hit.arrayLength !== undefined;
            info = {
                name: n,
                type: hit.allowed ? "lookup" : isArray ? "array" : hit.range ? "number" : "string",
                min,
                max,
                values: hit.allowed,
                length: hit.arrayLength,
                default: hit.default ?? hit.value,
            };
        }
        info.scope = hit.scope;
        this.infoCache.set(n, info);
        return info;
    }

    private async unknownSetting(name: string): Promise<BfError> {
        let suggestions: string[] = [];
        try {
            const parts = name.split("_").filter((p) => p.length > 2);
            for (const p of parts) {
                suggestions.push(...(await this.list(p)).map((s) => s.name));
                if (suggestions.length > 20) break;
            }
            suggestions = [...new Set(suggestions)].slice(0, 10);
        } catch {
            /* best effort */
        }
        return validationError(
            `unknown setting '${name}'`,
            suggestions.length ? `did you mean: ${suggestions.join(", ")}` : "list settings with `bf setting list --filter <text>`",
            { suggestions },
        );
    }

    /** Validate and canonicalize a value against setting metadata. */
    normalize(info: SettingInfo, raw: string | number | boolean): string {
        let v = String(raw).trim();
        const t = info.type;
        if (info.values) {
            if (typeof raw === "boolean") v = raw ? "ON" : "OFF";
            const hit = info.values.find((x) => x.toLowerCase() === v.toLowerCase());
            if (!hit) throw validationError(`invalid value '${v}' for ${info.name}`, `allowed values: ${info.values.join(", ")}`, { allowed: info.values });
            return hit;
        }
        if (t?.endsWith("[]") || t === "array") {
            const parts = v.split(/[,\s]+/).filter(Boolean);
            if (info.length !== undefined && parts.length !== info.length)
                throw validationError(`${info.name} needs ${info.length} comma-separated values, got ${parts.length}`);
            if (parts.some((p) => !/^-?\d+$/.test(p))) throw validationError(`${info.name} takes integers only`);
            return parts.join(",");
        }
        if (t === "string") {
            if (info.maxLength !== undefined && v.length > info.maxLength) throw validationError(`${info.name} is at most ${info.maxLength} characters`);
            return v === "" ? "-" : v;
        }
        if (!/^-?\d+$/.test(v)) throw validationError(`${info.name} takes an integer, got '${v}'`, info.min !== undefined ? `range ${info.min}..${info.max}` : undefined);
        const n = Number(v);
        if (info.min !== undefined && info.max !== undefined && (n < info.min || n > info.max)) {
            throw validationError(`${info.name} = ${n} is out of range`, `allowed range: ${info.min}..${info.max}`, { min: info.min, max: info.max });
        }
        return String(n);
    }

    static same(a: string, b: string): boolean {
        const norm = (x: string) => x.replace(/\s+/g, "").toLowerCase().replace(/^-$/, "");
        return norm(a) === norm(b);
    }

    /** Write a single value to RAM (no validation, no save). */
    private async writeRaw(name: string, value: string): Promise<void> {
        if (await this.hasMsp2Settings()) {
            const frame = await this.s.client.exclusive(() =>
                this.s.client.requestFrameUnlocked(MSP.MSP2_CLI_SETTING, [...Buffer.from(`${name} = ${value}`, "latin1")]),
            );
            if (frame.error) throw validationError(`flight controller rejected ${name} = ${value}`);
            return;
        }
        const r = await this.s.cli.exec(`set ${name} = ${value}`);
        if (r.errors.length) throw validationError(`flight controller rejected ${name} = ${value}: ${r.errors.join("; ")}`);
    }

    /**
     * Idempotent bulk write. Validates everything first (nothing is written if any value is
     * invalid), writes only differing values, verifies by read-back, then saves unless
     * `save: false`.
     */
    async set(values: Record<string, string | number | boolean>, opts: { dryRun?: boolean; save?: boolean } = {}): Promise<WriteResult> {
        const plan: { name: string; from: string; to: string }[] = [];
        const unchanged: string[] = [];
        for (const [k, raw] of Object.entries(values)) {
            const info = await this.info(k);
            const to = this.normalize(info, raw);
            const cur = await this.get(info.name);
            if (SettingsService.same(cur.value, to)) unchanged.push(info.name);
            else plan.push({ name: info.name, from: cur.value, to });
        }
        const changed = plan.map((p) => ({ key: p.name, from: p.from, to: p.to }));
        if (opts.dryRun || plan.length === 0) {
            return { changed, unchanged, dryRun: !!opts.dryRun, saved: false };
        }
        await this.s.assertDisarmed();
        for (const p of plan) await this.writeRaw(p.name, p.to);
        const mismatched: Change[] = [];
        for (const p of plan) {
            const back = await this.get(p.name);
            if (!SettingsService.same(back.value, p.to)) mismatched.push({ key: p.name, from: p.to, to: back.value });
        }
        if (mismatched.length) {
            throw new BfError("VERIFY_FAILED", "some values did not stick after writing", ExitCode.VERIFY_FAILED, "values may be clamped or depend on other settings", {
                mismatched,
            });
        }
        if (opts.save === false) return { changed, unchanged, dryRun: false, saved: false };
        const saved = await this.s.save();
        return { changed, unchanged, dryRun: false, saved: true, rebootRequired: saved.rebootRequired };
    }

    async reset(names: string[], opts: { dryRun?: boolean; save?: boolean } = {}): Promise<WriteResult> {
        const values: Record<string, string> = {};
        for (const n of names) {
            const info = await this.info(n);
            if (info.default === undefined) throw validationError(`no default known for ${n}`);
            values[n] = info.default;
        }
        return this.set(values, opts);
    }
}
