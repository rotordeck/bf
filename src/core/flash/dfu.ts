// STM32 / AT32 / APM32 USB DFU (DfuSe) flashing over libusb.
//
// Protocol follows ST AN3156 (DfuSe) and betaflight-configurator src/js/protocols/usbdfu.js:
// read the flash layout from the alt setting name ("@Internal Flash /0x08000000/04*016Kg,..."),
// clear status, (optionally) remove read protection, erase the needed pages (or mass erase),
// write in wTransferSize chunks, verify by upload, then leave DFU to start the firmware.

import { usb } from "usb";

type UsbDevice = Awaited<ReturnType<typeof usb.getDevices>>[number];
import type { FirmwareImage } from "./hex.js";
import { BfError, ExitCode } from "../errors.js";

// VID/PID of DFU bootloaders (Configurator devices.js defaultUsbFilters)
export const DFU_DEVICES = [
    { vendorId: 0x0483, productId: 0xdf11, name: "STM32 DFU" },
    { vendorId: 0x28e9, productId: 0x0189, name: "GD32 DFU" },
    { vendorId: 0x2e3c, productId: 0xdf11, name: "AT32 DFU" },
    { vendorId: 0x314b, productId: 0x0106, name: "APM32 DFU" },
    { vendorId: 0x3997, productId: 0xdf11, name: "X32 DFU" },
];

const DFU = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 } as const;
const STATE = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 } as const;

export interface FlashSector {
    start: number;
    size: number;
    count: number;
}
export interface FlashLayout {
    name: string;
    start: number;
    sectors: FlashSector[];
    totalSize: number;
}

/** Parse a DfuSe alt-setting name like "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg". */
export function parseDfuLayout(desc: string): FlashLayout | undefined {
    const m = /^@([^/]+)\/0x([0-9a-f]+)\/(.+)$/i.exec(desc.trim());
    if (!m) return undefined;
    const start = parseInt(m[2], 16);
    let addr = start;
    const sectors: FlashSector[] = [];
    for (const part of m[3].split(",")) {
        const p = /^(\d+)\*(\d+)([ KM ])([a-g])$/i.exec(part.trim());
        if (!p) continue;
        const mult = p[3].toUpperCase() === "K" ? 1024 : p[3].toUpperCase() === "M" ? 1024 * 1024 : 1;
        const size = Number(p[2]) * mult;
        sectors.push({ start: addr, size, count: Number(p[1]) });
        addr += size * Number(p[1]);
    }
    return { name: m[1].trim(), start, sectors, totalSize: addr - start };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dfuName = (d: { vendorId: number; productId: number }) => DFU_DEVICES.find((f) => f.vendorId === d.vendorId && f.productId === d.productId)?.name;

export async function listDfuDevices() {
    const devs = await usb.getDevices();
    return devs.filter((d) => dfuName(d)).map((d) => ({ vendorId: d.vendorId, productId: d.productId, name: dfuName(d)!, bus: d.bus, address: d.address, serialNumber: d.serialNumber, device: d }));
}

export async function waitForDfuDevice(timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const devs = await listDfuDevices();
        if (devs.length) return devs[0];
        await sleep(300);
    }
    return undefined;
}

export class DfuFlasher {
    private iface = 0;
    private transferSize = 2048;
    private layout?: FlashLayout;

    constructor(
        private readonly dev: UsbDevice,
        private readonly progress: (msg: string, pct?: number) => void = () => {},
    ) {}

    private async ctrlOut(request: number, value: number, data: Uint8Array = new Uint8Array(0)): Promise<void> {
        const r = await this.dev.controlTransferOut({ requestType: "class", recipient: "interface", request, value, index: this.iface }, data as Uint8Array<ArrayBuffer>);
        if (r.status !== "ok") throw new BfError("DFU_ERROR", `USB control transfer failed (${r.status})`, ExitCode.CONNECTION);
    }

