// One command group per Configurator tab: `bf <area> get|set` over the area's settings,
// plus the tab-specific actions (modes, motor test, channel map, ...).

import fs from "node:fs";
import type { CommandDef, GroupDef } from "../framework.js";
import { dryRunOpt, noSaveOpt, parseAssignments, intArg, confirmOpt, collect } from "../framework.js";
import { GROUPS, GroupsService, groupByName, type GroupSpec } from "../../core/services/groups.js";
import { ListsService, ADJUSTMENT_FUNCTIONS } from "../../core/services/lists.js";
import { LiveService, TELEMETRY_KINDS, type TelemetryKind } from "../../core/services/live.js";
import { ProfilesService, type ProfileKind } from "../../core/services/profiles.js";
import { DSHOT_CMD } from "../../core/msp/messages.js";
import { validationError } from "../../core/errors.js";
import { table } from "../format.js";
import { blackboxCommands, osdCommands } from "./extra.js";

const profileOpt = { flags: "--profile <n>", description: "profile number (1-based); default: the active profile", parse: intArg };

function groupGetSet(g: GroupSpec): CommandDef[] {
    const profiled = !!g.scope && g.scope !== "global";
    const aliasHint = g.aliases ? ` Aliases: ${Object.keys(g.aliases).slice(0, 6).join(", ")}, ...` : "";
    const sampleKey = g.aliases ? Object.keys(g.aliases)[0] : undefined;
    return [
        {
            name: "get",
            summary: `Show ${g.title.toLowerCase()} (Configurator: ${g.tab})`,
            fc: true,
            options: [profileOpt, { flags: "--all-profiles", description: "show every profile" }],
            examples: [`bf ${g.name} get`, `bf ${g.name} get --json`, ...(profiled ? [`bf ${g.name} get --profile 2`] : [])],
            run: async (ctx) => new GroupsService(ctx.fc).get(g, { profile: ctx.opts.profile, allProfiles: ctx.opts.allProfiles }),
        },
        {
            name: "set <assignments...>",
            summary: `Change ${g.title.toLowerCase()}: name=value ...`,
            description: `Set settings that belong to ${g.title.toLowerCase()} (validated, idempotent, verified, saved).${aliasHint}`,
            fc: true,
            mutates: true,
            options: [profileOpt, dryRunOpt, noSaveOpt],
            examples: g.aliases
                ? [`bf ${g.name} set ${sampleKey}=45`, `bf ${g.name} set ${Object.keys(g.aliases).slice(0, 2).map((k) => `${k}=50`).join(" ")} --profile 2 --dry-run`]
                : [`bf ${g.name} get --json  # find names first`, `bf ${g.name} set <name>=<value> --dry-run`],
            exitCodes: [4, 7],
            run: async (ctx) =>
                new GroupsService(ctx.fc).set(g, parseAssignments(ctx.args), { profile: ctx.opts.profile, dryRun: ctx.opts.dryRun, save: ctx.opts.save }),
        },
    ];
}

function area(name: string, extra: (CommandDef | GroupDef)[] = [], summary?: string): GroupDef {
    const g = groupByName(name)!;
    return { name, summary: summary ?? `${g.title} (Configurator: ${g.tab})`, commands: [...groupGetSet(g), ...extra] };
}

const wr = (o: Record<string, any>) => ({ dryRun: o.dryRun, save: o.save });

// ---------------- profiles ----------------

