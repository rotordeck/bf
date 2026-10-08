---
name: upstream-sync
description: Check Betaflight firmware and Betaflight Configurator for upstream changes since the baseline in docs/CHANGELOG.md, port the relevant ones into the bf CLI, and update the changelog and baseline hashes. Use when asked to "check for upstream updates", "sync with betaflight", "update the changelog for upstream", or periodically.
---

# Upstream sync for `bf`

`bf` mirrors three upstream things:
- the firmware's MSP protocol and CLI (`betaflight/`)
- the Configurator's procedures: DFU, presets, build API, backup/restore (`betaflight-configurator/`)
- the upstream commits recorded in the **Upstream baseline** table of `docs/CHANGELOG.md`

This skill moves that baseline forward. The two upstream checkouts are git-ignored clones inside the repo; the script clones them if they are missing.

## 1. Check

```sh
scripts/upstream-check.sh          # fetches, compares baseline..origin/master
```

- **Exit 0:** nothing relevant changed.
  - If the commit count is 0, report "up to date" and stop.
  - If there are commits but none are relevant, do step 5 only, and log "baseline moved, no relevant changes" under `[Unreleased]`.
- **Exit 10:** relevant changes. The report lists them per area, as upstream paths → the `bf` files that depend on them, plus concrete deltas:
  - MSP codes
  - arming flags
  - setting names
  - CLI command table
  - API version
  - added/removed tabs
- **Exit 2:** the baseline is missing or unknown. Fix the table in `docs/CHANGELOG.md`.

To compare against a release instead of master, use `TARGET_REF=<tag-or-sha> scripts/upstream-check.sh`.

## 2. Triage each listed commit

For every commit in the report, read the actual change:

```sh
git -C betaflight show <sha> -- <paths from the report>
git -C betaflight-configurator show <sha> -- <paths>
```

Classify each as one of:
- **needs change**: the wire format, a name, a CLI output format or a procedure that `bf` uses changed
- **new capability**: worth exposing in `bf`, e.g. a new MSP command, setting, CLI command or Configurator tab
- **no impact**: refactor, a platform-only change, or code `bf` does not use

Show the user a short table with the commit, the classification and the `bf` files affected. Ask before implementing large **new capability** items. Always do **needs change** items.

### Where things live in bf

| Upstream change | Update in bf |
|---|---|
| `#define MSP*` codes | run `scripts/gen-msp-codes.sh`, then check `git diff src/core/msp/codes.ts` |
| MSP payload layout (`msp.c`) | decoders/encoders in `src/core/msp/messages.ts`; read-only fields are optional trailing fields (`u8or`/`u16or`) so older firmware keeps working |
| `MSP2_CLI_*` handlers, STX/ETX CLI, `msp_serial.c` | `src/core/clitext/channel.ts`, `src/core/msp/client.ts`, `src/core/msp/frame.ts` |
| CLI output formats (`cli.c` print functions) | the parsers in `src/core/services/{settings,config,lists,osd}.ts`; add a test fixture in `test/parsers.test.ts` |
| setting renamed/added/removed | group regexes in `src/core/services/groups.ts`; names used in `skills/betaflight/**` (grep for the old name) |
| arming-disable flags | `ARMING_DISABLE_FLAG_NAMES` in `src/core/msp/messages.ts` (index = bit) and the table in `skills/betaflight/workflows/troubleshoot-wont-arm.md` |
| serial function bits / OSD position / adjustment functions / DShot commands | constants in `src/core/services/lists.ts`, `src/core/services/osd.ts`, `src/core/msp/messages.ts` |
| Configurator DFU / UART bootloader / hex | `src/core/flash/*` |
| Build API / cloud build | `src/core/net/buildapi.ts`, `src/core/services/firmware.ts` |
| presets parser / repo layout | `src/core/net/presets.ts` |
| USB VID/PID lists (`devices.js`) | `FC_SERIAL_DEVICES` in `src/core/transport/transport.ts`, `DFU_DEVICES` in `src/core/flash/dfu.ts` |
| new Configurator tab or feature | new service in `src/core/services/`, commands in `src/cli/commands/`, workflow in `skills/betaflight/workflows/`, entry in `skills/betaflight/SKILL.md` |

Rules while porting:
- Business logic goes in `src/core`; `src/cli` only parses and formats (enforced by eslint and `test/cli-contract.test.ts`).
- Keep backward compatibility with older firmware. Gate on `session.apiAtLeast(major, minor)`, or on an MSP error reply, rather than dropping support.
- Writes must stay idempotent (`{changed, unchanged}`), support `--dry-run`, and require `--confirm` when destructive.
- Every new or changed command keeps `--help` examples and documented exit codes.

## 3. Verify

```sh
npm run typecheck && npm run lint && npm test
```

Then build and run SITL at the new firmware commit, so the integration tests exercise the new upstream code:

```sh
git -C betaflight checkout --detach <target sha>
make -C betaflight TARGET=SITL -j"$(nproc)"
# run obj/main/betaflight_SITL.elf in a restart loop from a scratch directory (it exits on reboot)
npm test                                   # SITL tests run automatically when tcp://127.0.0.1:5761 answers
```

If the user has a flight controller attached, run read-only checks only: `bf info`, `bf status`, `bf config diff`. **Never flash firmware or erase blackbox logs as part of a sync.**

## 4. Changelog

Under `## [Unreleased]` in `docs/CHANGELOG.md`, add entries grouped as `### Added` / `### Changed` / `### Fixed` / `### Upstream`. Each entry says what changed for `bf` users and cites the upstream commit(s), e.g.:

```md
### Upstream
- Synced to betaflight `abc1234` (2026-11-02) and betaflight-configurator `def5678` (2026-11-01).
### Changed
- `bf status`: decodes the new `ALT_HOLD_SW` arming flag (betaflight `1234abc`).
```

## 5. Move the baseline

Update the two rows between `<!-- upstream-baseline -->` and `<!-- /upstream-baseline -->`:
- the full 40-character SHA
- the commit date (`git log -1 --format=%cs <sha>`)
- notes: branch, firmware version from `betaflight/src/main/build/version.h` (`FC_VERSION_YEAR`, `FC_VERSION_MONTH`, `FC_VERSION_PATCH_LEVEL`, suffix) and `API_VERSION_MAJOR.MINOR` from `msp_protocol.h`

Keep the row format `| name | sha | date | notes |`, because `scripts/upstream-check.sh` parses it. Then re-run `scripts/upstream-check.sh --no-fetch`; it must report 0 commits.

## 6. Finish

Summarize for the user:
- the upstream range covered
- which commits were ported, and which were judged no-impact (with a one-line reason)
- test results, including whether the SITL tests ran

Commit only when the user asks. When cutting a release, rename `[Unreleased]` to `[x.y.z] - date` and bump `package.json`.
