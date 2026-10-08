// Firmware update orchestration (Configurator Firmware Flasher tab):
// pick target/release -> cloud build or local file -> back up config -> reboot to DFU ->
// flash + verify -> wait for the FC -> optionally restore the backup.

import fs from "node:fs";
import { Session, waitForFc, type ConnectOptions } from "../session.js";
import { ConfigService } from "./config.js";
import { BuildApi, cloudBuild, resolveBuildOptions } from "../net/buildapi.js";
import { parseHex, binImage, type FirmwareImage } from "../flash/hex.js";
import { flashDfu, listDfuDevices } from "../flash/dfu.js";
import { flashStm32Serial } from "../flash/stm32serial.js";
import { BfError, validationError } from "../errors.js";

export function loadImage(file: string): FirmwareImage {
    const data = fs.readFileSync(file);
    if (/\.hex$/i.test(file) || data.subarray(0, 1).toString() === ":") return parseHex(data.toString("latin1"));
    if (/\.bin$/i.test(file)) return binImage(new Uint8Array(data));
    if (/\.uf2$/i.test(file)) throw validationError("UF2 images (RP2350) are flashed by copying the file to the RPI-RP2 drive", "reboot with `bf reboot --mode bootloader --confirm`, then copy the .uf2 file");
    throw validationError(`unknown firmware file type: ${file}`, "expected .hex or .bin");
}

export async function detectTarget(s: Session) {
    const id = s.identity;
    const candidates = [id.board, id.target].filter(Boolean);
    const targets = await BuildApi.targets();
    const match = targets.find((t) => candidates.includes(t.target));
    return {
        connectedBoard: id.board,
        firmware: id.version,
        mcu: id.mcu,
        buildTarget: match?.target,
        manufacturer: match?.manufacturer,
        buildKey: id.build.key,
        note: match ? undefined : "board not found on the build server: pick a target manually with --target",
    };
}

export async function releasesFor(target: string, includeUnstable = false) {
    const t = await BuildApi.target(target);
    return t.releases
        .filter((r) => !r.withdrawn && (includeUnstable || r.type === "Stable"))
        .map((r) => ({ release: r.release, type: r.type, date: r.date, cloudBuild: r.cloudBuild }));
}

export async function buildFirmware(
    req: { target: string; release?: string; options?: string[]; core?: boolean; commit?: string; output?: string },
    progress: (m: string) => void,
) {
    const release = req.release ?? (await releasesFor(req.target))[0]?.release;
    if (!release) throw validationError(`no stable release found for ${req.target}`);
    const opts = resolveBuildOptions(await BuildApi.options(release), req.options ?? [], { core: req.core });
    progress(`requesting ${req.target} ${release} [${opts.join(" ")}]`);
    const built = await cloudBuild({ target: req.target, release, options: opts, commit: req.commit }, progress);
    const bytes = await BuildApi.download(built.url);
    const file = req.output ?? built.file;
    fs.writeFileSync(file, bytes);
    return { file, bytes: bytes.length, target: req.target, release, options: opts, buildKey: built.key, log: built.log, configuration: built.configuration };
}

export interface FlashOptions {
    file: string;
    method?: "dfu" | "serial";
    /** UART path for the STM32 serial bootloader */
    serialPort?: string;
    fullErase?: boolean;
    noBackup?: boolean;
    restore?: boolean;
    backupFile?: string;
    connect: ConnectOptions;
    progress: (m: string) => void;
}

export async function flashFirmware(o: FlashOptions) {
    const img = loadImage(o.file);
    let backupFile: string | undefined;
    let fromFc: { board: string; version: string } | undefined;
    const method = o.method ?? "dfu";

    if (method === "dfu" && (await listDfuDevices()).length === 0) {
        // FC is running firmware: back up, then reboot it into the ROM bootloader.
        const s = await Session.connect(o.connect);
        try {
            fromFc = { board: s.identity.board, version: s.identity.version };
            if (!o.noBackup) {
                backupFile = o.backupFile ?? `BTFL_backup_before_flash_${s.identity.board}_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.txt`;
                fs.writeFileSync(backupFile, await new ConfigService(s).diff("all"));
                o.progress(`configuration backed up to ${backupFile}`);
            }
            o.progress("rebooting into DFU bootloader...");
            await s.reboot("bootloader");
        } catch (e) {
            await s.close();
            throw e;
        }
    }

    const flashed =
        method === "dfu"
            ? await flashDfu(img, { fullErase: o.fullErase, progress: (m) => o.progress(m) })
            : await flashStm32Serial(o.serialPort ?? o.connect.port ?? "", img, { progress: (m) => o.progress(m) });

    o.progress("waiting for the flight controller to boot the new firmware...");
    let after: { version: string; board: string } | undefined;
    let restored: unknown;
    try {
        const s = await waitForFc({ ...o.connect, port: o.connect.port?.startsWith("tcp://") ? o.connect.port : undefined }, 30000);
        after = { version: s.identity.version, board: s.identity.board };
        if (o.restore && backupFile) {
            o.progress("restoring configuration...");
            restored = await new ConfigService(s).restore(fs.readFileSync(backupFile, "utf8")).catch((e) => ({ error: e instanceof BfError ? e.toJSON() : String(e) }));
        } else {
            await s.close();
        }
    } catch {
        o.progress("flight controller did not reconnect over MSP (a full erase leaves a fresh config; this can be normal)");
    }
    return { ...flashed, before: fromFc, after, backupFile, restored, nextStep: backupFile && !o.restore ? `restore your settings with: bf config restore ${backupFile} --confirm` : undefined };
}
