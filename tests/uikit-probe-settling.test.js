import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, chmod, readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startProbeBridge } from '../src/drivers/uikit-probe-bridge.js';
import { validateProbePair } from '../src/drivers/uikit-probe.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const session={nonce:randomUUID(),contextId:'CTX-settling-synthetic',sceneId:'test.screen.ready',screenAnchor:'test.screen'};
const rect={x:0,y:0,width:400,height:800};
function capture(alpha=1,text='Actual text') {
 const n=(id,children=[],extra={})=>({identifier:id,class:'UIView',frameInWindow:rect,frameInScreen:rect,bounds:rect,order:0,hidden:false,ancestorOrSelfHidden:false,alpha:1,effectiveAlpha:1,clipsToBounds:false,clipIntersection:rect,clipMethod:'axisAlignedBoundsIntersection',transformed:false,attachedToWindow:true,renderEligible:true,occlusion:'notComputed',text:'',textSource:'none',children:children.map((c,i)=>({...c,order:i})),...extra});
 const indicator=n('',[n('',[],{effectiveAlpha:alpha,renderEligible:alpha>0})],{class:'UIScrollViewScrollIndicator',alpha,effectiveAlpha:alpha,renderEligible:alpha>0});
 return {source:'currentUIKitViewTree',occlusion:'notComputed',nodeCount:5,windows:[{sceneSession:'synthetic-scene',bounds:rect,screenAnchor:session.screenAnchor,windowFrame:rect,screenBounds:rect,screenScale:2,interfaceOrientation:1,safeAreaInsets:{top:0,left:0,bottom:0,right:0},tree:n('',[n('test.screen',[n('test.title',[],{class:'UILabel',text,textSource:'UILabel.text'})]),indicator],{class:'UIWindow'})}]};
}
async function json(p){return JSON.parse(await readFile(p,'utf8'));}
async function wait(fn,ms=9000){const end=Date.now()+ms;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){if(e.code!=='ENOENT')throw e;}await pause(10);}throw Error('synthetic wait expired');}
async function fixture(t,{sequence=()=>capture(),settle=true,mutate,runDelay=0,identityDelay=0,settlingBudgetMs}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'probe-settle-fixture-'))),device='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bundleId='dev.generic.capture';
 const base=path.join(root,'CoreSimulator/Devices',device,'data/Containers'),app=path.join(base,'Bundle/Application/id/Generic.app'),data=path.join(base,'Data/Application/id'),channel=path.join(data,'Library/Caches/SiyueCaptureProbe'),outputDir=path.join(root,'out');
 await Promise.all([mkdir(app,{recursive:true}),mkdir(channel,{recursive:true,mode:0o700}),mkdir(outputDir)]);await chmod(channel,0o700);
 await writeFile(path.join(app,'Generic'),'exe');await writeFile(path.join(app,'main.jsbundle'),'js');await writeFile(path.join(app,'Info.plist'),'plist');
 const info={CFBundleIdentifier:bundleId,CFBundleShortVersionString:'1',CFBundleVersion:'1',CFBundleExecutable:'Generic'},calls=[],sent=[],ids=new Set();let stop=false,collectorError;
 const run=async(argv,options)=>{calls.push({argv,options});if(identityDelay&&argv[0]==='xcrun'&&argv.at(-1)==='app')await pause(identityDelay);if(runDelay)await pause(Math.min(runDelay,options.timeoutMs));if(runDelay>=options.timeoutMs)return {code:null,timedOut:true,stdout:''};return {code:0,stdout:argv[0]==='xcrun'?(argv.at(-1)==='app'?app:data):info[argv[2]]};};
 const work=(async()=>{while(!stop){try{const request=await json(path.join(channel,'request.json'));if(!ids.has(request.sampleId)){ids.add(request.sampleId);const at=Date.now()/1000;const sample={schemaVersion:1,status:'OK',nonce:request.nonce,sampleId:request.sampleId,correlation:Object.fromEntries(Object.keys(session).map(k=>[k,request[k]])),actualBuild:request.expectedBuild,startedAt:at,finishedAt:at,mainThread:true,capture:sequence(sent.length)};mutate?.(sample,sent.length);const bytes=Buffer.from(JSON.stringify(sample)+'\n');await writeFile(path.join(channel,'.response'),bytes,{mode:0o600});await rename(path.join(channel,'.response'),path.join(channel,'response.json'));sent.push({request,sample,bytes});}}catch(e){if(e.code!=='ENOENT'){collectorError=e;break;}}await pause(5);}})();
 const bridge=startProbeBridge({device,bundleId,outputDir,session,run,settleBeforeCapture:settle,settlingBudgetMs});
 t.after(async()=>{await bridge.stop();stop=true;await work;await rm(root,{recursive:true,force:true});if(collectorError)throw collectorError;});
 const marker=async(phase,sampleId=randomUUID())=>{await writeFile(path.join(outputDir,'.marker'),JSON.stringify({phase,sampleId,nonce:session.nonce}),{mode:0o600});await rename(path.join(outputDir,'.marker'),path.join(outputDir,'probe-request.json'));return sampleId;};
 return {root,app,channel,outputDir,calls,sent,bridge,marker,ack:phase=>wait(()=>json(path.join(outputDir,`probe-ack-${phase}.json`)))};
}
test('settling waits for the complete fading tree, preserves each raw sample, then takes two fresh strict samples',async t=>{
 const f=await fixture(t,{sequence:i=>capture(i<2?1-i*.3:0)});await f.marker('settle');
 const ack=await Promise.race([f.ack('settle'),wait(()=>f.bridge.error,2500).then(e=>{throw e;})]);assert.equal(ack.status,'OK');
 const settling=await json(path.join(f.outputDir,'probe-settling.json'));assert.equal(settling.status,'READY');assert.ok(settling.settlingReceipts.length<=8);assert.ok(settling.quietSpanMs>=1500);assert.ok(settling.observedQuietSpanMs>=1500);assert.ok(settling.consecutive>=3);
 for(const r of settling.settlingReceipts){const actual=f.sent.find(x=>x.request.sampleId===r.sampleId);assert.ok(actual);assert.deepEqual(await readFile(path.join(f.outputDir,r.file)),actual.bytes);assert.equal((await stat(path.join(f.outputDir,r.file))).mode&0o777,0o600);}
 const measured=[];for(const phase of ['before','after']){const id=await f.marker(phase);const a=await f.ack(phase);assert.equal(a.status,'OK');assert.ok(!settling.settlingReceipts.some(r=>r.sampleId===id));measured.push(await json(path.join(f.outputDir,a.file)));}
 const ledger=await json(path.join(f.outputDir,'probe-bridge.json'));assert.deepEqual(ledger.receipts.map(r=>r.phase),['before','after']);assert.equal(new Set(f.sent.map(x=>x.sample.sampleId)).size,f.sent.length);
 const [before,after]=measured;const timing={axStartedAt:before.finishedAt,axFinishedAt:before.finishedAt,screenshotStartedAt:before.finishedAt,screenshotFinishedAt:before.finishedAt};assert.ok(validateProbePair({before,after,timing,expectedBuild:f.bridge.expectedBuild,session}).hash);
 for(const c of f.calls)assert.ok(c.options.timeoutMs>0&&c.options.timeoutMs<=10000);
});
test('a continuously changing unanchored scalar is never ignored and exhausts the bounded settling budget',async t=>{
 const f=await fixture(t,{sequence:i=>capture(i%2?.3:.7)});const start=performance.now();await f.marker('settle');const ack=await f.ack('settle');assert.equal(ack.status,'ERROR');assert.match(ack.reason,/settling/);assert.ok(performance.now()-start<6800);assert.ok(f.sent.length<=8);await assert.rejects(stat(path.join(f.outputDir,'probe-before.json')),{code:'ENOENT'});assert.equal((await json(path.join(f.outputDir,'probe-settling.json'))).status,'NOT_RUN');
});
test('the opt-in cannot start the measured bracket without a completed settling phase',async t=>{const f=await fixture(t);await f.marker('before');const ack=await f.ack('before');assert.equal(ack.status,'ERROR');assert.match(ack.reason,/settling/);assert.equal(f.sent.length,0);});
for(const [label,mutate] of [['main thread',s=>s.mainThread=false],['correlation',s=>s.correlation.contextId='CTX-wrong'],['build',s=>s.actualBuild={...s.actualBuild,javascriptSha256:'0'.repeat(64)}],['capture validation',s=>s.capture.windows[0].tree.attachedToWindow=false]])test(`settling rejects ${label} rather than treating matching hashes as readiness`,async t=>{const f=await fixture(t,{mutate});await f.marker('settle');assert.equal((await f.ack('settle')).status,'ERROR');await assert.rejects(stat(path.join(f.outputDir,'probe-before.json')),{code:'ENOENT'});});
test('every identity command is bounded by the remaining total settling time',async t=>{const f=await fixture(t,{runDelay:7000});const start=performance.now();await f.marker('settle');const ack=await f.ack('settle');assert.equal(ack.status,'ERROR');assert.ok(performance.now()-start<6800);assert.ok(f.calls.length>0);assert.ok(f.calls.every(c=>c.options.timeoutMs<=6000));assert.equal(f.sent.length,0);});

