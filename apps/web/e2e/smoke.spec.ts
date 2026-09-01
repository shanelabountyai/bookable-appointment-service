import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@bookable/db';
import { seedSetup } from '@bookable/db/settings';

// Proves the harness (build, serve on 3300, browser automation, axe) works,
// and that the front door renders against a real catalogue rather than an
// empty one — the shape of defect that hid A-031's dormant chairs.
test('home page loads and has no serious accessibility violations', async ({ page }) => {
  const prisma = new PrismaClient();
  try {
    await seedSetup(prisma);
  } finally {
    await prisma.$disconnect();
  }

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('nobody double-booked');

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious).toEqual([]);
});
