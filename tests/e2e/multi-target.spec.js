import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FAKE_GH } from '../helpers/fake-gh.js';

const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');

/*
 * Multi-target runner end to end: one local Git prototype stream, two targets with separate roots, real Chromium
 * verification, a per-target independent AI review gate, automated approval and per-target delivery through a bare
 * remote. Test doubles stand in for gh, the Codex review provider and the github.com transport (FAKE fixtures only).
 * The executor is a deterministic stand-in for Codex: it copies the frozen prototype into its target's root,
 * renaming data-pf to data-testid, and prints a Codex-shaped JSONL session trace; a marker file makes it fail for one target.
 */
const fixtureUrl = 'https://github.com/protoflow-fixture/application.git';
const EXECUTOR = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
const target = context.anchors.target;
try { await fs.access(process.argv[2] + '-' + target.id); console.error('injected executor failure for ' + target.id); process.exit(1); } catch {}
const source = context.prototypeVersion.prototypeDir;
for (const entry of await fs.readdir(source, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const to = path.join(target.root, path.relative(source, from));
  await fs.mkdir(path.dirname(to), { recursive: true });
  let data = await fs.readFile(from);
  if (/\.(html|js|css)$/.test(entry.name)) data = data.toString().replaceAll('data-pf=', 'data-testid=').replaceAll("'data-pf'", "'data-testid'");
  await fs.writeFile(to, data);
}
// Session provenance the review gate checks: one started, completed executor session.
for (const event of [{ type: 'thread.started', thread_id: 'executor-' + target.id + '-' + process.pid }, { type: 'turn.started' }, { type: 'turn.completed' }]) console.log(JSON.stringify(event));
`;

const page = (screen, body) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${screen}</title><link rel="stylesheet" href="style.css"></head>\n<body data-pf="${screen}" data-pf-role="screen">\n${body}\n</body></html>\n`;

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'protoflow-multi-'));
  const design = path.join(base, 'design'), remote = path.join(base, 'remote.git'), root = path.join(base, 'app'), bin = path.join(base, 'bin');
  const transport = path.join(base, 'git-transport.json');
  const run = (cwd, ...args) => exec('git', args, { cwd }).then(result => result.stdout.trim());
  const identity = async cwd => { await run(cwd, 'config', 'user.email', 'fixture@protoflow.test'); await run(cwd, 'config', 'user.name', 'Fixture'); };
  for (const dir of [design, root, bin]) await mkdir(dir, { recursive: true });
  await run(design, 'init', '-q', '-b', 'prototypes'); await identity(design);
  const commit = async (files, message) => {
    for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(design, file)), { recursive: true }); await writeFile(path.join(design, file), content); }
    await run(design, 'add', '.'); await run(design, 'commit', '-q', '-m', message); return run(design, 'rev-parse', 'HEAD');
  };
  const start = await commit({ 'README.md': 'design\n' }, 'start');
  await commit({
    'prototype/style.css': 'body{margin:0;font-family:Arial,sans-serif;background:#f2f5f7}main{margin:40px;padding:24px;background:#fff;border-radius:12px}button{background:#0d766e;color:#fff;border:0;border-radius:8px;padding:10px 16px}[hidden]{display:none}\n',
    'prototype/home.html': page('home', '<main data-pf="home.panel" data-pf-role="region"><h1 data-pf="home.title">Hello</h1><button id="greet" data-pf="home.greet" data-pf-role="action">Greet</button><p id="message" data-pf="home.message" hidden>Welcome!</p></main>\n<script src="home.js"></script>'),
    'prototype/home.js': "document.getElementById('greet').addEventListener('click', () => { document.getElementById('message').hidden = false; });\n",
    'prototype/home.pf.json': JSON.stringify({ schemaVersion: 1, screen: 'home', states: { greeted: { steps: [{ action: 'tap', anchor: 'home.greet' }], expect: { visible: ['home.message'] } } } })
  }, 'Home screen');

  await run(base, 'init', '-q', '--bare', '-b', 'main', remote);
  await run(root, 'init', '-q', '-b', 'main'); await identity(root);
  await run(root, 'remote', 'add', 'origin', remote);
  const failMarker = path.join(base, 'fail');
  await writeFile(path.join(root, 'executor.mjs'), EXECUTOR);
  const target = (id, platform, width) => ({
    id, platform, root: id,
    driver: { kind: 'playwright-web', urlTemplate: `${id}/{page}.html` },
    build: { argv: [process.execPath, '-e', '0'] }, functional: { argv: [process.execPath, '-e', '0'] },
    viewport: { width, height: 600, scale: 1 }
  });
  const config = {
    schemaVersion: 2, prototypeDir: 'prototype', anchors: { attribute: 'data-pf' },
    targets: [target('web', 'web', 800), target('desktop', 'electron', 1100)],
    release: { requireTargets: ['web', 'desktop'] },
    policy: { maxRepairAttempts: 0, requireHumanReview: true, sequentialVersions: true, autoApprove: true },
    adapters: {
      codex: { command: { argv: [process.execPath, 'executor.mjs', failMarker], timeoutMs: 60000 } },
      independentReview: { command: { argv: [process.execPath, path.join(engine, 'scripts/codex-review-adapter.js')], timeoutMs: 60000 } }
    },
    source: { kind: 'git', repository: design, branch: 'prototypes', path: 'prototype', startSha: start },
    runner: { pollMs: 1000, spec: 'spec.md', delivery: { remote: 'origin', branch: 'protoflow/delivery', baseBranch: 'main', merge: 'auto' } }
  };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config, null, 2));
  await writeFile(path.join(root, '.gitignore'), '.protoflow/\nnode_modules/\n');
  await writeFile(path.join(root, 'spec.md'), '# Reviewed specification\nThe home screen greets on request; the about screen is static.\n');
  for (const id of ['web', 'desktop']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, '.gitkeep'), ''); }
  await run(root, 'add', '.'); await run(root, 'commit', '-q', '-m', 'Application'); await run(root, 'push', '-q', 'origin', 'main');
  // Delivery only publishes to github.com; the git double maps that URL onto the bare remote.
  await run(root, 'remote', 'set-url', 'origin', fixtureUrl);
  const realGit = (await exec('which', ['git'])).stdout.trim();
  await writeFile(transport, JSON.stringify({ realGit, urls: { [fixtureUrl]: remote }, log: path.join(base, 'git-calls.json') }));
  await writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  for (const [name, fixture] of [['git', 'fake-delivery-git.cjs'], ['codex', 'fake-codex-review.cjs']]) {
    await copyFile(path.join(engine, 'tests/fixtures', fixture), path.join(bin, name)); await chmod(path.join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_DB: path.join(base, 'gh.json'), FAKE_DELIVERY_GIT: transport, FAKE_GH_REAL_REMOTE: remote };
  for (const key of ['GH_REPO', 'GH_HOST', 'FAKE_GH_FAIL', 'FAKE_GH_DRIFT', 'FAKE_REVIEW_MODE']) delete env[key];
  const cliRun = async (args, expected) => {
    let result;
    try { result = { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 })) }; }
    catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    if (expected !== undefined) expect(result.code, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(expected);
    const lines = (result.stdout || result.stderr).trim();
    // runner start prints JSONL events, then the pretty-printed final result.
    const json = JSON.parse(lines.startsWith('{"event"') ? lines.slice(lines.lastIndexOf('\n{\n') + 1) : lines);
    return json;
  };
  return { base, root, remote, failMarker, commit, cliRun, run, gh: async () => JSON.parse(await readFile(env.FAKE_GH_DB, 'utf8')) };
}

