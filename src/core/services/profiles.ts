// PID / rate / battery profile selection, copy, reset and naming.

import type { Session } from "../session.js";
import { MSP, TextType } from "../msp/codes.js";
import * as M from "../msp/messages.js";
import { validationError } from "../errors.js";

export type ProfileKind = "pid" | "rate" | "battery";

const TEXT_TYPE: Record<ProfileKind, number> = {
    pid: TextType.PID_PROFILE_NAME,
    rate: TextType.RATE_PROFILE_NAME,
    battery: TextType.BATTERY_PROFILE_NAME,
};

export class ProfilesService {
    constructor(private readonly s: Session) {}

    async list(kind: ProfileKind) {
        const st = await this.s.status();
        const count = kind === "pid" ? st.pidProfileCount : kind === "rate" ? st.rateProfileCount : st.batteryProfileCount;
        const active = kind === "pid" ? st.pidProfile : kind === "rate" ? st.rateProfile : st.batteryProfile;
        const names: string[] = [];
        const setting = kind === "pid" ? "profile_name" : kind === "rate" ? "rateprofile_name" : "battery_profile_name";
        // Profile names are profile-scoped settings: read them from one dump.
        const dump = await this.s.cli.exec("dump all", { timeoutMs: 60000 });
        const section = kind === "pid" ? "profile" : kind === "rate" ? "rateprofile" : "battery_profile";
        let cur = -1;
        for (const line of dump.output.split("\n")) {
            const m = new RegExp(`^${section} (\\d+)$`).exec(line.trim());
            if (m) cur = Number(m[1]);
            const n = new RegExp(`^set ${setting} = (.*)$`).exec(line.trim());
            if (n && cur >= 0) names[cur] = n[1].trim() === "-" ? "" : n[1].trim();
        }
        return Array.from({ length: count ?? 0 }, (_, i) => ({ profile: i + 1, active: i + 1 === active, name: names[i] ?? "" }));
    }

    private async count(kind: ProfileKind): Promise<{ count: number; active: number }> {
        const st = await this.s.status();
        if (kind === "pid") return { count: st.pidProfileCount, active: st.pidProfile };
        if (kind === "rate") return { count: st.rateProfileCount ?? 0, active: st.rateProfile };
        return { count: st.batteryProfileCount ?? 0, active: st.batteryProfile ?? 1 };
    }

    private async check(kind: ProfileKind, profile: number) {
        const { count, active } = await this.count(kind);
        if (!Number.isInteger(profile) || profile < 1 || profile > count) throw validationError(`${kind} profile ${profile} does not exist`, `valid: 1..${count}`);
        return active;
    }

    /** Make `profile` (1-based) the active one and save the selection. */
    async select(kind: ProfileKind, profile: number, opts: { save?: boolean } = {}) {
        const active = await this.check(kind, profile);
        if (active === profile) return { changed: [], unchanged: [`${kind}_profile`], dryRun: false, saved: false };
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP_SELECT_SETTING, M.encodeSelectSetting(kind, profile - 1));
        const saved = opts.save === false ? undefined : await this.s.save();
        return { changed: [{ key: `${kind}_profile`, from: String(active), to: String(profile) }], unchanged: [], dryRun: false, saved: !!saved };
    }

    /** Run fn with `profile` temporarily active; the previous selection is restored afterwards. */
    async withProfile<T>(kind: ProfileKind, profile: number, fn: () => Promise<T>): Promise<T> {
        const active = await this.check(kind, profile);
        if (active === profile) return fn();
        await this.s.request(MSP.MSP_SELECT_SETTING, M.encodeSelectSetting(kind, profile - 1));
        try {
            return await fn();
        } finally {
            await this.s.request(MSP.MSP_SELECT_SETTING, M.encodeSelectSetting(kind, active - 1));
        }
    }

    async copy(kind: "pid" | "rate", from: number, to: number, opts: { dryRun?: boolean } = {}) {
        await this.check(kind, from);
        await this.check(kind, to);
        if (from === to) throw validationError("source and destination profile are the same");
        if (opts.dryRun) return { changed: [{ key: `${kind}_profile ${to}`, from: "(current)", to: `copy of ${from}` }], unchanged: [], dryRun: true, saved: false };
        await this.s.assertDisarmed();
        await this.s.request(MSP.MSP_COPY_PROFILE, M.encodeCopyProfile(kind, to - 1, from - 1));
        const saved = await this.s.save();
        return { changed: [{ key: `${kind}_profile ${to}`, from: "(previous)", to: `copy of ${from}` }], unchanged: [], dryRun: false, saved: true, rebootRequired: saved.rebootRequired };
    }

    /** Reset the given PID profile to defaults (MSP_SET_RESET_CURR_PID acts on the active one). */
    async resetPid(profile: number) {
        await this.check("pid", profile);
        await this.s.assertDisarmed();
        await this.withProfile("pid", profile, () => this.s.request(MSP.MSP_SET_RESET_CURR_PID));
        const saved = await this.s.save();
        return { changed: [{ key: `pid_profile ${profile}`, from: "(custom)", to: "defaults" }], unchanged: [], dryRun: false, saved: true, rebootRequired: saved.rebootRequired };
    }

    async rename(kind: ProfileKind, profile: number, name: string) {
        if (name.length > 8) throw validationError("profile names are at most 8 characters");
        await this.check(kind, profile);
        await this.s.assertDisarmed();
        const before = await this.withProfile(kind, profile, async () => {
            const cur = M.decodeText(await this.s.request(MSP.MSP2_GET_TEXT, M.encodeGetText(TEXT_TYPE[kind])));
            if (cur !== name) await this.s.request(MSP.MSP2_SET_TEXT, M.encodeSetText(TEXT_TYPE[kind], name));
            return cur;
        });
        if (before === name) return { changed: [], unchanged: [`${kind}_profile ${profile} name`], dryRun: false, saved: false };
        const saved = await this.s.save();
        return { changed: [{ key: `${kind}_profile ${profile} name`, from: before, to: name }], unchanged: [], dryRun: false, saved: true, rebootRequired: saved.rebootRequired };
    }
}
