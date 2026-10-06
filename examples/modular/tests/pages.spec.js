import { test, expect } from '@playwright/test';

for (const surface of ['prototype', 'app']) {
  test(`${surface}: sends a message, saves settings and navigates between pages`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/${surface}/pages/chat.html`);
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Review the navigation spacing.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('list', { name: 'Messages' }).getByText('Review the navigation spacing.')).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${surface}/pages/settings\\.html$`));
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Display name').fill('Morgan');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status')).toHaveText('Display name saved: Morgan');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(errors).toEqual([]);
  });
}
