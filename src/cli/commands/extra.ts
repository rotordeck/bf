// Blackbox, OSD layout/font, presets, firmware, waypoints.

import fs from "node:fs";
import type { CommandDef, GroupDef } from "../framework.js";
import { dryRunOpt, noSaveOpt, intArg, confirmOpt, collect } from "../framework.js";
import { BlackboxService } from "../../core/services/blackbox.js";
import { OsdService } from "../../core/services/osd.js";
import { ConfigService } from "../../core/services/config.js";
import { ListsService } from "../../core/services/lists.js";
import { PresetsRepo, loadSources, saveSources, normalizeSourceUrl, presetCli, OFFICIAL_SOURCE } from "../../core/net/presets.js";
import { BuildApi } from "../../core/net/buildapi.js";
import { detectTarget, releasesFor, buildFirmware, flashFirmware, loadImage } from "../../core/services/firmware.js";
import { listDfuDevices } from "../../core/flash/dfu.js";
import { validationError } from "../../core/errors.js";

const wr = (o: Record<string, any>) => ({ dryRun: o.dryRun, save: o.save });

const blackboxExtras: (CommandDef | GroupDef)[] = [
    {
        name: "info",
        summary: "Log storage: device, flash size/usage, SD card state",
        fc: true,
        examples: ["bf blackbox info"],
        run: async (ctx) => new BlackboxService(ctx.fc).info(),
    },
    {
        name: "download",
        summary: "Download the onboard flash log to a .bbl file (open with Blackbox Explorer / PIDtoolbox)",
        fc: true,
        options: [{ flags: "-o, --output <file>", description: "output file", default: undefined }],
        examples: ["bf blackbox download -o flight1.bbl"],
        exitCodes: [5],
        run: async (ctx) => {
            const file = ctx.opts.output ?? `blackbox_${ctx.fc.identity.board}_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.bbl`;
            return new BlackboxService(ctx.fc).download(file, ctx.progress);
        },
    },
    {
        name: "erase",
        summary: "Erase all logs on the onboard flash (destructive)",
        fc: true,
        mutates: true,
        options: [confirmOpt],
        examples: ["bf blackbox download -o backup.bbl && bf blackbox erase --confirm"],
        exitCodes: [4, 5, 6],
        run: async (ctx) => {
            ctx.requireConfirm("erasing all blackbox logs");
            return new BlackboxService(ctx.fc).erase(ctx.progress);
        },
    },
    {
        name: "msc",
        summary: "Reboot as a USB drive to copy logs (needs unplug/power-cycle to leave)",
        fc: true,
        mutates: true,
        options: [{ flags: "--utc", description: "use UTC file timestamps" }, confirmOpt],
        examples: ["bf blackbox msc --confirm"],
        exitCodes: [4, 6],
        run: async (ctx) => {
            ctx.requireConfirm("rebooting into USB mass-storage mode (the FC only leaves it when unplugged)");
            return new BlackboxService(ctx.fc).massStorage(ctx.opts.utc);
        },
    },
];