test('two targets advance through the same versions independently and deliver on their own branches', async () => {
  test.setTimeout(300000);
  const fixture = await setup();
  const { root, remote, failMarker, commit, cliRun, run, gh } = fixture;
  try {
    expect((await cliRun(['doctor'])).checks.find(check => check.name === 'verification').detail).toMatch(/target web .* target desktop/);
    await writeFile(`${failMarker}-desktop`, 'fail');
    const first = await cliRun(['runner', 'start', '--once'], 3);
    expect(first.status).toBe('BLOCKED');
    expect(first.targets.web.status, JSON.stringify(first.targets.web)).toBe('IDLE');
    expect(first.targets.desktop.status).toBe('BLOCKED');
    expect(first.targets.desktop.reason).toMatch(/Codex execution FAIL/);

    let queue = await cliRun(['queue']);
    const [v1] = queue.versions;
    expect(v1.acceptance).toBe('partial');
    expect(queue.targets.web.current).toBe(null);
    expect(queue.targets.desktop.current).toBe(v1.id);
    expect(queue.release).toEqual({ requireTargets: ['web', 'desktop'], version: null, summary: null });
    // Each target has its own worktree, runner state and progress.
    const status = await cliRun(['runner', 'status']);
    expect(status.targets.web.runner.worktree).toMatch(/-web$/);
    expect(status.targets.desktop.runner.worktree).toMatch(/-desktop$/);
    expect(status.targets.web.progress.entries[0].status).toBe('PASS');
    expect(status.targets.desktop.progress.entries[0].status).toBe('BLOCKED');
    // Commands that act on one target must say which.
    expect((await cliRun(['verify', '--manifest', v1.id], 1)).error).toMatch(/several targets .*pass --target/);
    expect((await cliRun(['context', '--manifest', v1.id, '--target', 'web'], 3)).error).toMatch(/已由 .* 驗收/);

    await rm(`${failMarker}-desktop`);
    expect((await cliRun(['runner', 'retry', '--target', 'desktop'])).target).toBe('desktop');
    const v2sha = await commit({ 'prototype/about.html': page('about', '<main data-pf="about.panel" data-pf-role="region"><h1 data-pf="about.title">About</h1></main>') }, 'About screen');
    const second = await cliRun(['runner', 'start', '--once'], 0);
    expect(second.status).toBe('IDLE');
    expect(second.targets.desktop.status).toBe('IDLE');

    queue = await cliRun(['queue']);
    expect(queue.versions.map(version => version.acceptance)).toEqual(['accepted', 'accepted']);
    expect(queue.release.version).toBe(`git-${v2sha}`);
    expect(queue.targets.desktop.lastAccepted).toBe(`git-${v2sha}`);
    const verifications = queue.versions.map(version => version.targets);
    expect(verifications.every(targets => targets.web && targets.desktop && targets.web !== targets.desktop)).toBe(true);

    // Delivery: per-target branches and PRs, each behind its own independent review, adding only its own target's root.
    const branches = (await run(remote, 'branch', '--list', 'protoflow/delivery/*')).split('\n').map(line => line.trim()).sort();
    expect(branches).toEqual(['protoflow/delivery/desktop', 'protoflow/delivery/web']);
    // One PR per delivered version on each target's branch: 2 versions × 2 targets.
    const pulls = (await gh()).prs;
    expect(pulls.map(pr => pr.head).sort()).toEqual(['protoflow/delivery/desktop', 'protoflow/delivery/desktop', 'protoflow/delivery/web', 'protoflow/delivery/web']);
    expect(pulls.every(pr => pr.state === 'MERGED' && pr.base === 'main'), JSON.stringify(pulls.map(({ comments, ...pr }) => pr))).toBe(true);
    expect(pulls.filter(pr => pr.head === 'protoflow/delivery/desktop').flatMap(pr => pr.comments).join()).toMatch(/target desktop/);
    const deliveries = await cliRun(['delivery', 'status']);
    expect(Object.keys(deliveries.targets)).toEqual(['web', 'desktop']);
    const reviews = new Set();
    for (const [id, other] of [['web', 'desktop'], ['desktop', 'web']]) {
      expect(deliveries.targets[id].deliveries.map(item => item.status)).toEqual(['MERGED', 'MERGED']);
      for (const delivery of deliveries.targets[id].deliveries) {
        // Each delivery passed its own fresh review; the automated approval names that session, not the Runner.
        expect(delivery.independentReviewAttempts.map(attempt => attempt.status)).toEqual(['PASS']);
        expect(delivery.approval.reviewer).toBe(`ai:codex-independent-review:${delivery.independentSessionId}`);
        expect(delivery.alignment.status, JSON.stringify(delivery.alignment)).toBe('PASS');
        reviews.add(delivery.independentReviewId);
        // What each PR adds to its base only touches its own target's root.
        const files = (await run(remote, 'diff', '--name-only', delivery.baseSha, delivery.commit)).split('\n').filter(Boolean);
        const sha = delivery.commit;
        expect(files.length).toBeGreaterThan(0);
        expect(files.every(file => file.startsWith(`${id}/`)), `${id} ${sha}: ${files.join(', ')}`).toBe(true);
        expect(files.some(file => file.startsWith(`${other}/`))).toBe(false);
      }
    }
    expect(reviews.size).toBe(4);
    // Desktop's first version forked before web's merges reached main, so it integrated that base first.
    expect(deliveries.targets.desktop.deliveries[0].integration.baseSha).toBe(deliveries.targets.desktop.deliveries[0].baseSha);
    expect(deliveries.targets.web.deliveries.every(item => !item.integration)).toBe(true);
    // Anchor indexes live in each target's worktree, where its executor reads them.
    for (const id of ['web', 'desktop']) await access(path.join(status.targets[id].runner.worktree, `.protoflow/targets/${id}/anchor-index.json`));
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});
