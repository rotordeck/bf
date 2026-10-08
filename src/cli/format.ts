// Human-readable rendering of command results (stdout without --json).

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function scalar(v: unknown): string {
    if (v === null || v === undefined) return "-";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (Array.isArray(v)) return v.map(scalar).join(", ");
    if (isPlainObject(v)) return JSON.stringify(v);
    return String(v);
}

export function table(rows: Record<string, unknown>[], columns?: string[]): string {
    if (rows.length === 0) return "(none)";
    const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cells = rows.map((r) => cols.map((c) => scalar(r[c])));
    const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
    const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
    return [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)].join("\n");
}

function kv(obj: Record<string, unknown>, indent = ""): string[] {
    const lines: string[] = [];
    const width = Math.max(...Object.keys(obj).map((k) => k.length));
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (isPlainObject(v) && Object.keys(v).length) {
            lines.push(`${indent}${k}:`);
            lines.push(...kv(v, indent + "  "));
        } else if (Array.isArray(v) && v.length && v.every(isPlainObject)) {
            lines.push(`${indent}${k}:`);
            lines.push(...table(v as Record<string, unknown>[]).split("\n").map((l) => indent + "  " + l));
        } else {
            lines.push(`${indent}${k.padEnd(width)}  ${scalar(v)}`);
        }
    }
    return lines;
}

/** Render a WriteResult-shaped object as a change list. */
function changes(data: any): string | undefined {
    if (!isPlainObject(data) || !Array.isArray(data.changed) || !Array.isArray(data.unchanged)) return undefined;
    const lines: string[] = [];
    if (data.changed.length === 0) lines.push("no changes (already set)");
    for (const c of data.changed) lines.push(`${data.dryRun ? "would change" : "changed"}  ${c.key}: ${c.from} -> ${c.to}`);
    if (data.unchanged.length) lines.push(`unchanged: ${data.unchanged.join(", ")}`);
    if (data.saved) lines.push("saved to EEPROM");
    else if (!data.dryRun && data.changed.length) lines.push("NOT saved (RAM only) - run `bf save` to persist");
    if (data.rebootRequired) lines.push("reboot required for changes to take effect: run `bf reboot`");
    for (const [k, v] of Object.entries(data)) {
        if (["changed", "unchanged", "dryRun", "saved", "rebootRequired", "executed", "errors"].includes(k) || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        lines.push(`${k}: ${scalar(v)}`);
    }
    return lines.join("\n");
}

export function formatHuman(data: unknown): string {
    if (data === null || data === undefined) return "";
    if (typeof data === "string") return data;
    const ch = changes(data);
    if (ch !== undefined) return ch;
    if (Array.isArray(data)) {
        if (data.every(isPlainObject)) return table(data as Record<string, unknown>[]);
        return data.map(scalar).join("\n");
    }
    if (isPlainObject(data)) return kv(data).join("\n");
    return scalar(data);
}