function profileCommands(kind: ProfileKind): GroupDef {
    const label = { pid: "PID profile", rate: "rate profile", battery: "battery profile" }[kind];
    const name = { pid: "profile", rate: "rateprofile", battery: "battery-profile" }[kind];
    const cmds: CommandDef[] = [
        { name: "list", summary: `List ${label}s and which is active`, fc: true, examples: [`bf ${name} list`], run: async (ctx) => new ProfilesService(ctx.fc).list(kind) },
        {
            name: "select <n>",
            summary: `Activate ${label} n (1-based) and save`,
            fc: true,
            mutates: true,
            examples: [`bf ${name} select 2`],
            exitCodes: [4],
            run: async (ctx) => new ProfilesService(ctx.fc).select(kind, intArg(ctx.args[0])),
        },
        {
            name: "rename <n> <label>",
            summary: `Name ${label} n (max 8 characters)`,
            fc: true,
            mutates: true,
            examples: [`bf ${name} rename 1 RACE`],
            run: async (ctx) => new ProfilesService(ctx.fc).rename(kind, intArg(ctx.args[0]), ctx.args[1]),
        },
    ];
    if (kind !== "battery") {
        cmds.push({
            name: "copy <from> <to>",
            summary: `Copy ${label} <from> over <to> (destructive for <to>)`,
            fc: true,
            mutates: true,
            options: [dryRunOpt, confirmOpt],
            examples: [`bf ${name} copy 1 2 --confirm`],
            exitCodes: [4, 6],
            run: async (ctx) => {
                if (!ctx.opts.dryRun) ctx.requireConfirm(`overwriting ${label} ${ctx.args[1]}`);
                return new ProfilesService(ctx.fc).copy(kind as "pid" | "rate", intArg(ctx.args[0]), intArg(ctx.args[1]), { dryRun: ctx.opts.dryRun });
            },
        });
    }
    if (kind === "pid") {
        cmds.push({
            name: "reset <n>",
            summary: "Reset PID profile n to firmware defaults",
            fc: true,
            mutates: true,
            options: [confirmOpt],
            examples: ["bf profile reset 3 --confirm"],
            exitCodes: [4, 6],
            run: async (ctx) => {
                ctx.requireConfirm(`resetting PID profile ${ctx.args[0]}`);
                return new ProfilesService(ctx.fc).resetPid(intArg(ctx.args[0]));
            },
        });
    }
    return { name, summary: `Select, copy, rename ${label}s`, commands: cmds };
}

// ---------------- modes / adjustments ----------------

const modesCmd: GroupDef = {
    name: "modes",
    summary: "Flight modes on AUX switches: ARM, ANGLE, BEEPER, ... (Configurator: Modes)",
    commands: [
        {
            name: "available",
            summary: "Modes this firmware build offers",
            fc: true,
            examples: ["bf modes available"],
            run: async (ctx) => new ListsService(ctx.fc).modeCatalog(),
        },
        {
            name: "list",
            summary: "Configured mode ranges",
            fc: true,
            options: [{ flags: "--all", description: "include unused slots" }],
            examples: ["bf modes list", "bf modes list --json"],
            run: async (ctx) => new ListsService(ctx.fc).modes({ all: ctx.opts.all }),
        },
        {
            name: "set <mode>",
            summary: "Activate <mode> when an AUX channel is inside a range (updates the existing range of that mode)",
            description:
                "AUX1 is RC channel 5. Ranges are in microseconds (900..2100), snapped to 25us steps. A typical 2-position " +
                "switch is 1000 (low) / 2000 (high), so 1700-2100 means 'switch high'. Use --add for a second range of the same mode.",
            fc: true,
            mutates: true,
            options: [
                { flags: "--aux <channel>", description: "AUX1..AUX20 (or 1..20)" },
                { flags: "--range <start-end>", description: "e.g. 1700-2100" },
                { flags: "--logic <OR|AND>", description: "how multiple ranges of a mode combine", default: "OR", choices: ["OR", "AND"] },
                { flags: "--link <mode>", description: "link to another mode instead of a channel range" },
                { flags: "--slot <n>", description: "use this slot index", parse: intArg },
                { flags: "--add", description: "add another range instead of updating the existing one" },
                dryRunOpt,
                noSaveOpt,
            ],
            examples: ["bf modes set ARM --aux 1 --range 1700-2100", "bf modes set ANGLE --aux 2 --range 900-1300", "bf modes set BEEPER --aux 3 --range 1700-2100 --dry-run"],
            exitCodes: [4],
            run: async (ctx) => {
                if (!ctx.opts.aux || !ctx.opts.range) throw validationError("--aux and --range are required");
                return new ListsService(ctx.fc).setMode(ctx.args[0], { channel: ctx.opts.aux, range: ctx.opts.range, logic: ctx.opts.logic, linkTo: ctx.opts.link, slot: ctx.opts.slot, add: ctx.opts.add, ...wr(ctx.opts) });
            },
        },
        {
            name: "remove <mode>",
            summary: "Remove the range(s) of a mode",
            fc: true,
            mutates: true,
            options: [{ flags: "--slot <n>", description: "only this slot", parse: intArg }, dryRunOpt, noSaveOpt],
            examples: ["bf modes remove ANGLE"],
            run: async (ctx) => new ListsService(ctx.fc).removeMode(ctx.args[0], { slot: ctx.opts.slot, ...wr(ctx.opts) }),
        },
    ],
};

