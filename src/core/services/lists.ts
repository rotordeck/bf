// Table-style configuration that the firmware exposes as CLI command lines rather than
// named settings: modes (aux), adjustments (adjrange), features, beepers, channel map,
// rx failsafe, LED strip, VTX table, servos, motor/servo mixes, waypoints.
//
// Reads parse the firmware's own line formats (cli.c print* functions); writes generate
// lines and go through ConfigService.apply, which skips lines that are already in effect.

import type { Session } from "../session.js";
import { ConfigService, type ApplyResult } from "./config.js";
import { BfError, ExitCode, validationError, unsupportedError } from "../errors.js";

export const ADJUSTMENT_FUNCTIONS = [
    "NONE", "RC_RATE", "RC_EXPO", "THROTTLE_EXPO", "PITCH_ROLL_RATE", "YAW_RATE", "PITCH_ROLL_P", "PITCH_ROLL_I", "PITCH_ROLL_D",
    "YAW_P", "YAW_I", "YAW_D", "RATE_PROFILE", "PITCH_RATE", "ROLL_RATE", "PITCH_P", "PITCH_I", "PITCH_D", "ROLL_P", "ROLL_I",
    "ROLL_D", "RC_RATE_YAW", "PITCH_ROLL_F", "FEEDFORWARD_TRANSITION", "HORIZON_STRENGTH", "PID_AUDIO", "PITCH_F", "ROLL_F",
    "YAW_F", "OSD_PROFILE", "LED_PROFILE", "LED_DIMMER", "SIMPLIFIED_MASTER_MULTIPLIER", "BATTERY_PROFILE",
] as const;

const CHANNEL_MIN = 900;
const CHANNEL_MAX = 2100;
const STEP = 25;

/** "AUX1".."AUX20" or 1..20 -> aux channel index (0-based, AUX1 = 0) */
export function parseAuxChannel(v: string | number): number {
    const m = /^(?:aux)?(\d+)$/i.exec(String(v).trim());
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 20) throw validationError(`invalid aux channel '${v}'`, "use AUX1..AUX20 (AUX1 is RC channel 5)");
    return n - 1;
}

/** "1700-2100" -> [1700, 2100], snapped to the firmware's 25 us steps */
export function parseRange(v: string): [number, number] {
    const m = /^(\d{3,4})\s*(?:-|\.\.)\s*(\d{3,4})$/.exec(v.trim());
    if (!m) throw validationError(`invalid range '${v}'`, "use e.g. 1700-2100 (microseconds, 900..2100)");
    const snap = (x: number) => Math.round((x - CHANNEL_MIN) / STEP) * STEP + CHANNEL_MIN;
    const a = snap(Number(m[1]));
    const b = snap(Number(m[2]));
    if (a < CHANNEL_MIN || b > CHANNEL_MAX || a >= b) throw validationError(`invalid range '${v}'`, `start < end, both within ${CHANNEL_MIN}..${CHANNEL_MAX}`);
    return [a, b];
}

/** Serial port function bits (firmware io/serial.h serialPortFunction_e). */
export const SERIAL_FUNCTIONS: Record<string, number> = {
    MSP: 1 << 0,
    GPS: 1 << 1,
    TELEMETRY_FRSKY_HUB: 1 << 2,
    TELEMETRY_HOTT: 1 << 3,
    TELEMETRY_LTM: 1 << 4,
    TELEMETRY_SMARTPORT: 1 << 5,
    RX_SERIAL: 1 << 6,
    BLACKBOX: 1 << 7,
    TELEMETRY_MAVLINK: 1 << 9,
    ESC_SENSOR: 1 << 10,
    VTX_SMARTAUDIO: 1 << 11,
    TELEMETRY_IBUS: 1 << 12,
    VTX_TRAMP: 1 << 13,
    RCDEVICE: 1 << 14,
    LIDAR: 1 << 15,
    FRSKY_OSD: 1 << 16,
    VTX_MSP: 1 << 17,
    GIMBAL: 1 << 18,
};

