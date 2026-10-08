import { SerialPort } from "serialport";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BfError, ExitCode, connectionError } from "../errors.js";

/** Byte pipe to a flight controller. Implementations: USB/UART serial, TCP (SITL). */
export interface Transport {
    readonly id: string;
    open(): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    /** fire-and-forget single NUL byte (no drain), used to wake firmware that stalls without host traffic */
    poke(): void;
    onData(cb: (data: Uint8Array) => void): void;
    onClose(cb: () => void): void;
    close(): Promise<void>;
}

// USB VID/PID pairs of flight-controller virtual COM ports, from
// betaflight-configurator src/js/protocols/devices.js (defaultSerialDevices).
export const FC_SERIAL_DEVICES: { vendorId: number; productId: number; name: string }[] = [
    { vendorId: 0x0483, productId: 0x5740, name: "STM32 VCP" },
    { vendorId: 0x0483, productId: 0x374e, name: "STLink VCP" },
    { vendorId: 0x0483, productId: 0x3256, name: "STM32 HID" },
    { vendorId: 0x2e3c, productId: 0x5740, name: "AT32 VCP" },
    { vendorId: 0x314b, productId: 0x5740, name: "APM32 VCP" },
    { vendorId: 0x28e9, productId: 0x018a, name: "GD32 VCP" },
    { vendorId: 0x2e8a, productId: 0x0009, name: "RP2350 VCP" },
    { vendorId: 0x3997, productId: 0x5740, name: "X32 VCP" },
    { vendorId: 0x0403, productId: 0x6001, name: "FTDI" },
    { vendorId: 0x10c4, productId: 0xea60, name: "CP210x" },
    { vendorId: 0x1a86, productId: 0x7523, name: "CH340" },
];

export interface HostPort {
    path: string;
    vendorId?: string;
    productId?: string;
    manufacturer?: string;
    serialNumber?: string;
    /** matched FC_SERIAL_DEVICES entry name, if any */
    device?: string;
    likelyFlightController: boolean;
}

export async function listHostPorts(all = false): Promise<HostPort[]> {
    const ports = await SerialPort.list();
    const out = ports.map((p): HostPort => {
        const vid = p.vendorId ? parseInt(p.vendorId, 16) : NaN;
        const pid = p.productId ? parseInt(p.productId, 16) : NaN;
        const dev = FC_SERIAL_DEVICES.find((d) => d.vendorId === vid && d.productId === pid);
        return {
            path: p.path,
            vendorId: p.vendorId,
            productId: p.productId,
            manufacturer: p.manufacturer,
            serialNumber: p.serialNumber,
            device: dev?.name,
            likelyFlightController: !!dev,
        };
    });
    // Without a USB id a port is almost always a legacy on-board UART (ttyS*): hide unless asked.
    return all ? out : out.filter((p) => p.vendorId);
}

/** Resolve --port / BF_PORT / auto-detect into a concrete port spec. */
export async function resolvePort(spec?: string): Promise<string> {
    if (spec) return spec;
    const candidates = (await listHostPorts()).filter((p) => p.likelyFlightController);
    if (candidates.length === 1) return candidates[0].path;
    if (candidates.length === 0) {
        throw new BfError(
            "NO_PORT",
            "no flight controller found on USB",
            ExitCode.CONNECTION,
            "plug in the FC (data-capable USB cable), or pass --port /dev/ttyACM0 or --port tcp://127.0.0.1:5761 for SITL; `bf ports --all` lists every port",
        );
    }
    throw new BfError(
        "AMBIGUOUS_PORT",
        `${candidates.length} possible flight controllers found: ${candidates.map((c) => c.path).join(", ")}`,
        ExitCode.CONNECTION,
        "choose one with --port or BF_PORT",
        { candidates: candidates.map((c) => c.path) },
    );
}

export function createTransport(spec: string, baudRate = 115200): Transport {
    const m = /^tcp:\/\/([^:/]+):(\d+)\/?$/.exec(spec);
    if (m) return new TcpTransport(m[1], Number(m[2]));
    return new SerialTransport(spec, baudRate);
}

abstract class BaseTransport implements Transport {
    protected dataCbs: ((d: Uint8Array) => void)[] = [];
    protected closeCbs: (() => void)[] = [];
    abstract readonly id: string;
    abstract open(): Promise<void>;
    abstract write(data: Uint8Array): Promise<void>;
    abstract poke(): void;
    abstract close(): Promise<void>;
    onData(cb: (d: Uint8Array) => void) {
        this.dataCbs.push(cb);
    }
    onClose(cb: () => void) {
        this.closeCbs.push(cb);
    }
    protected emitData(d: Uint8Array) {
        for (const cb of this.dataCbs) cb(d);
    }
    protected emitClose() {
        for (const cb of this.closeCbs) cb();
    }
}