const adjustmentsCmd: GroupDef = {
    name: "adjustments",
    summary: "In-flight adjustments of rates/PIDs/profiles from AUX channels (Configurator: Adjustments)",
    commands: [
        {
            name: "functions",
            summary: "List adjustment functions",
            examples: ["bf adjustments functions"],
            run: async () => ADJUSTMENT_FUNCTIONS.slice(1),
        },
        {
            name: "list",
            summary: "Configured adjustment ranges",
            fc: true,
            options: [{ flags: "--all", description: "include unused slots" }],
            examples: ["bf adjustments list"],
            run: async (ctx) => new ListsService(ctx.fc).adjustments({ all: ctx.opts.all }),
        },
        {
            name: "set <function>",
            summary: "Configure an adjustment",
            fc: true,
            mutates: true,
            options: [
                { flags: "--when <aux>", description: "AUX channel that enables the adjustment" },
                { flags: "--range <start-end>", description: "range on that channel", default: "1700-2100" },
                { flags: "--with <aux>", description: "AUX channel that provides the value" },
                { flags: "--center <n>", description: "center value (absolute mode)", parse: intArg },
                { flags: "--scale <n>", description: "scale (absolute mode)", parse: intArg },
                { flags: "--slot <n>", description: "slot index", parse: intArg },
                dryRunOpt,
                noSaveOpt,
            ],
            examples: ["bf adjustments set RATE_PROFILE --when AUX4 --range 900-2100 --with AUX4", "bf adjustments set PITCH_ROLL_P --when AUX3 --with AUX5"],
            run: async (ctx) => {
                if (!ctx.opts.when || !ctx.opts.with) throw validationError("--when and --with are required");
                return new ListsService(ctx.fc).setAdjustment(ctx.args[0], {
                    rangeChannel: ctx.opts.when,
                    range: ctx.opts.range,
                    valueChannel: ctx.opts.with,
                    center: ctx.opts.center,
                    scale: ctx.opts.scale,
                    slot: ctx.opts.slot,
                    ...wr(ctx.opts),
                });
            },
        },
        {
            name: "remove <slot>",
            summary: "Clear an adjustment slot",
            fc: true,
            mutates: true,
            options: [dryRunOpt, noSaveOpt],
            examples: ["bf adjustments remove 0"],
            run: async (ctx) => new ListsService(ctx.fc).removeAdjustment(intArg(ctx.args[0]), wr(ctx.opts)),
        },
    ],
};

// ---------------- features / beepers ----------------

function toggleList(kind: "feature" | "beeper" | "beacon"): GroupDef {
    const what = { feature: "features", beeper: "beeper conditions", beacon: "DShot beacon conditions" }[kind];
    const list = (s: ListsService) => (kind === "feature" ? s.features() : s.beepers(kind));
    const set = (s: ListsService, on: string[], off: string[], o: any) => (kind === "feature" ? s.setFeatures(on, off, o) : s.setBeepers(kind, on, off, o));
    return {
        name: kind,
        summary: `Enable/disable ${what}`,
        commands: [
            { name: "list", summary: `List ${what}`, fc: true, examples: [`bf ${kind} list`], run: async (ctx) => list(new ListsService(ctx.fc)) },
            {
                name: "enable <names...>",
                summary: `Enable ${what}`,
                fc: true,
                mutates: true,
                options: [dryRunOpt, noSaveOpt],
                examples: [kind === "feature" ? "bf feature enable GPS TELEMETRY" : `bf ${kind} enable RX_LOST`],
                run: async (ctx) => set(new ListsService(ctx.fc), ctx.args, [], wr(ctx.opts)),
            },
            {
                name: "disable <names...>",
                summary: `Disable ${what}`,
                fc: true,
                mutates: true,
                options: [dryRunOpt, noSaveOpt],
                examples: [kind === "feature" ? "bf feature disable AIRMODE" : `bf ${kind} disable GYRO_CALIBRATED`],
                run: async (ctx) => set(new ListsService(ctx.fc), [], ctx.args, wr(ctx.opts)),
            },
        ],
    };
}

