import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { scanSource, sourceStatus, git, gitSnapshot } from '../src/source.js';
import { runOnce, retryRunner, configureRunner, startRunner, runnerStatus } from '../src/runner.js';
import { versionQueue } from '../src/queue.js';
import { verify } from '../src/workflow.js';
import { loadVersion } from '../src/versions.js';
import { runCommand, withLock, hash, fingerprint, processGroupAlive } from '../src/util.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-git-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), root = path.join(directory, 'app');
  for (const location of [source, root]) {
    await fs.mkdir(location); await git(location, ['init', '-b', 'main']);
    await git(location, ['config', 'user.name', 'Fixture']); await git(location, ['config', 'user.email', 'fixture@example.test']);
    await fs.writeFile(path.join(location, 'README.md'), 'local Git fixture, no GitHub writes');
    await git(location, ['add', 'README.md']); await git(location, ['commit', '-m', 'baseline']);
  }
  const baseline = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await fs.mkdir(path.join(source, 'prototype'));
  const page = label => `<button id="button">${label}</button>`;
  const shas = [];
  for (const label of ['Save', 'Publish']) {
    await fs.writeFile(path.join(source, 'prototype/index.html'), page(label));
    await fs.writeFile(path.join(source, 'prototype/styles.css'), `button{color:${label === 'Save' ? 'teal' : 'purple'}}`);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', label]);
    shas.push((await git(source, ['rev-parse', 'HEAD'])).trim());
  }
  const config = { schemaVersion: 1, prototypeDir: 'prototype', source: { kind: 'git', repository: source, branch: 'main', path: 'prototype', startSha: baseline },
    mappings: [{ id: 'button', prototypeFiles: ['prototype/**'], prototype: '#button', application: '#button', component: 'app.html' }], policy: { maxRepairAttempts: 0 },
    adapters: { codex: { command: { argv: [process.execPath, '-e', 'process.exit(9)'] } } } };
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, 'app.html'), page('Draft'));
  return { root, source, config, shas, baseline };
}
test('local Git fixture: offline catch-up freezes two SHAs and full assets, dedupes on restart, ignores live files', async t => {
  const { root, source, config, shas } = await fixture(t);
  const first = await scanSource(root, config);
  assert.deepEqual(first.state.entries.map(item => item.sha), shas);
  const [one, two] = await Promise.all(first.added.map(id => fs.readFile(path.join(root, '.protoflow/manifests', `${id}.json`), 'utf8').then(JSON.parse)));
  assert.equal(two.beforeHash, one.afterHash);
  const frozen = await loadVersion(root, config, one);
  assert.match(await fs.readFile(path.join(root, frozen.prototypeDir, 'index.html'), 'utf8'), /Save/);
  assert.match(await fs.readFile(path.join(root, frozen.prototypeDir, 'styles.css'), 'utf8'), /teal/);
  await fs.writeFile(path.join(source, 'prototype/index.html'), 'uncommitted newer content');
  assert.deepEqual((await scanSource(root, config)).added, []);
  await fs.mkdir(path.join(root, 'prototype')); await fs.writeFile(path.join(root, 'prototype/index.html'), 'local edits are not a trigger');
  assert.deepEqual((await scanSource(root, config)).added, []);
  await fs.writeFile(path.join(source, 'notes.txt'), 'unrelated commit');
  await git(source, ['add', 'notes.txt']); await git(source, ['commit', '-m', 'Unrelated']);
  assert.deepEqual((await scanSource(root, config)).added, []);
  assert.equal((await sourceStatus(root)).entries.length, 2);
  assert.equal((await versionQueue(root, config)).current.id, one.id);
  await fs.writeFile(path.join(root, frozen.prototypeDir, 'styles.css'), 'tampered');
  await assert.rejects(loadVersion(root, config, one), /version store changed/);
});
test('local Git fixture: rewrite/rewind fails explicitly and preserves cursor and queue', async t => {
  const { root, source, config, shas } = await fixture(t);
  await scanSource(root, config);
  await git(source, ['update-ref', 'refs/heads/main', shas[0]]);
  await assert.rejects(scanSource(root, config), error => error.code === 'SOURCE_HISTORY_REWRITTEN');
  const state = await sourceStatus(root);
  assert.equal(state.status, 'HISTORY_REWRITTEN'); assert.equal(state.scannedSha, shas[1]); assert.equal(state.entries.length, 2);
  await assert.rejects(runOnce(root, config), /SOURCE_HISTORY_REWRITTEN/);
});
test('local Git fixture: transport failure retains durable progress and catches up after reconnection', async t => {
  const { root, source, config, shas } = await fixture(t);
  await git(source, ['update-ref', 'refs/heads/main', shas[0]]); await scanSource(root, config);
  await fs.rename(source, `${source}-offline`);
  await assert.rejects(scanSource(root, config));
  assert.equal((await sourceStatus(root)).scannedSha, shas[0]);
  await fs.rename(`${source}-offline`, source); await git(source, ['update-ref', 'refs/heads/main', shas[1]]);
  assert.equal((await scanSource(root, config)).added.length, 1);
  assert.equal((await sourceStatus(root)).entries.length, 2);
});
test('local Git fixture: symlink resources are rejected rather than incompletely frozen', async t => {
  const { source, config } = await fixture(t);
  await fs.symlink('../README.md', path.join(source, 'prototype/escape'));
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'symlink']);
  const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await assert.rejects(gitSnapshot(source, sha, config), /symlink\/submodule/);
});
test('runner unit fixture (failing argv, no Codex provider): blocks FIFO, preserves primary dirty files, retries only current', async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), 'uncommitted user edit');
  const before = await git(root, ['status', '--porcelain=v1']);
  await scanSource(root, config);
  const result = await runOnce(root, config);
  assert.equal(result.status, 'BLOCKED');
  let state = await sourceStatus(root);
  assert.equal(state.entries[0].status, 'BLOCKED'); assert.equal(state.entries[1].status, 'PENDING');
  assert.equal(state.entries[0].attempts.length, 1); assert.equal(state.entries[1].attempts.length, 0);
  const attempt = state.entries[0].attempts[0];
  assert.equal(attempt.status, 'FAIL'); assert.ok(attempt.completedAt); assert.match(attempt.error, /exit 9/);
  assert.equal((await runOnce(root, config)).status, 'BLOCKED');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'uncommitted user edit');
  assert.equal((await git(root, ['status', '--porcelain=v1'])).replace(/\?\? \.protoflow\/\n/g, ''), before);
  await retryRunner(root); await runOnce(root, config); state = await sourceStatus(root);
  assert.equal(state.entries[0].attempts.length, 2); assert.equal(state.entries[1].attempts.length, 0);
});
test('foreground runner reports failed initial fetch as failure instead of idle success', async t => {
  const { root, config } = await fixture(t);
  const result = await startRunner(root, { ...config, source: { ...config.source, repository: path.join(root, 'missing-source') } }, { once: true });
  assert.equal(result.status, 'SCAN_FAILED');
});
test('source rejects missing and mutable resource references instead of freezing partial assets', async t => {
  const { source, config } = await fixture(t);
  for (const reference of ['missing.css', 'https://example.test/style.css']) {
    await fs.writeFile(path.join(source, 'prototype/index.html'), `<link rel="stylesheet" href="${reference}"><button id="button">Save</button>`);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', reference]);
    const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
    await assert.rejects(gitSnapshot(source, sha, config), /resource is not frozen/);
  }
});
test('checkpoint publication interrupted before cursor update reuses the same manifest without duplicates', async t => {
  const { root, config, shas } = await fixture(t);
  const scan = await scanSource(root, config);
  const interrupted = { ...scan.state, scannedSha: shas[0], entries: scan.state.entries.slice(0, 1) };
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(interrupted));
  const recovered = await scanSource(root, config);
  assert.deepEqual(recovered.state.entries.map(entry => entry.sha), shas);
  assert.equal((await fs.readdir(path.join(root, '.protoflow/manifests'))).length, 2);
});
test('explicit configuration recovery updates only operational fields and keeps failed attempt evidence', async t => {
  const { root, config } = await fixture(t);
  await scanSource(root, config); await runOnce(root, config);
  const updated = { ...config, adapters: { codex: { command: { argv: [process.execPath, '-e', 'process.exit(8)'] } } } };
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(updated));
  const configured = await configureRunner(root, updated);
  assert.equal(configured.status, 'PASS'); assert.equal(configured.configHash, hash(updated));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(configured.worktree, 'protoflow.config.json'), 'utf8')), updated);
  assert.equal((await sourceStatus(root)).entries[0].attempts.length, 1);
  await retryRunner(root); assert.equal((await runOnce(root, updated)).status, 'BLOCKED');
  const attempts = (await sourceStatus(root)).entries[0].attempts;
  assert.equal(attempts.length, 2); assert.match(attempts[1].error, /exit 8/);
  for (const forbidden of [{ ...updated, source: { ...updated.source, branch: 'other' } }, { ...updated, prototypeDir: 'other' }, { ...updated, mappings: [{ ...updated.mappings[0], prototypeFiles: ['other/**'] }] }]) {
    await assert.rejects(configureRunner(root, forbidden), /Cannot change source/);
  }
});
test('stop aborts a running process and dead-owner locks recover conservatively', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-stop-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const operation = runCommand(directory, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000 }, null, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await operation; assert.equal(result.status, 'FAIL'); assert.equal(result.aborted, true);
  await fs.mkdir(path.join(directory, '.protoflow/runner.lock'), { recursive: true });
  await fs.writeFile(path.join(directory, '.protoflow/runner.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  assert.equal(await withLock(directory, () => 'recovered', 'runner'), 'recovered');
  await fs.mkdir(path.join(directory, '.protoflow/active.lock'));
  await assert.rejects(withLock(directory, () => 'must not run'), /inspect its owner/);
});

test('history rewrite remains blocked through offline fetches until ancestry is confirmed again', async t => {
  const { root, source, config, shas } = await fixture(t);
  await scanSource(root, config);
  await git(source, ['update-ref', 'refs/heads/main', shas[0]]);
  await assert.rejects(scanSource(root, config), error => error.code === 'SOURCE_HISTORY_REWRITTEN');
  const rewritten = await sourceStatus(root);
  await fs.rename(source, `${source}-offline`);
  await assert.rejects(scanSource(root, config));
  const offline = await sourceStatus(root);
  assert.equal(offline.status, 'HISTORY_REWRITTEN'); assert.equal(offline.error, rewritten.error);
  assert.notEqual(offline.lastScanError, rewritten.error);
  assert.deepEqual(offline.entries, rewritten.entries); assert.equal(offline.scannedSha, shas[1]);
  await assert.rejects(runOnce(root, config), /SOURCE_HISTORY_REWRITTEN/);
  await assert.rejects(startRunner(root, config, { once: true }), /SOURCE_HISTORY_REWRITTEN/);
  await assert.rejects(fs.access(path.join(root, '.protoflow/runner/state.json')), error => error.code === 'ENOENT');
  await fs.rename(`${source}-offline`, source);
  await assert.rejects(scanSource(root, config), error => error.code === 'SOURCE_HISTORY_REWRITTEN');
  await git(source, ['update-ref', 'refs/heads/main', shas[1]]);
  assert.equal((await scanSource(root, config)).state.status, 'READY');
  assert.equal((await runOnce(root, config)).status, 'BLOCKED');
});
test('static resource attributes freeze every srcset candidate, poster, preload, embed and SVG reference', async t => {
  const { source, config } = await fixture(t);
  for (const file of ['one.png', 'two.png', 'poster.png', 'movie.mp4', 'captions.vtt', 'icon.svg']) {
    await fs.writeFile(path.join(source, 'prototype', file), 'vendored fixture');
  }
  const local = '<img srcset="one.png 1x, two.png 2x"><video src="movie.mp4" poster="poster.png"><track src="captions.vtt"></video><link rel="preload" href="one.png" imagesrcset="one.png 1x, two.png 2x"><object data="icon.svg"></object><svg><image href="one.png"/><use xlink:href="icon.svg#mark"/></svg>';
  await fs.writeFile(path.join(source, 'prototype/index.html'), local);
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Vendored attributes']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
  const mutable = [
    '<img srcset="one.png 1x, https://example.test/two.png 2x">',
    '<source srcset="https://example.test/image.png 800w">',
    '<video src="movie.mp4" poster="https://example.test/poster.png"></video>',
    '<link rel="preload" href="one.png" imagesrcset="one.png 1x, https://example.test/image.png 2x">',
    '<track src=https://example.test/captions.vtt>',
    '<object data="https://example.test/icon.svg"></object>',
    '<svg><image href="https://example.test/image.png"/></svg>',
    '<input type=image src="https&#58;//example.test/image.png">',
    '<base href="https://example.test/"><img src="one.png">',
    '<iframe srcdoc="&lt;img src=&quot;https://example.test/image.png&quot;&gt;"></iframe>',
    '<img srcset="one.png 1x, missing.png 2x">',
    '<video poster="missing.png"></video>'
  ];
  for (const html of mutable) {
    await fs.writeFile(path.join(source, 'prototype/index.html'), html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Mutable attribute']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /resource is not frozen/);
  }
});
test('stopping during execution closes the active attempt and leaves the next version pending', async t => {
  const { root, config } = await fixture(t);
  config.adapters.codex.command.argv = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await scanSource(root, config);
  const controller = new AbortController();
  const result = await runOnce(root, config, { signal: controller.signal, onEvent: event => {
    if (event.event === 'execute') setTimeout(() => controller.abort(), 50);
  } });
  assert.equal(result.status, 'BLOCKED');
  const state = await sourceStatus(root), attempt = state.entries[0].attempts[0];
  assert.equal(state.entries[0].status, 'STOPPED'); assert.equal(state.entries[1].status, 'PENDING');
  assert.equal(attempt.status, 'STOPPED'); assert.equal(attempt.executionStatus, 'FAIL'); assert.ok(Number.isSafeInteger(attempt.pid));
  assert.ok(attempt.completedAt); assert.match(attempt.error, /STOPPED/);
});
test('verification I/O failure closes the attempt while retaining successful execution evidence', async t => {
  const { root, config } = await fixture(t);
  config.adapters.codex.command.argv = [process.execPath, '-e', 'process.exit(0)'];
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await scanSource(root, config);
  const result = await runOnce(root, config, { onEvent: async event => {
    if (event.event === 'execute') await fs.writeFile(path.join(event.worktree, '.protoflow/artifacts'), 'blocks verification mkdir');
  } });
  assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /ENOTDIR/);
  const state = await sourceStatus(root), attempt = state.entries[0].attempts[0];
  assert.equal(attempt.executionStatus, 'PASS'); assert.ok(attempt.executionId);
  assert.equal(attempt.status, 'FAIL'); assert.ok(attempt.completedAt); assert.match(attempt.error, /ENOTDIR/);
  assert.equal(state.entries[1].status, 'PENDING');
});
test('simultaneous stale-owner reclaimers cannot remove the new owner or overlap actions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-lock-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/util.js', import.meta.url).href;
  // Hold each child's initial dead-owner read so B resumes only after A owns the
  // replacement lock. The old read/remove recursion deterministically deleted A.
  const child = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { setTimeout as delay } from 'node:timers/promises';
    const [inputRoot, actor] = process.argv.slice(1);
    const root = await fs.realpath(inputRoot);
    const owner = path.join(root, '.protoflow/runner.lock/owner.json');
    const marker = name => path.join(root, name);
    const waitFor = async name => {
      const deadline = Date.now() + 5000;
      while (true) {
        try { await fs.access(marker(name)); return; } catch {}
        if (Date.now() > deadline) throw new Error('Barrier timeout: ' + name);
        await delay(5);
      }
    };
    const originalReadFile = fs.readFile;
    let paused = false;
    fs.readFile = async (file, ...args) => {
      const content = await originalReadFile(file, ...args);
      if (file === owner && !paused && JSON.parse(content).token === 'dead') {
        paused = true; await fs.writeFile(marker(actor + '-ready'), '');
        await waitFor('a-ready'); await waitFor('b-ready');
        if (actor === 'b') await waitFor('a-acquired');
      }
      return content;
    };
    syncBuiltinESMExports();
    const { withLock } = await import(${JSON.stringify(moduleUrl)});
    let status, failure;
    try {
      await withLock(root, async () => {
        await fs.appendFile(marker('events'), actor + '-start\\n');
        if (actor === 'a') { await fs.writeFile(marker('a-acquired'), ''); await waitFor('b-done'); }
        await fs.appendFile(marker('events'), actor + '-end\\n');
      }, 'runner');
      status = 'PASS';
    } catch (error) { status = 'BLOCKED'; failure = error.message; }
    if (actor === 'b') await fs.writeFile(marker('b-done'), '');
    console.log(JSON.stringify({ actor, status, failure }));
  `;
  for (let round = 0; round < 3; round++) {
    const root = path.join(directory, String(round));
    await fs.mkdir(path.join(root, '.protoflow/runner.lock'), { recursive: true });
    await fs.writeFile(path.join(root, '.protoflow/runner.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
    const results = await Promise.all(['a', 'b'].map(actor => runCommand(root, { argv: [process.execPath, '--input-type=module', '-e', child, root, actor], timeoutMs: 10000 })));
    assert.ok(results.every(result => result.status === 'PASS'), JSON.stringify(results));
    assert.deepEqual(results.map(result => JSON.parse(result.stdout).status), ['PASS', 'BLOCKED'], JSON.stringify(results));
    assert.equal(await fs.readFile(path.join(root, 'events'), 'utf8'), 'a-start\na-end\n');
    assert.equal(await withLock(root, () => 'next', 'runner'), 'next');
  }
});
test('an interrupted recovery mutex requires manual inspection and leaves the stale lock intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-lock-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, '.protoflow/runner.lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await fs.mkdir(`${lock}.recovery`);
  await assert.rejects(withLock(root, () => 'must not run', 'runner'), /recovery.*inspect its owner/);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).token, 'dead');
});

test('command records child PID before delivering stdin and fails closed when recording fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-command-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'child.json');
  const script = 'const fs=require("node:fs");process.stdin.once("data",()=>process.stdout.write(fs.readFileSync(process.argv[1],"utf8")))';
  const result = await runCommand(root, { argv: [process.execPath, '-e', script, marker] }, { kind: 'implement' }, {
    onStart: async pid => { process.kill(pid, 0); await delay(30); await fs.writeFile(marker, JSON.stringify({ pid })); }
  });
  assert.equal(result.status, 'PASS'); assert.ok(Number.isSafeInteger(JSON.parse(result.stdout).pid));
  const failed = await runCommand(root, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000 }, null, {
    onStart: () => { throw new Error('Cannot persist child identity'); }
  });
  assert.equal(failed.status, 'FAIL'); assert.equal(failed.error, 'Cannot persist child identity');
});
test('SIGKILL leaves a tracked live executor that blocks retry until the child exits', async t => {
  const { root, config } = await fixture(t);
  config.adapters.codex.command.argv = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await scanSource(root, config);
  const moduleUrl = new URL('../src/runner.js', import.meta.url).href;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import { runOnce } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    await runOnce(root, JSON.parse(await fs.readFile(root + '/protoflow.config.json', 'utf8')));
  `, root], { stdio: 'ignore' });
  let executorPid;
  t.after(() => {
    worker.kill('SIGKILL');
    if (executorPid) { try { process.kill(-executorPid, 'SIGKILL'); } catch {} }
  });
  const deadline = Date.now() + 5000;
  while (!executorPid) {
    executorPid = (await sourceStatus(root)).entries[0].attempts[0]?.pid;
    if (Date.now() > deadline) throw new Error('Runner did not persist executor PID');
    if (!executorPid) await delay(10);
  }
  const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
  process.kill(executorPid, 0);
  await assert.rejects(retryRunner(root), /still active/);
  let state = await sourceStatus(root);
  assert.equal(state.entries[0].status, 'RUNNING'); assert.equal(state.entries[1].status, 'PENDING');
  assert.equal(state.entries[0].attempts[0].pid, executorPid); assert.equal(state.entries[0].attempts[0].completedAt, undefined);
  process.kill(-executorPid, 'SIGKILL');
  const exitDeadline = Date.now() + 5000;
  while (true) {
    try { process.kill(executorPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    if (Date.now() > exitDeadline) throw new Error('Executor did not exit');
    await delay(10);
  }
  assert.equal((await retryRunner(root)).status, 'PASS');
  state = await sourceStatus(root); assert.equal(state.entries[0].status, 'PENDING');
  assert.equal(state.entries[0].attempts[0].status, 'STOPPED'); assert.ok(state.entries[0].attempts[0].completedAt);
  // Completed evidence must not be blocked by a subsequently reused live PID.
  state.entries[0].status = 'BLOCKED';
  state.entries[0].attempts[0] = { ...state.entries[0].attempts[0], pid: process.pid, completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
  assert.equal((await retryRunner(root)).status, 'PASS');
});

test('stop aborts setup and records its child and completion before initialization recovery', async t => {
  const { root, config } = await fixture(t);
  config.runner = { setup: { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 10000 } };
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await scanSource(root, config);
  const controller = new AbortController();
  const operation = runOnce(root, config, { signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!(await runnerStatus(root)).runner?.setupPid) {
    if (Date.now() > deadline) throw new Error('Setup did not persist PID');
    await delay(10);
  }
  controller.abort();
  assert.equal((await operation).status, 'STOPPED');
  const { runner, source } = await runnerStatus(root);
  assert.equal(runner.status, 'SETUP_FAILED'); assert.equal(runner.setup.aborted, true);
  assert.ok(Number.isSafeInteger(runner.setupPid)); assert.ok(runner.setupCompletedAt);
  assert.equal(source.entries[0].status, 'PENDING'); assert.equal(source.entries[0].attempts.length, 0);
});
test('initialization recovery blocks a live unfinished setup child and accepts a dead PID', async t => {
  const { root, config } = await fixture(t);
  await scanSource(root, config);
  const file = path.join(root, '.protoflow/runner/state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const status of ['INITIALIZING', 'SETUP_FAILED']) {
    await fs.writeFile(file, JSON.stringify({ status, setupPid: process.pid }));
    await assert.rejects(runOnce(root, config), /setup process .*still active/);
  }
  await fs.writeFile(file, JSON.stringify({ status: 'INITIALIZING', setupPid: 2147483647 }));
  assert.equal((await runOnce(root, config)).status, 'BLOCKED');
  assert.equal((await sourceStatus(root)).entries[0].attempts.length, 1);
});
test('a stop received during scanning returns before runner initialization or execution', async t => {
  const { root, config } = await fixture(t);
  const controller = new AbortController();
  const result = await startRunner(root, config, { once: true, signal: controller.signal, onEvent: event => {
    if (event.event === 'scanned') controller.abort();
  } });
  assert.equal(result.status, 'STOPPED');
  assert.equal((await runOnce(root, config, { signal: controller.signal })).status, 'STOPPED');
  assert.equal((await runnerStatus(root)).runner, null);
  assert.ok((await sourceStatus(root)).entries.every(entry => entry.status === 'PENDING' && entry.attempts.length === 0));
});

for (const phase of ['build', 'functional']) {
  test(`SIGKILL during ${phase} persists its live verifier and blocks retry until it exits`, async t => {
    const { root, config } = await fixture(t);
    const idle = { argv: [process.execPath, '-e', 'if(!require("node:fs").existsSync(".protoflow/resume-verification"))setInterval(()=>{},1000)'] };
    const pass = { argv: [process.execPath, '-e', 'process.exit(0)'] };
    config.adapters.codex.command = pass;
    config.verification = { build: phase === 'build' ? idle : pass, functional: idle };
    await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
    await scanSource(root, config);
    const moduleUrl = new URL('../src/runner.js', import.meta.url).href;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import { runOnce } from ${JSON.stringify(moduleUrl)};
      const root = process.argv[1];
      await runOnce(root, JSON.parse(await fs.readFile(root + '/protoflow.config.json', 'utf8')));
    `, root], { stdio: 'ignore' });
    let verifierPid;
    t.after(() => {
      worker.kill('SIGKILL');
      if (verifierPid) { try { process.kill(-verifierPid, 'SIGKILL'); } catch {} }
    });
    const deadline = Date.now() + 5000;
    while (!verifierPid) {
      verifierPid = (await sourceStatus(root)).entries[0].attempts[0]?.processes?.find(child => child.phase === phase)?.pid;
      if (Date.now() > deadline) throw new Error('Runner did not persist verifier PID');
      if (!verifierPid) await delay(10);
    }
    const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
    process.kill(verifierPid, 0);
    await assert.rejects(retryRunner(root), new RegExp(`Runner ${phase} process .*still active`));
    let state = await sourceStatus(root), attempt = state.entries[0].attempts[0];
    const executor = attempt.processes.find(child => child.phase === 'execute');
    assert.ok(executor.completedAt); assert.equal(executor.status, 'PASS'); assert.equal(attempt.pid, executor.pid);
    assert.ok(attempt.processes.find(child => child.phase === phase).startedAt);
    assert.equal(attempt.processes.find(child => child.phase === phase).completedAt, undefined);
    if (phase === 'functional') assert.ok(attempt.processes.find(child => child.phase === 'build').completedAt);
    assert.equal(state.entries[0].status, 'RUNNING'); assert.equal(state.entries[1].status, 'PENDING');
    process.kill(-verifierPid, 'SIGKILL');
    const exitDeadline = Date.now() + 5000;
    while (true) {
      try { process.kill(verifierPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() > exitDeadline) throw new Error('Verifier did not exit');
      await delay(10);
    }
    assert.equal((await retryRunner(root)).status, 'PASS');
    state = await sourceStatus(root); attempt = state.entries[0].attempts[0];
    assert.equal(state.entries[0].status, 'PENDING'); assert.equal(attempt.status, 'STOPPED');
    assert.ok(attempt.processes.find(child => child.phase === phase).completedAt);
    assert.equal(attempt.processes.find(child => child.phase === phase).status, 'STOPPED');
    // A dead verifier recovered after SIGKILL can execute again from this version.
    const { runner } = await runnerStatus(root);
    await fs.writeFile(path.join(runner.worktree, '.protoflow/resume-verification'), 'resume with the same commands');
    const resumed = await runOnce(root, config);
    assert.equal(resumed.status, 'BLOCKED'); assert.match(resumed.reason, /Verification NOT_RUN/);
    state = await sourceStatus(root); assert.equal(state.entries[0].attempts.length, 2);
    const checks = state.entries[0].attempts[1].processes.filter(child => child.phase !== 'execute');
    assert.deepEqual(checks.map(child => child.phase), ['build', 'functional']);
    assert.ok(checks.every(child => child.completedAt && child.status === 'PASS'));
  });
}
test('inline module imports and import maps fail closed while vendored external modules remain frozen', async t => {
  const { source, config } = await fixture(t);
  await fs.writeFile(path.join(source, 'prototype/local.js'), 'export const label = "Frozen";');
  const snippets = [
    `<script type="module">import 'https://example.test/mutable.js';</script>`,
    `<script type=module>import /* comment */ 'https://example.test/mutable.js';</script>`,
    `<script type="mo&#100;ule">import('https://example.test/mutable.js');</script>`,
    `<script type="importmap">{"imports":{"ui":"https://example.test/mutable.js"}}</script>`,
    `<script type="importmap">{"scopes":{"./":{"ui":"https://example.test/mutable.js"}}}</script>`,
    `<iframe srcdoc="&lt;script type='module'&gt;import 'https://example.test/mutable.js';&lt;/script&gt;"></iframe>`
  ];
  for (const html of snippets) {
    await fs.writeFile(path.join(source, 'prototype/index.html'), html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Inline resource']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /inline modules and import maps are not auditable/);
  }
  await fs.writeFile(path.join(source, 'prototype/index.html'), '<script type="module" src="./local.js"></script>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Vendored module']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});
test('synthetic PASS crash recovery saves runner IDLE and permits configuration recovery', async t => {
  const { root, config } = await fixture(t);
  await scanSource(root, config); await runOnce(root, config); await retryRunner(root);
  let { source: state, runner } = await runnerStatus(root);
  const entry = state.entries[0];
  const manifest = JSON.parse(await fs.readFile(path.join(runner.worktree, '.protoflow/manifests', `${entry.manifestId}.json`), 'utf8'));
  const report = { id: 'VER-crash-recovery', createdAt: new Date().toISOString(), manifestId: manifest.id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash,
    project: await fingerprint(runner.worktree, { exclude: [config.prototypeDir] }), artifactHashes: {}, status: 'PASS' };
  await fs.mkdir(path.join(runner.worktree, '.protoflow/verifications'), { recursive: true });
  await fs.writeFile(path.join(runner.worktree, '.protoflow/verifications', `${report.id}.json`), JSON.stringify(report));
  runner.status = 'RUNNING'; runner.current = entry.manifestId;
  await fs.writeFile(path.join(root, '.protoflow/runner/state.json'), JSON.stringify(runner));
  const recovered = await runOnce(root, config);
  assert.equal(recovered.status, 'PASS'); assert.equal(recovered.recovered, true);
  ({ source: state, runner } = await runnerStatus(root));
  assert.equal(state.entries[0].status, 'PASS'); assert.ok(state.entries[0].completedAt);
  assert.equal(state.completedSha, entry.sha); assert.equal(runner.status, 'IDLE'); assert.equal(runner.current, null);
  assert.equal((await configureRunner(root, config)).status, 'PASS');
});
test('all source entries PASS repair a stale runner RUNNING state before returning IDLE', async t => {
  const { root, config, shas } = await fixture(t);
  await scanSource(root, config); await runOnce(root, config);
  let { source: state, runner } = await runnerStatus(root);
  for (const entry of state.entries) entry.status = 'PASS';
  state.completedSha = shas.at(-1); runner.status = 'RUNNING'; runner.current = state.entries[0].manifestId;
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(root, '.protoflow/runner/state.json'), JSON.stringify(runner));
  assert.equal((await runOnce(root, config)).status, 'IDLE');
  ({ runner } = await runnerStatus(root));
  assert.equal(runner.status, 'IDLE'); assert.equal(runner.current, null);
  assert.equal((await configureRunner(root, config)).status, 'PASS');
});

test('verification onStart persistence failure stops its child and yields FAIL evidence', async t => {
  const { root, config } = await fixture(t);
  const scan = await scanSource(root, config);
  config.verification = { build: { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000 }, functional: { argv: [process.execPath, '-e', 'process.exit(0)'] } };
  let buildPid;
  const report = await verify(root, config, scan.added[0], { onStart: (phase, pid) => {
    if (phase === 'build') { buildPid = pid; throw new Error('Cannot persist build identity'); }
  } });
  assert.equal(report.status, 'FAIL'); assert.equal(report.build.status, 'FAIL');
  assert.equal(report.build.error, 'Cannot persist build identity');
  assert.throws(() => process.kill(buildPid, 0), error => error.code === 'ESRCH');
});
test('verification onFinish persistence failure rejects before launching the next phase', async t => {
  const { root, config } = await fixture(t);
  const scan = await scanSource(root, config);
  config.verification = { build: { argv: [process.execPath, '-e', 'process.exit(0)'] }, functional: { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(".protoflow/functional-started", "unexpected")'] } };
  let buildPid;
  await assert.rejects(verify(root, config, scan.added[0], {
    onStart: (phase, pid) => { if (phase === 'build') buildPid = pid; },
    onFinish: phase => { if (phase === 'build') throw new Error('Cannot persist build completion'); }
  }), /Cannot persist build completion/);
  assert.throws(() => process.kill(buildPid, 0), error => error.code === 'ESRCH');
  await assert.rejects(fs.access(path.join(root, '.protoflow/functional-started')), error => error.code === 'ENOENT');
});

async function waitForGroupExit(pid) {
  const deadline = Date.now() + 5000;
  while (processGroupAlive(pid)) {
    if (Date.now() > deadline) throw new Error('Process group did not exit');
    await delay(10);
  }
}
async function orphanedGroup(t, root) {
  const childFile = path.join(root, 'group-child.pid'), release = path.join(root, 'release-leader');
  const leaderScript = `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)', process.argv[1]], { stdio: 'ignore' });
    child.unref();
    setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 10);
  `;
  const leader = spawn(process.execPath, ['-e', leaderScript, childFile, release], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} });
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.access(childFile); break; } catch {}
    if (Date.now() > deadline) throw new Error('Group child did not start');
    await delay(10);
  }
  const childPid = Number(await fs.readFile(childFile, 'utf8'));
  const exited = once(leader, 'exit'); await fs.writeFile(release, 'exit'); await exited;
  assert.throws(() => process.kill(leader.pid, 0), error => error.code === 'ESRCH');
  process.kill(childPid, 0); assert.equal(processGroupAlive(leader.pid), true);
  return { pid: leader.pid, childPid };
}
test('a normally exited leader cannot PASS while its subprocess group survives', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-group-close-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const childFile = path.join(root, 'child.pid');
  const script = `
    const fs=require('node:fs'), {spawn}=require('node:child_process');
    const child=spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)', process.argv[1]], {stdio:'ignore'});
    child.unref(); setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},10);
  `;
  let leaderPid;
  t.after(() => { if (leaderPid) { try { process.kill(-leaderPid, 'SIGKILL'); } catch {} } });
  const result = await runCommand(root, { argv: [process.execPath, '-e', script, childFile], timeoutMs: 5000 }, null, { onStart: pid => { leaderPid = pid; } });
  assert.equal(result.exitCode, 0); assert.equal(result.status, 'FAIL'); assert.equal(result.spawned, true);
  assert.match(result.error, /surviving subprocess group/); assert.equal(result.processGroupActive, false);
  assert.equal(processGroupAlive(leaderPid), false);
  const childPid = Number(await fs.readFile(childFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
});
test('retry detects a live process group after its recorded leader has exited', async t => {
  const { root, config } = await fixture(t);
  const scan = await scanSource(root, config), group = await orphanedGroup(t, root);
  const state = scan.state, entry = state.entries[0];
  entry.status = 'RUNNING'; entry.attempts = [{ status: 'RUNNING', pid: group.pid, processes: [{ phase: 'execute', pid: group.pid, pgid: group.pid, status: 'RUNNING', startedAt: new Date().toISOString() }] }];
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
  await assert.rejects(retryRunner(root), /process group .*still active/);
  assert.equal((await sourceStatus(root)).entries[0].status, 'RUNNING');
  process.kill(-group.pid, 'SIGKILL'); await waitForGroupExit(group.pid);
  assert.equal((await retryRunner(root)).status, 'PASS');
});
test('setup recovery detects a live process group after the setup leader has exited', async t => {
  const { root, config } = await fixture(t);
  await scanSource(root, config); const group = await orphanedGroup(t, root);
  const file = path.join(root, '.protoflow/runner/state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ status: 'INITIALIZING', setupPid: group.pid, setupPgid: group.pid, setupStartedAt: new Date().toISOString() }));
  await assert.rejects(runOnce(root, config), /setup process group .*still active/);
  process.kill(-group.pid, 'SIGKILL'); await waitForGroupExit(group.pid);
  const recovered = await runOnce(root, config);
  assert.equal(recovered.status, 'BLOCKED'); assert.match(recovered.reason, /Codex execution FAIL/);
});
test('onBeforeSpawn persists intent before any command runs and known pre-spawn failures report spawned:false', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-before-spawn-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'started'), intent = path.join(root, 'intent.json');
  const command = { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker] };
  const result = await runCommand(root, command, null, {
    onBeforeSpawn: async () => {
      await fs.writeFile(intent, JSON.stringify({ status: 'STARTING', pid: null })); await delay(30);
      await assert.rejects(fs.access(marker), error => error.code === 'ENOENT');
    },
    onStart: async pid => {
      assert.deepEqual(JSON.parse(await fs.readFile(intent, 'utf8')), { status: 'STARTING', pid: null });
      await fs.writeFile(intent, JSON.stringify({ status: 'RUNNING', pid }));
    }
  });
  assert.equal(result.status, 'PASS'); assert.equal(result.spawned, true);
  await fs.rm(marker);
  const controller = new AbortController();
  const stopped = await runCommand(root, command, null, { signal: controller.signal, onBeforeSpawn: () => controller.abort() });
  assert.equal(stopped.status, 'FAIL'); assert.equal(stopped.spawned, false);
  const failed = await runCommand(root, command, null, { onBeforeSpawn: () => { throw new Error('Intent persistence failed'); } });
  assert.equal(failed.status, 'FAIL'); assert.equal(failed.spawned, false); assert.equal(failed.error, 'Intent persistence failed');
  await assert.rejects(fs.access(marker), error => error.code === 'ENOENT');
});
for (const phase of ['setup', 'execute', 'build', 'functional']) {
  test(`SIGKILL after ${phase} intent but before spawn leaves unknown PID and blocks recovery`, async t => {
    const { root, config } = await fixture(t);
    const pass = { argv: [process.execPath, '-e', 'process.exit(0)'] };
    const marker = `.protoflow/started-${phase}`;
    const target = { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker] };
    config.adapters.codex.command = phase === 'execute' ? target : pass;
    config.verification = { build: phase === 'build' ? target : pass, functional: phase === 'functional' ? target : pass };
    if (phase === 'setup') config.runner = { setup: target };
    await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
    await scanSource(root, config);
    const moduleUrl = new URL('../src/runner.js', import.meta.url).href;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const root = await fs.realpath(process.argv[1]), phase = process.argv[2];
      const file = root + (phase === 'setup' ? '/.protoflow/runner/state.json' : '/.protoflow/source/state.json');
      const originalRename = fs.rename;
      fs.rename = async (from, to) => {
        await originalRename(from, to);
        if (to === file) {
          const state = JSON.parse(await fs.readFile(file, 'utf8'));
          const intent = phase === 'setup' ? state.setupStatus === 'STARTING' && state.setupPid === null : state.entries[0].attempts[0]?.processes?.some(child => child.phase === phase && child.status === 'STARTING' && child.pid === null);
          if (intent) { setInterval(()=>{},1000); await new Promise(()=>{}); }
        }
      };
      syncBuiltinESMExports();
      const {runOnce} = await import(${JSON.stringify(moduleUrl)});
      await runOnce(root, JSON.parse(await fs.readFile(root + '/protoflow.config.json', 'utf8')));
    `, root, phase], { stdio: 'ignore' });
    t.after(() => worker.kill('SIGKILL'));
    const deadline = Date.now() + 5000;
    let saved;
    while (true) {
      const status = await runnerStatus(root);
      saved = phase === 'setup' ? status.runner?.setupStatus === 'STARTING' && status.runner.setupPid === null : status.source.entries[0].attempts[0]?.processes?.some(child => child.phase === phase && child.status === 'STARTING' && child.pid === null);
      if (saved) break;
      if (Date.now() > deadline) throw new Error('Intent was not persisted');
      await delay(10);
    }
    const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
    const {runner} = await runnerStatus(root);
    await assert.rejects(fs.access(path.join(runner.worktree, marker)), error => error.code === 'ENOENT');
    if (phase === 'setup') await assert.rejects(runOnce(root, config), /setup launch has unknown PID/);
    else await assert.rejects(retryRunner(root), new RegExp(`Runner ${phase} launch has unknown PID`));
  });
  test(`known ${phase} ENOENT spawn failure completes intent and allows recovery`, async t => {
    const { root, config } = await fixture(t);
    const pass = { argv: [process.execPath, '-e', 'process.exit(0)'] }, missing = { argv: [path.join(root, 'missing-executable')] };
    config.adapters.codex.command = phase === 'execute' ? missing : pass;
    config.verification = { build: phase === 'build' ? missing : pass, functional: phase === 'functional' ? missing : pass };
    if (phase === 'setup') config.runner = { setup: missing };
    await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
    await scanSource(root, config);
    if (phase === 'setup') {
      await assert.rejects(runOnce(root, config), /Runner setup failed/);
      const {runner} = await runnerStatus(root);
      assert.equal(runner.setupSpawned, false); assert.equal(runner.setupPid, null); assert.ok(runner.setupCompletedAt);
      config.runner.setup = pass; await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
      assert.equal((await runOnce(root, config)).status, 'BLOCKED');
    } else {
      assert.equal((await runOnce(root, config)).status, 'BLOCKED');
      const child = (await sourceStatus(root)).entries[0].attempts[0].processes.find(item => item.phase === phase);
      assert.equal(child.spawned, false); assert.equal(child.pid, null); assert.ok(child.completedAt);
      assert.equal((await configureRunner(root, config)).status, 'PASS');
      assert.equal((await retryRunner(root)).status, 'PASS');
    }
  });
}
test('JS audit rejects comment-separated imports, classic inline imports, opaque data scripts and uninspectable script formats', async t => {
  const { source, config } = await fixture(t);
  const bundle = path.join(source, 'prototype/bundle.JS');
  const cases = [
    { js: `import /* comment */ 'https://example.test/mutable.js';` },
    { js: `import /* comment */ ('https://example.test/mutable.js');` },
    { js: `export * /* comment */ from 'https://example.test/mutable.js';` },
    { html: `<script>import /* comment */ ('https://example.test/mutable.js');</script>` },
    { html: `<script type="text/javascript1.3">import('https://example.test/mutable.js');</script>` },
    { html: `<script type="module" src="data:text/javascript,import%20'https://example.test/mutable.js'"></script>` },
    { html: `<script src="data:text/javascript,import('https://example.test/mutable.js')"></script>` },
    { html: `<iframe src="data:text/html,%3Cscript%3Eimport('https://example.test/mutable.js')%3C/script%3E"></iframe>` },
    { html: '<script src="bundle.TXT"></script>', textScript: true },
    { html: '<script src="bundle.TXT?as=module.js"></script>', textScript: true },
    { html: '<script src="bundle.TXT#module.js"></script>', textScript: true },
    { html: '<script src="bundle.JS"></script>', binary: true }
  ];
  for (const entry of cases) {
    await fs.writeFile(bundle, entry.binary ? Buffer.from([0xff, 0xfe]) : entry.js ?? 'const frozen = true;');
    if (entry.textScript) await fs.writeFile(path.join(source, 'prototype/bundle.TXT'), `import /* comment */ 'https://example.test/mutable.js';`);
    await fs.writeFile(path.join(source, 'prototype/index.html'), entry.html ?? '<script src="bundle.JS"></script>');
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported JS resource']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /resource is not frozen/);
  }
  await fs.writeFile(bundle, 'const frozen = true;');
  await fs.writeFile(path.join(source, 'prototype/index.html'), '<img src="data:image/png;base64,iVBORw0KGgo="><script src="bundle.JS"></script><script>console.log("Frozen");</script>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Bundled JS and image data']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('CSS audit captures quoted URLs with spaces in files, inline styles and SVG, and fails closed on unsupported syntax', async t => {
  const { source, config } = await fixture(t);
  const stylesheet = path.join(source, 'prototype/styles.css'), page = path.join(source, 'prototype/index.html');
  const cases = [
    { css: 'body{background:url("https://example.test/a b.png")}' },
    { css: "body{background:URL('https://example.test/a b.png')}" },
    { css: '@import "https://example.test/a b.css";' },
    { css: '@import url("https://example.test/a b.css");' },
    { html: '<style>body{background:url("https://example.test/a b.png")}</style>' },
    { html: '<div style="background:url(&quot;https://example.test/a b.png&quot;)"></div>' },
    { html: '<svg><path fill=\'url("https://example.test/a b.svg#mark")\'/></svg>' },
    { html: '<style>body{background:url("https://example.test/a b.png")}' },
    { css: 'body{background:url("https://example.test/missing.png)}' },
    { css: 'body{background:url("https://example.test/missing.png"}' },
    { css: 'body{background:url(https://example.test/a b.png)}' },
    { css: 'body{background:u\\72l("https://example.test/mutable.png")}' },
    { css: 'body{background:url("https\\3a//example.test/mutable.png")}' },
    { css: '@import "data:text/css,body%7Bbackground:url(https://example.test/mutable.png)%7D";' },
    { css: '@import url("data:text/css,body%7Bbackground:url(https://example.test/mutable.png)%7D");' },
    { css: 'body{background:image-set("https://example.test/mutable.png" 1x)}' },
    { css: 'body{background:-webkit-image-set("https://example.test/mutable.png" 1x)}' },
    { css: 'body{background:image("https://example.test/mutable.png")}' },
    { css: '@font-face{src:src("https://example.test/mutable.woff")}' }
  ];
  for (const entry of cases) {
    await fs.writeFile(stylesheet, entry.css ?? 'body{color:teal}');
    await fs.writeFile(page, entry.html ?? '<link rel="stylesheet" href="styles.css">');
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported CSS fixture']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /resource is not frozen/);
  }
  await fs.writeFile(path.join(source, 'prototype/a b.png'), Buffer.from([0xff, 0x00, 0xfe]));
  await fs.writeFile(path.join(source, 'prototype/a b.css'), 'body{color:teal}');
  await fs.writeFile(stylesheet, '@import "a b.css";/* url("https://example.test/comment.png") */body{background:url("a b.png");mask:url(data:image/png;base64,aA==);color:rgb(1,2,3);width:calc(100% - 1px)}');
  await fs.writeFile(page, '<link rel="stylesheet" href="styles.css"><style>body{background:url("a b.png")}</style><div style="background:url(&quot;a b.png&quot;)"></div>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Frozen quoted CSS fixture']);
  const snapshot = await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
  assert.equal(snapshot.files['prototype/a b.png'].binary, true);
});

test('auditable HTML, CSS and SVG reject non-UTF8 text while binary images remain frozen', async t => {
  const { source, config } = await fixture(t);
  const formats = [
    ['index.html', '<img src="https://example.test/mutable.png">'],
    ['styles.css', 'body{background:url("https://example.test/mutable.png")}'],
    ['icon.svg', '<svg><image href="https://example.test/mutable.png"/></svg>']
  ];
  for (const [name, text] of formats) {
    await fs.writeFile(path.join(source, 'prototype', name), Buffer.concat([Buffer.from(text), Buffer.from([0xe9])]));
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', `Non-UTF8 ${name}`]);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /auditable text file must be UTF-8/);
    await fs.writeFile(path.join(source, 'prototype', name), name.endsWith('.svg') ? '<svg></svg>' : name.endsWith('.css') ? 'body{color:teal}' : '<button id="button">Save</button>');
  }
  await fs.writeFile(path.join(source, 'prototype/frozen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
  await fs.writeFile(path.join(source, 'prototype/index.html'), '<img src="frozen.png">');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Frozen binary image']);
  const snapshot = await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
  assert.equal(snapshot.files['prototype/frozen.png'].binary, true);
});

// A controlled result-field fixture exercises the remaining-group guard without
// pretending to run a Codex provider or to leave an unkillable OS subprocess.
async function activeGroupResultFixture(root) {
  const moduleUrl = new URL('../src/runner.js', import.meta.url).href;
  const utilUrl = new URL('../src/util.js', import.meta.url).href;
  const visualUrl = new URL('../src/visual.js', import.meta.url).href;
  const worker = `
    import fs from 'node:fs/promises';
    import {registerHooks} from 'node:module';
    registerHooks({load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url === ${JSON.stringify(utilUrl)}) {
        const source = String(loaded.source);
        const needle = 'spawned: Number.isSafeInteger(child.pid), processGroupActive });';
        if (!source.includes(needle)) throw new Error('Controlled active-group fixture injection point missing');
        return {...loaded, source: source.replace(needle, 'spawned: Number.isSafeInteger(child.pid), processGroupActive: command.argv.includes("__fixture_active_group__") ? true : processGroupActive });')};
      }
      if (url === ${JSON.stringify(visualUrl)}) return {...loaded, source: 'import fs from "node:fs/promises"; export async function verifyVisual(root) {await fs.writeFile(root + "/.protoflow/visual-started", "fixture");return {status:"NOT_RUN",scenes:[],artifacts:[]};}'};
      return loaded;
    }});
    const root = process.argv[1], config = JSON.parse(await fs.readFile(root + '/protoflow.config.json', 'utf8'));
    const {runOnce} = await import(${JSON.stringify(moduleUrl)});
    try {console.log(JSON.stringify(await runOnce(root, config)));}
    catch(error) {console.log(JSON.stringify({status:'BLOCKED', reason:error.message}));}
  `;
  const result = await runCommand(root, { argv: [process.execPath, '--input-type=module', '-e', worker, root], timeoutMs: 10000 });
  assert.equal(result.status, 'PASS', result.stderr || result.error);
  return JSON.parse(result.stdout.trim());
}
for (const phase of ['setup', 'execute', 'build', 'functional']) {
  test(`controlled active ${phase} group blocks subsequent phases and repair, retaining unfinished identity`, async t => {
    const { root, config } = await fixture(t);
    const markerCommand = name => ({ argv: [process.execPath, '-e', 'require("node:fs").mkdirSync(".protoflow", {recursive:true});require("node:fs").appendFileSync(process.argv[1], "started\\n")', `.protoflow/${name}-started`] });
    const execution = markerCommand('execute'), build = markerCommand('build'), functional = markerCommand('functional');
    config.adapters.codex.command = execution;
    config.verification = { build, functional };
    config.policy.maxRepairAttempts = 2;
    if (phase === 'setup') config.runner = { setup: markerCommand('setup') };
    const command = phase === 'setup' ? config.runner.setup : phase === 'execute' ? execution : phase === 'build' ? build : functional;
    command.argv.push('__fixture_active_group__');
    await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config)); await scanSource(root, config);
    const result = await activeGroupResultFixture(root);
    assert.equal(result.status, 'BLOCKED');
    const { source, runner } = await runnerStatus(root), entry = source.entries[0];
    assert.equal(source.entries[1].status, 'PENDING');
    await assert.rejects(fs.access(path.join(runner.worktree, '.protoflow/visual-started')), error => error.code === 'ENOENT');
    if (phase !== 'functional') await assert.rejects(fs.access(path.join(runner.worktree, '.protoflow/functional-started')), error => error.code === 'ENOENT');
    if (['setup', 'execute'].includes(phase)) await assert.rejects(fs.access(path.join(runner.worktree, '.protoflow/build-started')), error => error.code === 'ENOENT');
    if (phase === 'setup') {
      assert.equal(entry.attempts.length, 0); assert.equal(runner.status, 'SETUP_FAILED');
      assert.equal(runner.setup.processGroupActive, true); assert.equal(runner.setup.status, 'PASS');
      assert.equal(runner.setupCompletedAt, null);
      await assert.rejects(fs.access(path.join(runner.worktree, '.protoflow/execute-started')), error => error.code === 'ENOENT');
    } else {
      assert.equal(entry.status, 'BLOCKED'); assert.equal(runner.status, 'BLOCKED'); assert.equal(entry.attempts.length, 1);
      assert.equal(await fs.readFile(path.join(runner.worktree, '.protoflow/execute-started'), 'utf8'), 'started\n');
      const attempt = entry.attempts[0], child = attempt.processes.find(item => item.phase === phase);
      assert.equal(child.processGroupActive, true); assert.equal(child.status, 'PASS'); assert.equal(child.completedAt, undefined);
      assert.ok(Number.isSafeInteger(child.pid)); assert.equal(attempt.processFailure.phase, phase);
      assert.equal(attempt.processFailure.result.processGroupActive, true); assert.match(result.reason, /subprocess group remains active/);
    }
  });
}

test('new attempts refuse an older unfinished group even when its attempt already has completedAt', async t => {
  const { root, config } = await fixture(t);
  config.adapters.codex.command.argv = [process.execPath, '-e', 'require("node:fs").writeFileSync(".protoflow/execute-started", "unexpected")'];
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  const { state } = await scanSource(root, config);
  state.entries[0].attempts = [{ status: 'FAIL', completedAt: new Date().toISOString(), processes: [{ phase: 'build', status: 'FAIL', pid: process.pid, pgid: process.pid, processGroupActive: true }] }];
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
  const result = await runOnce(root, config);
  assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /build process group .*still active/);
  const status = await runnerStatus(root);
  assert.equal(status.source.entries[0].attempts.length, 1); assert.equal(status.source.entries[1].status, 'PENDING');
  assert.equal(status.runner, null); // Existing unfinished groups block even initialization.
});

