// build.betaflight.com client (port of betaflight-configurator src/js/BuildApi.js and the
// request/poll logic of src/composables/useCloudBuild.ts).

import { BfError, ExitCode, validationError } from "../errors.js";

const BASE = process.env.BF_BUILD_API ?? "https://build.betaflight.com";
const UA = { "X-CFG-VER": "bf-cli", "User-Agent": "bf-cli" };

async function get<T>(path: string): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${BASE}${path}`, { headers: UA });
    } catch (e: any) {
        throw new BfError("NETWORK", `cannot reach ${BASE}: ${e.message}`, ExitCode.CONNECTION);
    }
    if (res.status === 404) throw validationError(`not found: ${path}`, "check the target/release name with `bf firmware targets` / `bf firmware releases`");
    if (!res.ok) throw new BfError("BUILD_API", `build server returned HTTP ${res.status} for ${path}`, ExitCode.GENERAL);
    return (await res.json()) as T;
}

export interface Target {
    target: string;
    manufacturer: string;
    mcu: string;
    group?: string;
}
export interface Release {
    release: string;
    type: "Stable" | "ReleaseCandidate" | "Unstable" | string;
    date: string;
    cloudBuild: boolean;
    withdrawn: boolean;
}
export interface BuildOption {
    name: string;
    value: string;
    default: boolean;
}
export interface BuildOptions {
    radioProtocols: BuildOption[];
    telemetryProtocols: BuildOption[];
    motorProtocols: BuildOption[];
    generalOptions: BuildOption[];
    osdProtocols?: BuildOption[];
}

export const BuildApi = {
    targets: () => get<Target[]>("/api/targets"),
    target: (target: string) => get<{ target: string; manufacturer: string; releases: Release[] }>(`/api/targets/${encodeURIComponent(target)}`),
    options: (release: string) => get<BuildOptions>(`/api/options/${encodeURIComponent(release)}`),
    status: (key: string) => get<{ status: string; timeOut?: number; configuration?: string[] }>(`/api/builds/${key}/status`),

    async requestBuild(req: { target: string; release: string; options: string[]; commit?: string }) {
        const res = await fetch(`${BASE}/api/builds`, { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(req) });
        if (![200, 201, 202].includes(res.status)) {
            throw new BfError("BUILD_REQUEST", `build request rejected (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`, ExitCode.VALIDATION);
        }
        return (await res.json()) as { key: string; url: string; file: string };
    },

    async download(path: string): Promise<Uint8Array> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, { headers: UA });
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
            await new Promise((r) => setTimeout(r, 4000));
        }
        throw new BfError("DOWNLOAD", `firmware download failed: ${path}`, ExitCode.CONNECTION);
    },

    logUrl: (key: string) => `${BASE}/api/builds/${key}/log`,
};

/**
 * Resolve the build option list the way Configurator does: CLOUD_BUILD plus the selected
 * radio/telemetry/OSD/motor protocols and general options (by name or define), falling back to
 * the server defaults per category when nothing was chosen.
 */
export function resolveBuildOptions(all: BuildOptions, wanted: string[], opts: { core?: boolean; noDefaults?: boolean } = {}): string[] {
    if (opts.core) return ["CORE_BUILD"];
    const flat = Object.values(all).flat() as BuildOption[];
    const picked = new Set<string>();
    for (const w of wanted) {
        const hit = flat.find((o) => o.value.toLowerCase() === w.toLowerCase() || o.name.toLowerCase() === w.toLowerCase());
        if (!hit) throw validationError(`unknown build option '${w}'`, `see \`bf firmware options <release>\``);
        picked.add(hit.value);
    }
    if (!opts.noDefaults) {
        for (const list of Object.values(all) as BuildOption[][]) {
            if (!list.some((o) => picked.has(o.value))) for (const o of list) if (o.default) picked.add(o.value);
        }
    }
    return ["CLOUD_BUILD", ...picked];
}

export async function cloudBuild(
    req: { target: string; release: string; options: string[]; commit?: string },
    progress: (m: string) => void,
    timeoutS = 300,
) {
    const resp = await BuildApi.requestBuild(req);
    progress(`build ${resp.key} requested`);
    const until = Date.now() + timeoutS * 1000;
    let status = await BuildApi.status(resp.key);
    while (status.status === "queued" && Date.now() < until) {
        progress(`build ${resp.key}: ${status.status}...`);
        await new Promise((r) => setTimeout(r, 5000));
        status = await BuildApi.status(resp.key);
    }
    if (status.status !== "success") {
        throw new BfError("BUILD_FAILED", `cloud build ${resp.key} ended with status '${status.status}'`, ExitCode.GENERAL, `log: ${BuildApi.logUrl(resp.key)}`);
    }
    return { ...resp, configuration: status.configuration, log: BuildApi.logUrl(resp.key) };
}
