#!/usr/bin/env bash
# Report upstream Betaflight / Configurator changes since the baseline in docs/CHANGELOG.md
# that are relevant to bf. Read-only except for `git fetch` / `git clone` of the upstream
# checkouts (which are git-ignored).
#
#   scripts/upstream-check.sh            # fetch, compare baseline..origin/master
#   scripts/upstream-check.sh --no-fetch # use what is already fetched
#   TARGET_REF=v2026.12.0 scripts/upstream-check.sh   # compare against a tag/commit instead
#
# Output is Markdown on stdout; exit 0 = no relevant changes, 10 = relevant changes found.

set -euo pipefail
cd "$(dirname "$0")/.."

FETCH=1
[[ "${1:-}" == "--no-fetch" ]] && FETCH=0
TARGET_REF=${TARGET_REF:-origin/master}

declare -A URL=(
    [betaflight]=https://github.com/betaflight/betaflight.git
    [betaflight-configurator]=https://github.com/betaflight/betaflight-configurator.git
)
declare -A DIR=(
    [betaflight]=${BETAFLIGHT_SRC:-betaflight}
    [betaflight-configurator]=${CONFIGURATOR_SRC:-betaflight-configurator}
)

# Upstream path -> bf code that depends on it. Order matters for the report only.
FIRMWARE_MAP=(
    "src/main/msp/msp_protocol.h src/main/msp/msp_protocol_v2_betaflight.h src/main/msp/msp_protocol_v2_common.h|MSP command codes|src/core/msp/codes.ts (regenerate: scripts/gen-msp-codes.sh)"
    "src/main/msp/msp.c|MSP payload layouts, MSP2_CLI_* handlers|src/core/msp/messages.ts, src/core/clitext/channel.ts, src/core/services/settings.ts"
    "src/main/msp/msp_serial.c src/main/msp/msp_serial.h|framing, STX/ETX CLI entry, buffer sizes|src/core/msp/frame.ts, src/core/msp/client.ts, src/core/clitext/channel.ts"
    "src/main/msp/msp_box.c src/main/msp/msp_box.h|mode (box) names and ids|src/core/services/lists.ts (modes)"
    "src/main/cli/cli.c src/main/cli/cli.h|CLI commands and their output formats (get, diff/dump, aux, serial, led, vtxtable, ...)|src/core/services/{settings,config,lists,osd}.ts"
    "src/main/cli/settings.c src/main/cli/settings.h|setting names / lookup tables|src/core/services/groups.ts (group regexes), skills/betaflight/workflows/*"
    "src/main/fc/runtime_config.c src/main/fc/runtime_config.h|arming-disable flags|src/core/msp/messages.ts (ARMING_DISABLE_FLAG_NAMES), skills/.../troubleshoot-wont-arm.md"
    "src/main/io/serial.h|serial port function bits|src/core/services/lists.ts (SERIAL_FUNCTIONS)"
    "src/main/osd/osd.h|OSD position encoding|src/core/services/osd.ts"
    "src/main/fc/rc_adjustments.h|adjustment functions|src/core/services/lists.ts (ADJUSTMENT_FUNCTIONS)"
    "src/main/drivers/dshot_command.h|DShot command ids|src/core/msp/messages.ts (DSHOT_CMD)"
    "src/main/sensors/battery.h|battery state enum|src/core/msp/messages.ts (decodeBatteryState)"
    "src/main/target/common_post.h src/platform/SIMULATOR/target/SITL/target.h|USE_MSP_CLI_COMMAND / buffer size defaults|src/core/clitext/channel.ts"
)
CONFIGURATOR_MAP=(
    "src/js/msp.ts src/js/msp/MSPCodes.ts src/js/msp/MSPHelper.ts src/js/msp/mspBytes.ts|MSP framing and encode/decode as Configurator does it|src/core/msp/*"
    "src/js/serial_backend.ts src/js/msp/MSPConnector.js|connect handshake|src/core/session.ts"
    "src/composables/useMspCliSession.ts src/js/utils/AutoBackup.ts src/js/utils/AutoRestore.js|CLI over MSP, backup/restore procedure|src/core/clitext/channel.ts, src/core/services/config.ts"
    "src/js/protocols/devices.js|USB VID/PID of FCs and DFU bootloaders|src/core/transport/transport.ts, src/core/flash/dfu.ts"
    "src/js/protocols/usbdfu.js src/js/protocols/WebUsbDfuTransport.js src/js/protocols/UsbDfuDescriptors.js|DFU flashing|src/core/flash/dfu.ts"
    "src/js/protocols/webstm32.ts|STM32 UART bootloader|src/core/flash/stm32serial.ts"
    "src/js/workers/hex_parser.ts|HEX parsing|src/core/flash/hex.ts"
    "src/js/BuildApi.js src/composables/useCloudBuild.ts src/composables/useBoardSelection.ts|build server API|src/core/net/buildapi.ts, src/core/services/firmware.ts"
    "src/components/tabs/presets src/stores/presets.js src/stores/presets_helpers.js|presets repo and parser|src/core/net/presets.ts"
    "src/js/vue_tab_registry.js src/components/tabs|tabs (new tab = new feature to mirror)|src/cli/commands/*, skills/betaflight/SKILL.md"
    "src/composables|tab logic (motor test, mag calibration, VTX, LED, OSD, ...)|matching src/core/services/*"
    "src/js/utils/osdFont.ts src/stores/osd.ts|OSD font / elements|src/core/services/osd.ts"
)