test('a quiet preflight never makes a changing measured pair acceptable',async t=>{let measured=false,n=0;const f=await fixture(t,{sequence:()=>capture(measured?(n++?0.3:1):0)});await f.marker('settle');assert.equal((await f.ack('settle')).status,'OK');measured=true;const pair=[];for(const phase of ['before','after']){await f.marker(phase);const a=await f.ack(phase);assert.equal(a.status,'OK');pair.push(await json(path.join(f.outputDir,a.file)));}const [before,after]=pair;assert.throws(()=>validateProbePair({before,after,expectedBuild:f.bridge.expectedBuild,session,timing:{axStartedAt:before.finishedAt,axFinishedAt:before.finishedAt,screenshotStartedAt:before.finishedAt,screenshotFinishedAt:before.finishedAt}}),/current tree changed/);});
test('a settling sample UUID cannot be reused as a formal before UUID',async t=>{const f=await fixture(t);await f.marker('settle');assert.equal((await f.ack('settle')).status,'OK');const warm=(await json(path.join(f.outputDir,'probe-settling.json'))).settlingReceipts[0].sampleId;await f.marker('before',warm);assert.equal((await f.ack('before')).status,'ERROR');assert.match(f.bridge.error.message,/replay/);await assert.rejects(stat(path.join(f.outputDir,'probe-before.json')),{code:'ENOENT'});});

