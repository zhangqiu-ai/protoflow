import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deliveryBlobDigests } from '../src/delivery-scope.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('committed blob digests come from one batch read, including empty, binary and newline-heavy files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-blobs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@protoflow.test'); git('config', 'user.name', 'Fixture');
  const files = { 'empty.txt': Buffer.alloc(0), 'lines.txt': Buffer.from('a\n\nb\n\n'), 'binary.bin': Buffer.from([0, 10, 255, 10, 0, 13, 10]), 'big.txt': Buffer.alloc(300000, 'x') };
  for (let i = 0; i < 200; i++) files[`many/${i}.txt`] = Buffer.from(`file ${i}\n`);
  for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), bytes); }
  git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  const tree = new Map(git('ls-tree', '-r', 'HEAD').split('\n').map(row => { const [meta, file] = row.split('\t'); return [file, meta.split(' ')[2]]; }));
  const oids = [...tree.values()];
  const digests = await deliveryBlobDigests(root, [...oids, oids[0]]);
  assert.equal(digests.size, new Set(oids).size);
  for (const [name, bytes] of Object.entries(files)) assert.equal(digests.get(tree.get(name)), sha(bytes), name);
  assert.equal((await deliveryBlobDigests(root, [])).size, 0);
  await assert.rejects(deliveryBlobDigests(root, ['not-an-oid']), /Malformed blob id/);
  await assert.rejects(deliveryBlobDigests(root, ['0'.repeat(40)]), /not a readable blob/);
});
