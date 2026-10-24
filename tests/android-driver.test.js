import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { anchorFromResource, resourceFromAnchor, nodeType, normalizeCapture, androidResponse, restoreScrolled } from '../src/drivers/android-tree.js';

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const node = (fields, children) => ({ enabled: true, visible: true, ...fields, ...(children && { children }) });

// A Compose tasks screen at density 3 on a 1080×2400 px display; status bar 72 px, gesture bar 63 px.
const raw = {
  status: 'PASS', density: 3, screen: { width: 1080, height: 2400 }, insets: { left: 0, top: 72, right: 0, bottom: 63 }, keyboardVisible: false,
  tree: node({ className: 'android.widget.FrameLayout', bounds: box(0, 0, 1080, 2400) }, [
    node({ className: 'android.view.View', resourceId: 'tasks', bounds: box(0, 72, 1080, 2337) }, [
      node({ className: 'android.view.View', resourceId: 'tasks.header', bounds: box(60, 120, 1020, 252) }, [
        node({ className: 'android.widget.TextView', resourceId: 'tasks.title', text: 'Today', bounds: box(60, 135, 297, 237) }),
        node({ className: 'android.widget.Button', resourceId: 'tasks.settings', text: 'Settings', clickable: true, bounds: box(831, 156, 1020, 216) })
      ]),
      node({ className: 'android.view.View', resourceId: 'tasks.list', bounds: box(60, 300, 1020, 612) }, [
        node({ className: 'android.widget.TextView', resourceId: 'tasks.item', text: 'Review prototype', bounds: box(60, 300, 1020, 444) }),
        node({ className: 'android.widget.TextView', resourceId: 'tasks.item', text: 'Ship version', bounds: box(60, 468, 1020, 612) })
      ]),
      node({ className: 'android.view.View', resourceId: 'tasks.form', bounds: box(60, 660, 1020, 792) }, [
        node({ className: 'android.widget.EditText', resourceId: 'tasks.input', text: 'New task', hint: 'New task', showingHint: true, editable: true, bounds: box(60, 660, 897, 792) }),
        node({ className: 'android.widget.Button', resourceId: 'tasks.add', text: 'Add', clickable: true, bounds: box(927, 660, 1020, 792) })
      ]),
      node({ className: 'android.widget.TextView', resourceId: 'tasks.error', text: 'Enter a task first.', visible: false, bounds: box(60, 828, 400, 873) })
    ])
  ])
};
const anchors = ['tasks', 'tasks.header', 'tasks.title', 'tasks.settings', 'tasks.list', 'tasks.item', 'tasks.form', 'tasks.input', 'tasks.add', 'tasks.error', 'tasks.missing'];
const screenshot = () => PNG.sync.write(new PNG({ width: 1080, height: 2400 }));

test('resource ids map to anchors for Compose, React Native, Flutter and view-based apps', () => {
  assert.equal(anchorFromResource('tasks.add'), 'tasks.add');
  assert.equal(anchorFromResource('dev.example:id/tasks__add'), 'tasks.add');
  assert.equal(anchorFromResource('dev.example:id/settings__notify_toggle'), 'settings.notify-toggle');
  assert.equal(anchorFromResource('settings.notify-toggle'), 'settings.notify-toggle');
  assert.equal(anchorFromResource('tasks'), 'tasks');
  assert.equal(anchorFromResource(''), null);
  for (const anchor of ['tasks', 'tasks.add', 'settings.notify-toggle', 'a.b-c.d']) assert.equal(anchorFromResource(`pkg:id/${resourceFromAnchor(anchor)}`), anchor);
});

