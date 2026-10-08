// MSP framing: encoder + streaming decoder for MSPv1 (incl. jumbo) and MSPv2 native.
// Ported from betaflight-configurator src/js/msp.ts, checked against firmware
// src/main/msp/msp_serial.c (mspSerialEncode / mspSerialProcessReceivedData).
//
//   v1:        '$' 'M' dir size(u8) cmd(u8) payload xor(size..payload)
//   v1 jumbo:  '$' 'M' dir 0xFF cmd(u8) size(u16le) payload xor(...)
//   v2:        '$' 'X' dir flags(u8) cmd(u16le) size(u16le) payload crc8_dvb_s2(flags..payload)
//   dir: '<' request, '>' reply, '!' error reply

export const MSP_V2_FRAME_ID = 255;
const JUMBO_FRAME_SIZE_LIMIT = 255;

export interface MspFrame {
    version: 1 | 2;
    code: number;
    payload: Uint8Array;
    /** true when the FC answered with '!' (MSP_RESULT_ERROR / unknown command) */
    error: boolean;
    flags: number;
}

export function crc8DvbS2(crc: number, byte: number): number {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
        crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}

export function crc8DvbS2Data(data: ArrayLike<number>, start = 0, end = data.length): number {
    let crc = 0;
    for (let i = start; i < end; i++) crc = crc8DvbS2(crc, data[i]);
    return crc;
}

export function encodeV1(code: number, payload: ArrayLike<number> = [], direction = "<"): Uint8Array {
    const len = payload.length;
    const jumbo = len >= JUMBO_FRAME_SIZE_LIMIT;
    const hdr = jumbo ? [JUMBO_FRAME_SIZE_LIMIT, code, len & 0xff, (len >> 8) & 0xff] : [len, code];
    const out = new Uint8Array(3 + hdr.length + len + 1);
    out.set([0x24, 0x4d, direction.charCodeAt(0)], 0);
    out.set(hdr, 3);
    out.set(Array.from(payload), 3 + hdr.length);
    let xor = 0;
    for (let i = 3; i < out.length - 1; i++) xor ^= out[i];
    out[out.length - 1] = xor;
    return out;
}

export function encodeV2(code: number, payload: ArrayLike<number> = [], direction = "<", flags = 0): Uint8Array {
    const len = payload.length;
    const out = new Uint8Array(8 + len + 1);
    out.set([0x24, 0x58, direction.charCodeAt(0), flags, code & 0xff, (code >> 8) & 0xff, len & 0xff, (len >> 8) & 0xff], 0);
    out.set(Array.from(payload), 8);
    out[out.length - 1] = crc8DvbS2Data(out, 3, out.length - 1);
    return out;
}

/** Encode a request the way Configurator does: v1 for codes <= 254, native v2 above. */
export function encodeRequest(code: number, payload: ArrayLike<number> = []): Uint8Array {
    return code <= 254 ? encodeV1(code, payload) : encodeV2(code, payload);
}

const enum S {
    IDLE,
    PROTO,
    DIR,
    V1_SIZE,
    V1_CMD,
    V1_JUMBO_LO,
    V1_JUMBO_HI,
    V1_PAYLOAD,
    V1_CHECKSUM,
    V2_FLAGS,
    V2_CMD_LO,
    V2_CMD_HI,
    V2_SIZE_LO,
    V2_SIZE_HI,
    V2_PAYLOAD,
    V2_CHECKSUM,
}

/**
 * Byte-at-a-time MSP decoder. Bytes that are not part of an MSP frame are handed to
 * `onNoise` (the CLI text-mode channel uses this to read CLI output on the same port).
 */
export class MspDecoder {
    private state = S.IDLE;
    private version: 1 | 2 = 1;
    private error = false;
    private flags = 0;
    private code = 0;
    private size = 0;
    private buf: number[] = [];
    private checksum = 0;
    /** v2 frames tunnelled in a v1 frame (cmd 255) are unwrapped transparently */

    constructor(
        private readonly onFrame: (f: MspFrame) => void,
        private readonly onNoise?: (byte: number) => void,
        private readonly onBadChecksum?: (code: number) => void,
    ) {}

    push(data: ArrayLike<number>): void {
        for (let i = 0; i < data.length; i++) this.byte(data[i]);
    }

