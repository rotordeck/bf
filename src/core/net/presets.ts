// Betaflight presets repository client. Port of betaflight-configurator
// components/tabs/presets/PresetsRepoIndexed/{PresetsRepoIndexed,PresetParser}.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BfError, ExitCode, validationError } from "../errors.js";

export interface PresetSource {
    name: string;
    /** base URL that contains index.json, ending with '/' */
    url: string;
    official?: boolean;
}

export const OFFICIAL_SOURCE: PresetSource = { name: "Betaflight Official", url: "https://presets.betaflight.com/firmware-presets/", official: true };

const CONFIG_DIR = process.env.BF_CONFIG_DIR ?? path.join(os.homedir(), ".config", "bf");
const SOURCES_FILE = path.join(CONFIG_DIR, "preset-sources.json");

export function loadSources(): PresetSource[] {
    try {
        return JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    } catch {
        return [OFFICIAL_SOURCE];
    }
}

export function saveSources(sources: PresetSource[]) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2));
}

/** GitHub repo URL -> raw URL (Configurator PresetsGithubRepo.js). */
export function normalizeSourceUrl(url: string, branch = "master"): string {
    const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}/`;
    return url.endsWith("/") ? url : url + "/";
}

export interface PresetIndexEntry {
    fullPath: string;
    title: string;
    firmware_version: string[];
    category: string;
    status: string;
    keywords?: string[];
    author?: string;
    priority?: number;
    hidden?: boolean;
}

interface PresetIndex {
    settings: any;
    presets: PresetIndexEntry[];
}

export interface PresetOption {
    name: string;
    checked: boolean;
    group?: string;
    exclusive?: boolean;
}

export const presetId = (e: { fullPath: string }) => e.fullPath.replace(/^presets\//, "").replace(/\.txt$/, "");

async function fetchText(url: string): Promise<string> {
    let res: Response;
    try {
        res = await fetch(url, { headers: { "User-Agent": "bf-cli" } });
    } catch (e: any) {
        throw new BfError("NETWORK", `cannot fetch ${url}: ${e.message}`, ExitCode.CONNECTION);
    }
    if (!res.ok) throw new BfError("NETWORK", `HTTP ${res.status} for ${url}`, ExitCode.CONNECTION);
    return res.text();
}

const INCLUDE = /^#\$[ ]+?INCLUDE:[ ]+?(\S+)$/;

export class PresetsRepo {
    private index?: PresetIndex;
    constructor(readonly source: PresetSource) {}

    async load(): Promise<PresetIndex> {
        if (!this.index) {
            const text = await fetchText(`${this.source.url}index.json`);
            try {
                this.index = JSON.parse(text);
            } catch {
                throw new BfError("PRESETS_INDEX", `invalid index.json at ${this.source.url}`, ExitCode.GENERAL);
            }
        }
        return this.index!;
    }

    async search(f: { text?: string; category?: string; firmware?: string; status?: string; author?: string }) {
        const idx = await this.load();
        const words = (f.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        return idx.presets
            .filter((p) => !p.hidden)
            .filter((p) => !f.category || p.category.toLowerCase() === f.category.toLowerCase())
            .filter((p) => !f.status || p.status.toLowerCase() === f.status.toLowerCase())
            .filter((p) => !f.firmware || p.firmware_version.some((v) => f.firmware!.startsWith(v)))
            .filter((p) => !f.author || (p.author ?? "").toLowerCase().includes(f.author.toLowerCase()))
            .filter((p) => {
                const hay = [p.title, p.fullPath, p.author ?? "", ...(p.keywords ?? [])].join(" ").toLowerCase();
                return words.every((w) => hay.includes(w));
            })
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.title.localeCompare(b.title))
            .map((p) => ({ id: presetId(p), title: p.title, category: p.category, status: p.status, firmware: p.firmware_version, author: p.author, source: this.source.name }));
    }

    async find(id: string): Promise<PresetIndexEntry | undefined> {
        const idx = await this.load();
        return idx.presets.find((p) => presetId(p) === id || p.fullPath === id);
    }

    /** Preset text with #$ INCLUDE resolved (nested), as trimmed lines. */
    async lines(entry: PresetIndexEntry): Promise<string[]> {
        let lines = (await fetchText(this.source.url + entry.fullPath)).split("\n").map((l) => l.trim());
        for (let depth = 0; depth < 10 && lines.some((l) => INCLUDE.test(l)); depth++) {
            const out: string[] = [];
            for (const l of lines) {
                const m = INCLUDE.exec(l);
                if (m) out.push(...(await fetchText(this.source.url + m[1])).split("\n").map((x) => x.trim()));
                else out.push(l);
            }
            lines = out;
        }
        return lines;
    }

    async details(entry: PresetIndexEntry) {
        const lines = await this.lines(entry);
        const props: Record<string, string[]> = {};
        const options: PresetOption[] = [];
        let group: { name: string; exclusive: boolean } | undefined;
        for (const raw of lines) {
            if (!raw.startsWith("#$")) continue;
            const line = raw.slice(2).trim();
            const low = line.toLowerCase();
            const prop = /^([a-z_]+):\s*(.*)$/i.exec(line);
            if (low.startsWith("option_group begin")) {
                const exclusive = low.includes("(exclusive)");
                group = { name: line.replace(/^option_group begin/i, "").replace(/\(exclusive\)/i, "").replace(/^\s*:/, "").trim(), exclusive };
            } else if (low.startsWith("option_group end")) group = undefined;
            else if (low.startsWith("option begin")) {
                const checked = low.includes("(checked)");
                const name = line.replace(/^option begin/i, "").replace(/\((un)?checked\)/i, "").replace(/^\s*:/, "").trim();
                options.push({ name, checked, ...(group ? { group: group.name, exclusive: group.exclusive } : {}) });
            } else if (low.startsWith("option end")) {
                /* end of option body */
            } else if (prop && !low.startsWith("option")) {
                (props[prop[1].toLowerCase()] ??= []).push(prop[2]);
            }
        }
        return {
            id: presetId(entry),
            title: entry.title,
            category: entry.category,
            status: entry.status,
            firmware: entry.firmware_version,
            author: entry.author,
            description: props.description?.join("\n"),
            warning: [props.warning, props.disclaimer].flat().filter(Boolean).join("\n") || undefined,
            discussion: props.discussion?.[0],
            forceOptionsReview: props.force_options_review?.[0]?.toLowerCase() === "true",
            options,
            url: this.source.url + entry.fullPath,
            lines,
        };
    }
}

/**
 * CLI lines of a preset with the selected options (Configurator PresetParser.removeUncheckedOptions):
 * option bodies not selected are dropped, '#' lines removed.
 */
export function presetCli(lines: string[], options: PresetOption[], enable: string[] = [], disable: string[] = []): { cli: string[]; selected: string[] } {
    const lower = (s: string) => s.toLowerCase();
    const known = new Set(options.map((o) => lower(o.name)));
    for (const n of [...enable, ...disable]) if (!known.has(lower(n))) throw validationError(`preset has no option '${n}'`, `options: ${options.map((o) => o.name).join(", ") || "(none)"}`);
    const selected = new Set(options.filter((o) => o.checked).map((o) => lower(o.name)));
    for (const n of enable) {
        const opt = options.find((o) => lower(o.name) === lower(n))!;
        if (opt.exclusive) for (const o of options) if (o.group === opt.group) selected.delete(lower(o.name));
        selected.add(lower(n));
    }
    for (const n of disable) selected.delete(lower(n));
    const cli: string[] = [];
    let excluded = false;
    for (const raw of lines) {
        if (raw.startsWith("#$")) {
            const line = raw.slice(2).trim();
            const low = line.toLowerCase();
            if (low.startsWith("option begin")) {
                const name = line.replace(/^option begin/i, "").replace(/\((un)?checked\)/i, "").replace(/^\s*:/, "").trim();
                excluded = !selected.has(lower(name));
            } else if (low.startsWith("option end")) excluded = false;
            continue;
        }
        if (excluded || !raw || raw.startsWith("#")) continue;
        cli.push(raw);
    }
    return { cli, selected: options.filter((o) => selected.has(lower(o.name))).map((o) => o.name) };
}
