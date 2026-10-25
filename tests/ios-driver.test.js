import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { anchorFacts, elementText, subtreeText, readingOrder, iosResponse, cropScreenshot } from '../src/drivers/ios-tree.js';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A real XCUITest snapshot of examples/mobile/ios (tasks.added) on an iPhone 17 simulator, safe area 402×778 at y=62.
const raw = JSON.parse(await readFile(path.join(engine, 'tests/fixtures/ios/tasks-added.raw.json'), 'utf8'));
const anchors = ['tasks', 'tasks.header', 'tasks.title', 'tasks.settings', 'tasks.list', 'tasks.item', 'tasks.form', 'tasks.input', 'tasks.add', 'tasks.error'];
const byAnchor = facts => Object.fromEntries(facts.elements.map(item => [item.anchor, item]));

test('XCUITest snapshot facts mirror the web inspector: text, roles, counts and content-relative bounds', () => {
  const facts = anchorFacts(raw.tree, { anchors, screen: 'tasks', content: raw.safeArea });
  const elements = byAnchor(facts);
  assert.deepEqual(facts.missing, ['tasks.error']);
  // The screen anchor is the content frame itself; SwiftUI containers only report the union of their children.
  assert.deepEqual(elements.tasks.bounds, { x: 0, y: 0, width: 402, height: 778 });
  assert.equal(elements.tasks.text, 'Today Settings Review prototype Ship version Write tests Add');
  // Containers read like innerText: labels in reading order, never typed values or placeholders.
  assert.equal(elements['tasks.header'].text, 'Today Settings');
  assert.equal(elements['tasks.form'].text, 'Add');
  assert.equal(elements['tasks.item'].count, 3);
  assert.equal(elements['tasks.item'].text, 'Review prototype');
  assert.deepEqual({ ...elements['tasks.input'], bounds: undefined }, {
    anchor: 'tasks.input', count: 1, visible: true, enabled: true, interactive: true, editable: true, inputType: 'text', role: 'textField', bounds: undefined, text: 'New task'
  });
  assert.equal(elements['tasks.add'].interactive, true);
  assert.equal(elements['tasks.add'].editable, false);
  assert.equal(elements['tasks.title'].bounds.y.toFixed(2), (83.17 - 62).toFixed(2));
});

test('React Native flattens the tree: container text is collected by geometry, counts and frames stay exact', async () => {
  // A real XCUITest snapshot of examples/mobile/react-native (tasks.initial): testID Views are leaves, their text siblings.
  const flat = JSON.parse(await readFile(path.join(engine, 'tests/fixtures/ios/rn-tasks-initial.raw.json'), 'utf8'));
  const elements = byAnchor(anchorFacts(flat.tree, { anchors, screen: 'tasks', content: flat.safeArea }));
  assert.equal(elements.tasks.text, 'Today Settings Review prototype Ship version Add');
  assert.equal(elements['tasks.header'].text, 'Today Settings');
  assert.equal(elements['tasks.list'].text, 'Review prototype Ship version');
  assert.equal(elements['tasks.form'].text, 'Add');
  assert.equal(elements['tasks.item'].count, 2);
  assert.equal(elements['tasks.title'].text, 'Today');
  assert.deepEqual(elements['tasks.header'].bounds, { x: 20, y: 16, width: 362, height: 44 });
  assert.equal(elements['tasks.input'].text, 'New task');
});

