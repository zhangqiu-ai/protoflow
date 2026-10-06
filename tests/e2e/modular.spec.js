import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');

async function command(project, args, expectedCode = 0) {
  const env = { ...process.env, PROTOFLOW_MODULAR_URL: project.origin };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  let result;
  try {
    result = { ...(await exec(process.execPath, [cli, ...args, '--project', project.root], { cwd: project.root, env, maxBuffer: 8 * 1024 * 1024 })), code: 0 };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  const output = result.stdout?.trim() || result.stderr;
  let record;
  try { record = JSON.parse(output); } catch { throw new Error(`${args[0]} returned invalid JSON: ${output}`); }
  const diagnostic = { status: record.status, error: record.error, build: record.build, functional: record.functional, visual: record.visual && { status: record.visual.status, reason: record.visual.reason, scenes: record.visual.scenes.map(scene => ({ id: scene.id, reasons: scene.reasons })) } };
  expect(result.code, `${args[0]}\n${JSON.stringify(diagnostic, null, 2)}`).toBe(expectedCode);
  return record;
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-modular-e2e-'));
  let server;
  try {
    const example = path.join(engine, 'examples/modular');
    const generated = new Set(['.protoflow', 'test-results', 'playwright-report', '.agents']);
    await cp(example, root, { recursive: true, filter: source => !path.relative(example, source).split(path.sep).some(part => generated.has(part)) });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // Reuse dependencies while executing the example's actual runner unchanged.
    await symlink(path.join(engine, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PROTOFLOW_MODULAR_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    server.stderr.on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: server.stdout });
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Modular server did not become ready: ${stderr}`)), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Modular server exited ${code}: ${stderr}`)); });
      lines.on('line', line => {
        const match = line.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    lines.close();
    const configFile = path.join(root, 'protoflow.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.visual.scenes = config.visual.scenes.map(scene => ({
      ...scene,
      prototypeUrl: new URL(new URL(scene.prototypeUrl).pathname, origin).href,
      applicationUrl: new URL(new URL(scene.applicationUrl).pathname, origin).href,
    }));
    await writeFile(configFile, JSON.stringify(config, null, 2));
    return { root, origin, config, server };
  } catch (error) {
    if (server && server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('close', resolve));
      server.kill();
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function dispose(project) {
  if (project.server.exitCode === null) {
    const stopped = new Promise(resolve => project.server.once('close', resolve));
    project.server.kill();
    await stopped;
  }
  await rm(project.root, { recursive: true, force: true });
}

test('split prototype page styles select one application component and verify its independent implementation', async ({ page }, info) => {
  test.setTimeout(120000);
  const fixture = await project();
  try {
    // An initial full-project context must also cover entry points and shared assets.
    const initial = await command(fixture, ['checkpoint']);
    await command(fixture, ['context', '--manifest', initial.id, '--spec', 'specs/modular.md']);
    // The designer pushes the next version before the application has accepted the first one.
    const style = '\n#chat-panel.panel { border-radius: 24px; }\n';
    await appendFile(path.join(fixture.root, 'prototype/styles/chat.css'), style);
    const manifest = await command(fixture, ['checkpoint', '--summary', 'Chat panel corners']);
    expect(manifest.changes.map(change => change.path)).toEqual(['prototype/styles/chat.css']);
    expect(manifest.mappings).toEqual(['chat-panel']);
    expect((await command(fixture, ['context', '--manifest', manifest.id], 3)).queue.current.id).toBe(initial.id);
    // The http prototype is served from the initial version's frozen copy, not the newer live CSS.
    const initialVerified = await command(fixture, ['verify', '--manifest', initial.id]);
    expect(initialVerified.status).toBe('PASS');
    expect(initialVerified.visual.prototypeSource).toBe('version');
    const context = await command(fixture, ['context', '--manifest', manifest.id]);
    expect(context.mappings.map(mapping => mapping.component)).toEqual(['app/components/ChatPanel.js']);
    // Application styles are independent sources, updated only for the mapped page.
    const settingsBefore = await readFile(path.join(fixture.root, 'app/components/SettingsPanel.js'), 'utf8');
    await appendFile(path.join(fixture.root, 'app/styles/chat.css'), style);
    const verified = await command(fixture, ['verify', '--manifest', manifest.id]);
    expect(verified.status).toBe('PASS');
    expect(verified.functional.status).toBe('PASS');
    expect(verified.functional.stdout).toContain('passed');
    expect(verified.visual.scenes.every(scene => scene.status === 'PASS')).toBe(true);
    const chatEvidence = verified.visual.scenes.flatMap(scene => scene.mappings).find(mapping => mapping.id === 'chat-panel');
    expect(chatEvidence.prototype.styles['border-radius']).toBe('24px');
    expect(chatEvidence.application.styles['border-radius']).toBe('24px');
    expect(await readFile(path.join(fixture.root, 'app/components/SettingsPanel.js'), 'utf8')).toBe(settingsBefore);
    await page.goto(`${fixture.origin}/app/pages/chat.html`);
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await info.attach('modular-verification', { body: JSON.stringify(verified, null, 2), contentType: 'application/json' });
  } finally { await dispose(fixture); }
});

test('shared design tokens affect both pages and verification rejects missing page coverage', async () => {
  test.setTimeout(120000);
  const fixture = await project();
  try {
    const initial = await command(fixture, ['checkpoint']);
    expect((await command(fixture, ['verify', '--manifest', initial.id])).status).toBe('PASS');
    const style = '\n:root { --accent: #7e22ce; }\n';
    await appendFile(path.join(fixture.root, 'prototype/styles/tokens.css'), style);
    const manifest = await command(fixture, ['checkpoint', '--summary', 'Shared design token']);
    expect([...manifest.mappings].sort()).toEqual(['chat-panel', 'navigation-chat', 'navigation-settings', 'settings-panel']);
    const context = await command(fixture, ['context', '--manifest', manifest.id]);
    expect(new Set(context.mappings.map(mapping => mapping.component)).size).toBe(3);
    await appendFile(path.join(fixture.root, 'app/styles/tokens.css'), style);
    // Keep the settings panel in the changed scope but omit it from acceptance scenes.
    fixture.config.visual.scenes = fixture.config.visual.scenes.filter(scene => !scene.mappings.includes('settings-panel'));
    await writeFile(path.join(fixture.root, 'protoflow.config.json'), JSON.stringify(fixture.config, null, 2));
    const verified = await command(fixture, ['verify', '--manifest', manifest.id], 1);
    expect(verified.functional.status).toBe('PASS');
    expect(verified.visual.scenes.every(scene => scene.status === 'PASS')).toBe(true);
    expect(verified.visual.reason).toContain('lack visual coverage');
    expect(verified.visual.reason).toContain('settings-panel');
    expect(verified.status).toBe('FAIL');
  } finally { await dispose(fixture); }
});
