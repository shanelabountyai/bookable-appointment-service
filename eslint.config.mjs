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
);
