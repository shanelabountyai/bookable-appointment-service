import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Proves the harness (build, serve on 3300, browser automation, axe) works.
// Real coverage arrives with each UI-bearing backlog item (A-010, A-016, ...).
test('home page loads and has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bookable' })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious).toEqual([]);
});
