import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const page = name => pathToFileURL(path.resolve(`app/${name}.html`)).href;

test('tasks: add, validate and list', async ({ page: browser }) => {
  await browser.goto(page('tasks'));
  await browser.getByTestId('tasks.add').click();
  await expect(browser.getByTestId('tasks.error')).toBeVisible();
  await browser.getByTestId('tasks.input').fill('Write tests');
  await browser.getByTestId('tasks.add').click();
  await expect(browser.getByTestId('tasks.item')).toHaveCount(3);
  await expect(browser.getByTestId('tasks.error')).toBeHidden();
});

test('settings: save shows confirmation', async ({ page: browser }) => {
  await browser.goto(page('settings'));
  await browser.getByTestId('settings.save').click();
  await expect(browser.getByTestId('settings.saved')).toBeVisible();
});
