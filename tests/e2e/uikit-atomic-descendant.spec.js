import {test,expect}from'@playwright/test';
import {captionFixture}from'../uikit-atomic-descendant-fixtures.js';
import {fact}from'../uikit-text-ownership-fixtures.js';
test('mapped physical caption remains in its real DOM owner after parent text replacement',async({page})=>{
 await page.setContent('<button><span data-testid="owner">Owned caption</span><span>Card title</span><span>Card subtitle</span></button>');
 const fixture=captionFixture();
 expect(fact(fixture,'test.thumb').text).toBe(await page.getByTestId('owner').innerText());
 expect(fixture.capture).toEqual(fixture.before.capture);
 expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});
