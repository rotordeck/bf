#!/usr/bin/env node
// bf: agent-oriented command line interface for Betaflight flight controllers.

import { Command, Option } from "commander";
import { register, describe, toBfError, type CommandDef } from "./framework.js";
import { EXIT_CODE_DOCS, ExitCode } from "../core/errors.js";
import { portsCmd, infoCmd, statusCmd, saveCmd, rebootCmd, defaultsCmd, nameCmd, versionCmd } from "./commands/device.js";
import { settingCmd, cliCmd, configCmd } from "./commands/settings.js";
import { areaCommands, areasTable } from "./commands/areas.js";
import { extraCommands } from "./commands/extra.js";

const program = new Command("bf");

program
    .description(
        "Configure Betaflight flight controllers from the terminal: everything the Betaflight Configurator does, " +
            "with stable JSON output for scripts and AI agents.",
    )
    .addOption(new Option("-p, --port <port>", "serial port (/dev/ttyACM0, COM3) or tcp://host:port for SITL; default: $BF_PORT or auto-detect"))
    .addOption(new Option("--baud <rate>", "baud rate for UART connections").default(115200).argParser(Number))
    .addOption(new Option("--timeout <ms>", "MSP reply timeout").argParser(Number))
    .option("--json", "machine-readable output: {ok, data, meta} on stdout, {ok:false, error} on stderr")
    .option("-q, --quiet", "no progress messages on stderr")
    .option("-v, --verbose", "diagnostic logging on stderr")
    .showHelpAfterError("(run with --help for usage)")
    .configureHelp({ sortSubcommands: false, showGlobalOptions: true })
    .addHelpText(
        "after",
        `
Output contract:
  stdout   data only (human text, or one JSON document with --json; NDJSON for --watch)
  stderr   errors, warnings, progress
  --json   success: {"ok":true,"data":...,"meta":{"port","fc":{...}}}
           failure: {"ok":false,"error":{"code","message","hint","details"}} on stderr

Writes are idempotent: values already set are skipped and reported as unchanged.
Every write validates first, verifies by read-back and saves to EEPROM (opt out: --no-save).
Use --dry-run to preview. Destructive actions need --confirm.

Exit codes:
${Object.entries(EXIT_CODE_DOCS)
    .map(([c, d]) => `  ${c}  ${d}`)
    .join("\n")}

Configuration areas (Configurator tab -> command):
${areasTable()
    .split("\n")
    .map((l) => "  " + l)
    .join("\n")}

Start here:
  $ bf ports                       # find the flight controller
  $ bf info && bf status           # identify it, see why it won't arm
  $ bf config backup               # always back up before changing things
  $ bf schema --json               # every command, option and example, machine-readable
`,
    );

// Must be set before subcommands are created: they inherit it.
program.exitOverride();

const top: (CommandDef | Parameters<typeof register>[1])[] = [
    portsCmd,
    infoCmd,
    statusCmd,
    configCmd,
    settingCmd,
    ...areaCommands(),
    ...extraCommands(),
    nameCmd,
    saveCmd,
    rebootCmd,
    defaultsCmd,
    cliCmd,
    versionCmd,
];
for (const c of top) register(program, c);

register(program, {
    name: "schema",
    summary: "Describe every command, argument, option and example (for agents)",
    examples: ["bf schema --json", "bf schema --json | jq '.data[] | select(.mutates) | .command'"],
    run: async () => describe(program),
    human: (cmds: any[]) => cmds.map((c) => `${c.command.padEnd(40)} ${c.summary}`).join("\n"),
});

try {
    await program.parseAsync(process.argv);
} catch (e: any) {
    if (e?.code === "commander.helpDisplayed" || e?.code === "commander.help" || e?.code === "commander.version") {
        // `--help` exits 0; help shown because a group was called without a subcommand is a usage error
        process.exitCode = e.exitCode === 0 ? 0 : ExitCode.VALIDATION;
    } else if (e?.code?.startsWith?.("commander.")) {
        // commander already printed the message to stderr
        if (process.argv.includes("--json")) process.stderr.write(JSON.stringify({ ok: false, error: { code: "USAGE", message: e.message } }) + "\n");
        process.exitCode = ExitCode.VALIDATION;
    } else {
        const err = toBfError(e);
        process.stderr.write(`error: ${err.message}\n`);
        process.exitCode = err.exitCode;
    }
}
