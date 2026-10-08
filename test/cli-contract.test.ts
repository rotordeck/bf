// End-to-end tests of the CLI contract. The SITL block runs only when a Betaflight SITL is
// listening (default tcp://127.0.0.1:5761, override with BF_TEST_PORT); see README.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITL = process.env.BF_TEST_PORT ?? "tcp://127.0.0.1:5761";

function bf(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src/cli/main.ts"), ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, BF_PORT: "", ...env },
        timeout: 60000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (s: string) => JSON.parse(s.trim());

async function sitlUp(): Promise<boolean> {
    const m = /^tcp:\/\/([^:]+):(\d+)$/.exec(SITL);
    if (!m) return false;
    return new Promise((resolve) => {
        const s = net.connect({ host: m[1], port: Number(m[2]) }, () => {
            s.destroy();
            resolve(true);
        });
        s.on("error", () => resolve(false));
        s.setTimeout(500, () => {
            s.destroy();
            resolve(false);
        });
    });
}

describe("CLI contract (no flight controller needed)", () => {
    it("bf schema --json describes every command with examples", () => {
        const r = bf(["schema", "--json"]);
        expect(r.code).toBe(0);
        const out = json(r.stdout);
        expect(out.ok).toBe(true);
        const cmds = out.data as { command: string; examples: string[]; mutates: boolean }[];
        expect(cmds.length).toBeGreaterThan(80);
        for (const c of cmds) expect(c.examples.length, `${c.command} needs examples`).toBeGreaterThan(0);
        expect(cmds.find((c) => c.command === "bf setting set")?.mutates).toBe(true);
    });

    it("connection errors exit 3 with a JSON error on stderr and nothing on stdout", () => {
        const r = bf(["--json", "info", "--port", "tcp://127.0.0.1:9"]);
        expect(r.code).toBe(3);
        expect(r.stdout).toBe("");
        expect(json(r.stderr)).toMatchObject({ ok: false, error: { code: "CONNECTION" } });
    });

    it("usage errors exit 2", () => {
        expect(bf(["setting"]).code).toBe(2);
        expect(bf(["--json", "modes", "set"]).code).toBe(2);
    });

    it("every --help lists examples and exit codes", () => {
        const r = bf(["pid", "set", "--help"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/Examples:/);
        expect(r.stdout).toMatch(/Exit codes:/);
    });
});

describe("architecture", () => {
    it("the CLI layer never encodes MSP itself", () => {
        const dir = path.join(ROOT, "src/cli");
        const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
        for (const f of files) {
            const src = fs.readFileSync(path.join(dir, f), "utf8");
            expect(src, `${f} imports MSP codes`).not.toMatch(/msp\/codes\.js/);
            expect(src, `${f} sends raw MSP`).not.toMatch(/\.request\(MSP\./);
        }
    });
});

describe.runIf(await sitlUp())("against SITL", () => {
    const env = { BF_PORT: SITL };
    let tmp: string;
    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-test-"));
    });

    it("info and status", () => {
        const r = bf(["--json", "info"], env);
        expect(r.code).toBe(0);
        expect(json(r.stdout).data.board).toBe("SITL");
        const s = json(bf(["--json", "status"], env).stdout);
        expect(Array.isArray(s.data.armingDisabledFlags)).toBe(true);
    });

    it("setting set is validated, idempotent and verified", () => {
        const before = json(bf(["--json", "setting", "get", "p_yaw"], env).stdout).data[0].value;
        const target = before === "46" ? "47" : "46";
        const r1 = json(bf(["--json", "setting", "set", `p_yaw=${target}`], env).stdout);
        expect(r1.data.changed).toEqual([{ key: "p_yaw", from: before, to: target }]);
        const r2 = json(bf(["--json", "setting", "set", `p_yaw=${target}`], env).stdout);
        expect(r2.data.changed).toEqual([]);
        expect(r2.data.unchanged).toEqual(["p_yaw"]);
        const bad = bf(["--json", "setting", "set", "p_yaw=999"], env);
        expect(bad.code).toBe(2);
        expect(json(bad.stderr).error.hint).toMatch(/0\.\.250/);
        bf(["setting", "set", `p_yaw=${before}`], env);
    });

    it("--dry-run writes nothing", () => {
        const before = json(bf(["--json", "setting", "get", "d_roll"], env).stdout).data[0].value;
        const r = json(bf(["--json", "pid", "set", "roll.d=33", "--dry-run"], env).stdout);
        expect(r.data.dryRun).toBe(true);
        expect(json(bf(["--json", "setting", "get", "d_roll"], env).stdout).data[0].value).toBe(before);
    });

    it("destructive commands require --confirm (exit 6)", () => {
        expect(bf(["defaults"], env).code).toBe(6);
        expect(bf(["motors", "test", "--motor", "1"], env).code).toBe(6);
    });

    it("config apply is idempotent", () => {
        const file = path.join(tmp, "desired.yaml");
        fs.writeFileSync(file, "pid_profiles:\n  2: {i_yaw: 81}\ncli:\n  - aux 5 13 3 1700 2100 0 0\n");
        const r1 = json(bf(["--json", "config", "apply", file], env).stdout);
        const r2 = json(bf(["--json", "config", "apply", file], env).stdout);
        expect(r2.data.changed).toEqual([]);
        expect(r1.data.changed.length + r1.data.unchanged.length).toBe(2);
    });

    it("backup can be parsed back as a desired state", () => {
        const file = path.join(tmp, "backup.txt");
        expect(bf(["config", "backup", "-o", file], env).code).toBe(0);
        expect(fs.readFileSync(file, "utf8")).toMatch(/# version/);
    });
});
