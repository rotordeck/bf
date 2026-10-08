# OSD and VTX

**Goal:** a readable OSD and the right VTX channel and power.

**Tools:** `bf osd elements/element/preview/get/set/font`, `bf vtx get/set/table`.

## OSD workflow
1. Run `bf osd preview` for a picture of the current layout in OSD profile 1. `bf osd elements --json` gives positions.
2. **Show, move or hide an element:**
   - `bf osd element vbat --pos 1,12 --show`
   - `bf osd element rssi --hide`
   - `--profiles 1,2` controls which OSD profiles show the element
3. **Video system:**
   - Analog: PAL is 30x16, NTSC is 30x13. Use `bf osd set vcd_video_system=PAL` if the picture rolls.
   - HD (DJI O3/O4, Walksnail, HDZero): `bf osd set osd_displayport_device=MSP` plus an MSP displayport UART (`bf serial`).
4. **Warnings and stats:** `osd_warn_bitmask` and `osd_stat_bitmask` (`bf osd get`).
5. **Analog font upload:** `bf osd font file.mcm --confirm`. The FC reboots afterwards.

## VTX workflow
1. Run `bf vtx get --json` (band, channel, power, pit mode) and `bf vtx table get --json` (the available bands and powers).
2. **Without a VTX table**, VTX control (SmartAudio/Tramp) can't select power levels:
   - Search for one: `bf presets search --category VTX`.
   - Or import the vendor's Configurator `.json`: `bf vtx table import table.json --confirm`.
3. **Set the channel:** `bf vtx set vtx_band=5 vtx_channel=1 vtx_power=2` (band 5 = Raceband in the default table).
4. **Check the UART:** SmartAudio/Tramp needs its UART function (`bf serial`).

## Error handling
- An element name is not found: use the names from `bf osd elements --all`.
- Power changes don't apply: check the VTX table power values and the protocol UART.