    private async ctrlIn(request: number, value: number, length: number): Promise<Uint8Array> {
        const r = await this.dev.controlTransferIn({ requestType: "class", recipient: "interface", request, value, index: this.iface }, length);
        if (r.status !== "ok" || !r.data) throw new BfError("DFU_ERROR", `USB control transfer failed (${r.status})`, ExitCode.CONNECTION);
        return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }

    /** wTransferSize from the DFU functional descriptor (type 0x21) in the configuration descriptor. */
    private async readTransferSize(): Promise<number | undefined> {
        const r = await this.dev.controlTransferIn({ requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 }, 512);
        if (r.status !== "ok" || !r.data) return undefined;
        const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        for (let o = 0; o + 1 < b.length && b[o] > 0; o += b[o]) {
            if (b[o + 1] === 0x21 && b[o] >= 7) return b[o + 5] | (b[o + 6] << 8);
        }
        return undefined;
    }

    async getStatus() {
        const b = await this.ctrlIn(DFU.GETSTATUS, 0, 6);
        return { status: b[0], pollTimeout: b[1] | (b[2] << 8) | (b[3] << 16), state: b[4] };
    }

    private async waitState(want: number, what: string) {
        for (let i = 0; i < 200; i++) {
            const s = await this.getStatus();
            if (s.state === want) return s;
            if (s.state === STATE.dfuERROR) {
                await this.ctrlOut(DFU.CLRSTATUS, 0);
                throw new BfError("DFU_ERROR", `DFU error during ${what} (status ${s.status})`, ExitCode.GENERAL, "the chip may be read-protected; retry with --full-erase");
            }
            await sleep(Math.max(s.pollTimeout, 5));
        }
        throw new BfError("DFU_TIMEOUT", `DFU timed out during ${what}`, ExitCode.CONNECTION);
    }

    async open(): Promise<FlashLayout> {
        await this.dev.open();
        if (!this.dev.configuration) await this.dev.selectConfiguration(1);
        for (const intf of this.dev.configuration!.interfaces) {
            for (const alt of intf.alternates) {
                if (alt.interfaceClass !== 0xfe || alt.interfaceSubclass !== 0x01) continue;
                const layout = parseDfuLayout(alt.interfaceName ?? "");
                if (layout && /flash/i.test(layout.name) && !this.layout) {
                    this.iface = intf.interfaceNumber;
                    this.layout = layout;
                    await this.dev.claimInterface(this.iface);
                    if (alt.alternateSetting !== 0) await this.dev.selectAlternateInterface(this.iface, alt.alternateSetting);
                }
            }
        }
        if (!this.layout) throw new BfError("DFU_ERROR", "could not find the internal flash in the DFU descriptors", ExitCode.UNSUPPORTED);
        this.transferSize = (await this.readTransferSize()) ?? 2048;
        // get out of any error/upload state
        const st = await this.getStatus();
        if (st.state === STATE.dfuERROR) await this.ctrlOut(DFU.CLRSTATUS, 0);
        if (st.state !== STATE.dfuIDLE) await this.ctrlOut(DFU.ABORT, 0);
        return this.layout;
    }

    private async dfuseCommand(bytes: number[], what: string) {
        await this.ctrlOut(DFU.DNLOAD, 0, Uint8Array.from(bytes));
        await this.waitState(STATE.dfuDNLOAD_IDLE, what);
    }

