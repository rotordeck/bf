# Troubleshooting: the craft won't arm

**Goal:** find out why arming is blocked and fix it.

**Tools:** `bf status --json`, `bf receiver live --json`, `bf modes list --json`, `bf setting get/set`, `bf calibrate acc`.

## Workflow
1. Run `bf status --json` and read `data.armingDisabledFlags`. An empty list together with `canArm: true` means the FC will arm when the ARM switch is flipped.
2. Fix the flags from the top of this table down. Re-run `bf status` after each fix.
3. `ARM_SWITCH` is always present while the arm switch is on and any other flag is active. Fix the other flags first.

| Flag | Meaning | Fix |
|---|---|---|
| NOGYRO | gyro not detected | hardware fault or wrong firmware target; check `bf info` |
| FAILSAFE | failsafe is active | fix the RX link (see RXLOSS) |
| RXLOSS | no valid RC signal | `bf receiver get` (provider), `bf serial list` (RX on the right UART), transmitter bound and on; `bf receiver live` must show changing values |
| NOT_DISARMED | arm switch on during boot/failsafe | switch ARM off, then on again |
| BOXFAILSAFE | failsafe switch active | turn the failsafe switch off (`bf modes list`) |
| RUNAWAY | runaway takeoff prevention triggered | disarm and re-arm; check motor order/direction (`motors-and-esc.md`) |
| CRASH | crash detected (GPS rescue) | disarm and re-arm |
| THROTTLE | throttle not low | lower the throttle; if it already is, check `bf receiver live` throttle < `min_check` (`bf receiver get`) and the channel map |
| ANGLE | craft tilted more than `small_angle` | level the craft, or `bf calibrate acc`, or `bf arming set small_angle=180` (whoops/freestyle) |
| BOOTGRACE | just booted | wait a few seconds |
| NOPREARM | PREARM mode configured but not active | flip the PREARM switch |
| LOAD | CPU overloaded | lower `pid_process_denom` or disable features; `bf status` shows `cpuLoadPercent` |
| CALIB | sensors calibrating | keep still, wait |
| CLI | CLI mode was entered (e.g. Configurator CLI tab) | `bf reboot --wait` |
| CMS | OSD menu open | exit the OSD menu |
| MSP | arming disabled over MSP (Configurator motor tab open) | close the other program, `bf reboot --wait` |
| PARALYZE | PARALYZE mode used | power cycle |
| GPS | GPS rescue needs a fix | wait for satellites (`bf gps status`), or `bf gps-rescue set gps_rescue_allow_arming_without_fix=ON` (only with user consent) |
| RESCUE_SW | GPS rescue switch active | turn the switch off |
| DSHOT_TELEM | bidirectional DShot enabled but no telemetry | ESC firmware without bidir support: `bf motors set dshot_bidir=OFF`, or flash Bluejay/AM32; also check `motor_poles` |
| REBOOT_REQD | config change needs a reboot | `bf reboot --wait` |
| DSHOT_BBANG | DShot bitbang timer conflict | `bf motors set dshot_bitbang=OFF` or change timers |
| NO_ACC_CAL | accelerometer not calibrated | level the craft, `bf calibrate acc` |
| MOTOR_PROTO | no motor protocol | `bf motors set motor_pwm_protocol=DSHOT300` |
| FLIP_SWITCH | turtle-mode switch on | turn the flip-over-after-crash switch off |
| ALT_HOLD_SW / POS_HOLD_SW / AUTOPILOT_SW | that mode's switch is on | turn it off before arming |
| ARM_SWITCH | arm switch was on while another flag was active | flip ARM off, then on |

## Error handling
- Exit code 3 / `PORT_BUSY`: another program holds the port. Ask the user to close it.
- RXLOSS that persists while `bf receiver live` shows values: the values are probably not reaching 1000–2000. Compare them with `min_check`/`max_check` and adjust the transmitter endpoints.
