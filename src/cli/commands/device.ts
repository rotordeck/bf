import fs from "node:fs";
import type { CommandDef, GroupDef } from "../framework.js";
import { confirmOpt } from "../framework.js";
import { listHostPorts } from "../../core/transport/transport.js";
import { LiveService } from "../../core/services/live.js";
import { REBOOT_MODES, type RebootMode } from "../../core/msp/messages.js";
import { waitForFc } from "../../core/session.js";
import { validationError } from "../../core/errors.js";

export const portsCmd: CommandDef = {
    name: "ports",
    summary: "List serial ports on this computer (flight controllers are marked)",
    options: [{ flags: "--all", description: "include ports without a USB id (legacy ttyS*)" }],
    examples: ["bf ports", "bf ports --json"],
    run: async (ctx) => listHostPorts(!!ctx.opts.all),
};

export const infoCmd: CommandDef = {
    name: "info",
    summary: "Identify the connected flight controller (firmware, board, MCU, build)",
    fc: true,
    examples: ["bf info", "bf info --json --port /dev/ttyACM0"],
    run: async (ctx) => {
        const i = ctx.fc.identity;
        return {
            firmware: `${i.variant === "BTFL" ? "Betaflight" : i.variant} ${i.version}`,
            version: i.version,
            api: i.api,
            board: i.board,
            target: i.target,
            manufacturer: i.manufacturer || undefined,
            mcu: i.mcu,
            uid: i.uid,
            build: i.build,
            gyroSampleRateHz: i.boardInfo.gyroSampleRateHz,
            capabilities: i.boardInfo.capabilities,
            problems: i.boardInfo.problems,
            port: i.port,
        };
    },
};

export const statusCmd: CommandDef = {
    name: "status",
    summary: "Arming state, arming-disable flags, active modes, profiles, CPU load, sensors",
    description:
        "Show live status. `canArm` is false while any arming-disable flag is set; `armingDisabledFlags` lists them " +
        "(see the troubleshoot-wont-arm skill for what each flag means). Use --watch to stream.",
    fc: true,
    options: [
        { flags: "--watch", description: "stream status until interrupted (NDJSON with --json)" },
        { flags: "--interval <ms>", description: "watch interval", default: 500, parse: Number },
    ],
    examples: ["bf status", "bf status --json | jq .data.armingDisabledFlags", "bf status --watch --interval 1000"],
    run: async (ctx) => {
        if (!ctx.opts.watch) return ctx.fc.status();
        const live = new LiveService(ctx.fc);
        await live.watch("status", { intervalMs: ctx.opts.interval, stop: () => ctx.interrupted }, (s) => ctx.emit(s));
        return undefined;
    },
};

export const saveCmd: CommandDef = {
    name: "save",
    summary: "Write the current (RAM) configuration to EEPROM, without rebooting",
    fc: true,
    mutates: true,
    options: [{ flags: "--reboot", description: "reboot afterwards (needed when rebootRequired is true)" }],
    examples: ["bf save", "bf save --reboot"],
    exitCodes: [4],
    run: async (ctx) => {
        const r = await ctx.fc.save();
        if (ctx.opts.reboot) {
            await ctx.fc.reboot("firmware");
            return { ...r, rebooted: true };
        }
        return r;
    },
};

export const rebootCmd: CommandDef = {
    name: "reboot",
    summary: "Reboot the flight controller (normally, into DFU/bootloader, or as a USB drive)",
    description:
        "Reboot. Modes: firmware (default), bootloader (ROM DFU, for flashing), bootloader-flash (flash bootloader), " +
        "msc / msc-utc (expose SD card/flash as a USB drive). Unsaved changes are lost: run `bf save` first. " +
        "Bootloader modes require --confirm because the FC stops responding to MSP until it is flashed or power-cycled.",
    fc: true,
    mutates: true,
    options: [
        { flags: "--mode <mode>", description: "reboot target", default: "firmware", choices: Object.keys(REBOOT_MODES) },
        { flags: "--wait", description: "wait until the FC is back (firmware mode only)" },
        confirmOpt,
    ],
    examples: ["bf reboot", "bf reboot --wait", "bf reboot --mode bootloader --confirm", "bf reboot --mode msc"],
    exitCodes: [4, 6],
    run: async (ctx) => {
        const mode = ctx.opts.mode as RebootMode;
        if (mode.startsWith("bootloader")) ctx.requireConfirm(`rebooting into ${mode}`);
        const port = ctx.fc.identity.port;
        await ctx.fc.reboot(mode);
        if (ctx.opts.wait && mode === "firmware") {
            ctx.progress("waiting for the flight controller to come back...");
            const s = await waitForFc({ port: ctx.global.port ?? process.env.BF_PORT ?? port, baudRate: ctx.global.baud });
            const st = await s.status();
            await s.close();
            return { rebooted: true, mode, back: true, armingDisabledFlags: st.armingDisabledFlags };
        }
        return { rebooted: true, mode };
    },
};

export const defaultsCmd: CommandDef = {
    name: "defaults",
    summary: "Reset ALL configuration to firmware defaults and reboot (destructive)",
    description: "Erases the whole configuration (PIDs, rates, modes, ports, OSD, ...). Take a backup first: `bf config backup -o backup.txt`.",
    fc: true,
    mutates: true,
    options: [confirmOpt],
    examples: ["bf config backup -o before-reset.txt && bf defaults --confirm"],
    exitCodes: [4, 6],
    run: async (ctx) => {
        ctx.requireConfirm("resetting the whole configuration to defaults");
        return new LiveService(ctx.fc).resetToDefaults();
    },
};

export const nameCmd: GroupDef = {
    name: "name",
    summary: "Craft and pilot name",
    commands: [
        {
            name: "get",
            summary: "Show craft and pilot name",
            fc: true,
            examples: ["bf name get"],
            run: async (ctx) => new LiveService(ctx.fc).names(),
        },
        {
            name: "set",
            summary: "Set craft and/or pilot name (shown in OSD and Configurator)",
            fc: true,
            mutates: true,
            options: [
                { flags: "--craft <name>", description: "craft name (max 16 chars, '' to clear)" },
                { flags: "--pilot <name>", description: "pilot name (max 16 chars, '' to clear)" },
            ],
            examples: ["bf name set --craft 'Chimera7' --pilot 'Pilot'"],
            run: async (ctx) => {
                if (ctx.opts.craft === undefined && ctx.opts.pilot === undefined) throw validationError("give --craft and/or --pilot");
                return new LiveService(ctx.fc).setNames({ craftName: ctx.opts.craft, pilotName: ctx.opts.pilot });
            },
        },
    ],
};

export const versionCmd: CommandDef = {
    name: "version",
    summary: "Show the bf version",
    examples: ["bf version"],
    run: async () => {
        const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
        return { name: "bf", version: pkg.version };
    },
};
