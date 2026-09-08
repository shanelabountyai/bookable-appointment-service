/**
 * A-102 — the perishable supply the perishable-supply screen could not see.
 *
 * A no-show keeps her time on the book (D-7, right), so a 90-minute colour
 * marked no-show at ten past leaves eighty minutes blocked and `/staff/opened`
 * showing **0**: that list reads `SLOT_FREEING_STATUSES` and the event log, and
 * an unreleased no-show writes neither.
 *
 * THE FIXTURE IS ANCHORED TO THE REAL CLOCK, and it has to be. Every other day
 * spec in this suite pins `?day=` to a Tuesday the roster works, because a spec
 * that trusts the wall clock passes on a Tuesday and fails on a Sunday — but
 * "there is still time to give back" is a statement about NOW being inside the
 * appointment, and a pinned past Tuesday can never be that. So the appointment
 * is built around `new Date()` instead, and the day is never mentioned: nothing
 * this spec touches has a roster, a working-hours window or a `?day=` in it.
 * `listUnreleasedNoShows` has no availability bound for the same reason the
 * salon has none — a chair nobody is sitting in is empty whatever the rota says.
 */
import { expectNoAxeViolations } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';
import { fromDate, instant, toDate, toLabel, zoneId } from '@bookable/core/time';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

const MIN = 60_000;

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

/**
 * Ada's Cut with Dana, running RIGHT NOW and marked no-show: it started ten
 * minutes ago and has thirty-five minutes of body left, plus the Cut's own
 * ten-minute after-buffer on top.
 *
 * A CUT RATHER THAN A COLOUR, deliberately: the seeded Colour carries SEGMENTS
 * that must sum to its duration, and a hand-written row whose body does not
 * match them is a row the product cannot produce.
 *
 * THE BUFFER COLUMNS ARE COPIED OFF THE SERVICE and `blockedEnd` is left to the
 * trigger (CLAUDE.md): a fixture that omits them stores an envelope equal to
 * the body, which is a row the product cannot produce and would silently
 * under-report every minute this screen exists to sell.
 */
async function noShowRunningNow(): Promise<{ minutes: number; startedAt: string }> {
  const prisma = new PrismaClient();
  try {
    const business = await prisma.business.findFirstOrThrow();
    const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
    const client = await prisma.client.create({
      data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
    });

    // FLOORED TO THE WHOLE MINUTE: `blockedEnd` carries a CHECK requiring one,
    // and `new Date()` has milliseconds on it.
    const nowMinute = Math.floor(fromDate(new Date()) / MIN) * MIN;
    const startAt = toDate(instant(nowMinute - 10 * MIN));
    const endAt = toDate(instant(nowMinute + 35 * MIN));
    const label = toLabel(fromDate(startAt), zoneId(business.timezone));

    await prisma.appointment.create({
      data: {
        businessId: business.id,
        providerId: dana.id,
        clientId: client.id,
        status: 'no_show',
        startAt,
        endAt,
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: label.day,
        startWallTime: label.time,
        lines: {
          create: {
            businessId: business.id,
            serviceId: service.id,
            ordinal: 0,
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
          },
        },
      },
    });

    // What the desk is offered: from now to the far end of the ENVELOPE, so
    // the after-buffer is in it — that is the span the release actually frees.
    return { minutes: 35 + service.bufferAfterMinutes, startedAt: label.time };
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeEach(async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await signIn(page);
});

test.describe('a no-show nobody has given back (A-102)', () => {
  test('reaches the release from the shell, and the freed time lands on the same screen', async ({ page }) => {
    const { minutes, startedAt } = await noShowRunningNow();

    // THE DOOR FIRST. Before this item the badge counted the freed list alone,
    // so the nav read "Opened up 0" over the forty-five minutes below — the same
    // invisibility as the screen's, one layer up.
    await page.goto('/staff/day');
    const tab = page.getByRole('link', { name: 'Opened up 1' });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(page).toHaveURL(/\/staff\/opened$/);

    await expect(page.getByRole('heading', { name: 'Nobody came — still blocked' })).toBeVisible();
    await expect(page.getByText(new RegExp(`${startedAt} · ${minutes} min still blocked`))).toBeVisible();
    await expect(page.getByText('Ada Chen never came, and the rest of the slot is still on the book')).toBeVisible();
    // The reason D-44 refused a timer: one more ring before anybody gives it up.
    await expect(page.getByRole('link', { name: '5125550101' })).toHaveAttribute('href', 'tel:5125550101');

    await page.getByRole('button', { name: `Put ${minutes} min back on the market` }).click();

    // THE ROW MOVES BETWEEN THE TWO LISTS, which is the whole shape of the
    // screen: the decision is taken, so it stops being a decision and becomes
    // supply. Asserting only that the button worked would pass against a
    // release that freed nothing anybody can sell.
    await expect(page.getByRole('heading', { name: 'Nobody came — still blocked' })).toBeHidden();
    await expect(page.getByText('Ada Chen never came — the rest of the time was put back')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Who wants this slot?' })).toBeVisible();
  });

  /**
   * The offer and the write are ONE predicate now (`releasableAt`). They used
   * to be a whole after-buffer apart — the panel asked whether the ENVELOPE was
   * over and the write refuses once the BODY is — so for the twenty minutes
   * after every no-show ended, the detail screen drew a button the server
   * refused. This asserts the screen from the outside: her time is over, so
   * nothing anywhere offers to sell it.
   */
  test('offers nothing once her visit is over, on either screen', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      const business = await prisma.business.findFirstOrThrow();
      const dana = await prisma.provider.findFirstOrThrow({ where: { displayName: 'Dana' } });
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'Cut' } });
      const client = await prisma.client.create({
        data: { businessId: business.id, name: 'Ada Chen', phone: '5125550101' },
      });
      const nowMinute = Math.floor(fromDate(new Date()) / MIN) * MIN;
      // Her body ended five minutes ago and the after-buffer has NOT: the exact
      // window where the two questions used to disagree.
      const startAt = toDate(instant(nowMinute - 50 * MIN));
      const endAt = toDate(instant(nowMinute - 5 * MIN));
      const label = toLabel(fromDate(startAt), zoneId(business.timezone));
      expect(service.bufferAfterMinutes).toBeGreaterThan(5);

      const appointment = await prisma.appointment.create({
        data: {
          businessId: business.id,
          providerId: dana.id,
          clientId: client.id,
          status: 'no_show',
          startAt,
          endAt,
          bufferBeforeMinutes: service.bufferBeforeMinutes,
          bufferAfterMinutes: service.bufferAfterMinutes,
          blockedStart: startAt,
          blockedEnd: endAt,
          startDay: label.day,
          startWallTime: label.time,
          lines: {
            create: {
              businessId: business.id,
              serviceId: service.id,
              ordinal: 0,
              priceCents: service.priceCents,
              durationMinutes: service.durationMinutes,
            },
          },
        },
      });

      await page.goto('/staff/opened');
      await expect(page.getByRole('heading', { name: 'Nobody came — still blocked' })).toBeHidden();

      await page.goto(`/staff/appointments/${appointment.id}`);
      await expect(page.getByText('Ada Chen').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /back on the market/ })).toBeHidden();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    await noShowRunningNow();
    await page.goto('/staff/opened');
    await expect(page.getByRole('heading', { name: 'Nobody came — still blocked' })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
