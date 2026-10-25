import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { traceActivity, roles, listProjects, addProject, removeProject, dashboardSnapshot, projectId } from '../src/dashboard-data.js';
import { createDashboardServer, overviewStream, serveDashboard, watchEngineVersion } from '../src/dashboard-server.js';
import { runAction } from '../src/dashboard-actions.js';
import { diagnose } from '../src/dashboard-diagnosis.js';
import { dashboardFixture, PNG } from './helpers/dashboard-fixture.js';

async function fixture(t, options) { const f = await dashboardFixture(options); t.after(f.cleanup); return f; }

test('executor traces become readable actions for Claude stream-json and Codex JSONL', () => {
  const claude = traceActivity([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the settings screen.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/w/app/a.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/app/a.js' } }, { type: 'tool_use', name: 'Write', input: { file_path: '/w/app/a.test.js' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }, { type: 'tool_use', name: 'Grep', input: { pattern: 'toggle' } }] } },
    { type: 'result', is_error: false }
  ], { root: '/w' });
  assert.deepEqual(claude.actions.map(action => [action.kind, action.text]), [['say', 'Looking at the settings screen.'], ['read', 'app/a.js'], ['edit', 'app/a.js'], ['write', 'app/a.test.js'], ['run', 'Run tests: npm test'], ['search', 'toggle'], ['done', 'finished']]);
  assert.deepEqual(claude.totals, { edits: 2, commands: 1, reads: 1, searches: 1 }); assert.deepEqual(claude.files, ['app/a.js', 'app/a.test.js']);
  const codex = traceActivity([
    { type: 'thread.started' }, { type: 'item.started', item: { type: 'command_execution', command: 'gradle test' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'gradle test', exit_code: 1 } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/src/Rule.kt', kind: 'add' }, { path: '/w/src/Screen.kt', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Extracted the rule.' } }, { type: 'turn.completed' }
  ], { root: '/w' });
  assert.deepEqual(codex.actions.map(action => [action.kind, action.text, action.ok]), [['run', 'gradle test', false], ['write', 'src/Rule.kt', undefined], ['edit', 'src/Screen.kt', undefined], ['say', 'Extracted the rule.', undefined], ['done', 'finished', true]]);
});

