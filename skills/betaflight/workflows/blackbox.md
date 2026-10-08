# Blackbox logging

**Goal:** record flight data for tuning and diagnosis, and get logs off the craft.

**Tools:** `bf blackbox get/set/info/download/erase/msc`.

## Workflow
1. Run `bf blackbox info --json`: the device (SPIFLASH/SDCARD/NONE) and flash usage.
2. **Configure:**
   - `bf blackbox set blackbox_device=SPIFLASH blackbox_sample_rate=1/2` and `bf system set debug_mode=GYRO_SCALED`
   - Find setting names with `bf blackbox get --json`. Find debug modes with `bf setting info debug_mode`.
   - Put logging on a switch (`bf modes set BLACKBOX ...`), or log always (`blackbox_mode`).
3. **Download** after flying: `bf blackbox download -o flight.bbl`. Typical speed is ~50–150 KiB/s.
4. **Erase** only after a successful download and with consent: `bf blackbox erase --confirm`.
5. **SD card logs:** `bf blackbox msc --confirm` reboots the FC as a USB drive. Copy the files, then the user must unplug it.

## Error handling
- `dataflash is not ready`: still erasing, wait.
- Exit 5 on download: no onboard flash (SD card or no logging device).
