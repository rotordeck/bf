# Modes on switches

**Goal:** assign ARM, ANGLE/HORIZON, BEEPER, flip-over-after-crash (turtle), and so on to transmitter switches.

**Tools:** `bf modes available/list/set/remove`, `bf receiver live`.

## Workflow
1. Run `bf modes available --json` to see the mode names this build offers. Use them exactly (e.g. `FLIP OVER AFTER CRASH` needs quoting).
2. **Find out which AUX channel a switch is:** run `bf receiver live --json` with the switch low, then again with it high. The `auxN` value that changed is AUXN. AUX1 is RC channel 5.
3. **Read the switch positions** from the same data. A 2-position switch is ~1000 and ~2000; a 3-position switch is ~1000 / ~1500 / ~2000.
4. **Assign** ranges that bracket the measured value with margin:
   - `bf modes set ARM --aux 1 --range 1700-2100`
   - `bf modes set ANGLE --aux 2 --range 900-1300`
   - `bf modes set HORIZON --aux 2 --range 1300-1700`
   - `bf modes set BEEPER --aux 3 --range 1700-2100`
   - `bf modes set "FLIP OVER AFTER CRASH" --aux 4 --range 1700-2100`
5. **Verify** with `bf modes list --json`. Then, switch by switch, check that `bf status --json` → `activeModes` changes as expected (ARM won't show as active while arming flags are set; that's fine).

## Notes
- `set` updates the existing range of a mode. Use `--add` for a second range (e.g. ARM on two switches with `--logic OR`).
- Remove a mode with `bf modes remove ANGLE`.
- Airmode is usually always on via `feature AIRMODE`.

## Error handling
- `unknown mode`: use a name from `bf modes available`. Some modes only appear when their feature or hardware is present (GPS RESCUE needs GPS).
