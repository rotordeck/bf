import { describe, it, expect } from "vitest";
import { parseGetOutput } from "../src/core/services/settings.js";
import { parseDump, dedupeSetLines, lineKeyLength, parseDesired, cliLines, normLine } from "../src/core/services/config.js";
import { parseRange, parseAuxChannel, functionsFromMask } from "../src/core/services/lists.js";
import { presetCli } from "../src/core/net/presets.js";
import { parseHex } from "../src/core/flash/hex.js";
import { parseDfuLayout } from "../src/core/flash/dfu.js";
import { decodePos, encodePos } from "../src/core/services/osd.js";
import { resolveBuildOptions } from "../src/core/net/buildapi.js";

describe("CLI text parsing", () => {
    it("parses `get` output with scope, range, allowed values and defaults", () => {
        const out = parseGetOutput(
            ["p_roll = 48", "profile 0", "Allowed range: 0 - 250", "Default value: 45", "", "gyro_lpf1_type = PT1", "Allowed values: PT1, BIQUAD, PT2, PT3", "", "motor_output_reordering = 0,1,2,3,4,5,6,7", "Array length: 8"].join("\r\n"),
        );
        expect(out).toEqual([
            { name: "p_roll", value: "48", scope: "pid_profile", range: "0..250", default: "45" },
            { name: "gyro_lpf1_type", value: "PT1", scope: "global", allowed: ["PT1", "BIQUAD", "PT2", "PT3"] },
            { name: "motor_output_reordering", value: "0,1,2,3,4,5,6,7", scope: "global", arrayLength: 8 },
        ]);
    });

    it("parses a dump into sections, features and command lines", () => {
        const snap = parseDump(
            [
                "# version",
                "batch start",
                "feature -GPS",
                "feature -AIRMODE",
                "feature AIRMODE",
                "aux 0 0 0 1700 2100 0 0",
                "set motor_pwm_protocol = DSHOT600",
                "profile 0",
                "set p_roll = 45",
                "profile 1",
                "set p_roll = 50",
                "rateprofile 0",
                "set roll_srate = 67",
                "save",
            ].join("\n"),
        );
        expect(snap.global).toEqual({ motor_pwm_protocol: "DSHOT600" });
        expect(snap.pidProfiles).toEqual([{ p_roll: "45" }, { p_roll: "50" }]);
        expect(snap.rateProfiles).toEqual([{ roll_srate: "67" }]);
        expect(snap.features).toEqual({ GPS: false, AIRMODE: true });
        expect(snap.commands.aux).toEqual(["aux 0 0 0 1700 2100 0 0"]);
    });

    it("drops batch/save/exit and comments from CLI text", () => {
        expect(cliLines("# hi\nbatch start\nset a = 1\nsave\nexit\nbatch end\n")).toEqual(["set a = 1"]);
    });

    it("keeps only the last assignment of a setting per profile context", () => {
        const lines = ["set a = 1", "profile 0", "set p = 1", "set p = 2", "profile 1", "set p = 3", "set a = 2"];
        // `a` is assigned in two different profile contexts, so both lines survive (order decides)
        expect(dedupeSetLines(lines)).toEqual(["set a = 1", "profile 0", "set p = 2", "profile 1", "set p = 3", "set a = 2"]);
    });

    it("knows which tokens identify a CLI line", () => {
        const k = (l: string) => normLine(l).split(" ").slice(0, lineKeyLength(normLine(l).split(" "))).join(" ");
        expect(k("aux 3 0 0 1700 2100 0 0")).toBe("aux 3");
        expect(k("serial UART2 64 115200 57600 0 115200")).toBe("serial uart2");
        expect(k("vtxtable band 2 BOSCAM_B B FACTORY 1 2")).toBe("vtxtable band 2");
        expect(k("vtxtable powervalues 1 2 3")).toBe("vtxtable powervalues");
        expect(k("map TAER1234")).toBe("map");
    });
});

describe("desired-state files", () => {
    it("turns YAML into ordered CLI lines with 1-based profiles", () => {
        const lines = parseDesired(
            "settings:\n  dshot_bidir: ON\npid_profiles:\n  2: {p_roll: 50}\nfeatures:\n  GPS: false\ncli:\n  - map TAER1234\n",
            "quad.yaml",
        );
        expect(lines).toEqual(["feature -GPS", "set dshot_bidir = ON", "profile 1", "set p_roll = 50", "map TAER1234"]);
    });

    it("accepts plain CLI text and rejects unknown keys", () => {
        expect(parseDesired("set a = 1\n# c\nfeature GPS\n")).toEqual(["set a = 1", "feature GPS"]);
        expect(() => parseDesired('{"setting": {"a": 1}}', "x.json")).toThrow(/unknown top-level keys/);
    });
});

