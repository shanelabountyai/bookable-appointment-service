import tseslint from 'typescript-eslint';
import { noAxisCrossingRules } from './eslint-rules/no-axis-crossing.mjs';

// Covers packages/**. apps/web has its own eslint.config.mjs (next lint needs
// its own plugin wiring) — root `npm run lint` runs both.
export default tseslint.config(
  { ignores: ['**/node_modules/**', 'apps/**', 'packages/db/prisma/migrations/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...noAxisCrossingRules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
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
