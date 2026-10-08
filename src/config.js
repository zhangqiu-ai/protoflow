import { validateSource } from './source.js';
import Ajv from 'ajv';
import { readJson, projectPath } from './util.js';

const command = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['argv'], properties: { argv: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000 } } }] };
const selectorPair = { type: 'object', required: ['prototype', 'application'], properties: { prototype: { type: 'string', minLength: 1 }, application: { type: 'string', minLength: 1 } }, additionalProperties: false };
export const configSchema = {
  type: 'object', required: ['schemaVersion', 'prototypeDir', 'mappings'], additionalProperties: false,
  properties: {
    source: { type: 'object', required: ['kind', 'repository', 'branch', 'path'], additionalProperties: false, properties: {
      kind: { const: 'git' }, repository: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, startSha: { type: 'string', pattern: '^[a-f0-9]{40}$' }
    } },
    runner: { type: 'object', additionalProperties: false, properties: { pollMs: { type: 'integer', minimum: 1000 }, applicationRef: { type: 'string', minLength: 1 }, setup: command, spec: { type: 'string', minLength: 1 }, adr: { type: 'string', minLength: 1 }, delivery: { type: 'object', additionalProperties: false, required: ['branch', 'baseBranch'], properties: { remote: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' }, branch: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$' }, baseBranch: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$' }, merge: { enum: ['auto', 'none'] } } } } },
    schemaVersion: { const: 1 }, prototypeDir: { type: 'string', minLength: 1 },
    mappings: { type: 'array', items: { type: 'object', required: ['id', 'prototypeFiles', 'prototype', 'application', 'component'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' }, prototypeFiles: { type: 'array', minItems: 1, items: { type: 'string' } }, prototype: { type: 'string', minLength: 1 }, application: { type: 'string', minLength: 1 }, component: { type: 'string', minLength: 1 }, priority: { enum: ['critical', 'high', 'normal', 'low'] }, geometryTolerance: { type: 'number', minimum: 0 }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }
    } } },
    classification: { type: 'object', additionalProperties: false, properties: { rules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pattern', 'level'], properties: { pattern: { type: 'string' }, level: { enum: ['L0', 'L1', 'L2', 'L3'] } } } } } },
    policy: { type: 'object', additionalProperties: false, properties: { maxRepairAttempts: { type: 'integer', minimum: 0, maximum: 10 }, requireHumanReview: { type: 'boolean' }, sequentialVersions: { type: 'boolean' }, autoApprove: { type: 'boolean' } } },
    watch: { type: 'object', additionalProperties: false, properties: { pollMs: { type: 'integer', minimum: 20 }, idleMs: { type: 'integer', minimum: 20 } } },
    verification: { type: 'object', additionalProperties: false, properties: { build: command, functional: command } },
    adapters: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['codex', 'specKit', 'bmad'].map(key => [key, { type: 'object', additionalProperties: false, properties: key === 'codex' ? { command } : { command, install: command } }])) },
    visual: { type: 'object', additionalProperties: false, properties: {
      mode: { enum: ['browser', 'native'] },
      prototypeBaseUrl: { type: 'string', pattern: '^https?://' },
      maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, pixelThreshold: { type: 'number', minimum: 0, maximum: 1 }, geometryTolerance: { type: 'number', minimum: 0 }, styleProperties: { type: 'array', items: { type: 'string' } },
      scenes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'prototypeUrl', 'applicationUrl', 'viewport'], properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' }, prototypeUrl: { type: 'string' }, applicationUrl: { type: 'string' }, viewport: { type: 'object', required: ['width', 'height'], additionalProperties: false, properties: { width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 } } }, deviceScaleFactor: { type: 'number', minimum: 0.5, maximum: 4 }, locale: { type: 'string' }, timezoneId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, colorScheme: { enum: ['light', 'dark', 'no-preference'] }, fixture: { type: 'object' }, mappings: { type: 'array', minItems: 1, items: { type: 'string' } }, masks: { type: 'array', items: selectorPair }, steps: { type: 'array', items: { type: 'object', required: ['action', 'prototype', 'application'], additionalProperties: false, properties: { action: { enum: ['click', 'fill'] }, prototype: { type: 'string' }, application: { type: 'string' }, value: { type: 'string' } } } }
      } } }
    } }
  }
};
const tier = { enum: ['required', 'advisory', 'off'] };
const shared = configSchema.properties;
/** schemaVersion 2: semantic anchors and per-platform targets replace component mappings (docs/proposals/0001). */
export const configSchemaV2 = {
  type: 'object', required: ['schemaVersion', 'prototypeDir', 'targets'], additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 }, prototypeDir: shared.prototypeDir, source: shared.source, runner: shared.runner,
    classification: shared.classification, policy: shared.policy, watch: shared.watch, adapters: shared.adapters,
    anchors: { type: 'object', additionalProperties: false, properties: {
      attribute: { type: 'string', pattern: '^data-[a-z0-9-]+$' }, requireScreenAnchor: { type: 'boolean' },
      tokens: { type: 'string', minLength: 1 }, ignore: { type: 'array', items: { type: 'string', minLength: 1 } }
    } },
    // One target per stream until multi-target queues (proposal phase P2).
    targets: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', required: ['id', 'platform', 'driver'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      platform: { enum: ['web', 'electron', 'ios', 'android', 'flutter', 'react-native'] },
      root: { type: 'string', minLength: 1 },
      driver: { type: 'object', required: ['kind'], additionalProperties: false, properties: {
        kind: { enum: ['playwright-web', 'external'] }, urlTemplate: { type: 'string', minLength: 1 }, command: shared.verification.properties.build
      } },
      build: shared.verification.properties.build, functional: shared.verification.properties.functional,
      locator: { type: 'object', additionalProperties: false, properties: { attribute: { type: 'string', pattern: '^data-[a-z0-9-]+$' }, strategy: { type: 'string', minLength: 1 } } },
      tiers: { type: 'object', additionalProperties: false, properties: { structure: tier, tokens: tier, layout: tier, visual: tier } },
      regression: { enum: ['all', 'affected', 'affected+smoke'] },
      viewport: { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 }, scale: { type: 'number', minimum: 0.5, maximum: 4 } } },
      visual: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['pixel', 'perceptual'] }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, pixelThreshold: { type: 'number', minimum: 0, maximum: 1 }, minSimilarity: { type: 'number', minimum: 0, maximum: 1 } } },
      layout: { type: 'object', additionalProperties: false, properties: { position: { type: 'number', minimum: 0, maximum: 1 }, size: { type: 'number', minimum: 0, maximum: 1 }, absolute: { anyOf: [{ type: 'null' }, { type: 'number', minimum: 0 }] } } },
      tokens: { type: 'object', additionalProperties: false, properties: { deltaE: { type: 'number', minimum: 0 }, fontSize: { type: 'number', minimum: 0 }, radius: { type: 'number', minimum: 0 } } },
      deviations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anchor', 'allow'], properties: { anchor: { type: 'string', minLength: 1 }, allow: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } } } },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 }
    } } }
  }
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(configSchema);
const validateV2 = ajv.compile(configSchemaV2);
async function loadConfigV2(root, config) {
  if (!validateV2(config)) throw new Error(`Invalid ProtoFlow config: ${JSON.stringify(validateV2.errors)}`);
  if (config.source) validateSource(config.source);
  await projectPath(root, config.prototypeDir);
  for (const evidence of [config.runner?.spec, config.runner?.adr].filter(Boolean)) await projectPath(root, evidence);
  if (config.anchors?.tokens) await projectPath(root, config.anchors.tokens);
  if (new Set(config.targets.map(target => target.id)).size !== config.targets.length) throw new Error('Duplicate target id');
  for (const target of config.targets) {
    if (target.root && target.root !== '.') await projectPath(root, target.root);
    if (target.driver.kind === 'playwright-web' && !target.driver.urlTemplate) throw new Error(`Target ${target.id}: playwright-web requires driver.urlTemplate`);
    if (target.driver.kind === 'external' && !target.driver.command) throw new Error(`Target ${target.id}: external driver requires driver.command`);
  }
  return config;
}
export async function loadConfig(root) {
  const config = await readJson(await projectPath(root, 'protoflow.config.json'));
  if (config?.schemaVersion === 2) return loadConfigV2(root, config);
  if (!validate(config)) throw new Error(`Invalid ProtoFlow config: ${JSON.stringify(validate.errors)}`);
  if (config.source) validateSource(config.source);
  await projectPath(root, config.prototypeDir);
  for (const evidence of [config.runner?.spec, config.runner?.adr].filter(Boolean)) await projectPath(root, evidence);
  for (const mapping of config.mappings) {
    await projectPath(root, mapping.component);
    for (const file of mapping.prototypeFiles) await projectPath(root, file);
  }
  for (const [key, entries] of [['mapping', config.mappings], ['scene', config.visual?.scenes ?? []]]) {
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error(`Duplicate ${key} id`);
  }
  return config;
}
