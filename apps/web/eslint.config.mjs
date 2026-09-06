import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { noAxisCrossingRules } from "../../eslint-rules/no-axis-crossing.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // D-3 (CLAUDE.md "The time rules"): banned repo-wide, UI included.
  { rules: { ...noAxisCrossingRules } },
  // A-096. A spec that builds its own axe run gets Playwright's DEFAULT colour
  // scheme, which is light — and half of a palette that flips with
  // `prefers-color-scheme` then goes unmeasured. That is not hypothetical: it
  // hid 275 colour-contrast nodes across twelve staff routes behind forty
  // green axe runs. `e2e/axe.ts` is the one door, and it runs both schemes.
  {
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@axe-core/playwright",
              message:
                "Use `expectNoAxeViolations` from ./axe — it runs BOTH colour schemes. A spec-local AxeBuilder measures the light one only (A-096).",
            },
          ],
        },
      ],
    },
  },
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
