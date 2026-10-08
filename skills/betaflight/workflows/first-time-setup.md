# First-time setup of a new build

**Goal:** take a freshly built quad to ready-to-fly. This mirrors the Configurator tabs in order.

**Tools:** `bf info`, `bf config backup`, `bf calibrate acc`, `bf serial`, `bf receiver`, `bf modes`, `bf motors`, `bf failsafe`, `bf power`, `bf osd`, `bf vtx`, `bf status`.

## Workflow
1. Identify the FC with `bf info --json`. Note `board`, `version` and `capabilities`.
2. Back up the factory config: `bf config backup -o factory.txt`.
3. **Optional, check first:** a BNF preset for this craft may exist. Run `bf presets search <craft name> --category BNF --json`. If one exists, follow `presets.md` and skip the steps it covers.
4. **Board orientation.** If the FC is mounted rotated, set it with `bf sensors set align_board_yaw=<deg>`. Then check that `bf telemetry attitude` follows when the user tilts the craft.
5. **Accelerometer.** Ask the user to place the craft level, then run `bf calibrate acc`.
6. **Receiver.** Follow `receiver-and-ports.md`.
7. **Modes.** Follow `modes-and-switches.md`. ARM is mandatory, and a BEEPER switch is recommended.
8. **Motors.** Follow `motors-and-esc.md` (protocol, direction, order). Never spin motors with propellers on.
9. **Battery.** Run `bf power get`. For voltage calibration, have the user measure the pack and run `bf power set vbat_scale=<n>`. Set the capacity with `bf power set bat_capacity=<mAh>`.
10. **Failsafe.** Follow `failsafe-gps-rescue.md`.
11. **OSD and VTX.** Follow `osd-vtx.md`.
12. **Name the craft:** `bf name set --craft <name>`.
13. **Check.** `bf status --json` must show only `RXLOSS`-free flags with the transmitter on. With the arm switch off, `canArm` should be true.
14. **Final backup:** `bf config backup -o <craft>-ready.txt`.

## Error handling
- Any exit code 4: the craft is armed. Disarm.
- After changing UARTs, features or the motor protocol, the result says `rebootRequired: true`. Run `bf reboot --wait`.
