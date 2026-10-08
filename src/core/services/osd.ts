// OSD elements (osd_*_pos settings), text preview, and MAX7456 font upload.

import type { Session } from "../session.js";
import { ConfigService } from "./config.js";
import { SettingsService } from "./settings.js";
import { MSP } from "../msp/codes.js";
import { PayloadWriter } from "../msp/bytes.js";
import { validationError } from "../errors.js";

// Encoding from firmware osd/osd.h (OSD_POS / OSD_X / OSD_Y / OSD_PROFILE_FLAG / OSD_TYPE)
const PROFILE_BITS_POS = 11;
export const decodePos = (v: number) => ({
    x: (v & 0x1f) | ((v & (1 << 10)) >> 5),
    y: (v >> 5) & 0x1f,
    profiles: [1, 2, 3].filter((p) => v & (1 << (p - 1 + PROFILE_BITS_POS))),
    variant: (v & 0xc000) >> 14,
});
export const encodePos = (x: number, y: number, profiles: number[], variant: number) =>
    (x & 0x1f) | ((x << 5) & (1 << 10)) | ((y & 0x1f) << 5) | profiles.reduce((a, p) => a | (1 << (p - 1 + PROFILE_BITS_POS)), 0) | ((variant & 3) << 14);

export const elementName = (setting: string) => setting.replace(/^osd_/, "").replace(/_pos$/, "");

export class OsdService {
    constructor(private readonly s: Session) {}

    async elements(opts: { all?: boolean } = {}) {
        const snap = await new ConfigService(this.s).snapshot();
        const out = Object.entries(snap.global)
            .filter(([k]) => /^osd_.*_pos$/.test(k))
            .map(([k, v]) => ({ element: elementName(k), setting: k, raw: Number(v), ...decodePos(Number(v)) }))
            .map((e) => ({ ...e, visible: e.profiles.length > 0 }));
        return opts.all ? out : out.filter((e) => e.visible);
    }

    /** Move/show/hide an element. Unspecified properties keep their current value. */
    async setElement(name: string, opts: { x?: number; y?: number; profiles?: number[]; variant?: number; dryRun?: boolean; save?: boolean }) {
        const all = await this.elements({ all: true });
        const el = all.find((e) => e.element === name.toLowerCase().replace(/-/g, "_") || e.setting === name);
        if (!el) throw validationError(`unknown OSD element '${name}'`, `known: ${all.map((e) => e.element).join(", ")}`);
        const canvas = await this.canvas();
        const x = opts.x ?? el.x;
        const y = opts.y ?? el.y;
        if (x < 0 || x >= Math.min(canvas.columns, 64) || y < 0 || y >= Math.min(canvas.rows, 32)) {
            throw validationError(`position ${x},${y} is outside the ${canvas.columns}x${canvas.rows} OSD canvas`);
        }
        for (const p of opts.profiles ?? []) if (p < 1 || p > 3) throw validationError("OSD profiles are 1..3");
        const value = encodePos(x, y, opts.profiles ?? el.profiles, opts.variant ?? el.variant);
        return new SettingsService(this.s).set({ [el.setting]: value }, opts);
    }

    async canvas() {
        const st = new SettingsService(this.s);
        const get = async (n: string, d: number) => {
            try {
                return Number((await st.get(n)).value);
            } catch {
                return d;
            }
        };
        const video = await st.get("vcd_video_system").catch(() => ({ value: "PAL" }));
        const cols = await get("osd_canvas_width", 0);
        const rows = await get("osd_canvas_height", 0);
        if (cols && rows && video.value === "HD") return { columns: cols, rows, videoSystem: video.value };
        return { columns: 30, rows: video.value === "NTSC" ? 13 : 16, videoSystem: video.value };
    }

    /** ASCII rendering of where elements sit in an OSD profile (first 3 letters of each element). */
    async preview(profile = 1) {
        const canvas = await this.canvas();
        const grid = Array.from({ length: canvas.rows }, () => Array(canvas.columns).fill("."));
        const placed: { element: string; x: number; y: number }[] = [];
        for (const e of await this.elements()) {
            if (!e.profiles.includes(profile) || e.y >= canvas.rows) continue;
            const label = e.element.replace(/_/g, "").slice(0, 3).toUpperCase();
            for (let i = 0; i < label.length && e.x + i < canvas.columns; i++) grid[e.y][e.x + i] = label[i];
            placed.push({ element: e.element, x: e.x, y: e.y });
        }
        return { ...canvas, profile, text: grid.map((r) => r.join("")).join("\n"), elements: placed };
    }

    /**
     * Upload a MAX7456 .mcm font (Configurator OSD tab "Upload font"). Characters are written
     * with MSP_OSD_CHAR_WRITE (16-bit address + 64 bytes); the FC reboots to apply the font.
     */
    async uploadFont(mcm: string, progress: (m: string) => void) {
        const lines = mcm.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines[0] !== "MAX7456") throw validationError("not a MAX7456 .mcm font file");
        const bytes = lines.slice(1).map((l) => {
            if (!/^[01]{8}$/.test(l)) throw validationError(`invalid font line '${l}'`);
            return parseInt(l, 2);
        });
        if (bytes.length % 64 !== 0) throw validationError("font size is not a multiple of 64 bytes per character");
        const chars = bytes.length / 64;
        await this.s.assertDisarmed();
        for (let i = 0; i < chars; i++) {
            const payload = new PayloadWriter().u16(i).raw(bytes.slice(i * 64, i * 64 + 64)).toArray();
            await this.s.request(MSP.MSP_OSD_CHAR_WRITE, payload, { timeoutMs: 2000 });
            if (i % 32 === 0) progress(`uploading font: ${i}/${chars} characters`);
        }
        await this.s.reboot("firmware");
        return { characters: chars, rebooted: true };
    }
}
