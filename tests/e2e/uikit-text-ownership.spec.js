import { test, expect } from '@playwright/test';
import { ownershipFixture, fact } from '../uikit-text-ownership-fixtures.js';
const norm = text => text.replace(/\s+/g, ' ').trim();
for (const [kind, id, html] of [
  ['row', 'test.container', '<main data-testid="owner"><span>29</span> <span>Read a book</span> <span>7 sessions</span> <span>Later</span> <span>C</span> <span>together</span></main>'],
  ['usage', 'test.screen', '<main data-testid="owner">Available today <span>18 text replies</span> <span>3 images</span> Resets tomorrow At limit, stop.</main>'],
  ['footer', 'test.screen', '<main data-testid="owner"><button>Save</button> <nav>Growth Together AI Chats Me</nav></main>'],
  ['thumb', 'test.thumb', '<main><button><div data-testid="owner"><svg></svg></div><p>Card title</p><p>Card subtitle</p></button></main>'],
  ['path', 'test.path', '<main><section data-testid="owner">Path heading Path detail</section><nav>Growth Together AI Chats Me</nav></main>'],
]) test(`${kind}: real DOM text does not borrow another owner or reorder hierarchy`, async ({ page }) => {
  await page.setContent(html);
  const fixture = ownershipFixture(kind);
  expect(fact(fixture, id).text).toBe(norm(await page.getByTestId('owner').innerText()));
  expect(fixture.capture).toEqual(fixture.before.capture);
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});