test('Android classes and flags map to the shared element types', () => {
  assert.equal(nodeType({ className: 'android.widget.EditText' }), 'textField');
  assert.equal(nodeType({ className: 'android.widget.EditText', password: true }), 'secureTextField');
  assert.equal(nodeType({ className: 'android.view.View', editable: true }), 'textField');
  assert.equal(nodeType({ className: 'android.widget.Switch', checkable: true }), 'switch');
  assert.equal(nodeType({ className: 'androidx.appcompat.widget.SwitchCompat', checkable: true }), 'switch');
  assert.equal(nodeType({ className: 'android.widget.CheckBox', checkable: true }), 'checkBox');
  assert.equal(nodeType({ className: 'android.widget.RadioButton', checkable: true }), 'radioButton');
  assert.equal(nodeType({ className: 'android.widget.Button', checkable: true, contentDescription: 'I agree' }), 'button');
  assert.equal(nodeType({ className: 'android.widget.ToggleButton', checkable: true }), 'button');
  assert.equal(nodeType({ className: 'android.view.ViewGroup', checkable: true }), 'checkBox');
  assert.equal(nodeType({ className: 'android.widget.SeekBar' }), 'slider');
  assert.equal(nodeType({ className: 'android.widget.Button', text: 'Add' }), 'button');
  assert.equal(nodeType({ className: 'android.view.View', clickable: true, contentDescription: 'Back' }), 'button');
  // A clickable container holding only text is one action (Compose Box/Row with clickable, React Native Pressable).
  assert.equal(nodeType({ className: 'android.view.View', clickable: true, children: [{ className: 'android.widget.TextView', text: 'Add' }] }), 'button');
  assert.equal(nodeType({ className: 'android.view.View', clickable: true, children: [{ className: 'android.widget.EditText', editable: true }] }), 'other');
  assert.equal(nodeType({ className: 'android.widget.TextView', text: 'Today' }), 'staticText');
  assert.equal(nodeType({ className: 'android.widget.ImageView' }), 'image');
  assert.equal(nodeType({ className: 'android.view.View' }), 'other');
});

test('a UiAutomator capture becomes protocol facts in dp relative to the content area', () => {
  const { response, png } = androidResponse(raw, screenshot(), { anchors, screen: 'tasks' });
  assert.equal(response.status, 'PASS');
  assert.deepEqual(response.viewport, { width: 360, height: 755, scale: 3 });
  assert.deepEqual([PNG.sync.read(png).width, PNG.sync.read(png).height], [1080, 2265]);
  const facts = Object.fromEntries(response.elements.map(item => [item.anchor, item]));
  assert.deepEqual(response.missing, ['tasks.missing']);
  assert.deepEqual(facts.tasks.bounds, { x: 0, y: 0, width: 360, height: 755 });
  assert.deepEqual(facts['tasks.header'].bounds, { x: 20, y: 16, width: 320, height: 44 });
  assert.equal(facts.tasks.text, 'Today Settings Review prototype Ship version Add');
  assert.equal(facts['tasks.header'].text, 'Today Settings');
  assert.equal(facts['tasks.form'].text, 'Add');
  assert.equal(facts['tasks.item'].count, 2);
  // A field showing its hint reports the placeholder, like the web inspector.
  assert.deepEqual([facts['tasks.input'].text, facts['tasks.input'].editable, facts['tasks.input'].inputType], ['New task', true, 'text']);
  assert.equal(facts['tasks.add'].interactive, true);
  // Present in the tree but not visible to the user.
  assert.deepEqual([facts['tasks.error'].count, facts['tasks.error'].visible], [1, false]);
});

