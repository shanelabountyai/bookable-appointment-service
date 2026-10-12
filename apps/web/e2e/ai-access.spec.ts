/**
 * M-002 — AI access tokens on /staff/people (MCP PRD §5).
 *
 * The token is shown ONCE, is the real credential (it resolves through the
 * same function the MCP server will use), is never on the list afterwards,
 * and the whole section is absent for anybody who is not an owner.
 */
import { expectNoAxeViolations, SERIOUS } from './axe';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@bookable/db';
import { resolveMcpToken } from '@bookable/db/mcp';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test.describe('AI access tokens', () => {
  test('owner issues a token, sees it once, and it resolves to the person it was issued for', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await page.goto('/staff/people');
      const section = page.getByRole('region', { name: 'AI access' });
      await expect(section.getByText('No tokens issued.')).toBeVisible();

      await section.getByLabel('Label').fill("Sam's laptop");
      await section.getByRole('button', { name: 'Issue token' }).click();
      await expect(section.getByText('Copy this now — it is shown once.')).toBeVisible();
      const shown = (await section.locator('output').textContent()) ?? '';
      expect(shown).toMatch(/^bk_mcp_[A-Za-z0-9_-]{43}$/);

      const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
      const grant = await resolveMcpToken(prisma, shown, new Date());
      expect(grant).toMatchObject({ staffUserId: owner.id, businessId: owner.businessId, role: 'owner' });

      // Rendered with a token on screen and a row in the list — both schemes (A-096 runs the loop inside the helper).
      await expectNoAxeViolations(page, { tags: null, impacts: SERIOUS });

      await page.reload();
      await expect(page.getByRole('region', { name: 'AI access' }).getByText("Sam's laptop")).toBeVisible();
      await expect(page.getByText(/last used/)).toBeVisible();
      await expect(page.getByText(shown)).toHaveCount(0);
      // Not in the HTML at all, not merely hidden.
      expect(await page.content()).not.toContain(shown);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('revoking ends the token on the next call and the row says so', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await page.goto('/staff/people');
      const section = page.getByRole('region', { name: 'AI access' });
      await section.getByLabel('Label').fill('Front desk iPad');
      await section.getByRole('button', { name: 'Issue token' }).click();
      const shown = (await section.locator('output').textContent()) ?? '';
      expect(await resolveMcpToken(prisma, shown, new Date())).not.toBeNull();

      await section.getByRole('button', { name: 'Revoke' }).click();
      await expect(section.getByText('Revoked.')).toBeVisible();
      await expect(section.getByText('revoked', { exact: true })).toBeVisible();
      await expect(section.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
      expect(await resolveMcpToken(prisma, shown, new Date())).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a stylist sees no AI access section at all', async ({ page }) => {
    const prisma = new PrismaClient();
    try {
      await signIn(page);
      await prisma.staffUser.updateMany({ where: { email: STAFF_EMAIL }, data: { role: 'staff' } });
      await page.goto('/staff/people');
      await expect(page.getByRole('heading', { name: 'Who works here' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'AI access' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Issue token' })).toHaveCount(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
