# bf: Betaflight from the command line, for humans and AI agents

`bf` configures Betaflight flight controllers over USB (or the SITL simulator over TCP). It covers what the Betaflight Configurator does: setup, ports, receiver, modes, motors, PID/rates/filters, failsafe, OSD, VTX, LED, blackbox, presets, backups and firmware flashing. Output is stable JSON for scripts and agents.

It follows the API + CLI + Skills design in [`agent_oriented_cli_design_principles.md`](agent_oriented_cli_design_principles.md):

| Layer | Where | What |
|---|---|---|
| API | `src/core/` | MSP protocol, transports, CLI-over-MSP, typed services. No console I/O. |
| CLI | `src/cli/` | Argument parsing, output envelope, exit codes. No Betaflight logic; an eslint rule and a test enforce the boundary. |
| Skills | `skills/betaflight/` | `SKILL.md` and workflow guides that teach an agent the vocabulary and safe procedures. |

## Install

Run it without installing. npm ≥ 12 blocks git and URL packages unless you allow them:

```sh
# latest release
npx --allow-remote=all https://github.com/rotordeck/bf/releases/download/v0.1.0/rotordeck-bf-0.1.0.tgz info
# current main branch (builds on install)
npx --allow-git=all github:rotordeck/bf info
```

Or install globally:

```sh
npm install -g --allow-git=all github:rotordeck/bf
bf --help
```

From a clone:

```sh
npm install && npm link   # `prepare` builds dist/
```

Linux: your user needs access to the serial device (group `uucp` or `dialout`). Flashing over DFU needs a udev rule for `0483:df11`.

## Quick start

```sh
bf ports                          # find the FC
bf info                           # firmware, board, MCU
bf status                         # arming-disable flags, active modes, profiles
bf config backup -o my-quad.txt   # always back up first
bf pid set roll.p=48 --dry-run    # preview
bf pid set roll.p=48              # validate, write, verify, save
bf modes set ARM --aux 1 --range 1700-2100
bf schema --json                  # full machine-readable command reference
```

Every command has `--help` with examples and exit codes.

## Contract

| | |
|---|---|
| stdout | data only. Human text by default; with `--json` it is `{"ok":true,"data":…,"meta":{"port","fc":{…}}}`; `--watch` streams NDJSON |
| stderr | errors, warnings, progress. With `--json`, errors are `{"ok":false,"error":{"code","message","hint","details"}}` |
| exit codes | 0 ok, 1 general, 2 validation, 3 connection, 4 refused by FC (armed), 5 unsupported by firmware, 6 needs `--confirm`, 7 verification failed, 8 partial batch failure |
| writes | Validated against the setting's type, range and allowed values. Unchanged values are skipped (`{changed, unchanged}`), so retries are safe. Every write is read back and saved to EEPROM; `--no-save` keeps it in RAM only. |
| safety | `--dry-run` everywhere. Destructive actions need `--confirm`. Motor commands need `--confirm-props-removed`. All writes are refused while armed. |

Declarative configuration applies only the differences, so it is idempotent:

```sh
cat > quad.yaml <<'EOF'
settings: { motor_pwm_protocol: DSHOT600, dshot_bidir: ON }
pid_profiles: { 1: { p_roll: 48 } }
features: { GPS: true }
cli: [ "aux 0 0 0 1700 2100 0 0" ]
EOF
bf config apply quad.yaml --dry-run
bf config apply quad.yaml        # a second run reports "no changes"
```

## How it talks to the FC

**MSP.** Binary MSP v1/v2 carries identity, status, live telemetry, motor test, calibration, profiles, dataflash, OSD font, DShot commands and reboot. The codecs follow the firmware's `msp.c`.

**Named settings.** These use `MSP2_CLI_SETTING` / `MSP2_CLI_SETTING_INFO` (Betaflight master, 2026.12 development), which give typed metadata per setting. On older firmware they fall back to the CLI `get`.

**Command lines** (`diff`, `dump`, `aux`, `serial`, presets, restore):
- `MSP2_CLI_COMMAND` where the firmware has it.
- Otherwise the non-interactive STX/ETX CLI (Betaflight ≥ 4.5.4).
- Neither enters the interactive CLI, so there is no reboot and no arming lock. `save` is replaced by `MSP_EEPROM_WRITE`.

**Firmware quirk.** Some builds hold a reply until another byte arrives (seen on a 2026.6.0-alpha G473). `bf` sends harmless NUL "nudges" when a reply is late.

**Configuration areas** (`bf pid`, `bf filters`, `bf receiver`, `bf osd`, …) are groups of named settings, matched by name and profile scope. They are resolved against what the connected firmware actually has, so build-specific settings appear automatically.

## Testing

```sh
npm test            # unit tests, plus the CLI contract and architecture tests
```

To include the SITL integration tests, run the simulator first; the tests detect it on `tcp://127.0.0.1:5761`:

```sh
make -C betaflight TARGET=SITL
(cd /tmp && while true; do ~/path/betaflight/obj/main/betaflight_SITL.elf; done) &   # SITL exits on reboot
npm test
```

## Changelog and upstream sync

[`docs/CHANGELOG.md`](docs/CHANGELOG.md) lists changes and records the Betaflight and Configurator commits `bf` is synced to. `scripts/upstream-check.sh` reports relevant upstream changes since that baseline. The Claude Code skill in `.claude/skills/upstream-sync/` walks through porting them and moving the baseline.

## Layout

```
src/core/transport   serial + TCP transports, port lock, busy-port detection
src/core/msp         framing (v1/jumbo/v2), codes (generated from firmware headers), typed messages
src/core/clitext     CLI command lines over MSP2_CLI_COMMAND / STX
src/core/services    settings, config (diff/backup/restore/apply), groups (tabs), profiles, lists
                     (modes, adjustments, features, serial, vtx table, ...), live data, osd, blackbox, firmware
src/core/net         build.betaflight.com and preset repositories
src/core/flash       Intel HEX, DfuSe over USB, STM32 UART bootloader
src/cli              commander front end
skills/betaflight    agent skill (SKILL.md + workflows/)
```

`scripts/gen-msp-codes.sh` regenerates `src/core/msp/codes.ts` from the firmware headers.

License: AGPL-3.0-or-later. Parts are ported from Betaflight Configurator (GPL-3.0-or-later), which GPLv3 section 13 allows combining with AGPLv3 code.
