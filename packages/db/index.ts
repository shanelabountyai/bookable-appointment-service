/**
 * The Prisma client singleton. One instance shared by the whole app.
 *
 * Reused across hot reloads in dev, so `next dev` doesn't open a new
 * connection pool on every file edit — a fresh `PrismaClient` per HMR pass
 * exhausts Postgres's connection limit within a few dozen saves.
 */
// Explicit .js extension, not the bare './generated/client' directory: Next.js
// and Vite's bundler resolution paper over a directory import, but plain Node
// running a script directly does not, and fails with ERR_UNSUPPORTED_DIR_IMPORT.
// The extension is correct either way — it's the file Prisma actually emits.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from './generated/client/index.js';

// D-65. On Vercel this client is bundled, and a bundled client searches for its
// query engine under /var/task/apps/web, where it never is. next.config traces
// the engine to /var/task/packages/db/…; name it here. Not a Vercel env var:
// `prisma generate` reads that variable at BUILD time and fails when the path
// does not exist on the build machine. Set only when the file is actually
// there, so local runs, CI and the build never see it. The engine loads on the
// first query, not at import, so setting it here is early enough.
const tracedEngine = join(
  process.cwd(),
  '../../packages/db/generated/client/libquery_engine-rhel-openssl-3.0.x.so.node',
);
if (process.env.VERCEL && !process.env.PRISMA_QUERY_ENGINE_LIBRARY && existsSync(tracedEngine)) {
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = tracedEngine;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from './generated/client/index.js';
