import AxeBuilder from '@axe-core/playwright';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff\/day/);
}

test.describe('service catalog (A-006)', () => {
  test('refuses an anonymous visitor', async ({ page }) => {
    await page.goto('/staff/services');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('an owner adds a service and it persists', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/services');

    await page.getByText('Add a service').click();
    await page.locator('#add-name').fill('Balayage');
    await page.locator('#add-durationMinutes').fill('180');
    await page.locator('#add-priceCents').fill('21000');
    await page.locator('#add-bufferBeforeMinutes').fill('10');
    await page.locator('#add-bufferAfterMinutes').fill('25');
    await page.getByRole('button', { name: 'Add service' }).click();

    await expect(page.getByText('Service added.')).toBeVisible();
    await expect(page.getByText('Balayage')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Balayage')).toBeVisible();
  });

  // The D-11/D-19 trap, exercised through the SERVICE side of the UI —
  // A-025's spec covers the business-settings side.
  test('refuses a service cutoff longer than the business lead time', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/services');

    await page.getByText('Add a service').click();
    await page.locator('#add-name').fill('Colour');
    await page.locator('#add-durationMinutes').fill('120');
    await page.locator('#add-priceCents').fill('14000');
    await page.locator('#add-cancellationCutoffMinutes').fill('1440'); // 24h, lead is 120min
    await page.getByRole('button', { name: 'Add service' }).click();

    const error = page.locator('#add-cutoff-error');
    await expect(error).toBeVisible();
    // Names the rejected service, so a page-wide text search for "Colour"
    // would match the error message ITSELF — scope to the service list.
    await expect(error).toContainText('“Colour”’s cancellation cutoff');
    await expect(error).toContainText('already unable to cancel');
    await expect(page.locator('main > ul > li')).toHaveCount(0);
  });

  test('deactivating and reactivating a service does not remove it from the list', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/services');

    await page.getByText('Add a service').click();
    await page.locator('#add-name').fill('Fringe trim');
    await page.locator('#add-durationMinutes').fill('10');
    await page.locator('#add-priceCents').fill('1500');
    await page.getByRole('button', { name: 'Add service' }).click();
    await expect(page.getByText('Service added.')).toBeVisible();

    const card = page.locator('li', { hasText: 'Fringe trim' });
    await card.getByRole('button', { name: 'Deactivate' }).click();
    await expect(card.getByText('Deactivated')).toBeVisible();
    await expect(card.getByText('Fringe trim')).toBeVisible(); // still listed

    await card.getByRole('button', { name: 'Reactivate' }).click();
    await expect(card.getByText('Deactivated')).toHaveCount(0);
  });

  test('an owner qualifies a provider for a service, with an override', async ({ page }) => {
    await signIn(page);

    // Set up: a provider and a service.
    await page.goto('/staff/providers');
    await page.getByLabel('Add a provider').fill('Dana');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Dana')).toBeVisible();

    await page.goto('/staff/services');
    await page.getByText('Add a service').click();
    await page.locator('#add-name').fill('Cut');
    await page.locator('#add-durationMinutes').fill('45');
    await page.locator('#add-priceCents').fill('5500');
    await page.getByRole('button', { name: 'Add service' }).click();
    await expect(page.getByText('Service added.')).toBeVisible();

    // NOT `li:has-text('Cut')` — every card's collapsed edit form contains
    // the label "Cancellation Cutoff", which also contains "Cut" as a
    // substring and matches every card, not just this one.
    const card = page.locator('li').filter({ has: page.getByText('Cut', { exact: true }) });
    await card.getByText(/Qualified providers/).click();
    const danaRow = card.locator('li').filter({ has: page.getByText('Dana', { exact: true }) });
    await danaRow.getByPlaceholder('duration override').fill('60');
    await danaRow.getByRole('button', { name: 'Qualify' }).click();

    await expect(card.getByText(/60 min/)).toBeVisible();

    // Removing her again.
    await danaRow.getByRole('button', { name: 'Remove' }).click();
    await expect(card.getByText(/60 min/)).toHaveCount(0);
  });

  test('services page has no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/services');
    await page.getByText('Add a service').click(); // exercise the form open too
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });
});
