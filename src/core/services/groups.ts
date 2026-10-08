// Configuration areas (Configurator tabs) as groups of named settings.
//
// Membership is by name pattern + scope, resolved against what the connected firmware
// actually has (from one `dump all`), so new or build-specific settings appear without a
// code change and missing ones are simply absent.

import type { Session } from "../session.js";
import { ConfigService, type Snapshot } from "./config.js";
import { SettingsService, type WriteResult } from "./settings.js";
import { ProfilesService, type ProfileKind } from "./profiles.js";
import { validationError } from "../errors.js";

export type Scope = "global" | "pid_profile" | "rate_profile" | "battery_profile";

export interface GroupSpec {
    name: string;
    title: string;
    /** Configurator tab this mirrors */
    tab: string;
    match: RegExp;
    exclude?: RegExp;
    /** restrict to settings of this scope (undefined = any scope) */
    scope?: Scope;
    /** friendly alias -> setting name */
    aliases?: Record<string, string>;
}

const axes = ["roll", "pitch", "yaw"] as const;
const pidAliases: Record<string, string> = {};
for (const a of axes) {
    for (const t of ["p", "i", "d", "f"]) pidAliases[`${a}.${t}`] = `${t}_${a}`;
    pidAliases[`${a}.dmax`] = `d_max_${a}`;
    pidAliases[`${a}.s`] = `s_${a}`;
}
const rateAliases: Record<string, string> = {};
for (const a of axes) {
    rateAliases[`${a}.rc_rate`] = `${a}_rc_rate`;
    rateAliases[`${a}.rate`] = `${a}_srate`;
    rateAliases[`${a}.expo`] = `${a}_expo`;
    rateAliases[`${a}.limit`] = `${a}_rate_limit`;
}

const FILTERS = /^(gyro_(lpf|notch|hardware_lpf)|dterm_(lpf|notch)|dyn_notch_|rpm_filter_|yaw_lowpass_hz)/;

export const GROUPS: GroupSpec[] = [
    { name: "pid", title: "PID gains", tab: "PID Tuning", scope: "pid_profile", match: /^([pidfs]_(roll|pitch|yaw)|d_max_(roll|pitch|yaw))$/, aliases: pidAliases },
    { name: "tuning", title: "Simplified tuning sliders", tab: "PID Tuning > Sliders", match: /^simplified_/ },
    { name: "filters", title: "Gyro and D-term filters", tab: "PID Tuning > Filter Settings", match: FILTERS },
    {
        name: "pid-advanced",
        title: "Advanced per-profile PID settings (anti-gravity, I-term relax, feedforward, TPA, dynamic idle, ...)",
        tab: "PID Tuning > PID Profile Settings",
        scope: "pid_profile",
        match: /./,
        exclude: new RegExp(`(^([pidfs]_(roll|pitch|yaw)|d_max_(roll|pitch|yaw))$|^simplified_|${FILTERS.source})`),
    },
    { name: "rates", title: "Rates and expo", tab: "PID Tuning > Rateprofile Settings", scope: "rate_profile", match: /./, aliases: rateAliases },
    {
        name: "receiver",
        title: "Receiver, channel limits, RSSI, RC smoothing",
        tab: "Receiver",
        match: /^(serialrx_|rx_|rssi_|rc_smoothing|deadband$|yaw_deadband$|max_aux_channels|mid_rc|min_check|max_check|spektrum|sbus_|srxl2_|crsf_use|expresslrs_|cc2500|frsky_spi|flysky|channel_forwarding|input_filtering|airmode_start|msp_override)/,
    },
    { name: "failsafe", title: "Failsafe", tab: "Failsafe", match: /^failsafe_/ },
    { name: "gps-rescue", title: "GPS Rescue", tab: "Failsafe > GPS Rescue", match: /^gps_rescue_/ },
    { name: "gps", title: "GPS receiver", tab: "GPS", match: /^gps_(?!rescue_)/ },
    { name: "autopilot", title: "Altitude/position hold and autopilot", tab: "Configuration", match: /^(ap_|alt_hold_|pos_hold_|poshold_|launch_)/ },
    {
        name: "power",
        title: "Battery, voltage and current meters",
        tab: "Power & Battery",
        match: /^(vbat_|ibat|bat_capacity|battery_|current_meter|cbat_|use_vbat|use_cbat|force_battery_cell_count|report_cell_voltage|auto_profile_cell_count)/,
    },
    {
        name: "motors",
        title: "Mixer, ESC/motor protocol, idle, 3D",
        tab: "Motors",
        match: /^(motor_|dshot_|mixer_type|min_command|max_throttle|use_unsynced_pwm|3d_|yaw_motors_reversed|esc_sensor_|rpm_limit|thr_corr)/,
    },
    {
        name: "arming",
        title: "Arming and safety",
        tab: "Configuration",
        match: /^(small_angle|auto_disarm_delay|enable_stick_arming|gyro_cal_on_first_arm|prearm_allow_rearm|pwr_on_arm_grace|runaway_takeoff|crashflip_|landing_disarm)/,
    },
    {
        name: "system",
        title: "System, scheduler, loop rates, names",
        tab: "Configuration",
        match: /^(pid_process_denom|cpu_|task_statistics|scheduler_|imu_|serial_update_rate|usb_|system_hse|debug_mode|timezone|craft_name|pilot_name|reboot_character|mco)/,
    },
    {
        name: "sensors",
        title: "Sensor hardware and alignment",
        tab: "Configuration / Sensors",
        match: /^(acc_|align_|mag_|baro_|gyro_(?!lpf|notch|hardware_lpf)|rangefinder_|opticalflow_|pitot_|altitude_)/,
    },
    { name: "osd", title: "OSD", tab: "OSD", match: /^(osd_|displayport_|vcd_|max7456_)/ },
    { name: "vtx", title: "Video transmitter", tab: "Video Transmitter", match: /^vtx_/ },
    { name: "led", title: "LED strip options", tab: "LED Strip", match: /^(ledstrip_|led_)/ },
    { name: "blackbox", title: "Blackbox logging", tab: "Blackbox", match: /^blackbox_/ },
    { name: "beeper", title: "Beeper hardware and DShot beacon", tab: "Configuration", match: /^beeper_/ },
    { name: "telemetry-config", title: "Telemetry", tab: "Configuration / Receiver", match: /^(telemetry_|tlm_|frsky_(?!spi)|hott_|mavlink_|crsf_tlm|pid_in_tlm|ibus_sensor)/ },
    { name: "serial", title: "UART function and baud assignment", tab: "Ports", match: /(_uart|_baud|^serialmsp_halfduplex|_halfduplex|_inverted)$/ },
    { name: "servos", title: "Servos and gimbal", tab: "Servos", match: /^(servo_|gimbal_|tri_)/ },
];

