import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist", "betaflight", "betaflight-configurator", "node_modules"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Layer 1 (core API) must never depend on Layer 2 (CLI formatting/transport).
        files: ["src/core/**/*.ts"],
        rules: {
            "no-restricted-imports": ["error", { patterns: [{ group: ["**/cli/**", "commander"], message: "src/core must not import the CLI layer" }] }],
            "no-console": "error",
        },
    },
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
);