// ---------------- receiver ----------------

const receiverExtras: (CommandDef | GroupDef)[] = [
    {
        name: "map [order]",
        summary: "Show or set the RC channel order (e.g. AETR1234, TAER1234)",
        fc: true,
        mutates: true,
        options: [dryRunOpt, noSaveOpt],
        examples: ["bf receiver map", "bf receiver map TAER1234"],
        run: async (ctx) => {
            const s = new ListsService(ctx.fc);
            return ctx.args[0] ? s.setChannelMap(ctx.args[0], wr(ctx.opts)) : s.channelMap();
        },
    },
    {
        name: "rxfail [channel]",
        summary: "Show or set per-channel failsafe behavior (auto/hold/set)",
        fc: true,
        mutates: true,
        options: [
            { flags: "--mode <mode>", description: "auto | hold | set", choices: ["auto", "hold", "set"] },
            { flags: "--value <us>", description: "value for mode 'set'", parse: intArg },
            dryRunOpt,
            noSaveOpt,
        ],
        examples: ["bf receiver rxfail", "bf receiver rxfail 5 --mode set --value 1000"],
        run: async (ctx) => {
            const s = new ListsService(ctx.fc);
            if (ctx.args[0] === undefined) return s.rxFail();
            if (!ctx.opts.mode) throw validationError("--mode is required when a channel is given");
            return s.setRxFail(intArg(ctx.args[0]), ctx.opts.mode, ctx.opts.value, wr(ctx.opts));
        },
    },
    { name: "rxrange", summary: "Channel endpoint calibration (rxrange)", fc: true, examples: ["bf receiver rxrange"], run: async (ctx) => new ListsService(ctx.fc).rxRange() },
    {
        name: "bind",
        summary: "Put an SPI/serial receiver into bind mode (where supported)",
        fc: true,
        mutates: true,
        examples: ["bf receiver bind"],
        exitCodes: [4],
        run: async (ctx) => new LiveService(ctx.fc).bind(),
    },
    {
        name: "live",
        summary: "Live RC channel values (check switches and stick directions)",
        fc: true,
        options: [
            { flags: "--watch", description: "stream until interrupted" },
            { flags: "--interval <ms>", description: "watch interval", default: 200, parse: intArg },
        ],
        examples: ["bf receiver live", "bf receiver live --watch --json"],
        run: async (ctx) => {
            const live = new LiveService(ctx.fc);
            if (!ctx.opts.watch) return live.read("rc");
            await live.watch("rc", { intervalMs: ctx.opts.interval, stop: () => ctx.interrupted }, (s) => ctx.emit(s));
            return undefined;
        },
    },
];

// ---------------- motors ----------------