export const functionsFromMask = (mask: number) => Object.entries(SERIAL_FUNCTIONS).filter(([, b]) => mask & b).map(([n]) => n);

export class ListsService {
    private config: ConfigService;
    constructor(private readonly s: Session) {
        this.config = new ConfigService(s);
    }

    private async lines(cmd: string): Promise<string[]> {
        const r = await this.s.cli.exec(cmd, { timeoutMs: 20000 });
        if (/ERR_CMD_NA/.test(r.output)) throw unsupportedError(`\`${cmd.split(" ")[0]}\` is not available in this firmware build`);
        if (r.errors.length) throw new BfError("CLI_ERROR", r.errors.join("; "), ExitCode.REFUSED);
        return r.output.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    }

    apply(lines: string[], opts: { dryRun?: boolean; save?: boolean } = {}): Promise<ApplyResult> {
        return this.config.apply(lines, opts);
    }

    // ---------- modes (aux) ----------

    /** Map permanent box id <-> name, for the modes this firmware build offers. */
    async modeCatalog(): Promise<{ id: number; name: string }[]> {
        const names = await this.s.boxNames();
        const ids = await this.s.boxIds();
        return ids.map((id, i) => ({ id, name: names[i] }));
    }

    async modes(opts: { all?: boolean } = {}) {
        const catalog = await this.modeCatalog();
        const byId = new Map(catalog.map((c) => [c.id, c.name]));
        const out = (await this.lines("aux")).flatMap((l) => {
            const m = /^aux (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(l);
            if (!m) return [];
            const [slot, modeId, aux, start, end, logic, link] = m.slice(1).map(Number);
            const enabled = end > start;
            return [{ slot, mode: byId.get(modeId) ?? `ID${modeId}`, modeId, channel: `AUX${aux + 1}`, rcChannel: aux + 5, start, end, logic: logic ? "AND" : "OR", linkedTo: link ? byId.get(link) ?? `ID${link}` : null, enabled }];
        });
        return opts.all ? out : out.filter((m) => m.enabled);
    }

    private async resolveMode(name: string) {
        const catalog = await this.modeCatalog();
        const hit = catalog.find((c) => c.name.toLowerCase() === name.toLowerCase().replace(/[-_]/g, " ") || c.name.toLowerCase() === name.toLowerCase());
        if (!hit) throw validationError(`unknown mode '${name}'`, `available on this FC: ${catalog.map((c) => c.name).join(", ")}`);
        return hit;
    }

    /**
     * Assign a mode to an aux range. Reuses the slot already holding that mode (or `slot`),
     * else the first unused slot.
     */
    async setMode(name: string, opts: { channel: string; range: string; logic?: "OR" | "AND"; linkTo?: string; slot?: number; add?: boolean; dryRun?: boolean; save?: boolean }) {
        const mode = await this.resolveMode(name);
        const aux = parseAuxChannel(opts.channel);
        const [start, end] = parseRange(opts.range);
        const link = opts.linkTo ? (await this.resolveMode(opts.linkTo)).id : 0;
        const all = await this.modes({ all: true });
        let slot = opts.slot;
        if (slot === undefined && !opts.add) slot = all.find((m) => m.enabled && m.modeId === mode.id)?.slot;
        if (slot === undefined) slot = all.find((m) => !m.enabled)?.slot;
        if (slot === undefined) throw validationError("all mode slots are in use", "remove one with `bf modes remove`");
        const line = `aux ${slot} ${mode.id} ${aux} ${start} ${end} ${opts.logic === "AND" ? 1 : 0} ${link}`;
        return { slot, ...(await this.apply([line], opts)) };
    }

    async removeMode(name: string, opts: { slot?: number; dryRun?: boolean; save?: boolean } = {}) {
        const mode = await this.resolveMode(name);
        const targets = (await this.modes()).filter((m) => m.modeId === mode.id && (opts.slot === undefined || m.slot === opts.slot));
        if (targets.length === 0) return { changed: [], unchanged: [`${mode.name} (not assigned)`], executed: [], errors: [], dryRun: !!opts.dryRun, saved: false };
        return this.apply(targets.map((t) => `aux ${t.slot} 0 0 900 900 0 0`), opts);
    }

    // ---------- adjustments (adjrange) ----------

    async adjustments(opts: { all?: boolean } = {}) {
        const out = (await this.lines("adjrange")).flatMap((l) => {
            const m = /^adjrange (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)(?: (\d+) (\d+))?$/.exec(l);
            if (!m) return [];
            const n = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
            const [slot, , rangeCh, start, end, fn, selectCh, center, scale] = n;
            return [{ slot, function: ADJUSTMENT_FUNCTIONS[fn] ?? `FN${fn}`, rangeChannel: `AUX${rangeCh + 1}`, start, end, valueChannel: `AUX${selectCh + 1}`, center, scale, enabled: end > start && fn !== 0 }];
        });
        return opts.all ? out : out.filter((a) => a.enabled);
    }

    async setAdjustment(fnName: string, opts: { rangeChannel: string; range: string; valueChannel: string; center?: number; scale?: number; slot?: number; dryRun?: boolean; save?: boolean }) {
        const fn = ADJUSTMENT_FUNCTIONS.indexOf(fnName.toUpperCase() as any);
        if (fn <= 0) throw validationError(`unknown adjustment function '${fnName}'`, `one of: ${ADJUSTMENT_FUNCTIONS.slice(1).join(", ")}`);
        const rc = parseAuxChannel(opts.rangeChannel);
        const vc = parseAuxChannel(opts.valueChannel);
        const [start, end] = parseRange(opts.range);
        const all = await this.adjustments({ all: true });
        let slot = opts.slot ?? all.find((a) => a.enabled && a.function === ADJUSTMENT_FUNCTIONS[fn])?.slot;
        if (slot === undefined) slot = all.find((a) => !a.enabled)?.slot;
        if (slot === undefined) throw validationError("all adjustment slots are in use");
        const line = `adjrange ${slot} 0 ${rc} ${start} ${end} ${fn} ${vc} ${opts.center ?? 0} ${opts.scale ?? 0}`;
        return { slot, ...(await this.apply([line], opts)) };
    }

    async removeAdjustment(slot: number, opts: { dryRun?: boolean; save?: boolean } = {}) {
        return this.apply([`adjrange ${slot} 0 0 900 900 0 0 0 0`], opts);
    }

    // ---------- features ----------

    async features() {
        const out = (await this.s.cli.exec("feature")).output;
        const grab = (label: string) => (new RegExp(`^${label}:\\s*(.*)$`, "m").exec(out)?.[1] ?? "").split(/\s+/).filter(Boolean);
        const enabled = grab("Enabled");
        const available = grab("Available");
        const unavailable = grab("Unavailable");
        return [
            ...enabled.map((f) => ({ feature: f, enabled: true, available: true })),
            ...available.map((f) => ({ feature: f, enabled: false, available: true })),
            ...unavailable.map((f) => ({ feature: f, enabled: false, available: false })),
        ];
    }

    async setFeatures(enable: string[], disable: string[], opts: { dryRun?: boolean; save?: boolean } = {}) {
        const all = await this.features();
        const check = (f: string) => {
            const hit = all.find((x) => x.feature === f.toUpperCase());
            if (!hit) throw validationError(`unknown feature '${f}'`, `known: ${all.map((x) => x.feature).join(", ")}`);
            if (!hit.available && enable.includes(f)) throw unsupportedError(`feature ${hit.feature} is not available in this firmware build`);
            return hit.feature;
        };
        return this.apply([...enable.map((f) => `feature ${check(f)}`), ...disable.map((f) => `feature -${check(f)}`)], opts);
    }

    // ---------- beepers / dshot beacon ----------

    async beepers(kind: "beeper" | "beacon" = "beeper") {
        const lines = await this.lines(`dump master`).catch(() => [] as string[]);
        const out = lines.flatMap((l) => {
            const m = new RegExp(`^${kind} (-?)(\\S+)$`).exec(l);
            return m ? [{ condition: m[2], enabled: m[1] !== "-" }] : [];
        });
        if (out.length === 0) throw unsupportedError(`\`${kind}\` is not available in this firmware build`);
        // dump prints the default line, then the actual one: keep the last occurrence
        return [...new Map(out.map((o) => [o.condition, o])).values()];
    }

    async setBeepers(kind: "beeper" | "beacon", enable: string[], disable: string[], opts: { dryRun?: boolean; save?: boolean } = {}) {
        const known = new Set((await this.beepers(kind)).map((b) => b.condition));
        const check = (c: string) => {
            const n = c.toUpperCase();
            if (!known.has(n)) throw validationError(`unknown ${kind} condition '${c}'`, `known: ${[...known].join(", ")}`);
            return n;
        };
        const current = new Map((await this.beepers(kind)).map((b) => [b.condition, b.enabled]));
        const lines = [...enable.map(check).filter((c) => !current.get(c)).map((c) => `${kind} ${c}`), ...disable.map(check).filter((c) => current.get(c)).map((c) => `${kind} -${c}`)];
        if (lines.length === 0 || opts.dryRun) {
            return { changed: lines.map((l) => ({ key: l, from: "", to: "applied" })), unchanged: [...enable, ...disable].filter((c) => !lines.some((l) => l.endsWith(c.toUpperCase()))), executed: [], errors: [], dryRun: !!opts.dryRun, saved: false };
        }
        await this.s.assertDisarmed();
        for (const l of lines) {
            const r = await this.s.cli.exec(l);
            if (r.errors.length) throw new BfError("CLI_ERROR", r.errors.join("; "), ExitCode.REFUSED);
        }
        const saved = opts.save === false ? undefined : await this.s.save();
        return { changed: lines.map((l) => ({ key: l, from: "", to: "applied" })), unchanged: [], executed: lines, errors: [], dryRun: false, saved: !!saved };
    }

    // ---------- receiver channel map / rx failsafe / rx range ----------

    async channelMap() {
        const l = (await this.lines("map")).find((x) => x.startsWith("map "));
        return { map: l?.split(" ")[1] ?? "" };
    }

    async setChannelMap(map: string, opts: { dryRun?: boolean; save?: boolean } = {}) {
        const m = map.toUpperCase();
        if (!/^[AETR1-8]{4,8}$/.test(m) || !["A", "E", "T", "R"].every((c) => m.includes(c))) throw validationError(`invalid channel map '${map}'`, "e.g. AETR1234 or TAER1234");
        return this.apply([`map ${m}`], opts);
    }

    async rxFail() {
        return (await this.lines("rxfail")).flatMap((l) => {
            const m = /^rxfail (\d+) ([ahs])(?: (\d+))?$/.exec(l);
            if (!m) return [];
            const ch = Number(m[1]);
            const name = ch < 4 ? ["roll", "pitch", "yaw", "throttle"][ch] : `AUX${ch - 3}`;
            return [{ channel: ch, name, mode: { a: "auto", h: "hold", s: "set" }[m[2] as "a" | "h" | "s"], value: m[3] ? Number(m[3]) : null }];
        });
    }

    async setRxFail(channel: number, mode: "auto" | "hold" | "set", value?: number, opts: { dryRun?: boolean; save?: boolean } = {}) {
        if (mode === "set" && (value === undefined || value < 750 || value > 2250)) throw validationError("mode 'set' needs --value 750..2250");
        if (channel < 4 && mode === "set") throw validationError("roll/pitch/yaw/throttle (channels 0-3) only support auto or hold");
        return this.apply([`rxfail ${channel} ${mode[0]}${mode === "set" ? ` ${value}` : ""}`], opts);
    }

    async rxRange() {
        return (await this.lines("rxrange")).flatMap((l) => {
            const m = /^rxrange (\d+) (\d+) (\d+)$/.exec(l);
            return m ? [{ channel: Number(m[1]), name: ["roll", "pitch", "yaw", "throttle"][Number(m[1])], min: Number(m[2]), max: Number(m[3]) }] : [];
        });
    }

    // ---------- serial ports (Ports tab) ----------

    /**
     * UART assignments. Classic firmware prints `serial <id> <mask> <msp> <gps> <tlm> <bb>`;
     * newer firmware assigns ports with `<function>_uart` settings (then `serial` prints set lines).
     */
    async serialPorts() {
        const lines = await this.lines("serial");
        const classic = lines.flatMap((l) => {
            const m = /^serial (\S+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(l);
            if (!m) return [];
            const mask = Number(m[2]);
            return [{ port: m[1], functions: functionsFromMask(mask), functionMask: mask, mspBaud: Number(m[3]), gpsBaud: Number(m[4]), telemetryBaud: Number(m[5]), blackboxBaud: Number(m[6]) }];
        });
        if (classic.length) return { style: "serial" as const, ports: classic };
        const assigned = lines.flatMap((l) => {
            const m = /^set (\S+)_uart = (\S+)$/.exec(l);
            return m ? [{ function: m[1], port: m[2] }] : [];
        });
        return { style: "uart-settings" as const, ports: assigned };
    }

    async setSerialPort(port: string, opts: { functions?: string[]; mspBaud?: number; gpsBaud?: number; telemetryBaud?: number; blackboxBaud?: number; dryRun?: boolean; save?: boolean }) {
        const cur = await this.serialPorts();
        if (cur.style !== "serial") {
            throw validationError("this firmware assigns ports with *_uart settings", "use `bf serial set rx_uart=UART2 msp_1_uart=UART1 ...` (see `bf serial get`)");
        }
        const p = cur.ports.find((x) => x.port.toUpperCase() === port.toUpperCase());
        if (!p) throw validationError(`unknown port '${port}'`, `ports: ${cur.ports.map((x) => x.port).join(", ")}`);
        let mask = p.functionMask;
        if (opts.functions) {
            mask = 0;
            for (const f of opts.functions) {
                const key = f.toUpperCase().replace(/-/g, "_");
                const bit = SERIAL_FUNCTIONS[key] ?? SERIAL_FUNCTIONS[key === "RX" ? "RX_SERIAL" : key === "SMARTAUDIO" ? "VTX_SMARTAUDIO" : key === "TRAMP" ? "VTX_TRAMP" : key];
                if (bit === undefined && key !== "NONE") throw validationError(`unknown port function '${f}'`, `one of: ${Object.keys(SERIAL_FUNCTIONS).join(", ")}, NONE`);
                mask |= bit ?? 0;
            }
        }
        if (p.port === "VCP" && !(mask & SERIAL_FUNCTIONS.MSP)) throw validationError("refusing to remove MSP from the USB port (VCP): you would lose the connection");
        const line = `serial ${p.port} ${mask} ${opts.mspBaud ?? p.mspBaud} ${opts.gpsBaud ?? p.gpsBaud} ${opts.telemetryBaud ?? p.telemetryBaud} ${opts.blackboxBaud ?? p.blackboxBaud}`;
        return this.apply([line], opts);
    }

    // ---------- generic raw-line lists (led, color, mode_color, vtxtable, servo, smix, mmix, serial, resource, timer, waypoint) ----------

    async rawList(cmd: string): Promise<string[]> {
        return (await this.lines(cmd)).filter((l) => l.startsWith(cmd.split(" ")[0] + " ") || cmd.startsWith("waypoint"));
    }

    async leds() {
        return (await this.rawList("led")).flatMap((l) => {
            const m = /^led (\d+) (\d+),(\d+):([NESWUD]*):([A-Z]*):(\d+)$/.exec(l);
            return m ? [{ index: Number(m[1]), x: Number(m[2]), y: Number(m[3]), directions: m[4], functions: m[5], color: Number(m[6]), line: l }] : [{ line: l }];
        });
    }

    async colors() {
        return (await this.rawList("color")).flatMap((l) => {
            const m = /^color (\d+) (\d+),(\d+),(\d+)$/.exec(l);
            return m ? [{ index: Number(m[1]), hue: Number(m[2]), saturation: Number(m[3]), value: Number(m[4]) }] : [];
        });
    }

    async vtxTable() {
        const lines = await this.rawList("vtxtable");
        const bands: { band: number; name: string; letter: string; factory: boolean; frequencies: number[] }[] = [];
        let powerValues: number[] = [];
        let powerLabels: string[] = [];
        for (const l of lines) {
            let m: RegExpExecArray | null;
            if ((m = /^vtxtable band (\d+) (\S+) (\S) (FACTORY|CUSTOM) (.*)$/.exec(l))) {
                bands.push({ band: Number(m[1]), name: m[2], letter: m[3], factory: m[4] === "FACTORY", frequencies: m[5].split(/\s+/).map(Number) });
            } else if ((m = /^vtxtable powervalues (.*)$/.exec(l))) powerValues = m[1].split(/\s+/).map(Number);
            else if ((m = /^vtxtable powerlabels (.*)$/.exec(l))) powerLabels = m[1].split(/\s+/);
        }
        return { bands, powerLevels: powerValues.map((v, i) => ({ level: i + 1, value: v, label: powerLabels[i] })), lines };
    }

    /**
     * Configurator-format VTX table JSON (vtx_table.json from the Configurator / vendor):
     * { vtx_table: { bands_list: [{name, letter, is_factory_band, frequencies[]}], powerlevels_list: [{value, label}] } }
     */
    static vtxTableJsonToLines(doc: any): string[] {
        const t = doc?.vtx_table;
        if (!t?.bands_list || !t?.powerlevels_list) throw validationError("not a VTX table file", "expected { vtx_table: { bands_list, powerlevels_list } }");
        const lines = [`vtxtable bands ${t.bands_list.length}`, `vtxtable channels ${t.bands_list[0]?.frequencies?.length ?? 8}`];
        t.bands_list.forEach((b: any, i: number) => lines.push(`vtxtable band ${i + 1} ${b.name} ${b.letter} ${b.is_factory_band ? "FACTORY" : "CUSTOM"} ${b.frequencies.join(" ")}`));
        lines.push(`vtxtable powerlevels ${t.powerlevels_list.length}`);
        lines.push(`vtxtable powervalues ${t.powerlevels_list.map((p: any) => p.value).join(" ")}`);
        lines.push(`vtxtable powerlabels ${t.powerlevels_list.map((p: any) => p.label).join(" ")}`);
        return lines;
    }

    async servos() {
        return (await this.rawList("servo")).flatMap((l) => {
            const m = /^servo (\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/.exec(l);
            return m ? [{ index: Number(m[1]), min: Number(m[2]), max: Number(m[3]), mid: Number(m[4]), rate: Number(m[5]), forwardChannel: Number(m[6]) }] : [];
        });
    }

    /** Replace the stored mission with `waypoint insert ...` lines, then save. */
    async loadWaypoints(lines: string[]) {
        const inserts = lines.map((l) => l.trim()).filter((l) => l.startsWith("waypoint insert"));
        if (!inserts.length) throw validationError("no `waypoint insert` lines given");
        await this.s.assertDisarmed();
        await this.s.cli.exec("waypoint clear");
        const results = await this.s.cli.batch(inserts);
        const failed = results.filter((r) => r.errors.length).map((f) => ({ line: f.line, errors: f.errors }));
        if (failed.length) {
            throw new BfError("PARTIAL_FAILURE", `${failed.length} waypoint lines failed; mission not saved`, ExitCode.PARTIAL_FAILURE, "reboot to discard the partial mission", { failed });
        }
        await this.s.save();
        return { loaded: results.length, saved: true };
    }

    async clearWaypoints() {
        await this.s.assertDisarmed();
        await this.s.cli.exec("waypoint clear");
        await this.s.save();
        return { cleared: true, saved: true };
    }

    async waypoints() {
        const r = await this.s.cli.exec("waypoint list");
        if (/ERR_CMD_NA/.test(r.output)) throw unsupportedError("waypoints are not available in this firmware build");
        return r.output.split("\n").map((l) => l.trim()).filter((l) => /^waypoint insert/.test(l));
    }
}
