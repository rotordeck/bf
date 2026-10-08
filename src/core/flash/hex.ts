// Intel HEX parser. Ported from betaflight-configurator src/js/workers/hex_parser.ts;
// returns contiguous blocks with absolute addresses.

import { validationError } from "../errors.js";

export interface HexBlock {
    address: number;
    data: Uint8Array;
}

export interface FirmwareImage {
    blocks: HexBlock[];
    bytesTotal: number;
    startAddress: number;
    endAddress: number;
}

export function parseHex(text: string): FirmwareImage {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const blocks: { address: number; bytes: number[] }[] = [];
    let ela = 0;
    let next = -1;
    let eof = false;
    let total = 0;
    for (const [i, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line.startsWith(":")) throw validationError(`not an Intel HEX file (line ${i + 1})`);
        const bytes = Buffer.from(line.slice(1), "hex");
        const count = bytes[0];
        const addr = (bytes[1] << 8) | bytes[2];
        const type = bytes[3];
        const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
        if (sum !== 0 || bytes.length !== count + 5) throw validationError(`HEX checksum error on line ${i + 1}`);
        const data = bytes.subarray(4, 4 + count);
        if (type === 0x00) {
            const abs = ela + addr;
            if (abs !== next || blocks.length === 0) blocks.push({ address: abs, bytes: [] });
            blocks[blocks.length - 1].bytes.push(...data);
            next = abs + count;
            total += count;
        } else if (type === 0x01) {
            eof = true;
            break;
        } else if (type === 0x04) {
            ela = ((data[0] << 24) | (data[1] << 16)) >>> 0;
        }
    }
    if (!eof) throw validationError("HEX file has no end-of-file record (truncated download?)");
    const out = blocks.map((b) => ({ address: b.address, data: Uint8Array.from(b.bytes) }));
    return {
        blocks: out,
        bytesTotal: total,
        startAddress: Math.min(...out.map((b) => b.address)),
        endAddress: Math.max(...out.map((b) => b.address + b.data.length)),
    };
}

/** Raw .bin image at a base address (default STM32 flash start). */
export const binImage = (data: Uint8Array, address = 0x08000000): FirmwareImage => ({
    blocks: [{ address, data }],
    bytesTotal: data.length,
    startAddress: address,
    endAddress: address + data.length,
});
