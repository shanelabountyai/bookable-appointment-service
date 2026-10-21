/**
 * W-001 — API keys on /staff/integrations (API PRD §5), and the audit line an
 * integration's write leaves ("Booked by HubSpot sync via the API").
 *
 * The key is shown ONCE, is the real credential (it resolves through the same
 * function the API uses), is never on the page afterwards, and the whole page
 * is closed to a stylist — by the route, not by a hidden link.
 */
import type { Page } from '@playwright/test';
import { apiActor, staffActor } from '@bookable/core/auth';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { issueApiKey, resolveApiKey } from '@bookable/db/api';
import { bookAppointment } from '@bookable/db/booking';
import { seedSetup } from '@bookable/db/settings';
import { expectNoAxeViolations, SERIOUS } from './axe';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test.describe('API keys', () => {
  test('owner issues a key with chosen scopes, sees it once, and it resolves to this salon', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await page.goto('/staff');
      await page.getByRole('link', { name: /Integrations/ }).click();
      await expect(page).toHaveURL(/\/staff\/integrations$/);
      const section = page.getByRole('region', { name: 'API keys' });
      await expect(section.getByText('No keys issued.')).toBeVisible();

      await section.getByLabel('Label').fill('HubSpot sync');
      await section.getByRole('checkbox', { name: /^Write/ }).check();
      await section.getByRole('checkbox', { name: /^Prices/ }).check();
      await section.getByRole('button', { name: 'Issue key' }).click();
      await expect(section.getByText('Copy this now — it is shown once.')).toBeVisible();
      const shown = (await section.locator('output').textContent()) ?? '';
      expect(shown).toMatch(/^bk_api_[A-Za-z0-9_-]{43}$/);

      const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
      const grant = await resolveApiKey(prisma, shown, new Date());
      expect(grant).toMatchObject({ businessId: owner.businessId, label: 'HubSpot sync', scopes: ['read', 'write', 'prices'] });

      await expectNoAxeViolations(page, { tags: null, impacts: SERIOUS });

      await page.reload();
      await expect(page.getByRole('region', { name: 'API keys' }).getByText('HubSpot sync')).toBeVisible();
      await expect(page.getByText(/last used/)).toBeVisible();
      // Not in the HTML at all, not merely hidden.
      expect(await page.content()).not.toContain(shown);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a label is required, and the refusal says so', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/integrations');
    const section = page.getByRole('region', { name: 'API keys' });
    await section.getByRole('button', { name: 'Issue key' }).click();
    await expect(section.getByText(/Give the key a label/)).toBeVisible();
    await expect(section.locator('output')).toHaveCount(0);
  });

  test('revoking ends the key on the next request and the row says so', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await page.goto('/staff/integrations');
      const section = page.getByRole('region', { name: 'API keys' });
      await section.getByLabel('Label').fill('n8n flow');
      await section.getByRole('button', { name: 'Issue key' }).click();
      const shown = (await section.locator('output').textContent()) ?? '';
      expect(await resolveApiKey(prisma, shown, new Date())).not.toBeNull();

      await section.getByRole('button', { name: 'Revoke n8n flow' }).click();
      await expect(section.getByText('Revoked.')).toBeVisible();
      await expect(section.getByText('revoked', { exact: true })).toBeVisible();
      expect(await resolveApiKey(prisma, shown, new Date())).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a stylist is turned away from the page and does not see the link', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await prisma.staffUser.updateMany({ where: { email: STAFF_EMAIL }, data: { role: 'staff' } });
      await page.goto('/staff');
      await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Integrations/ })).toHaveCount(0);
      await page.goto('/staff/integrations');
      await expect(page).toHaveURL(/\/staff\/day/);
      await expect(page.getByRole('region', { name: 'API keys' })).toHaveCount(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

test('an API booking reads "by HubSpot sync via the API" in the history; a desk booking does not', async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    const { businessId, providerIds, serviceIds } = await seedSetup(prisma);
    const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
    const key = await issueApiKey(prisma, { businessId, issuedById: owner.id, label: 'HubSpot sync', scopes: ['read', 'write'], now: new Date() });
    const now = toDate(instantFromIso('2026-06-09T14:00:00Z'));
    const book = (actor: ReturnType<typeof staffActor>, iso: string) =>
      bookAppointment(prisma, { businessId, providerId: providerIds[0]!, serviceIds: [serviceIds[0]!], startAt: toDate(instantFromIso(iso)), now, actor, audience: 'staff' });
    const viaApi = await book(apiActor(key.id), '2026-06-10T15:00:00Z');
    const viaDesk = await book(staffActor(owner.id), '2026-06-10T16:00:00Z');

    await signIn(page);
    await page.goto(`/staff/appointments/${viaApi.id}`);
    await expect(page.getByText('Booked by HubSpot sync via the API.')).toBeVisible();
    await page.goto(`/staff/appointments/${viaDesk.id}`);
    await expect(page.getByText(/Booked by/)).toBeVisible();
    await expect(page.getByText(/via the API/)).toHaveCount(0);
  } finally {
    await prisma.$disconnect();
  }
});
