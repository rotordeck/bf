import { describe, it, expect } from "vitest";
import { encodeV1, encodeV2, crc8DvbS2Data, MspDecoder, type MspFrame } from "../src/core/msp/frame.js";
import { PayloadReader, PayloadWriter } from "../src/core/msp/bytes.js";
import * as M from "../src/core/msp/messages.js";
import { MSP } from "../src/core/msp/codes.js";

const decodeAll = (bytes: number[]) => {
    const frames: MspFrame[] = [];
    const noise: number[] = [];
    const bad: number[] = [];
    const d = new MspDecoder((f) => frames.push(f), (b) => noise.push(b), (c) => bad.push(c));
    d.push(bytes);
    return { frames, noise, bad };
};

describe("MSP framing", () => {
    it("encodes MSP_API_VERSION request as v1 golden frame", () => {
        expect([...encodeV1(1)]).toEqual([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);
    });

    it("encodes v1 payload with xor checksum", () => {
        // $M< size=2 cmd=68 [1,2] xor = 2^68^1^2
        expect([...encodeV1(68, [1, 2])]).toEqual([0x24, 0x4d, 0x3c, 2, 68, 1, 2, 2 ^ 68 ^ 1 ^ 2]);
    });

    it("encodes v2 with crc8_dvb_s2 over flags..payload", () => {
        const f = encodeV2(0x3010, [0x61]);
        expect([...f.slice(0, 8)]).toEqual([0x24, 0x58, 0x3c, 0, 0x10, 0x30, 1, 0]);
        expect(f[9]).toBe(crc8DvbS2Data([0, 0x10, 0x30, 1, 0, 0x61]));
    });

    it("crc8_dvb_s2 matches the reference value", () => {
        // reference: crc8_dvb_s2 of "123456789" is 0xBC
        expect(crc8DvbS2Data(Buffer.from("123456789"))).toBe(0xbc);
    });

    it("round-trips v1 and v2 replies through the decoder", () => {
        const { frames } = decodeAll([...encodeV1(3, [1, 2, 3], ">"), ...encodeV2(0x3006, [5, 4, 65, 66, 67, 68], ">")]);
        expect(frames.map((f) => [f.version, f.code, [...f.payload]])).toEqual([
            [1, 3, [1, 2, 3]],
            [2, 0x3006, [5, 4, 65, 66, 67, 68]],
        ]);
    });

    it("decodes v1 jumbo frames", () => {
        const payload = Array.from({ length: 300 }, (_, i) => i & 0xff);
        const enc = encodeV1(71, payload, ">");
        expect(enc[3]).toBe(255);
        const { frames } = decodeAll([...enc]);
        expect(frames[0].payload.length).toBe(300);
        expect([...frames[0].payload]).toEqual(payload);
    });

    it("unwraps v2-over-v1 frames", () => {
        const v2 = [0, 0x10, 0x30, 2, 0, 9, 8];
        const inner = [...v2, crc8DvbS2Data(v2)];
        const { frames } = decodeAll([...encodeV1(255, inner, ">")]);
        expect(frames[0]).toMatchObject({ version: 2, code: 0x3010 });
        expect([...frames[0].payload]).toEqual([9, 8]);
    });

    it("flags error replies and rejects bad checksums", () => {
        const err = [...encodeV1(250, [], "!")];
        const bad = [...encodeV1(1, [1], ">")];
        bad[bad.length - 1] ^= 0xff;
        const r = decodeAll([...err, ...bad]);
        expect(r.frames).toHaveLength(1);
        expect(r.frames[0].error).toBe(true);
        expect(r.bad).toEqual([1]);
    });

    it("passes non-MSP bytes (CLI text) to the noise handler", () => {
        const r = decodeAll([...Buffer.from("# "), ...encodeV1(1, [0, 1, 49], ">")]);
        expect(String.fromCharCode(...r.noise)).toBe("# ");
        expect(r.frames).toHaveLength(1);
    });
});

describe("payload helpers", () => {
    it("writes and reads little-endian values", () => {
        const w = new PayloadWriter().u8(1).u16(0x1234).u32(0xdeadbeef).i16(-2).pstr("ab");
        const r = new PayloadReader(w.toUint8Array());
        expect([r.u8(), r.u16(), r.u32(), r.i16(), r.pstr()]).toEqual([1, 0x1234, 0xdeadbeef, -2, "ab"]);
        expect(() => r.u8()).toThrow(/payload too short/);
    });
});

describe("message decoders", () => {
    it("decodes STATUS_EX with arming flags, modes and profiles", () => {
        const w = new PayloadWriter()
            .u16(250) // cycle time
            .u16(0) // i2c errors
            .u16(0b100001) // acc + gyro
            .raw([0b101, 0, 0, 0]) // modes 0 (ARM) and 2
            .u8(2) // pid profile index
            .u16(47) // cpu load (permille)
            .u8(4) // pid profile count
            .u8(0) // rate profile index
            .u8(0) // extra mode bytes
            .u8(30) // arming flag count
            .u32((1 << 2) | (1 << 13)) // RXLOSS, CLI
            .u8(1) // reboot required
            .u16(39)
            .u8(4)
            .u8(3)
            .u8(0);
        const s = M.decodeStatusEx(w.toUint8Array(), ["ARM", "ANGLE", "HORIZON"]);
        expect(s).toMatchObject({
            armed: true,
            activeModes: ["ARM", "HORIZON"],
            armingDisabledFlags: ["RXLOSS", "CLI"],
            canArm: false,
            rebootRequired: true,
            pidProfile: 3,
            rateProfile: 1,
            cpuLoadPercent: 4.7,
            cpuTempC: 39,
        });
        expect(s.sensors).toMatchObject({ acc: true, gyro: true, baro: false });
    });

    it("decodes FC_VERSION with and without the version string", () => {
        expect(M.decodeFcVersion(Uint8Array.from([4, 5, 2])).version).toBe("4.5.2");
        expect(M.decodeFcVersion(new PayloadWriter().u8(26).u8(6).u8(0).pstr("2026.6.0-alpha").toUint8Array()).version).toBe("2026.6.0-alpha");
    });

    it("encodes profile selection like the firmware expects", () => {
        expect(M.encodeSelectSetting("pid", 2)).toEqual([2]);
        expect(M.encodeSelectSetting("rate", 1)).toEqual([0x81]);
        expect(M.encodeSelectSetting("battery", 1)).toEqual([0x41]);
    });

    it("motor test payload always carries 8 motors", () => {
        const p = M.encodeSetMotor([1100]);
        expect(p.length).toBe(16);
        expect(new PayloadReader(Uint8Array.from(p)).u16()).toBe(1100);
    });

    it("has codes for the fork's MSP2 CLI commands", () => {
        expect(MSP.MSP2_CLI_SETTING).toBe(0x3010);
        expect(MSP.MSP2_CLI_COMMAND).toBe(0x3012);
    });
});
