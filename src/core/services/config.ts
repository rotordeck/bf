// Whole-configuration operations: diff/dump, backup, restore, and declarative apply.

import YAML from "yaml";
import type { Session } from "../session.js";
import { SettingsService, type Change } from "./settings.js";
import { BfError, ExitCode, validationError } from "../errors.js";
import type { CliLineResult } from "../clitext/channel.js";

export const DIFF_SCOPES = ["all", "master", "profile", "rates", "hardware", "battery"] as const;
export type DiffScope = (typeof DIFF_SCOPES)[number];

const SKIP_LINE = /^(batch\s+(start|end)|save(\s+noreboot)?|exit(\s+noreboot)?)$/i;

/** Normalize a CLI line for comparison: collapse spaces, lowercase, drop comments. */
export const normLine = (l: string) => l.replace(/#.*$/, "").trim().replace(/\s+/g, " ").replace(/\s*=\s*/, " = ").toLowerCase();

export function cliLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !SKIP_LINE.test(l));
}

export interface DesiredState {
    /** global settings */
    settings?: Record<string, string | number | boolean>;
    /** per PID profile (1-based keys) */
    pid_profiles?: Record<string, Record<string, string | number | boolean>>;
    rate_profiles?: Record<string, Record<string, string | number | boolean>>;
    battery_profiles?: Record<string, Record<string, string | number | boolean>>;
    features?: Record<string, boolean>;
    /** raw CLI lines (aux, serial, map, led, ...) applied after settings */
    cli?: string[];
}

/** Turn a desired-state document (JSON/YAML object) into an ordered list of CLI lines. */
export function desiredToLines(d: DesiredState): string[] {
    const known = ["settings", "pid_profiles", "rate_profiles", "battery_profiles", "features", "cli"];
    const unknown = Object.keys(d).filter((k) => !known.includes(k));
    if (unknown.length) throw validationError(`unknown top-level keys in desired state: ${unknown.join(", ")}`, `allowed: ${known.join(", ")}`);
    const lines: string[] = [];
    for (const [f, on] of Object.entries(d.features ?? {})) lines.push(`feature ${on ? "" : "-"}${f.toUpperCase()}`);
    for (const [k, v] of Object.entries(d.settings ?? {})) lines.push(`set ${k} = ${v}`);
    const profileBlock = (cmd: string, sect?: Record<string, Record<string, string | number | boolean>>) => {
        for (const [idx, vals] of Object.entries(sect ?? {})) {
            const n = Number(idx);
            if (!Number.isInteger(n) || n < 1) throw validationError(`profile keys are 1-based numbers, got '${idx}'`);
            lines.push(`${cmd} ${n - 1}`);
            for (const [k, v] of Object.entries(vals)) lines.push(`set ${k} = ${v}`);
        }
    };
    profileBlock("profile", d.pid_profiles);
    profileBlock("rateprofile", d.rate_profiles);
    profileBlock("battery_profile", d.battery_profiles);
    lines.push(...(d.cli ?? []));
    return lines;
}

/** Parse a desired-state file: CLI text (diff/dump format), JSON or YAML. */
export function parseDesired(text: string, filename = ""): string[] {
    const trimmed = text.trim();
    const looksStructured = /\.(json|ya?ml)$/i.test(filename) || trimmed.startsWith("{") || /^(settings|pid_profiles|rate_profiles|features|cli|battery_profiles)\s*:/m.test(trimmed);
    if (looksStructured) {
        let doc: unknown;
        try {
            doc = trimmed.startsWith("{") ? JSON.parse(trimmed) : YAML.parse(trimmed);
        } catch (e: any) {
            throw validationError(`cannot parse ${filename || "desired state"}: ${e.message}`);
        }
        if (!doc || typeof doc !== "object") throw validationError("desired state must be an object");
        return desiredToLines(doc as DesiredState);
    }
    return cliLines(text);
}

/** How many leading tokens identify the thing a CLI line configures (a later line with the same key replaces it). */
export function lineKeyLength(tokens: string[]): number {
    const fixed: Record<string, number> = { aux: 2, adjrange: 2, rxfail: 2, rxrange: 2, led: 2, color: 2, servo: 2, smix: 2, mmix: 2, serial: 2, timer: 2, mode_color: 3, resource: 3, dma: 3, beeper: 2, beacon: 2 };
    if (tokens[0] === "vtxtable") return tokens[1] === "band" ? 3 : 2;
    if (tokens[0] === "smix" && tokens[1] === "reverse") return 4;
    return fixed[tokens[0]] ?? (tokens[1] && /^\d+$/.test(tokens[1]) ? 2 : 1);
}

/**
 * Drop `set` lines that a later line in the same profile context overrides (presets often
 * INCLUDE defaults and then change some of them). Order of the surviving lines is kept.
 */
