import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullRootFixture, screen } from './uikit-full-root-fixtures.js';
import { supplementUIKitFacts } from '../src/drivers/uikit-probe.js';
const unchanged = f => { assert.deepEqual(f.response,f.before.response);assert.deepEqual(f.rawAX,f.before.rawAX);assert.deepEqual(f.capture,f.before.capture);const rest=({text,provenance,...x})=>x;for(const item of f.response.elements)assert.deepEqual(rest(f.result.elements.find(x=>x.anchor===item.anchor)),rest(item)); };
for(const [kind,expected] of [['ring','29 Goal heading 7 sessions'],['icon','Visible heading'],['caption','Visible heading Actual caption'],['footer','Body heading Body tail Footer caption'],['input','Visible heading']])test(`full root ${kind} uses the real owned-window hierarchy and physical text`,()=>{
 const f=fullRootFixture(kind);assert.equal(screen(f).text,expected);assert.equal(screen(f).provenance?.textCorrection,'publicOwnedWindowScreenText');assert.deepEqual(screen(f).provenance.fields,['text']);unchanged(f);
});
test('redacted descendant remains excluded without reading AX input value or placeholder',()=>{
 const f=fullRootFixture('input');let reads=0;for(const key of ['value','placeholder'])Object.defineProperty(f.inputAX,key,{get(){reads++;throw new Error('private input read');},configurable:true});
 const result=supplementUIKitFacts(f.response,f.rawAX,f.capture,{anchors:f.anchors,screen:'test.screen',content:f.content});
 const item=result.elements.find(x=>x.anchor==='test.screen');assert.equal(item.text,'Visible heading');assert.equal(item.provenance?.textCorrection,'publicOwnedWindowScreenText');assert.equal(reads,0);assert.equal(f.capture.windows[0].tree.children[0].children.at(-1).text,'');
});
export const rejectedFullRoots=[
 ['duplicate AX root',f=>f.rawAX.children.push({...structuredClone(f.screenAX),children:[]})],
 ['duplicate UIKit root',f=>f.tree.children.push({...structuredClone(f.screenUIKit),children:[]})],
 ['duplicate response root',f=>{f.changeResponse=r=>r.elements.push(structuredClone(r.elements[0]));}],
 ['mismatched root frame',f=>{f.screenAX.frame={...f.screenAX.frame,width:399};}],
 ['foreign root outside owned window',f=>{const frame=f.rect(1,0,400,800);f.screenAX.frame=frame;f.screenUIKit.frameInScreen=frame;}],
 ['unknown root semantics',f=>{delete f.screenUIKit.observedSemantics;}],
 ['hidden root',f=>{Object.assign(f.screenUIKit,{hidden:true,ancestorOrSelfHidden:true,renderEligible:false}); const hide=n=>{n.ancestorOrSelfHidden=true;n.renderEligible=false;for(const x of n.children??[])hide(x);};for(const x of f.screenUIKit.children)hide(x);}],
 ['action root',f=>{f.screenUIKit.observedSemantics.buttonTrait=true;}],
 ['input root',f=>{f.screenUIKit.observedSemantics.inputKind='textField';f.screenUIKit.observedSemantics.sources.inputKind='UIKit.publicType';}],
 ['response input type',f=>{f.changeResponse=r=>{r.elements[0].inputType='password';};}],
 ['different original response text',f=>{f.changeResponse=r=>{r.elements[0].text='Different sample';};}],
 ['wrong response bounds',f=>{f.changeResponse=r=>{r.elements[0].bounds.width=399;};}],
 ['blocked correction group',f=>{f.container.identifier='';}],
];
for(const [name,change] of rejectedFullRoots)test(`${name} fails closed for a full root`,()=>{const f=fullRootFixture('caption',change);assert.notEqual(screen(f).provenance?.textCorrection,'publicOwnedWindowScreenText');unchanged(f);});

for(const [name,change] of [
 ['missing redacted flag',n=>{delete n.inputRedacted;}],
 ['wrong redacted source',n=>{n.textSource='none';}],
 ['nonempty redacted text',n=>{n.text='Synthetic forbidden text';}],
 ['redacted children',n=>{n.children=[];}],
])test(`unknown descendant privacy: ${name} cannot rewrite full-root snapshot`,()=>{
 const f=fullRootFixture('input'), capture=structuredClone(f.capture);
 const input=capture.windows[0].tree.children[0].children.at(-1);change(input);
 const result=supplementUIKitFacts(f.response,f.rawAX,capture,{anchors:f.anchors,screen:'test.screen',content:f.content});
 assert.deepEqual(result.elements.find(x=>x.anchor==='test.screen'),f.response.elements.find(x=>x.anchor==='test.screen'));
});

test('already-blocked screen deletes only its stale pending correction at the private function boundary',()=>{
 const source=readFileSync(new URL('../src/drivers/uikit-probe.js',import.meta.url),'utf8');
 const start=source.indexOf('function ownedWindowScreenText('),end=source.indexOf('\n\n/** Opt-in current UIKit supplementation',start);
 assert.ok(start>=0&&end>start,'actual private function source is located exactly');
 const invoke=runInNewContext('('+source.slice(start,end)+')');
 const screenID='test.screen', originalScreen={text:'Stale correction'}, other={text:'Other scope'};
 const corrections=new Map([[screenID,originalScreen],['test.other',other]]),blocked=new Set([screenID]);
 invoke(null,null,null,null,{screen:screenID,content:null},corrections,blocked);
 assert.equal(corrections.has(screenID),false);assert.equal(corrections.get('test.other'),other);assert.deepEqual([...blocked],[screenID]);
});

test('a full native-window frame including safe-area insets still uses the actual whole window',()=>{
 const f=fullRootFixture('icon',v=>{v.content=v.rect(0,32,400,748);});
 assert.equal(screen(f).text,'Visible heading');assert.equal(screen(f).provenance?.textCorrection,'publicOwnedWindowScreenText');assert.deepEqual(screen(f).bounds,{x:0,y:0,width:400,height:748});unchanged(f);
});
