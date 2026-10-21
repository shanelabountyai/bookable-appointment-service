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

/**
 * W-011 — webhooks on the owner page, against the REFERENCE receiver on a
 * real port (WEBHOOK_ALLOW_PRIVATE=1 in .env.test, W-D21). The Replay click
 * also proves the INLINE carrier: the owner's server action passes through
 * `readDesk`, whose `after()` sweep delivers the replay with no cron call.
 */
test('webhooks: register (secret once), deliver, log, replay inline, switch off', async ({ page }) => {
  const prisma = new PrismaClient();
  const { startReceiver } = await import('../../../scripts/webhook-receiver');
  const lines: string[] = [];
  let secret = '';
  const secrets: string[] = []; // read per request, so the secret can be added once the page shows it
  const server = await startReceiver({ port: 0, secrets, log: (l) => lines.push(l) });
  try {
    const { businessId, providerIds, serviceIds } = await seedSetup(prisma);
    const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
    const url = `http://localhost:${(server.address() as { port: number }).port}/`;

    await signIn(page);
    await page.goto('/staff/integrations');
    const hooks = page.getByRole('region', { name: 'Webhooks' });
    await expect(hooks.getByText('No endpoints registered.')).toBeVisible();
    await hooks.getByLabel('URL').fill(url);
    await hooks.getByRole('button', { name: 'Register endpoint' }).click();
    await expect(hooks.getByText(/Copy the signing secret now/)).toBeVisible();
    secret = (await hooks.locator('output').textContent()) ?? '';
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    secrets.push(secret);
    await expectNoAxeViolations(page, { tags: null, impacts: SERIOUS });

    // A booking the browser did not make, delivered by the sweep route.
    await bookAppointment(prisma, {
      businessId,
      providerId: providerIds[0]!,
      serviceIds: [serviceIds[0]!],
      startAt: toDate(instantFromIso('2099-06-10T15:00:00Z')),
      now: new Date(),
      actor: staffActor(owner.id),
      audience: 'staff',
    });
    const res = await page.request.get('/api/jobs/webhooks', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(res.status()).toBe(200);
    await expect.poll(() => lines.join('\n')).toMatch(/VERIFIED #\d+ appointment\.booked/);

    await page.reload();
    const log = page.getByRole('region', { name: 'Delivery log' });
    await expect(log.getByText('appointment.booked', { exact: true })).toBeVisible();
    await expect(log.getByRole('listitem').getByText('succeeded', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(secret);

    await log.getByRole('button', { name: /Replay delivery #\d+ appointment\.booked/ }).click();
    await expect(log.getByText('Queued to send again.')).toBeVisible();
    // No cron call: the action's own after() sweep sends it.
    await expect.poll(() => lines.join('\n'), { timeout: 15_000 }).toMatch(/duplicate .* \(attempt 1\)/);

    await page.reload();
    await page.getByRole('region', { name: 'Webhooks' }).getByRole('button', { name: 'Switch off' }).click();
    await expect(page.getByText('Switched off by the owner.')).toBeVisible();
    expect((await prisma.webhookEndpoint.findFirstOrThrow()).status).toBe('disabled');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  }
});