test('content a scroll view has scrolled out of sight keeps its own size and counts as rendered', () => {
  // A React Native goal screen as UiAutomator reports it: below the scroll view's bottom edge (2328 px) a node keeps its
  // true top but its bottom is clamped, it is not visible to the user, and only boundsInParent keeps its size.
  const scroll = node({ className: 'android.widget.ScrollView', scrollable: true, bounds: box(0, 298, 1080, 2328), size: { width: 1080, height: 2030 } }, [
    node({ className: 'android.view.ViewGroup', resourceId: 'goal.title', text: 'Run 10K', bounds: box(0, 298, 1080, 400), size: { width: 1080, height: 150 }, visible: true }),
    node({ className: 'android.view.ViewGroup', resourceId: 'goal.chart', bounds: box(48, 1969, 1032, 2328), size: { width: 984, height: 432 } }),
    node({ className: 'android.widget.Button', resourceId: 'goal.discuss', text: 'Discuss with AI', clickable: true, visible: false, bounds: box(174, 2678, 547, 2328), size: { width: 373, height: 108 } }),
    node({ className: 'android.widget.TextView', resourceId: 'goal.hint', text: 'Saved', visible: false, bounds: box(60, 600, 400, 660), size: { width: 340, height: 60 } }),
    // Clamped to the scroll view's 18 px top padding rather than its edge: still the top, so the true bottom is kept.
    node({ className: 'android.view.ViewGroup', resourceId: 'goal.segments', bounds: box(48, 316, 1032, 454), size: { width: 984, height: 156 } }),
    // A horizontal row below the fold: the row and its items are clipped by the outer scroll view's bottom edge.
    node({ className: 'android.widget.HorizontalScrollView', scrollable: true, visible: false, bounds: box(48, 2900, 1032, 2328), size: { width: 984, height: 360 } }, [
      node({ className: 'android.widget.Button', resourceId: 'goal.recent', text: 'Ordering cards', clickable: true, visible: false, bounds: box(48, 2900, 528, 2328), size: { width: 480, height: 360 } })
    ])
  ]);
  const screen = { status: 'PASS', density: 3, screen: { width: 1080, height: 2400 }, insets: { left: 0, top: 72, right: 0, bottom: 63 }, keyboardVisible: false,
    tree: node({ className: 'android.widget.FrameLayout', bounds: box(0, 0, 1080, 2400) }, [
      node({ className: 'android.view.ViewGroup', resourceId: 'goal', bounds: box(0, 136, 1080, 2328) }), scroll
    ]) };
  const restored = restoreScrolled(screen.tree).children[1].children;
  // Scrolled above the top edge: the top is clamped and the true bottom kept.
  assert.deepEqual(restored[0].bounds, box(0, 250, 1080, 400));
  assert.deepEqual(restored[1].bounds, box(48, 1969, 1032, 2401));
  assert.deepEqual([restored[2].bounds, restored[2].visible], [box(174, 2678, 547, 2786), true]);
  // Hidden inside the scroll view, not clipped: stays hidden.
  assert.equal(restored[3].visible, false);
  assert.deepEqual(restored[4].bounds, box(48, 298, 1032, 454));
  assert.deepEqual([restored[5].children[0].bounds, restored[5].children[0].visible], [box(48, 2900, 528, 3260), true]);
  const { response } = androidResponse(screen, screenshot(), { anchors: ['goal', 'goal.chart', 'goal.discuss', 'goal.hint', 'goal.recent'], screen: 'goal' });
  const facts = Object.fromEntries(response.elements.map(item => [item.anchor, item]));
  assert.deepEqual([facts['goal.discuss'].visible, facts['goal.discuss'].bounds.height, facts['goal.chart'].bounds.height], [true, 36, 144]);
  assert.deepEqual([facts['goal.hint'].visible, facts['goal.recent'].visible], [false, true]);
  assert.equal(facts.goal.text, 'Run 10K Discuss with AI Ordering cards');
});

test('typed text, keyboards and failed captures', () => {
  const typed = structuredClone(raw);
  const field = typed.tree.children[0].children[2].children[0];
  Object.assign(field, { text: 'Write tests', showingHint: false });
  const facts = Object.fromEntries(androidResponse(typed, screenshot(), { anchors, screen: 'tasks' }).response.elements.map(item => [item.anchor, item]));
  assert.equal(facts['tasks.input'].text, 'Write tests');
  assert.equal(facts['tasks.form'].text, 'Add');

  assert.equal(androidResponse({ ...raw, keyboardVisible: true }, screenshot(), { anchors, screen: 'tasks' }).response.status, 'FAIL');
  assert.deepEqual(androidResponse({ status: 'FAIL', reason: 'screen anchor tasks did not appear' }, null, { anchors, screen: 'tasks' }).response,
    { schemaVersion: 1, status: 'FAIL', reason: 'screen anchor tasks did not appear' });
  assert.equal(androidResponse(null, null, { anchors, screen: 'tasks' }).response.status, 'NOT_RUN');
  assert.equal(normalizeCapture({ ...raw, insets: undefined }).safeArea.height, 800);
  // A status bar that is not a whole number of dp: the content area is floored so viewport × scale = screenshot size.
  const odd = androidResponse({ ...raw, insets: { left: 0, top: 136, right: 0, bottom: 72 } }, screenshot(), { anchors, screen: 'tasks' });
  assert.deepEqual(odd.response.viewport, { width: 360, height: 730, scale: 3 });
  assert.deepEqual([PNG.sync.read(odd.png).width, PNG.sync.read(odd.png).height], [1080, 2190]);
});

