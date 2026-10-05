import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');
const playwrightCLI = path.join(engine, 'node_modules/@playwright/test/cli.js');
const playwrightImport = pathToFileURL(path.join(engine, 'node_modules/@playwright/test/index.mjs')).href;

async function command(root, args, expectedCode = 0) {
  let result;
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  try { result = { ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, env, maxBuffer: 8 * 1024 * 1024 })), code: 0 }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  expect(result.code, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(expectedCode);
  return JSON.parse(expectedCode === 1 && !result.stdout.trim() ? result.stderr : result.stdout);
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-e2e-'));
  const demo = path.join(engine, 'examples/demo');
  const generated = new Set(['.protoflow', 'test-results', 'playwright-report', '.agents']);
  await cp(demo, root, { recursive: true, filter: source => !path.relative(demo, source).split(path.sep).some(part => generated.has(part)) });
  const config = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
  config.visual.scenes = config.visual.scenes.map((scene) => ({ ...scene, prototypeUrl: 'prototype/index.html', applicationUrl: 'app/index.html' }));
  config.policy = { maxRepairAttempts: 2, requireHumanReview: true };
  config.verification = {
    build: { argv: [process.execPath, 'build-check.cjs'] },
    functional: { argv: [process.execPath, playwrightCLI, 'test', '--config', 'acceptance.config.mjs'] },
  };
  config.adapters = { codex: { command: { argv: [process.execPath, 'repair-adapter.cjs'] } } };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config, null, 2));
  await writeFile(path.join(root, 'spec.md'), '# Reviewed initial specification\nThe session form must create a named design session and announce its confirmation.\n');
  await writeFile(path.join(root, 'build-check.cjs'), `const fs=require('node:fs');const vm=require('node:vm');for(const file of ['prototype/index.html','app/index.html']){const html=fs.readFileSync(file,'utf8');if(!html.toLowerCase().startsWith('<!doctype html>'))throw new Error('Missing document');for(const match of html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g))new vm.Script(match[1]);}console.log('Static documents and browser scripts valid');\n`);
  await writeFile(path.join(root, 'acceptance.config.mjs'), `import {defineConfig} from ${JSON.stringify(playwrightImport)};export default defineConfig({testDir:'.',testMatch:'acceptance.spec.mjs',workers:1,reporter:'list',outputDir:'test-results',use:{headless:true,trace:'retain-on-failure'}});\n`);
  await writeFile(path.join(root, 'acceptance.spec.mjs'), `import {test,expect} from ${JSON.stringify(playwrightImport)};import {pathToFileURL} from 'node:url';import path from 'node:path';test('application creates a named session',async({page})=>{await page.goto(pathToFileURL(path.resolve('app/index.html')).href);await page.getByLabel('Session name').fill('Accepted session');await page.getByRole('button',{name:'Create session'}).click();await expect(page.getByText('Session created: Accepted session')).toBeVisible();});\n`);
  await writeFile(path.join(root, 'repair-adapter.cjs'), `const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const context=JSON.parse(input);if(context.kind!=='repair'||!context.repair.verification)throw new Error('Missing repair evidence');const file='app/index.html';const before=fs.readFileSync(file,'utf8');fs.writeFileSync(file,before.replace('main{max-width:560px','main{max-width:640px'));console.log(JSON.stringify({status:'done',evidence:'Restored the mapped card width from the prototype'}));});\n`);
  return root;
}

