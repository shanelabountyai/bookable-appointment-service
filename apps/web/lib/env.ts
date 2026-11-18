/**
 * K11 (INV-14): the environment the web app reads, validated once at server
 * boot (instrumentation.ts) instead of failing on the first request that
 * happens to need a value.
 *
 * Only the two values without which nothing works are REQUIRED. Everything
 * else keeps the meaning its reader already gives it (CRON_SECRET unset = the
 * job routes refuse; DEMO_ACCESS_PASSWORD unset = no demo gate; and so on),
 * so this adds a boot-time check without changing what any setting does.
 *
 * `.env.example` must name every variable the code reads — this schema's keys
 * and the tool-only ones — and env.test.ts enforces that by scanning source.
 */
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  NEXT_RUNTIME: z.string().optional(), // set by Next: 'nodejs' | 'edge'
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(1), // D-9: signs the staff cookie; no default
  CRON_SECRET: z.string().min(1).optional(), // unset = /api/jobs/* refuse (fail closed)
  DEMO_ACCESS_PASSWORD: z.string().min(1).optional(), // D-65: unset = no demo gate
  NOTIFICATIONS_ENABLED: z.string().optional(), // D-14: 'false' = kill switch
  NOTIFICATIONS_SANDBOX_TO: z.string().optional(), // D-14: redirect every send here
  WEBHOOK_ALLOW_PRIVATE: z.string().optional(), // '1' = local test receivers only
  VERCEL: z.string().optional(), // set by Vercel
  PRISMA_QUERY_ENGINE_LIBRARY: z.string().optional(), // D-65: set at runtime on Vercel by packages/db
  ALLOW_CLOUD_DB: z.enum(['1']).optional(), // K12 escape hatch, tests only
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  // An empty `NAME=` line (a key waiting for its value) is unset, not an invalid empty string.
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid environment: ${keys}`); // names only — never echo values
  }
  return result.data;
}
