# PID and filter tuning

**Goal:** adjust tuning safely and reversibly.

**Tools:** `bf tuning get/set` (sliders), `bf pid get/set`, `bf pid-advanced`, `bf filters`, `bf profile`, `bf presets`, `bf blackbox`.

## Workflow
1. **Back up:** `bf config backup -o before-tune.txt`.
2. **Work on a spare profile so the user can switch back in the field:**
   - `bf profile list --json` shows the profiles.
   - `bf profile copy 1 2 --confirm`, then `bf profile rename 2 TUNE` (max 8 characters).
   - Edit with `--profile 2`, then activate with `bf profile select 2`.
3. **Prefer sliders** (simplified tuning) for most users. Run `bf tuning get --json`, then:
   - `bf tuning set simplified_master_multiplier=110 --profile 2`
   - `bf tuning set simplified_d_gain=110 simplified_pi_gain=100 --profile 2`
4. **Direct PIDs:** `bf pid set roll.p=48 roll.d=34 pitch.p=52 --profile 2`. Aliases are `<axis>.p|i|d|f|dmax`; raw names like `p_roll` also work.
5. **Filters:**
   - With RPM filtering (`dshot_bidir=ON`), the gyro lowpass can often be raised. Run `bf filters get --json`.
   - Change filters in small steps (10–20%), for example `bf tuning set simplified_gyro_filter_multiplier=120`.
6. **Verify with logs:** see `blackbox.md`. Suggest the user fly, then download the log for analysis (PIDtoolbox, Blackbox Explorer).
7. **Revert** by selecting the previous profile, or with `bf config restore before-tune.txt --confirm`.

## Error handling
- Exit 2 with `allowed range`: stay within the range. Values are integers (e.g. gains are ×1).
- Hot motors after a change: revert immediately (D-term and filter changes are the usual cause).
