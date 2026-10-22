/**
 * W-013 — the API's golden path end to end, over real HTTP against the
 * production build (API PRD §9, demo checkpoints 2–3):
 *
 *   key → availability → add client → book → webhook RECEIVED and VERIFIED
 *   (inline, no cron) → reschedule → second webhook → replay from the owner
 *   page at PHONE WIDTH → the receiver sees the replay marked as such.
 *
 * Then the PII sweep (Showcall L1.9d's pattern): every body the receiver got
 * and every API response this test read is searched for the client's phone
 * digits and email — none may appear, because the endpoint did not ask for
 * contacts and the key has no `contacts` scope.
 */
import { type ZoneId, addDays, fromDate, instantFromIso, toLabel } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { issueApiKey } from '@bookable/db/api';
import { seedSetup } from '@bookable/db/settings';
import { startReceiver } from '../../../scripts/webhook-receiver';
import { expectNoAxeViolations, SERIOUS } from './axe';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const PHONE = '+13125550199';
const EMAIL = 'golden.path@example.test';

test.use({ viewport: { width: 390, height: 844 } });

test('API golden path: book and reschedule through the API, both verified at the receiver, replayed from the owner page', async ({ page }) => {
  const prisma = new PrismaClient();
  const secrets: string[] = [];
  const lines: string[] = [];
  const bodies: string[] = [];
  const server = await startReceiver({ port: 0, secrets, log: (l) => lines.push(l), onEvent: (e) => bodies.push(JSON.stringify(e)) });
  const read: string[] = []; // every API response body, for the PII sweep
  try {
    const { businessId, serviceIds } = await seedSetup(prisma);
    const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
    const { key } = await issueApiKey(prisma, { businessId, issuedById: owner.id, label: 'Golden path', scopes: ['read', 'write'], now: new Date() });
    const auth = { authorization: `Bearer ${key}` };
    const api = async (method: 'GET' | 'POST', path: string, body?: unknown, idem?: string) => {
      const res = await page.request.fetch(`/api/v1${path}`, {
        method,
        headers: { ...auth, ...(idem ? { 'Idempotency-Key': idem } : {}) },
        ...(body !== undefined ? { data: body } : {}),
      });
      const text = await res.text();
      read.push(text);
      return { status: res.status(), json: JSON.parse(text) as Record<string, unknown> };
    };

    // The owner registers the receiver (the page, at phone width).
    await page.goto('/staff/login');
    await page.getByLabel('Email').fill(STAFF_EMAIL);
    await page.getByLabel('Password').fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/staff\/day/);
    await page.goto('/staff/integrations');
    const hooks = page.getByRole('region', { name: 'Webhooks' });
    await hooks.getByLabel('URL').fill(`http://localhost:${(server.address() as { port: number }).port}/`);
    await hooks.getByRole('button', { name: 'Register endpoint' }).click();
    await expect(hooks.locator('output')).toHaveText(/^whsec_/);
    secrets.push((await hooks.locator('output').textContent())!);

    // Availability for one service, any stylist, the next two weeks.
    const { timezone } = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
    const today = toLabel(fromDate(new Date()), timezone as ZoneId).day;
    const until = addDays(today, 12);
    const avail = await api('GET', `/availability?serviceIds=${serviceIds[0]}&providerId=any&from=${today}&to=${until}`);
    expect(avail.status).toBe(200);
    const days = avail.json.data as { providers: { providerId: string; starts: { startAt: string }[] }[] }[];
    const offered = days.flatMap((d) => d.providers.flatMap((p) => p.starts.map((s) => ({ providerId: p.providerId, startAt: s.startAt }))));
    const slot = offered[0]!;
    // Hours later with the same stylist, so the move clears the first booking's own footprint.
    const later = offered.find((s) => s.providerId === slot.providerId && instantFromIso(s.startAt) - instantFromIso(slot.startAt) >= 3 * 3_600_000)!;
    expect(later, 'no second start with the same stylist').toBeDefined();

    const client = await api('POST', '/clients', { name: 'Golden Path', phone: PHONE, email: EMAIL }, 'gp-client');
    expect(client.status).toBe(201);
    const booked = await api('POST', '/appointments', { clientId: client.json.id, serviceIds: [serviceIds[0]], providerId: slot.providerId, start: slot.startAt }, 'gp-book');
    expect(booked.status).toBe(201);
    const id = booked.json.id as string;

    // Inline: the receiver has it within seconds, verified — no cron call anywhere in this test.
    await expect.poll(() => lines.join('\n'), { timeout: 15_000 }).toMatch(new RegExp(`VERIFIED #\\d+ appointment\\.booked appointment=${id} `));

    const moved = await api('POST', `/appointments/${id}/reschedule`, { start: later.startAt }, 'gp-move');
    expect(moved.status).toBe(200);
    await expect.poll(() => lines.join('\n'), { timeout: 15_000 }).toMatch(new RegExp(`VERIFIED #\\d+ appointment\\.rescheduled appointment=${id} start=${later.startAt.replace(/[+]/g, '\\+')}`));

    // The catch-up door agrees with what was pushed.
    const events = await api('GET', '/events?since=0&limit=100');
    const mine = (events.json.data as { type: string; data: { appointment: { id: string } } }[]).filter((e) => e.data.appointment.id === id).map((e) => e.type);
    expect(mine).toEqual(['appointment.booked', 'appointment.rescheduled']);

    // Replay the booking from the owner page at 390 px; it arrives marked as a replay, with the BOOKED time.
    await page.goto(`/staff/integrations?type=appointment.booked`);
    const log = page.getByRole('region', { name: 'Delivery log' });
    await expect(log.getByRole('listitem')).toHaveCount(1);
    await expectNoAxeViolations(page, { tags: null, impacts: SERIOUS });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the owner page scrolls sideways at 390 px').toBeLessThanOrEqual(0);
    await log.getByRole('button', { name: /Replay delivery/ }).click();
    await expect(log.getByText('Queued to send again.')).toBeVisible();
    await expect.poll(() => lines.join('\n'), { timeout: 15_000 }).toMatch(/duplicate .* \(attempt 1\)/);

    // PII sweep: nothing the receiver got, nothing the API answered, carries her phone or email.
    const digits = PHONE.slice(-7);
    for (const text of [...bodies, ...read]) {
      expect(text).not.toContain(digits);
      expect(text).not.toContain(EMAIL);
    }
    expect(bodies.length).toBe(2); // booked + rescheduled; the replay was a duplicate to the receiver
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  }
});
