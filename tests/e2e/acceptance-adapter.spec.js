import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkpoint } from '../../src/sessions.js';
import { verify } from '../../src/workflow.js';
import { verifyVisual } from '../../src/visual.js';
import { hash, processGroupAlive } from '../../src/util.js';

const engine = path.resolve('.');
const sdk = new URL('../../src/acceptance-client.js', import.meta.url).href;
const util = new URL('../../src/util.js', import.meta.url).href;
const playwright = import.meta.resolve('playwright');
const playwrightTest = import.meta.resolve('@playwright/test');
const html = '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif;background:#fafafa}main{margin:40px;padding:24px;width:320px;background:white}button{font:inherit}</style><main id="panel"><h1>Counter fixture</h1><button>Increment</button><output role="status">0</output></main><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent=Number(document.querySelector("output").textContent)+1;</script>';

// A fresh Chromium project fixture exercises the legacy protocol. It is not native or provider acceptance.
async function fixture({ corrupt = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-adapter-browser-e2e-'));
  await fs.mkdir(path.join(root, 'prototype')); await fs.mkdir(path.join(root, 'app'));
  for (const file of ['prototype/index.html', 'app/index.html']) await fs.writeFile(path.join(root, file), html);
  await fs.writeFile(path.join(root, 'functional.spec.mjs'), `import {test,expect} from ${JSON.stringify(playwrightTest)};\ntest('the application counter changes through its user-facing control',async({page})=>{await page.goto(${JSON.stringify(pathToFileURL(path.join(root, 'app/index.html')).href)});await expect(page.getByRole('heading',{name:'Counter fixture'})).toBeVisible();await page.getByRole('button',{name:'Increment'}).click();await expect(page.getByRole('status')).toHaveText('1');});\n`);
  await fs.writeFile(path.join(root, 'playwright.config.mjs'), `export default {testDir:'.',testMatch:'functional.spec.mjs',timeout:10000,workers:1,reporter:'list',use:{headless:true,trace:'retain-on-failure'}};\n`);
  await fs.writeFile(path.join(root, 'adapter.mjs'), `
import {acceptanceClient,runAcceptanceCommand} from ${JSON.stringify(sdk)};
import {processGroupAlive} from ${JSON.stringify(util)};
import {chromium} from ${JSON.stringify(playwright)};
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const client=await acceptanceClient(), request=client.request;
await client.starting('application');
const server=await chromium.launchServer({headless:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
const pid=server.process().pid; await client.started('application',pid);
const browser=await chromium.connect(server.wsEndpoint());
let result;
try {
  const scene=request.scene??{viewport:{width:640,height:480}};
  const context=await browser.newContext({viewport:scene.viewport,deviceScaleFactor:scene.deviceScaleFactor??1,locale:scene.locale??'en-US',timezoneId:scene.timezoneId??'UTC',colorScheme:scene.colorScheme??'light',reducedMotion:'reduce'});
  const page=await context.newPage();
  await page.goto(request.applicationUrl??pathToFileURL(path.join(request.projectRoot,'app/index.html')).href);
  await page.getByRole('heading',{name:'Counter fixture'}).waitFor();
  if(request.phase==='functional') {
    const functional=await runAcceptanceCommand(client,'tests',{argv:[process.execPath,${JSON.stringify(path.join(engine, 'node_modules/@playwright/test/cli.js'))},'test','--config','playwright.config.mjs'],timeoutMs:20000});
    if(functional.status!=='PASS')throw new Error(functional.stderr||functional.stdout||functional.error);
    result={functional};
  } else {
    for(const step of scene.steps??[]) {
      const locator=page.locator(step.application);
      if(step.action==='click')await locator.click(); else if(step.action==='fill')await locator.fill(String(step.value??'')); else throw new Error('Unsupported fixture step');
    }
    await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    await page.screenshot({path:request.capturePath,animations:'disabled',scale:'css'});
    result={sceneId:scene.id,sceneHash:request.sceneHash,stateReady:true,capture:{path:request.capturePath,parameters:request.requestedCapture},regions:[{id:'panel',box:await page.locator('#panel').boundingBox()}]};
    ${corrupt === 'state' ? 'result.stateReady=false;' : corrupt === 'parameters' ? 'result.capture.parameters.viewport.width+=1;' : corrupt === 'scene' ? 'result.sceneHash="incorrect";' : ''}
  }
  await context.close();
} finally {
  await browser.close(); await server.close();
  const deadline=Date.now()+2000;
  while(processGroupAlive(pid)&&Date.now()<deadline)await delay(10);
  if(processGroupAlive(pid))throw new Error('Chromium fixture group survived normal close');
}
await client.finished('application');
await client.result({schemaVersion:1,requestId:request.requestId,phase:request.phase,status:'PASS',applicationSurface:{kind:'chromium',processId:pid},...result});
client.close();
`);
  const config = {
    schemaVersion: 1, prototypeDir: 'prototype',
    mappings: [{ id: 'panel', prototypeFiles: ['prototype/**'], prototype: '#panel', application: '#panel', component: 'app/index.html' }],
    verification: { build: { argv: [process.execPath, '-e', 'process.exit(0)'] }, functional: { adapter: 'acceptance' } },
    adapters: { acceptance: { command: { argv: [process.execPath, 'adapter.mjs'], timeoutMs: 30000 } } },
    visual: { mode: 'adapter', maxDiffRatio: 0, scenes: [{ id: 'counter', prototypeUrl: 'prototype/index.html', applicationUrl: 'app/index.html', viewport: { width: 640, height: 480 }, steps: [{ action: 'click', prototype: 'button', application: 'button' }] }] }
  };
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  return { root, config };
}

test('project adapter binds actual Chromium/Playwright evidence to frozen source, application and artifacts', async ({}, info) => {
  const { root, config } = await fixture(), pids = [];
  try {
    const manifest = await checkpoint(root, config, { summary: 'Self-contained project adapter fixture' });
    const result = await verify(root, config, manifest.id, { onStart: (phase, pid) => pids.push({ phase, pid }) });
    await info.attach('verification', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.status).toBe('PASS'); expect(result.functional.stdout).toContain('1 passed');
    expect(result.functional.applicationSurface.kind).toBe('chromium');
    expect(result.visual.prototypeSource).toBe('version'); expect(result.visual.scenes[0].pixelDiffRatio).toBe(0);
    expect(result.visual.scenes[0].comparison.alignment).toBe('none');
    expect(Object.keys(result.artifactHashes).length).toBeGreaterThanOrEqual(5);
    for (const [relative, expected] of Object.entries(result.artifactHashes)) expect(hash(await fs.readFile(path.join(root, relative)))).toBe(expected);
    for (const { pid } of pids) expect(processGroupAlive(pid)).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const corrupt of ['state', 'parameters', 'scene']) test(`project adapter rejects mismatched ${corrupt} from a real Chromium capture`, async () => {
  const { root, config } = await fixture({ corrupt });
  try {
    const result = await verifyVisual(root, config, path.join(root, '.protoflow/visual'));
    expect(result.status).toBe('FAIL'); expect(result.scenes[0].reasons.join(' ')).toContain('dimensions/state/parameters');
    expect(result.scenes[0].pixelDiffRatio).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('relative prototype URL is rejected before launching an application adapter', async () => {
  const { root, config } = await fixture(); const phases = [];
  try {
    config.visual.scenes[0].applicationUrl = 'app/../prototype/%69ndex.html?state=1#counter';
    const result = await verifyVisual(root, config, path.join(root, '.protoflow/visual'), { onBeforeSpawn: phase => phases.push(phase) });
    expect(result.status).toBe('FAIL'); expect(result.scenes[0].reasons.join(' ')).toContain('cannot load prototype HTML');
    expect(phases.filter(phase => phase.includes('adapter'))).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
