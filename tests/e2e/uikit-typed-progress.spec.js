import{test,expect}from'@playwright/test';
import{progressFixture,bodyText,physicalExpected,rejectionCases}from'../uikit-typed-progress-fixtures.js';
const dom='<section aria-label="Example body">Example reply <span role="progressbar" aria-label="Accessible busy state" style="display:inline-block;width:20px;height:20px;border:2px solid blue;border-right-color:transparent;border-radius:50%"></span>Creating example… Example detail</section>';
test('real DOM innerText excludes the empty progress indicator name while its accessible name remains available',async({page})=>{
 await page.setContent(dom);await expect(page.getByRole('progressbar',{name:'Accessible busy state'})).toBeVisible();const visible=(await page.getByRole('region',{name:'Example body'}).innerText());expect(visible).toBe(physicalExpected);expect(bodyText(progressFixture())).toBe(visible);
});
for(const[name,change]of rejectionCases)test('unproven '+name+' does not get a DOM-text pass',async({page})=>{await page.setContent(dom);const visible=(await page.getByRole('region',{name:'Example body'}).innerText());expect(bodyText(progressFixture(change))).not.toBe(visible);expect(bodyText(progressFixture(change))).toContain('Accessible busy state');});
