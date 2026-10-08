# Backups, restore, cloning, firmware updates

**Goal:** never lose a configuration; update firmware safely.

**Tools:** `bf config backup/restore/apply/diff`, `bf firmware detect/releases/build/flash/dfu-devices`.

## Backup and restore
- Back up with `bf config backup -o <name>.txt`. This is `diff all`, the standard Betaflight format; Configurator's CLI tab can load it too.
- **Full restore** (reset + replay + reboot):
  1. Preview: `bf config restore <file> --dry-run --json`. Check `warnings` for a board or firmware mismatch.
  2. With user consent: `bf config restore <file> --confirm`.
- **Partial or merge restore** (no reset): `bf config apply <file> --dry-run`, then `bf config apply <file>`.
- **Clone a config to another quad of the same model:** apply the backup to the other FC with `bf config apply`. Skip lines with hardware ids by removing `mcu_id`/`signature`/`board_name` lines first.

## Firmware update (only on explicit user request)
1. Run `bf firmware detect --json`. It reports `buildTarget` and the current `firmware`.
2. List releases with `bf firmware releases <target> --json`. Recommend the newest `Stable`.
3. **Build:**
   - Pick options to match the current setup: radio protocol (CRSF/SBUS/...), and features like GPS, LED_STRIP and OSD. `bf firmware options <release> --json` lists them.
   - `bf firmware build <target> --release <r> --option CRSF --option USE_GPS -o fw.hex`
4. **Flash** (after the user confirms): `bf firmware flash fw.hex --confirm`.
   - It backs up automatically, reboots to DFU, flashes, verifies and waits for the FC.
   - Major version jumps change settings. Don't use `--restore` across major versions; re-apply settings with `bf config apply <backup>` instead and review the failed lines.
5. **Check:** `bf info`, `bf status`, then `bf calibrate acc` (needed after a full erase).

## Error handling
- `NO_DFU` on Linux: the udev rule is missing for 0483:df11. The user needs:
  `SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0664", GROUP="plugdev"`
- **Board stuck in DFU after a failed flash:** `bf firmware dfu-devices` shows it. Re-run `bf firmware flash fw.hex --confirm`; it flashes a DFU device directly.
- **Never flash a hex for a different target.** Check that the target in the filename matches `bf firmware detect`.