const osdExtras: (CommandDef | GroupDef)[] = [
    {
        name: "elements",
        summary: "OSD elements with position and the OSD profiles they show in",
        fc: true,
        options: [{ flags: "--all", description: "include hidden elements" }],
        examples: ["bf osd elements", "bf osd elements --all --json"],
        run: async (ctx) => (await new OsdService(ctx.fc).elements({ all: ctx.opts.all })).map(({ raw: _raw, ...e }) => e),
    },
    {
        name: "element <name>",
        summary: "Move, show or hide one OSD element",
        fc: true,
        mutates: true,
        options: [
            { flags: "--pos <x,y>", description: "column,row (0-based)" },
            { flags: "--profiles <list>", description: "OSD profiles to show it in, e.g. 1 or 1,2,3; 'none' hides it" },
            { flags: "--show", description: "show in OSD profile 1 (shorthand for --profiles 1)" },
            { flags: "--hide", description: "hide in all profiles" },
            { flags: "--variant <n>", description: "element display variant 0-3", parse: intArg },
            dryRunOpt,
            noSaveOpt,
        ],
        examples: ["bf osd element rssi --pos 2,1 --show", "bf osd element vbat --profiles 1,2", "bf osd element crosshairs --hide"],
        run: async (ctx) => {
            let profiles: number[] | undefined;
            if (ctx.opts.hide || ctx.opts.profiles === "none") profiles = [];
            else if (ctx.opts.profiles) profiles = String(ctx.opts.profiles).split(",").map((p) => intArg(p.trim()));
            else if (ctx.opts.show) profiles = [1];
            let x: number | undefined, y: number | undefined;
            if (ctx.opts.pos) {
                const m = /^(\d+),(\d+)$/.exec(ctx.opts.pos);
                if (!m) throw validationError("--pos takes x,y e.g. 2,1");
                x = Number(m[1]);
                y = Number(m[2]);
            }
            return new OsdService(ctx.fc).setElement(ctx.args[0], { x, y, profiles, variant: ctx.opts.variant, ...wr(ctx.opts) });
        },
    },
    {
        name: "preview",
        summary: "Text rendering of the OSD layout (3-letter labels)",
        fc: true,
        options: [{ flags: "--profile <n>", description: "OSD profile", default: 1, parse: intArg }],
        examples: ["bf osd preview", "bf osd preview --profile 2"],
        run: async (ctx) => new OsdService(ctx.fc).preview(ctx.opts.profile),
        human: (d) => `${d.videoSystem} ${d.columns}x${d.rows}, OSD profile ${d.profile}\n${d.text}`,
    },
    {
        name: "font <file>",
        summary: "Upload a MAX7456 .mcm font (analog OSD); the FC reboots",
        fc: true,
        mutates: true,
        options: [confirmOpt],
        examples: ["bf osd font betaflight.mcm --confirm"],
        exitCodes: [4, 6],
        run: async (ctx) => {
            ctx.requireConfirm("replacing the OSD font");
            return new OsdService(ctx.fc).uploadFont(fs.readFileSync(ctx.args[0], "utf8"), ctx.progress);
        },
    },
];

const presetsCmd: GroupDef = {
    name: "presets",
    summary: "Find and apply community presets (tunes, rates, VTX tables, OSD, ...) (Configurator: Presets)",
    commands: [
        {
            name: "search [text...]",
            summary: "Search presets; defaults to the connected FC's firmware version when --firmware is not given and an FC is connected",
            options: [
                { flags: "--category <c>", description: "TUNE, RATES, FILTERS, RC_LINK, VTX, OSD, LEDS, MODES, BNF, OTHER" },
                { flags: "--firmware <v>", description: "firmware version, e.g. 4.5 or 2025.12" },
                { flags: "--status <s>", description: "OFFICIAL, COMMUNITY or EXPERIMENTAL" },
                { flags: "--author <name>", description: "author substring" },
                { flags: "--limit <n>", description: "max results", default: 30, parse: intArg },
            ],
            examples: ["bf presets search --category VTX --firmware 4.5", "bf presets search air75 --json", "bf presets search elrs --category RC_LINK"],
            run: async (ctx) => {
                const out = [];
                for (const src of loadSources()) out.push(...(await new PresetsRepo(src).search({ text: ctx.args.join(" "), category: ctx.opts.category, firmware: ctx.opts.firmware, status: ctx.opts.status, author: ctx.opts.author })));
                return out.slice(0, ctx.opts.limit);
            },
        },
        {
            name: "show <id>",
            summary: "Description, warnings, options and CLI lines of a preset",
            options: [{ flags: "--cli", description: "include the CLI lines it would run (with default options)" }],
            examples: ["bf presets show 4.5/rates/ctzsnooze/actual_rates --cli"],
            run: async (ctx) => {
                const { repo, entry } = await findPreset(ctx.args[0]);
                const d = await repo.details(entry);
                const { lines, ...rest } = d;
                return ctx.opts.cli ? { ...rest, cli: presetCli(lines, d.options).cli } : rest;
            },
        },
        {
            name: "apply <id>",
            summary: "Apply a preset to the FC (backs up first, applies only what differs)",
            description:
                "Loads the preset, selects options (defaults: the preset's checked options; --option enables, --without disables), " +
                "writes a backup, then applies the lines idempotently and saves. Read the preset's warning first (`bf presets show`).",
            fc: true,
            mutates: true,
            options: [
                { flags: "--option <name>", description: "enable an option (repeatable)", parse: collect },
                { flags: "--without <name>", description: "disable an option (repeatable)", parse: collect },
                { flags: "--backup <file>", description: "backup file (default: auto-named)" },
                dryRunOpt,
                confirmOpt,
            ],
            examples: ["bf presets apply 4.5/rates/ctzsnooze/actual_rates --dry-run", "bf presets apply 4.5/vtx/tbs/unify_pro32 --option '25mW only' --confirm"],
            exitCodes: [4, 6, 8],
            run: async (ctx) => {
                const { repo, entry } = await findPreset(ctx.args[0]);
                const d = await repo.details(entry);
                const fw = ctx.fc.identity.version;
                if (!entry.firmware_version.some((v) => fw.startsWith(v))) {
                    ctx.progress(`warning: preset is for firmware ${entry.firmware_version.join(", ")}, FC runs ${fw}`);
                }
                const { cli, selected } = presetCli(d.lines, d.options, ctx.opts.option ?? [], ctx.opts.without ?? []);
                if (!ctx.opts.dryRun) {
                    ctx.requireConfirm(`applying preset '${d.title}'`);
                    const plan = await new ConfigService(ctx.fc).apply(cli, { dryRun: true });
                    if (plan.changed.length === 0) return { preset: d.id, options: selected, ...plan, dryRun: false };
                    const backup = ctx.opts.backup ?? `BTFL_backup_before_preset_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.txt`;
                    fs.writeFileSync(backup, await new ConfigService(ctx.fc).diff("all"));
                    ctx.progress(`backup written to ${backup}`);
                    const r = await new ConfigService(ctx.fc).apply(cli);
                    return { preset: d.id, options: selected, backup, ...r };
                }
                return { preset: d.id, options: selected, warning: d.warning, ...(await new ConfigService(ctx.fc).apply(cli, { dryRun: true })) };
            },
        },
        {
            name: "sources",
            summary: "Preset repositories",
            commands: [
                { name: "list", summary: "Configured preset sources", examples: ["bf presets sources list"], run: async () => loadSources() },
                {
                    name: "add <name> <url>",
                    summary: "Add a source (GitHub repo URL or a URL containing index.json)",
                    options: [{ flags: "--branch <b>", description: "GitHub branch", default: "master" }],
                    examples: ["bf presets sources add mine https://github.com/me/firmware-presets"],
                    run: async (ctx) => {
                        const s = loadSources().filter((x) => x.name !== ctx.args[0]);
                        const src = { name: ctx.args[0], url: normalizeSourceUrl(ctx.args[1], ctx.opts.branch) };
                        await new PresetsRepo(src).load();
                        saveSources([...s, src]);
                        return src;
                    },
                },
                {
                    name: "remove <name>",
                    summary: "Remove a source",
                    examples: ["bf presets sources remove mine"],
                    run: async (ctx) => {
                        const s = loadSources().filter((x) => x.name !== ctx.args[0]);
                        saveSources(s.length ? s : [OFFICIAL_SOURCE]);
                        return s;
                    },
                },
            ],
        },
    ],
};

