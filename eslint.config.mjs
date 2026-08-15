import tseslint from 'typescript-eslint';
import { noAxisCrossingRules } from './eslint-rules/no-axis-crossing.mjs';

// Covers packages/**. apps/web has its own eslint.config.mjs (next lint needs
// its own plugin wiring) — root `npm run lint` runs both.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'apps/**',
      'packages/db/prisma/migrations/**',
      // Generated Prisma client — not ours to lint, and gitignored.
      'packages/db/generated/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...noAxisCrossingRules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // packages/core/time is the sanctioned axis boundary: it owns toDate/fromDate,
    // which are the only permitted `new Date(...)` in the repo. Everything else
    // keeps the full ban.
    files: ['packages/core/time/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Temporal at the boundary ONLY (CLAUDE.md, spec §5). The engine core is
    // integer epoch-millis arithmetic — DST-proof by construction and
    // library-free. packages/core/time is the sole exception.
    files: ['packages/**/*.ts'],
    ignores: ['packages/core/time/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'temporal-polyfill',
              message:
                'Temporal is confined to packages/core/time (spec §5). Resolve to Instants at the boundary, then do all arithmetic on epoch-millisecond integers.',
            },
          ],
        },
      ],
    },
  },
);