    reset(): void {
        this.state = S.IDLE;
    }

    private byte(c: number): void {
        switch (this.state) {
            case S.IDLE:
                if (c === 0x24) this.state = S.PROTO;
                else this.onNoise?.(c);
                break;
            case S.PROTO:
                if (c === 0x4d) {
                    this.version = 1;
                    this.state = S.DIR;
                } else if (c === 0x58) {
                    this.version = 2;
                    this.state = S.DIR;
                } else {
                    this.onNoise?.(0x24);
                    this.onNoise?.(c);
                    this.state = S.IDLE;
                }
                break;
            case S.DIR:
                if (c !== 0x3e && c !== 0x21 && c !== 0x3c) {
                    this.state = S.IDLE;
                    break;
                }
                this.error = c === 0x21;
                this.buf = [];
                this.state = this.version === 1 ? S.V1_SIZE : S.V2_FLAGS;
                break;
            case S.V1_SIZE:
                this.size = c;
                this.checksum = c;
                this.state = S.V1_CMD;
                break;
            case S.V1_CMD:
                this.code = c;
                this.checksum ^= c;
                if (this.size === JUMBO_FRAME_SIZE_LIMIT) this.state = S.V1_JUMBO_LO;
                else this.state = this.size > 0 ? S.V1_PAYLOAD : S.V1_CHECKSUM;
                break;
            case S.V1_JUMBO_LO:
                this.size = c;
                this.checksum ^= c;
                this.state = S.V1_JUMBO_HI;
                break;
            case S.V1_JUMBO_HI:
                this.size |= c << 8;
                this.checksum ^= c;
                this.state = this.size > 0 ? S.V1_PAYLOAD : S.V1_CHECKSUM;
                break;
            case S.V1_PAYLOAD:
                this.buf.push(c);
                this.checksum ^= c;
                if (this.buf.length >= this.size) this.state = S.V1_CHECKSUM;
                break;
            case S.V1_CHECKSUM:
                this.state = S.IDLE;
                if (c !== this.checksum) {
                    this.onBadChecksum?.(this.code);
                    break;
                }
                if (this.code === MSP_V2_FRAME_ID && this.buf.length >= 6) this.unwrapV2OverV1();
                else this.emit(1, this.code, 0);
                break;
            case S.V2_FLAGS:
                this.flags = c;
                this.checksum = crc8DvbS2(0, c);
                this.state = S.V2_CMD_LO;
                break;
            case S.V2_CMD_LO:
                this.code = c;
                this.checksum = crc8DvbS2(this.checksum, c);
                this.state = S.V2_CMD_HI;
                break;
            case S.V2_CMD_HI:
                this.code |= c << 8;
                this.checksum = crc8DvbS2(this.checksum, c);
                this.state = S.V2_SIZE_LO;
                break;
            case S.V2_SIZE_LO:
                this.size = c;
                this.checksum = crc8DvbS2(this.checksum, c);
                this.state = S.V2_SIZE_HI;
                break;
            case S.V2_SIZE_HI:
                this.size |= c << 8;
                this.checksum = crc8DvbS2(this.checksum, c);
                this.state = this.size > 0 ? S.V2_PAYLOAD : S.V2_CHECKSUM;
                break;
            case S.V2_PAYLOAD:
                this.buf.push(c);
                this.checksum = crc8DvbS2(this.checksum, c);
                if (this.buf.length >= this.size) this.state = S.V2_CHECKSUM;
                break;
            case S.V2_CHECKSUM:
                this.state = S.IDLE;
                if (c !== this.checksum) {
                    this.onBadChecksum?.(this.code);
                    break;
                }
                this.emit(2, this.code, this.flags);
                break;
        }
    }

    private unwrapV2OverV1(): void {
        const b = this.buf;
        const flags = b[0];
        const code = b[1] | (b[2] << 8);
        const size = b[3] | (b[4] << 8);
        const crc = crc8DvbS2Data(b, 0, 5 + size);
        if (b[5 + size] !== crc) {
            this.onBadChecksum?.(code);
            return;
        }
        this.buf = b.slice(5, 5 + size);
        this.emit(2, code, flags);
    }

    private emit(version: 1 | 2, code: number, flags: number): void {
        this.onFrame({ version, code, flags, error: this.error, payload: Uint8Array.from(this.buf) });
    }
}