test('content scrolled out of a scroll view is rendered: visible, and part of its container text', () => {
  const frame = (x, y, width, height) => ({ x, y, width, height });
  // React Native on iOS: the screen View is a leaf, its scroll content lies below the 778 pt content area.
  const tree = { type: 'application', frame: frame(0, 0, 402, 874), children: [
    { type: 'other', identifier: 'goal', label: '', frame: frame(0, 62, 402, 778) },
    { type: 'scrollView', frame: frame(0, 116, 402, 724), children: [
      { type: 'staticText', identifier: 'goal.title', label: 'Run 10K', frame: frame(16, 122, 300, 40) },
      { type: 'button', identifier: 'goal.discuss', label: 'Discuss with AI', frame: frame(58, 899, 130, 36) },
      // A horizontal row below the fold: its first item is inside the row, the row is scrolled out.
      { type: 'scrollView', identifier: 'goal.recent', frame: frame(0, 960, 402, 120), children: [
        { type: 'button', identifier: 'goal.recent.1', label: 'Ordering cards', frame: frame(16, 960, 160, 120) }
      ] }
    ] },
    // Outside any scroll view (a drawer parked off screen): not rendered on the page.
    { type: 'button', identifier: 'goal.drawer', label: 'Settings', frame: frame(-320, 62, 300, 44) }
  ] };
  const elements = byAnchor(anchorFacts(tree, { anchors: ['goal', 'goal.discuss', 'goal.recent.1', 'goal.drawer'], screen: 'goal', content: frame(0, 62, 402, 778) }));
  assert.deepEqual([elements['goal.discuss'].visible, elements['goal.recent.1'].visible, elements['goal.drawer'].visible], [true, true, false]);
  assert.deepEqual(elements['goal.discuss'].bounds, { x: 58, y: 837, width: 130, height: 36 });
  assert.equal(elements.goal.text, 'Run 10K Discuss with AI Ordering cards');
  // A tab bar floating over the scroll view reads after its content, as in document order, not between the fold.
  tree.children.push({ type: 'tabBar', frame: frame(0, 722, 402, 84), children: [{ type: 'button', identifier: 'goal.tab', label: 'Growth', frame: frame(0, 722, 100, 84) }] });
  assert.equal(byAnchor(anchorFacts(tree, { anchors: ['goal'], screen: 'goal', content: frame(0, 62, 402, 778) })).goal.text, 'Run 10K Discuss with AI Ordering cards Growth');
});

test('a flattened container\'s own label is an accessible name, not text it shows', () => {
  const tree = { type: 'application', frame: { x: 0, y: 0, width: 400, height: 800 }, children: [
    { type: 'other', identifier: 'page', frame: { x: 0, y: 0, width: 400, height: 800 } },
    { type: 'staticText', label: 'Settings', frame: { x: 20, y: 20, width: 100, height: 20 } },
    { type: 'tabBar', label: 'Main navigation', frame: { x: 20, y: 720, width: 360, height: 60 } },
    { type: 'button', label: 'Growth', frame: { x: 30, y: 730, width: 60, height: 40 } },
    { type: 'button', label: 'Me', frame: { x: 300, y: 730, width: 60, height: 40 } },
    { type: 'other', label: 'Z', frame: { x: 20, y: 60, width: 56, height: 56 } }
  ] };
  assert.equal(elementText(tree.children[0], tree), 'Settings Z Growth Me');
});

test('an overlay reads after the page it covers, in tree order like the DOM, and never as content of what it covers', () => {
  const frame = (x, y, width, height) => ({ x, y, width, height });
  // siyue nav.sidebar on iPad (React Native, flattened): the home page with a progress ring, a drawer over it and a
  // centred tab bar the drawer barely touches.
  const page = (drawerLast, tabs) => {
    const home = { type: 'other', frame: frame(0, 0, 834, 1210), children: [
      { type: 'button', label: 'Z', frame: frame(12, 41, 34, 34) },
      { type: 'scrollView', frame: frame(0, 86, 834, 1104), children: [
        { type: 'other', label: '1/4', frame: frame(91, 110, 74, 74) },
        { type: 'staticText', label: '3 left today', frame: frame(181, 125, 562, 26) },
        { type: 'button', label: 'Goals', frame: frame(16, 600, 802, 50) }
      ] }
    ] };
    const drawer = [
      { type: 'other', label: 'Sidebar', frame: frame(0, 0, 300, 1210) },
      { type: 'scrollView', frame: frame(12, 42, 276, 1090), children: [
        { type: 'button', label: 'Zhang Qiu', frame: frame(12, 42, 276, 64) },
        // Its centre lies inside the ring underneath: the ring is not a container of the drawer's items.
        { type: 'button', label: 'Search', frame: frame(12, 106, 276, 48) }
      ] },
      { type: 'button', label: 'Settings', frame: frame(12, 1132, 276, 48) }
    ];
    const bar = { type: 'other', label: 'Main navigation', frame: frame(tabs.x - 6, tabs.y - 6, 420, 62), children: [
      { type: 'button', label: 'Growth', frame: frame(tabs.x, tabs.y, 82, 51) },
      { type: 'button', label: 'Me', frame: frame(tabs.x + 327, tabs.y, 82, 51) }
    ] };
    const root = { type: 'other', identifier: 'nav.sidebar', label: '', frame: frame(0, 0, 834, 1210) };
    return { type: 'application', frame: frame(0, 0, 834, 1210), children: [root, home, ...(drawerLast ? [bar, ...drawer] : [...drawer, bar])] };
  };
  const text = tree => elementText(tree.children[0], tree);
  const ipad = { x: 213, y: 1140 }, iphone = { x: 17, y: 1140 };
  // The prototype's DOM: page, tab bar, then the drawer that covers both.
  assert.equal(text(page(true, ipad)), 'Z 1/4 3 left today Goals Growth Me Zhang Qiu Search Settings');
  assert.equal(text(page(true, iphone)), 'Z 1/4 3 left today Goals Growth Me Zhang Qiu Search Settings');
  // A drawer earlier in the tree than the tab bar reads before it: the order follows the tree, not the coordinates
  // (formerly the drawer's Settings and the tab bar shared a row, and the ring was dropped as a container on iPad).
  assert.equal(text(page(false, ipad)), 'Z 1/4 3 left today Goals Zhang Qiu Search Settings Growth Me');
  assert.equal(text(page(false, iphone)), 'Z 1/4 3 left today Goals Zhang Qiu Search Settings Growth Me');

  // Plain layouts keep the geometric order: a badge inside a button and lines that touch stay where they are.
  const plain = { type: 'application', frame: frame(0, 0, 400, 800), children: [
    { type: 'other', identifier: 'list', label: '', frame: frame(0, 0, 400, 800) },
    { type: 'staticText', label: 'Second', frame: frame(16, 40, 200, 22) },
    { type: 'staticText', label: 'First', frame: frame(16, 20, 200, 21) },
    { type: 'button', label: 'Chats', frame: frame(16, 100, 100, 50) },
    { type: 'button', label: 'Me', frame: frame(120, 100, 100, 50) },
    { type: 'staticText', label: '3', frame: frame(90, 110, 20, 20) }
  ] };
  assert.equal(elementText(plain.children[0], plain), 'First Second Chats 3 Me');
});

