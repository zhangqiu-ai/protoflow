import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCliOutput } from '../helpers/cli-json.js';

/*
 * Real emulator acceptance of the Android reference driver (scripts/android-driver.js) on examples/mobile.
 * Opt-in: needs JAVA_HOME (JDK 17), ANDROID_HOME and an AVD named by PROTOFLOW_ANDROID_AVD (e.g. ProtoFlow_Pixel,
 * 480 dpi, hardware keyboard). PROTOFLOW_FLUTTER=1 also verifies the Flutter target on its ios and android variants
 * (needs flutter on PATH and PROTOFLOW_IOS_DEVICE).
 */
const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');
const avd = process.env.PROTOFLOW_ANDROID_AVD;

async function command(root, args, expectedCode = 0) {
  let result;
  try { result = { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, maxBuffer: 64 * 1024 * 1024 })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const json = parseCliOutput(result.stdout, result.stderr);
  const scenes = json.visual?.scenes?.map(scene => `${scene.variant ?? ''} ${scene.id}:${scene.status} ${scene.reason ?? ''} ${JSON.stringify(Object.fromEntries(Object.entries(scene.tiers).map(([tier, value]) => [tier, value.reasons?.slice(0, 3)])))}`);
  expect(result.code, `${args.join(' ')}\n${json.error ?? json.visual?.reason ?? json.build?.stderr?.slice(-800) ?? ''}\n${scenes?.join('\n') ?? ''}`).toBe(expectedCode);
  return json;
}

/** Copy examples/mobile with absolute driver paths and the given targets; build output and caches stay out. */
async function project(targets) {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-android-e2e-'));
  const example = path.join(engine, 'examples/mobile');
  // Whole directory names only: "/.gradle" must not match build.gradle.kts.
  await cp(example, root, { recursive: true, filter: source => !/\/(\.protoflow|DerivedData|node_modules|Pods|build|\.gradle|\.dart_tool)(\/|$)/.test(`/${path.relative(example, source)}`) });
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const swap = value => value.replace(/^\.\.\/\.\.\/scripts\//, `${engine}/scripts/`).replace('ProtoFlow_Pixel', avd).replace('ProtoFlow iPhone 17', process.env.PROTOFLOW_IOS_DEVICE ?? 'ProtoFlow iPhone 17');
  const withCache = driver => ({ ...driver, command: { ...driver.command, argv: [...driver.command.argv.map(swap), '--cache', path.join(engine, `.protoflow/cache/${driver.command.argv.some(arg => arg.endsWith('android-driver.js')) ? 'android' : 'ios'}-driver`)] } });
  config.targets = config.targets.filter(target => targets.includes(target.id)).map(target => target.variants
    ? { ...target, variants: target.variants.map(variant => ({ ...variant, driver: withCache(variant.driver) })) }
    : { ...target, driver: withCache(target.driver) });
  config.release = { requireTargets: targets };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  // A real project is a Git checkout: its .gitignore keeps build output (Gradle, Flutter, codegen) out of evidence.
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-qm', 'example']]) await exec('git', args, { cwd: root });
  return root;
}
const edit = async (root, file, from, to) => {
  const target = path.join(root, file);
  const content = await readFile(target, 'utf8');
  if (!content.includes(from)) throw new Error(`${file} lacks ${from}`);
  await writeFile(target, content.replace(from, to));
};

test.describe('Android reference driver', () => {
  test.skip(!avd || !process.env.JAVA_HOME || !process.env.ANDROID_HOME, 'set PROTOFLOW_ANDROID_AVD, JAVA_HOME and ANDROID_HOME');

  test('Compose target passes T1–T3 on a real emulator and catches structural drift', async () => {
    test.setTimeout(3600000);
    const root = await project(['android']);
    try {
      const manifest = await command(root, ['checkpoint', '--summary', 'mobile v1']);
      // Drift first (an accepted version cannot be verified again): a renamed button is a structural difference.
      await edit(root, 'android/app/src/main/java/dev/protoflow/examples/tasks/TasksApp.kt', 'PrimaryButton("tasks.add", "Add"', 'PrimaryButton("tasks.add", "Plus"');
      const drifted = await command(root, ['verify', '--manifest', manifest.id, '--target', 'android'], 1);
      expect(drifted.visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.structure.reasons).toContain('tasks.add: text "Add" vs "Plus"');
      await edit(root, 'android/app/src/main/java/dev/protoflow/examples/tasks/TasksApp.kt', 'PrimaryButton("tasks.add", "Plus"', 'PrimaryButton("tasks.add", "Add"');

      const verification = await command(root, ['verify', '--manifest', manifest.id, '--target', 'android']);
      expect(verification.visual.platform).toBe('android');
      expect(verification.functional.status).toBe('PASS');
      for (const tier of ['structure', 'tokens', 'layout']) expect(verification.visual.tiers[tier].status).toBe('PASS');
      expect(verification.visual.scenes.find(scene => scene.id === 'settings.initial').deviations).toEqual([{ anchor: 'settings.notify-toggle', allow: ['layout'] }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('Flutter target passes on its ios and android variants', async () => {
    test.skip(!process.env.PROTOFLOW_FLUTTER || process.platform !== 'darwin', 'set PROTOFLOW_FLUTTER=1 (macOS, flutter on PATH)');
    test.setTimeout(3600000);
    const root = await project(['flutter']);
    try {
      const manifest = await command(root, ['checkpoint', '--summary', 'mobile v1']);
      const verification = await command(root, ['verify', '--manifest', manifest.id, '--target', 'flutter']);
      expect(Object.fromEntries(Object.entries(verification.visual.variants).map(([id, variant]) => [id, variant.status]))).toEqual({ ios: 'PASS', android: 'PASS' });
      expect(Object.keys(verification.build.variants)).toEqual(['ios', 'android']);
      expect(new Set(verification.visual.scenes.map(scene => scene.variant))).toEqual(new Set(['ios', 'android']));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