test('Compose: composed buttons take their text, placeholders shown as child text count only for the field', () => {
  const compose = structuredClone(raw);
  const form = compose.tree.children[0].children[2];
  form.children = [
    node({ className: 'android.widget.EditText', resourceId: 'tasks.input', editable: true, clickable: true, bounds: box(60, 660, 897, 792) }, [node({ className: 'android.widget.TextView', text: 'New task', bounds: box(96, 700, 300, 760) })]),
    node({ className: 'android.view.View', resourceId: 'tasks.add', clickable: true, bounds: box(927, 660, 1020, 792) }, [node({ className: 'android.widget.TextView', text: 'Add', bounds: box(950, 700, 1000, 760) })])
  ];
  const facts = Object.fromEntries(androidResponse(compose, screenshot(), { anchors, screen: 'tasks' }).response.elements.map(item => [item.anchor, item]));
  assert.deepEqual([facts['tasks.input'].text, facts['tasks.input'].role], ['New task', 'textField']);
  assert.deepEqual([facts['tasks.add'].text, facts['tasks.add'].role, facts['tasks.add'].interactive], ['Add', 'button', true]);
  assert.equal(facts['tasks.form'].text, 'Add');
  // Once typed, the field shows its value and the placeholder child is gone.
  form.children[0] = node({ ...form.children[0], text: 'Write tests', children: undefined });
  const typed = Object.fromEntries(androidResponse(compose, screenshot(), { anchors, screen: 'tasks' }).response.elements.map(item => [item.anchor, item]));
  assert.equal(typed['tasks.input'].text, 'Write tests');
});


