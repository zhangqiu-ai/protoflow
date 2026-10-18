import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchUrl, launchUrlTemplateError } from '../src/drivers/launch-url.js';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function driver(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(engine, 'scripts', script), ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ schemaVersion: 1, screen: 'tasks', state: 'initial', steps: [], anchors: [], outputDir: path.join(engine, 'test-results', 'launch-url') }));
  });
}

test('a launch URL template carries the screen, state and fixture percent-encoded', () => {
  const request = { screen: 'settings', state: 'saved & closed', fixture: { data: { user: 'Ada', tags: ['a/b'] } } };
  assert.equal(launchUrl('protoflowtasks://{screen}?state={state}&fixture={fixture}', request),
    'protoflowtasks://settings?state=saved%20%26%20closed&fixture=%7B%22user%22%3A%22Ada%22%2C%22tags%22%3A%5B%22a%2Fb%22%5D%7D');
  // No fixture is an empty object, the same default the launch arguments and intent extras use.
  assert.equal(launchUrl('app://open/{screen}?f={fixture}', { screen: 'tasks', state: 'initial' }), 'app://open/tasks?f=%7B%7D');
  assert.equal(launchUrl('app://{screen}', { screen: 'tasks' }), 'app://tasks');
});

test('a launch URL template must name the screen, use known placeholders and have a scheme', () => {
  assert.equal(launchUrlTemplateError('protoflowtasks://{screen}?state={state}&fixture={fixture}'), null);
  assert.match(launchUrlTemplateError('protoflowtasks://home'), /must contain \{screen\}/);
  assert.match(launchUrlTemplateError('protoflowtasks://{screen}?locale={locale}'), /unknown placeholder \{locale\}/);
  assert.match(launchUrlTemplateError('{screen}?state={state}'), /needs a URL scheme/);
});

test('both native drivers refuse a bad launch URL template before touching a device', async () => {
  const ios = await driver('ios-driver.js', ['--bundle-id', 'dev.example', '--device', 'Any', '--launch-url', 'dev.example://home']);
  const android = await driver('android-driver.js', ['--package', 'dev.example', '--avd', 'Any', '--launch-url', 'dev.example://home']);
  if (process.platform === 'darwin') assert.deepEqual(ios, { schemaVersion: 1, status: 'NOT_RUN', reason: '--launch-url must contain {screen} so each scene opens its own screen: dev.example://home' });
  assert.deepEqual(android, { schemaVersion: 1, status: 'NOT_RUN', reason: '--launch-url must contain {screen} so each scene opens its own screen: dev.example://home' });
});
