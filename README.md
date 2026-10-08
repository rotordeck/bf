# bf: Betaflight from the command line, for humans and AI agents

[![npm](https://img.shields.io/npm/v/@rotordeck/bf)](https://www.npmjs.com/package/@rotordeck/bf)
[![license](https://img.shields.io/npm/l/@rotordeck/bf)](LICENSE)

`bf` configures Betaflight flight controllers over USB (or the SITL simulator over TCP). It covers what the Betaflight Configurator does: setup, ports, receiver, modes, motors, PID/rates/filters, failsafe, OSD, VTX, LED, blackbox, presets, backups and firmware flashing. Output is stable JSON for scripts and AI agents.

```sh
npx @rotordeck/bf status
```

```
armed                no
armingDisabledFlags  RXLOSS, DSHOT_TELEM
canArm               no
activeModes          HORIZON, BLACKBOX, VTX PIT MODE
pidProfile           3
...
```

## Install

Requires Node.js ≥ 22.

```sh
npx @rotordeck/bf info              # run without installing
alias bf='npx --yes @rotordeck/bf'  # handy in a shell session
npm install -g @rotordeck/bf        # or install the `bf` command
```

- Unreleased `main` branch: `npx --allow-git=all github:rotordeck/bf info`. npm ≥ 12 needs the flag.
- **Linux:** your user needs access to the serial device (group `uucp` or `dialout`). Flashing over DFU needs a udev rule for `0483:df11`:

  ```
  SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0664", GROUP="plugdev"
  ```

## Quick start

```sh
bf ports                          # find the FC (auto-detected when only one is plugged in)
bf info                           # firmware, board, MCU
bf status                         # arming-disable flags, active modes, profiles
bf config backup -o my-quad.txt   # always back up first
bf pid set roll.p=48 --dry-run    # preview
bf pid set roll.p=48              # validate, write, verify, save
bf modes set ARM --aux 1 --range 1700-2100
bf receiver live --watch          # watch sticks and switches
bf schema --json                  # full machine-readable command reference
```

Connect to a specific port with `--port /dev/ttyACM0` (or `BF_PORT`), or to the simulator with `--port tcp://127.0.0.1:5761`. Every command has `--help` with examples and exit codes.

## Commands (Configurator tab → `bf`)

| Configurator | `bf` |
|---|---|
| Setup | `info`, `status`, `calibrate acc\|mag`, `reboot`, `defaults` |
| Ports | `serial list`, `serial port UART2 --functions RX`, `serial get\|set` |
| Configuration | `feature`, `system`, `arming`, `sensors`, `beeper`, `beacon`, `name` |
| Power & Battery | `power get\|set`, `telemetry battery` |
| Failsafe | `failsafe`, `gps-rescue`, `receiver rxfail` |
| PID Tuning | `pid`, `pid-advanced`, `tuning` (sliders), `filters`, `rates`, `profile`, `rateprofile` |
| Receiver | `receiver get\|set\|map\|live\|bind`, `telemetry-config` |
| Modes / Adjustments | `modes available\|list\|set\|remove`, `adjustments` |
| Motors | `motors get\|set\|test\|direction\|outputs\|esc-telemetry` |
| OSD | `osd get\|set\|elements\|element\|preview\|font` |
| Video Transmitter | `vtx get\|set`, `vtx table get\|import` |
| LED Strip / Servos / GPS | `led`, `servos`, `gps status` |
| Blackbox | `blackbox info\|download\|erase\|msc` |
| Presets | `presets search\|show\|apply\|sources` |
| Firmware Flasher | `firmware detect\|targets\|releases\|options\|build\|flash` |
| CLI / Backup | `setting get\|set\|info\|list\|reset`, `config diff\|dump\|backup\|restore\|apply\|snapshot`, `cli exec` |
| Live data | `telemetry attitude\|imu\|altitude\|rc\|motors\|battery\|gps\|esc\|status [--watch]` |

Area commands (`bf pid get`, `bf osd get`, ...) show every setting of that tab. Matching `set` commands change them by name. `--profile N` targets a PID, rate or battery profile without switching to it.

## Contract

| | |
|---|---|
| stdout | Data only. Human text by default. With `--json` it is `{"ok":true,"data":…,"meta":{"port","fc":{…}}}`. `--watch` streams NDJSON. |
| stderr | Errors, warnings and progress. With `--json`, errors are `{"ok":false,"error":{"code","message","hint","details"}}`. |
| exit codes | 0 ok, 1 general, 2 validation, 3 connection, 4 refused by FC (armed), 5 unsupported by firmware, 6 needs `--confirm`, 7 verification failed, 8 partial batch failure |
| writes | Validated against the setting's type, range and allowed values before anything is written. Unchanged values are skipped (`{changed, unchanged}`), so retries are safe. Every write is read back and saved to EEPROM; `--no-save` keeps it in RAM only. |
| safety | `--dry-run` everywhere. Destructive actions need `--confirm`, motor commands need `--confirm-props-removed`, and all writes are refused while armed. |

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

## Using it with AI agents

`bf` follows the API + CLI + Skills design in [`agent_oriented_cli_design_principles.md`](agent_oriented_cli_design_principles.md). The package ships two skills for the agent layer:

| Skill | Teaches |
|---|---|
| [`skills/bf-cli`](skills/bf-cli/SKILL.md) | running the tool: npx/install, connecting, the JSON and exit-code contract, discovery, safe writes, troubleshooting |
| [`skills/betaflight`](skills/betaflight/SKILL.md) | drone workflows: first-time setup, receiver and ports, modes, motors/ESC, failsafe, tuning, rates, OSD/VTX, presets, backups and firmware updates, blackbox, LEDs, "why won't it arm" |

Install them for Claude Code:

```sh
npm install -g @rotordeck/bf
mkdir -p ~/.claude/skills && cp -r "$(npm root -g)/@rotordeck/bf/skills/"* ~/.claude/skills/
```

Then ask, for example: "set up my ELRS receiver on UART2 and put ARM on AUX1", "why won't my quad arm?", or "update to the latest stable firmware and keep my settings". The skills make the agent back up first, preview with `--dry-run`, and ask before destructive actions or motor tests.

## How it talks to the FC

**MSP.** Binary MSP v1/v2 carries identity, status, live telemetry, motor test, calibration, profiles, dataflash, OSD font, DShot commands and reboot. The codecs follow the firmware's `msp.c`.

**Named settings.** These use `MSP2_CLI_SETTING` / `MSP2_CLI_SETTING_INFO` (Betaflight master, 2026.12 development), which give typed metadata per setting. On older firmware they fall back to the CLI `get`.

**Command lines** (`diff`, `dump`, `aux`, `serial`, presets, restore):
- `MSP2_CLI_COMMAND` where the firmware has it.
- Otherwise the non-interactive STX/ETX CLI (Betaflight ≥ 4.5.4).
- Neither enters the interactive CLI, so there is no reboot and no arming lock. `save` is replaced by `MSP_EEPROM_WRITE`.

**Firmware quirk.** Some builds hold a reply until another byte arrives (seen on a 2026.6.0-alpha G473). `bf` sends harmless NUL "nudges" when a reply is late.

**Configuration areas** are groups of named settings, matched by name and profile scope. They are resolved against what the connected firmware actually has, so build-specific settings appear automatically.

## Status

Version 0.1, early. Tested against:
- Betaflight SITL, at firmware master `af06388` (2026.12.0-alpha)
- a BETAFPVG473_V2 flight controller on 2026.6.0-alpha: reads, writes, backup/restore round trip, presets, reboot and blackbox download

DFU and UART flashing are implemented and unit-tested, but have not yet been run on real hardware. Try them on a spare board first.

Not yet covered: Autotune, cloud backups (user.betaflight.com) and shell completion.

## Development

```sh
git clone https://github.com/rotordeck/bf && cd bf
npm install          # `prepare` builds dist/
npm link             # put the local `bf` on your PATH
npm test             # unit, CLI contract and architecture tests
npm run lint && npm run typecheck
```

To include the SITL integration tests, run the simulator first; the tests detect it on `tcp://127.0.0.1:5761`:

```sh
git clone https://github.com/betaflight/betaflight && make -C betaflight TARGET=SITL
(cd /tmp && while true; do ~/path/betaflight/obj/main/betaflight_SITL.elf; done) &   # SITL exits on reboot
npm test
```

### Layout

```
src/core/transport   serial + TCP transports, port lock, busy-port detection
src/core/msp         framing (v1/jumbo/v2), codes (generated from firmware headers), typed messages
src/core/clitext     CLI command lines over MSP2_CLI_COMMAND / STX
src/core/services    settings, config (diff/backup/restore/apply), groups (tabs), profiles, lists
                     (modes, adjustments, features, serial, vtx table, ...), live data, osd, blackbox, firmware
src/core/net         build.betaflight.com and preset repositories
src/core/flash       Intel HEX, DfuSe over USB, STM32 UART bootloader
src/cli              commander front end (no Betaflight logic; enforced by eslint + a test)
skills/              agent skills shipped in the npm package (bf-cli, betaflight)
docs/CHANGELOG.md    changes + the upstream commits bf is synced to
scripts/             gen-msp-codes.sh (codes from firmware headers), upstream-check.sh
.claude/skills/      upstream-sync: maintainer skill for porting upstream changes
```

### Keeping up with Betaflight

[`docs/CHANGELOG.md`](docs/CHANGELOG.md) records the Betaflight and Configurator commits `bf` is synced to. `scripts/upstream-check.sh` reports relevant upstream changes since then, mapped to the `bf` files they affect. In Claude Code, the `upstream-sync` skill (`/upstream-sync`) walks through porting the changes, testing, and moving the baseline.

### Releasing

1. Move `[Unreleased]` in `docs/CHANGELOG.md` to a new version.
2. Run `npm version <x.y.z> --no-git-tag-version` and commit.
3. Run `npm publish --auth-type=web`. `prepublishOnly` runs typecheck, lint and tests; 2FA is approved in the browser.
4. Run `git tag v<x.y.z> && git push --tags`, then `gh release create v<x.y.z>`.

## License

AGPL-3.0-or-later. Parts are ported from [Betaflight Configurator](https://github.com/betaflight/betaflight-configurator) (GPL-3.0-or-later), which GPLv3 section 13 allows combining with AGPLv3 code.
