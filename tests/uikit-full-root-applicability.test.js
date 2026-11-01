import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFixture } from './uikit-probe-control-fixtures.js';
import { screenScopeFixture } from './uikit-screen-scope-fixtures.js';
import { supplementUIKitFacts } from '../src/drivers/uikit-probe.js';
const screen=f=>f.result.elements.find(item=>item.anchor==='test.screen');
const original=f=>f.response.elements.find(item=>item.anchor==='test.screen');
const immutable=f=>{assert.deepEqual(f.response,f.before.response);assert.deepEqual(f.rawAX,f.before.rawAX);assert.deepEqual(f.capture,f.before.capture);};
test('missing full-root proof keeps independently verified control text and its derived provenance',()=>{
 const f=controlFixture();assert.equal('observedSemantics'in f.tree,false);
 assert.equal(screen(f).text,'Visible heading');assert.equal(screen(f).provenance.textCorrection,'publicNoninputControlText');assert.equal(screen(f).provenance.source,'derivedAXWithCurrentUIKitControlText');assert.ok(screen(f).provenance.textParts.length>0);immutable(f);
});
for(const[name,change]of[
 ['present undefined proof',f=>{f.tree.observedSemantics=undefined;}],
 ['present null proof',f=>{f.tree.observedSemantics=null;}],
 ['affirmative action proof',f=>{f.tree.observedSemantics=structuredClone(f.control.observedSemantics);}],
 ['duplicate AX root',f=>{f.rawAX.children.push({...structuredClone(f.rawAX),children:[]});}],
 ['mismatched root frame',f=>{f.rawAX.frame={...f.rawAX.frame,width:399};}],
])test(`${name} still rejects and clears pending screen correction`,()=>{const f=controlFixture(change);assert.deepEqual(screen(f),original(f));immutable(f);});
test('missing root proof cannot bypass malformed public input redaction',()=>{
 const f=controlFixture(v=>{const n=v.uikit('test.input','',[],v.rect(20,140,100,20),{inputRedacted:true,textSource:'redactedInput'});delete n.children;v.tree.children.push(n);});
 const capture=structuredClone(f.capture);capture.windows[0].tree.children.at(-1).textSource='none';
 const result=supplementUIKitFacts(f.response,f.rawAX,capture,{anchors:f.anchors,screen:'test.screen',content:f.rect()});
 assert.deepEqual(result.elements.find(item=>item.anchor==='test.screen'),original(f));immutable(f);
});
test('a proper main pane missing root proof remains invalid and cannot retain a screen rewrite',()=>{
 const f=screenScopeFixture(v=>{delete v.screenUIKit.observedSemantics;});assert.deepEqual(screen(f),original(f));immutable(f);
});
