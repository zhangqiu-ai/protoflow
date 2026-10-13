import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCliOutput } from '../helpers/cli-json.js';

/*
 * Real iOS Simulator acceptance of the reference driver (scripts/ios-driver.js) on examples/mobile.
 * Opt-in: needs macOS, Xcode and a simulator named by PROTOFLOW_IOS_DEVICE (e.g. "ProtoFlow iPhone 17").
 * PROTOFLOW_IOS_RN=1 also verifies the React Native target (needs `npm install` and `pod install` in
 * examples/mobile/react-native first).
 */
const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');
const device = process.env.PROTOFLOW_IOS_DEVICE;

async function command(root, args, expectedCode = 0) {
  let result;
  try { result = { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, maxBuffer: 64 * 1024 * 1024 })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const json = parseCliOutput(result.stdout, result.stderr);
  const scenes = json.visual?.scenes?.map(scene => `${scene.id}:${scene.status} ${scene.reason ?? ''} ${JSON.stringify(Object.fromEntries(Object.entries(scene.tiers).map(([tier, value]) => [tier, value.reasons?.slice(0, 3)])))}`);
  expect(result.code, `${args.join(' ')}\n${json.error ?? json.visual?.reason ?? json.build?.stderr?.slice(-800) ?? ''}\n${scenes?.join('\n') ?? ''}`).toBe(expectedCode);
  return json;
}

/** Copy examples/mobile with absolute driver paths; the built apps and runner cache stay out of the copy. */
async function project(targets) {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-ios-e2e-'));
  const example = path.join(engine, 'examples/mobile');
  await cp(example, root, { recursive: true, filter: source => !/(\.protoflow|\/build\/|node_modules|Pods)/.test(path.relative(example, source) + '/') });
  if (targets.includes('react-native')) {
    // Reuse the installed JS dependencies and pods of the example instead of reinstalling them.
    await symlink(path.join(example, 'react-native/node_modules'), path.join(root, 'react-native/node_modules'), 'dir');
    await symlink(path.join(example, 'react-native/ios/Pods'), path.join(root, 'react-native/ios/Pods'), 'dir');
  }
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.targets = config.targets.filter(target => targets.includes(target.id)).map(target => {
    const swap = value => value === '../../scripts/ios-driver.js' ? path.join(engine, 'scripts/ios-driver.js') : value.replace('ProtoFlow iPhone 17', device);
    const argv = target.driver.command.argv.map(swap);
    return {
      ...target,
      driver: { ...target.driver, command: { ...target.driver.command, argv: [...argv, '--cache', path.join(engine, '.protoflow/cache/ios-driver')] } },
      functional: target.functional && { ...target.functional, argv: target.functional.argv.map(swap) }
    };
  });
  if (config.release) config.release.requireTargets = config.release.requireTargets.filter(id => targets.includes(id));
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return root;
}
const edit = async (root, file, from, to) => {
  const target = path.join(root, file);
  const content = await readFile(target, 'utf8');
  if (!content.includes(from)) throw new Error(`${file} lacks ${from}`);
  await writeFile(target, content.replace(from, to));
};

test.describe('iOS reference driver', () => {
  test.skip(process.platform !== 'darwin' || !device, 'set PROTOFLOW_IOS_DEVICE to a simulator name on macOS');

  test('SwiftUI target passes T1–T3 on a real simulator and catches structural drift', async () => {
    test.setTimeout(3600000);
    const root = await project(['ios']);
    try {
      const manifest = await command(root, ['checkpoint', '--summary', 'mobile v1']);
      expect(manifest.scope.affected).toEqual(['settings', 'tasks']);
      // Drift first (an accepted version cannot be verified again): a renamed button is a structural difference.
      await edit(root, 'ios/ProtoFlowTasks/TasksScreen.swift', 'PrimaryButton(title: "Add"', 'PrimaryButton(title: "Plus"');
      const drifted = await command(root, ['verify', '--manifest', manifest.id], 1);
      expect(drifted.visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.structure.reasons).toContain('tasks.add: text "Add" vs "Plus"');
      await edit(root, 'ios/ProtoFlowTasks/TasksScreen.swift', 'PrimaryButton(title: "Plus"', 'PrimaryButton(title: "Add"');

      const verification = await command(root, ['verify', '--manifest', manifest.id]);
      expect(verification.visual.platform).toBe('ios');
      expect(verification.visual.regression).toBe('affected+smoke');
      expect(verification.visual.tiers.visual.policy).toBe('advisory');
      expect(verification.visual.scenes.map(scene => scene.id).sort()).toEqual(['settings.initial', 'settings.saved', 'tasks.added', 'tasks.empty-error', 'tasks.initial']);
      for (const tier of ['structure', 'tokens', 'layout']) expect(verification.visual.tiers[tier].status).toBe('PASS');
      expect(verification.visual.scenes.find(scene => scene.id === 'tasks.added').tiers.tokens.sampled).toBeGreaterThan(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('React Native target passes T1–T3 through the same driver', async () => {
    test.skip(!process.env.PROTOFLOW_IOS_RN, 'set PROTOFLOW_IOS_RN=1 after installing the React Native example');
    test.setTimeout(3600000);
    const root = await project(['react-native']);
    try {
      const manifest = await command(root, ['checkpoint', '--summary', 'mobile v1']);
      const verification = await command(root, ['verify', '--manifest', manifest.id]);
      expect(verification.visual.platform).toBe('react-native');
      for (const tier of ['structure', 'tokens', 'layout']) expect(verification.visual.tiers[tier].status).toBe('PASS');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
