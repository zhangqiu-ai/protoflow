import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, configSchemaV2 } from '../src/config.js';
import { sidecarSchema, staticContractSchema, driverRequestSchema, driverResponseSchema } from '../src/protocol-schemas.js';
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
const published = {
  'config.schema.json': configSchema, 'config.v2.schema.json': configSchemaV2, 'anchor-sidecar.schema.json': sidecarSchema,
  'static-contract.schema.json': staticContractSchema, 'driver-request.schema.json': driverRequestSchema, 'driver-response.schema.json': driverResponseSchema
};
for (const [name, schema] of Object.entries(published)) {
  const saved = JSON.parse(await readFile(path.join(root, 'schemas', name), 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(schema)) throw new Error(`Published schemas/${name} differs from the engine schema`);
}
const ajv = new Ajv({ strict: false });
const validators = { 1: ajv.compile(configSchema), 2: ajv.compile(configSchemaV2) };
const configFiles = (await readdir(path.join(root, 'templates')))
  .filter(name => /^protoflow(?:\.[a-z-]+)?\.config\.json$/.test(name))
  .map(name => `templates/${name}`);
for (const example of await readdir(path.join(root, 'examples'), { withFileTypes: true })) {
  if (!example.isDirectory()) continue;
  const directory = `examples/${example.name}`;
  if ((await readdir(path.join(root, directory))).includes('protoflow.config.json')) configFiles.push(`${directory}/protoflow.config.json`);
}
for (const relative of configFiles) {
  const config = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  const validate = validators[config.schemaVersion];
  if (!validate) throw new Error(`${relative}: unknown schemaVersion ${config.schemaVersion}`);
  if (!validate(config)) throw new Error(`${relative}: ${JSON.stringify(validate.errors)}`);
}
console.log(`Syntax OK: ${count} JavaScript files; ${Object.keys(published).length} published schemas in sync; ${configFiles.length} example/template configs validated`);
