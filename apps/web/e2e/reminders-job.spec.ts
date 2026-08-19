/**
 * A-022 — the reminder job's route (NOTIF-02, NOTIF-03).
 *
 * Seeded relative to the REAL clock, not a fixed date: the route reads
 * `new Date()` itself (the one legitimate boundary — an external scheduler
 * calls it), so nothing here can freeze `now` the way the db-layer test does.
 */
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { fromDate, instant, toDate, toLabel, zoneId } from '@bookable/core/time';
import { expect, test } from './fixtures';

const SECRET = process.env.CRON_SECRET;
if (!SECRET) throw new Error('CRON_SECRET must be set in .env.test to run this spec.');

test.beforeEach(async () => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/** An appointment starting a couple of minutes into the job's 5-minute
 *  window — safe against ordinary test latency without drifting out. */
async function seedDueTomorrow(): Promise<{ appointmentId: string; clientId: string }> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const provider = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' },
    });

    // The whole-minutes check constraint (appointment_instants_whole_minutes)
    // means `new Date()`'s own seconds/milliseconds have to go — floored, not
    // rounded, so the result never drifts forward out of the window.
    const nowMs = fromDate(new Date());
    const nowWholeMinute = nowMs - (nowMs % 60_000);
    const startInstant = instant(nowWholeMinute + 24 * 60 * 60_000 + 2 * 60_000);
    const endInstant = instant(startInstant + 45 * 60_000);
    const startAt = toDate(startInstant);
    const endAt = toDate(endInstant);
    const label = toLabel(startInstant, zoneId(business.timezone));

    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: provider.id,
        clientId: client.id,
        status: 'booked',
        startAt,
        endAt,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: label.day,
        startWallTime: label.time,
        lines: {
          create: { businessId: business.id, serviceId: service.id, ordinal: 0, priceCents: 5500, durationMinutes: 45 },
        },
      },
    });
    return { appointmentId: appointment.id, clientId: client.id };
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('the reminder job route (A-022)', () => {
  test('refuses without the bearer secret', async ({ page }) => {
    const response = await page.request.get('/api/jobs/reminders');
    expect(response.status()).toBe(401);
  });

  test('refuses the wrong secret, the same as no secret at all', async ({ page }) => {
    const response = await page.request.get('/api/jobs/reminders', {
      headers: { authorization: 'Bearer not-the-real-secret' },
    });
    expect(response.status()).toBe(401);
  });

  test('enqueues and sends a reminder whose link opens the right appointment', async ({ page }) => {
    await seedDueTomorrow();

    const response = await page.request.get('/api/jobs/reminders', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.reminders).toMatchObject({ due: 1, enqueued: 1, duplicate: 0 });
    expect(body.dispatch.sent).toBeGreaterThanOrEqual(1);

    const prisma = new PrismaClient();
    try {
      const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { template: 'appointment.reminder' } });
      expect(row.status).toBe('sent');
      const payload = row.payload as { manageUrl: string };

      // NOTIF-03: the link IS the confirm/cancel action surface (A-021).
      await page.goto(payload.manageUrl);
      await expect(page.getByRole('heading', { name: 'Your appointment' })).toBeVisible();
      await expect(page.getByRole('button', { name: "I'll be there" })).toBeVisible();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('running twice does not send the same reminder twice', async ({ page }) => {
    await seedDueTomorrow();

    await page.request.get('/api/jobs/reminders', { headers: { authorization: `Bearer ${SECRET}` } });
    const second = await page.request.get('/api/jobs/reminders', { headers: { authorization: `Bearer ${SECRET}` } });
    const body = await second.json();
    expect(body.reminders).toMatchObject({ enqueued: 0, duplicate: 1 });

    const prisma = new PrismaClient();
    try {
      expect(await prisma.notificationOutbox.count({ where: { template: 'appointment.reminder' } })).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
