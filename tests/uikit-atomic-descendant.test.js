import { captionFixture } from './uikit-atomic-descendant-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipFixture, fact } from './uikit-text-ownership-fixtures.js';
const find = (n,id) => n.identifier===id ? n : (n.children??[]).map(c=>find(c,id)).find(Boolean);
const parentOf = (root,target) => (root.children??[]).includes(target) ? root : (root.children??[]).map(c=>parentOf(c,target)).find(Boolean);
const immutable = f => { assert.deepEqual(f.capture,f.before.capture); assert.deepEqual(f.rawAX,f.before.rawAX); assert.deepEqual(f.response,f.before.response); };
test('a removed AX descendant excludes its changed real ancestor aggregate in the same atomic group',()=>{
 const f=ownershipFixture('thumb');
 assert.equal(fact(f,'test.thumb').text,'');
 assert.equal(fact(f,'test.action').text,'Card title Card subtitle');
 immutable(f);
});
for(const[name,change]of[
 ['same-frame current node on a foreign branch',f=>{const n=find(f.tree,'test.thumb'),parent=parentOf(f.tree,n);parent.children=parent.children.filter(c=>c!==n);f.tree.children.push(n);}],
 ['current frame mismatch',f=>{const n=find(f.tree,'test.thumb');n.frameInScreen.x+=1;n.frameInWindow.x+=1;}],
 ['missing typed semantics',f=>{delete find(f.tree,'test.thumb').observedSemantics;}],
 ['editable input observation even when false',f=>{const n=find(f.tree,'test.thumb');n.observedSemantics.editable=false;n.observedSemantics.sources.editable='UITextView.editable';}],
 ['unmapped geometric text part',f=>{const a=find(f.rawAX,'test.action');a.children.push(f.ax('','staticText','Unknown text',[],f.rect(420,1040,100,20)));}],
 ['duplicate current descendant',f=>{const n=find(f.tree,'test.thumb');parentOf(f.tree,n).children.push(structuredClone(n));}],
 ['hidden current descendant',f=>{const n=find(f.tree,'test.thumb');n.hidden=true;const hide=x=>{x.ancestorOrSelfHidden=true;x.renderEligible=false;(x.children??[]).forEach(hide);};hide(n);}],
 ['transformed current descendant',f=>{find(f.tree,'test.thumb').transformed=true;}],
])test(`${name} leaves the full affected correction group closed`,()=>{
 const f=ownershipFixture('thumb',change);
 for(const id of ['test.action','test.thumb'])assert.equal(fact(f,id).text,f.before.response.elements.find(x=>x.anchor===id).text);
 immutable(f);
});

test('a genuinely mapped public descendant retains nonempty own text rather than forcing empty', () => {
 const fixture=captionFixture();
 assert.equal(fact(fixture,'test.thumb').text,'Owned caption');
 assert.ok(fact(fixture,'test.action').text.includes('Owned caption'));
 immutable(fixture);
});
test('a hidden selected current text part cannot enter the fallback group', () => {
 const fixture=captionFixture(true);
 for(const id of ['test.action','test.thumb'])assert.equal(fact(fixture,id).text,fixture.before.response.elements.find(x=>x.anchor===id).text);
 immutable(fixture);
});
