import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { suggestMappings } from '../src/mappings.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));

// Arbitrary page and resource names: the scanner must derive structure from the project, not presets.
async function fixture(files, mappings = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-suggest-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const config = { schemaVersion: 1, prototypeDir: 'design', mappings };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  return { root, config };
}

const files = {
  'design/screens/orders.html': `<link rel="stylesheet" href="../theme/base.css?v=2">
<link href="https://fonts.example.com/font.css" rel="stylesheet">
<script type="module" src="../logic/orders.js"></script>
<img srcset="../media/mark.svg 1x, ../media/mark@2x.png 2x" alt="">
<a href="profile.html">Profile</a><a href="#top">Top</a>
<img src="../media/missing.png">`,
  'design/screens/profile.html': `<style>@import url("../theme/base.css"); .hero { background: url('/media/hero.jpg'); }</style>
<main data-area="profile"></main>`,
  'design/theme/base.css': `@import "./palette.css";\nbody { background: url(data:image/png;base64,AAAA); }`,
  'design/theme/palette.css': ':root { --ink: #111; }',
  'design/logic/orders.js': `import { format } from './shared/format.js';\nexport { format };`,
  'design/logic/shared/format.js': 'export const format = value => value;',
  'design/media/mark.svg': '<svg></svg>',
  'design/media/mark@2x.png': 'png',
  'design/media/hero.jpg': 'jpg',
  'design/notes/readme.txt': 'unused',
};

test('suggest derives page resources transitively and leaves component targets empty', async () => {
  const { root, config } = await fixture(files);
  const draft = await suggestMappings(root, config);
  assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(draft.pages.map(page => page.path), ['design/screens/orders.html', 'design/screens/profile.html']);
  assert.deepEqual(draft.pages[0].resources, [
    'design/logic/orders.js', 'design/logic/shared/format.js', 'design/media/mark.svg', 'design/media/mark@2x.png',
    'design/theme/base.css', 'design/theme/palette.css',
  ]);
  assert.deepEqual(draft.pages[0].unresolved, ['../media/missing.png']);
  assert.deepEqual(draft.pages[1].resources, ['design/media/hero.jpg', 'design/theme/base.css', 'design/theme/palette.css']);
  assert.deepEqual(draft.sharedResources.map(item => item.path), ['design/theme/base.css', 'design/theme/palette.css']);
  assert.deepEqual(draft.orphanFiles, ['design/notes/readme.txt']);
  assert.deepEqual(draft.mappings.map(mapping => mapping.id), ['screens-orders', 'screens-profile']);
  for (const mapping of draft.mappings) {
    assert.equal(mapping.component, null);
    assert.equal(mapping.prototype, null);
    assert.equal(mapping.application, null);
  }
  assert.equal(draft.mappings[1].prototypeFiles[0], 'design/screens/profile.html');
});

test('suggest reports prototype files not covered by configured mappings', async () => {
  const { root, config } = await fixture(files, [
    { id: 'orders', prototypeFiles: ['design/screens/orders.html', 'design/theme/**'], prototype: 'main', application: 'main', component: 'anything/Orders' },
  ]);
  const draft = await suggestMappings(root, config);
  assert.ok(!draft.unmappedFiles.includes('design/theme/palette.css'));
  assert.ok(draft.unmappedFiles.includes('design/screens/profile.html'));
  assert.ok(draft.unmappedFiles.includes('design/logic/orders.js'));
});

test('CLI mappings suggest is read-only', async () => {
  const { root } = await fixture(files);
  const before = await readFile(path.join(root, 'protoflow.config.json'), 'utf8');
  const { stdout } = await exec(process.execPath, [cli, 'mappings', 'suggest', '--project', root]);
  assert.equal(JSON.parse(stdout).mappings.length, 2);
  assert.equal(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'), before);
  await assert.rejects(exec(process.execPath, [cli, 'mappings', 'apply', '--project', root]), /Use mappings suggest/);
});
