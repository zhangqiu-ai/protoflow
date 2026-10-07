import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyVisual } from '../../src/visual.js';
import { processGroupAlive } from '../../src/util.js';
import { git, scanSource, sourceStatus } from '../../src/source.js';
import { runOnce, retryRunner, runnerStatus } from '../../src/runner.js';

const demoRoot = path.resolve('examples/demo');
const visualConfig = { mappings: [{ id: 'card', prototype: '#card', application: '[data-ui=card]' }], visual: { scenes: [{ prototypeUrl: 'prototype/index.html', applicationUrl: 'app/index.html', viewport: { width: 1000, height: 720 } }] } };
async function groupEnded(pid) {
  const deadline = Date.now() + 5000;
  while (processGroupAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Browser group ${pid} did not end`);
    await delay(10);
  }
}

test('real Chromium persists launch intent and PID before screenshots, and completes only after its group ends', async ({}, info) => {
  const events = [], record = {}, file = info.outputPath('browser-lifecycle.json');
  const save = () => fs.writeFile(file, JSON.stringify(record));
  const result = await verifyVisual(demoRoot, visualConfig, info.outputPath('visual'), {
    onBeforeSpawn: async phase => { events.push('intent'); record.phase = phase; record.status = 'STARTING'; record.pid = null; await save(); },
    onStart: async (phase, pid) => {
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ phase: 'visual', status: 'STARTING', pid: null });
      expect(phase).toBe('visual'); expect(processGroupAlive(pid)).toBe(true);
      events.push('start'); record.pid = pid; record.pgid = pid; record.status = 'RUNNING'; await save();
    },
    onFinish: async (phase, pid, result) => {
      expect(phase).toBe('visual'); expect(pid).toBe(record.pid); expect(processGroupAlive(pid)).toBe(false);
      expect(result).toMatchObject({ status: 'PASS', spawned: true, processGroupActive: false });
      events.push('finish'); record.status = result.status; record.completedAt = new Date().toISOString(); await save();
    }
  });
  expect(result.status).toBe('PASS'); expect(result.artifacts).toHaveLength(6);
  expect(events).toEqual(['intent', 'start', 'finish']); expect(record.completedAt).toBeTruthy();
});

for (const abortAt of ['start', 'navigation']) {
test(`abort during real Chromium ${abortAt} waits for browser-group cleanup and prevents visual artifacts`, async ({}, info) => {
  const controller = new AbortController(), finishes = []; let browserPid;
  await assert.rejects(verifyVisual(demoRoot, visualConfig, info.outputPath('visual'), {
    signal: controller.signal,
    onStart: (phase, pid) => { expect(phase).toBe('visual'); browserPid = pid; expect(processGroupAlive(pid)).toBe(true); if (abortAt === 'start') controller.abort(); else setTimeout(() => controller.abort(), 150); },
    onFinish: (phase, pid, result) => { finishes.push(phase); expect(pid).toBe(browserPid); expect(processGroupAlive(pid)).toBe(false); expect(result).toMatchObject({ status: 'FAIL', spawned: true, aborted: true, processGroupActive: false }); }
  }), /STOPPED: visual verification was interrupted/);
  expect(finishes).toEqual(['visual']); expect(processGroupAlive(browserPid)).toBe(false);
  await assert.rejects(fs.access(info.outputPath('visual/visual-review.html')), error => error.code === 'ENOENT');
});

}

test('Chromium lifecycle hook failures fail closed and still terminate the actual browser group', async ({}, info) => {
  for (const failAt of ['start', 'finish']) {
    let browserPid, finished = false;
    await assert.rejects(verifyVisual(demoRoot, visualConfig, info.outputPath(failAt), {
      onStart: (phase, pid) => { browserPid = pid; if (failAt === 'start') throw new Error('Cannot persist browser PID'); },
      onFinish: (phase, pid, result) => {
        finished = true; expect(processGroupAlive(pid)).toBe(false); expect(result.processGroupActive).toBe(false);
        if (failAt === 'finish') throw new Error('Cannot persist browser completion');
      }
    }), failAt === 'start' ? /Cannot persist browser PID/ : /Cannot persist browser completion/);
    expect(finished).toBe(true); expect(processGroupAlive(browserPid)).toBe(false);
  }
});

test('visual abort before launch completes its known unspawned intent', async ({}, info) => {
  const controller = new AbortController(); let starts = 0, finish;
  await assert.rejects(verifyVisual(demoRoot, visualConfig, info.outputPath('visual'), {
    signal: controller.signal, onBeforeSpawn: () => controller.abort(), onStart: () => starts++,
    onFinish: (phase, pid, result) => { finish = { phase, pid, ...result }; }
  }), /STOPPED/);
  expect(starts).toBe(0); expect(finish).toMatchObject({ phase: 'visual', pid: null, status: 'FAIL', spawned: false, processGroupActive: false, aborted: true });
});

async function runnerFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-browser-runner-'));
  const source = path.join(directory, 'source'), root = path.join(directory, 'app');
  for (const location of [source, root]) {
    await fs.mkdir(location); await git(location, ['init', '-b', 'main']);
    await git(location, ['config', 'user.name', 'Fixture']); await git(location, ['config', 'user.email', 'fixture@example.test']);
    await fs.writeFile(path.join(location, 'README.md'), 'local browser crash fixture; no provider');
    await git(location, ['add', 'README.md']); await git(location, ['commit', '-m', 'baseline']);
  }
  const baseline = (await git(source, ['rev-parse', 'HEAD'])).trim(), html = '<button id="button">Save</button>';
  await fs.mkdir(path.join(source, 'prototype')); await fs.writeFile(path.join(source, 'prototype/index.html'), html);
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'frozen button']);
  const pass = { argv: [process.execPath, '-e', 'process.exit(0)'] };
  const config = { schemaVersion: 1, prototypeDir: 'prototype', source: { kind: 'git', repository: source, branch: 'main', path: 'prototype', startSha: baseline }, mappings: [{ id: 'button', prototypeFiles: ['prototype/**'], prototype: '#button', application: '#button', component: 'app.html' }], adapters: { codex: { command: pass } }, policy: { maxRepairAttempts: 2 }, verification: { build: pass, functional: pass }, visual: { scenes: [{ prototypeUrl: 'prototype/index.html', applicationUrl: 'app.html', viewport: { width: 300, height: 200 } }] } };
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config)); await fs.writeFile(path.join(root, 'app.html'), html);
  await scanSource(root, config); return { directory, root, config };
}
for (const launchWindow of ['STARTING', 'RUNNING']) {
  test(`SIGKILL with visual ${launchWindow} preserves browser identity and blocks unsafe retry (argv fixture, no provider)`, async ({}, info) => {
    const { directory, root, config } = await runnerFixture();
    let worker, browserPid;
    try {
      const runnerUrl = new URL('../../src/runner.js', import.meta.url).href;
      const script = `
        import fs from 'node:fs/promises';
        import {syncBuiltinESMExports} from 'node:module';
        const root = await fs.realpath(process.argv[1]), status = process.argv[2];
        const target = root + '/.protoflow/source/state.json', rename = fs.rename;
        fs.rename = async (from, to) => {
          await rename(from, to);
          if (to === target) {
            const state = JSON.parse(await fs.readFile(target, 'utf8'));
            const child = state.entries[0].attempts[0]?.processes?.find(item => item.phase === 'visual' && item.status === status);
            if (child) {
              await fs.writeFile(root + '/.protoflow/browser-barrier.json', JSON.stringify(child));
              setInterval(()=>{},1000); await new Promise(()=>{});
            }
          }
        };
        syncBuiltinESMExports();
        const {runOnce} = await import(${JSON.stringify(runnerUrl)});
        console.log(JSON.stringify(await runOnce(root, JSON.parse(await fs.readFile(root + '/protoflow.config.json', 'utf8')))));
      `;
      worker = spawn(process.execPath, ['--input-type=module', '-e', script, root, launchWindow], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; worker.stdout.on('data', value => { log += value; }); worker.stderr.on('data', value => { log += value; });
      const deadline = Date.now() + 15000; let identity;
      while (!identity) {
        try { identity = JSON.parse(await fs.readFile(path.join(root, '.protoflow/browser-barrier.json'), 'utf8')); } catch {}
        if (Date.now() > deadline) throw new Error(`Browser launch barrier absent: ${log}`);
        if (!identity) await delay(10);
      }
      browserPid = identity.pid;
      const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
      const state = await sourceStatus(root), record = state.entries[0].attempts[0];
      expect(record.processes.filter(item => item.phase !== 'visual').every(item => item.completedAt)).toBe(true);
      expect(record.processes.find(item => item.phase === 'visual').completedAt).toBeUndefined();
      await fs.writeFile(info.outputPath('interrupted-browser-state.json'), JSON.stringify(state, null, 2));
      if (launchWindow === 'STARTING') {
        expect(browserPid).toBeNull(); await assert.rejects(retryRunner(root), /visual launch has unknown PID/);
        const blocked = await runOnce(root, config); expect(blocked.status).toBe('BLOCKED'); expect(blocked.reason).toContain('visual launch has unknown PID');
      } else {
        expect(processGroupAlive(browserPid)).toBe(true); await assert.rejects(retryRunner(root), /visual process group .*still active/);
        expect((await runOnce(root, config)).status).toBe('BLOCKED'); expect((await sourceStatus(root)).entries[0].attempts).toHaveLength(1);
        process.kill(-browserPid, 'SIGKILL'); await groupEnded(browserPid);
        expect((await retryRunner(root)).status).toBe('PASS');
        const recovered = await runOnce(root, config); expect(recovered.status).toBe('PASS');
        const final = await runnerStatus(root), rows = final.source.entries[0].attempts;
        expect(rows).toHaveLength(2); expect(rows[0].processes.find(item => item.phase === 'visual').completedAt).toBeTruthy();
        expect(rows[1].processes.find(item => item.phase === 'visual')).toMatchObject({ status: 'PASS', processGroupActive: false });
        expect(rows[1].processes.every(item => item.completedAt)).toBe(true); expect(final.runner.status).toBe('IDLE');
        await fs.writeFile(info.outputPath('recovered-browser-state.json'), JSON.stringify(final, null, 2));
      }
    } finally {
      worker?.kill('SIGKILL');
      if (browserPid) { try { process.kill(-browserPid, 'SIGKILL'); } catch {} await groupEnded(browserPid); }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
