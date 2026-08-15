import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { noAxisCrossingRules } from "../../eslint-rules/no-axis-crossing.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // D-3 (CLAUDE.md "The time rules"): banned repo-wide, UI included.
  { rules: { ...noAxisCrossingRules } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
