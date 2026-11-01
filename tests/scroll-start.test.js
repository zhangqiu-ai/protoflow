import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScrollEnds, validateScrollSteps } from '../src/drivers/scroll-alignment.js';
const step = { action: 'scroll-to', anchor: 'demo.first', value: 'start' };
const rect = (x,y,width,height) => ({x,y,width,height});
function fixture() {
 const target={identifier:'demo.first',attachedToWindow:true,ancestorOrSelfHidden:false,renderEligible:true,transformed:false,frameInScreen:rect(20,30,200,44),children:[]};
 const scroll={identifier:'',attachedToWindow:true,renderEligible:true,transformed:false,bounds:rect(0,-24,320,500),frameInScreen:rect(0,0,320,500),scrollGeometry:{source:'UIScrollView.publicGeometry',isScrollView:true,scrollEnabled:true,contentSize:{width:320,height:1400},contentOffset:{x:0,y:-24},adjustedContentInset:{top:24,left:0,bottom:0,right:0}},children:[target]};
 const root={identifier:'demo',transformed:false,children:[scroll]};
 const observations=[{anchor:step.anchor,endpoint:'start',source:'XCUIAutomation.publicScrollGesture',endpointVerified:false,gestureCount:2,stationarySamples:2,scrollFrame:{...scroll.frameInScreen},targetFrame:{...target.frameInScreen}}];
 return {target,scroll,root,capture:{windows:[{screenScale:3,tree:root}]},observations};
}
const verify=f=>nativeScrollEnds(f.capture,[step],f.observations);
test('explicit start proves observed min=-adjustedTop in the final capture',()=>{const f=fixture();const r=verify(f)[0];assert.equal(r.endpoint,'start');assert.equal(r.minimum,-24);assert.equal(r.contentOffset.y,-24);assert.deepEqual(r.nativeNodePath,[0,0]);});
test('finite negative top inset retains its mathematical minimum',()=>{const f=fixture();f.scroll.scrollGeometry.adjustedContentInset.top=-12;f.scroll.scrollGeometry.contentOffset.y=0;assert.throws(()=>verify(f),/not at scroll start/);f.scroll.scrollGeometry.contentOffset.y=12;assert.equal(verify(f)[0].minimum,12);});
test('one physical pixel applies unchanged at the top endpoint',()=>{const f=fixture();f.scroll.scrollGeometry.contentOffset.y+=0.3;verify(f);f.scroll.scrollGeometry.contentOffset.y+=0.1;assert.throws(()=>verify(f),/not at scroll start/);});
for(const[name,change,reason]of[
 ['stationary away from start',f=>f.scroll.scrollGeometry.contentOffset.y=21,/not at scroll start/],
 ['end observation cannot prove start',f=>delete f.observations[0].endpoint,/gesture observation/],
 ['wrong endpoint',f=>f.observations[0].endpoint='end',/gesture observation/],
 ['unknown endpoint',f=>f.observations[0].endpoint='middle',/gesture observation/],
 ['duplicate observations',f=>f.observations.push({...f.observations[0]}),/gesture observation/],
 ['no public gesture',f=>f.observations=[],/gesture observation/],
 ['missing inset',f=>delete f.scroll.scrollGeometry.adjustedContentInset,/adjusted content inset/],
 ['nonfinite inset',f=>f.scroll.scrollGeometry.adjustedContentInset.top=NaN,/adjusted content inset/],
 ['negative extent',f=>f.scroll.scrollGeometry.contentSize.height=-1,/extent/],
 ['nonfinite extent',f=>f.scroll.scrollGeometry.contentSize.height=Infinity,/extent/],
 ['changed top inset not reached',f=>f.scroll.scrollGeometry.adjustedContentInset.top=48,/not at scroll start/],
 ['duplicate target',f=>f.root.children.push(structuredClone(f.target)),/unique exact target/],
 ['nested scroll',f=>f.scroll.children=[{...structuredClone(f.scroll),children:[f.target]}],/nested scroll/],
 ['foreign branch',f=>{f.scroll.children=[];f.root.children.push(f.target)},/unique vertical scroll/],
 ['disabled scroll',f=>f.scroll.scrollGeometry.scrollEnabled=false,/rendered and enabled/],
 ['changed scope',f=>f.observations[0].scrollFrame.y=5,/scope changed/],
 ['changed target',f=>f.observations[0].targetFrame.y=5,/scope changed/],
 ['horizontal content',f=>f.scroll.scrollGeometry.contentSize.width=400,/horizontal scroll/],
 ['transformed target',f=>f.target.transformed=true,/transformed/],
 ['hidden target',f=>f.target.ancestorOrSelfHidden=true,/not rendered/],
])test(name+' fails closed',()=>{const f=fixture();change(f);assert.throws(()=>verify(f),reason)});
test('start requires probe and unique anchor; unknown values still fail',()=>{assert.deepEqual(validateScrollSteps([step]),['demo.first']);assert.throws(()=>validateScrollSteps([step],{requireUIKit:true}),/needs current UIKit probe/);assert.throws(()=>validateScrollSteps([step,{...step,value:'end'}]),/repeated/);assert.throws(()=>validateScrollSteps([{...step,value:'center'}]),/unsupported/);});
test('geometry proof does not read text, value, placeholder or label',()=>{const f=fixture();for(const node of [f.target,f.scroll,f.root])for(const key of ['text','value','placeholder','accessibilityLabel'])Object.defineProperty(node,key,{get(){throw Error('private content read')}});assert.equal(verify(f)[0].minimum,-24);});