test('actual CLI verifies, binds a human review, records a baseline and rejects stale evidence', async ({ page }, info) => {
  test.setTimeout(120000);
  const root = await project();
  try {
    const checkpoint = await command(root, ['checkpoint', '--summary', 'Initial demo']);
    expect(checkpoint.mappings).toContain('card');
    const planningPath = path.join(root, '.protoflow/review-spec.md');
    const planning = await readFile(path.join(root, 'spec.md'), 'utf8');
    await writeFile(planningPath, planning);
    await command(root, ['context', '--manifest', checkpoint.id, '--spec', '.protoflow/review-spec.md']);
    const verified = await command(root, ['verify', '--manifest', checkpoint.id]);
    expect(verified.status).toBe('PASS');
    expect(verified.functional.stdout).toContain('1 passed');
    await page.goto(pathToFileURL(verified.visual.artifacts.at(-1)).href);
    await expect(page.getByRole('heading', { name: 'ProtoFlow visual review' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /create-session — PASS/ })).toBeVisible();
    const review = await command(root, ['review', 'create', '--manifest', checkpoint.id, '--verification', verified.id]);
    await writeFile(planningPath, 'A different specification');
    const stalePlanning = await command(root, ['review', 'approve', '--review', review.id, '--reviewer', 'E2E reviewer'], 1);
    expect(stalePlanning.error).toContain('Planning evidence changed');
    await writeFile(planningPath, planning);
    const appFile = path.join(root, 'app/index.html');
    const original = await readFile(appFile, 'utf8');
    await writeFile(appFile, original.replace('ProtoFlow application', 'Changed application'));
    const staleReview = await command(root, ['review', 'approve', '--review', review.id, '--reviewer', 'E2E reviewer'], 1);
    expect(staleReview.error).toContain('Project changed since verification');
    await writeFile(appFile, original);
    const approved = await command(root, ['review', 'approve', '--review', review.id, '--reviewer', 'E2E reviewer']);
    expect(approved.status).toBe('approved');
    const baseline = await command(root, ['baseline', 'create', '--review', review.id]);
    expect(baseline.reviewId).toBe(review.id);
    expect(baseline.evidence.visual).toBe('PASS');
    expect(baseline.spec.path).toBe('.protoflow/review-spec.md');
    const show = await command(root, ['baseline', 'show']);
    expect(show.id).toBe(baseline.id);
    const repeated = await command(root, ['baseline', 'create', '--review', review.id]);
    expect(repeated.id).toBe(baseline.id);
    await writeFile(appFile, `${original}\n<!-- Later app edit -->\n`);
    const staleBaseline = await command(root, ['baseline', 'create', '--review', review.id], 1);
    expect(staleBaseline.error).toContain('Project changed since verification');
    await info.attach('approved-baseline', { body: JSON.stringify(baseline, null, 2), contentType: 'application/json' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured repair consumes failed visual evidence and reruns real acceptance to PASS', async ({ page }, info) => {
  test.setTimeout(120000);
  const root = await project();
  try {
    const checkpoint = await command(root, ['checkpoint']);
    const appFile = path.join(root, 'app/index.html');
    const original = await readFile(appFile, 'utf8');
    await writeFile(appFile, original.replace('main{max-width:640px', 'main{max-width:560px'));
    const repair = await command(root, ['repair', '--manifest', checkpoint.id, '--execute', '--spec', 'spec.md']);
    expect(repair.status).toBe('READY_FOR_REVIEW');
    expect(repair.executions).toHaveLength(1);
    expect(repair.reports).toHaveLength(2);
    const initial = JSON.parse(await readFile(path.join(root, '.protoflow/verifications', `${repair.reports[0]}.json`), 'utf8'));
    const final = JSON.parse(await readFile(path.join(root, '.protoflow/verifications', `${repair.reports[1]}.json`), 'utf8'));
    expect(initial.status).toBe('FAIL');
    expect(initial.visual.scenes[0].mappings[0].reasons.join(' ')).toContain('Geometry width');
    expect(final.status).toBe('PASS');
    expect(final.functional.stdout).toContain('1 passed');
    await page.goto(pathToFileURL(appFile).href);
    await page.getByLabel('Session name').fill('Repaired session');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByText('Session created: Repaired session')).toBeVisible();
    const pending = JSON.parse(await readFile(path.join(root, '.protoflow/reviews', `${repair.reviewId}.json`), 'utf8'));
    expect(pending.status).toBe('pending');
    await info.attach('bounded-repair', { body: JSON.stringify(repair, null, 2), contentType: 'application/json' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsuccessful adapter stops at the configured repair bound and leaves human review pending', async ({ page }) => {
  test.setTimeout(120000);
  const root = await project();
  try {
    const checkpoint = await command(root, ['checkpoint']);
    const appFile = path.join(root, 'app/index.html');
    const original = await readFile(appFile, 'utf8');
    await writeFile(appFile, original.replace('main{max-width:640px', 'main{max-width:560px'));
    await writeFile(path.join(root, 'repair-adapter.cjs'), "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({status:'done',evidence:'No change'})));\n");
    const repair = await command(root, ['repair', '--manifest', checkpoint.id, '--execute', '--spec', 'spec.md'], 2);
    expect(repair.status).toBe('NEEDS_REVIEW');
    expect(repair.executions).toHaveLength(2);
    expect(repair.reports).toHaveLength(3);
    await page.goto(pathToFileURL(appFile).href);
    await expect(page.getByRole('heading', { name: 'Create a design session' })).toBeVisible();
    const pending = JSON.parse(await readFile(path.join(root, '.protoflow/reviews', `${repair.reviewId}.json`), 'utf8'));
    expect(pending.status).toBe('pending');
    const approval = await command(root, ['review', 'approve', '--review', pending.id, '--reviewer', 'E2E reviewer'], 1);
    expect(approval.error).toContain('requires PASS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects visually passing scenes that do not cover every changed mapping', async () => {
  const root = await project();
  try {
    const configFile = path.join(root, 'protoflow.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.visual.scenes = config.visual.scenes.map((scene) => ({ ...scene, mappings: ['heading'] }));
    await writeFile(configFile, JSON.stringify(config, null, 2));
    const checkpoint = await command(root, ['checkpoint']);
    expect(checkpoint.mappings).toContain('card');
    const verified = await command(root, ['verify', '--manifest', checkpoint.id], 1);
    expect(verified.visual.scenes.every((scene) => scene.status === 'PASS')).toBe(true);
    expect(verified.visual.reason).toContain('lack visual coverage: card');
    expect(verified.status).toBe('FAIL');
    expect(JSON.stringify(verified)).toContain('card');
  } finally { await rm(root, { recursive: true, force: true }); }
});