describe("modes and ports", () => {
    it("parses and snaps ranges", () => {
        expect(parseRange("1700-2100")).toEqual([1700, 2100]);
        expect(parseRange("1290..1710")).toEqual([1300, 1700]);
        expect(() => parseRange("2100-1700")).toThrow();
        expect(parseAuxChannel("AUX1")).toBe(0);
        expect(parseAuxChannel(4)).toBe(3);
        expect(() => parseAuxChannel("AUX21")).toThrow();
    });

    it("decodes serial function masks", () => {
        expect(functionsFromMask(64)).toEqual(["RX_SERIAL"]);
        expect(functionsFromMask(1 | 2048)).toEqual(["MSP", "VTX_SMARTAUDIO"]);
    });
});

describe("presets", () => {
    const lines = [
        "#$ TITLE: test",
        "set a = 1",
        "#$ OPTION BEGIN (CHECKED): Default option",
        "set b = 1",
        "#$ OPTION END",
        "#$ OPTION_GROUP BEGIN (EXCLUSIVE): Power",
        "#$ OPTION BEGIN (UNCHECKED): Low",
        "set p = 25",
        "#$ OPTION END",
        "#$ OPTION BEGIN (CHECKED): High",
        "set p = 400",
        "#$ OPTION END",
        "#$ OPTION_GROUP END",
        "# comment",
    ];
    const options = [
        { name: "Default option", checked: true },
        { name: "Low", checked: false, group: "Power", exclusive: true },
        { name: "High", checked: true, group: "Power", exclusive: true },
    ];

    it("applies default options", () => {
        expect(presetCli(lines, options).cli).toEqual(["set a = 1", "set b = 1", "set p = 400"]);
    });

    it("exclusive groups switch, --without removes, unknown options fail", () => {
        expect(presetCli(lines, options, ["low"], ["Default option"]).cli).toEqual(["set a = 1", "set p = 25"]);
        expect(() => presetCli(lines, options, ["nope"])).toThrow(/no option/);
    });
});

describe("firmware images", () => {
    it("parses Intel HEX with extended linear address", () => {
        const rec = (s: string) => {
            const b = Buffer.from(s, "hex");
            const sum = (0x100 - (b.reduce((a, x) => a + x, 0) & 0xff)) & 0xff;
            return ":" + s.toUpperCase() + sum.toString(16).padStart(2, "0").toUpperCase();
        };
        const hex = [rec("020000040800"), rec("0400000001020304"), rec("0200040005 06".replace(" ", "")), rec("00000001")].join("\n");
        const img = parseHex(hex);
        expect(img.startAddress).toBe(0x08000000);
        expect(img.blocks).toHaveLength(1);
        expect([...img.blocks[0].data]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(() => parseHex(":0400000001020304FF\n")).toThrow(/checksum/);
    });

    it("parses DfuSe flash layouts", () => {
        const l = parseDfuLayout("@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg")!;
        expect(l.totalSize).toBe(1024 * 1024);
        expect(l.sectors[1]).toEqual({ start: 0x08010000, size: 65536, count: 1 });
    });

    it("resolves build options with per-category defaults", () => {
        const all = {
            radioProtocols: [
                { name: "CRSF", value: "USE_SERIALRX_CRSF", default: true },
                { name: "SBUS", value: "USE_SERIALRX_SBUS", default: false },
            ],
            telemetryProtocols: [{ name: "CRSF", value: "USE_TELEMETRY_CRSF", default: true }],
            motorProtocols: [{ name: "DSHOT", value: "USE_DSHOT", default: true }],
            generalOptions: [{ name: "GPS", value: "USE_GPS", default: false }],
        };
        expect(resolveBuildOptions(all, ["sbus", "USE_GPS"])).toEqual(["CLOUD_BUILD", "USE_SERIALRX_SBUS", "USE_GPS", "USE_TELEMETRY_CRSF", "USE_DSHOT"]);
        expect(resolveBuildOptions(all, [], { core: true })).toEqual(["CORE_BUILD"]);
    });
});

describe("OSD positions", () => {
    it("matches the firmware OSD_POS encoding", () => {
        // osd_vbat_pos = 6529 on the test board: x=1, y=12, profiles 1 and 2
        expect(decodePos(6529)).toEqual({ x: 1, y: 12, profiles: [1, 2], variant: 0 });
        expect(encodePos(1, 12, [1, 2], 0)).toBe(6529);
        // HD x range uses bit 10
        expect(decodePos(encodePos(40, 3, [1], 1))).toEqual({ x: 40, y: 3, profiles: [1], variant: 1 });
    });
});
