import { test, expect } from '@playwright/test';
import { controlFixture } from '../uikit-probe-control-fixtures.js';
import { imageFixture, imageCaptionConflictFixture, unconfirmedSiblingFixture } from '../uikit-probe-image-text-fixtures.js';

test('an AX image caption subtree is left coherent when current UIKit caption evidence differs', async ({ page }) => {
  await page.setContent('<div data-testid="picture"><img alt="Accessible operation"><span>AX caption A</span></div>');
  const text = await page.getByTestId('picture').innerText(), fixture = imageCaptionConflictFixture();
  expect(text).toBe('AX caption A');
  expect(fixture.result.elements.find(item => item.anchor === 'test.screen').text).toBe(`Visible heading ${text}`);
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').text).toBe(text);
  expect(fixture.result).toEqual(fixture.before.response);
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
  expect(fixture.capture).toEqual(fixture.before.capture);
});

test('image alt remains an accessible name while visible text matches the real browser image scope', async ({ page }) => {
  await page.setContent('<div data-testid="picture"><img alt="Accessible operation"></div>');
  await expect(page.getByRole('img', { name: 'Accessible operation' })).toBeVisible();
  const text = await page.getByTestId('picture').innerText(), fixture = imageFixture();
  expect(text).toBe('');
  const item = fixture.result.elements.find(value => value.anchor === 'test.action');
  expect(item.text).toBe(text);
  expect(item.role).toBe('image');
  expect(item.provenance.originalAX.label).toBe('Accessible operation');
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});

test('physical image caption text remains visible rather than being erased with the alt name', async ({ page }) => {
  await page.setContent('<div data-testid="picture"><img alt="Accessible operation"><span>Physical caption</span></div>');
  const text = await page.getByTestId('picture').innerText();
  const fixture = imageFixture(({ control, uikit, rect }) => { control.children = [uikit('', text, [], rect(20, 100, 40, 20), { class: 'UILabel', textSource: 'UILabel.text' })]; });
  expect(text).toBe('Physical caption');
  expect(fixture.result.elements.find(value => value.anchor === 'test.action').text).toBe(text);
  expect(fixture.result.elements.find(value => value.anchor === 'test.screen').text).toBe(`Visible heading ${text}`);
});

test('icon-only button names stay accessible and an unconfirmed sibling cannot supply empty visible text', async ({ page }) => {
  await page.setContent('<button aria-label="Accessible operation"><svg aria-hidden="true"></svg></button>');
  const button = page.getByRole('button', { name: 'Accessible operation' });
  await expect(button).toBeVisible();
  const fixture = unconfirmedSiblingFixture();
  expect(await button.innerText()).toBe('');
  expect(fixture.result.elements.find(value => value.anchor === 'test.action').text).toBe(await button.innerText());
  expect(fixture.result.elements.find(value => value.anchor === 'test.action').provenance.originalAX.label).toBe('Accessible operation');
  expect(fixture.result.elements.find(value => value.anchor === 'test.unconfirmed')).toEqual(fixture.response.elements.find(value => value.anchor === 'test.unconfirmed'));
});

test('a real profile character stays visible independently of its accessible name', async ({ page }) => {
  await page.setContent('<button aria-label="Profile"><span>Z</span></button>');
  const text = await page.getByRole('button', { name: 'Profile' }).innerText();
  const fixture = controlFixture(({ control, axControl, uikit, rect }) => { axControl.label = 'Profile'; control.children = [uikit('', text, [], rect(20, 100, 40, 20))]; });
  expect(text).toBe('Z');
  expect(fixture.result.elements.find(value => value.anchor === 'test.action').text).toBe(text);
  expect(fixture.result.elements.find(value => value.anchor === 'test.action').provenance.originalAX.label).toBe('Profile');
});