const motorsExtras: (CommandDef | GroupDef)[] = [
    {
        name: "test",
        summary: "Spin motors for a short time (REMOVE PROPELLERS)",
        description:
            "Spins motors via MSP like the Configurator Motors tab. PROPELLERS MUST BE REMOVED. Requires --confirm-props-removed. " +
            "Values: 1000 = stop .. 2000 = full; capped by --max-value (default 1300). Motors stop after --duration or on Ctrl-C.",
        fc: true,
        mutates: true,
        options: [
            { flags: "--motor <n>", description: "motor number (1-based), repeatable, or 'all'", parse: collect },
            { flags: "--value <n>", description: "output value 1000..2000", default: 1100, parse: intArg },
            { flags: "--duration <ms>", description: "how long to spin", default: 2000, parse: intArg },
            { flags: "--max-value <n>", description: "safety cap", default: 1300, parse: intArg },
            { flags: "--confirm-props-removed", description: "required: confirms the propellers are off" },
        ],
        examples: ["bf motors test --motor 1 --value 1080 --confirm-props-removed", "bf motors test --motor all --duration 1000 --confirm-props-removed"],
        exitCodes: [4, 6],
        run: async (ctx) => {
            ctx.requireConfirm("spinning motors", "--confirm-props-removed");
            const sel: string[] = ctx.opts.motor ?? [];
            if (!sel.length) throw validationError("give --motor <n> (repeatable) or --motor all");
            const motors = sel.includes("all") ? [1, 2, 3, 4, 5, 6, 7, 8] : sel.map(intArg);
            const live = new LiveService(ctx.fc);
            if (sel.includes("all")) {
                const outs = (await live.read("motors")) as number[];
                motors.splice(0, motors.length, ...outs.map((v, i) => (v > 0 ? i + 1 : 0)).filter(Boolean));
            }
            return live.motorTest({ motors, value: ctx.opts.value, durationMs: ctx.opts.duration, maxValue: ctx.opts.maxValue, stop: () => ctx.interrupted, progress: ctx.progress });
        },
    },
    {
        name: "direction <motor>",
        summary: "Set ESC spin direction via DShot commands (BLHeli_32/Bluejay/AM32)",
        fc: true,
        mutates: true,
        options: [
            { flags: "--reversed", description: "reversed direction (default: normal)" },
            { flags: "--confirm-props-removed", description: "required: confirms the propellers are off" },
        ],
        examples: ["bf motors direction 2 --reversed --confirm-props-removed", "bf motors direction all --confirm-props-removed"],
        exitCodes: [4, 6],
        run: async (ctx) => {
            ctx.requireConfirm("sending DShot direction commands", "--confirm-props-removed");
            const motor = ctx.args[0] === "all" ? 0 : intArg(ctx.args[0]);
            const cmd = ctx.opts.reversed ? DSHOT_CMD.SPIN_DIRECTION_REVERSED : DSHOT_CMD.SPIN_DIRECTION_NORMAL;
            await new LiveService(ctx.fc).dshotCommand(motor, [cmd, DSHOT_CMD.SAVE_SETTINGS]);
            return { motor: ctx.args[0], direction: ctx.opts.reversed ? "reversed" : "normal", savedToEsc: true };
        },
    },
    {
        name: "outputs",
        summary: "Current motor output values (and --watch)",
        fc: true,
        options: [{ flags: "--watch", description: "stream" }, { flags: "--interval <ms>", description: "interval", default: 200, parse: intArg }],
        examples: ["bf motors outputs"],
        run: async (ctx) => {
            const live = new LiveService(ctx.fc);
            if (!ctx.opts.watch) return live.read("motors");
            await live.watch("motors", { intervalMs: ctx.opts.interval, stop: () => ctx.interrupted }, (s) => ctx.emit(s));
            return undefined;
        },
    },
    {
        name: "esc-telemetry",
        summary: "RPM, temperature, voltage, current per motor (bidirectional DShot / ESC sensor)",
        fc: true,
        examples: ["bf motors esc-telemetry --json"],
        run: async (ctx) => new LiveService(ctx.fc).read("esc"),
    },
    {
        name: "mixers",
        summary: "List mixer types",
        fc: true,
        examples: ["bf motors mixers"],
        run: async (ctx) => (await ctx.fc.cli.exec("mixer list")).output.replace(/^Available:\s*/, "").trim().split(/\s+/),
    },
];

// ---------------- serial ports ----------------