// These execute the actual bridge against a private channel; only public process IO is delayed.
test('host settling budget keeps the default failure and permits three fresh delayed samples only with explicit bounded opt-in',async t=>{
 const baseline=await fixture(t,{identityDelay:2200});await baseline.marker('settle');assert.equal((await baseline.ack('settle')).status,'ERROR');
 const failed=await json(path.join(baseline.outputDir,'probe-settling.json'));assert.equal(failed.budgetMs,6000);assert.ok(failed.consecutive<3);assert.equal(failed.status,'NOT_RUN');
 const extended=await fixture(t,{identityDelay:2200,settlingBudgetMs:10000});await extended.marker('settle');assert.equal((await extended.ack('settle')).status,'OK');
 const ready=await json(path.join(extended.outputDir,'probe-settling.json'));assert.equal(ready.budgetMs,10000);assert.ok(ready.consecutive>=3);assert.ok(ready.quietSpanMs>=1500&&ready.observedQuietSpanMs>=1500);assert.equal(new Set(ready.settlingReceipts.map(r=>r.captureHash)).size,1);
 for(const receipt of ready.settlingReceipts){assert.ok(receipt.elapsedMs.identity>=2000);assert.ok(receipt.elapsedMs.channel>=0);assert.ok(receipt.elapsedMs.total>=receipt.elapsedMs.identity);assert.deepEqual(Object.keys(receipt.elapsedMs).sort(),['channel','identity','total']);}
 const pair=[];for(const phase of ['before','after']){await extended.marker(phase);const ack=await extended.ack(phase);assert.equal(ack.status,'OK');pair.push(await json(path.join(extended.outputDir,ack.file)));}
 const [before,after]=pair;assert.ok(validateProbePair({before,after,expectedBuild:extended.bridge.expectedBuild,session,timing:{axStartedAt:before.finishedAt,axFinishedAt:before.finishedAt,screenshotStartedAt:before.finishedAt,screenshotFinishedAt:before.finishedAt}}).hash);
 assert.equal(new Set(extended.sent.map(x=>x.sample.sampleId)).size,extended.sent.length);
});
test('host settling budget never accepts a changed third delayed tree or starts the strict bracket',async t=>{
 const f=await fixture(t,{identityDelay:2200,settlingBudgetMs:10000,sequence:i=>capture(i<2?1:.3)});await f.marker('settle');assert.equal((await wait(()=>json(path.join(f.outputDir,'probe-ack-settle.json')),11000)).status,'ERROR');
 const failed=await json(path.join(f.outputDir,'probe-settling.json'));assert.equal(failed.status,'NOT_RUN');assert.ok(new Set(failed.settlingReceipts.map(r=>r.captureHash)).size>1);assert.ok(failed.consecutive<3);await assert.rejects(stat(path.join(f.outputDir,'probe-before.json')),{code:'ENOENT'});
});
test('host settling budget retains a finite bound for late identity IO',async t=>{
 const f=await fixture(t,{runDelay:12000,settlingBudgetMs:10000});const start=performance.now();await f.marker('settle');assert.equal((await wait(()=>json(path.join(f.outputDir,'probe-ack-settle.json')),11000)).status,'ERROR');assert.ok(performance.now()-start<10800);assert.equal(f.sent.length,0);assert.ok(f.calls.every(c=>c.options.timeoutMs<=10000));
});
for(const [label,mutate]of [['nonce',s=>s.correlation.nonce='wrong'],['build',s=>s.actualBuild={...s.actualBuild,javascriptSha256:'0'.repeat(64)}]])test(`host settling budget opt-in preserves ${label} rejection`,async t=>{
 const f=await fixture(t,{settlingBudgetMs:10000,mutate});await f.marker('settle');assert.equal((await f.ack('settle')).status,'ERROR');await assert.rejects(stat(path.join(f.outputDir,'probe-before.json')),{code:'ENOENT'});
});

test('host settling budget direct API rejects invalid bounds before any IO',async()=>{
 for(const settlingBudgetMs of [5999,10001,NaN,Infinity,6000.5,'10000',null])assert.throws(()=>startProbeBridge({settleBeforeCapture:true,settlingBudgetMs}),/invalid settling budget/);
 assert.throws(()=>startProbeBridge({settlingBudgetMs:10000}),/requires settling opt-in/);
});
