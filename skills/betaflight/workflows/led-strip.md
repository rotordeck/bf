# LED strip

**Goal:** configure LED positions, functions and colors.

**Tools:** `bf feature enable LED_STRIP`, `bf led get/set/list/colors/apply`.

## Workflow
1. Run `bf feature enable LED_STRIP`, then `bf reboot --wait`.
2. Check the current layout with `bf led list --json` and the palette with `bf led colors --json`.
3. **Set LEDs in the CLI format** `led <index> <x>,<y>:<directions NESWUD>:<functions>:<color>`:
   - Functions: C = color, F = flight mode, A = armed state, W = warnings, I = indicator, R = ring, T = thrust, B = blink, O = larson.
   - Example: `bf led apply 'led 0 0,0:N:FW:0' 'led 1 1,0:N:FW:0'`
4. **Global options:** `bf led set ledstrip_brightness=50 ledstrip_profile=STATUS` (names from `bf led get --json`).

## Error handling
- Exit 5: this firmware build has no LED strip support. A rebuild with LED_STRIP is needed (see `backup-restore-update-firmware.md`).
