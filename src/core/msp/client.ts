import type { Transport } from "../transport/transport.js";
import { MspDecoder, encodeRequest, type MspFrame } from "./frame.js";
import { mspName } from "./codes.js";
import { BfError, ExitCode, timeoutError } from "../errors.js";

export interface RequestOptions {
    timeoutMs?: number;
    retries?: number;
    /** resolve with the error frame instead of throwing when the FC answers '!' */
    allowError?: boolean;
}

export type Logger = (msg: string) => void;

/**
 * Request/response MSP client. Requests are strictly serialized: the firmware only sends a
 * large reply when its TX buffer is empty (msp_serial.c mspSerialSendFrame), and pairing
 * replies by code is only unambiguous with one request in flight.
 *
 * `raw` mode hands every received byte to the raw listener instead of the MSP decoder;
 * the text-mode CLI channel uses it while the FC is in CLI mode.
 */
export class MspClient {
    private decoder: MspDecoder;
    private pending?: { code: number; resolve: (f: MspFrame) => void };
    private queue: Promise<unknown> = Promise.resolve();
    private rawListener?: (data: Uint8Array) => void;
    private closed = false;
    defaultTimeoutMs = 1500;
    /** delay before nudging a silent FC with a NUL byte (see requestFrameUnlocked) */
    nudgeAfterMs = 15;

    constructor(
        readonly transport: Transport,
        private readonly log: Logger = () => {},
    ) {
        this.decoder = new MspDecoder(
            (f) => this.onFrame(f),
            undefined,
            (code) => this.log(`bad checksum on ${mspName(code)} reply`),
        );
        transport.onData((d) => {
            if (this.rawListener) this.rawListener(d);
            else this.decoder.push(d);
        });
        transport.onClose(() => {
            this.closed = true;
        });
    }

    get isClosed() {
        return this.closed;
    }

    setRawListener(cb?: (data: Uint8Array) => void) {
        this.rawListener = cb;
        this.decoder.reset();
    }

    private onFrame(f: MspFrame) {
        const p = this.pending;
        if (p && p.code === f.code) {
            this.pending = undefined;
            p.resolve(f);
        } else {
            this.log(`unsolicited ${mspName(f.code)} reply ignored`);
        }
    }

    /** Run `fn` with exclusive use of the link (no interleaved MSP requests). */
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    request(code: number, payload: ArrayLike<number> = [], opts: RequestOptions = {}): Promise<Uint8Array> {
        return this.exclusive(() => this.requestUnlocked(code, payload, opts));
    }

    /** Must only be called from inside `exclusive`. */
    async requestUnlocked(code: number, payload: ArrayLike<number> = [], opts: RequestOptions = {}): Promise<Uint8Array> {
        const frame = await this.requestFrameUnlocked(code, payload, opts);
        if (frame.error && !opts.allowError) {
            throw new BfError(
                "MSP_ERROR",
                `flight controller rejected ${mspName(code)}`,
                ExitCode.REFUSED,
                "the command may be unsupported by this firmware, refused while armed, or given invalid data",
            );
        }
        return frame.payload;
    }

    async requestFrameUnlocked(code: number, payload: ArrayLike<number> = [], opts: RequestOptions = {}): Promise<MspFrame> {
        const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
        const retries = opts.retries ?? 2;
        const frameBytes = encodeRequest(code, payload);
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (this.closed) throw new BfError("DISCONNECTED", "connection to the flight controller was lost", ExitCode.CONNECTION);
            const result = await new Promise<MspFrame | undefined>((resolve) => {
                // Some firmware builds (seen on a 2026.6.0-alpha G473 board over USB VCP) only
                // finish a received frame when a later byte arrives. If no reply comes quickly,
                // nudge with a lone NUL: the idle parser ignores it (it only reacts to '$', '#',
                // STX and the reboot character), so this is harmless on firmware without the issue.
                let nudge: NodeJS.Timeout | undefined;
                const scheduleNudge = (ms: number) => {
                    nudge = setTimeout(() => {
                        this.transport.poke();
                        scheduleNudge(50);
                    }, ms);
                };
                const done = (f: MspFrame | undefined) => {
                    clearTimeout(timer);
                    clearTimeout(nudge);
                    resolve(f);
                };
                const timer = setTimeout(() => {
                    this.pending = undefined;
                    done(undefined);
                }, timeoutMs);
                this.pending = { code, resolve: (f) => done(f) };
                this.transport
                    .write(frameBytes)
                    .then(() => scheduleNudge(this.nudgeAfterMs))
                    .catch(() => {
                        this.pending = undefined;
                        done(undefined);
                    });
            });
            if (result) return result;
            this.log(`${mspName(code)} timed out (attempt ${attempt + 1}/${retries + 1})`);
        }
        throw timeoutError(`no reply to ${mspName(code)} after ${retries + 1} attempts`);
    }

    /** Fire-and-forget (used for reboot, where the FC may drop the link before replying). */
    async send(code: number, payload: ArrayLike<number> = []): Promise<void> {
        await this.exclusive(() => this.transport.write(encodeRequest(code, payload)));
    }

    poke(): void {
        this.transport.poke();
    }

    async writeRaw(data: Uint8Array | string): Promise<void> {
        await this.transport.write(typeof data === "string" ? Buffer.from(data, "latin1") : data);
    }

    async close(): Promise<void> {
        await this.transport.close();
    }
}
