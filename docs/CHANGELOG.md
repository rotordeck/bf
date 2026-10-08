# Changelog

All notable changes to `bf`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Upstream baseline

`bf` mirrors the MSP protocol, the CLI and the Configurator behaviour of these upstream commits. `scripts/upstream-check.sh` reads this table and lists relevant upstream changes since then. Update the table whenever the code is synced (see `.claude/skills/upstream-sync/SKILL.md`).

<!-- upstream-baseline: machine-readable, keep the format "| name | 40-char sha | date | description |" -->
| Repository | Commit | Commit date | Notes |
|---|---|---|---|
| betaflight | af0638839ac318584ac1da48cf53126e2f30f834 | 2026-10-08 | master, firmware 2026.12.0-alpha, MSP API 1.49 |
| betaflight-configurator | d85e797e8674e3059cc3172e38df831e46a5250c | 2026-10-06 | master |
<!-- /upstream-baseline -->

Upstream: <https://github.com/betaflight/betaflight>, <https://github.com/betaflight/betaflight-configurator>.

## [Unreleased]

### Added
- `skills/bf-cli`: how to run `bf` (npx, global install), connect, parse the JSON contract, handle exit codes, write safely, and troubleshoot.
- Published to npm as `@rotordeck/bf`.

## [0.1.0] - 2026-10-08

Synced to betaflight `af06388` and betaflight-configurator `d85e797`.

### Added
- **Protocol:**
  - MSP v1 (including jumbo frames) and v2 framing, with an error-reply decoder and a v2-over-v1 unwrapper.
  - Command codes generated from the firmware headers (`scripts/gen-msp-codes.sh`).
- **Connections:**
  - USB/UART serial and TCP (for SITL).
  - Auto-detection of the FC port, a per-port lock, and detection of other programs holding the port.
- **Running firmware CLI commands without entering CLI mode:**
  - Uses `MSP2_CLI_COMMAND` when available, otherwise the STX/ETX non-interactive CLI.
  - There is no reboot and no CLI arming lock.
- **Named settings:**
  - Read and written over `MSP2_CLI_SETTING` / `MSP2_CLI_SETTING_INFO`, with a fallback to CLI `get`.
  - Writes are validated, idempotent, verified by read-back and saved.
- **Commands for every Configurator tab:** setup, ports, configuration, power, failsafe/GPS rescue, PID tuning (PIDs, sliders, filters, rates, profiles), receiver, modes, adjustments, motors (including motor test and DShot direction), OSD (elements, preview, font), VTX (including VTX tables), LED strip, servos, GPS, blackbox (info, download, erase, MSC), presets, firmware (detect, cloud build, DFU and UART flashing), waypoints, raw CLI.
- **Whole configuration:**
  - `bf config diff/dump/backup/restore/snapshot`.
  - `bf config apply` applies CLI, JSON or YAML idempotently.
- **Contract:**
  - `--json` envelope, documented exit codes 0–8, `--dry-run`, `--confirm`, and `bf schema --json`.
- **Agent skill:** `skills/betaflight/` (SKILL.md plus 13 workflows).
- **Tests:** unit tests, CLI contract tests, a layering check, and SITL integration tests.

### Fixed (found on real hardware)
- Firmware that holds an MSP reply, or stalls CLI output, until the host sends another byte. Seen on 2026.6.0-alpha on a G473 board. `bf` now sends NUL nudges when a reply is late.
