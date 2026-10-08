// Typed decoders/encoders for the binary MSP messages bf uses directly. Layouts follow the
// firmware handlers in betaflight/src/main/msp/msp.c (mspCommonProcessOutCommand,
// mspFcProcessOutCommand, mspProcessInCommand). Configuration that is reachable as a named
// CLI setting is deliberately NOT done here: named settings are stable across firmware
// versions, binary layouts are not (see services/settings.ts).

import { PayloadReader, PayloadWriter } from "./bytes.js";

export const ARMING_DISABLE_FLAG_NAMES = [
    "NOGYRO",
    "FAILSAFE",
    "RXLOSS",
    "NOT_DISARMED",
    "BOXFAILSAFE",
    "RUNAWAY",
    "CRASH",
    "THROTTLE",
    "ANGLE",
    "BOOTGRACE",
    "NOPREARM",
    "LOAD",
    "CALIB",
    "CLI",
    "CMS",
    "BST",
    "MSP",
    "PARALYZE",
    "GPS",
    "RESCUE_SW",
    "DSHOT_TELEM",
    "REBOOT_REQD",
    "DSHOT_BBANG",
    "NO_ACC_CAL",
    "MOTOR_PROTO",
    "FLIP_SWITCH",
    "ALT_HOLD_SW",
    "POS_HOLD_SW",
    "AUTOPILOT_SW",
    "ARM_SWITCH",
] as const;

export const REBOOT_MODES = { firmware: 0, bootloader: 1, msc: 2, "msc-utc": 3, "bootloader-flash": 4 } as const;
export type RebootMode = keyof typeof REBOOT_MODES;

const zstr = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").replace(/\0.*$/s, "");

export function decodeApiVersion(p: Uint8Array) {
    const r = new PayloadReader(p);
    const protocol = r.u8();
    const major = r.u8();
    const minor = r.u8();
    return { protocol, api: `${major}.${minor}`, major, minor };
}

export const decodeFcVariant = (p: Uint8Array) => zstr(p.slice(0, 4));

export function decodeFcVersion(p: Uint8Array) {
    const r = new PayloadReader(p);
    const a = r.u8();
    const b = r.u8();
    const c = r.u8();
    // Since the CalVer switch the firmware sends (year-2000, month, patch) plus a
    // length-prefixed version string; older firmware sends only the 3 bytes (x.y.z).
    const versionString = r.has(1) ? r.pstr() : undefined;
    return { version: versionString || `${a}.${b}.${c}`, parts: [a, b, c] };
}

export function decodeBoardInfo(p: Uint8Array) {
    const r = new PayloadReader(p);
    const boardIdentifier = r.str(4);
    const hardwareRevision = r.u16();
    const boardType = r.u8();
    const capabilities = r.u8or(0);
    const targetName = r.has(1) ? r.pstr() : "";
    const boardName = r.has(1) ? r.pstr() : "";
    const manufacturerId = r.has(1) ? r.pstr() : "";
    if (r.has(32)) r.bytes(32); // signature
    const mcuTypeId = r.u8or(undefined);
    const configurationState = r.u8or(undefined);
    const gyroSampleRateHz = r.u16or(undefined);
    const problems = r.u32or(0);
    return {
        boardIdentifier,
        hardwareRevision,
        hasMax7456: boardType === 2,
        capabilities: {
            vcp: !!(capabilities & 1),
            softSerial: !!(capabilities & 2),
            flashBootloader: !!(capabilities & 8),
            rxBind: !!(capabilities & 64),
        },
        targetName,
        boardName,
        manufacturerId,
        mcuTypeId,
        configurationState,
        gyroSampleRateHz,
        problems: {
            accNeedsCalibration: !!(problems & 1),
            motorProtocolDisabled: !!(problems & 2),
        },
    };
}

export function decodeBuildInfo(p: Uint8Array) {
    const r = new PayloadReader(p);
    const date = r.str(11);
    const time = r.str(8);
    const gitRevision = r.str(7);
    return { date, time, gitRevision };
}

export function decodeUid(p: Uint8Array) {
    const r = new PayloadReader(p);
    return [r.u32(), r.u32(), r.u32()].map((n) => n.toString(16).padStart(8, "0")).join("");
}