async function findPreset(id: string) {
    for (const src of loadSources()) {
        const repo = new PresetsRepo(src);
        const entry = await repo.find(id);
        if (entry) return { repo, entry };
    }
    throw validationError(`preset '${id}' not found`, "find ids with `bf presets search`");
}

const firmwareCmd: GroupDef = {
    name: "firmware",
    summary: "Find, build and flash firmware (Configurator: Firmware Flasher)",
    commands: [
        {
            name: "detect",
            summary: "Which build target the connected board is, and what it runs",
            fc: true,
            examples: ["bf firmware detect --json"],
            run: async (ctx) => detectTarget(ctx.fc),
        },
        {
            name: "targets [filter]",
            summary: "Board targets on the build server",
            examples: ["bf firmware targets speedybee", "bf firmware targets --json"],
            run: async (ctx) => (await BuildApi.targets()).filter((t) => !ctx.args[0] || t.target.toLowerCase().includes(ctx.args[0].toLowerCase())),
        },
        {
            name: "releases <target>",
            summary: "Firmware releases available for a target",
            options: [{ flags: "--unstable", description: "include release candidates and dev builds" }],
            examples: ["bf firmware releases SPEEDYBEEF405V4"],
            run: async (ctx) => releasesFor(ctx.args[0], ctx.opts.unstable),
        },
        {
            name: "options <release>",
            summary: "Build options (radio/telemetry/motor protocols, features) for a release",
            examples: ["bf firmware options 2025.12.5 --json"],
            run: async (ctx) => BuildApi.options(ctx.args[0]),
        },
        {
            name: "build <target>",
            summary: "Cloud-build a firmware and download the .hex",
            description: "Requests a build from build.betaflight.com (CLOUD_BUILD with the given options, or server defaults per category) and downloads it.",
            options: [
                { flags: "--release <r>", description: "release (default: latest stable)" },
                { flags: "--option <name>", description: "build option by name or define, repeatable (e.g. CRSF, USE_GPS)", parse: collect },
                { flags: "--core", description: "core build only (no options)" },
                { flags: "--commit <sha>", description: "commit (unstable releases)" },
                { flags: "-o, --output <file>", description: "output file" },
            ],
            examples: ["bf firmware build SPEEDYBEEF405V4 --option CRSF --option USE_GPS --option USE_LED_STRIP", "bf firmware build $(bf firmware detect --json | jq -r .data.buildTarget)"],
            run: async (ctx) =>
                buildFirmware(
                    { target: ctx.args[0], release: ctx.opts.release, options: ctx.opts.option, core: ctx.opts.core, commit: ctx.opts.commit, output: ctx.opts.output },
                    ctx.progress,
                ),
        },
        {
            name: "check <file>",
            summary: "Parse a .hex/.bin file and report its address range (no FC needed)",
            examples: ["bf firmware check betaflight_2025.12.5_STM32F405_SPEEDYBEEF405V4.hex"],
            run: async (ctx) => {
                const img = loadImage(ctx.args[0]);
                return { blocks: img.blocks.length, bytes: img.bytesTotal, start: `0x${img.startAddress.toString(16)}`, end: `0x${img.endAddress.toString(16)}` };
            },
        },
        {
            name: "dfu-devices",
            summary: "Boards currently in DFU (bootloader) mode",
            examples: ["bf firmware dfu-devices"],
            run: async () => (await listDfuDevices()).map(({ device: _d, ...rest }) => rest),
        },
        {
            name: "flash <file>",
            summary: "Flash firmware: back up config, reboot to DFU, flash, verify (DESTRUCTIVE)",
            description:
                "Backs up the configuration (diff all), reboots the FC into its DFU bootloader, flashes and verifies the image, waits for the FC. " +
                "--restore replays the backup afterwards (only when moving between compatible versions). If no FC answers but a DFU device is present, flashes it directly.",
            mutates: true,
            options: [
                { flags: "--full-erase", description: "erase the whole chip (also wipes the configuration)" },
                { flags: "--no-backup", description: "skip the configuration backup" },
                { flags: "--restore", description: "restore the backup after flashing" },
                { flags: "--method <m>", description: "dfu (USB) or serial (STM32 UART bootloader)", default: "dfu", choices: ["dfu", "serial"] },
                { flags: "--serial-port <path>", description: "UART adapter for --method serial" },
                confirmOpt,
            ],
            examples: ["bf firmware flash betaflight_2025.12.5_SPEEDYBEEF405V4.hex --confirm", "bf firmware flash fw.hex --full-erase --confirm"],
            exitCodes: [4, 6, 7],
            run: async (ctx) => {
                ctx.requireConfirm("flashing firmware");
                return flashFirmware({
                    file: ctx.args[0],
                    method: ctx.opts.method,
                    serialPort: ctx.opts.serialPort,
                    fullErase: ctx.opts.fullErase,
                    noBackup: ctx.opts.backup === false,
                    restore: ctx.opts.restore,
                    connect: { port: ctx.global.port ?? process.env.BF_PORT, baudRate: ctx.global.baud },
                    progress: ctx.progress,
                });
            },
        },
    ],
};

