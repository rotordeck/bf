#!/usr/bin/env bash
# Regenerates src/core/msp/codes.ts from the firmware MSP protocol headers.
set -euo pipefail
cd "$(dirname "$0")/.."
F=${BETAFLIGHT_SRC:-betaflight}/src/main/msp
{
echo "// Generated from firmware msp_protocol.h, msp_protocol_v2_common.h, msp_protocol_v2_betaflight.h."
echo "// Regenerate with scripts/gen-msp-codes.sh when the firmware headers change."
echo "export const MSP = {"
cat $F/msp_protocol.h $F/msp_protocol_v2_common.h $F/msp_protocol_v2_betaflight.h | grep -E '^#define\s+MSP2?_[A-Z0-9_]+\s+(0x[0-9A-Fa-f]+|[0-9]+)\b' | awk '{print $2, $3}' | grep -v "MSP_PROTOCOL_VERSION\|_FLAG_\|MSP2TEXT\|MSP_V2_FRAME" | awk '!seen[$1]++ {printf "    %s: %s,\n", $1, $2}'
echo "} as const;"
echo
echo "export type MspCodeName = keyof typeof MSP;"
echo
echo "const byValue = new Map<number, string>(Object.entries(MSP).map(([k, v]) => [v as number, k]));"
echo "export const mspName = (code: number): string => byValue.get(code) ?? \`MSP_\${code}\`;"
echo
echo "export const MSP2_CLI_COMMAND_FLAG_TRUNCATED = 1;"
echo "export const MSP2_CLI_COMMAND_FLAG_REFUSED = 2;"
echo
echo "/** MSP2_GET_TEXT / MSP2_SET_TEXT selectors (msp_protocol_v2_betaflight.h MSP2TEXT_*) */"
echo "export const TextType = {"
grep -E '^#define\s+MSP2TEXT_' $F/msp_protocol_v2_betaflight.h | awk '{sub("MSP2TEXT_","",$2); printf "    %s: %s,\n", $2, $3}'
echo "} as const;"
} > src/core/msp/codes.ts
