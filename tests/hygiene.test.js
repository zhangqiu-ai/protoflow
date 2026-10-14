import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, truncate } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationHygiene, fingerprint, HYGIENE } from '../src/util.js';

const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd });
async function project(t, { git: repository = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-hygiene-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/lib'), { recursive: true });
  await writeFile(path.join(root, 'app/lib/main.dart'), 'void main() {}\n');
  if (repository) {
    await git(root, 'init', '-q'); await git(root, 'add', '.');
    await git(root, '-c', 'user.email=fixture@protoflow.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'init');
  }
  return root;
}
const check = async root => applicationHygiene(root, (await fingerprint(root, { gitIgnore: true })).files);

test('ordinary application changes, new source files included, pass', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'app/lib/main.dart'), 'void main() { run(); }\n');
  await writeFile(path.join(root, 'app/lib/about.dart'), 'class About {}\n');
  assert.deepEqual(await check(root), { status: 'PASS', addedFiles: 1, largeFiles: [], directories: [{ path: 'app/lib', count: 1 }] });
});

test('a tool cache placed in the worktree fails with the directories to delete', async t => {
  const root = await project(t);
  const cache = path.join(root, 'app/.gradle-user-home/caches');
  await mkdir(cache, { recursive: true });
  for (let index = 0; index <= HYGIENE.maxNewFiles; index++) await writeFile(path.join(cache, `entry-${index}.bin`), String(index));
  const result = await check(root);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.addedFiles, HYGIENE.maxNewFiles + 1);
  assert.match(result.reason, /1001 untracked application files \(limit 1000\), mostly under app\/\.gradle-user-home \(1001\)/);
  assert.match(result.reason, /outside the project or git-ignore them/);
  // Git-ignored caches are not application content and pass.
  await writeFile(path.join(root, '.gitignore'), '.gradle-user-home/\n');
  assert.equal((await check(root)).status, 'PASS');
});

test('an oversized file fails, also in a project without Git', async t => {
  for (const repository of [true, false]) {
    const root = await project(t, { git: repository });
    await writeFile(path.join(root, 'app/download.zip.part'), '');
    await truncate(path.join(root, 'app/download.zip.part'), HYGIENE.maxFileBytes + 1);
    const result = await check(root);
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.largeFiles, [{ path: 'app/download.zip.part', bytes: HYGIENE.maxFileBytes + 1 }]);
    assert.match(result.reason, /files above 25 MiB: app\/download\.zip\.part \(25 MiB\)/);
  }
});
