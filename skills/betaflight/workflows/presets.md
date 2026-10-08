# Presets

**Goal:** apply community presets (tunes, rates, filters, VTX tables, OSD layouts, BNF configs).

**Tools:** `bf presets search/show/apply/sources`.

## Workflow
1. **Search, filtered to the FC's firmware:** `bf presets search <keywords> --category <CAT> --firmware <x.y> --json`. Get the version from `bf info --json` → `data.version` (e.g. `2025.12`, `4.5`).
2. **Inspect:** `bf presets show <id> --cli --json`. Show the user the `description` and `warning`, and the `options` (checked = default).
3. **Preview:** `bf presets apply <id> [--option "<name>"] [--without "<name>"] --dry-run --json`. This shows exactly which settings would change.
4. **Apply** (after consent): `bf presets apply <id> --confirm --json`. A backup is written first (`data.backup`), and only differing values are written.
5. Reboot if `rebootRequired` is true.

## Notes
- Rate and PID presets apply to the **active** profile. Select the profile first (`bf profile select N`).
- Custom sources: `bf presets sources add <name> <github-url>`.

## Error handling
- `preset has no option`: copy option names exactly from `bf presets show`.
- Exit 8: some lines failed (usually settings missing in this firmware). See `error.details`.