export function decodeStatusEx(p: Uint8Array, boxNames: string[] = []) {
    const r = new PayloadReader(p);
    const cycleTimeUs = r.u16();
    const i2cErrors = r.u16();
    const sensorBits = r.u16();
    const modeBytes = [...r.bytes(4)];
    const pidProfile = r.u8();
    const cpuLoadPercent = r.u16();
    const pidProfileCount = r.u8();
    const rateProfile = r.u8();
    const extraModeBytes = r.u8();
    modeBytes.push(...r.bytes(extraModeBytes));
    const armingFlagCount = r.u8();
    const armingFlags = r.u32();
    const configState = r.u8or(0);
    const cpuTempC = r.u16or(undefined);
    const rateProfileCount = r.u8or(undefined);
    const batteryProfileCount = r.u8or(undefined);
    const batteryProfile = r.u8or(undefined);

    const activeModes: string[] = [];
    modeBytes.forEach((byte, i) => {
        for (let b = 0; b < 8; b++) if (byte & (1 << b)) activeModes.push(boxNames[i * 8 + b] ?? `BOX${i * 8 + b}`);
    });
    const armingDisabledFlags: string[] = [];
    for (let i = 0; i < armingFlagCount; i++) {
        if (armingFlags & (1 << i)) armingDisabledFlags.push(ARMING_DISABLE_FLAG_NAMES[i] ?? `FLAG${i}`);
    }
    const sensorNames = ["acc", "baro", "mag", "gps", "rangefinder", "gyro", "opticalflow", "pitot"];
    const sensors = Object.fromEntries(sensorNames.map((n, i) => [n, !!(sensorBits & (1 << i))]));
    return {
        armed: activeModes.includes("ARM"),
        armingDisabledFlags,
        canArm: armingDisabledFlags.length === 0,
        activeModes,
        rebootRequired: !!(configState & 1),
        cpuLoadPercent: cpuLoadPercent / 10,
        cycleTimeUs,
        i2cErrors,
        cpuTempC,
        sensors,
        pidProfile: pidProfile + 1,
        pidProfileCount,
        rateProfile: rateProfile + 1,
        rateProfileCount,
        batteryProfile: batteryProfile === undefined ? undefined : batteryProfile + 1,
        batteryProfileCount,
    };
}
export type Status = ReturnType<typeof decodeStatusEx>;

/** MSP_BOXNAMES / MSP_BOXIDS are paged 32 boxes per page; names are ';'-terminated. */
export const decodeBoxNames = (p: Uint8Array) => Buffer.from(p).toString("latin1").split(";").filter(Boolean);
export const decodeBoxIds = (p: Uint8Array) => [...p];

export function decodeAnalog(p: Uint8Array) {
    const r = new PayloadReader(p);
    r.u8();
    const mAhDrawn = r.u16();
    const rssi = r.u16();
    const amperage = r.i16() / 100;
    const voltage = r.has(2) ? r.u16() / 100 : undefined;
    return { voltage, amperage, mAhDrawn, rssiPercent: Math.round((rssi / 1023) * 1000) / 10 };
}

export function decodeBatteryState(p: Uint8Array) {
    const r = new PayloadReader(p);
    const cellCount = r.u8();
    const capacityMah = r.u16();
    r.u8();
    const mAhDrawn = r.u16();
    const amperage = r.i16() / 100;
    const state = ["ok", "warning", "critical", "not_present", "init"][r.u8()] ?? "unknown";
    const voltage = r.u16() / 100;
    return { cellCount, capacityMah, voltage, cellVoltage: cellCount ? Math.round((voltage / cellCount) * 100) / 100 : null, amperage, mAhDrawn, state };
}

export function decodeRc(p: Uint8Array) {
    const r = new PayloadReader(p);
    const ch: number[] = [];
    while (r.has(2)) ch.push(r.u16());
    return ch;
}

export function decodeAttitude(p: Uint8Array) {
    const r = new PayloadReader(p);
    return { roll: r.i16() / 10, pitch: r.i16() / 10, yaw: r.i16() };
}

export function decodeRawImu(p: Uint8Array) {
    const r = new PayloadReader(p);
    const v = () => [r.i16(), r.i16(), r.i16()];
    return { acc: v(), gyroDps: v(), mag: v() };
}

export function decodeAltitude(p: Uint8Array) {
    const r = new PayloadReader(p);
    return { altitudeM: r.i32() / 100, varioCmS: r.has(2) ? r.i16() : undefined };
}

export function decodeMotor(p: Uint8Array) {
    const r = new PayloadReader(p);
    const out: number[] = [];
    while (r.has(2)) out.push(r.u16());
    return out;
}

export function decodeMotorTelemetry(p: Uint8Array) {
    const r = new PayloadReader(p);
    const count = r.u8();
    return Array.from({ length: count }, (_, i) => ({
        motor: i + 1,
        rpm: r.u32(),
        invalidPercent: r.u16() / 100,
        temperatureC: r.u8(),
        voltage: r.u16() / 100,
        current: r.u16() / 100,
        consumptionMah: r.u16(),
    }));
}

export function decodeRawGps(p: Uint8Array) {
    const r = new PayloadReader(p);
    const fix = r.u8();
    const numSat = r.u8();
    const lat = r.i32() / 1e7;
    const lon = r.i32() / 1e7;
    const altM = r.u16();
    const speedCmS = r.u16();
    const course = r.u16() / 10;
    const pdop = r.has(2) ? r.u16() / 100 : undefined;
    const hdop = r.has(2) ? r.u16() / 100 : undefined;
    const vdop = r.has(2) ? r.u16() / 100 : undefined;
    const satsInView = r.u8or(undefined);
    return { fix: fix > 0, numSat, satsInView, lat, lon, altM, speedCmS, courseDeg: course, pdop, hdop, vdop };
}