    private setAddress(addr: number) {
        return this.dfuseCommand([0x21, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >>> 24) & 0xff], `set address 0x${addr.toString(16)}`);
    }

    /** Erase only the sectors the image touches, or the whole chip. */
    async erase(img: FirmwareImage, full: boolean) {
        if (full) {
            this.progress("mass erase (can take 30-60 s)...");
            await this.ctrlOut(DFU.DNLOAD, 0, Uint8Array.from([0x41]));
            await this.waitState(STATE.dfuDNLOAD_IDLE, "mass erase");
            return;
        }
        const pages: number[] = [];
        for (const s of this.layout!.sectors) {
            for (let i = 0; i < s.count; i++) {
                const start = s.start + i * s.size;
                const end = start + s.size;
                if (img.blocks.some((b) => b.address < end && b.address + b.data.length > start)) pages.push(start);
            }
        }
        for (const [i, p] of pages.entries()) {
            this.progress(`erasing ${i + 1}/${pages.length}`, Math.round(((i + 1) / pages.length) * 100));
            await this.dfuseCommand([0x41, p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff], `erase page 0x${p.toString(16)}`);
        }
    }

    async write(img: FirmwareImage) {
        let done = 0;
        for (const block of img.blocks) {
            for (let off = 0; off < block.data.length; off += this.transferSize) {
                const chunk = block.data.subarray(off, off + this.transferSize);
                await this.setAddress(block.address + off);
                await this.ctrlOut(DFU.DNLOAD, 2, chunk);
                await this.waitState(STATE.dfuDNLOAD_IDLE, `write 0x${(block.address + off).toString(16)}`);
                done += chunk.length;
                this.progress(`writing ${done}/${img.bytesTotal} bytes`, Math.round((done / img.bytesTotal) * 100));
            }
        }
    }

    async verify(img: FirmwareImage) {
        let done = 0;
        for (const block of img.blocks) {
            await this.ctrlOut(DFU.ABORT, 0);
            await this.setAddress(block.address);
            await this.ctrlOut(DFU.ABORT, 0);
            for (let off = 0, blockNum = 2; off < block.data.length; off += this.transferSize, blockNum++) {
                const len = Math.min(this.transferSize, block.data.length - off);
                const got = await this.ctrlIn(DFU.UPLOAD, blockNum, len);
                const want = block.data.subarray(off, off + len);
                if (Buffer.compare(Buffer.from(got.subarray(0, len)), Buffer.from(want)) !== 0) {
                    throw new BfError("VERIFY_FAILED", `flash verification failed at 0x${(block.address + off).toString(16)}`, ExitCode.VERIFY_FAILED, "retry the flash with --full-erase");
                }
                done += len;
                this.progress(`verifying ${done}/${img.bytesTotal} bytes`, Math.round((done / img.bytesTotal) * 100));
            }
        }
        await this.ctrlOut(DFU.ABORT, 0);
    }

    /** Leave DFU: zero-length DNLOAD at the start address makes the bootloader jump to the firmware. */
    async leave(startAddress: number) {
        await this.setAddress(startAddress);
        await this.ctrlOut(DFU.DNLOAD, 0, new Uint8Array(0));
        try {
            await this.getStatus();
        } catch {
            /* device resets and disappears: expected */
        }
    }

    async close() {
        await this.dev.close().catch(() => undefined);
    }
}

export async function flashDfu(img: FirmwareImage, opts: { fullErase?: boolean; verify?: boolean; progress?: (m: string, pct?: number) => void } = {}) {
    const found = await waitForDfuDevice(15000);
    if (!found) throw new BfError("NO_DFU", "no DFU device found", ExitCode.CONNECTION, "on Linux add a udev rule for 0483:df11 (see the firmware-update skill), or hold BOOT while plugging in USB");
    const f = new DfuFlasher(found.device, opts.progress);
    try {
        const layout = await f.open();
        if (img.endAddress > layout.start + layout.totalSize || img.startAddress < layout.start) {
            throw new BfError("IMAGE_TOO_LARGE", `firmware (0x${img.startAddress.toString(16)}-0x${img.endAddress.toString(16)}) does not fit the flash ${layout.name}`, ExitCode.VALIDATION, "wrong firmware for this MCU?");
        }
        await f.erase(img, !!opts.fullErase);
        await f.write(img);
        if (opts.verify !== false) await f.verify(img);
        await f.leave(img.startAddress);
        return { device: found.name, flash: layout.name, bytes: img.bytesTotal, verified: opts.verify !== false, fullErase: !!opts.fullErase };
    } finally {
        await f.close();
    }
}