test('roles show the planner, the frontend and backend executors and the acceptor with their models', async t => {
  const { root } = await fixture(t);
  const config = JSON.parse(await fs.readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
  assert.deepEqual(roles(config), { planner: { provider: 'claude', model: 'claude-opus-5-5' }, executors: { frontend: { provider: 'claude', model: 'claude-sonnet-5-5' }, backend: { provider: 'codex', model: 'gpt-codex' }, fallback: 'codex' }, acceptor: { provider: 'claude', model: 'claude-opus-5-5' } });
});

test('projects register once by real path, with the configured name, and can be removed', async t => {
  const { root, home } = await fixture(t);
  const added = await addProject(root, { home });
  assert.equal(added.project.name, 'Fixture App'); assert.equal(added.project.id, await projectId(root));
  await addProject(path.join(root, '.'), { home });
  assert.equal((await listProjects({ home })).length, 1);
  assert.deepEqual(await removeProject(root, { home }), { status: 'PASS', removed: 1 });
  assert.deepEqual(await listProjects({ home }), []);
});

test('a snapshot shows the live executor, its stage, the latest verification and what needs a person', async t => {
  const { root, worktree, sha2 } = await fixture(t);
  const view = await dashboardSnapshot(root, { service: false });
  assert.equal(view.protocol, 'protoflow.dashboard/1'); assert.equal(view.project.name, 'Fixture App'); assert.equal(view.service.status, 'HEARTBEAT');
  const [stream] = view.streams;
  assert.equal(stream.stage, 'execute'); assert.equal(stream.phase, 'execute'); assert.equal(stream.current.manifestId, `git-${sha2}`); assert.equal(stream.current.summary, 'Settings toggle');
  assert.equal(stream.live.running, true); assert.equal(stream.live.model, 'claude-sonnet-5-5'); assert.equal(stream.runner.worktree, worktree);
  assert.deepEqual(stream.live.actions.map(action => action.kind), ['say', 'read', 'edit', 'run']); assert.deepEqual(stream.live.files, ['app/settings.js']);
  assert.equal(stream.verification.id, 'VER-fixture-1'); assert.deepEqual(stream.verification.scenes[0].tiers, { structure: 'PASS', tokens: 'FAIL', layout: 'PASS', visual: 'FAIL' });
  assert.equal(stream.verification.scenes[0].prototype, '.protoflow/artifacts/VER-fixture-1/web/settings.initial/prototype.png');
  assert.match(stream.verification.scenes[0].reasons[0], /^tokens: settings\.save: color/);
  assert.deepEqual(view.attention.map(item => item.kind), ['manual-merge', 'issue']);
  assert.deepEqual(view.attention[0].actions, ['merge']); assert.equal(view.attention[1].number, 5); assert.deepEqual(view.attention[1].questions, ['Should Saved hide on any change?']);
  assert.deepEqual(view.issues.map(issue => [issue.number, issue.status, issue.area]), [[6, 'in-progress', 'backend'], [5, 'needs-human', 'frontend']]);
  assert.deepEqual(view.events.map(event => event.event), ['execute', 'planned']);
  // Without a running executor process the stage follows the last event, and the trace is the previous run's.
  const idle = await dashboardFixture({ executing: false }); t.after(idle.cleanup);
  const after = (await dashboardSnapshot(idle.root, { service: false })).streams[0];
  assert.equal(after.phase, null); assert.equal(after.stage, 'execute');
});

test('versions waiting for a person appear when the project does not approve automatically', async t => {
  const { root } = await fixture(t, { autoApprove: false });
  const view = await dashboardSnapshot(root, { service: false });
  assert.deepEqual(view.attention.filter(item => item.kind === 'review').map(item => [item.verificationId, item.actions[0]]), [['VER-fixture-1', 'approve']]);
});

test('waivers: the snapshot shows waived tiers and requests, and only a listed person decides a waiver', async t => {
  const { root } = await fixture(t, { waivers: true });
  const view = await dashboardSnapshot(root, { service: false });
  assert.deepEqual([view.waivers.enabled, view.waivers.reviewers, view.waivers.waivers.map(item => [item.id, item.status])], [true, ['Fixture Person'], [['WVR-fixture-2', 'requested'], ['WVR-fixture-1', 'approved']]]);
  assert.deepEqual(view.waivers.waivers[0].prototype, '.protoflow/artifacts/WVR-fixture-2/prototype.png');
  const [stream] = view.streams;
  assert.deepEqual(stream.verification.scenes[0].waived, { tokens: 'WVR-fixture-1' });
  assert.deepEqual(stream.verification.waivers.map(item => [item.id, item.tier]), [['WVR-fixture-1', 'tokens']]);
  assert.equal(stream.versions.find(version => version.verificationId === 'VER-fixture-1').waivers, 1);
  // Under autoApprove the waived version still waits for a person (decision D), next to the waiver request.
  const waiting = view.attention.filter(item => ['review', 'waiver'].includes(item.kind));
  assert.deepEqual(waiting.map(item => [item.kind, item.waiverId ?? item.verificationId, item.actions]), [['review', 'VER-fixture-1', ['approve']], ['waiver', 'WVR-fixture-2', ['approve-waiver', 'reject-waiver']]]);
  assert.equal(waiting[0].waivers, 1);
  assert.deepEqual(waiting[1].findings, ['settings.toggle: text "Weekly" vs "Monthly"']);
  // The dashboard reviewer must be listed in policy.waivers.reviewers; an ai: identity never decides.
  const configFile = path.join(root, 'protoflow.config.json'), config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  await fs.writeFile(configFile, JSON.stringify({ ...config, dashboard: { ...config.dashboard, reviewer: 'Someone Else' } }));
  await assert.rejects(runAction(root, { action: 'approve-waiver', waiverId: 'WVR-fixture-2' }), /Someone Else is not a waiver reviewer/);
  await fs.writeFile(configFile, JSON.stringify({ ...config, dashboard: { ...config.dashboard, reviewer: 'ai:claude' } }));
  // The config itself refuses an ai: dashboard reviewer.
  await assert.rejects(runAction(root, { action: 'approve-waiver', waiverId: 'WVR-fixture-2' }), /\/dashboard\/reviewer/);
  await fs.writeFile(configFile, JSON.stringify(config));
  const approved = await runAction(root, { action: 'approve-waiver', waiverId: 'WVR-fixture-2', notes: 'until the engine fix' });
  assert.deepEqual([approved.status, approved.waiverId, approved.waiver], ['PASS', 'WVR-fixture-2', 'approved']);
  const stored = JSON.parse(await fs.readFile(path.join(root, '.protoflow/waivers/WVR-fixture-2.json'), 'utf8'));
  assert.deepEqual([stored.decision.reviewer, stored.decision.reviewerKind, stored.decision.notes], ['Fixture Person', 'human', 'until the engine fix']);
  await assert.rejects(runAction(root, { action: 'reject-waiver', waiverId: 'WVR-fixture-2' }), /already approved/);
  assert.equal((await runAction(root, { action: 'revoke-waiver', waiverId: 'WVR-fixture-1' })).waiver, 'revoked');
  assert.deepEqual((await dashboardSnapshot(root, { service: false })).attention.filter(item => item.kind === 'waiver'), []);
  // Under autoApprove the dashboard approves only a version that passed with waivers.
  await assert.rejects(runAction(root, { action: 'approve', manifestId: 'git-x', verificationId: 'VER-missing' }), /only a version that passed with maintainer waivers is approved here/);
  const log = (await fs.readFile(path.join(root, '.protoflow/dashboard/actions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.action, entry.status]), [['approve-waiver', 'FAIL'], ['approve-waiver', 'PASS'], ['reject-waiver', 'FAIL'], ['revoke-waiver', 'PASS'], ['approve', 'FAIL']]);
});

function request(url, { method = 'GET', headers = {}, body, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, response => {
      let data = ''; response.setEncoding(encoding);
      response.on('data', chunk => { data += chunk; if (response.headers['content-type']?.startsWith('text/event-stream') && data.includes('\n\n')) { req.destroy(); resolve({ status: response.statusCode, headers: response.headers, body: data }); } });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data }));
    });
    req.on('error', error => error.code === 'ECONNRESET' ? null : reject(error));
    if (body) req.write(body);
    req.end();
  });
}