test('native controls: no text of their own, labels deduplicated inside containers, values never leak', () => {
  const row = { type: 'other', identifier: 'settings.notify', frame: { x: 20, y: 140, width: 362, height: 52 }, children: [
    { type: 'staticText', label: 'Daily reminder', frame: { x: 36, y: 156, width: 120, height: 20 } },
    { type: 'switch', identifier: 'settings.notify-toggle', label: 'Daily reminder', value: '1', frame: { x: 315, y: 150, width: 51, height: 31 } }
  ] };
  assert.equal(subtreeText(row), 'Daily reminder');
  assert.equal(elementText(row.children[1]), '');
  // With a subtitle the switch reads after both lines (siyue growth.reminders); its repeated label is still left out,
  // in a hierarchy and in a flattened (React Native) tree. A switch whose label is the only text keeps it.
  const subtitled = { ...row, children: [
    { type: 'staticText', label: 'Daily reminder', frame: { x: 74, y: 128, width: 235, height: 21 } },
    { type: 'switch', label: 'Daily reminder', value: '1', frame: { x: 321, y: 132.7, width: 51, height: 31 } },
    { type: 'staticText', label: 'Today’s tasks', frame: { x: 74, y: 150, width: 235, height: 18 } }
  ] };
  assert.equal(subtreeText(subtitled), 'Daily reminder Today’s tasks');
  const flat = { type: 'other', frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ ...subtitled, children: undefined, frame: { x: 16, y: 116, width: 370, height: 64 } }, ...subtitled.children] };
  assert.equal(elementText(flat.children[0], flat), 'Daily reminder Today’s tasks');
  assert.equal(subtreeText({ type: 'other', children: [{ type: 'switch', label: 'Wi-Fi', frame: { x: 0, y: 0, width: 300, height: 44 } }] }), 'Wi-Fi');
  assert.equal(elementText({ type: 'textField', value: 'Draft', placeholder: 'New task' }), 'Draft');
  assert.equal(elementText({ type: 'textField', value: 'New task', placeholder: 'New task' }), 'New task');
  assert.equal(elementText({ type: 'textField', placeholder: 'New task' }), 'New task');
  // Flutter on iOS: the hint is the field's label, the empty value stays empty.
  assert.equal(elementText({ type: 'textField', label: 'New task', value: '' }), 'New task');
  assert.equal(elementText({ type: 'textField', label: 'New task', value: 'Draft' }), 'Draft');
  assert.equal(subtreeText({ type: 'other', children: [{ type: 'textField', value: 'secret', frame: { x: 0, y: 0, width: 10, height: 10 } }] }), '');
  // Rows by vertical centre (mixed heights share a row), then left to right.
  const order = readingOrder([
    { label: 'b', frame: { x: 300, y: 90, width: 60, height: 20 } },
    { label: 'c', frame: { x: 0, y: 140, width: 60, height: 20 } },
    { label: 'a', frame: { x: 20, y: 83, width: 80, height: 34 } }
  ]).map(item => item.label);
  assert.deepEqual(order, ['a', 'b', 'c']);
  // A tall ring beside a stack of text lines (siyue growth.goal): each line's centre lies within the ring's height,
  // so the ring reads first; the stacked lines overlap horizontally and stay top to bottom. A layer over the same
  // area (overlapping horizontally) still orders by its centre.
  const media = readingOrder([
    { label: 'name', frame: { x: 120, y: 125, width: 205, height: 30 } },
    { label: 'sub', frame: { x: 120, y: 155, width: 205, height: 20 } },
    { label: 'ring', frame: { x: 20, y: 121, width: 84, height: 84 } },
    { label: 'visibility', frame: { x: 120, y: 183, width: 91, height: 20 } },
    { label: 'next', frame: { x: 22, y: 232, width: 74, height: 24 } }
  ]).map(item => item.label);
  assert.deepEqual(media, ['ring', 'name', 'sub', 'visibility', 'next']);
  const layered = readingOrder([
    { label: 'line', frame: { x: 10, y: 20, width: 100, height: 20 } },
    { label: 'backdrop', frame: { x: 0, y: 0, width: 400, height: 300 } }
  ]).map(item => item.label);
  assert.deepEqual(layered, ['line', 'backdrop']);
});

