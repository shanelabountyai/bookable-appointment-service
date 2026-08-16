import AxeBuilder from '@axe-core/playwright';
import { STAFF_EMAIL, STAFF_PASSWORD, expect, test } from './fixtures';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

test.describe('business settings & providers (A-025)', () => {
  test('both routes refuse an anonymous visitor', async ({ page }) => {
    await page.goto('/staff/settings');
    await expect(page).toHaveURL(/\/staff\/login$/);
    await page.goto('/staff/providers');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test('an owner can change policy and it persists', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/settings');

    await page.getByLabel('Booking horizon (days)').fill('75');
    await page.getByLabel('No-show threshold').fill('4');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Booking horizon (days)')).toHaveValue('75');
    await expect(page.getByLabel('No-show threshold')).toHaveValue('4');
  });

  // The D-11/D-19 trap the operator found (R-3), asserted through the UI: the
  // owner must be STOPPED, and told which setting is the problem.
  test('refuses a cancellation cutoff longer than the lead time, next to the field', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/settings');

    await page.getByLabel('Minimum lead time (minutes)').fill('60');
    await page.getByLabel('Cancellation cutoff (minutes)').fill('1440');
    await page.getByRole('button', { name: 'Save settings' }).click();

    const cutoff = page.getByLabel('Cancellation cutoff (minutes)');
    await expect(cutoff).toHaveAttribute('aria-invalid', 'true');
    // Target the ERROR element by id, not by text: the field's help text
    // deliberately explains the same rule, so a text locator matches both and
    // would pass even if only the hint were present.
    const error = page.locator('#cancellationCutoffMinutes-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('already unable to cancel');
    // ...and the input actually points at it for a screen reader.
    await expect(cutoff).toHaveAttribute('aria-describedby', /cancellationCutoffMinutes-error/);
    await expect(page.getByText('Settings saved.')).toHaveCount(0);

    // And nothing was written.
    await page.reload();
    await expect(page.getByLabel('Minimum lead time (minutes)')).not.toHaveValue('60');
  });

  test('an owner can add, deactivate and reactivate a provider', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/providers');

    await page.getByLabel('Add a provider').fill('Dana');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Dana')).toBeVisible();

    await page.getByRole('button', { name: 'Deactivate' }).first().click();
    await expect(page.getByText('Not taking bookings')).toBeVisible();

    // Deactivation is not deletion — she is still listed.
    await expect(page.getByText('Dana')).toBeVisible();

    await page.getByRole('button', { name: 'Reactivate' }).first().click();
    await expect(page.getByText('Not taking bookings')).toHaveCount(0);
  });

  test('refuses a blank provider name', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/providers');
    // Bypass the browser's `required` so the SERVER-side check is what runs.
    await page.getByLabel('Add a provider').fill('x');
    await page.getByLabel('Add a provider').fill('');
    await page.evaluate(() => {
      document.querySelector('form')?.setAttribute('novalidate', 'true');
    });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('A provider needs a name.')).toBeVisible();
  });

  test('settings and providers pages have no serious accessibility violations', async ({ page }) => {
    await signIn(page);
    for (const path of ['/staff/settings', '/staff/providers']) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious, `${path} has serious axe violations`).toEqual([]);
    }
  });
});
