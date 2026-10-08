# Rates

**Goal:** set stick feel (max rotation rate and expo).

**Tools:** `bf rates get/set`, `bf rateprofile`, `bf presets search --category RATES`.

## Workflow
1. Run `bf rates get --json` and check `rates_type`. ACTUAL is the default since 4.3.
2. **ACTUAL rates mean:**
   - `<axis>_rc_rate`: center sensitivity in deg/s ÷ 10
   - `<axis>_srate`: max rate in deg/s ÷ 10
   - `<axis>_expo`: expo × 100
3. **Example**, 670 deg/s max with 70 center and some expo on roll/pitch:
   `bf rates set roll.rc_rate=7 roll.rate=67 roll.expo=0 pitch.rc_rate=7 pitch.rate=67 pitch.expo=0`
4. **A different rate profile per pilot/purpose:** `bf rates set ... --profile 2`, then `bf rateprofile select 2`.
5. **Presets:** `bf presets search --category RATES --json`. Note that presets write to the *active* rate profile.
