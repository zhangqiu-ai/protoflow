import { test, expect } from '@playwright/test';

for (const surface of ['prototype', 'app']) {
  test(`${surface} creates a named session`, async ({ page }) => {
    await page.goto(new URL(`../${surface}/index.html`, import.meta.url).href);
    await expect(page.getByRole('heading', { name: 'Create a design session' })).toBeVisible();
    await page.getByLabel('Session name').fill('Settings screen');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByText('Session created: Settings screen')).toBeVisible();
  });
}