export const groupByName = (n: string) => GROUPS.find((g) => g.name === n);

export function scopeOf(snap: Snapshot, name: string): Scope {
    if (snap.pidProfiles[0] && name in snap.pidProfiles[0]) return "pid_profile";
    if (snap.rateProfiles[0] && name in snap.rateProfiles[0]) return "rate_profile";
    if (snap.batteryProfiles[0] && name in snap.batteryProfiles[0]) return "battery_profile";
    return "global";
}

export function groupMembers(g: GroupSpec, snap: Snapshot): { name: string; scope: Scope }[] {
    const all: { name: string; scope: Scope }[] = [
        ...Object.keys(snap.global).map((n) => ({ name: n, scope: "global" as Scope })),
        ...Object.keys(snap.pidProfiles[0] ?? {}).map((n) => ({ name: n, scope: "pid_profile" as Scope })),
        ...Object.keys(snap.rateProfiles[0] ?? {}).map((n) => ({ name: n, scope: "rate_profile" as Scope })),
        ...Object.keys(snap.batteryProfiles[0] ?? {}).map((n) => ({ name: n, scope: "battery_profile" as Scope })),
    ];
    return all.filter((s) => g.match.test(s.name) && !g.exclude?.test(s.name) && (!g.scope || g.scope === s.scope));
}

const PROFILE_KIND: Record<Exclude<Scope, "global">, ProfileKind> = { pid_profile: "pid", rate_profile: "rate", battery_profile: "battery" };

export class GroupsService {
    private config: ConfigService;
    private settings: SettingsService;
    private profiles: ProfilesService;
    constructor(private readonly s: Session) {
        this.config = new ConfigService(s);
        this.settings = new SettingsService(s);
        this.profiles = new ProfilesService(s);
    }