baseline() {
    # | name | sha | date | notes |  inside the upstream-baseline block of the changelog
    sed -n '/<!-- upstream-baseline/,/<!-- \/upstream-baseline -->/p' "${BASELINE_FILE:-docs/CHANGELOG.md}" |
        awk -F'|' -v n="$1" '{gsub(/ /,"",$2); gsub(/ /,"",$3)} $2==n {print $3}'
}

relevant=0
echo "# Upstream check ($(date -u +%Y-%m-%dT%H:%MZ))"
echo

for repo in betaflight betaflight-configurator; do
    dir=${DIR[$repo]}
    if [[ ! -d "$dir/.git" ]]; then
        echo "_cloning $repo into $dir_" >&2
        git clone --quiet "${URL[$repo]}" "$dir"
    fi
    (( FETCH )) && git -C "$dir" fetch --quiet origin
    base=$(baseline "$repo")
    if [[ -z "$base" ]]; then echo "error: no baseline for $repo in docs/CHANGELOG.md" >&2; exit 2; fi
    if ! git -C "$dir" cat-file -e "$base^{commit}" 2>/dev/null; then echo "error: baseline $base not found in $dir (fetch first)" >&2; exit 2; fi
    target=$(git -C "$dir" rev-parse "$TARGET_REF")
    total=$(git -C "$dir" rev-list --count "$base..$target")

    echo "## $repo"
    echo
    echo "- baseline: \`${base:0:9}\` ($(git -C "$dir" log -1 --format=%cs "$base"))"
    echo "- target:   \`${target:0:9}\` ($(git -C "$dir" log -1 --format=%cs "$target")) \`$TARGET_REF\`"
    echo "- commits since baseline: $total"
    echo

    if [[ "$total" == 0 ]]; then echo "Up to date."; echo; continue; fi

    if [[ $repo == betaflight ]]; then map=("${FIRMWARE_MAP[@]}"); else map=("${CONFIGURATOR_MAP[@]}"); fi
    for entry in "${map[@]}"; do
        IFS='|' read -r paths what bf <<<"$entry"
        # shellcheck disable=SC2086
        commits=$(git -C "$dir" log --no-merges --format='  - `%h` %cs %s' "$base..$target" -- $paths)
        [[ -z "$commits" ]] && continue
        relevant=1
        echo "### $what"
        echo "upstream: \`$paths\` → bf: $bf"
        echo
        echo "$commits"
        echo
    done

    if [[ $repo == betaflight ]]; then
        # Concrete deltas that usually need code changes
        msp=$(git -C "$dir" diff "$base..$target" -- src/main/msp/msp_protocol*.h | grep -E '^[+-]#define\s+MSP' || true)
        [[ -n "$msp" ]] && { relevant=1; echo "### MSP code changes"; echo '```diff'; echo "$msp"; echo '```'; echo; }
        flags=$(git -C "$dir" diff "$base..$target" -- src/main/fc/runtime_config.c src/main/fc/runtime_config.h | grep -E '^[+-]\s+("|ARMING_DISABLED_)' || true)
        [[ -n "$flags" ]] && { relevant=1; echo "### Arming-disable flag changes"; echo '```diff'; echo "$flags"; echo '```'; echo; }
        sets=$(git -C "$dir" diff "$base..$target" -- src/main/cli/settings.c src/main/cli/settings.h $(git -C "$dir" grep -l 'define PARAM_NAME' "$target" -- src/main | sed "s/^$target://") |
            grep -E '^[+-]\s*(\{ *("[a-z0-9_]+"|PARAM_NAME_)|#define PARAM_NAME)' || true)
        [[ -n "$sets" ]] && { relevant=1; echo "### Setting table changes (names added/removed/renamed)"; echo '```diff'; echo "$sets" | head -80; echo '```'; echo; }
        cmds=$(git -C "$dir" diff "$base..$target" -- src/main/cli/cli.c | grep -E '^[+-]\s*CLI_COMMAND_DEF' || true)
        [[ -n "$cmds" ]] && { relevant=1; echo "### CLI command table changes"; echo '```diff'; echo "$cmds"; echo '```'; echo; }
        api=$(git -C "$dir" diff "$base..$target" -- src/main/msp/msp_protocol.h | grep -E '^[+-]#define API_VERSION' || true)
        [[ -n "$api" ]] && { relevant=1; echo "### MSP API version"; echo '```diff'; echo "$api"; echo '```'; echo; }
    else
        tabs=$(git -C "$dir" diff --name-status "$base..$target" -- src/components/tabs | grep -E '^[AD]\s.*Tab\.vue$' || true)
        [[ -n "$tabs" ]] && { relevant=1; echo "### Tabs added/removed"; echo '```'; echo "$tabs"; echo '```'; echo; }
    fi
done

if (( relevant )); then
    echo "**Relevant upstream changes found.** Follow .claude/skills/upstream-sync/SKILL.md to apply them and update docs/CHANGELOG.md."
    exit 10
fi
echo "No relevant upstream changes."