export function decodeCompGps(p: Uint8Array) {
    const r = new PayloadReader(p);
    return { distanceToHomeM: r.u16(), directionToHomeDeg: r.u16(), updateToggle: r.u8() };
}

export function decodeGpsSvInfo(p: Uint8Array) {
    const r = new PayloadReader(p);
    const n = r.u8();
    return Array.from({ length: n }, () => ({ channel: r.u8(), svid: r.u8(), quality: r.u8(), cno: r.u8() }));
}

export function decodeDataflashSummary(p: Uint8Array) {
    const r = new PayloadReader(p);
    const flags = r.u8();
    return { supported: !!(flags & 2), ready: !!(flags & 1), sectors: r.u32(), totalSize: r.u32(), usedSize: r.u32() };
}

export function decodeSdcardSummary(p: Uint8Array) {
    const r = new PayloadReader(p);
    const supported = !!(r.u8() & 1);
    const state = ["not_present", "fatal", "card_init", "fs_init", "ready"][r.u8()] ?? "unknown";
    const lastError = r.u8();
    return { supported, state, lastError, freeKb: r.u32(), totalKb: r.u32() };
}

export const encodeDataflashRead = (address: number, length: number) => new PayloadWriter().u32(address).u16(length).u8(0).toArray();

export function decodeDataflashRead(p: Uint8Array) {
    const r = new PayloadReader(p);
    const address = r.u32();
    const length = r.u16();
    const compression = r.u8();
    return { address, compression, data: r.bytes(length) };
}

/** MSP_SET_MOTOR takes one u16 per motor in the external range (1000 = stop, 2000 = full). */
export const encodeSetMotor = (values: number[]) => {
    const w = new PayloadWriter();
    for (let i = 0; i < 8; i++) w.u16(values[i] ?? 1000);
    return w.toArray();
};

export const encodeArmingDisabled = (disable: boolean, disableRunawayTakeoff = true) => [disable ? 1 : 0, disableRunawayTakeoff ? 1 : 0];

export const encodeSelectSetting = (kind: "pid" | "rate" | "battery", index0: number) =>
    [kind === "rate" ? 0x80 | index0 : kind === "battery" ? 0x40 | index0 : index0];

export const encodeCopyProfile = (kind: "pid" | "rate", dst0: number, src0: number) => [kind === "rate" ? 1 : 0, dst0, src0];

export const encodeGetText = (type: number) => [type];
export const decodeText = (p: Uint8Array) => {
    const r = new PayloadReader(p);
    r.u8();
    return r.pstr();
};
export const encodeSetText = (type: number, text: string) => new PayloadWriter().u8(type).pstr(text).toArray();

/** MSP2_SEND_DSHOT_COMMAND: type 1 = blocking (motors stopped). motorIndex 255 = all. */
export const encodeDshotCommand = (motorIndex: number, commands: number[], blocking = true) => [blocking ? 1 : 0, motorIndex, commands.length, ...commands];

export const DSHOT_CMD = {
    SPIN_DIRECTION_NORMAL: 20,
    SPIN_DIRECTION_REVERSED: 21,
    SAVE_SETTINGS: 12,
    SPIN_DIRECTION_1: 7,
    SPIN_DIRECTION_2: 8,
    BEACON1: 1,
} as const;

export function encodeRtc(date = new Date()) {
    const ms = date.getTime();
    return new PayloadWriter().u32(Math.floor(ms / 1000)).u16(ms % 1000).toArray();
}

export function decodeOsdCanvas(p: Uint8Array) {
    const r = new PayloadReader(p);
    return { columns: r.u8(), rows: r.u8() };
}

export function decodeMcuInfo(p: Uint8Array) {
    const r = new PayloadReader(p);
    const id = r.u8();
    return { id, name: r.has(1) ? r.pstr() : "" };
}

export function decodeMotorReordering(p: Uint8Array) {
    const r = new PayloadReader(p);
    const n = r.u8();
    return Array.from({ length: n }, () => r.u8());
}
export const encodeMotorReordering = (order: number[]) => [order.length, ...order];

export function decodeVtxDeviceStatus(p: Uint8Array) {
    const r = new PayloadReader(p);
    const deviceType = r.u8();
    const types: Record<number, string> = { 0: "unsupported", 1: "rtc6705", 3: "smartaudio", 4: "tramp", 5: "msp", 255: "unknown" };
    return { deviceType: types[deviceType] ?? String(deviceType), ready: !!r.u8or(0), raw: [...p] };
}
