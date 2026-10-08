import fs from "node:fs";
import readline from "node:readline";
import type { GroupDef } from "../framework.js";
import { dryRunOpt, noSaveOpt, parseAssignments, confirmOpt } from "../framework.js";
import { SettingsService } from "../../core/services/settings.js";
import { ConfigService, DIFF_SCOPES, parseDesired, type DiffScope } from "../../core/services/config.js";
import { BfError, ExitCode, validationError } from "../../core/errors.js";

export const settingCmd: GroupDef = {
    name: "setting",
    summary: "Read/write any named firmware setting (the CLI `get`/`set` variables)",
    description:
        "Low-level access to all ~600-800 firmware settings by name. Writes are validated against the setting's type, range " +
        "and allowed values, skip values that are already set, are verified by read-back and saved to EEPROM. " +
        "Profile-scoped settings act on the active profile; use the area commands (bf pid, bf rates, ...) with --profile to target another.",
    commands: [
        {
            name: "get <names...>",
            summary: "Get one or more settings by exact name",
            fc: true,
            examples: ["bf setting get p_roll i_roll d_roll", "bf setting get motor_pwm_protocol --json"],
            run: async (ctx) => new SettingsService(ctx.fc).getMany(ctx.args),
        },
        {
            name: "list",
            summary: "List settings and values, optionally filtered by substring",
            fc: true,
            options: [{ flags: "--filter <text>", description: "substring of the setting name", default: "" }],
            examples: ["bf setting list --filter gyro_lpf", "bf setting list --json > all-settings.json"],
            run: async (ctx) => new SettingsService(ctx.fc).list(ctx.opts.filter),
        },
        {
            name: "info <name>",
            summary: "Type, range or allowed values, default, and scope of a setting",
            fc: true,
            examples: ["bf setting info serialrx_provider", "bf setting info p_roll --json"],
            run: async (ctx) => {
                const svc = new SettingsService(ctx.fc);
                const info = await svc.info(ctx.args[0]);
                const cur = await svc.get(ctx.args[0]);
                return { ...info, value: cur.value };
            },
        },
        {
            name: "set <assignments...>",
            summary: "Set settings: name=value ... (validated, idempotent, saved)",
            fc: true,
            mutates: true,
            options: [dryRunOpt, noSaveOpt],
            examples: [
                "bf setting set motor_pwm_protocol=DSHOT600 dshot_bidir=ON",
                "bf setting set craft_name=Chimera --dry-run",
                "bf setting set p_roll=48 i_roll=85 --no-save",
            ],
            exitCodes: [4, 7],
            run: async (ctx) => new SettingsService(ctx.fc).set(parseAssignments(ctx.args), { dryRun: ctx.opts.dryRun, save: ctx.opts.save }),
        },
        {
            name: "reset <names...>",
            summary: "Reset settings to their firmware default",
            fc: true,
            mutates: true,
            options: [dryRunOpt, noSaveOpt],
            examples: ["bf setting reset gyro_lpf1_static_hz dterm_lpf1_static_hz"],
            exitCodes: [4, 7],
            run: async (ctx) => new SettingsService(ctx.fc).reset(ctx.args, { dryRun: ctx.opts.dryRun, save: ctx.opts.save }),
        },
    ],
};

export const cliCmd: GroupDef = {
    name: "cli",
    summary: "Run raw firmware CLI commands (escape hatch)",
    commands: [
        {
            name: "exec [lines...]",
            summary: "Run firmware CLI command lines and print their output",
            description:
                "Runs each line in the firmware CLI without entering CLI mode (no reboot, no arming lock). `save` lines are " +
                "rejected: use `bf save`. Prefer the typed commands; use this for things they do not cover " +
                "(resource, timer, dma, mmix, smix, ...). With -f, lines are read from a file ('-' for stdin).",
            fc: true,
            mutates: true,
            options: [
                { flags: "-f, --file <path>", description: "read command lines from a file ('-' = stdin)" },
                { flags: "--save", description: "write EEPROM after running the lines" },
            ],
            examples: ['bf cli exec "resource" "timer"', "bf cli exec -f extra-commands.txt --save", 'bf cli exec "dshot_telemetry_info" --json'],
            exitCodes: [4, 8],
            run: async (ctx) => {
                let lines = ctx.args;
                if (ctx.opts.file) lines = fs.readFileSync(ctx.opts.file === "-" ? 0 : ctx.opts.file, "utf8").split(/\r?\n/);
                lines = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
                if (!lines.length) throw validationError("no command lines given");
                const results = [];
                for (const l of lines) results.push(await ctx.fc.cli.exec(l));
                const failed = results.filter((r) => r.errors.length);
                if (ctx.opts.save && !failed.length) await ctx.fc.save();
                if (failed.length) {
                    throw new BfError("PARTIAL_FAILURE", `${failed.length} of ${results.length} lines failed`, ExitCode.PARTIAL_FAILURE, undefined, {
                        results,
                    });
                }
                return results;
            },
            human: (results: { line: string; output: string }[]) => results.map((r) => (results.length > 1 ? `# ${r.line}\n` : "") + r.output.trimEnd()).join("\n"),
        },
        {
            name: "shell",
            summary: "Interactive firmware CLI (for humans; reboots the FC on exit like Configurator's CLI tab)",
            description: "Opens the interactive firmware CLI. Type `exit` to leave (reboots) or `exit noreboot`. Not for agents: use `bf cli exec`.",
            fc: true,
            mutates: true,
            examples: ["bf cli shell"],
            run: async (ctx) => {
                const c = ctx.fc.client;
                c.setRawListener((d) => process.stdout.write(Buffer.from(d)));
                await c.writeRaw("#");
                const rl = readline.createInterface({ input: process.stdin, terminal: false });
                for await (const line of rl) {
                    await c.writeRaw(line + "\n");
                    if (/^exit\b/.test(line.trim())) break;
                }
                await new Promise((r) => setTimeout(r, 500));
                return undefined;
            },
        },
    ],
};