export function dedupeSetLines(lines: string[]): string[] {
    let context = "";
    const keyed = lines.map((raw) => {
        const l = normLine(raw);
        if (/^(profile|rateprofile|battery_profile) \d+$/.test(l)) {
            context = `${context.split("|").filter((c) => !c.startsWith(l.split(" ")[0] + " ")).join("|")}|${l}`;
            return { raw, key: undefined as string | undefined };
        }
        const m = /^set (\S+) = /.exec(l);
        return { raw, key: m ? `${context}#${m[1]}` : undefined };
    });
    const last = new Map<string, number>();
    keyed.forEach((k, i) => k.key && last.set(k.key, i));
    return keyed.filter((k, i) => !k.key || last.get(k.key) === i).map((k) => k.raw);
}

export interface Snapshot {
    global: Record<string, string>;
    pidProfiles: Record<string, string>[];
    rateProfiles: Record<string, string>[];
    batteryProfiles: Record<string, string>[];
    features: Record<string, boolean>;
    /** non-`set` command lines grouped by command (aux, adjrange, map, mixer, led, serial, ...) */
    commands: Record<string, string[]>;
}

/** Parse `dump all` / `diff all` text into values per section. Profile indices are 0-based. */
export function parseDump(text: string): Snapshot {
    const snap: Snapshot = { global: {}, pidProfiles: [], rateProfiles: [], batteryProfiles: [], features: {}, commands: {} };
    let section: Record<string, string> = snap.global;
    for (const line of cliLines(text)) {
        let m: RegExpExecArray | null;
        if ((m = /^(profile|rateprofile|battery_profile) (\d+)$/.exec(line))) {
            const list = m[1] === "profile" ? snap.pidProfiles : m[1] === "rateprofile" ? snap.rateProfiles : snap.batteryProfiles;
            const i = Number(m[2]);
            list[i] ??= {};
            section = list[i];
            continue;
        }
        if ((m = /^set (\S+)\s*=\s*(.*)$/.exec(line))) {
            section[m[1]] = m[2].trim();
            continue;
        }
        if ((m = /^feature (-?)(\S+)$/.exec(line))) {
            snap.features[m[2]] = m[1] !== "-";
            continue;
        }
        const cmd = line.split(" ")[0];
        (snap.commands[cmd] ??= []).push(line);
    }
    return snap;
}

export interface ApplyResult {
    changed: Change[];
    unchanged: string[];
    executed: string[];
    errors: { line: string; errors: string[] }[];
    dryRun: boolean;
    saved: boolean;
    rebootRequired?: boolean;
}

export class ConfigService {
    private settings: SettingsService;
    constructor(private readonly s: Session) {
        this.settings = new SettingsService(s);
    }

    async diff(scope: DiffScope = "all", opts: { defaults?: boolean; bare?: boolean } = {}): Promise<string> {
        const args = [scope, opts.defaults ? "defaults" : "", opts.bare ? "bare" : ""].filter(Boolean).join(" ");
        const r = await this.s.cli.exec(`diff ${args}`, { timeoutMs: 30000 });
        return r.output;
    }

    /** Every setting of every profile plus all command lines, from one `dump all`. */
    async snapshot(): Promise<Snapshot> {
        return parseDump(await this.dump("all"));
    }

    async dump(scope: DiffScope = "all"): Promise<string> {
        const r = await this.s.cli.exec(`dump ${scope}`, { timeoutMs: 60000 });
        return r.output;
    }

