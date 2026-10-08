// Onboard blackbox flash: summary, download (MSP_DATAFLASH_READ), erase, USB mass storage.
// Mirrors betaflight-configurator OnboardLoggingTab / useDataflashPull / useDataflashErase.

import fs from "node:fs";
import type { Session } from "../session.js";
import { MSP } from "../msp/codes.js";
import * as M from "../msp/messages.js";
import { BfError, ExitCode, unsupportedError } from "../errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BlackboxService {
    constructor(private readonly s: Session) {}

    async info() {
        const flash = M.decodeDataflashSummary(await this.s.request(MSP.MSP_DATAFLASH_SUMMARY));
        let sdcard: ReturnType<typeof M.decodeSdcardSummary> | undefined;
        try {
            sdcard = M.decodeSdcardSummary(await this.s.request(MSP.MSP_SDCARD_SUMMARY, [], { retries: 0 }));
        } catch {
            /* no SD support */
        }
        const device = await this.s.cli.exec("get blackbox_device");
        return {
            device: /blackbox_device = (\S+)/.exec(device.output)?.[1],
            flash: { ...flash, usedPercent: flash.totalSize ? Math.round((flash.usedSize / flash.totalSize) * 1000) / 10 : 0 },
            sdcard,
        };
    }

    /** Download the used part of the onboard flash to a file. */
    async download(file: string, progress: (m: string) => void, opts: { chunk?: number } = {}) {
        const sum = M.decodeDataflashSummary(await this.s.request(MSP.MSP_DATAFLASH_SUMMARY));
        if (!sum.supported) throw unsupportedError("this flight controller has no onboard dataflash", "logs on an SD card are read via `bf blackbox msc` (USB mass storage)");
        if (!sum.ready) throw new BfError("FLASH_BUSY", "dataflash is not ready (erasing or busy)", ExitCode.REFUSED, "wait and retry");
        const out = fs.openSync(file, "w");
        const chunk = opts.chunk ?? 4096;
        const t0 = Date.now();
        let addr = 0;
        try {
            while (addr < sum.usedSize) {
                const want = Math.min(chunk, sum.usedSize - addr);
                const r = M.decodeDataflashRead(await this.s.request(MSP.MSP_DATAFLASH_READ, M.encodeDataflashRead(addr, want), { timeoutMs: 3000 }));
                if (r.address !== addr) throw new BfError("FLASH_READ", `dataflash replied for 0x${r.address.toString(16)}, expected 0x${addr.toString(16)}`, ExitCode.GENERAL);
                if (r.compression !== 0) throw new BfError("FLASH_READ", "compressed dataflash reply received although compression was not requested", ExitCode.GENERAL);
                if (r.data.length === 0) break;
                fs.writeSync(out, r.data);
                addr += r.data.length;
                if ((addr / chunk) % 32 < 1) progress(`downloaded ${Math.round(addr / 1024)} / ${Math.round(sum.usedSize / 1024)} KiB`);
            }
        } finally {
            fs.closeSync(out);
        }
        const seconds = (Date.now() - t0) / 1000;
        return { file, bytes: addr, seconds, kibPerSecond: Math.round(addr / 1024 / Math.max(seconds, 0.001)) };
    }

    async erase(progress: (m: string) => void, timeoutS = 180) {
        await this.s.assertDisarmed();
        const before = M.decodeDataflashSummary(await this.s.request(MSP.MSP_DATAFLASH_SUMMARY));
        if (!before.supported) throw unsupportedError("this flight controller has no onboard dataflash");
        await this.s.request(MSP.MSP_DATAFLASH_ERASE, [], { timeoutMs: 5000 });
        const until = Date.now() + timeoutS * 1000;
        while (Date.now() < until) {
            await sleep(2000);
            const s = M.decodeDataflashSummary(await this.s.request(MSP.MSP_DATAFLASH_SUMMARY, [], { timeoutMs: 3000 }));
            if (s.ready) return { erased: true, freedBytes: before.usedSize, usedSize: s.usedSize };
            progress("erasing dataflash...");
        }
        throw new BfError("ERASE_TIMEOUT", "dataflash erase did not finish in time", ExitCode.GENERAL);
    }

    /** Reboot as a USB drive. The FC stays in that mode until it is unplugged/power-cycled. */
    async massStorage(utc = false) {
        await this.s.reboot(utc ? "msc-utc" : "msc");
        return { rebooted: true, mode: utc ? "msc-utc" : "msc", note: "the FC now appears as a USB drive; unplug or power-cycle it to return to normal mode" };
    }
}
