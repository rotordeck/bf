# Failsafe and GPS Rescue

**Goal:** a safe reaction to signal loss.

**Tools:** `bf failsafe get/set`, `bf receiver rxfail`, `bf gps-rescue get/set`, `bf gps status`.

## Workflow
1. Run `bf failsafe get --json`. Key settings:
   - `failsafe_procedure`: DROP (default, safest near people), AUTO-LAND, or GPS-RESCUE
   - `failsafe_delay`: stage-1 guard time
   - `failsafe_throttle` and `failsafe_landing_time`: for landing
2. **Typical freestyle/race setup:** `bf failsafe set failsafe_procedure=DROP`.
3. **GPS rescue**, for long range, only with a GPS:
   1. `bf feature enable GPS`, plus the GPS UART (see `receiver-and-ports.md`).
   2. `bf gps status --json`: wait for `fix: true` and enough satellites.
   3. `bf gps-rescue set gps_rescue_return_alt=30 gps_rescue_ground_speed=750 gps_rescue_min_sats=8` (values are examples; discuss with the user).
   4. `bf failsafe set failsafe_procedure=GPS-RESCUE`.
   5. Optionally put GPS RESCUE on a switch: `bf modes set "GPS RESCUE" --aux N --range 1700-2100`.
4. **Per-channel stage-1 values:** `bf receiver rxfail` shows them. For example, hold AUX switches with `bf receiver rxfail 5 --mode hold`.
5. **Test:** with props off and the craft disarmed, turn the transmitter off. `bf status` should show `FAILSAFE`/`RXLOSS`.

## Error handling
- Names differ between firmware versions. Use `bf failsafe get --json` and `bf setting info <name>` for the exact names and allowed values.
