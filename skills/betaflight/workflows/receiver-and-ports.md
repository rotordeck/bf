# Receiver and UART setup

**Goal:** get RC input working (ELRS/CRSF, SBUS, ...) and assign UART functions.

**Tools:** `bf serial list/port/set`, `bf receiver get/set/map/live/bind`, `bf feature`.

## Workflow
1. **Find where the receiver is wired.** Ask the user which pad (e.g. "RX2/TX2" means UART2).
2. **See how this firmware assigns ports:** `bf serial list --json`.
   - `style: "serial"` (classic firmware): run `bf serial port UART2 --functions RX`. Keep the existing functions you still need, e.g. `--functions RX,MSP`.
   - `style: "uart-settings"` (newer firmware): run `bf serial set rx_uart=UART2`. List the assignable functions with `bf serial get --json`.
3. **Pick the protocol:** `bf receiver set serialrx_provider=CRSF`. CRSF is right for ELRS and TBS Crossfire. Others are SBUS, IBUS, FPORT, GHST, SRXL2, and so on. List them with `bf setting info serialrx_provider --json`. Serial receivers need the `RX_SERIAL` feature: `bf feature enable RX_SERIAL`.
4. **Reboot** if `rebootRequired` is true: `bf reboot --wait`.
5. **Verify** with `bf receiver live --watch --json --interval 300`. Ask the user to move each stick and switch, and check:
   - roll, pitch, yaw and throttle move the right channel and go 1000..2000 with ~1500 center
   - the AUX channels change with the switches
6. **Fix a wrong channel order:** `bf receiver map TAER1234` (or what the radio uses; ELRS/CRSF is normally AETR1234).
7. **Center/endpoint drift:** set `rc_smoothing` defaults, or adjust endpoints in the radio. `min_check`/`max_check` are under `bf receiver get`.
8. **ELRS binding phrase / bind:**
   - `bf receiver bind` works where supported.
   - ELRS normally binds via its phrase in the receiver's own web UI.
   - SPI ELRS receivers use `bf receiver set expresslrs_uid=...`.

## Error handling
- No change in `bf receiver live`: wrong UART (TX/RX swapped, or the wrong UART number), wrong provider, `RX_SERIAL` disabled, or no reboot after the change.
- Values stuck at 1500 with RXLOSS: the receiver isn't bound, or the transmitter is off.
- Inverted SBUS on F4 boards: `bf receiver set serialrx_inverted=ON` only when the board lacks an inverter (rare).
