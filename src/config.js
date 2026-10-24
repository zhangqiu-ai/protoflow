import path from 'node:path';
import { validateSource } from './source.js';
import Ajv from 'ajv';
import { readJson, projectPath } from './util.js';

const command = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['argv'], properties: { argv: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000 } } }] };
const functionalCommand = { anyOf: [...command.anyOf, { type: 'object', additionalProperties: false, required: ['adapter'], properties: { adapter: { const: 'acceptance' } } }] };
const selectorPair = { type: 'object', required: ['prototype', 'application'], properties: { prototype: { type: 'string', minLength: 1 }, application: { type: 'string', minLength: 1 } }, additionalProperties: false };
export const configSchema = {
  type: 'object', required: ['schemaVersion', 'prototypeDir', 'mappings'], additionalProperties: false,
  properties: {
    source: { type: 'object', required: ['kind', 'repository', 'branch', 'path'], additionalProperties: false, properties: {
      kind: { const: 'git' }, repository: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, startSha: { type: 'string', pattern: '^[a-f0-9]{40}$' }
    } },
    runner: { type: 'object', additionalProperties: false, properties: { pollMs: { type: 'integer', minimum: 1000 }, applicationRef: { type: 'string', minLength: 1 }, setup: command, spec: { type: 'string', minLength: 1 }, adr: { type: 'string', minLength: 1 }, delivery: { type: 'object', additionalProperties: false, required: ['branch', 'baseBranch'], properties: { remote: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' }, branch: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$' }, baseBranch: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$' }, merge: { enum: ['auto', 'none', 'manual'] }, draft: { type: 'boolean' }, paths: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }, prBodyTrailers: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', maxLength: 500, pattern: '^[A-Za-z][A-Za-z0-9-]*: [^\\r\\n]*[^\\s]$' } } } } } },
    schemaVersion: { const: 1 }, prototypeDir: { type: 'string', minLength: 1 },
    mappings: { type: 'array', items: { type: 'object', required: ['id', 'prototypeFiles', 'prototype', 'application', 'component'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' }, prototypeFiles: { type: 'array', minItems: 1, items: { type: 'string' } }, prototype: { type: 'string', minLength: 1 }, application: { type: 'string', minLength: 1 }, component: { type: 'string', minLength: 1 }, priority: { enum: ['critical', 'high', 'normal', 'low'] }, geometryTolerance: { type: 'number', minimum: 0 }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }
    } } },
    classification: { type: 'object', additionalProperties: false, properties: { rules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pattern', 'level'], properties: { pattern: { type: 'string' }, level: { enum: ['L0', 'L1', 'L2', 'L3'] } } } } } },
    policy: { type: 'object', additionalProperties: false, properties: { maxRepairAttempts: { type: 'integer', minimum: 0, maximum: 10 }, stallRounds: { type: 'integer', minimum: 0, maximum: 10 }, transientRetries: { type: 'integer', minimum: 0, maximum: 5 }, transientRetryDelayMs: { type: 'integer', minimum: 0, maximum: 600000 }, requireHumanReview: { type: 'boolean' }, sequentialVersions: { type: 'boolean' }, autoApprove: { type: 'boolean' }, executor: { type: 'object', additionalProperties: false, required: ['primary'], properties: { primary: { enum: ['claude', 'codex'] }, fallback: { enum: ['claude', 'codex'] }, routes: { type: 'object', additionalProperties: false, properties: { frontend: { enum: ['claude', 'codex'] }, backend: { enum: ['claude', 'codex'] } } } } } } },
    watch: { type: 'object', additionalProperties: false, properties: { pollMs: { type: 'integer', minimum: 20 }, idleMs: { type: 'integer', minimum: 20 } } },
    // A desktop notification (macOS) when a version blocks or work waits for a person; on by default.
    notifications: { type: 'object', additionalProperties: false, properties: { desktop: { type: 'boolean' } } },
    // Proposal 0004: how the dashboard names the project and which person approves versions from it.
    dashboard: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, reviewer: { type: 'string', minLength: 1, maxLength: 120, not: { pattern: '^ai:' } } } },
    // Proposal 0003 §6: GitHub Issues intake, triage and implementation (schemaVersion 1 projects use one implicit target).
    issues: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
      enabled: { type: 'boolean' }, label: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' },
      authors: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'] } },
      targets: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      all: { type: 'boolean' }, maxTriagePerSync: { type: 'integer', minimum: 1, maximum: 20 }, remote: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' }
    } },
    verification: { type: 'object', additionalProperties: false, properties: { build: command, functional: functionalCommand } },
    adapters: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['codex', 'claude', 'planner', 'independentReview', 'specKit', 'bmad'].map(key => [key, { type: 'object', additionalProperties: false, properties: key === 'codex' ? { command, ignoreUserConfig: { type: 'boolean' } } : key === 'independentReview' ? { provider: { enum: ['claude', 'codex'] }, command } : ['claude', 'planner'].includes(key) ? { command } : { command, install: command } }])) },
    visual: { type: 'object', additionalProperties: false, properties: {
      mode: { enum: ['browser', 'native', 'adapter'] },
      prototypeBaseUrl: { type: 'string', pattern: '^https?://' },
      maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, pixelThreshold: { type: 'number', minimum: 0, maximum: 1 }, geometryTolerance: { type: 'number', minimum: 0 }, styleProperties: { type: 'array', items: { type: 'string' } },
      scenes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'prototypeUrl', 'applicationUrl', 'viewport'], properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' }, prototypeUrl: { type: 'string' }, applicationUrl: { type: 'string' }, viewport: { type: 'object', required: ['width', 'height'], additionalProperties: false, properties: { width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 } } }, deviceScaleFactor: { type: 'number', minimum: 0.5, maximum: 4 }, locale: { type: 'string' }, timezoneId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, colorScheme: { enum: ['light', 'dark', 'no-preference'] }, fixture: { type: 'object' }, mappings: { type: 'array', minItems: 1, items: { type: 'string' } }, masks: { type: 'array', items: selectorPair }, steps: { type: 'array', items: { type: 'object', required: ['action', 'prototype', 'application'], additionalProperties: false, properties: { action: { enum: ['click', 'fill'] }, prototype: { type: 'string' }, application: { type: 'string' }, value: { type: 'string' } } } }
      } } }
    } }
  }
};
const tier = { enum: ['required', 'advisory', 'off'] };
configSchema.properties.adapters.properties.acceptance = { type: 'object', additionalProperties: false, required: ['command'], properties: { command: command.anyOf[1], options: { type: 'object' } } };
const shared = configSchema.properties;
const driver = { type: 'object', required: ['kind'], additionalProperties: false, properties: {
  kind: { enum: ['playwright-web', 'playwright-electron', 'external'] }, urlTemplate: { type: 'string', minLength: 1 }, command: shared.verification.properties.build,
  // playwright-electron: entry relative to the target root, route template ('#/{screen}' or a page path), optional binary.
  main: { type: 'string', minLength: 1 }, route: { type: 'string', minLength: 1 }, executablePath: { type: 'string', minLength: 1 },
  args: { type: 'array', items: { type: 'string' } }, env: { type: 'object', additionalProperties: { type: 'string' } }
} };
const locator = { type: 'object', additionalProperties: false, properties: { attribute: { type: 'string', pattern: '^data-[a-z0-9-]+$' }, strategy: { type: 'string', minLength: 1 } } };
const targetTiers = { type: 'object', additionalProperties: false, properties: { structure: tier, tokens: tier, layout: tier, visual: tier } };
const regression = { enum: ['all', 'affected', 'affected+smoke'] };
const viewport = { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 }, scale: { type: 'number', minimum: 0.5, maximum: 4 } } };
const visual = { type: 'object', additionalProperties: false, properties: { mode: { enum: ['pixel', 'perceptual'] }, maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 }, pixelThreshold: { type: 'number', minimum: 0, maximum: 1 }, minSimilarity: { type: 'number', minimum: 0, maximum: 1 } } };
const layout = { type: 'object', additionalProperties: false, properties: { position: { type: 'number', minimum: 0, maximum: 1 }, size: { type: 'number', minimum: 0, maximum: 1 }, absolute: { anyOf: [{ type: 'null' }, { type: 'number', minimum: 0 }] } } };
const tokens = { type: 'object', additionalProperties: false, properties: { deltaE: { type: 'number', minimum: 0 }, fontSize: { type: 'number', minimum: 0 }, radius: { type: 'number', minimum: 0 } } };
const deviations = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anchor', 'allow'], properties: { anchor: { type: 'string', minLength: 1 }, allow: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } } } };
const timeoutMs = { type: 'integer', minimum: 100, maximum: 600000 };
/** schemaVersion 2: semantic anchors and per-platform targets replace component mappings (docs/proposals/0001). */
export const configSchemaV2 = {
  type: 'object', required: ['schemaVersion', 'prototypeDir', 'targets'], additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 }, prototypeDir: shared.prototypeDir, source: shared.source, runner: shared.runner,
    classification: shared.classification, policy: shared.policy, watch: shared.watch, notifications: shared.notifications, dashboard: shared.dashboard, adapters: shared.adapters,
    // Proposal 0003 §6: GitHub Issues intake, triage and (P5) implementation.
    issues: shared.issues,
    anchors: { type: 'object', additionalProperties: false, properties: {
      attribute: { type: 'string', pattern: '^data-[a-z0-9-]+$' }, requireScreenAnchor: { type: 'boolean' },
      tokens: { type: 'string', minLength: 1 }, ignore: { type: 'array', items: { type: 'string', minLength: 1 } }, scopeExclude: { type: 'array', items: { type: 'string', minLength: 1 } },
      dynamicText: { type: 'array', items: { type: 'string', minLength: 1 } }
    } },
    // Each target advances through the same prototype versions independently (proposal 0001 §15.1).
    release: { type: 'object', additionalProperties: false, properties: { requireTargets: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' } } } },
    targets: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'platform'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      platform: { enum: ['web', 'electron', 'ios', 'android', 'flutter', 'react-native'] },
      root: { type: 'string', minLength: 1 },
      driver,
      // One codebase, several runtimes (React Native, Flutter): the target stays the unit of FIFO and delivery and every
      // required variant must PASS (docs/proposals/0002 D5). Variant fields override the target's.
      variants: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'driver'], additionalProperties: false, properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, required: { type: 'boolean' }, driver, build: command,
        locator, tiers: targetTiers, regression, viewport, visual, layout, tokens, deviations, timeoutMs
      } } },
      build: command, functional: command,
      locator, tiers: targetTiers, regression, viewport, visual, layout, tokens, deviations, timeoutMs
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
  if (config.targets.length > 1) {
    // Separate roots let each target's application hash ignore the other targets' work.
    const roots = config.targets.map(target => (target.root ?? '.').replace(/\/+$/, ''));
    if (roots.some(item => item === '.' || item === '')) throw new Error('With several targets, every target needs its own root directory (not ".")');
    for (const [i, a] of roots.entries()) for (const [j, b] of roots.entries()) {
      if (i !== j && (a === b || a.startsWith(`${b}/`))) throw new Error(`Target roots must be distinct and not nested: ${a} and ${b}`);
    }
  }
  for (const id of config.release?.requireTargets ?? []) if (!config.targets.some(target => target.id === id)) throw new Error(`release.requireTargets names unknown target: ${id}`);
  for (const target of config.targets) {
    if (target.root && target.root !== '.') await projectPath(root, target.root);
    if (!target.driver === !target.variants) throw new Error(`Target ${target.id}: configure either driver or variants`);
    if (target.variants) {
      if (new Set(target.variants.map(variant => variant.id)).size !== target.variants.length) throw new Error(`Target ${target.id}: duplicate variant id`);
      if (!target.variants.some(variant => variant.required !== false)) throw new Error(`Target ${target.id}: at least one variant must be required`);
    }
    for (const { driver, label } of target.variants?.map(variant => ({ driver: variant.driver, label: `${target.id}/${variant.id}` })) ?? [{ driver: target.driver, label: target.id }]) {
      if (driver.kind === 'playwright-web' && !driver.urlTemplate) throw new Error(`Target ${label}: playwright-web requires driver.urlTemplate`);
      if (driver.kind === 'external' && !driver.command) throw new Error(`Target ${label}: external driver requires driver.command`);
      if (driver.kind === 'playwright-electron') {
        if (!driver.main || !driver.route) throw new Error(`Target ${label}: playwright-electron requires driver.main and driver.route`);
        await projectPath(root, path.posix.join(target.root ?? '.', driver.main));
        if (driver.executablePath) await projectPath(root, driver.executablePath);
      }
    }
  }
  return config;
}
export async function loadConfig(root) {
  const config = await readJson(await projectPath(root, 'protoflow.config.json'));
  if (config?.schemaVersion === 2) return loadConfigV2(root, config);
  if (!validate(config)) throw new Error(`Invalid ProtoFlow config: ${JSON.stringify(validate.errors)}`);
  if ((config.visual?.mode === 'adapter' || config.verification?.functional?.adapter === 'acceptance') && !config.adapters?.acceptance?.command) throw new Error('Configure adapters.acceptance.command for project acceptance');
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
