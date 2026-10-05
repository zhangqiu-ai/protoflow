import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/config.js';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.protoflow', 'test-results', 'playwright-report'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await walk(file);
    else if (item.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      count++;
    }
  }
}
await walk(root);
const validate = new Ajv({ strict: false }).compile(configSchema);
const savedSchema = JSON.parse(await readFile(path.join(root, 'schemas/config.schema.json'), 'utf8'));
if (JSON.stringify(savedSchema) !== JSON.stringify(configSchema)) throw new Error('Published config schema differs from engine schema');
for (const relative of ['templates/protoflow.config.json', 'examples/demo/protoflow.config.json']) {
  const config = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  if (!validate(config)) throw new Error(`${relative}: ${JSON.stringify(validate.errors)}`);
}
console.log(`Syntax OK: ${count} JavaScript files; config templates validated`);
