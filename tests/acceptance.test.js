import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAcceptanceAdapter, sceneEvidenceHash, acceptanceApplicationUrl } from '../src/acceptance.js';
import { processGroupAlive } from '../src/util.js';

// Protocol/process fixtures only: these do not claim native UI, GitHub or provider acceptance.
const sdk = new URL('../src/acceptance-client.js', import.meta.url).href;
async function fixture(body, { timeoutMs = 5000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-acceptance-contract-'));
  await fs.writeFile(path.join(root, 'adapter.mjs'), `import {acceptanceClient,runAcceptanceCommand} from ${JSON.stringify(sdk)};\nimport {spawn} from 'node:child_process';\nimport {once} from 'node:events';\nconst client=await acceptanceClient(); const request=client.request;\n${body}\n`);
  return { root, config: { adapters: { acceptance: { command: { argv: [process.execPath, 'adapter.mjs'], timeoutMs } } } } };
}
const launch = `await client.starting('surface'); const surface=spawn(process.execPath,['-e','process.stdin.resume()'],{detached:true,stdio:['pipe','ignore','ignore']}); await client.started('surface',surface.pid);`;
const close = `surface.stdin.end(); const [code,signal]=await once(surface,'close'); if(code!==0||signal)throw new Error('Fixture did not exit normally'); await client.finished('surface');`;
const pass = `await client.result({schemaVersion:1,requestId:request.requestId,phase:request.phase,status:'PASS',applicationSurface:{kind:'fixture',processId:surface.pid},functional:{status:'PASS',exitCode:0,stdout:'你好 fixture'}}); client.close();`;

test('SDK waits for durable launch/PID acknowledgements before command argv and completes actual groups', async () => {
  const { root, config } = await fixture(`${launch}\nconst result=await runAcceptanceCommand(client,'tests',{argv:[process.execPath,'-e','require("fs").writeFileSync("ran.json",JSON.stringify(process.env.ACCEPTANCE_FIXTURE));console.log("你好 fixture")']},{env:{...process.env,ACCEPTANCE_FIXTURE:'explicit argv'}}); if(result.status!=='PASS'||!result.stdout.includes('你好 fixture'))throw new Error(result.error??result.stdout);\n${close}\n${pass}`);
  const events = [];
  try {
    const result = await runAcceptanceAdapter(root, config, 'functional', {}, {
      onBeforeSpawn: async phase => {
        if (phase === 'functional-adapter-tests') await assert.rejects(fs.access(path.join(root, 'ran.json')), { code: 'ENOENT' });
        events.push(['intent', phase]);
      },
      onStart: async (phase, pid) => {
        assert.equal(processGroupAlive(pid), true);
        if (phase === 'functional-adapter-tests') {
          await new Promise(resolve => setTimeout(resolve, 30));
          await assert.rejects(fs.access(path.join(root, 'ran.json')), { code: 'ENOENT' });
        }
        events.push(['start', phase, pid]);
      },
      onFinish: (phase, pid, value) => { assert.equal(value.processGroupActive, false); if (pid) assert.equal(processGroupAlive(pid), false); events.push(['finish', phase, pid]); }
    });
    assert.equal(result.status, 'PASS'); assert.equal(result.adapter.processes.length, 2);
    assert.equal(result.stdout, '你好 fixture'); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'ran.json'), 'utf8')), 'explicit argv');
    for (const phase of ['functional-adapter', 'functional-adapter-surface', 'functional-adapter-tests']) assert.deepEqual(events.filter(event => event[1] === phase).map(event => event[0]), ['intent', 'start', 'finish']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('zero exit, malformed/incomplete JSONL and unbound PASS cannot become acceptance', async () => {
  for (const body of ['client.close();', 'process.stdout.write("not json\\n"); client.close();', 'process.stdout.write("{\\\"seq\\\":1}");client.close();', `await client.result({schemaVersion:1,requestId:request.requestId,phase:request.phase,status:'PASS'});client.close();`]) {
    const { root, config } = await fixture(body);
    try { assert.equal((await runAcceptanceAdapter(root, config, 'functional', {})).status, 'FAIL'); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('unknown child spawn blocks recovery without marking an unrecorded PID complete', async () => {
  const { root, config } = await fixture("await client.starting('surface'); process.exit(1);"); const events = [];
  try {
    await assert.rejects(runAcceptanceAdapter(root, config, 'visual', {}, { onBeforeSpawn: phase => events.push(phase), onFinish: phase => events.push(`finished:${phase}`) }), error => error.code === 'PROCESS_START_UNKNOWN');
    assert.ok(events.includes('visual-adapter-surface')); assert.ok(!events.includes('finished:visual-adapter-surface'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('adapter crash cleans its acknowledged independent application group', async () => {
  const { root, config } = await fixture(`${launch}\nprocess.exit(2);`); let pid;
  try {
    const result = await runAcceptanceAdapter(root, config, 'visual', {}, { onStart: (phase, value) => { if (phase.endsWith('-surface')) pid = value; } });
    assert.equal(result.status, 'FAIL'); assert.ok(pid); assert.equal(processGroupAlive(pid), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const mode of ['crash', 'timeout']) test(`adapter ${mode} with inherited output pipes remains bounded and cleans its acknowledged group`, async () => {
  const inherited = launch.replace("'process.stdin.resume()'", "'setInterval(()=>{},1000)'").replace("stdio:['pipe','ignore','ignore']", "stdio:'inherit'");
  const { root, config } = await fixture(`${inherited}\n${mode === 'crash' ? 'process.exit(2);' : 'setInterval(()=>{},1000);'}`, { timeoutMs: 1500 }); let pid;
  const started = Date.now();
  try {
    const result = await runAcceptanceAdapter(root, config, 'visual', {}, { onStart: (phase, value) => { if (phase.endsWith('-surface')) pid = value; } });
    assert.equal(result.status, 'FAIL'); assert.ok(pid); assert.equal(processGroupAlive(pid), false); assert.ok(Date.now() - started < 5000);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('abort cleans acknowledged adapter/application groups before STOPPED', async () => {
  const { root, config } = await fixture(`${launch}\nawait new Promise(()=>{});`); const controller = new AbortController(), pids = [];
  try {
    await assert.rejects(runAcceptanceAdapter(root, config, 'visual', {}, { signal: controller.signal, onStart: (phase, pid) => { pids.push(pid); if (phase.endsWith('-surface')) setTimeout(() => controller.abort(), 50); } }), /STOPPED/);
    assert.equal(pids.length, 2); for (const pid of pids) assert.equal(processGroupAlive(pid), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('completion persistence failure still cleans groups and fails closed', async () => {
  const { root, config } = await fixture(`${launch}\n${close}\n${pass}`); let pid;
  try {
    await assert.rejects(runAcceptanceAdapter(root, config, 'functional', {}, { onStart: (phase, value) => { if (phase.endsWith('-surface')) pid = value; }, onFinish: phase => { if (phase.endsWith('-surface')) throw new Error('durable completion rejected'); } }), /durable completion rejected/);
    assert.equal(processGroupAlive(pid), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('foreign PID is rejected and never killed', async () => {
  const { root, config } = await fixture(`await client.starting('surface'); await client.started('surface',${process.pid});`);
  try { await assert.rejects(runAcceptanceAdapter(root, config, 'visual', {}), error => error.code === 'PROCESS_START_UNKNOWN'); process.kill(process.pid, 0); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('scene hash binds URLs, viewport, fixture, steps, masks and environment', () => {
  const scene = { id: 'example', prototypeUrl: 'prototype/a.html', applicationUrl: 'app/a.html', viewport: { width: 10, height: 10 } };
  for (const [key, value] of Object.entries({ prototypeUrl: 'prototype/b.html', applicationUrl: 'app/b.html', viewport: { width: 11, height: 10 }, fixture: { value: 1 }, steps: [{ action: 'click' }], masks: [{ application: '#clock' }], locale: 'zh-TW' })) assert.notEqual(sceneEvidenceHash(scene), sceneEvidenceHash({ ...scene, [key]: value }));
});

test('relative, file and symlink prototype targets cannot masquerade as application captures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-acceptance-url-'));
  try {
    for (const directory of ['prototype', 'app', '.protoflow/versions/v1']) await fs.mkdir(path.join(root, directory), { recursive: true });
    for (const file of ['prototype/index.html', 'app/index.html', '.protoflow/versions/v1/index.html']) await fs.writeFile(path.join(root, file), '<!doctype html>');
    await fs.symlink(path.join(root, 'prototype'), path.join(root, 'alias'));
    const config = { prototypeDir: 'prototype/' };
    for (const value of ['prototype/index.html', 'app/../prototype/index.html?state=1#initial', './prototype/%69ndex.html', '.protoflow/versions/v1/index.html', 'alias/index.html', pathToFileURL(path.join(root, 'prototype/index.html')).href]) await assert.rejects(acceptanceApplicationUrl(root, config, value), /cannot load prototype HTML/);
    assert.equal(await acceptanceApplicationUrl(root, config, 'app/index.html?state=1#initial'), `${pathToFileURL(await fs.realpath(path.join(root, 'app/index.html'))).href}?state=1#initial`);
    assert.equal(await acceptanceApplicationUrl(root, config, 'app://main'), 'app://main');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
