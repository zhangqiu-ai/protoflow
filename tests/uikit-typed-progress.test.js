import test from 'node:test';
import assert from 'node:assert/strict';
import {progressFixture,bodyText,physicalExpected,rejectionCases} from './uikit-typed-progress-fixtures.js';
test('trusted typed anonymous progress contributes no accessibility-only name to visible body text',()=>{
 const f=progressFixture();assert.equal(bodyText(f),physicalExpected);assert.deepEqual(f.rawAX,f.before.rawAX);assert.deepEqual(f.capture,f.before.capture);
 assert.match(f.before.response.elements.find(e=>e.anchor==='test.body').text,/Accessible busy state/,'legacy AX text and raw label are preserved');
});
test('typed correlation does not depend on class or expected accessible-name string',()=>{
 const f=progressFixture(f=>{f.spinner.class='AnotherAnonymousClass';f.spinner.accessibilityLabel='Alternate status name';f.axSpinner.label='Alternate status name';});assert.equal(bodyText(f),physicalExpected);
});
for(const[name,change]of rejectionCases)test(name+' fails closed without dropping original accessible name',()=>{const f=progressFixture(change);assert.ok(bodyText(f).includes('Accessible busy state'));assert.deepEqual(f.rawAX,f.before.rawAX);assert.deepEqual(f.capture,f.before.capture);});
test('physical child text in a typed indicator is retained and prevents accessibility-only exclusion',()=>{
 const f=progressFixture(f=>{const frame=f.rect(50,150,20,20);f.spinner.children.push(f.make('','Visible child caption',[],frame));f.axSpinner.children.push(f.ax('','staticText','Visible child caption',[],frame));});assert.match(bodyText(f),/Visible child caption/);assert.equal(bodyText(f),f.before.response.elements.find(e=>e.anchor==='test.body').text);
});
test('optional typed metadata leaves the legacy AX facts byte-identical',()=>{
 const typed=progressFixture(),legacy=progressFixture(f=>delete f.axSpinner.observedNonTextKind);assert.deepEqual(typed.before.response,legacy.before.response);assert.match(typed.before.response.elements.find(e=>e.anchor==='test.body').text,/Accessible busy state/);
});
