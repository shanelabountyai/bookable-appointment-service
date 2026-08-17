/**
 * A-013 — the rate limiter (TOKEN-02).
 *
 * `now` is supplied by every test, so the window is advanced by arithmetic
 * rather than by sleeping. A limiter tested with a real clock is a limiter
 * whose window can only be tested at one length.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../core/time';
import { PrismaClient } from './generated/client/index.js';
import { consumeRateLimit } from './rate-limit';
import { resetDatabase } from './testing';

const prisma = new PrismaClient();

const NOW = toDate(instantFromIso('2026-06-09T08:00:00-05:00'));
const WINDOW_MS = 60_000;
const LIMIT = 3;

const consume = (key: string, now: Date) => consumeRateLimit(prisma, { key, limit: LIMIT, windowMs: WINDOW_MS, now });
const plus = (ms: number) => toDate(instant(fromDate(NOW) + ms));

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('consumeRateLimit', () => {
  it('allows exactly the limit, then refuses', async () => {
    expect(await consume('a', NOW)).toBe(true);
    expect(await consume('a', NOW)).toBe(true);
    expect(await consume('a', NOW)).toBe(true);
    expect(await consume('a', NOW)).toBe(false);
  });

  it('counts each key separately', async () => {
    for (let i = 0; i < LIMIT + 1; i++) await consume('a', NOW);
    // A namespaced key per caller: one caller exhausting its budget must not
    // close the door on everyone else.
    expect(await consume('b', NOW)).toBe(true);
  });

  it('opens a fresh window once the old one has passed', async () => {
    for (let i = 0; i < LIMIT + 1; i++) await consume('a', NOW);
    expect(await consume('a', plus(WINDOW_MS))).toBe(true);
  });

  it('does not open a fresh window one millisecond early', async () => {
    for (let i = 0; i < LIMIT + 1; i++) await consume('a', NOW);
    expect(await consume('a', plus(WINDOW_MS - 1))).toBe(false);
  });

  it('keeps counting while refused, so hammering keeps the door shut', async () => {
    for (let i = 0; i < 10; i++) await consume('a', NOW);
    const row = await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key: 'a' } });
    expect(row.count).toBe(10);
    // The window opened at the FIRST request, not at the last — otherwise a
    // caller sending one request per second would hold it open forever.
    expect(row.windowStart.toISOString()).toBe(NOW.toISOString());
  });

  /**
   * THE REASON IT IS ONE STATEMENT.
   *
   * Read-then-write — even inside a transaction, under READ COMMITTED — lets
   * two concurrent requests both read 2 and both write 3, and the limit is
   * then whatever concurrency happens to be. This asserts the count reflects
   * every caller, not the last writer.
   */
  it('loses no count under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => consume('a', NOW)));
    expect(results.filter(Boolean)).toHaveLength(LIMIT);
    expect((await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key: 'a' } })).count).toBe(12);
  });
});
