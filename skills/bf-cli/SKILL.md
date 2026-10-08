---
name: bf-cli
description: How to run and drive the `bf` Betaflight command line tool, from scripts or as an agent. Covers getting it via npx, connecting to a flight controller or the simulator, the JSON output and exit-code contract, discovering commands, safe write patterns, streaming, and troubleshooting. Use whenever you need to invoke `bf`; for drone-specific procedures (receiver setup, tuning, won't arm, ...) also load the `betaflight` skill.
---

# Using the `bf` CLI

`bf` configures Betaflight flight controllers (FCs) over USB. It talks to the Betaflight SITL simulator over TCP. It is stateless: every invocation connects, runs one command and disconnects.

## 1. Getting `bf`

No install is needed. Run it with npx:

```sh
npx @rotordeck/bf --help
npx @rotordeck/bf info
```

Other ways:

| Situation | Command |
|---|---|
| Use repeatedly in a session | `alias bf='npx --yes @rotordeck/bf'` |
| Pin a version (reproducible scripts, CI) | `npx --yes @rotordeck/bf@0.1.0 info` |
| Install permanently | `npm install -g @rotordeck/bf`, then `bf ...` |
| Unreleased `main` branch | `npx --allow-git=all github:rotordeck/bf info` (npm ≥ 12 needs the flag) |
| A GitHub release tarball | `npx --allow-remote=all https://github.com/rotordeck/bf/releases/download/v0.1.0/rotordeck-bf-0.1.0.tgz info` |
| From a clone | `npm install && npm link` |

- **Requirements:** Node.js ≥ 22.
- **Linux serial access:** the user must be in the `uucp` or `dialout` group.
- **Non-interactive shells:** use `npx --yes` to skip the install prompt.
- **Everything below writes `bf`.** With npx, substitute `npx --yes @rotordeck/bf`.

## 2. Connecting

| Option | Meaning |
|---|---|
| (none) | auto-detect the single USB flight controller |
| `--port /dev/ttyACM0` / `--port COM3` | a specific port |
| `--port tcp://127.0.0.1:5761` | SITL simulator |
| `BF_PORT=...` | environment default for `--port` |
| `--baud 115200` | only for UART adapters (USB ignores it) |
| `--timeout <ms>` | MSP reply timeout (default 1500) |

Steps:
1. Run `bf ports --json` first if unsure. Entries with `likelyFlightController: true` are FCs.
2. Then run `bf info --json` to identify the board and firmware. Run it again if the user swaps boards.

## 3. Output contract

- **Use `--json` for anything you parse.**
- **Success** goes to stdout as one JSON document:

  ```json
  {"ok":true,"data":{...},"meta":{"port":"/dev/ttyACM0","fc":{"variant":"BTFL","version":"2025.12.5","api":"1.48","board":"SPEEDYBEEF405V4"}}}
  ```

- **Failure** goes to stderr, with nothing on stdout:

  ```json
  {"ok":false,"error":{"code":"VALIDATION","message":"p_roll = 999 is out of range","hint":"allowed range: 0..250","details":{"min":0,"max":250}}}
  ```

- **Streams:** `--watch` commands print NDJSON, one `{"t":ms,"kind":...,"data":...}` per line, until Ctrl-C (or `--count` on `bf telemetry`).
- **Progress:** progress and diagnostics go to stderr. `-q` silences progress, `-v` adds protocol logging.
- **Human mode:** without `--json` you get readable tables. Don't parse those.

Exit codes. Branch on these, not on message text:

| Code | Meaning | Typical reaction |
|---|---|---|
| 0 | ok | |
| 1 | general error | report it with `error.message` |
| 2 | validation | fix the input using `error.hint` / `error.details` (allowed values, ranges, name suggestions) |
| 3 | connection | no port, wrong port, port busy (`PORT_BUSY` names the program holding it), timeout |
| 4 | refused by the FC | usually armed: ask the user to disarm |
| 5 | unsupported | not in this firmware build; explain, and don't retry |
| 6 | confirmation required | ask the user, then repeat with `--confirm` (or `--confirm-props-removed`) |
| 7 | verification failed | the value didn't stick (clamped/dependent); show `error.details` |
| 8 | partial batch failure | some lines failed; `error.details` lists them |

`jq` recipes:

```sh
bf status --json | jq -r '.data.armingDisabledFlags[]'
bf setting get p_roll i_roll --json | jq -r '.data[] | "\(.name)=\(.value)"'
bf config snapshot --json | jq '.data.pidProfiles[0] | {p_roll, i_roll, d_roll}'
bf pid set roll.p=48 --json | jq '.data.changed'
```

## 4. Discovering commands

- `bf schema --json` lists every command with its arguments, options (choices, defaults), examples, whether it connects to the FC (`connectsToFc`), whether it changes state (`mutates`), and its exit codes. Read it once instead of guessing.
- `bf <command> --help` gives the description, options, examples and exit codes for one command.
- `bf setting info <name> --json` gives a setting's type, range or allowed values, default and scope.
- `bf <area> get --json` gives every setting of a Configurator tab with its current value.

Areas mirror the Configurator tabs:
- PID tuning: `pid`, `pid-advanced`, `tuning`, `filters`, `rates`
- Link and control: `receiver`, `modes`, `adjustments`, `failsafe`, `gps-rescue`, `gps`
- Hardware: `power`, `motors`, `arming`, `system`, `sensors`, `serial`, `servos`, `led`
- Video: `osd`, `vtx`
- Other: `blackbox`, `beeper`, `telemetry-config`, `feature`, `beacon`

Whole-config commands are under `config`, raw settings under `setting`, and live data under `telemetry` / `status`.

## 5. Writing safely

Every write follows the same rules:
- **Validated before anything is written.** If any value is invalid, nothing is written (exit 2).
- **Idempotent.** Values already set are skipped. The result is `{"changed":[{key,from,to}], "unchanged":[...], "saved":bool, "rebootRequired":bool}`, so re-running is safe.
- **Verified.** Values are read back after writing (exit 7 on mismatch).
- **Saved.** Changes go to EEPROM unless `--no-save` is given. Use `--no-save` for several steps, then `bf save`.
- **Refused while armed** (exit 4).

The pattern for any change:

```sh
bf config backup -o before.txt                    # 1. back up (tell the user the file)
bf pid set roll.p=48 pitch.p=50 --dry-run --json  # 2. preview, show the user data.changed
bf pid set roll.p=48 pitch.p=50 --json            # 3. apply
# 4. if data.rebootRequired: bf reboot --wait
```

Profiles:
- PID, rate and battery profile settings act on the active profile by default.
- Pass `--profile N` (1-based) to target another one without switching. The active profile is restored afterwards.
- Switch profiles with `bf profile select N` / `bf rateprofile select N`.

For several related changes, prefer a desired-state file. It is idempotent and reviewable:

```sh
cat > desired.yaml <<'EOF'
settings: { motor_pwm_protocol: DSHOT600, dshot_bidir: ON }
pid_profiles: { 1: { p_roll: 48 }, 2: { p_roll: 52 } }
rate_profiles: { 1: { roll_srate: 70 } }
features: { GPS: true, AIRMODE: true }
cli: [ "aux 0 0 0 1700 2100 0 0", "map AETR1234" ]
EOF
bf config apply desired.yaml --dry-run --json
bf config apply desired.yaml --json      # running it again reports no changes
```

`config apply` also accepts CLI text (part of a `diff`) and `-` for stdin.

Escape hatches:
- **`bf setting set name=value`** sets any setting by name, including ones no area covers.
- **`bf cli exec "<line>" ...`** runs raw firmware CLI lines (e.g. `resource`, `timer`, `dma`, `mmix`, `smix`). Add `--save` to persist. `save` lines are rejected; use `bf save`.

## 6. Destructive and physical actions

These need an explicit flag, and you need the user's explicit consent before adding it:

| Command | Flag |
|---|---|
| `bf defaults`, `bf config restore`, `bf presets apply`, `bf profile copy\|reset`, `bf vtx table import`, `bf osd font`, `bf waypoints load\|clear` | `--confirm` |
| `bf firmware flash`, `bf reboot --mode bootloader*`, `bf blackbox erase`, `bf blackbox msc` | `--confirm` |
| `bf motors test`, `bf motors direction` | `--confirm-props-removed` (props must be OFF) |

Bootloader and MSC modes leave the FC unreachable over MSP until it is flashed or unplugged. Only use them when the user can replug the board.

## 7. Live data

```sh
bf status --json                                    # arming flags, modes, profiles, CPU, sensors
bf telemetry attitude --json                        # also: imu altitude rc motors battery analog gps esc status
bf telemetry imu --watch --interval 100 --count 50 --json > imu.ndjson
bf receiver live --watch --json                     # watch sticks/switches while the user moves them
```

`bf telemetry --watch` accepts `--count N`. Every `--watch` stream stops cleanly on SIGINT/SIGTERM. Motor tests always stop the motors on exit.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| exit 3, `NO_PORT` | FC unplugged, charge-only cable, or the board is in DFU mode (`bf firmware dfu-devices`) |
| exit 3, `PORT_BUSY` | another program holds the port (Configurator, serial monitor, another `bf`); `details.holders` names it |
| exit 3, `did not answer MSP` | wrong port, MSP disabled on that UART, or the FC is in bootloader/MSC mode |
| permission denied on `/dev/ttyACM0` | add the user to `uucp`/`dialout`, then log in again |
| exit 5 | the firmware build lacks the feature (e.g. LED strip). A rebuild with that option is needed (`bf firmware build ... --option ...`) |
| unknown setting (exit 2) | names differ between firmware versions. Use `error.details.suggestions` or `bf setting list --filter <part> --json` |
| slow or partial replies | run with `-v` to see MSP retries. Some firmware builds need nudges, which `bf` sends automatically |

## 9. For Claude Code users

The domain workflows live in the `betaflight` skill, which ships next to this one. Install both:

```sh
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/@rotordeck/bf/skills/"* ~/.claude/skills/   # after npm install -g
# or from a clone: cp -r skills/* ~/.claude/skills/
```
