/**
 * M-016 — "Booked by Sam via the assistant": the audit line the MCP PRD calls
 * the thing that makes an AI client trustworthy, on the staff detail page.
 * A booking written through the MCP server (channel `mcp`) renders with the
 * person's name and the channel; the same booking made at the desk does not.
 */
import type { Page } from '@playwright/test';
import { mcpActor, staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { bookAppointment } from '@bookable/db/booking';
import { seedSetup } from '@bookable/db/settings';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test('an MCP booking reads "via the assistant" in the history; a desk booking does not', async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    const { businessId, providerIds, serviceIds } = await seedSetup(prisma);
    const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
    const now = toDate(instantFromIso('2026-06-09T14:00:00Z'));
    const book = (actor: ReturnType<typeof staffActor>, iso: string) =>
      bookAppointment(prisma, {
        businessId,
        providerId: providerIds[0]!,
        serviceIds: [serviceIds[0]!],
        startAt: toDate(instantFromIso(iso)),
        now,
        actor,
        audience: 'staff',
      });
    const viaMcp = await book(mcpActor(owner.id), '2026-06-10T15:00:00Z');
    const viaDesk = await book(staffActor(owner.id), '2026-06-10T16:00:00Z');

    await signIn(page);
    await page.goto(`/staff/appointments/${viaMcp.id}`);
    await expect(page.getByText(/via the assistant/)).toBeVisible();
    await page.goto(`/staff/appointments/${viaDesk.id}`);
    await expect(page.getByText(/Booked/)).toBeVisible();
    await expect(page.getByText(/via the assistant/)).toHaveCount(0);
  } finally {
    await prisma.$disconnect();
  }
});
