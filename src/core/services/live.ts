// Live data, calibration, motor test and other MSP actions (Setup / Sensors / Motors tabs).

import type { Session } from "../session.js";
import { MSP, TextType } from "../msp/codes.js";
import * as M from "../msp/messages.js";
import { BfError, ExitCode, refusedError, validationError } from "../errors.js";

export const TELEMETRY_KINDS = ["attitude", "imu", "altitude", "rc", "motors", "battery", "analog", "gps", "esc", "status"] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveService {
    constructor(private readonly s: Session) {}

    async read(kind: TelemetryKind): Promise<unknown> {
        switch (kind) {
            case "attitude":
                return M.decodeAttitude(await this.s.request(MSP.MSP_ATTITUDE));
            case "imu":
                return M.decodeRawImu(await this.s.request(MSP.MSP_RAW_IMU));
            case "altitude":
                return M.decodeAltitude(await this.s.request(MSP.MSP_ALTITUDE));
            case "rc": {
                const ch = M.decodeRc(await this.s.request(MSP.MSP_RC));
                // MSP_RC reports channels after mapping, i.e. always in AETR order
                return { roll: ch[0], pitch: ch[1], yaw: ch[2], throttle: ch[3], ...Object.fromEntries(ch.slice(4).map((v, i) => [`aux${i + 1}`, v])) };
            }
            case "motors":
                return M.decodeMotor(await this.s.request(MSP.MSP_MOTOR));
            case "battery":
                return M.decodeBatteryState(await this.s.request(MSP.MSP_BATTERY_STATE));
            case "analog":
                return M.decodeAnalog(await this.s.request(MSP.MSP_ANALOG));
            case "gps": {
                const raw = M.decodeRawGps(await this.s.request(MSP.MSP_RAW_GPS));
                const comp = M.decodeCompGps(await this.s.request(MSP.MSP_COMP_GPS));
                return { ...raw, ...comp };
            }
            case "esc":
                return M.decodeMotorTelemetry(await this.s.request(MSP.MSP_MOTOR_TELEMETRY));
            case "status":
                return this.s.status();
        }
    }

    async gpsSatellites() {
        return M.decodeGpsSvInfo(await this.s.request(MSP.MSP_GPSSVINFO));
    }

    /** Poll `kind` every `intervalMs` until `stop()` returns true or `count` samples are taken. */
    async watch(kind: TelemetryKind, opts: { intervalMs: number; count?: number; stop: () => boolean }, onSample: (s: { t: number; kind: string; data: unknown }) => void) {
        const t0 = Date.now();
        for (let i = 0; opts.count === undefined || i < opts.count; i++) {
            if (opts.stop()) break;
            const started = Date.now();
            onSample({ t: Date.now() - t0, kind, data: await this.read(kind) });
            const left = opts.intervalMs - (Date.now() - started);
            if (left > 0) await sleep(left);
        }
    }

    // ---------- calibration ----------

    async calibrateAcc() {
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP_ACC_CALIBRATION);
        // firmware calibrates over ~2 s (400 samples); the CALIB arming flag is set while it runs
        await sleep(2500);
        for (let i = 0; i < 20; i++) {
            const st = await this.s.status();
            if (!st.armingDisabledFlags.includes("CALIB")) {
                const saved = await this.s.save();
                return { calibrated: "acc", saved: saved.saved, armingDisabledFlags: st.armingDisabledFlags };
            }
            await sleep(500);
        }
        throw new BfError("CALIBRATION_TIMEOUT", "accelerometer calibration did not finish", ExitCode.GENERAL, "keep the craft level and still, then retry");
    }

    async calibrateMag(progress: (msg: string) => void, durationS = 30) {
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP_MAG_CALIBRATION);
        progress(`magnetometer calibration running for ${durationS}s: rotate the craft through all orientations`);
        await sleep(durationS * 1000);
        const saved = await this.s.save();
        return { calibrated: "mag", saved: saved.saved };
    }

    // ---------- motor test ----------

    /**
     * Spin motors via MSP_SET_MOTOR (Configurator Motors tab). Values are in the external
     * range 1000 (stop) .. 2000. Arming over MSP is blocked first (MSP_SET_ARMING_DISABLED),
     * and motors are always stopped afterwards, also on error or interrupt.
     */
    async motorTest(opts: { motors: number[]; value: number; durationMs: number; maxValue: number; stop: () => boolean; progress: (m: string) => void }) {
        if (opts.value < 1000 || opts.value > 2000) throw validationError("--value must be 1000..2000");
        if (opts.value > opts.maxValue) throw validationError(`--value ${opts.value} exceeds the safety limit ${opts.maxValue}`, "raise it explicitly with --max-value");
        if (opts.durationMs <= 0 || opts.durationMs > 30000) throw validationError("--duration must be between 0 and 30s");
        const st = await this.s.assertDisarmed();
        // MSP_MOTOR reports 0 for outputs that are not in use by the mixer
        const count = M.decodeMotor(await this.s.request(MSP.MSP_MOTOR)).filter((v) => v > 0).length;
        for (const m of opts.motors) if (m < 1 || m > count) throw validationError(`motor ${m} does not exist (1..${count})`);
        const stopAll = M.encodeSetMotor(Array(8).fill(1000));
        await this.s.request(MSP.MSP_SET_ARMING_DISABLED, M.encodeArmingDisabled(true, true));
        try {
            const values = Array.from({ length: 8 }, (_, i) => (opts.motors.includes(i + 1) ? opts.value : 1000));
            opts.progress(`spinning motor(s) ${opts.motors.join(",")} at ${opts.value} for ${opts.durationMs} ms`);
            const until = Date.now() + opts.durationMs;
            // Re-send periodically so a dropped frame cannot leave a stale value.
            while (Date.now() < until && !opts.stop()) {
                await this.s.request(MSP.MSP_SET_MOTOR, M.encodeSetMotor(values));
                await sleep(Math.min(100, Math.max(0, until - Date.now())));
            }
            const readback = M.decodeMotor(await this.s.request(MSP.MSP_MOTOR));
            return { motors: opts.motors, value: opts.value, durationMs: opts.durationMs, interrupted: opts.stop(), lastOutputs: readback, armingDisabledFlagsBefore: st.armingDisabledFlags };
        } finally {
            await this.s.request(MSP.MSP_SET_MOTOR, stopAll).catch(() => undefined);
            await this.s.request(MSP.MSP_SET_MOTOR, stopAll).catch(() => undefined);
            await this.s.request(MSP.MSP_SET_ARMING_DISABLED, M.encodeArmingDisabled(false, false)).catch(() => undefined);
            opts.progress("motors stopped");
        }
    }

    /** Send DShot commands (spin direction etc.) to one motor (1-based) or all (0). */
    async dshotCommand(motor: number, commands: number[]) {
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP2_SEND_DSHOT_COMMAND, M.encodeDshotCommand(motor === 0 ? 255 : motor - 1, commands, true));
    }

    async motorReordering() {
        return M.decodeMotorReordering(await this.s.request(MSP.MSP2_MOTOR_OUTPUT_REORDERING));
    }

    // ---------- names ----------

    async names() {
        const get = async (t: number) => M.decodeText(await this.s.request(MSP.MSP2_GET_TEXT, M.encodeGetText(t)));
        return { craftName: await get(TextType.CRAFT_NAME), pilotName: await get(TextType.PILOT_NAME) };
    }

    /** Idempotent craft/pilot name update (max 16 characters each). */
    async setNames(names: { craftName?: string; pilotName?: string }) {
        const before = await this.names();
        const changed: { key: string; from: string; to: string }[] = [];
        const unchanged: string[] = [];
        const types = { craftName: TextType.CRAFT_NAME, pilotName: TextType.PILOT_NAME } as const;
        for (const key of ["craftName", "pilotName"] as const) {
            const val = names[key];
            if (val === undefined) continue;
            if (val.length > 16) throw validationError(`${key} is at most 16 characters`);
            if (before[key] === val) unchanged.push(key);
            else changed.push({ key, from: before[key], to: val });
        }
        if (changed.length) {
            await this.s.assertDisarmed();
            for (const c of changed) await this.s.request(MSP.MSP2_SET_TEXT, M.encodeSetText(types[c.key as keyof typeof types], c.to));
            await this.s.save();
        }
        return { changed, unchanged, dryRun: false, saved: changed.length > 0 };
    }

    // ---------- receiver ----------

    async bind() {
        if (!this.s.identity.boardInfo.capabilities.rxBind) throw refusedError("this flight controller/receiver does not support binding from the FC", "bind from the receiver or use `bf cli exec bind_rx`");
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP2_BETAFLIGHT_BIND);
        return { binding: true };
    }

    async syncRtc() {
        await this.s.request(MSP.MSP_SET_RTC, M.encodeRtc());
        return { rtc: new Date().toISOString() };
    }

    // ---------- reset ----------

    async resetToDefaults() {
        await this.s.assertDisarmed();
        const reply = await this.s.request(MSP.MSP_RESET_CONF, [0], { timeoutMs: 5000 });
        if (reply.length && reply[0] === 0) throw refusedError("flight controller refused to reset the configuration");
        await this.s.close();
        return { reset: true, rebooting: true };
    }
}