const waypointsCmd: GroupDef = {
    name: "waypoints",
    summary: "Waypoint missions stored on the FC (Configurator: Flight Plan)",
    commands: [
        { name: "list", summary: "Stored waypoints as CLI lines", fc: true, examples: ["bf waypoints list"], run: async (ctx) => new ListsService(ctx.fc).waypoints() },
        {
            name: "load <file>",
            summary: "Replace the mission with `waypoint insert ...` lines from a file",
            fc: true,
            mutates: true,
            options: [confirmOpt],
            examples: ["bf waypoints load mission.txt --confirm"],
            exitCodes: [4, 6, 8],
            run: async (ctx) => {
                ctx.requireConfirm("replacing the waypoint mission");
                return new ListsService(ctx.fc).loadWaypoints(fs.readFileSync(ctx.args[0], "utf8").split(/\r?\n/));
            },
        },
        {
            name: "clear",
            summary: "Delete all waypoints",
            fc: true,
            mutates: true,
            options: [confirmOpt],
            examples: ["bf waypoints clear --confirm"],
            run: async (ctx) => {
                ctx.requireConfirm("deleting all waypoints");
                return new ListsService(ctx.fc).clearWaypoints();
            },
        },
    ],
};

export function blackboxCommands() {
    return blackboxExtras;
}
export function osdCommands() {
    return osdExtras;
}

export function extraCommands(): (CommandDef | GroupDef)[] {
    return [presetsCmd, firmwareCmd, waypointsCmd];
}
