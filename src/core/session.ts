// A connection to one flight controller: transport + MSP client + identity handshake.
// Mirrors betaflight-configurator serial_backend.ts onOpen() (API_VERSION → FC_VARIANT →
// FC_VERSION → BUILD_INFO → BOARD_INFO → UID), minus the UI state.

import { createTransport, resolvePort } from "./transport/transport.js";
import { MspClient, type Logger } from "./msp/client.js";
import { MSP, TextType } from "./msp/codes.js";
import * as M from "./msp/messages.js";
import { CliRunner } from "./clitext/channel.js";
import { BfError, ExitCode, armedError, connectionError } from "./errors.js";

export interface ConnectOptions {
    port?: string;
    baudRate?: number;
    timeoutMs?: number;
    log?: Logger;
}

export interface FcIdentity {
    port: string;
    variant: string;
    version: string;
    api: string;
    apiMajor: number;
    apiMinor: number;
    board: string;
    target: string;
    manufacturer: string;
    boardInfo: ReturnType<typeof M.decodeBoardInfo>;
    build: ReturnType<typeof M.decodeBuildInfo> & { key?: string; release?: string };
    uid: string;
    mcu?: string;
}

export class Session {
    readonly cli: CliRunner;
    private boxNamesCache?: string[];

    private constructor(
        readonly client: MspClient,
        readonly identity: FcIdentity,
        readonly log: Logger,
    ) {
        this.cli = new CliRunner(client, log);
    }

    static async connect(opts: ConnectOptions = {}): Promise<Session> {
        const log = opts.log ?? (() => {});
        const port = await resolvePort(opts.port);
        const transport = createTransport(port, opts.baudRate);
        await transport.open();
        const client = new MspClient(transport, log);
        if (opts.timeoutMs) client.defaultTimeoutMs = opts.timeoutMs;
        try {
            const identity = await Session.handshake(client, port, log);
            return new Session(client, identity, log);
        } catch (e) {
            await client.close().catch(() => {});
            if (e instanceof BfError && e.code === "TIMEOUT") {
                throw connectionError(
                    `${port} did not answer MSP`,
                    "the port is not a Betaflight MSP port, the FC is in bootloader/DFU mode, or MSP is disabled on that UART",
                );
            }
            throw e;
        }
    }

    private static async handshake(client: MspClient, port: string, log: Logger): Promise<FcIdentity> {
        const api = M.decodeApiVersion(await client.request(MSP.MSP_API_VERSION, [], { retries: 3 }));
        const variant = M.decodeFcVariant(await client.request(MSP.MSP_FC_VARIANT));
        if (variant !== "BTFL") {
            throw new BfError("NOT_BETAFLIGHT", `flight controller runs ${variant}, not Betaflight`, ExitCode.UNSUPPORTED);
        }
        const version = M.decodeFcVersion(await client.request(MSP.MSP_FC_VERSION));
        const build = M.decodeBuildInfo(await client.request(MSP.MSP_BUILD_INFO));
        const boardInfo = M.decodeBoardInfo(await client.request(MSP.MSP_BOARD_INFO));
        const uid = M.decodeUid(await client.request(MSP.MSP_UID));
        const optionalText = async (t: number) => {
            try {
                return M.decodeText(await client.request(MSP.MSP2_GET_TEXT, M.encodeGetText(t), { retries: 0, allowError: false }));
            } catch {
                return undefined;
            }
        };
        const key = await optionalText(TextType.BUILDKEY);
        const release = await optionalText(TextType.RELEASENAME);
        let mcu: string | undefined;
        try {
            mcu = M.decodeMcuInfo(await client.request(MSP.MSP2_MCU_INFO, [], { retries: 0 })).name;
        } catch {
            /* older firmware */
        }
        log(`connected: Betaflight ${version.version} (API ${api.api}) on ${boardInfo.boardName || boardInfo.targetName}`);
        return {
            port,
            variant,
            version: version.version,
            api: api.api,
            apiMajor: api.major,
            apiMinor: api.minor,
            board: boardInfo.boardName || boardInfo.targetName || boardInfo.boardIdentifier,
            target: boardInfo.targetName,
            manufacturer: boardInfo.manufacturerId,
            boardInfo,
            build: { ...build, key: key || undefined, release: release || undefined },
            uid,
            mcu,
        };
    }

    /** api >= major.minor */
    apiAtLeast(major: number, minor: number): boolean {
        const { apiMajor: a, apiMinor: b } = this.identity;
        return a > major || (a === major && b >= minor);
    }

    request(code: number, payload: ArrayLike<number> = [], opts?: Parameters<MspClient["request"]>[2]) {
        return this.client.request(code, payload, opts);
    }

    async boxNames(): Promise<string[]> {
        if (!this.boxNamesCache) {
            const names: string[] = [];
            for (let page = 0; page < 8; page++) {
                const p = M.decodeBoxNames(await this.request(MSP.MSP_BOXNAMES, page === 0 ? [] : [page]));
                names.push(...p);
                if (p.length < 32) break;
            }
            this.boxNamesCache = names;
        }
        return this.boxNamesCache;
    }

    async boxIds(): Promise<number[]> {
        const ids: number[] = [];
        for (let page = 0; page < 8; page++) {
            const p = M.decodeBoxIds(await this.request(MSP.MSP_BOXIDS, page === 0 ? [] : [page]));
            ids.push(...p);
            if (p.length < 32) break;
        }
        return ids;
    }

    async status(): Promise<M.Status> {
        const names = await this.boxNames();
        return M.decodeStatusEx(await this.request(MSP.MSP_STATUS_EX), names);
    }

    /** Throws FC_ARMED when armed. Call before any configuration write. */
    async assertDisarmed(): Promise<M.Status> {
        const s = await this.status();
        if (s.armed) throw armedError();
        return s;
    }

    /** Persist RAM config to EEPROM without rebooting. Returns whether a reboot is needed for changes to apply. */
    async save(): Promise<{ saved: true; rebootRequired: boolean }> {
        await this.assertDisarmed();
        await this.request(MSP.MSP_EEPROM_WRITE, [], { timeoutMs: 5000, retries: 1 });
        const s = await this.status();
        return { saved: true, rebootRequired: s.rebootRequired };
    }

    /**
     * Reboot. The FC answers, then resets; the USB port disappears, so the session is
     * closed afterwards. For `firmware` mode with `waitForReconnect`, waits until MSP
     * answers again on the same port.
     */
    async reboot(mode: M.RebootMode = "firmware"): Promise<void> {
        await this.assertDisarmed();
        try {
            await this.request(MSP.MSP_REBOOT, [M.REBOOT_MODES[mode]], { timeoutMs: 1500, retries: 0 });
        } catch (e) {
            if (!(e instanceof BfError && (e.code === "TIMEOUT" || e.code === "DISCONNECTED"))) throw e;
        }
        await this.close();
    }

    async close(): Promise<void> {
        await this.client.close().catch(() => {});
    }
}

/** Poll until the FC answers MSP again after a reboot. */
export async function waitForFc(opts: ConnectOptions, timeoutMs = 15000): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 1500));
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            return await Session.connect({ ...opts, log: () => {} });
        } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw last instanceof BfError ? last : connectionError("flight controller did not come back after reboot");
}
