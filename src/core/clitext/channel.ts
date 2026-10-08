// Running firmware CLI command lines without leaving MSP mode.
//
// Two transports, both side-effect free (no reboot, no ARMING_DISABLED_CLI latch):
//
//  * Msp2CliCommand – this firmware fork's MSP2_CLI_COMMAND (0x3012): the command runs inside
//    an MSP request, output is paged back in windows. Output is capped at
//    MSP_CLI_COMMAND_BUFFER_SIZE (2048 by default): longer output comes back with the
//    TRUNCATED flag and we re-run the line over STX.
//  * Stx – the non-interactive CLI (firmware msp_serial.c: byte 0x02 enters, 0x03 leaves;
//    cli.c cliProcess). Supported by stock Betaflight >= 4.5.4 (Configurator's
//    MSP.send_cli_command). Output is the bytes between the FC's 0x02 and 0x03.
//
// The interactive '#' CLI is NOT used for automation: entering it latches
// ARMING_DISABLED_CLI until reboot, which would make read-only commands stateful.
//
// `save` is never sent as a CLI line; callers persist with MSP_EEPROM_WRITE, which writes
// without rebooting on every firmware.

import type { MspClient } from "../msp/client.js";
import { MSP, MSP2_CLI_COMMAND_FLAG_REFUSED, MSP2_CLI_COMMAND_FLAG_TRUNCATED } from "../msp/codes.js";
import { PayloadReader } from "../msp/bytes.js";
import { BfError, ExitCode, refusedError, timeoutError } from "../errors.js";

export interface CliLineResult {
    line: string;
    output: string;
    /** "###ERROR ..." / "ERR_CMD_NA" lines found in the output */
    errors: string[];
}

const MSP2_MAX_LINE = 127;

export function findCliErrors(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("###ERROR") || l.startsWith("ERR_CMD_NA") || /^INVALID /.test(l));
}

export class CliRunner {
    private msp2Supported?: boolean;

    constructor(
        private readonly client: MspClient,
        private readonly log: (m: string) => void = () => {},
    ) {}

    /** Whether MSP2_CLI_COMMAND is available (probed once, lazily). */
    async hasMsp2Cli(): Promise<boolean> {
        if (this.msp2Supported === undefined) {
            const frame = await this.client.exclusive(() =>
                this.client.requestFrameUnlocked(MSP.MSP2_CLI_COMMAND, [...Buffer.from("version", "latin1")], { retries: 1 }),
            );
            this.msp2Supported = !frame.error;
            this.log(`MSP2_CLI_COMMAND ${this.msp2Supported ? "available" : "not available, using STX CLI"}`);
        }
        return this.msp2Supported;
    }

    async exec(line: string, opts: { timeoutMs?: number } = {}): Promise<CliLineResult> {
        const trimmed = line.trim();
        if (/^save(\s|$)/i.test(trimmed)) {
            throw new BfError("CLI_SAVE", "`save` is not sent as a CLI line", ExitCode.VALIDATION, "use `bf save` (MSP_EEPROM_WRITE)");
        }
        let output: string | undefined;
        if (trimmed.length <= MSP2_MAX_LINE && (await this.hasMsp2Cli())) {
            output = await this.execMsp2(trimmed);
        }
        if (output === undefined) output = await this.execStx(trimmed, opts.timeoutMs ?? 15000);
        output = output.replace(/\r\n/g, "\n");
        return { line: trimmed, output, errors: findCliErrors(output) };
    }

    /** returns undefined when the output was truncated (caller falls back to STX) */
    private async execMsp2(line: string): Promise<string | undefined> {
        return this.client.exclusive(async () => {
            const chunks: Uint8Array[] = [];
            let offset = 0;
            let total = Infinity;
            while (offset < total) {
                const req = offset === 0 ? [...Buffer.from(line, "latin1")] : [...Buffer.from(line, "latin1"), 0, offset & 0xff, (offset >> 8) & 0xff];
                const payload = await this.client.requestUnlocked(MSP.MSP2_CLI_COMMAND, req, { timeoutMs: 5000, retries: 0 });
                const r = new PayloadReader(payload);
                total = r.u16();
                const flags = r.u8();
                if (flags & MSP2_CLI_COMMAND_FLAG_REFUSED) {
                    throw refusedError(`flight controller refused CLI command \`${line}\``, "bl/msc/serialpassthrough, bare `defaults`, and save/defaults while armed are refused");
                }
                if (flags & MSP2_CLI_COMMAND_FLAG_TRUNCATED) {
                    this.log(`output of \`${line}\` exceeds the MSP CLI buffer, re-running over STX`);
                    return undefined;
                }
                const window = r.rest();
                if (window.length === 0 && offset < total) break;
                chunks.push(window);
                offset += window.length;
            }
            return Buffer.concat(chunks).toString("latin1");
        });
    }

    private async execStx(line: string, timeoutMs: number): Promise<string> {
        return this.client.exclusive(
            () =>
                new Promise<string>((resolve, reject) => {
                    const bytes: number[] = [];
                    let started = false;
                    // Same firmware quirk as in MspClient: some builds stall the VCP output until
                    // the host sends something. NUL is ignored by the CLI line parser.
                    const idleTimer = setInterval(() => this.client.poke(), 50);
                    const finish = (err?: Error) => {
                        clearTimeout(timer);
                        clearInterval(idleTimer);
                        this.client.setRawListener(undefined);
                        if (err) reject(err);
                        else resolve(Buffer.from(bytes).toString("latin1"));
                    };
                    let raw = 0;
                    const timer = setTimeout(() => {
                        this.log(`STX timeout: ${raw} bytes received, started=${started}, collected=${bytes.length}`);
                        finish(timeoutError(`CLI command \`${line}\` did not complete`));
                    }, timeoutMs);
                    this.client.setRawListener((data) => {
                        raw += data.length;
                        for (const b of data) {
                            if (!started) {
                                if (b === 0x02) started = true;
                                continue;
                            }
                            if (b === 0x03) return finish();
                            bytes.push(b);
                        }
                    });
                    // STX, command, LF, ETX in one write: the FC must see ETX within 2 s of STX.
                    const payload = Buffer.concat([Buffer.from([0x02]), Buffer.from(line + "\n", "latin1"), Buffer.from([0x03])]);
                    this.client.writeRaw(payload).catch((e) => finish(e));
                }),
        );
    }

    async batch(lines: string[], opts: { stopOnError?: boolean; onLine?: (r: CliLineResult, i: number) => void } = {}): Promise<CliLineResult[]> {
        const results: CliLineResult[] = [];
        for (const [i, raw] of lines.entries()) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            if (/^(batch\s+(start|end)|save|exit)\b/i.test(line)) continue;
            const r = await this.exec(line);
            results.push(r);
            opts.onLine?.(r, i);
            if (r.errors.length && opts.stopOnError) break;
        }
        return results;
    }
}