const serialExtras: (CommandDef | GroupDef)[] = [
    {
        name: "list",
        summary: "UART assignments: which function (RX, MSP, GPS, VTX, ...) runs on which port",
        fc: true,
        examples: ["bf serial list", "bf serial list --json"],
        run: async (ctx) => new ListsService(ctx.fc).serialPorts(),
    },
    {
        name: "port <port>",
        summary: "Assign functions and baud rates to a UART (firmware with `serial` lines)",
        description: "Replaces the function list of <port> (UART1, UART2, ..., VCP). Functions: RX_SERIAL (alias RX), MSP, GPS, TELEMETRY_SMARTPORT, VTX_SMARTAUDIO, VTX_TRAMP, VTX_MSP, ESC_SENSOR, BLACKBOX, ... or NONE. Changes need a reboot.",
        fc: true,
        mutates: true,
        options: [
            { flags: "--functions <list>", description: "comma-separated functions, e.g. RX or MSP,VTX_MSP or NONE", parse: (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean) },
            { flags: "--msp-baud <n>", description: "MSP baud", parse: intArg },
            { flags: "--gps-baud <n>", description: "GPS baud", parse: intArg },
            { flags: "--telemetry-baud <n>", description: "telemetry baud", parse: intArg },
            { flags: "--blackbox-baud <n>", description: "blackbox baud", parse: intArg },
            dryRunOpt,
            noSaveOpt,
        ],
        examples: ["bf serial port UART2 --functions RX", "bf serial port UART1 --functions MSP,VTX_MSP --dry-run", "bf serial port UART3 --functions NONE"],
        exitCodes: [4],
        run: async (ctx) =>
            new ListsService(ctx.fc).setSerialPort(ctx.args[0], {
                functions: ctx.opts.functions,
                mspBaud: ctx.opts.mspBaud,
                gpsBaud: ctx.opts.gpsBaud,
                telemetryBaud: ctx.opts.telemetryBaud,
                blackboxBaud: ctx.opts.blackboxBaud,
                ...wr(ctx.opts),
            }),
    },
];

// ---------------- vtx / led / servos ----------------

const vtxExtras: (CommandDef | GroupDef)[] = [
    {
        name: "table",
        summary: "VTX frequency/power table",
        commands: [
            { name: "get", summary: "Show the VTX table", fc: true, examples: ["bf vtx table get"], run: async (ctx) => new ListsService(ctx.fc).vtxTable() },
            {
                name: "import <file>",
                summary: "Load a VTX table (Configurator .json format or CLI vtxtable lines)",
                fc: true,
                mutates: true,
                options: [dryRunOpt, confirmOpt],
                examples: ["bf vtx table import tbs_unify_pro32.json --confirm"],
                exitCodes: [4, 6],
                run: async (ctx) => {
                    const text = fs.readFileSync(ctx.args[0], "utf8");
                    const lines = text.trim().startsWith("{") ? ListsService.vtxTableJsonToLines(JSON.parse(text)) : text.split(/\r?\n/).filter((l) => l.trim().startsWith("vtxtable"));
                    if (!ctx.opts.dryRun) ctx.requireConfirm("replacing the VTX table");
                    return new ListsService(ctx.fc).apply(lines, { dryRun: ctx.opts.dryRun });
                },
            },
        ],
    },
];

const ledExtras: (CommandDef | GroupDef)[] = [
    { name: "list", summary: "LED positions, functions and colors", fc: true, examples: ["bf led list"], run: async (ctx) => new ListsService(ctx.fc).leds() },
    { name: "colors", summary: "LED color palette (HSV)", fc: true, examples: ["bf led colors"], run: async (ctx) => new ListsService(ctx.fc).colors() },
    {
        name: "apply <lines...>",
        summary: "Set LEDs/colors with CLI lines: 'led N X,Y:DIRS:FUNCS:COLOR', 'color N H,S,V', 'mode_color M F C'",
        fc: true,
        mutates: true,
        options: [dryRunOpt, noSaveOpt],
        examples: ["bf led apply 'led 0 0,0:N:FW:0' 'led 1 1,0:N:FW:0'", "bf led apply 'color 1 120,0,255'"],
        run: async (ctx) => {
            const bad = ctx.args.filter((l) => !/^(led|color|mode_color) /.test(l.trim()));
            if (bad.length) throw validationError(`not an LED line: ${bad[0]}`);
            return new ListsService(ctx.fc).apply(ctx.args, wr(ctx.opts));
        },
    },
];

const servosExtras: (CommandDef | GroupDef)[] = [
    { name: "list", summary: "Servo endpoints, rate, forwarding", fc: true, examples: ["bf servos list"], run: async (ctx) => new ListsService(ctx.fc).servos() },
    {
        name: "apply <lines...>",
        summary: "Configure servos/mixes with CLI lines: 'servo ...', 'smix ...'",
        fc: true,
        mutates: true,
        options: [dryRunOpt, noSaveOpt],
        examples: ["bf servos apply 'servo 0 1000 2000 1500 100 -1'"],
        run: async (ctx) => new ListsService(ctx.fc).apply(ctx.args, wr(ctx.opts)),
    },
];

