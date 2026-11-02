import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { driverOptions, launchPreparationOptions } from '../scripts/ios-driver.js';

const token = 'a'.repeat(64);
const options = directory => driverOptions(['--launch-url', 'example://screen?fixture={fixture}', '--launch-preparation-dir', directory, '--launch-preparation-token', token]);
const temporary = async () => realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-launch-options-')));

test('launch preparation leaves unconfigured generic defaults unchanged', async () => {
  assert.deepEqual({ ...driverOptions([]) }, { frame: 'safe-area' });
  assert.equal(await launchPreparationOptions(driverOptions([])), null);
});

test('launch preparation requires both arguments, lowercase 64-character hex identity and a deep link', async () => {
  for (const values of [
    { 'launch-preparation-dir': '/private/none' },
    { 'launch-preparation-token': token },
    { 'launch-preparation-dir': '/private/none', 'launch-preparation-token': 'secret' },
    { 'launch-preparation-dir': '/private/none', 'launch-preparation-token': 'A'.repeat(64) },
    { 'launch-preparation-dir': '/private/none', 'launch-preparation-token': token + '\n' },
  ]) await assert.rejects(launchPreparationOptions(values), /needs a directory and a 64-character/);
  await assert.rejects(launchPreparationOptions({ 'launch-preparation-dir': '/private/none', 'launch-preparation-token': token }), /needs --launch-url/);
});

test('a private owned canonical directory produces only the fixed native channel fields', async () => {
  const directory = await temporary();
  try {
    await chmod(directory, 0o700);
    assert.deepEqual(await launchPreparationOptions(options(directory)), { directory, token, timeoutMs: 15000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('launch preparation refuses public permissions, files, missing directories and relative paths', async () => {
  const directory = await temporary();
  try {
    await chmod(directory, 0o755);
    await assert.rejects(launchPreparationOptions(options(directory)), /owned mode-0700/);
    const file = path.join(directory, 'file'); await writeFile(file, 'not a directory', { mode: 0o700 });
    for (const value of [file, path.join(directory, 'absent'), './relative', directory + '/./']) {
      await assert.rejects(launchPreparationOptions(options(value)), /owned mode-0700/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('direct and ancestor symlinks cannot redirect the launch channel', async () => {
  const directory = await temporary();
  try {
    const owned = path.join(directory, 'owned'); await mkdir(owned, { mode: 0o700 });
    const link = path.join(directory, 'link'); await symlink(owned, link);
    await assert.rejects(launchPreparationOptions(options(link)), /without symlinks/);
    const child = path.join(owned, 'child'); await mkdir(child, { mode: 0o700 });
    await assert.rejects(launchPreparationOptions(options(path.join(link, 'child'))), /without symlinks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
