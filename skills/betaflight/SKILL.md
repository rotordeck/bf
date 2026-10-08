---
name: betaflight
description: Configure Betaflight FPV flight controllers with the `bf` command line tool. Use it for anything the Betaflight Configurator does, such as receiver and ports, modes/switches, motors and ESC protocol, PIDs, rates and filters, failsafe and GPS rescue, OSD, VTX, presets, backups and firmware updates, blackbox logs, and "why won't it arm?".
---

# Betaflight via `bf`

`bf` talks to a Betaflight flight controller (FC) over USB, or over TCP for the simulator. It covers everything the Betaflight Configurator can do. Each invocation connects, does one thing and disconnects, so there is no session to manage.

## Contract (rely on it)

- **Always pass `--json`.**
  - Success goes to stdout as `{"ok":true,"data":...,"meta":{"fc":{...}}}`.
  - Failure goes to stderr as `{"ok":false,"error":{"code","message","hint","details"}}`.
  - `--watch` commands print NDJSON, one object per line.
- **Exit codes:**

  | Code | Meaning | What to do |
  |---|---|---|
  | 0 | ok | |
  | 1 | general error | |
  | 2 | invalid input | read `error.hint`, which carries the allowed range/values or suggestions |
  | 3 | connection | no port, port busy, timeout |
  | 4 | refused by FC | usually armed |
  | 5 | unsupported | not in this firmware build |
  | 6 | needs `--confirm` | ask the user first |
  | 7 | verification failed | |
  | 8 | partial batch failure | see `error.details` |

- **Writes are idempotent.** They validate first, change only what differs, read back to verify, and save to EEPROM. The result is `{changed:[{key,from,to}], unchanged:[...], saved, rebootRequired}`. Retrying is safe.
- **Preview with `--dry-run`.** Use `--no-save` to stage in RAM, then `bf save` to persist.
- **Reboot when needed.** If `rebootRequired` is true, run `bf reboot --wait` (UART, protocol and feature changes need it).
- **Discovery:**
  - `bf schema --json` lists every command, option and example.
  - `bf <cmd> --help` shows details for one command.
  - `bf setting info <name> --json` gives a setting's type, range, allowed values and default.

## Safety rules (mandatory)

1. **Back up before any change session:** `bf config backup -o <file>`. Tell the user where the file is.
2. **Commands that need explicit user consent** (pass the flag only after the user agrees):
   - `--confirm`: `defaults`, `config restore`, `presets apply`, `firmware flash`, `blackbox erase`, `blackbox msc`, `osd font`, `reboot --mode bootloader*`, `profile copy|reset`, `vtx table import`, `waypoints load|clear`
   - `--confirm-props-removed`: `motors test`, `motors direction`
3. **Never spin motors unless the user has confirmed the propellers are removed.**
4. **Never flash firmware without the user's explicit request.** Flashing the wrong target can brick a board until DFU recovery.
5. **Never change config while armed.** The FC refuses anyway (exit 4).
6. **Bootloader/MSC modes:** after `reboot --mode bootloader` or `blackbox msc`, the FC stops answering MSP until it is flashed or power-cycled. Only do this when the user can unplug/replug.

## Connecting

- `bf ports --json` lists ports; `likelyFlightController` marks the FC.
- With exactly one FC attached, `--port` is optional. Otherwise pass `--port /dev/ttyACM0`, or set `BF_PORT`.
- For the simulator: `--port tcp://127.0.0.1:5761`.
- `error.code` values you may see:
  - `PORT_BUSY`: another program (Configurator, a serial monitor) holds the port. Ask the user to close it.
  - `NO_PORT`: nothing is plugged in, or the cable is charge-only.

## Command map (Configurator tab → command)

| Tab | Commands |
|---|---|
| Setup | `bf info`, `bf status`, `bf calibrate acc\|mag`, `bf reboot`, `bf defaults` |
| Ports | `bf serial list`, `bf serial port UART2 --functions RX` (classic firmware), `bf serial set rx_uart=UART2` (firmware with `*_uart` settings) |
| Configuration | `bf feature list\|enable\|disable`, `bf system get\|set`, `bf arming get\|set`, `bf sensors get\|set`, `bf beeper ...`, `bf beacon ...`, `bf name set` |
| Power & Battery | `bf power get\|set`, `bf telemetry battery` |
| Failsafe | `bf failsafe get\|set`, `bf gps-rescue get\|set`, `bf receiver rxfail` |
| PID Tuning | `bf pid get\|set`, `bf pid-advanced`, `bf tuning` (sliders), `bf filters`, `bf rates`, `bf profile ...`, `bf rateprofile ...` |
| Receiver | `bf receiver get\|set\|map\|live\|bind`, `bf telemetry-config` |
| Modes | `bf modes available\|list\|set\|remove` |
| Adjustments | `bf adjustments functions\|list\|set\|remove` |
| Motors | `bf motors get\|set\|test\|direction\|outputs\|esc-telemetry\|mixers` |
| OSD | `bf osd get\|set\|elements\|element\|preview\|font` |
| Video Transmitter | `bf vtx get\|set\|table get\|table import` |
| LED Strip | `bf led get\|set\|list\|colors\|apply` |
| Servos | `bf servos get\|set\|list\|apply` |
| GPS | `bf gps get\|set\|status` |
| Blackbox | `bf blackbox get\|set\|info\|download\|erase\|msc` |
| Presets | `bf presets search\|show\|apply\|sources` |
| Firmware Flasher | `bf firmware detect\|targets\|releases\|options\|build\|flash` |
| CLI | `bf setting get\|set\|info\|list\|reset`, `bf config diff\|dump\|backup\|restore\|apply\|snapshot`, `bf cli exec` |

`bf <area> get --json` shows the area's settings by name. `bf <area> set name=value ...` changes them, with `--profile N` for PID/rate/battery-profile settings. Profile numbers are 1-based, as in the Configurator.

## Workflows

Read the matching file before starting:

- `workflows/first-time-setup.md`: new build, from unboxing to ready-to-fly
- `workflows/receiver-and-ports.md`: ELRS/CRSF/SBUS receiver, UARTs, channel map
- `workflows/modes-and-switches.md`: ARM, ANGLE, BEEPER, turtle mode on switches
- `workflows/motors-and-esc.md`: ESC protocol, bidirectional DShot, motor order and direction
- `workflows/failsafe-gps-rescue.md`: failsafe stages, GPS rescue
- `workflows/pid-filter-tuning.md`: sliders, PIDs, filters, RPM filtering
- `workflows/rates.md`: rates and expo
- `workflows/osd-vtx.md`: OSD layout, VTX band/channel/power, VTX tables
- `workflows/backup-restore-update-firmware.md`: backups, cloning a config, firmware updates
- `workflows/presets.md`: finding and applying presets
- `workflows/blackbox.md`: logging setup and log download
- `workflows/troubleshoot-wont-arm.md`: every arming-disable flag explained
- `workflows/led-strip.md`: LED strip

## Declarative configuration (preferred for multi-step changes)

Write the desired state and let `bf` compute the difference:

```yaml
# quad.yaml
settings: { motor_pwm_protocol: DSHOT600, dshot_bidir: ON }
pid_profiles: { 1: { p_roll: 48 } }
rate_profiles: { 1: { roll_srate: 70 } }
features: { GPS: true }
cli: [ "aux 0 0 0 1700 2100 0 0" ]
```

Run `bf config apply quad.yaml --dry-run --json`, show the user the `changed` list, then run `bf config apply quad.yaml --json`. Re-running reports nothing changed.