// ---------------- telemetry / calibration ----------------

export const telemetryCmd: CommandDef = {
    name: "telemetry <kind>",
    summary: `Live sensor data: ${TELEMETRY_KINDS.join(", ")}`,
    fc: true,
    options: [
        { flags: "--watch", description: "stream until interrupted (NDJSON with --json)" },
        { flags: "--interval <ms>", description: "watch interval", default: 200, parse: intArg },
        { flags: "--count <n>", description: "number of samples in --watch mode", parse: intArg },
    ],
    examples: ["bf telemetry attitude", "bf telemetry battery --json", "bf telemetry imu --watch --count 50 --json > imu.ndjson"],
    run: async (ctx) => {
        const kind = ctx.args[0] as TelemetryKind;
        if (!TELEMETRY_KINDS.includes(kind)) throw validationError(`unknown telemetry kind '${kind}'`, `one of: ${TELEMETRY_KINDS.join(", ")}`);
        const live = new LiveService(ctx.fc);
        if (!ctx.opts.watch) return live.read(kind);
        await live.watch(kind, { intervalMs: ctx.opts.interval, count: ctx.opts.count, stop: () => ctx.interrupted }, (s) => ctx.emit(s));
        return undefined;
    },
};

export const calibrateCmd: GroupDef = {
    name: "calibrate",
    summary: "Sensor calibration (Configurator: Setup)",
    commands: [
        {
            name: "acc",
            summary: "Calibrate the accelerometer (craft level and still)",
            fc: true,
            mutates: true,
            examples: ["bf calibrate acc"],
            exitCodes: [4],
            run: async (ctx) => {
                ctx.progress("calibrating accelerometer: keep the craft level and still...");
                return new LiveService(ctx.fc).calibrateAcc();
            },
        },
        {
            name: "mag",
            summary: "Calibrate the magnetometer (rotate the craft in all directions)",
            fc: true,
            mutates: true,
            options: [{ flags: "--duration <s>", description: "seconds to wait while rotating", default: 30, parse: intArg }],
            examples: ["bf calibrate mag"],
            exitCodes: [4],
            run: async (ctx) => new LiveService(ctx.fc).calibrateMag(ctx.progress, ctx.opts.duration),
        },
    ],
};

export const gpsExtras: (CommandDef | GroupDef)[] = [
    {
        name: "status",
        summary: "GPS fix, satellites, position, distance to home",
        fc: true,
        options: [{ flags: "--satellites", description: "include per-satellite signal info" }],
        examples: ["bf gps status", "bf gps status --satellites --json"],
        run: async (ctx) => {
            const live = new LiveService(ctx.fc);
            const gps = (await live.read("gps")) as Record<string, unknown>;
            return ctx.opts.satellites ? { ...gps, satellites: await live.gpsSatellites() } : gps;
        },
    },
];

export function areaCommands(): (CommandDef | GroupDef)[] {
    return [
        area("pid"),
        area("pid-advanced"),
        area("tuning"),
        area("filters"),
        area("rates"),
        profileCommands("pid"),
        profileCommands("rate"),
        profileCommands("battery"),
        area("receiver", receiverExtras),
        modesCmd,
        adjustmentsCmd,
        area("failsafe"),
        area("gps-rescue"),
        area("gps", gpsExtras),
        area("autopilot"),
        area("power"),
        area("motors", motorsExtras),
        area("arming"),
        area("system"),
        area("sensors"),
        area("osd", osdCommands()),
        area("vtx", vtxExtras),
        area("led", ledExtras),
        area("blackbox", blackboxCommands()),
        area("beeper", toggleList("beeper").commands, "Beeper hardware settings and beeper conditions (Configurator: Configuration)"),
        area("telemetry-config", [], "Telemetry protocols and sensors (Configurator: Configuration / Receiver)"),
        area("serial", serialExtras, "UART function and baud assignment (Configurator: Ports)"),
        area("servos", servosExtras),
        toggleList("feature"),
        toggleList("beacon"),
        telemetryCmd,
        calibrateCmd,
    ];
}

export const areasTable = () => table(GROUPS.map((g) => ({ area: g.name, tab: g.tab, title: g.title })));
