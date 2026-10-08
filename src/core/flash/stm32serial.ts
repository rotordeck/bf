// STM32 system-memory bootloader over UART (ST AN3155), used when the FC is attached through a
// USB-UART adapter rather than native USB. Equivalent to betaflight-configurator
// src/js/protocols/webstm32.ts. Serial framing is 8E1.

import { SerialPort } from "serialport";
import type { FirmwareImage } from "./hex.js";
import { BfError, ExitCode } from "../errors.js";

const ACK = 0x79;
const NACK = 0x1f;
const CMD = { GET: 0x00, READ: 0x11, GO: 0x21, WRITE: 0x31, ERASE: 0x43, EXT_ERASE: 0x44 } as const;

const xor = (bytes: number[]) => bytes.reduce((a, b) => a ^ b, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Stm32SerialFlasher {
    private port!: SerialPort;
    private rx: number[] = [];
    private extendedErase = false;

    constructor(
        private readonly path: string,
        private readonly baudRate = 115200,
        private readonly progress: (m: string, pct?: number) => void = () => {},
    ) {}

    async open() {
        this.port = await new Promise<SerialPort>((resolve, reject) => {
            const p = new SerialPort({ path: this.path, baudRate: this.baudRate, parity: "even", dataBits: 8, stopBits: 1, autoOpen: false });
            p.open((e) => (e ? reject(e) : resolve(p)));
        });
        this.port.on("data", (d: Buffer) => this.rx.push(...d));
    }

    private async write(bytes: number[]) {
        await new Promise<void>((resolve, reject) => this.port.write(Buffer.from(bytes), (e) => (e ? reject(e) : this.port.drain(() => resolve()))));
    }

    private async read(n: number, timeoutMs = 2000): Promise<number[]> {
        const until = Date.now() + timeoutMs;
        while (this.rx.length < n) {
            if (Date.now() > until) throw new BfError("STM32_TIMEOUT", "no answer from the STM32 bootloader", ExitCode.CONNECTION, "is BOOT0 high / the FC in bootloader mode, and RX/TX crossed?");
            await sleep(5);
        }
        return this.rx.splice(0, n);
    }

    private async ack(what: string, timeoutMs = 2000) {
        const [b] = await this.read(1, timeoutMs);
        if (b === NACK) throw new BfError("STM32_NACK", `bootloader refused ${what}`, ExitCode.REFUSED, "the flash may be write-protected");
        if (b !== ACK) throw new BfError("STM32_PROTOCOL", `unexpected byte 0x${b.toString(16)} during ${what}`, ExitCode.GENERAL);
    }

    private async command(cmd: number, what: string) {
        await this.write([cmd, cmd ^ 0xff]);
        await this.ack(what);
    }

    async sync() {
        for (let i = 0; i < 5; i++) {
            this.rx = [];
            await this.write([0x7f]);
            try {
                const [b] = await this.read(1, 500);
                if (b === ACK || b === NACK) break;
            } catch {
                if (i === 4) throw new BfError("STM32_TIMEOUT", "STM32 bootloader did not respond to sync", ExitCode.CONNECTION);
            }
        }
        await this.command(CMD.GET, "GET");
        const [n] = await this.read(1);
        const data = await this.read(n + 1);
        await this.ack("GET");
        this.extendedErase = data.slice(1).includes(CMD.EXT_ERASE);
        return { bootloaderVersion: `${data[0] >> 4}.${data[0] & 0xf}`, extendedErase: this.extendedErase };
    }

    private addr(a: number) {
        const b = [(a >>> 24) & 0xff, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff];
        return [...b, xor(b)];
    }

    async massErase() {
        this.progress("erasing flash (can take up to a minute)...");
        if (this.extendedErase) {
            await this.command(CMD.EXT_ERASE, "extended erase");
            await this.write([0xff, 0xff, 0x00]);
            await this.ack("mass erase", 120000);
        } else {
            await this.command(CMD.ERASE, "erase");
            await this.write([0xff, 0x00]);
            await this.ack("mass erase", 60000);
        }
    }

    async writeImage(img: FirmwareImage) {
        let done = 0;
        for (const block of img.blocks) {
            for (let off = 0; off < block.data.length; off += 256) {
                const chunk = [...block.data.subarray(off, off + 256)];
                await this.command(CMD.WRITE, "write");
                await this.write(this.addr(block.address + off));
                await this.ack("write address");
                const payload = [chunk.length - 1, ...chunk];
                await this.write([...payload, xor(payload)]);
                await this.ack("write data", 5000);
                done += chunk.length;
                this.progress(`writing ${done}/${img.bytesTotal}`, Math.round((done / img.bytesTotal) * 100));
            }
        }
    }

    async verify(img: FirmwareImage) {
        let done = 0;
        for (const block of img.blocks) {
            for (let off = 0; off < block.data.length; off += 256) {
                const len = Math.min(256, block.data.length - off);
                await this.command(CMD.READ, "read");
                await this.write(this.addr(block.address + off));
                await this.ack("read address");
                await this.write([len - 1, (len - 1) ^ 0xff]);
                await this.ack("read length");
                const got = await this.read(len);
                if (Buffer.compare(Buffer.from(got), Buffer.from(block.data.subarray(off, off + len))) !== 0) {
                    throw new BfError("VERIFY_FAILED", `verification failed at 0x${(block.address + off).toString(16)}`, ExitCode.VERIFY_FAILED);
                }
                done += len;
                this.progress(`verifying ${done}/${img.bytesTotal}`, Math.round((done / img.bytesTotal) * 100));
            }
        }
    }

    async go(address: number) {
        await this.command(CMD.GO, "go");
        await this.write(this.addr(address));
        await this.ack("go address");
    }

    async close() {
        if (this.port?.isOpen) await new Promise<void>((r) => this.port.close(() => r()));
    }
}

export async function flashStm32Serial(path: string, img: FirmwareImage, opts: { baudRate?: number; verify?: boolean; progress?: (m: string, pct?: number) => void } = {}) {
    const f = new Stm32SerialFlasher(path, opts.baudRate ?? 115200, opts.progress);
    await f.open();
    try {
        const info = await f.sync();
        await f.massErase();
        await f.writeImage(img);
        if (opts.verify !== false) await f.verify(img);
        await f.go(img.startAddress);
        return { method: "stm32-serial", port: path, bootloader: info.bootloaderVersion, bytes: img.bytesTotal, verified: opts.verify !== false };
    } finally {
        await f.close();
    }
}