test('verification stop after build prevents functional and visual phases', async t => {
  const { root, config } = await fixture(t);
  const { added } = await scanSource(root, config);
  const marker = path.join(root, '.protoflow/functional-started');
  config.verification = {
    build: { argv: [process.execPath, '-e', 'process.exit(0)'] },
    functional: { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "unexpected")', marker] }
  };
  const controller = new AbortController(), phases = [];
  await assert.rejects(verify(root, config, added[0], {
    signal: controller.signal,
    onFinish: phase => { phases.push(phase); if (phase === 'build') controller.abort(); }
  }), /STOPPED: verification build was interrupted/);
  assert.deepEqual(phases, ['build']);
  await assert.rejects(fs.access(marker), error => error.code === 'ENOENT');
});

test('event handlers and executable JavaScript URLs apply the same conservative module audit', async t => {
  const { source, config } = await fixture(t);
  const page = path.join(source, 'prototype/index.html');
  const cases = [
    `<button onclick="import('https://example.test/mutable.js')">Load</button>`,
    `<img src="data:image/png;base64,aA==" ONERROR="import /* comment */ ('https://example.test/mutable.js')">`,
    `<svg onload="&#105;mport('https://example.test/mutable.js')"></svg>`,
    `<iframe srcdoc="&lt;button onclick=&quot;import('https://example.test/mutable.js')&quot;&gt;Load&lt;/button&gt;"></iframe>`,
    `<a href="javascript:import('https://example.test/mutable.js')">Load</a>`,
    `<a href="java&#x09;script:&#105;mport('https://example.test/mutable.js')">Load</a>`,
    `<a href="javascript:%69mport('https://example.test/mutable.js')">Load</a>`,
    `<a href="javascript:%zz">Unsupported encoding</a>`,
    `<form action="javascript:import('https://example.test/mutable.js')"></form>`,
    `<button formaction="javascript:import('https://example.test/mutable.js')">Load</button>`,
    `<svg><a xlink:href="javascript:import('https://example.test/mutable.js')">Load</a></svg>`
  ];
  for (const html of cases) {
    await fs.writeFile(page, html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported executable attribute']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /resource is not frozen: JavaScript/);
  }
  await fs.writeFile(page, '<button onclick="this.textContent = &quot;Saved&quot;">Save</button><a href="javascript:void(0)">Frozen action</a><a href="https://example.test/navigation">Navigation</a>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Self-contained executable attribute']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('SVG XML stylesheet processing instructions fail closed for both remote and local targets', async t => {
  const { source, config } = await fixture(t);
  for (const target of ['https://example.test/mutable.css', 'styles.css']) {
    await fs.writeFile(path.join(source, 'prototype/icon.svg'), `<?xml version="1.0"?><?xml-stylesheet type="text/css" href="${target}"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported XML stylesheet']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /XML stylesheet processing instructions are not auditable/);
  }
});
for (const identity of [process.pid, null]) {
  test(`unfinished visual identity ${identity === null ? 'unknown' : 'live'} blocks setup and stale PASS recovery`, async t => {
    const { root, config } = await fixture(t), { state } = await scanSource(root, config);
    config.runner = { setup: { argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("unexpected-setup", "started")'] } };
    state.entries[0].status = 'PASS';
    state.entries[0].attempts = [{ status: 'PASS', completedAt: new Date().toISOString(), processes: [{ phase: 'visual', pid: identity, pgid: identity, status: identity === null ? 'STARTING' : 'RUNNING' }] }];
    await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
    let result = await runOnce(root, config);
    assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, identity === null ? /visual launch has unknown PID/ : /visual process group .*still active/);
    assert.equal((await runnerStatus(root)).runner, null);
    await assert.rejects(retryRunner(root), identity === null ? /visual launch has unknown PID/ : /visual process group .*still active/);
    state.entries[1].status = 'PASS'; await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify(state));
    result = await runOnce(root, config);
    assert.equal(result.status, 'BLOCKED'); assert.equal((await runnerStatus(root)).runner, null);
  });
}

test('XML/XHTML and opaque embedded document formats fail closed while audited HTML/SVG remain supported', async t => {
  const { source, config } = await fixture(t);
  const page = path.join(source, 'prototype/index.html');
  const xml = '<?xml-stylesheet type="text/css" href="https://example.test/mutable.css"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const cases = [
    ...['xml', 'xhtml', 'xht', 'XML', 'XHTML'].map(extension => ({ name: `scene.${extension}`, content: '<html><body>Unsupported direct scene</body></html>', direct: true })),
    { name: 'scene.xml', content: xml, html: '<iframe src="scene.xml"></iframe>' },
    { name: 'scene.xhtml', content: xml, html: '<embed src="scene.xhtml" type="application/xhtml+xml">' },
    { name: 'scene.xht', content: xml, html: '<object data="scene.xht" type="text/html"></object>' },
    { name: 'scene.txt', content: '<img src="https://example.test/mutable.png">', html: '<iframe src="scene.txt"></iframe>' },
    { name: 'scene.txt', content: '<img src="https://example.test/mutable.png">', html: '<iframe src="scene.txt?as=scene.html"></iframe>' },
    { name: 'scene.bin', content: '<svg><image href="https://example.test/mutable.png"/></svg>', html: '<object data="scene.bin#scene.svg" type="image/svg+xml"></object>' },
    { name: 'scene.png', content: Buffer.from([0xff, 0x00]), html: '<embed src="scene.png" type="image/svg+xml">' },
    { name: 'scene.bin', content: Buffer.from([0xff, 0x00]), html: '<object data="scene.bin" type="text/html"></object>' },
    { name: 'unreferenced.txt', content: xml },
    { name: 'unreferenced', content: xml }
  ];
  for (const entry of cases) {
    const resource = path.join(source, 'prototype', entry.name);
    await fs.writeFile(resource, entry.content); await fs.writeFile(page, entry.html ?? '<button id="button">Save</button>');
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported document format']);
    const candidate = entry.direct ? { ...config, visual: { scenes: [{ prototypeUrl: `prototype/${entry.name}` }] } } : config;
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), candidate), /resource is not frozen: (?:XML|embedded documents)/);
    await fs.rm(resource);
  }
  await fs.writeFile(path.join(source, 'prototype/scene.html'), '<img src="frozen.png"><button onclick="this.textContent=\'Saved\'">Save</button>');
  await fs.writeFile(path.join(source, 'prototype/scene.htm'), '<p>Frozen HTML</p>');
  await fs.writeFile(path.join(source, 'prototype/scene.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="frozen.png"/></svg>');
  await fs.writeFile(path.join(source, 'prototype/frozen.png'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(page, '<iframe src="scene.html"></iframe><embed src="scene.htm" type="text/html"><object data="scene.svg" type="image/svg+xml"></object>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Audited embedded documents']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('namespace-prefixed SVG elements fail closed, preserving ordinary SVG and xlink attributes', async t => {
  const { source, config } = await fixture(t), page = path.join(source, 'prototype/index.html');
  for (const content of [
    '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:image href="https://example.test/mutable.png"/></s:svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:image href="https://example.test/mutable.png"/></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>import("https://example.test/mutable.js")</s:script></svg>'
  ]) {
    await fs.writeFile(page, content); await fs.writeFile(path.join(source, 'prototype/scene.svg'), content);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported SVG prefix']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /namespace-prefixed document elements are not auditable/);
  }
  await fs.writeFile(page, '<svg><use xlink:href="scene.svg#mark"/></svg>');
  await fs.writeFile(path.join(source, 'prototype/scene.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path id="mark" d="M0 0L1 1"/></svg>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unprefixed frozen SVG']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('ordinary inline scripts require a closing tag before their body can be audited', async t => {
  const { source, config } = await fixture(t), page = path.join(source, 'prototype/index.html');
  for (const html of [
    '<script>import("https://example.test/mutable.js")',
    '<script type="text/javascript">import /* comment */ ("https://example.test/mutable.js")',
    '<script>console.log("Frozen but unauditable closing boundary")',
    '<script/>import("https://example.test/mutable.js")'
  ]) {
    await fs.writeFile(page, html); await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unclosed script']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /inline script text is not auditable without a closing tag/);
  }
  await fs.writeFile(page, '<script>console.log("Frozen");</script>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Closed bundled script']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('stylesheet links and CSS imports require audited CSS formats regardless of attribute order', async t => {
  const { source, config } = await fixture(t);
  const page = path.join(source, 'prototype/index.html'), css = path.join(source, 'prototype/styles.css');
  await fs.writeFile(path.join(source, 'prototype/skin.txt'), 'body{background:url("https://example.test/mutable.png")}');
  for (const entry of [
    { html: '<link rel="stylesheet" href="skin.txt">' },
    { html: '<link href="skin.txt" type="text/css" rel="stylesheet">' },
    { html: '<link href="skin.txt" REL="alternate STYLESHEET">' },
    { html: '<link rel="stylesheet" href="skin.txt?as=skin.css">' },
    { html: '<link rel="stylesheet" href="data:text/css,body{background:url(https://example.test/mutable.png)}/*skin.css">' },
    { css: '@import "skin.txt";' },
    { css: '@import url("skin.txt");' },
    { css: '@import "skin.txt?as=skin.css";' },
    { css: '@import "skin.txt#skin.css";' }
  ]) {
    await fs.writeFile(page, entry.html ?? '<link href="styles.css" rel="stylesheet">');
    await fs.writeFile(css, entry.css ?? 'body{color:teal}');
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported stylesheet format']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /(?:stylesheets|CSS imports) require auditable local .css text files/);
  }
  await fs.writeFile(path.join(source, 'prototype/normal.CSS'), 'body{color:teal}');
  await fs.writeFile(page, '<link href="styles.css" REL="stylesheet"><link rel="alternate stylesheet" href="normal.CSS">');
  await fs.writeFile(css, '@import "normal.CSS";');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Audited stylesheet formats']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('automatic meta refresh fails closed regardless of attribute order, case or entity encoding', async t => {
  const { source, config } = await fixture(t), page = path.join(source, 'prototype/index.html');
  for (const html of [
    '<meta http-equiv="refresh" content="0;url=https://example.test/mutable.html">',
    '<meta content="0; URL=https://example.test/mutable.html" HTTP-EQUIV="REFRESH">',
    '<meta content="0;url=https://example.test/mutable.html" http-equiv=" Refr&#x65;sh ">',
    '<meta content="0;url=index.html" http-equiv=refresh>'
  ]) {
    await fs.writeFile(page, html); await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported automatic navigation']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /automatic meta refresh navigation is not auditable/);
  }
  await fs.writeFile(page, '<meta charset="utf-8"><meta http-equiv="content-type" content="text/html; charset=utf-8"><button id="button">Save</button>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Normal metadata']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('unsupported HTML resource entities cannot use colocated literal placeholder files to bypass browser URL semantics', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  const literal = '&sol;&sol;example.test/asset.png';
  await fs.mkdir(path.dirname(path.join(directory, literal)), { recursive: true });
  await fs.writeFile(path.join(directory, literal), Buffer.from([0xff, 0x00]));
  for (const html of [
    `<img src="${literal}">`,
    `<div style="background:url(&quot;${literal}&quot;)"></div>`,
    `<style>body{background:url("${literal}")}</style>`
  ]) {
    await fs.writeFile(path.join(directory, 'index.html'), html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Literal entity placeholder']);
    const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
    // The exact literal target exists in the commit; rejection must come from
    // the supported-entity gate, never from a missing-resource fallback.
    assert.ok((await git(source, ['ls-tree', '-r', '--name-only', sha])).includes(`prototype/${literal}`));
    await assert.rejects(gitSnapshot(source, sha, config), /unsupported HTML entity in a resource value/);
  }
  await fs.writeFile(path.join(directory, 'a&b.png'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, 'one.png'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, 'index.html'), '<img src="&amp;sol;&amp;sol;example.test/asset.png"><img src="a&amp;b.png"><img src="one&#x2e;png"><img src="one&#46;png"><img src="data:image/png;base64,aA=="><svg><use href="#mark"/></svg><button onclick="if (true && true) this.textContent=\'Saved\'">Save</button>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Single decoded supported entities']);
  const snapshot = await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
  assert.ok(snapshot.files[`prototype/${literal}`]);
});

test('backslash resource URLs reject even when the matching POSIX literal filename is frozen', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  const literal = String.raw`\\example.test/asset.png`;
  await fs.mkdir(path.dirname(path.join(directory, literal)), { recursive: true });
  await fs.writeFile(path.join(directory, literal), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, 'index.html'), `<img src="${literal}">`);
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Literal backslash placeholder']);
  const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
  assert.ok((await git(source, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').includes(`prototype/${literal}`));
  await assert.rejects(gitSnapshot(source, sha, config), /resource URLs cannot contain backslashes or control characters/);
});

test('leading C0 resource URLs reject even when a colocated literal protocol-shaped path exists', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  const literal = '\u0001https://example.test/asset.png';
  const relative = path.posix.normalize(literal);
  await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await fs.writeFile(path.join(directory, relative), Buffer.from([0xff, 0x00]));
  for (const html of [`<img src="${literal}">`, '<img src="&#1;https://example.test/asset.png">']) {
    await fs.writeFile(path.join(directory, 'index.html'), html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Literal control-character placeholder']);
    const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
    assert.ok((await git(source, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').includes(`prototype/${relative}`));
    await assert.rejects(gitSnapshot(source, sha, config), /resource URLs cannot contain backslashes or control characters/);
  }
});

test('malformed starting tags fail closed while quoted attributes and audited raw script/style text keep legal comparisons', async t => {
  const { source, config } = await fixture(t), page = path.join(source, 'prototype/index.html');
  for (const html of [
    '<img src=//example.test/mutable.png<q>',
    '<img src="frozen.png"<q>',
    '<img src="frozen.png"',
    '<div title="unterminated><img src=//example.test/mutable.png>'
  ]) {
    await fs.writeFile(page, html); await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Malformed tag boundary']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /malformed starting tag cannot be completely audited/);
  }
  await fs.writeFile(path.join(source, 'prototype/frozen.png'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(source, 'prototype/bundle.js'), 'const frozen = true;');
  await fs.writeFile(page, '<!-- normal inert comment --><img src="frozen.png" title="a<b and > c"><button onclick="const a=1,b=2;if(a<b && b>0)this.textContent=\'Saved\'">Save</button><script>const a=1,b=2;if(a<b){console.log("<img src=not-markup<q>");}</script><script src="bundle.js">ignored <img src=not-markup<q></script><script type="application/json">{"value":"<img src=not-markup<q>"}</script><style>body::before{content:"a<b <img src=not-markup<q>"}body{background:url("frozen.png")}</style>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Complete tag and raw text boundaries']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('resource existence uses own snapshot entries and preserves __proto__ files with prototypeDir dot', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  for (const entry of [
    { html: '<img src="../constructor">', css: 'body{color:teal}', name: 'constructor' },
    { html: '<button>Save</button>', css: 'body{background:url("../toString")}', name: 'toString' }
  ]) {
    await fs.writeFile(path.join(directory, 'index.html'), entry.html); await fs.writeFile(path.join(directory, 'styles.css'), entry.css);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Missing inherited-name resource']);
    const sha = (await git(source, ['rev-parse', 'HEAD'])).trim();
    assert.equal((await git(source, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').includes(entry.name), false);
    await assert.rejects(gitSnapshot(source, sha, config), new RegExp(`resource is not frozen: .* -> \\.\\./${entry.name};`));
  }
  await fs.writeFile(path.join(directory, 'constructor'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, '__proto__'), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, 'index.html'), '<img src="constructor"><img src="__proto__">');
  await fs.writeFile(path.join(directory, 'styles.css'), 'body{color:teal}');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Real own-property named files']);
  const snapshot = await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), { ...config, prototypeDir: '.' });
  assert.equal(Object.getPrototypeOf(snapshot.files), null);
  assert.equal(Object.hasOwn(snapshot.files, 'constructor'), true); assert.equal(Object.hasOwn(snapshot.files, '__proto__'), true);
  assert.equal(snapshot.files.__proto__.binary, true); assert.equal(snapshot.bytes.has('__proto__'), true);
});

test('raw script/style use the first browser closing prefix and reject unsupported closing or escaped states', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  await fs.writeFile(path.join(directory, 'bundle.js'), 'const frozen=true;');
  const mutable = '<img src="https://example.test/mutable.png">';
  const cases = [
    `<script>const a=1;</script x>${mutable}<script></script>`,
    `<style>body{color:teal}</style data-x>${mutable}<style></style>`,
    `<script>const a=1;</script/>${mutable}<script></script>`,
    `<style>body{color:teal}</style/>${mutable}<style></style>`,
    `<script type="application/json">{}</script x>${mutable}<script></script>`,
    `<script src="bundle.js"></script x>${mutable}<script></script>`,
    '<script><!--<script>const a=1;</script></script>',
    '<script type="application/json">{"value":"<!--"}</script>',
    '<script src="bundle.js"><!-- ignored script state </script>'
  ];
  for (const html of cases) {
    await fs.writeFile(path.join(directory, 'index.html'), html);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported rawtext boundary']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /(?:noncanonical raw script\/style closing tag|escaped HTML script state) is not auditable/);
  }
  await fs.writeFile(path.join(directory, 'index.html'), '<button onclick="const a=1,b=2;if(a<b)this.textContent=\'Saved\'">Save</button><script>const a=1,b=2;if(a<b)console.log("</script\u00a0><img src=not-markup<q>");</script \t><style>body::before{content:"</style\u00a0><img src=not-markup<q>"}</style \r\n><script type="application/json">{"value":"<img src=not-markup<q>"}</script><script src="bundle.js">ignored <img src=not-markup<q></script>');
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Canonical ASCII rawtext boundaries']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('SVG and HTML foreign SVG script/style cannot hide resource-bearing child markup in skipped raw bodies', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  const svg = body => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  await fs.writeFile(path.join(directory, 'bundle.js'), 'const frozen=true;');
  for (const entry of [
    { name: 'scene.svg', body: '<style><image href="https://example.test/mutable.png"/></style>' },
    { name: 'scene.svg', body: '<script><image href="https://example.test/mutable.png"/></script>' },
    { name: 'scene.svg', body: '<script src="bundle.js"><image href="https://example.test/mutable.png"/></script>' },
    { name: 'scene.svg', body: '<script type="application/json"><image href="https://example.test/mutable.png"/></script>' },
    { name: 'index.html', body: '<style><image href="https://example.test/mutable.png"/></style>' },
    { name: 'index.html', body: '<script><image href="https://example.test/mutable.png"/></script>' },
    { name: 'index.html', body: '<style><s:image href="https://example.test/mutable.png"/></style>' },
    { name: 'index.html', body: '<script><image href="https://example.test/mutable.png"</script>' }
  ]) {
    await fs.rm(path.join(directory, 'scene.svg'), { force: true });
    await fs.writeFile(path.join(directory, 'index.html'), '<button>Frozen</button>');
    await fs.writeFile(path.join(directory, entry.name), svg(entry.body));
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Unsupported SVG raw-body child']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), /resource-bearing child markup in SVG script\/style is not auditable/);
  }
  await fs.writeFile(path.join(directory, 'frozen.png'), Buffer.from([0xff, 0x00]));
  const normal = '<style>text{fill:url("frozen.png")}text::before{content:"<b>Frozen</b>"}</style><script>const a=1,b=2;if(a&lt;b &amp;&amp; b&gt;0)console.log("<b>Frozen</b>");</script>';
  await fs.writeFile(path.join(directory, 'scene.svg'), svg(normal));
  await fs.writeFile(path.join(directory, 'index.html'), `<button onclick="const a=1,b=2;if(a<b && b>0)this.textContent='Saved'">Save</button>${svg(normal)}`);
  await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Auditable SVG raw-body text']);
  await gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config);
});

test('SVG and foreign SVG raw bodies audit decoded script imports and reject unsupported CSS entities', async t => {
  const { source, config } = await fixture(t), directory = path.join(source, 'prototype');
  const literal = '&sol;&sol;example.test/asset.png';
  await fs.mkdir(path.dirname(path.join(directory, literal)), { recursive: true });
  await fs.writeFile(path.join(directory, literal), Buffer.from([0xff, 0x00]));
  await fs.writeFile(path.join(directory, 'bundle.js'), 'const frozen=true;');
  for (const entry of [
    { name: 'scene.svg', body: '<script>&#105;mport("https://example.test/mutable.js")</script>', error: /JavaScript import\/re-export syntax is not auditable/ },
    { name: 'index.html', body: '<script>&#x69;mport("https://example.test/mutable.js")</script>', error: /JavaScript import\/re-export syntax is not auditable/ },
    { name: 'scene.svg', body: '<script src="bundle.js">&#105;mport("https://example.test/mutable.js")</script>', error: /JavaScript import\/re-export syntax is not auditable/ },
    { name: 'scene.svg', body: `<style>image{fill:url("${literal}")}</style>`, error: /unsupported HTML entity in a resource value/ },
    { name: 'index.html', body: `<style>image{fill:url("${literal}")}</style>`, error: /unsupported HTML entity in a resource value/ }
  ]) {
    await fs.rm(path.join(directory, 'scene.svg'), { force: true });
    await fs.writeFile(path.join(directory, 'index.html'), '<button>Frozen</button>');
    await fs.writeFile(path.join(directory, entry.name), `<svg xmlns="http://www.w3.org/2000/svg">${entry.body}</svg>`);
    await git(source, ['add', 'prototype']); await git(source, ['commit', '-m', 'Decoded SVG raw-body resource']);
    await assert.rejects(gitSnapshot(source, (await git(source, ['rev-parse', 'HEAD'])).trim(), config), entry.error);
  }
});