const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function driver(args, env = {}) {
  const child = spawn(process.execPath, [path.join(engine, 'scripts/android-driver.js'), ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ schemaVersion: 1, kind: 'capture', screen: 'tasks', state: 'initial', steps: [], anchors: ['tasks'], outputDir: '.protoflow/out' }));
  await new Promise(resolve => child.once('close', resolve));
  return JSON.parse(stdout);
}
/** A fake SDK whose adb and emulator are shell scripts. */
async function fakeSdk(t, { adb, emulator }) {
  const sdk = await mkdtemp(path.join(tmpdir(), 'protoflow-fake-sdk-'));
  t.after(() => rm(sdk, { recursive: true, force: true }));
  for (const [dir, name, body] of [['platform-tools', 'adb', adb], ['emulator', 'emulator', emulator]]) {
    await mkdir(path.join(sdk, dir), { recursive: true });
    await writeFile(path.join(sdk, dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(sdk, dir, name), 0o755);
  }
  return sdk;
}

test('the Android driver reports NOT_RUN, never PASS, without an SDK or an AVD', async t => {
  assert.deepEqual(await driver([]), { schemaVersion: 1, status: 'NOT_RUN', reason: 'the Android driver needs --package and --avd' });
  const empty = await mkdtemp(path.join(tmpdir(), 'protoflow-no-sdk-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const noSdk = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel'], { ANDROID_HOME: empty });
  assert.equal(noSdk.status, 'NOT_RUN');
  assert.match(noSdk.reason, /platform-tools not found/);

  const sdk = await fakeSdk(t, { adb: 'echo "List of devices attached"; echo', emulator: 'echo "Other_Device"' });
  const noAvd = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel', '--cache', path.join(sdk, 'cache')], { ANDROID_HOME: sdk });
  assert.equal(noAvd.status, 'NOT_RUN');
  assert.match(noAvd.reason, /AVD "ProtoFlow Pixel" was not found; create it/);
});

test('a running emulator that rejects the app APK is the application failure', async t => {
  const sdk = await fakeSdk(t, {
    adb: `case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n\\n' ;;
  *"emu avd name"*) printf 'ProtoFlow Pixel\\nOK\\n' ;;
  *install*) echo "Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]" ;;
  *) exit 0 ;;
esac`,
    emulator: 'echo "ProtoFlow Pixel"'
  });
  await writeFile(path.join(sdk, 'app.apk'), 'not an apk');
  const broken = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel', '--apk', path.join(sdk, 'app.apk'), '--cache', path.join(sdk, 'cache')], { ANDROID_HOME: sdk });
  assert.equal(broken.status, 'FAIL');
  assert.match(broken.reason, /could not be installed: Failure \[INSTALL_PARSE_FAILED_NO_CERTIFICATES\]/);
  const absent = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel', '--apk', path.join(sdk, 'missing.apk'), '--cache', path.join(sdk, 'cache')], { ANDROID_HOME: sdk });
  assert.equal(absent.status, 'FAIL');
  assert.match(absent.reason, /missing\.apk does not exist; the target's build must produce it/);
});

test('an emulator whose package service is down cannot install: the device is unavailable (NOT_RUN), not the app', async t => {
  const sdk = await fakeSdk(t, {
    adb: `case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n\\n' ;;
  *"emu avd name"*) printf 'ProtoFlow Pixel\\nOK\\n' ;;
  *install*) echo "Performing Streamed Install"; echo "adb: failed to install app.apk: cmd: Can't find service: package" >&2; exit 1 ;;
  *) exit 0 ;;
esac`,
    emulator: 'echo "ProtoFlow Pixel"'
  });
  await writeFile(path.join(sdk, 'app.apk'), 'apk');
  const down = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel', '--apk', path.join(sdk, 'app.apk'), '--cache', path.join(sdk, 'cache')], { ANDROID_HOME: sdk });
  assert.equal(down.status, 'NOT_RUN');
  assert.match(down.reason, /emulator could not install .*Can't find service: package/s);
});

test('an installed copy signed with another key is uninstalled and replaced by the verified APK', async t => {
  const sdk = await fakeSdk(t, {
    adb: `echo "$*" >> "$ANDROID_HOME/adb.log"
case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n\\n' ;;
  *"emu avd name"*) printf 'ProtoFlow Pixel\\nOK\\n' ;;
  *"uninstall dev.example"*) touch "$ANDROID_HOME/uninstalled"; echo Success ;;
  *install*) if [ -f "$ANDROID_HOME/uninstalled" ]; then echo Success; else echo "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package dev.example signatures do not match newer version; ignoring!]"; exit 1; fi ;;
  *) exit 0 ;;
esac`,
    emulator: 'echo "ProtoFlow Pixel"'
  });
  await writeFile(path.join(sdk, 'app.apk'), 'fixture apk');
  // No usable JDK: the capture stops at the runner build, after the app install it is testing.
  const result = await driver(['--package', 'dev.example', '--avd', 'ProtoFlow Pixel', '--apk', path.join(sdk, 'app.apk'), '--cache', path.join(sdk, 'cache')], { ANDROID_HOME: sdk, JAVA_HOME: path.join(sdk, 'no-jdk') });
  assert.equal(result.status, 'NOT_RUN');
  assert.match(result.reason, /JDK/);
  const calls = (await readFile(path.join(sdk, 'adb.log'), 'utf8')).split('\n').filter(line => /install/.test(line));
  assert.deepEqual(calls.map(line => line.replace(path.join(sdk, 'app.apk'), 'APK')), ['-s emulator-5554 install -r -g APK', '-s emulator-5554 uninstall dev.example', '-s emulator-5554 install -r -g APK']);
});