    /**
     * Values of a group. Profile-scoped values come from the active profile unless
     * `profile` (1-based) is given; `allProfiles` returns every profile.
     */
    async get(group: GroupSpec, opts: { profile?: number; allProfiles?: boolean } = {}) {
        const snap = await this.config.snapshot();
        const status = await this.s.status();
        const members = groupMembers(group, snap);
        const pick = (scope: Scope, idx0: number) =>
            Object.fromEntries(
                members
                    .filter((m) => m.scope === scope)
                    .map((m) => {
                        const src = scope === "global" ? snap.global : scope === "pid_profile" ? snap.pidProfiles[idx0] : scope === "rate_profile" ? snap.rateProfiles[idx0] : snap.batteryProfiles[idx0];
                        return [m.name, src?.[m.name]];
                    }),
            );
        const activeIdx: Record<Exclude<Scope, "global">, number> = {
            pid_profile: status.pidProfile,
            rate_profile: status.rateProfile,
            battery_profile: status.batteryProfile ?? 1,
        };
        const scopes = [...new Set(members.map((m) => m.scope))];
        const out: Record<string, unknown> = {};
        if (scopes.includes("global")) out.settings = pick("global", 0);
        for (const sc of scopes.filter((x): x is Exclude<Scope, "global"> => x !== "global")) {
            const count = sc === "pid_profile" ? snap.pidProfiles.length : sc === "rate_profile" ? snap.rateProfiles.length : snap.batteryProfiles.length;
            this.checkProfile(opts.profile, count);
            if (opts.allProfiles) {
                out[`${sc}s`] = Array.from({ length: count }, (_, i) => ({ profile: i + 1, active: i + 1 === activeIdx[sc], values: pick(sc, i) }));
            } else {
                const p = opts.profile ?? activeIdx[sc];
                out[sc] = { profile: p, active: p === activeIdx[sc], values: pick(sc, p - 1) };
            }
        }
        if (group.aliases) out.aliases = group.aliases;
        return out;
    }

    private checkProfile(p: number | undefined, count: number) {
        if (p !== undefined && (p < 1 || p > count)) throw validationError(`profile ${p} does not exist`, `valid profiles: 1..${count}`);
    }

    /** Resolve aliases and check that every key belongs to the group. */
    async resolve(group: GroupSpec, values: Record<string, string>) {
        const snap = await this.config.snapshot();
        const members = new Map(groupMembers(group, snap).map((m) => [m.name, m.scope]));
        const resolved: Record<string, string> = {};
        const scopes = new Set<Scope>();
        for (const [k, v] of Object.entries(values)) {
            const name = group.aliases?.[k.toLowerCase()] ?? k.toLowerCase();
            const scope = members.get(name);
            if (!scope) {
                const exists = name in snap.global || scopeOf(snap, name) !== "global";
                throw validationError(
                    exists ? `'${name}' is not part of the ${group.name} group` : `unknown setting '${k}' in ${group.name}`,
                    exists ? `use \`bf setting set ${name}=${v}\`` : `see \`bf ${group.name} get\` for valid names${group.aliases ? " or aliases like " + Object.keys(group.aliases).slice(0, 3).join(", ") : ""}`,
                );
            }
            resolved[name] = v;
            scopes.add(scope);
        }
        return { resolved, scopes, snap };
    }

    async set(group: GroupSpec, values: Record<string, string>, opts: { profile?: number; dryRun?: boolean; save?: boolean } = {}): Promise<WriteResult & { profile?: number }> {
        const { resolved, scopes, snap } = await this.resolve(group, values);
        const profileScopes = [...scopes].filter((x): x is Exclude<Scope, "global"> => x !== "global");
        if (opts.profile !== undefined) {
            if (profileScopes.length === 0) throw validationError("--profile only applies to profile-scoped settings");
            if (profileScopes.length > 1) throw validationError("cannot mix pid/rate/battery profile settings with --profile in one call");
            const sc = profileScopes[0];
            const count = sc === "pid_profile" ? snap.pidProfiles.length : sc === "rate_profile" ? snap.rateProfiles.length : snap.batteryProfiles.length;
            this.checkProfile(opts.profile, count);
            const res = await this.profiles.withProfile(PROFILE_KIND[sc], opts.profile, () => this.settings.set(resolved, { ...opts, save: false }));
            if (opts.dryRun || res.changed.length === 0 || opts.save === false) return { ...res, profile: opts.profile };
            const saved = await this.s.save();
            return { ...res, saved: true, rebootRequired: saved.rebootRequired, profile: opts.profile };
        }
        return this.settings.set(resolved, opts);
    }
}
