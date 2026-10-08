// CLI plumbing: command definitions, connection handling, output envelope, exit codes.
// Contains no Betaflight logic; handlers call into src/core.

import { Command, Option } from "commander";
import { Session } from "../core/session.js";
import { BfError, ExitCode, EXIT_CODE_DOCS, confirmRequired } from "../core/errors.js";
import { formatHuman } from "./format.js";

export interface GlobalOpts {
    port?: string;
    baud: number;
    timeout?: number;
    json?: boolean;
    quiet?: boolean;
    verbose?: boolean;
}

export interface Ctx {
    args: string[];
    opts: Record<string, any>;
    global: GlobalOpts;
    /** connected session (only when the command declares `fc: true`) */
    fc: Session;
    log: (msg: string) => void;
    /** progress/diagnostics to stderr (suppressed by --quiet / --json) */
    progress: (msg: string) => void;
    /** emit one streaming record (NDJSON under --json) */
    emit: (record: unknown) => void;
    /** throw CONFIRM_REQUIRED unless the named flag was given */
    requireConfirm: (action: string, flag?: string) => void;
    connect: () => Promise<Session>;
    /** true once SIGINT/SIGTERM was received: streaming loops must stop and clean up */
    readonly interrupted: boolean;
}

export interface OptionDef {
    flags: string;
    description: string;
    default?: unknown;
    choices?: string[];
    /** argParser, e.g. Number */
    parse?: (v: string, prev: any) => any;
}

export interface CommandDef {
    /** e.g. "set <assignments...>" */
    name: string;
    summary: string;
    description?: string;
    options?: OptionDef[];
    examples: string[];
    /** connect to the FC before running the handler */
    fc?: boolean;
    /** whether the command changes FC state (documented in schema; adds --dry-run where relevant) */
    mutates?: boolean;
    /** extra exit codes beyond 0/1/2/3 worth documenting */
    exitCodes?: number[];
    /** handler returns the `data` payload; undefined for streaming commands */
    run: (ctx: Ctx) => Promise<unknown>;
    /** custom human rendering */
    human?: (data: any) => string;
}

export interface GroupDef {
    name: string;
    summary: string;
    description?: string;
    commands: (CommandDef | GroupDef)[];
}

const isGroup = (d: CommandDef | GroupDef): d is GroupDef => "commands" in d;

export const intArg = (v: string) => {
    if (!/^-?\d+$/.test(v)) throw new BfError("VALIDATION", `expected an integer, got '${v}'`, ExitCode.VALIDATION);
    return Number(v);
};
export const numArg = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BfError("VALIDATION", `expected a number, got '${v}'`, ExitCode.VALIDATION);
    return n;
};
export const collect = (v: string, prev: string[] = []) => [...prev, v];

function exitCodeHelp(codes: number[] = []) {
    const all = [...new Set([0, 1, 2, 3, ...codes])].sort((a, b) => a - b);
    return all.map((c) => `  ${c}  ${EXIT_CODE_DOCS[c as keyof typeof EXIT_CODE_DOCS]}`).join("\n");
}

export function register(parent: Command, def: CommandDef | GroupDef): Command {
    if (isGroup(def)) {
        const g = parent.command(def.name).summary(def.summary).description(def.description ?? def.summary);
        for (const c of def.commands) register(g, c);
        return g;
    }
    const cmd = parent.command(def.name).summary(def.summary).description(def.description ?? def.summary);
    for (const o of def.options ?? []) {
        const opt = new Option(o.flags, o.description);
        if (o.choices) opt.choices(o.choices);
        if (o.parse) opt.argParser(o.parse);
        if (o.default !== undefined) opt.default(o.default);
        cmd.addOption(opt);
    }
    (cmd as any)._bfDef = def;
    cmd.addHelpText(
        "after",
        `\nExamples:\n${def.examples.map((e) => `  $ ${e}`).join("\n")}\n\nExit codes:\n${exitCodeHelp(def.exitCodes)}\n`,
    );
    cmd.action(async (...actionArgs: any[]) => {
        const command: Command = actionArgs[actionArgs.length - 1];
        const opts = command.opts();
        const global = command.optsWithGlobals() as GlobalOpts;
        const args = actionArgs.slice(0, -2).flatMap((a) => (Array.isArray(a) ? a : a === undefined ? [] : [a]));
        await runCommand(def, args, opts, global);
    });
    return cmd;
}

const stderr = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");

