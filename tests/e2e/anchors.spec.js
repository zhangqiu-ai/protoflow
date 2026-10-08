import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');
const playwrightCli = path.join(engine, 'node_modules/@playwright/test/cli.js');

async function command(root, args, expectedCode = 0, env = {}) {
  let result;
  try { result = { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const output = result.stdout?.trim() || result.stderr;
  let json;
  try { json = JSON.parse(output); } catch { throw new Error(`${args.join(' ')} returned invalid JSON: ${output}`); }
  const scenes = json.visual?.scenes?.map(scene => `${scene.id}:${scene.status} ${JSON.stringify(Object.fromEntries(Object.entries(scene.tiers).map(([tier, value]) => [tier, value.reasons?.slice(0, 2)])))}`);
  expect(result.code, `${args.join(' ')}\n${json.error ?? json.visual?.reason ?? ''}\n${scenes?.join('\n') ?? ''}\n${json.functional?.stdout?.slice(-800) ?? ''}`).toBe(expectedCode);
  return json;
}

/** Copy the anchors example into a temporary project using this checkout's Playwright runner. */
async function project({ target } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-anchors-e2e-'));
  await cp(path.join(engine, 'examples/anchors'), root, { recursive: true, filter: source => !/(\.protoflow|test-results|node_modules)/.test(source) });
  await symlink(path.join(engine, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
  await writeFile(path.join(root, 'spec.md'), '# Reviewed specification\nTasks can be added and validated; settings can be saved.\n');
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.targets[0].functional = { argv: [process.execPath, playwrightCli, 'test', '-c', 'playwright.config.js'] };
  if (target) config.targets[0] = { ...config.targets[0], ...target };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return root;
}
const edit = async (root, file, from, to) => {
  const target = path.join(root, file);
  const content = await readFile(target, 'utf8');
  if (!content.includes(from)) throw new Error(`${file} lacks ${from}`);
  await writeFile(target, content.replace(from, to));
  return () => writeFile(target, content);
};

test('anchored web target passes all four tiers without any mapping', async () => {
  test.setTimeout(120000);
  const root = await project();
  try {
    expect((await command(root, ['anchors', 'lint'])).status).toBe('PASS');
    const manifest = await command(root, ['checkpoint', '--summary', 'v1']);
    expect(manifest.scope.affected).toEqual(['settings', 'tasks']);
    expect(manifest.mappings).toEqual([]);
    const context = await command(root, ['context', '--manifest', manifest.id, '--spec', 'spec.md']);
    expect(Object.keys(context.anchors.screens)).toEqual(['settings', 'tasks']);
    expect(context.anchors.target.convention).toContain('data-testid');
    expect(context.instructions).toContain('app/{page}.html');
    const verification = await command(root, ['verify', '--manifest', manifest.id]);
    expect(verification.status).toBe('PASS');
    expect(verification.visual.mode).toBe('anchors');
    expect(Object.values(verification.visual.tiers).map(tier => tier.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    expect(verification.visual.scenes.map(scene => scene.id)).toEqual(['settings.initial', 'settings.saved', 'tasks.initial', 'tasks.empty-error', 'tasks.added']);
    await access(verification.visual.artifacts.at(-1));
    const index = JSON.parse(await readFile(path.join(root, '.protoflow/targets/web/anchor-index.json'), 'utf8'));
    expect(index.anchors['tasks.add']).toContainEqual({ file: 'app/tasks.html', line: 13 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('each tier reports its own kind of drift', async () => {
  test.setTimeout(180000);
  const root = await project();
  try {
    const manifest = await command(root, ['checkpoint']);
    const verifyFailing = async () => (await command(root, ['verify', '--manifest', manifest.id], 1)).visual;

    let restore = await edit(root, 'app/tasks.html', '<h1 data-testid="tasks.title">Today</h1>', '<h1 data-testid="tasks.title">Tomorrow</h1>');
    let visual = await verifyFailing();
    expect(visual.tiers.structure.status).toBe('FAIL');
    expect(visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.structure.reasons).toContain('tasks.title: text "Today" vs "Tomorrow"');
    await restore();

    restore = await edit(root, 'app/styles.css', 'background:#0d766e;color:#fff', 'background:#1d4ed8;color:#fff');
    visual = await verifyFailing();
    expect(visual.tiers.structure.status).toBe('PASS');
    expect(visual.tiers.tokens.status).toBe('FAIL');
    expect(visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.tokens.reasons.join()).toMatch(/tasks\.add: backgroundColor color\.accent vs rgb\(29, 78, 216\)/);
    await restore();

    restore = await edit(root, 'app/styles.css', '.screen{width:560px;', '.screen{width:560px;display:flex;flex-direction:column-reverse;');
    visual = await verifyFailing();
    expect(visual.tiers.layout.status).toBe('FAIL');
    expect(visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.layout.reasons.join()).toMatch(/is above .* but below/);
    await restore();

    restore = await edit(root, 'app/tasks.html', '<button data-testid="tasks.add" type="submit">', '<button type="submit">');
    visual = await verifyFailing();
    expect(visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.structure.reasons).toContain('tasks.add: expected 1 element(s), found 0');
    // The state that taps the missing anchor cannot be reached in the application at all.
    expect(visual.scenes.find(scene => scene.id === 'tasks.empty-error').reason).toMatch(/application could not reach tasks\.empty-error/);
    await restore();

    expect((await command(root, ['verify', '--manifest', manifest.id])).status).toBe('PASS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a new prototype screen is verified without any configuration change', async () => {
  test.setTimeout(180000);
  const root = await project();
  try {
    const first = await command(root, ['checkpoint']);
    expect((await command(root, ['verify', '--manifest', first.id])).status).toBe('PASS');
    const configBefore = await readFile(path.join(root, 'protoflow.config.json'), 'utf8');
    const about = name => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="styles.css"></head>\n<body>\n<main class="screen" ${name}="about"${name === 'data-pf' ? ' data-pf-role="screen"' : ''}>\n  <h1 ${name}="about.title">About</h1>\n  <p ${name}="about.body">Prototype-driven tasks.</p>\n</main>\n</body>\n</html>\n`;
    await writeFile(path.join(root, 'prototype/about.html'), about('data-pf'));
    const second = await command(root, ['checkpoint', '--summary', 'Add about screen']);
    expect(second.scope.affected).toEqual(['about']);
    expect(second.scope.screens.about.status).toBe('added');
    const missing = await command(root, ['verify', '--manifest', second.id], 1);
    expect(missing.visual.scenes.find(scene => scene.id === 'about.initial').reason).toMatch(/application screen about is not reachable at app\/about\.html/);
    // What an executor does for this version: implement the screen with the anchor IDs.
    await writeFile(path.join(root, 'app/about.html'), about('data-testid'));
    const passed = await command(root, ['verify', '--manifest', second.id]);
    expect(passed.status).toBe('PASS');
    expect(passed.visual.scenes.map(scene => scene.id)).toContain('about.initial');
    expect(await readFile(path.join(root, 'protoflow.config.json'), 'utf8')).toBe(configBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid anchors are reported and never become a version', async () => {
  const root = await project();
  try {
    await writeFile(path.join(root, 'prototype/broken.html'), '<!doctype html><html><body><main><h1 data-pf="Bad Id">x</h1></main></body></html>\n');
    const lint = await command(root, ['anchors', 'lint'], 1);
    expect(lint.errors.join('\n')).toMatch(/broken\.html: Invalid anchor id "Bad Id"/);
    expect(lint.errors.join('\n')).toMatch(/broken\.html: expected exactly one data-pf-role="screen" anchor, found 0/);
    const checkpoint = await command(root, ['checkpoint'], 1);
    expect(checkpoint.error).toBe('Prototype anchors are invalid');
    expect((await command(root, ['queue'])).versions).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Protocol test double: a "native" driver that drives the web app through Playwright but reports what native
// automation exposes — identifiers, bounds, text, visibility — and no computed styles.
const FAKE_NATIVE_DRIVER = `
import { chromium } from ${JSON.stringify(path.join(engine, 'node_modules/playwright/index.mjs'))};
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (process.env.FAKE_DRIVER_DEVICE === 'missing') { console.log(JSON.stringify({ schemaVersion: 1, status: 'NOT_RUN', reason: 'no emulator attached' })); process.exit(0); }
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: request.viewport.width, height: request.viewport.height }, deviceScaleFactor: request.viewport.scale });
  await page.goto(pathToFileURL(path.resolve('app', path.basename(request.page))).href);
  for (const step of request.steps) {
    const target = page.locator('[data-testid="' + step.anchor + '"]').first();
    if (step.action === 'tap' || step.action === 'toggle') await target.click(); else if (step.action === 'fill') await target.fill(step.value);
  }
  const elements = [], missing = [];
  for (const anchor of request.anchors) {
    const nodes = page.locator('[data-testid="' + anchor + '"]');
    const count = await nodes.count();
    if (!count) { missing.push(anchor); continue; }
    const first = nodes.first();
    const box = await first.boundingBox();
    const facts = await first.evaluate(node => ({ text: node.matches('input,textarea') ? node.value || node.placeholder || '' : node.innerText, tag: node.tagName }));
    elements.push({ anchor, count, visible: await first.isVisible(), enabled: await first.isEnabled(), interactive: ['BUTTON', 'A', 'INPUT'].includes(facts.tag), editable: facts.tag === 'INPUT',
      bounds: box ?? { x: 0, y: 0, width: 0, height: 0 }, text: facts.text });
  }
  await mkdir(request.outputDir, { recursive: true });
  await page.screenshot({ path: path.join(request.outputDir, 'device.png'), scale: 'device' });
  console.log(JSON.stringify({ schemaVersion: 1, status: 'PASS', screenshot: 'device.png', viewport: request.viewport, elements, missing }));
} finally { await browser.close(); }
`;

test('external driver protocol verifies a native-style target with sampled tokens and perceptual visuals', async () => {
  test.setTimeout(180000);
  // visual: undefined drops the example's pixel setting so the android platform defaults (perceptual, advisory) apply.
  const root = await project({ target: { id: 'android', platform: 'android', visual: undefined, driver: { kind: 'external', command: { argv: [process.execPath, 'native-driver.mjs'], timeoutMs: 60000 } } } });
  try {
    await writeFile(path.join(root, 'native-driver.mjs'), FAKE_NATIVE_DRIVER);
    const manifest = await command(root, ['checkpoint']);
    // Drift first: an accepted version cannot be verified again (the queue moves on).
    const restore = await edit(root, 'app/styles.css', 'background:#0d766e;color:#fff', 'background:#b91c1c;color:#fff');
    const drifted = await command(root, ['verify', '--manifest', manifest.id], 1);
    expect(drifted.visual.scenes.find(item => item.id === 'tasks.initial').tiers.tokens.reasons.join()).toMatch(/tasks\.add: sampled background differs/);
    await restore();

    const verification = await command(root, ['verify', '--manifest', manifest.id]);
    expect(verification.status).toBe('PASS');
    expect(verification.visual.platform).toBe('android');
    expect(verification.visual.regression).toBe('affected+smoke');
    expect(verification.visual.tiers.visual.policy).toBe('advisory');
    const scene = verification.visual.scenes.find(item => item.id === 'tasks.initial');
    expect(scene.tiers.tokens.sampled).toBeGreaterThan(0);
    expect(scene.tiers.visual.score).toBeGreaterThan(0.92);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unavailable device makes native verification NOT_RUN, never PASS', async () => {
  test.setTimeout(120000);
  const root = await project({ target: { id: 'android', platform: 'android', visual: undefined, driver: { kind: 'external', command: { argv: [process.execPath, 'native-driver.mjs'] } } } });
  try {
    await writeFile(path.join(root, 'native-driver.mjs'), FAKE_NATIVE_DRIVER.replace("process.env.FAKE_DRIVER_DEVICE === 'missing'", 'true'));
    const manifest = await command(root, ['checkpoint']);
    const verification = await command(root, ['verify', '--manifest', manifest.id], 2);
    expect(verification.status).toBe('NOT_RUN');
    expect(verification.visual.scenes[0].reason).toBe('no emulator attached');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a v1 mapping project migrates to anchors and passes anchored verification', async () => {
  test.setTimeout(180000);
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-migrate-e2e-'));
  let server;
  try {
    const example = path.join(engine, 'examples/modular');
    await cp(example, root, { recursive: true, filter: source => !/(\.protoflow|test-results|playwright-report|node_modules)/.test(path.relative(example, source)) });
    await symlink(path.join(engine, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
    server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PROTOFLOW_MODULAR_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('modular server did not start')), 10000);
      createInterface({ input: server.stdout }).on('line', line => { const match = line.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });

    const migration = await command(root, ['migrate', 'anchors']);
    expect(migration.manual).toEqual([]);
    expect(migration.lint.errors).toEqual([]);
    expect(migration.anchors.map(anchor => anchor.anchor)).toEqual(['chat.chat-panel', 'settings.settings-panel', 'chat.navigation-chat', 'settings.navigation-settings']);
    // Drafts are applied by people (prototype) and executors (application); here git apply stands in for both.
    for (const patch of ['prototype.patch', 'application.patch']) await exec('git', ['apply', `.protoflow/migration/${patch}`], { cwd: root });
    const draft = JSON.parse(await readFile(path.join(root, '.protoflow/migration/protoflow.config.v2.json'), 'utf8'));
    draft.targets[0].driver.urlTemplate = draft.targets[0].driver.urlTemplate.replace('http://127.0.0.1:4319', origin);
    await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(draft, null, 2));

    expect((await command(root, ['anchors', 'lint'])).status).toBe('PASS');
    const manifest = await command(root, ['checkpoint', '--summary', 'Anchored modular prototype']);
    expect(manifest.scope.affected).toEqual(['chat', 'settings']);
    const verification = await command(root, ['verify', '--manifest', manifest.id], 0, { PROTOFLOW_MODULAR_URL: origin });
    expect(verification.status).toBe('PASS');
    expect(verification.visual.scenes.map(scene => scene.id)).toEqual(['chat.initial', 'settings.initial']);
  } finally {
    if (server && server.exitCode === null) { const stopped = new Promise(resolve => server.once('close', resolve)); server.kill(); await stopped; }
    await rm(root, { recursive: true, force: true });
  }
});