export class SerialTransport extends BaseTransport {
    private port?: SerialPort;
    private lock?: PortLock;
    constructor(
        private readonly path: string,
        private readonly baudRate: number,
    ) {
        super();
    }
    get id() {
        return this.path;
    }
    async open(): Promise<void> {
        const holders = otherPortHolders(this.path);
        if (holders.length) {
            throw new BfError(
                "PORT_BUSY",
                `${this.path} is already open in another program: ${holders.map((h) => `${h.command} (pid ${h.pid})`).join(", ")}`,
                ExitCode.CONNECTION,
                "close that program (Betaflight Configurator, a serial monitor, ...) and retry; two programs on one port corrupt MSP traffic",
                { holders },
            );
        }
        this.lock = PortLock.acquire(this.path);
        try {
            await new Promise<void>((resolve, reject) => {
                this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
                this.port.open((err) => (err ? reject(err) : resolve()));
            });
        } catch (e: any) {
            this.lock.release();
            const busy = /lock|busy|EBUSY/i.test(e.message);
            throw connectionError(
                `cannot open ${this.path}: ${e.message}`,
                busy
                    ? "another program (e.g. Betaflight Configurator) is using the port"
                    : /permission|EACCES/i.test(e.message)
                      ? "add your user to the dialout/uucp group, then log in again"
                      : "check the port path with `bf ports`",
            );
        }
        this.port!.on("data", (d: Buffer) => this.emitData(new Uint8Array(d)));
        this.port!.on("close", () => this.emitClose());
        // USB devices vanish on reboot (ENODEV); report as a close instead of crashing.
        this.port!.on("error", () => this.emitClose());
    }
    async write(data: Uint8Array): Promise<void> {
        const p = this.port;
        if (!p?.isOpen) throw connectionError("port is closed");
        await new Promise<void>((resolve, reject) => p.write(Buffer.from(data), (err) => (err ? reject(err) : p.drain(() => resolve()))));
    }
    poke(): void {
        if (this.port?.isOpen) this.port.write(Buffer.from([0]), () => undefined);
    }
    async close(): Promise<void> {
        const p = this.port;
        this.port = undefined;
        if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()));
        this.lock?.release();
    }
}

export class TcpTransport extends BaseTransport {
    private sock?: net.Socket;
    constructor(
        private readonly host: string,
        private readonly port: number,
    ) {
        super();
    }
    get id() {
        return `tcp://${this.host}:${this.port}`;
    }
    async open(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const s = net.createConnection({ host: this.host, port: this.port }, () => resolve());
            s.setNoDelay(true);
            s.once("error", (e) => reject(connectionError(`cannot connect to ${this.id}: ${e.message}`, "is SITL running?")));
            s.on("data", (d: Buffer) => this.emitData(new Uint8Array(d)));
            s.on("close", () => this.emitClose());
            s.on("error", () => this.emitClose());
            this.sock = s;
        });
    }
    async write(data: Uint8Array): Promise<void> {
        const s = this.sock;
        if (!s || s.destroyed) throw connectionError("socket is closed");
        await new Promise<void>((resolve, reject) => s.write(data, (err) => (err ? reject(err) : resolve())));
    }
    poke(): void {
        if (this.sock && !this.sock.destroyed) this.sock.write(Buffer.from([0]), () => undefined);
    }
    async close(): Promise<void> {
        const s = this.sock;
        this.sock = undefined;
        if (s && !s.destroyed) await new Promise<void>((r) => s.end(() => r()));
    }
}

/**
 * Advisory per-port lock so two `bf` invocations never interleave MSP traffic on one
 * port. Stale locks (dead pid) are taken over.
 */
export class PortLock {
    private constructor(private readonly file: string) {}
    static acquire(portPath: string): PortLock {
        const file = path.join(os.tmpdir(), `bf-port-${portPath.replace(/[^A-Za-z0-9]/g, "_")}.lock`);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                fs.writeFileSync(file, String(process.pid), { flag: "wx" });
                return new PortLock(file);
            } catch {
                const pid = Number(fs.readFileSync(file, "utf8"));
                if (pid && pid !== process.pid && processAlive(pid)) {
                    throw new BfError("PORT_BUSY", `${portPath} is in use by another bf process (pid ${pid})`, ExitCode.CONNECTION, "wait for it to finish");
                }
                fs.rmSync(file, { force: true });
            }
        }
        throw connectionError(`cannot lock ${portPath}`);
    }
    release() {
        fs.rmSync(this.file, { force: true });
    }
}

/** Linux: other processes that have the device node open (via /proc/<pid>/fd). Best effort, empty elsewhere. */
export function otherPortHolders(devicePath: string): { pid: number; command: string }[] {
    if (process.platform !== "linux") return [];
    let target: string;
    try {
        target = fs.realpathSync(devicePath);
    } catch {
        return [];
    }
    const out: { pid: number; command: string }[] = [];
    let pids: string[];
    try {
        pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid);
    } catch {
        return [];
    }
    for (const pid of pids) {
        let fds: string[];
        try {
            fds = fs.readdirSync(`/proc/${pid}/fd`);
        } catch {
            continue; // other users' processes are not readable
        }
        for (const fd of fds) {
            try {
                if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
                    out.push({ pid: Number(pid), command: fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() });
                    break;
                }
            } catch {
                /* fd closed meanwhile */
            }
        }
    }
    return out;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e.code === "EPERM";
    }
}