    /**
     * Desired-state apply: every line is checked against the FC first and only lines that
     * would change something are executed, so re-running the same file is a no-op.
     *  - `set x = y`: compared via the settings service (validated, normalized)
     *  - `profile N` / `rateprofile N` / `battery_profile N`: always executed (context), the
     *    original selection is restored at the end
     *  - any other line: skipped if it already appears verbatim in `diff all`/`dump`
     *    output, executed otherwise
     */
    async apply(lines: string[], opts: { dryRun?: boolean; save?: boolean } = {}): Promise<ApplyResult> {
        const status = await this.s.status();
        const dumpText = await this.dump("all");
        const current = new Set(cliLines(dumpText).map(normLine));
        const features = parseDump(dumpText).features;
        const changed: Change[] = [];
        const unchanged: string[] = [];
        const executed: string[] = [];
        const errors: { line: string; errors: string[] }[] = [];
        const toRun: { line: string; change?: Change }[] = [];
        let contextSwitched = false;

        // Validation + planning pass. Profile context must be live while checking `set` lines.
        for (const line of dedupeSetLines(lines)) {
            const nl = normLine(line);
            if (/^(profile|rateprofile|battery_profile) \d+$/.test(nl)) {
                await this.s.assertDisarmed();
                await this.s.cli.exec(nl);
                contextSwitched = true;
                toRun.push({ line: nl });
                continue;
            }
            const m = /^set ([a-z0-9_]+) = (.*)$/i.exec(line.trim().replace(/\s*=\s*/, " = "));
            if (m) {
                const info = await this.settings.info(m[1]);
                const to = this.settings.normalize(info, m[2]);
                const cur = await this.settings.get(info.name);
                if (SettingsService.same(cur.value, to)) unchanged.push(info.name);
                else toRun.push({ line: `set ${info.name} = ${to}`, change: { key: info.name, from: cur.value, to } });
                continue;
            }
            if (/^defaults\b/i.test(nl)) {
                throw validationError("`defaults` is not allowed in apply", "use `bf config restore` for a full restore, or `bf defaults --confirm`");
            }
            const fm = /^feature (-?)(\S+)$/i.exec(line.trim());
            if (fm) {
                const want = fm[1] !== "-";
                const name = fm[2].toUpperCase();
                if (!(name in features)) throw validationError(`unknown feature '${fm[2]}'`, `known: ${Object.keys(features).join(", ")}`);
                if (features[name] === want) unchanged.push(`feature ${name}`);
                else toRun.push({ line: `feature ${want ? "" : "-"}${name}`, change: { key: `feature ${name}`, from: want ? "off" : "on", to: want ? "on" : "off" } });
                continue;
            }
            if (current.has(nl)) unchanged.push(line.trim());
            else {
                // Indexed commands (aux 3 ..., led 0 ..., vtxtable band 2 ...) replace the line with the same key.
                const tokens = nl.split(" ");
                const keyLen = lineKeyLength(tokens);
                const key = tokens.slice(0, keyLen).join(" ");
                const prev = [...current].reverse().find((c) => c.split(" ").slice(0, keyLen).join(" ") === key);
                toRun.push({ line: line.trim(), change: { key, from: prev ?? "(none)", to: line.trim() } });
            }
        }

        const restoreSelection = async () => {
            if (!contextSwitched) return;
            await this.s.cli.exec(`profile ${status.pidProfile - 1}`);
            await this.s.cli.exec(`rateprofile ${status.rateProfile - 1}`);
            if (status.batteryProfile) await this.s.cli.exec(`battery_profile ${status.batteryProfile - 1}`).catch(() => undefined);
        };

        const planned = toRun.filter((t) => t.change);
        if (opts.dryRun || planned.length === 0) {
            await restoreSelection();
            return { changed: planned.map((t) => t.change!), unchanged, executed: [], errors: [], dryRun: !!opts.dryRun, saved: false };
        }

        await this.s.assertDisarmed();
        try {
            for (const t of toRun) {
                const r = await this.s.cli.exec(t.line);
                if (t.change) {
                    executed.push(t.line);
                    if (r.errors.length) errors.push({ line: t.line, errors: r.errors });
                    else changed.push(t.change);
                }
            }
        } finally {
            await restoreSelection();
        }
        if (errors.length) {
            throw new BfError("PARTIAL_FAILURE", `${errors.length} of ${executed.length} lines failed; nothing was saved`, ExitCode.PARTIAL_FAILURE,
                "fix the failing lines and re-run; successful lines are applied in RAM only (reboot to discard)", { errors, changed });
        }
        if (opts.save === false) return { changed, unchanged, executed, errors, dryRun: false, saved: false };
        const saved = await this.s.save();
        return { changed, unchanged, executed, errors, dryRun: false, saved: true, rebootRequired: saved.rebootRequired };
    }

    /**
     * Full restore of a backup (diff/dump text): `defaults nosave`, every line, EEPROM write,
     * reboot. Mirrors Configurator's restore (BackupsTab.vue / useMspCliSession.runBatch).
     */
    async restore(text: string, opts: { dryRun?: boolean; onLine?: (r: CliLineResult) => void } = {}) {
        const lines = cliLines(text);
        const body = lines.filter((l) => !/^defaults\b/i.test(l));
        if (body.length === 0) throw validationError("backup file contains no CLI commands");
        const header = /^# Betaflight \/ (\S+) \((\S+)\) (\S+)/m.exec(text);
        const backupBoard = /^board_name (\S+)/m.exec(text)?.[1] ?? header?.[1];
        const warnings: string[] = [];
        if (backupBoard && backupBoard !== this.s.identity.target && backupBoard !== this.s.identity.board) {
            warnings.push(`backup was taken on board ${backupBoard}, this FC is ${this.s.identity.board}`);
        }
        if (header && header[3] !== this.s.identity.version) {
            warnings.push(`backup firmware ${header[3]} differs from FC firmware ${this.s.identity.version}; some settings may be rejected`);
        }
        if (opts.dryRun) return { dryRun: true, lines: body.length, warnings, commands: body };
        await this.s.assertDisarmed();
        const results: CliLineResult[] = [];
        results.push(await this.s.cli.exec("defaults nosave", { timeoutMs: 10000 }));
        for (const line of body) {
            const r = await this.s.cli.exec(line);
            results.push(r);
            opts.onLine?.(r);
        }
        const failed = results.filter((r) => r.errors.length).map((r) => ({ line: r.line, errors: r.errors }));
        await this.s.save();
        await this.s.reboot("firmware");
        if (failed.length) {
            throw new BfError("PARTIAL_FAILURE", `restore finished with ${failed.length} failed lines (config saved, FC rebooting)`, ExitCode.PARTIAL_FAILURE,
                "the failed lines are usually settings that do not exist on this firmware", { failed, warnings });
        }
        return { dryRun: false, lines: body.length, warnings, rebooted: true };
    }
}