test('iosResponse crops to the safe area and refuses keyboards, failures and unmeasured frames', () => {
  const device = new PNG({ width: 30, height: 60 });
  for (let i = 0; i < device.data.length; i += 4) { const y = Math.floor(i / 4 / 30); device.data.set(y < 6 ? [0, 0, 0, 255] : [255, 255, 255, 255], i); }
  const screenshot = PNG.sync.write(device);
  const tree = { type: 'application', frame: { x: 0, y: 0, width: 10, height: 20 }, children: [{ type: 'other', identifier: 'home', frame: { x: 1, y: 3, width: 8, height: 4 } }] };
  const { response, png } = iosResponse({ status: 'PASS', tree, safeArea: { x: 0, y: 2, width: 10, height: 16 } }, screenshot, { anchors: ['home', 'home.go'], screen: 'home' });
  assert.equal(response.status, 'PASS');
  assert.deepEqual(response.viewport, { width: 10, height: 16, scale: 3 });
  assert.deepEqual(response.missing, ['home.go']);
  const cropped = PNG.sync.read(png);
  assert.deepEqual([cropped.width, cropped.height], [30, 48]);
  assert.deepEqual([...cropped.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.equal(cropScreenshot(screenshot, { x: 0, y: 0, width: 10, height: 20 }, 10).scale, 3);

  assert.equal(iosResponse({ status: 'PASS', tree, keyboardVisible: true, safeArea: { x: 0, y: 2, width: 10, height: 16 } }, screenshot, { anchors: [], screen: 'home' }).response.status, 'FAIL');
  assert.deepEqual(iosResponse({ status: 'FAIL', reason: 'step 1 tap home.go: anchor home.go not found' }, null, { anchors: [], screen: 'home' }).response,
    { schemaVersion: 1, status: 'FAIL', reason: 'step 1 tap home.go: anchor home.go not found' });
  assert.equal(iosResponse({ status: 'PASS', tree }, screenshot, { anchors: [], screen: 'home' }).response.status, 'NOT_RUN');
  assert.equal(iosResponse({ status: 'PASS', tree }, screenshot, { anchors: ['home'], screen: 'home', frame: 'device' }).response.viewport.height, 20);
  assert.equal(iosResponse(null, null, { anchors: [], screen: 'home' }).response.status, 'NOT_RUN');
});

test('iosResponse keeps a keyboard after a final fill or clear: its frame is occluded and its keys leave the tree', () => {
  const screenshot = PNG.sync.write(new PNG({ width: 30, height: 60 }));
  const keys = { type: 'keyboard', frame: { x: 0, y: 12, width: 10, height: 8 }, children: [{ type: 'button', identifier: 'home.go', label: 'Go', frame: { x: 1, y: 13, width: 2, height: 2 } }] };
  const tree = { type: 'application', frame: { x: 0, y: 0, width: 10, height: 20 }, children: [{ type: 'other', identifier: 'home', frame: { x: 0, y: 2, width: 10, height: 16 } }, keys] };
  const typing = { status: 'PASS', tree, keyboardVisible: true, keyboardFrame: keys.frame, safeArea: { x: 0, y: 2, width: 10, height: 16 } };
  const fill = [{ action: 'tap', anchor: 'home' }, { action: 'fill', anchor: 'home.name', value: 'W' }];
  const { response } = iosResponse(typing, screenshot, { anchors: ['home', 'home.go'], screen: 'home', steps: fill });
  assert.equal(response.status, 'PASS');
  // Clipped to the safe area, in content coordinates; the keyboard's own "Go" key is not the app's anchor.
  assert.deepEqual(response.occluded, [{ x: 0, y: 10, width: 10, height: 6 }]);
  assert.deepEqual(response.missing, ['home.go']);
  assert.equal(iosResponse(typing, screenshot, { anchors: [], screen: 'home', steps: [{ action: 'clear', anchor: 'home.name' }] }).response.status, 'PASS');
  // Any other last step (or none) must leave the keyboard dismissed, and an unmeasured keyboard is not compared.
  assert.equal(iosResponse(typing, screenshot, { anchors: [], screen: 'home', steps: [...fill, { action: 'tap', anchor: 'home' }] }).response.status, 'FAIL');
  assert.equal(iosResponse(typing, screenshot, { anchors: [], screen: 'home' }).response.status, 'FAIL');
  assert.equal(iosResponse({ ...typing, keyboardFrame: undefined }, screenshot, { anchors: [], screen: 'home', steps: fill }).response.status, 'NOT_RUN');
  // A focused field on a Simulator with a hardware keyboard: XCUITest still lists a keyboard, parked below the screen
  // (y 918 on an 874 pt iPhone 17). Nothing is covered, whatever the last step was.
  const parked = { ...typing, keyboardFrame: { x: 0, y: 22, width: 10, height: 8 } };
  for (const steps of [fill, [{ action: 'tap', anchor: 'home' }]]) {
    const { response: below } = iosResponse(parked, screenshot, { anchors: [], screen: 'home', steps });
    assert.equal(below.status, 'PASS');
    assert.equal(below.occluded, undefined);
  }
});

async function driver(args, { env = {}, request = {} } = {}) {
  const child = spawn(process.execPath, [path.join(engine, 'scripts/ios-driver.js'), ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ schemaVersion: 1, kind: 'capture', screen: 'tasks', state: 'initial', steps: [], anchors: ['tasks'], outputDir: '.protoflow/out', ...request }));
  await new Promise(resolve => child.once('close', resolve));
  return JSON.parse(stdout);
}

test('the iOS driver reports NOT_RUN, never PASS, when it cannot reach a simulator', { skip: process.platform !== 'darwin' && 'driver requires macOS' }, async () => {
  assert.deepEqual(await driver([]), { schemaVersion: 1, status: 'NOT_RUN', reason: 'the iOS driver needs --bundle-id and --device' });
  const bin = await mkdtemp(path.join(tmpdir(), 'protoflow-fake-xcrun-'));
  try {
    await writeFile(path.join(bin, 'xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n');
    await chmod(path.join(bin, 'xcrun'), 0o755);
    const missing = await driver(['--bundle-id', 'dev.example', '--device', 'No Such Phone', '--cache', path.join(bin, 'cache')], { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(missing.status, 'NOT_RUN');
    assert.match(missing.reason, /simulator "No Such Phone" was not found; create it/);
    await writeFile(path.join(bin, 'xcrun'), '#!/bin/sh\necho "xcrun: error: unable to find utility simctl" >&2\nexit 72\n');
    const noTools = await driver(['--bundle-id', 'dev.example', '--device', 'Any', '--cache', path.join(bin, 'cache')], { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(noTools.status, 'NOT_RUN');
    assert.match(noTools.reason, /Xcode simulator tools are not available: xcrun: error/);

    // A booted simulator that rejects the app bundle is the application's failure, not the environment's.
    await writeFile(path.join(bin, 'xcrun'), `#!/bin/sh
case "$2" in
  list) echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":"U1","name":"Fake Phone","state":"Booted","isAvailable":true}]}}' ;;
  install) echo "Invalid bundle: missing CFBundleExecutable" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`);
    await mkdir(path.join(bin, 'App.app'));
    const broken = await driver(['--bundle-id', 'dev.example', '--device', 'Fake Phone', '--app', path.join(bin, 'App.app'), '--cache', path.join(bin, 'cache')], { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(broken.status, 'FAIL');
    assert.match(broken.reason, /could not be installed: Invalid bundle/);
    const absent = await driver(['--bundle-id', 'dev.example', '--device', 'Fake Phone', '--app', path.join(bin, 'Missing.app'), '--cache', path.join(bin, 'cache')], { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(absent.status, 'FAIL');
    assert.match(absent.reason, /Missing\.app does not exist; the target's build must produce it/);
  } finally { await rm(bin, { recursive: true, force: true }); }
});
