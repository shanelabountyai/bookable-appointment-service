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
import { PrismaClient } from './generated/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from './generated/client/index.js';
