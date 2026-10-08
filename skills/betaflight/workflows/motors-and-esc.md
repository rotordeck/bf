# Motors and ESCs

**Goal:** correct ESC protocol, motor order and spin direction. Optionally bidirectional DShot for RPM filtering.

**Tools:** `bf motors get/set/test/direction/outputs/esc-telemetry`, `bf status`.

**SAFETY:** ask the user to remove all propellers before `motors test` or `motors direction`. Pass `--confirm-props-removed` only after the user has confirmed it.

## Workflow
1. Check the current state with `bf motors get --json`: `motor_pwm_protocol`, `dshot_bidir`, `motor_poles`, `yaw_motors_reversed`, `motor_idle`.
2. **Protocol:**
   - Modern BLHeli_S/Bluejay/AM32/BLHeli_32 ESCs: `bf motors set motor_pwm_protocol=DSHOT300`. DSHOT600 works with 8k PID loops.
3. **Bidirectional DShot (enables RPM filtering):**
   - Run `bf motors set dshot_bidir=ON motor_poles=14` (14 for most 5" motors, 12 for many tiny whoop motors).
   - Run `bf reboot --wait`.
   - Check `bf motors esc-telemetry --json`: `invalidPercent` should be < 1 while the motors spin in a test.
   - If the FC shows the `DSHOT_TELEM` arming flag, the ESC firmware lacks bidir support. Revert with `dshot_bidir=OFF`.
4. **Motor order:**
   - Spin each motor with `bf motors test --motor N --value 1080 --duration 1500 --confirm-props-removed`.
   - Ask the user which corner spun. Betaflight's QUADX order is 1 = rear right, 2 = front right, 3 = rear left, 4 = front left.
   - Fix a wrong order in hardware or with `bf setting set motor_output_reordering=...`. Configurator's "motor reorder" writes the same setting.
5. **Direction:**
   - Default props-in: motors 1 and 4 spin CW, 2 and 3 spin CCW.
   - Reverse a single motor with `bf motors direction <n> --reversed --confirm-props-removed` (DShot ESCs only).
   - For props-out, use `bf motors set yaw_motors_reversed=ON`.
6. **Idle:** `motor_idle` (percent × 100). For example, `bf motors set motor_idle=550` is 5.5%.

## Error handling
- `motors test` refused (exit 4): armed, or arming is disabled by another tool. Run `bf status`.
- Nothing spins: check `bf motors outputs`, the battery, and that `motor_pwm_protocol` matches the ESC.