async function runCommand(def: CommandDef, args: string[], opts: Record<string, any>, global: GlobalOpts) {
    const json = !!global.json;
    const quiet = !!global.quiet;
    const log = (m: string) => {
        if (global.verbose) stderr(`[bf] ${m}`);
    };
    let session: Session | undefined;
    let streamed = false;
    const connect = async () => {
        if (!session) {
            session = await Session.connect({
                port: global.port ?? process.env.BF_PORT,
                baudRate: global.baud,
                timeoutMs: global.timeout,
                log,
            });
        }
        return session;
    };
    const onSignal = () => {
        // Let streaming loops and motor tests stop and clean up (they poll ctx.interrupted);
        // a second signal, or 3 s without finishing, exits hard.
        if (interrupted) process.exit(130);
        interrupted = true;
        setTimeout(() => process.exit(130), 3000).unref();
    };
    let interrupted = false;
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
        if (def.fc) await connect();
        const ctx: Ctx = {
            args,
            opts,
            global,
            get fc() {
                if (!session) throw new Error("internal: command did not declare fc: true");
                return session;
            },
            log,
            progress: (m) => {
                if (!quiet) stderr(m);
            },
            emit: (record) => {
                streamed = true;
                if (json) process.stdout.write(JSON.stringify(record) + "\n");
                else process.stdout.write(formatHuman(record) + "\n");
            },
            requireConfirm: (action, flag = "--confirm") => {
                const key = flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                if (!opts[key]) throw confirmRequired(action, flag);
            },
            connect,
            get interrupted() {
                return interrupted;
            },
        };
        const data = await def.run(ctx);
        if (!streamed || data !== undefined) {
            if (json) {
                const meta = session ? { port: session.identity.port, fc: fcMeta(session) } : undefined;
                process.stdout.write(JSON.stringify({ ok: true, data: data ?? null, ...(meta ? { meta } : {}) }) + "\n");
            } else if (data !== undefined) {
                const text = def.human ? def.human(data) : formatHuman(data);
                if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
            }
        }
        process.exitCode = ExitCode.OK;
    } catch (e) {
        const err = toBfError(e);
        if (json) stderr(JSON.stringify({ ok: false, error: err.toJSON() }));
        else {
            stderr(`error: ${err.message}`);
            if (err.hint) stderr(`hint: ${err.hint}`);
            if (err.details && (global.verbose || err.exitCode === ExitCode.PARTIAL_FAILURE || err.exitCode === ExitCode.VERIFY_FAILED)) {
                stderr(`details: ${JSON.stringify(err.details, null, 2)}`);
            }
            if (global.verbose && !(e instanceof BfError) && e instanceof Error && e.stack) stderr(e.stack);
        }
        process.exitCode = err.exitCode;
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await session?.close();
    }
}

function fcMeta(s: Session) {
    const i = s.identity;
    return { variant: i.variant, version: i.version, api: i.api, board: i.board };
}

export function toBfError(e: unknown): BfError {
    if (e instanceof BfError) return e;
    const anyE = e as any;
    if (anyE?.code === "commander.invalidArgument" || anyE?.code === "commander.missingArgument") {
        return new BfError("VALIDATION", String(anyE.message), ExitCode.VALIDATION);
    }
    if (e instanceof RangeError && /payload too short/.test(e.message)) {
        return new BfError("DECODE", `unexpected reply from the flight controller: ${e.message}`, ExitCode.UNSUPPORTED, "the firmware may be too old or too new for this command");
    }
    return new BfError("INTERNAL", e instanceof Error ? e.message : String(e), ExitCode.GENERAL);
}

/** Machine-readable description of the whole command tree (for `bf schema`). */
export function describe(cmd: Command, path: string[] = []): any[] {
    const out: any[] = [];
    for (const c of cmd.commands) {
        const def: CommandDef | undefined = (c as any)._bfDef;
        const p = [...path, c.name()];
        if (def) {
            out.push({
                command: `bf ${p.join(" ")}`,
                summary: def.summary,
                description: def.description ?? def.summary,
                arguments: c.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic, description: a.description })),
                options: c.options.map((o) => ({
                    flags: o.flags,
                    description: o.description,
                    default: o.defaultValue,
                    choices: (o as any).argChoices,
                    takesValue: o.required || o.optional,
                })),
                connectsToFc: !!def.fc,
                mutates: !!def.mutates,
                examples: def.examples,
                exitCodes: [...new Set([0, 1, 2, 3, ...(def.exitCodes ?? [])])],
            });
        }
        out.push(...describe(c, p));
    }
    return out;
}

/** Parse "key=value" assignments (value may contain '='). */
export function parseAssignments(items: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const item of items) {
        const i = item.indexOf("=");
        if (i <= 0) throw new BfError("VALIDATION", `expected key=value, got '${item}'`, ExitCode.VALIDATION, "example: bf setting set p_roll=48 i_roll=80");
        out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
    }
    return out;
}

export const dryRunOpt: OptionDef = { flags: "--dry-run", description: "show what would change without writing anything" };
export const noSaveOpt: OptionDef = { flags: "--no-save", description: "apply to RAM only (lost on reboot unless `bf save` is run)" };
export const confirmOpt: OptionDef = { flags: "--confirm", description: "required: acknowledge this destructive action" };