test('the server answers only loopback hosts, serves only artifact screenshots and runs actions behind its token', async t => {
  const { root, home } = await fixture(t);
  await addProject(root, { home });
  const calls = [];
  const dashboard = createDashboardServer({ home, port: 0, service: false, pollMs: 50, actions: async (projectRoot, body) => { calls.push([projectRoot, body]); return { status: 'PASS', next: 'fixture' }; } });
  const url = await dashboard.listen(); t.after(() => dashboard.close());
  const id = await projectId(root);
  const page = await request(url);
  assert.equal(page.status, 200); assert.match(page.body, new RegExp(`name="protoflow-token" content="${dashboard.token}"`));
  assert.equal((await request(url, { headers: { host: 'evil.example:80' } })).status, 403);
  assert.equal((await request(`${url}api/projects`, { headers: { origin: 'https://evil.example' } })).status, 403);
  const overview = JSON.parse((await request(`${url}api/projects`)).body);
  assert.equal(overview.projects[0].name, 'Fixture App'); assert.equal(overview.projects[0].attention, 2); assert.equal(overview.projects[0].streams[0].stage, 'execute');
  const snapshot = JSON.parse((await request(`${url}api/projects/${id}`)).body);
  assert.equal(snapshot.streams[0].live.model, 'claude-sonnet-5-5');
  const image = await request(`${url}api/projects/${id}/file?path=${encodeURIComponent('.protoflow/artifacts/VER-fixture-1/web/settings.initial/prototype.png')}`, { encoding: 'latin1' });
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(Buffer.from(image.body, 'latin1').equals(PNG), 'the exact screenshot bytes');
  for (const bad of ['protoflow.config.json', '.protoflow/artifacts/../../protoflow.config.json', '.protoflow/runner/state.json']) assert.equal((await request(`${url}api/projects/${id}/file?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  assert.equal((await request(`${url}api/projects/000000000000`)).status, 404);
  const post = token => request(`${url}api/projects/${id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { 'x-protoflow-token': token }) }, body: JSON.stringify({ action: 'merge', deliveryId: 'DLV-fixture-1' }) });
  assert.equal((await post(null)).status, 403); assert.equal((await post('wrong')).status, 403); assert.deepEqual(calls, []);
  const done = await post(dashboard.token);
  assert.equal(done.status, 200); assert.deepEqual(calls, [[await fs.realpath(root), { action: 'merge', deliveryId: 'DLV-fixture-1' }]]);
  const events = await request(`${url}api/projects/${id}/stream`);
  assert.match(events.headers['content-type'], /^text\/event-stream/); assert.match(events.body, /^data: \{"protocol":"protoflow\.dashboard\/1"/);
});

test('actions refuse unknown requests and record every attempt in the project audit log', async t => {
  const { root } = await fixture(t);
  await assert.rejects(runAction(root, { action: 'delete-everything' }), error => error.statusCode === 400);
  await assert.rejects(runAction(root, { action: 'merge', deliveryId: 'DLV-missing' }), /is not a manual PR waiting to be merged/);
  await assert.rejects(runAction(root, { action: 'approve', manifestId: 'x', verificationId: 'y' }), /approves automatically/);
  await assert.rejects(runAction(root, { action: 'handback', number: 6 }), /not waiting for a person/);
  const log = (await fs.readFile(path.join(root, '.protoflow/dashboard/actions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.action, entry.status]), [['merge', 'FAIL'], ['approve', 'FAIL'], ['handback', 'FAIL']]);
  assert.equal(log[0].via, 'dashboard'); assert.match(log[0].error, /DLV-missing/);
});

test('the overview carries each working target\'s version, phase, timer start and the executor\'s latest action', async t => {
  const f = await fixture(t);
  const [stream] = (await dashboardSnapshot(f.root)).streams;
  const card = overviewStream(stream);
  assert.equal(card.stage, 'execute');
  assert.equal(card.phase, 'execute');
  assert.ok(card.phaseStartedAt);
  assert.equal(card.current.summary, 'Settings toggle');
  assert.equal(card.current.attempts, 1);
  assert.deepEqual(card.live.last, { kind: 'run', text: 'Run unit tests: npm test' });
  assert.deepEqual(card.live.totals, { edits: 1, commands: 1, reads: 1, searches: 0 });
  assert.equal(card.lastEvent.event, 'execute');
  // An idle target sends no live activity, so the card stays quiet.
  const idle = await fixture(t, { executing: false });
  assert.equal(overviewStream((await dashboardSnapshot(idle.root)).streams[0]).live, null);
});

test('a known failure becomes what to do before retrying: which login expired, the network, the disk', () => {
  const claude = diagnose('Claude execution FAIL (EXEC-1792798137551-21266fcf, exit 1): Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.equal(claude.kind, 'auth'); assert.equal(claude.title, 'Claude 登入失效'); assert.equal(claude.command, 'claude');
  assert.match(claude.steps.join(' '), /`\/login`/);
  assert.deepEqual([diagnose('HTTP 401: Bad credentials (https://api.github.com/graphql)').command, diagnose('codex exec failed: 401 Unauthorized').command], ['gh auth login', 'codex login']);
  assert.equal(diagnose('fatal: unable to access: Could not resolve host: github.com').kind, 'network');
  assert.equal(diagnose('rate_limit_error: 429 Too Many Requests').kind, 'quota');
  assert.equal(diagnose('write ENOSPC: no space left on device').command, 'protoflow runner gc');
  assert.equal(diagnose('Executor timed out after 1800000ms').kind, 'timeout');
  // An unknown reason is shown as it is, without a guess.
  assert.equal(diagnose('Repair limit exhausted (2)'), null);
  assert.equal(diagnose(undefined), null);
});

test('a blocked version waiting for a person carries the diagnosis of its failure', async t => {
  const f = await fixture(t, { blockedError: 'Claude execution FAIL (exit 1): Failed to authenticate: OAuth session expired' });
  const blocked = (await dashboardSnapshot(f.root)).attention.find(item => item.kind === 'blocked-version');
  assert.equal(blocked.diagnosis.title, 'Claude 登入失效');
  assert.match(blocked.reason, /OAuth session expired/);
});

test('a runner reasonCode decides the diagnosis first, and a blocked version says since when it waits', async t => {
  assert.equal(diagnose('Repair made no progress: 2 rounds in a row did not reduce the failures (21 → 21 → 21)', 'stalled').title, '修復沒有進展');
  assert.equal(diagnose('Repair limit exhausted (3)', 'repair-limit').kind, 'repair-limit');
  assert.deepEqual([diagnose('Operator action required after attempt 0: the executor may not change scripts/build.mjs.', 'operator-action').kind, diagnose('Operator action required', 'operator-action').title], ['operator-action', '需要操作員處理']);
  assert.deepEqual([diagnose('Base main moved to 1a2b3c4 but the runner worktree has 1 commit(s) not in the base', 'base-moved').kind, diagnose('Base main moved', 'base-moved').command], ['base-moved', 'protoflow runner rebase']);
  // An environment block still tells an expired login from an unreachable network by its text.
  const login = diagnose('Claude execution cannot run in this environment (EXEC-1, exit 1): OAuth token has expired', 'environment');
  assert.deepEqual([login.kind, login.reasonCode, login.command], ['auth', 'environment', 'claude']);
  assert.equal(diagnose('Codex execution cannot run in this environment: getaddrinfo ENOTFOUND api.openai.com', 'environment').kind, 'network');
  const build = diagnose('Build cannot run in this environment (VER-1, build): [!] Unable to locate the executable `cmake`. (hermes-engine fell back to a source build); retried after 60s: FAIL', 'environment');
  assert.deepEqual([build.kind, build.reasonCode], ['build-environment', 'environment']); assert.match(build.steps.join(' '), /HERMES_ENGINE_TARBALL_PATH/);
  // A code the dashboard does not know falls back to the text.
  assert.equal(diagnose('Executor timed out after 1800000ms', 'execution').kind, 'timeout');
  const since = '2026-10-24T10:00:00.000Z';
  const f = await fixture(t, { blockedError: 'Repair made no progress: 2 rounds in a row did not reduce the failures (6 → 6 → 6)', blockedReasonCode: 'stalled', blockedAt: since });
  const view = await dashboardSnapshot(f.root, { service: false });
  const blocked = view.attention.find(item => item.kind === 'blocked-version');
  assert.deepEqual([blocked.reasonCode, blocked.since, blocked.diagnosis.kind], ['stalled', since, 'stalled']);
  assert.equal(view.streams[0].current.reasonCode, 'stalled'); assert.equal(view.streams[0].current.blockedAt, since);
  assert.ok(view.attention.every(item => 'since' in item), 'every item says since when it waits, or null');
});

test('pages watching the same view share one poll, and a view nobody watches stops polling', async t => {
  const { root, home } = await fixture(t);
  await addProject(root, { home });
  let reads = 0;
  const dashboard = createDashboardServer({ home, port: 0, service: false, pollMs: 100, snapshotOf: async (...args) => { reads += 1; return dashboardSnapshot(...args); } });
  const url = await dashboard.listen(); t.after(() => dashboard.close());
  const id = await projectId(root);
  const open = path => new Promise((resolve, reject) => {
    const req = http.get(`${url}${path}`, response => { response.setEncoding('utf8'); let data = ''; response.on('data', chunk => { data += chunk; if (data.includes('\n\n')) resolve({ req, data }); }); });
    req.on('error', error => error.code === 'ECONNRESET' ? null : reject(error));
  });
  // Three project pages and the overview: every page gets data, yet the project is read about once per poll.
  const pages = await Promise.all([open(`api/projects/${id}/stream`), open(`api/projects/${id}/stream`), open(`api/projects/${id}/stream`), open('api/stream')]);
  for (const page of pages.slice(0, 3)) assert.match(page.data, /^data: \{"protocol":"protoflow\.dashboard\/1"/);
  assert.match(pages[3].data, /"inbox":\[/);
  const before = reads;
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.ok(reads - before <= 12, `${reads - before} reads in 10 polls of two views`);
  for (const page of pages) page.req.destroy();
  await new Promise(resolve => setTimeout(resolve, 300));
  const idle = reads;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(reads, idle, 'no polling once every page has gone');
});

test('engine watcher resolves with the new version once the checkout on disk changes, riding out unreadable reads', async () => {
  const reads = [async () => '0.3.1', async () => { throw new Error('mid-checkout'); }, async () => '0.3.2'];
  const watcher = watchEngineVersion('0.3.1', { intervalMs: 5, read: () => reads.shift()() });
  assert.equal(await watcher.changed, '0.3.2');
  assert.equal(reads.length, 0);
});

test('dashboard service exits on an engine upgrade so launchd restarts it; the foreground server only reports it', async () => {
  const home = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'protoflow-reload-'));
  const upgrade = () => ({ changed: Promise.resolve('9.9.9'), stop: () => {} });
  const events = [];
  let url;
  const service = await serveDashboard({ port: 0, home, reloadOnUpgrade: true, watch: upgrade, log: event => events.push(event), onListen: value => { url = value; } });
  assert.equal(service.status, 'RELOAD');
  assert.equal(service.current, '9.9.9');
  await assert.rejects(fetch(url), 'the port is released for the restarted process');
  assert.equal(events.at(-1).event, 'engine-upgraded');

  events.length = 0;
  const foreground = serveDashboard({ port: 0, home, watch: upgrade, log: event => events.push(event) });
  while (!events.length) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(events[0].hint, /restart/);
  process.emit('SIGTERM');
  assert.equal((await foreground).status, 'STOPPED');
});

test('issues: a waiting issue offers answer, hand back and close; once handed back it leaves the list unless no runner is there to sync it', async t => {
  const { root } = await fixture(t);
  let view = await dashboardSnapshot(root, { service: false });
  const waiting = view.attention.find(item => item.kind === 'issue');
  assert.deepEqual(waiting.actions, ['answer-issue', 'handback', 'close-issue']); assert.equal(waiting.waiting, undefined);
  await fs.mkdir(path.join(root, '.protoflow/dashboard'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/dashboard/actions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), action: 'answer-issue', args: { number: 5, text: 'FAKE FIXTURE answer' }, via: 'dashboard', status: 'PASS', result: { actor: 'human:fixture' } })}\n`);
  // A live runner picks it up on its next sync: nothing waits for the person.
  view = await dashboardSnapshot(root, { service: false });
  assert.equal(view.attention.some(item => item.kind === 'issue'), false);
  assert.deepEqual(view.issues.find(issue => issue.number === 5).handedBack, { action: 'answer-issue', at: view.issues.find(issue => issue.number === 5).handedBack.at, actor: 'human:fixture' });
  assert.equal(view.streams[0].stopped, undefined);
  // No runner (the heartbeat is an hour old): the card says issue work stopped and how to start it, and lanes show stopped.
  const heartbeat = path.join(root, '.protoflow/runner/heartbeat.json');
  await fs.writeFile(heartbeat, JSON.stringify({ ...JSON.parse(await fs.readFile(heartbeat, 'utf8')), at: new Date(Date.now() - 3600000).toISOString() }));
  view = await dashboardSnapshot(root, { service: false });
  const stopped = view.attention.find(item => item.kind === 'issue');
  assert.equal(stopped.waiting, 'runner'); assert.deepEqual(stopped.actions, []); assert.equal(stopped.handedBack.action, 'answer-issue');
  assert.equal(stopped.diagnosis.kind, 'runner-stopped'); assert.match(stopped.diagnosis.command, /^protoflow runner /);
  assert.equal(view.streams[0].stopped, true);
});
