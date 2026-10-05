import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject, installSkill } from '../src/install.js';
import { loadConfig } from '../src/config.js';

test('init preserves user configuration, AGENTS content, and uses existing prototype location', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-init-'));
  const original = '{"schemaVersion":1,"prototypeDir":"design/mockups","userOption":true}\n';
  await writeFile(path.join(root, 'protoflow.config.json'), original);
  await writeFile(path.join(root, 'AGENTS.md'), '# User rules\nDo not delete my data.');
  const first = await initProject(root);
  assert.equal(await readFile(first.configPath, 'utf8'), original);
  const agents = await readFile(first.agentsPath, 'utf8');
  assert.ok(agents.startsWith('# User rules\nDo not delete my data.\n\n'));
  assert.ok(first.created.includes(path.join(await realpath(root), 'design/mockups')));
  const second = await initProject(root);
  assert.equal(await readFile(first.agentsPath, 'utf8'), agents);
  assert.equal(second.created.length, 0);
});

test('init creates usable defaults and rejects paths outside project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-init-'));
  const result = await initProject(root);
  const config = JSON.parse(await readFile(result.configPath, 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.prototypeDir, 'prototype');
  assert.deepEqual(config.mappings, []);
  assert.equal(config.adapters.codex.command, null);
  assert.equal(config.policy.maxRepairAttempts, 3);
  await assert.rejects(initProject(root, { prototypeDir: '../outside' }), /inside the project/);
  await assert.rejects(initProject(root, { prototypeDir: '/tmp/outside' }), /relative project path/);
});

test('local skill install contains instructions only and preserves an existing destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-install-'));
  const first = await installSkill(root);
  assert.equal(first.installed.length, 1);
  assert.ok((await readFile(path.join(first.skillDir, 'SKILL.md'), 'utf8')).includes('name: protoflow'));
  assert.deepEqual((await readdir(first.skillDir)).sort(), ['SKILL.md', 'references']);
  await writeFile(path.join(first.skillDir, 'user-note.txt'), 'keep');
  const second = await installSkill(root);
  assert.equal(second.installed.length, 0);
  assert.deepEqual(second.skipped, [first.skillDir]);
  assert.equal(await readFile(path.join(first.skillDir, 'user-note.txt'), 'utf8'), 'keep');
});

test('personal install uses the source-of-truth directory and a per-skill discovery symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-personal-'));
  const sourceDir = path.join(root, 'source');
  const discoveryDir = path.join(root, 'discover');
  await mkdir(discoveryDir);
  await writeFile(path.join(discoveryDir, 'other-skill'), 'unrelated');
  const first = await installSkill(root, { personal: true, sourceDir, discoveryDir });
  assert.equal(first.installed.length, 2);
  assert.equal(await readlink(path.join(discoveryDir, 'protoflow')), path.join(sourceDir, 'protoflow'));
  assert.equal(await readFile(path.join(discoveryDir, 'other-skill'), 'utf8'), 'unrelated');
  const second = await installSkill(root, { personal: true, sourceDir, discoveryDir });
  assert.equal(second.installed.length, 0);
  assert.equal(second.skipped.length, 2);
});

test('personal install preserves dangling symlinks at source and discovery destinations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-links-'));
  const sourceDir = path.join(root, 'source');
  const discoveryDir = path.join(root, 'discover');
  await mkdir(sourceDir);
  await mkdir(discoveryDir);
  await symlink(path.join(root, 'missing-source'), path.join(sourceDir, 'protoflow'));
  await symlink(path.join(root, 'missing-discovery'), path.join(discoveryDir, 'protoflow'));
  const result = await installSkill(root, { personal: true, sourceDir, discoveryDir });
  assert.equal(result.installed.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(await readlink(path.join(sourceDir, 'protoflow')), path.join(root, 'missing-source'));
  assert.equal(await readlink(path.join(discoveryDir, 'protoflow')), path.join(root, 'missing-discovery'));
});

test('init rejects escaping configuration and AGENTS symlinks without changing external files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-init-links-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'protoflow-outside-'));
  const externalAgents = path.join(outside, 'AGENTS.md');
  await writeFile(externalAgents, 'private rules\n');
  await symlink(externalAgents, path.join(root, 'AGENTS.md'));
  await assert.rejects(initProject(root), /Symlink escapes project/);
  assert.equal(await readFile(externalAgents, 'utf8'), 'private rules\n');
  const second = await mkdtemp(path.join(os.tmpdir(), 'protoflow-config-links-'));
  const externalConfig = path.join(outside, 'config.json');
  const original = '{"prototypeDir":"prototype"}\n';
  await writeFile(externalConfig, original);
  await symlink(externalConfig, path.join(second, 'protoflow.config.json'));
  await assert.rejects(initProject(second), /Symlink escapes project/);
  assert.equal(await readFile(externalConfig, 'utf8'), original);
});

test('init and local install reject escaping parent directory symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-parent-links-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'protoflow-outside-'));
  await symlink(outside, path.join(root, 'design'));
  await assert.rejects(initProject(root, { prototypeDir: 'design/mockups' }), /Symlink escapes project/);
  assert.deepEqual(await readdir(outside), []);
  await symlink(outside, path.join(root, '.agents'));
  await assert.rejects(installSkill(root), /Symlink escapes project/);
  assert.deepEqual(await readdir(outside), []);
});

test('initial and example template configurations are accepted by the actual engine schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-template-'));
  await initProject(root);
  assert.equal((await loadConfig(root)).schemaVersion, 1);
  const template = await readFile(new URL('../templates/protoflow.config.json', import.meta.url), 'utf8');
  await writeFile(path.join(root, 'protoflow.config.json'), template);
  const configured = await loadConfig(root);
  assert.equal(configured.mappings[0].component, 'src/Home.tsx');
  assert.equal(configured.mappings[0].priority, 'normal');
});

test('init rejects an unresolved AGENTS symlink without creating its external target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-dangling-agents-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'protoflow-outside-'));
  const externalAgents = path.join(outside, 'missing-AGENTS.md');
  await symlink(externalAgents, path.join(root, 'AGENTS.md'));
  await assert.rejects(initProject(root));
  assert.deepEqual(await readdir(outside), []);
});