const scopeOpt = { flags: "--scope <scope>", description: "section", default: "all", choices: [...DIFF_SCOPES] };

export const configCmd: GroupDef = {
    name: "config",
    summary: "Whole-configuration diff, backup, restore and declarative apply",
    commands: [
        {
            name: "diff",
            summary: "Settings that differ from defaults (CLI `diff`)",
            fc: true,
            options: [scopeOpt, { flags: "--with-defaults", description: "include the defaults line" }],
            examples: ["bf config diff", "bf config diff --scope profile", "bf config diff --json | jq -r .data.text"],
            run: async (ctx) => ({ text: await new ConfigService(ctx.fc).diff(ctx.opts.scope as DiffScope, { defaults: ctx.opts.withDefaults }) }),
            human: (d) => d.text,
        },
        {
            name: "dump",
            summary: "Every setting and command line (CLI `dump`)",
            fc: true,
            options: [scopeOpt],
            examples: ["bf config dump > dump.txt"],
            run: async (ctx) => ({ text: await new ConfigService(ctx.fc).dump(ctx.opts.scope as DiffScope) }),
            human: (d) => d.text,
        },
        {
            name: "snapshot",
            summary: "All settings of every profile as structured JSON (from one dump)",
            fc: true,
            examples: ["bf config snapshot --json | jq '.data.pidProfiles[0].p_roll'"],
            run: async (ctx) => new ConfigService(ctx.fc).snapshot(),
        },
        {
            name: "backup",
            summary: "Save `diff all` to a file (the standard Betaflight backup format)",
            fc: true,
            options: [
                { flags: "-o, --output <file>", description: "output file (default: <craft>_<board>_<date>.txt)" },
                { flags: "--dump", description: "back up the full dump instead of the diff" },
            ],
            examples: ["bf config backup", "bf config backup -o my-quad.txt"],
            run: async (ctx) => {
                const svc = new ConfigService(ctx.fc);
                const text = ctx.opts.dump ? await svc.dump("all") : await svc.diff("all");
                const id = ctx.fc.identity;
                const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
                const file = ctx.opts.output ?? `BTFL_backup_${id.board}_${stamp}.txt`;
                fs.writeFileSync(file, text);
                return { file, bytes: text.length, firmware: id.version, board: id.board };
            },
        },
        {
            name: "restore <file>",
            summary: "Restore a backup: reset to defaults, replay the file, save, reboot (destructive)",
            description:
                "Full restore like Configurator's CLI/Backups restore: `defaults nosave`, every line of the file, EEPROM write, reboot. " +
                "Use --dry-run to check the file first. To change only some settings without a reset, use `bf config apply`.",
            fc: true,
            mutates: true,
            options: [dryRunOpt, confirmOpt],
            examples: ["bf config restore my-quad.txt --dry-run", "bf config restore my-quad.txt --confirm"],
            exitCodes: [4, 6, 8],
            run: async (ctx) => {
                const text = fs.readFileSync(ctx.args[0], "utf8");
                if (!ctx.opts.dryRun) ctx.requireConfirm("restoring a backup (resets the configuration first)");
                return new ConfigService(ctx.fc).restore(text, { dryRun: ctx.opts.dryRun, onLine: (r) => ctx.log(`> ${r.line}`) });
            },
            human: (d: any) =>
                d.dryRun
                    ? [`would restore ${d.lines} lines (defaults, replay, save, reboot)`, ...d.warnings.map((w: string) => `warning: ${w}`), "first lines:", ...d.commands.slice(0, 8).map((c: string) => `  ${c}`), d.lines > 8 ? `  ... (--json for all)` : ""].filter(Boolean).join("\n")
                    : [`restored ${d.lines} lines, FC rebooting`, ...d.warnings.map((w: string) => `warning: ${w}`)].join("\n"),
        },
        {
            name: "apply <file>",
            summary: "Make the FC match a desired state (CLI text, JSON or YAML), changing only what differs",
            description:
                "Idempotent configuration: lines/values already in effect are skipped, everything else is applied and saved. " +
                "Re-running the same file reports no changes. Accepts CLI text (e.g. part of a diff), or JSON/YAML:\n" +
                "  settings: {motor_pwm_protocol: DSHOT600}\n  pid_profiles: {1: {p_roll: 48}}\n  rate_profiles: {1: {roll_srate: 70}}\n" +
                "  features: {GPS: true}\n  cli: ['aux 0 0 0 1700 2100 0 0']\n" +
                "Use '-' to read from stdin.",
            fc: true,
            mutates: true,
            options: [dryRunOpt, noSaveOpt],
            examples: ["bf config apply quad.yaml --dry-run", "bf config apply quad.yaml", "echo 'set dshot_bidir = ON' | bf config apply -"],
            exitCodes: [4, 7, 8],
            run: async (ctx) => {
                const file = ctx.args[0];
                const text = fs.readFileSync(file === "-" ? 0 : file, "utf8");
                return new ConfigService(ctx.fc).apply(parseDesired(text, file), { dryRun: ctx.opts.dryRun, save: ctx.opts.save });
            },
        },
    ],
};
