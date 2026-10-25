import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { staticContract } from './anchors.js';
import { superviseBrowser, urlFor } from './browser.js';
import { captureWeb } from './drivers/web.js';
import { captureExternal } from './drivers/external.js';
import { captureElectron, captureElectronPrototype } from './drivers/electron.js';
import { compareStructure, compareTokens, compareLayout, compareVisual, tierVerdict, flattenTokens, TIERS } from './tiers.js';
import { projectPath, writeJson, readJson, hash } from './util.js';
import { listWaivers, applyWaivers } from './waivers.js';
import { PNG } from 'pngjs';

const SAME_TECHNOLOGY = new Set(['web', 'electron']);
/** Defaults by platform: web-like targets can match pixels; native targets use relative layout and perceptual visuals. */
export function targetSettings(target) {
  const native = !SAME_TECHNOLOGY.has(target.platform);
  return {
    regression: target.regression ?? (native ? 'affected+smoke' : 'all'),
    tiers: { structure: 'required', tokens: 'required', layout: 'required', visual: native ? 'advisory' : 'required', ...target.tiers },
    viewport: { width: 1280, height: 800, scale: 1, ...target.viewport },
    locator: { attribute: 'data-testid', ...target.locator },
    layout: { position: 0.02, size: 0.05, absolute: null, ...target.layout },
    visual: { mode: native ? 'perceptual' : 'pixel', maxDiffRatio: 0.01, pixelThreshold: 0.1, minSimilarity: 0.92, ...target.visual },
    tokens: { deltaE: 3, fontSize: 1, radius: 1, ...target.tokens }
  };
}
/**
 * Capture configurations of a target: the target itself, or one per variant when one codebase runs on several
 * platforms (docs/proposals/0002 D5). Variant fields override the target's; `variant` and `required` are added.
 */
export function targetVariants(target) {
  if (!target.variants?.length) return [{ ...target, variant: null, required: true }];
  const { variants, ...base } = target;
  return variants.map(({ id, required, ...fields }) => ({ ...base, ...fields, id: target.id, variant: id, required: required !== false }));
}
/** The target a command acts on: the named one, the only one, or an error asking for --target. */
export function selectTarget(config, id) {
  if (!config.targets?.length) throw new Error('schemaVersion 2 requires at least one target');
  if (id) {
    const target = config.targets.find(item => item.id === id);
    if (!target) throw new Error(`Unknown target: ${id}`);
    return target;
  }
  if (config.targets.length > 1) throw new Error(`This project has several targets (${config.targets.map(item => item.id).join(', ')}); pass --target`);
  return config.targets[0];
}

/** Read a frozen version back into snapshot shape (text content for UTF-8 files). */
export async function versionFiles(root, version) {
  const files = {};
  for (const file of Object.keys(version.files)) {
    const bytes = await readFile(await projectPath(root, `${version.directory}/${file}`));
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary asset */ }
    files[file] = { hash: version.files[file].hash, ...(content === undefined ? { binary: true } : { content }) };
  }
  return { files, hash: version.hash };
}
export async function versionContract(root, config, version) {
  return staticContract(await versionFiles(root, version), config);
}

/** Screen × state pairs to verify: affected screens fully, plus the regression policy for the rest. */
export function scenesFor(contract, scope, regression) {
  const affected = new Set(scope?.affected ?? Object.keys(contract.screens));
  const scenes = [];
  for (const [screen, entry] of Object.entries(contract.screens)) {
    const all = affected.has(screen) || regression === 'all';
    if (!all && regression !== 'affected+smoke') continue;
    for (const state of all ? Object.keys(entry.states) : ['initial']) scenes.push({ screen, state, affected: affected.has(screen) });
  }
  return scenes;
}

/** Size problems of captures against the requested viewport: reported viewport and screenshot pixels must both match. */
export function captureSizeIssues(viewport, captures) {
  const scale = viewport.scale ?? 1;
  const pixels = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  const issues = [];
  for (const [side, capture] of Object.entries(captures)) {
    const reported = capture.viewport ?? {};
    if (reported.width !== viewport.width || reported.height !== viewport.height || (reported.scale ?? 1) !== scale) {
      issues.push(`${side} viewport ${reported.width}×${reported.height}@${reported.scale ?? 1} does not match requested ${viewport.width}×${viewport.height}@${scale}`);
    }
    if (capture.screenshot) {
      const image = PNG.sync.read(capture.screenshot);
      if (image.width !== pixels.width || image.height !== pixels.height) issues.push(`${side} screenshot ${image.width}×${image.height} px does not match requested ${pixels.width}×${pixels.height} px`);
    }
  }
  return issues;
}

function fillTemplate(template, { screen, page, state }, prototypeDir) {
  const relative = path.posix.relative(prototypeDir.split(path.sep).join('/'), page).replace(/\.html?$/i, '');
  return template.replaceAll('{screen}', screen).replaceAll('{page}', relative).replaceAll('{state}', state);
}

/** Capture request for one scene (schemas/driver-request.schema.json); web targets use the same fields internally. */
export function driverRequest(target, settings, scene, screen, state, outputDir) {
  const anchors = [...new Set([...screen.anchors.map(anchor => anchor.id), ...state.expect.visible, ...state.expect.hidden])];
  return {
    schemaVersion: 1, kind: 'capture', target: { id: target.id, platform: target.platform, root: target.root ?? '.', ...(target.variant && { variant: target.variant }) },
    screen: scene.screen, state: scene.state, page: screen.page,
    fixture: { name: state.fixture, data: state.fixture ? screen.fixtures[state.fixture] : {} },
    steps: state.steps, anchors, viewport: settings.viewport, outputDir
  };
}

/** Run a capture, and once more if it produced no result (NOT_RUN); the retried outcome records the first reason. */
export async function retryNotRun(capture, signal) {
  const first = await capture();
  if (first.status !== 'NOT_RUN' || signal?.aborted) return first;
  const second = await capture();
  return { ...second, retried: { status: first.status, reason: String(first.reason ?? '').slice(-500) } };
}

async function captureApplication(root, config, target, settings, browser, scene, request, hooks) {
  if (target.driver?.kind === 'external') {
    // External drivers are supervised child processes like the browser itself. A capture that produced no result
    // (NOT_RUN: the simulator or the test runner failed, as XCUITest does now and then) is taken once more before the
    // scene is reported NOT_RUN; an application that cannot reach the state (FAIL) is never retried.
    const capture = async () => {
      let pid = null;
      await hooks.onBeforeSpawn?.('visual-driver');
      const outcome = await captureExternal(root, target, request, { signal: hooks.signal, onStart: async childPid => { pid = childPid; await hooks.onStart?.('visual-driver', childPid); } });
      await hooks.onFinish?.('visual-driver', pid, { status: outcome.status, processGroupActive: false });
      return outcome;
    };
    return retryNotRun(capture, hooks.signal);
  }
  if (target.driver?.kind === 'playwright-electron') return captureElectron(root, target, settings, request, hooks);
  if (target.driver?.kind !== 'playwright-web') return { status: 'NOT_RUN', reason: `driver kind ${target.driver?.kind} is not available in this phase` };
  const template = target.driver.urlTemplate;
  if (!template) return { status: 'FAIL', reason: 'playwright-web target requires driver.urlTemplate' };
  const filled = fillTemplate(template, { ...scene, page: request.page }, config.prototypeDir);
  let url;
  try { url = /^https?:/.test(filled) ? filled : await urlFor(root, filled); }
  catch (error) { return { status: 'FAIL', reason: `application screen ${scene.screen} is not reachable at ${filled}: ${error.message}` }; }
  try {
    return { status: 'PASS', capture: await captureWeb(browser, { url, attribute: settings.locator.attribute, anchors: request.anchors, steps: request.steps, dynamicText: config.anchors?.dynamicText, fixture: request.fixture.data, viewport: settings.viewport, timeoutMs: target.timeoutMs }) };
  } catch (error) { return { status: 'FAIL', reason: `application could not reach ${scene.screen}.${scene.state}: ${error.message.split('\n')[0]}` }; }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function renderReport(target, scenes, waivers = []) {
  const rows = scenes.map(scene => {
    const tiers = TIERS.map(tier => { const status = scene.tiers[tier]?.status ?? 'NOT_RUN', waiver = scene.tiers[tier]?.waiver; return `<td class="${escapeHtml(waiver ? 'WAIVED' : status)}">${escapeHtml(status)}${waiver ? ` (waived: ${escapeHtml(waiver.id)})` : ''}</td>`; }).join('');
    const waived = waivers.filter(item => item.scene === scene.id).map(item => `Waiver ${item.id} (${item.tier}): ${item.reason}${item.engineIssue ? ` — ${item.engineIssue}` : ''}; the ${item.tier} findings below were waived by a maintainer`);
    const skipped = (scene.waiverSkipped ?? []).map(item => `Waiver ${item.id} (${item.tier}) not applied: ${item.why}`);
    const reasons = [scene.reason, ...waived, ...skipped, ...TIERS.flatMap(tier => (scene.tiers[tier]?.reasons ?? []).map(reason => `${tier}: ${reason}`))].filter(Boolean);
    const image = name => scene.artifacts.find(file => file.endsWith(`/${name}.png`));
    const images = ['prototype', 'application', 'diff'].filter(image).map(name => `<figure><figcaption>${name}</figcaption><img alt="${name}" src="${escapeHtml(path.relative(path.dirname(scene.reportDir), image(name)))}"></figure>`).join('');
    return `<section><h2>${escapeHtml(scene.id)} — ${escapeHtml(scene.status)}</h2><table><tr><th>structure</th><th>tokens</th><th>layout</th><th>visual</th></tr><tr>${tiers}</tr></table><ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul><div class="images">${images}</div></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ProtoFlow anchor review</title><style>body{font:15px system-ui;margin:24px;background:#fafafa;color:#111}section{border:1px solid #ddd;background:#fff;padding:16px;margin:20px 0}td,th{border:1px solid #ddd;padding:4px 10px}.PASS{color:#06713b}.FAIL{color:#b00020;font-weight:700}.NOT_RUN{color:#8a6d00}.WAIVED{color:#7a4cc2;font-weight:700}.images{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;max-width:32%}img{max-width:100%;border:1px solid #eee}</style><h1>ProtoFlow anchor review — target ${escapeHtml(target.id)}${target.variant ? ` / ${escapeHtml(target.variant)}` : ''} (${escapeHtml(target.platform)})</h1><p>T1 structure, T2 tokens, T3 layout, T4 visual. Required tiers decide acceptance; advisory tiers are informational. A tier marked waived failed, and a maintainer approved a waiver for exactly these findings of this prototype version.</p>${rows}</html>`;
}

function summarize(scenes, policy) {
  const tiers = {};
  for (const tier of TIERS) {
    // A waived tier keeps FAIL on its scene; the summary is the gate's view and counts it separately.
    const statuses = scenes.map(scene => scene.tiers[tier]?.waiver ? 'PASS' : scene.tiers[tier]?.status ?? 'NOT_RUN');
    const waived = scenes.filter(scene => scene.tiers[tier]?.waiver).length;
    tiers[tier] = { policy: policy[tier] ?? 'required', status: statuses.includes('FAIL') ? 'FAIL' : statuses.length && statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT_RUN', ...(waived && { waived }) };
  }
  return tiers;
}

/**
 * Verify one target against a frozen prototype version. Returns a visual-phase result compatible with verification
 * records: { status, mode: 'anchors', target, tiers, scenes, artifacts, prototypeSource: 'version' }. A target with
 * variants is verified on each variant; it passes when every required variant passes, and the result adds `variants`.
 */
export async function verifyTarget(root, config, manifest, version, { target: targetId, build = null, ...options } = {}) {
  const variants = targetVariants(selectTarget(config, targetId));
  // Captures need a working build: an app whose build failed cannot start, and every scene would wait out the driver's
  // launch timeout instead. A capture configuration whose build did not pass is skipped with the build's verdict.
  const skipped = (variant, phase, result) => ({
    status: 'NOT_RUN', mode: 'anchors', target: variant.id, platform: variant.platform,
    reason: `${phase} ${result?.status ?? 'NOT_RUN'}; captures skipped`, scenes: [], artifacts: [], prototypeSource: 'version',
    tiers: Object.fromEntries(TIERS.map(tier => [tier, { status: 'NOT_RUN', reasons: [`${phase} did not pass`] }]))
  });
  if (!variants[0].variant) {
    if (build && build.status !== 'PASS') return skipped(variants[0], 'build', build);
    return verifyVariant(root, config, manifest, version, variants[0], options);
  }
  const results = [];
  for (const variant of variants) {
    if (options.signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    // A failed target build leaves no variant builds; a variant without its own build relies on the target build.
    const own = build?.variants?.[variant.variant];
    const failed = build && (own ? own.status !== 'PASS' : build.status !== 'PASS' && !Object.keys(build.variants ?? {}).length);
    results.push({ variant, result: failed ? skipped(variant, own ? `build:${variant.variant}` : 'build', own ?? build) : await verifyVariant(root, config, manifest, version, variant, options) });
  }
  const combine = statuses => statuses.includes('FAIL') ? 'FAIL' : statuses.length && statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT_RUN';
  const required = results.filter(item => item.variant.required);
  const tiers = Object.fromEntries(TIERS.map(tier => [tier, {
    policy: required.some(item => item.result.tiers?.[tier]?.policy === 'required') ? 'required' : required[0]?.result.tiers?.[tier]?.policy ?? 'required',
    status: combine(required.map(item => item.result.tiers?.[tier]?.status ?? 'NOT_RUN')),
    ...(results.some(item => item.result.tiers?.[tier]?.waived) && { waived: results.reduce((sum, item) => sum + (item.result.tiers?.[tier]?.waived ?? 0), 0) })
  }]));
  const failing = results.filter(item => item.result.status !== 'PASS').map(item => `${item.variant.variant}${item.variant.required ? '' : ' (optional)'}: ${item.result.reason ?? item.result.status}`);
  const first = results[0].result;
  return {
    status: combine(required.map(item => item.result.status)), mode: 'anchors', target: first.target, platform: first.platform, regression: first.regression, tiers,
    scenes: results.flatMap(item => (item.result.scenes ?? []).map(scene => ({ ...scene, variant: item.variant.variant }))),
    artifacts: results.flatMap(item => item.result.artifacts ?? []), prototypeSource: 'version', contract: first.contract,
    ...(results.some(item => item.result.waivers?.length) && { waivers: results.flatMap(item => item.result.waivers ?? []) }),
    variants: Object.fromEntries(results.map(item => [item.variant.variant, { required: item.variant.required, status: item.result.status, tiers: item.result.tiers, ...(item.result.reason && { reason: item.result.reason }) }])),
    ...(failing.length && { reason: failing.join('; ') })
  };
}

/** Verify one capture configuration (a target, or one variant of it). */
async function verifyVariant(root, config, manifest, version, target, { outDir, signal, onBeforeSpawn, onStart, onFinish } = {}) {
  const settings = targetSettings(target);
  // Evidence of a variant lives under <target>/<variant>; a plain target keeps <target>.
  const segments = [target.id, ...(target.variant ? [target.variant] : [])];
  const reportFile = target.variant ? path.join(outDir, ...segments, 'report.html') : path.join(outDir, 'report.html');
  const contract = await versionContract(root, config, version);
  if (contract.errors.length) return { status: 'FAIL', mode: 'anchors', target: target.id, reason: `Prototype contract is invalid: ${contract.errors.join('; ')}`, scenes: [], artifacts: [], prototypeSource: 'version' };
  const scenes = scenesFor(contract, manifest.scope, settings.regression);
  if (!scenes.length) return { status: 'NOT_RUN', mode: 'anchors', target: target.id, reason: 'No screens to verify for this version', scenes: [], artifacts: [], prototypeSource: 'version' };
  let tokens = [];
  if (config.anchors?.tokens && version.files[config.anchors.tokens]) {
    tokens = flattenTokens(JSON.parse(await readFile(await projectPath(root, `${version.directory}/${config.anchors.tokens}`), 'utf8')));
  }
  const attribute = config.anchors?.attribute ?? 'data-pf';
  const hooks = { signal, onBeforeSpawn, onStart, onFinish };
  const outRelative = path.relative(await realpath(root), outDir).split(path.sep).join('/');
  const waivers = await listWaivers(root), manifestHash = hash(manifest);
  const run = async browser => {
    const results = [], usedWaivers = [];
    const artifacts = [];
    for (const scene of scenes) {
      if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
      const screen = contract.screens[scene.screen];
      const state = screen.states[scene.state];
      const id = `${scene.screen}.${scene.state}`;
      const sceneDir = path.join(outDir, ...segments, id);
      await mkdir(sceneDir, { recursive: true });
      const entry = { id, screen: scene.screen, state: scene.state, affected: scene.affected, status: 'FAIL', tiers: {}, artifacts: [], reportDir: reportFile };
      const request = driverRequest(target, settings, scene, screen, state, `${outRelative}/${segments.join('/')}/${id}/driver`);
      const { anchors } = request;
      let prototype;
      const prototypeUrl = pathToFileURL(await projectPath(root, `${version.directory}/${screen.page}`)).href;
      if (target.driver?.kind === 'playwright-electron') {
        // Same engine on both sides: the frozen prototype is rendered by the target's Electron build.
        const reference = await captureElectronPrototype(root, target, settings, request, { url: prototypeUrl, attribute }, hooks);
        if (reference.runtime) {
          const runtimeFile = path.join(sceneDir, 'prototype-runtime.json');
          await writeFile(runtimeFile, `${JSON.stringify(reference.runtime, null, 2)}\n`);
          entry.artifacts.push(runtimeFile);
          entry.prototypeRuntime = reference.runtime;
        }
        if (reference.status !== 'PASS') {
          entry.status = reference.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL';
          entry.reason = reference.status === 'NOT_RUN' ? reference.reason : `prototype state is unreachable: ${reference.reason}`;
          for (const tier of TIERS) entry.tiers[tier] = { status: entry.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL', reasons: [entry.reason] };
          artifacts.push(...entry.artifacts); results.push(entry); continue;
        }
        prototype = reference.capture;
      } else {
        try {
          prototype = await captureWeb(browser, { url: prototypeUrl, attribute, anchors, steps: state.steps, dynamicText: config.anchors?.dynamicText, fixture: request.fixture.data, viewport: settings.viewport });
        } catch (error) {
          entry.reason = `prototype state is unreachable: ${error.message.split('\n')[0]}`;
          results.push(entry); continue;
        }
      }
      const app = await captureApplication(root, config, target, settings, browser, scene, request, hooks);
      if (app.retried) entry.captureRetry = app.retried;
      const write = async (name, buffer) => { const file = path.join(sceneDir, `${name}.png`); await writeFile(file, buffer); entry.artifacts.push(file); };
      await write('prototype', prototype.screenshot);
      if (app.runtime) {
        // Electron runtime evidence: versions, executable, PID, route, actual viewport and exit.
        const runtimeFile = path.join(sceneDir, 'runtime.json');
        await writeFile(runtimeFile, `${JSON.stringify(app.runtime, null, 2)}\n`);
        entry.artifacts.push(runtimeFile);
        entry.runtime = app.runtime;
      }
      if (app.status !== 'PASS') {
        entry.status = app.status; entry.reason = app.reason;
        for (const tier of TIERS) entry.tiers[tier] = { status: app.status === 'FAIL' ? 'FAIL' : 'NOT_RUN', reasons: [app.reason] };
      } else {
        if (app.capture.screenshot) await write('application', app.capture.screenshot);
        // Every driver must capture at exactly the requested size; equal but wrong sizes on both sides are not a match.
        const sizeIssues = captureSizeIssues(settings.viewport, { prototype, application: app.capture });
        if (sizeIssues.length) {
          entry.status = 'FAIL'; entry.reason = sizeIssues.join('; ');
          for (const tier of TIERS) entry.tiers[tier] = { status: 'FAIL', reasons: sizeIssues };
          artifacts.push(...entry.artifacts); results.push(entry); continue;
        }
        // Reviewed platform conventions (target.deviations): an anchor allowed to differ in a tier is left out of that
        // tier's comparison; the screen anchor always stays. Structure (T1) never has a deviation.
        const deviated = tier => new Set((target.deviations ?? []).filter(item => item.allow.includes(tier)).map(item => item.anchor));
        const without = tier => { const skip = deviated(tier); return skip.size ? { ...screen, anchors: screen.anchors.filter(anchor => anchor.role === 'screen' || !skip.has(anchor.id)) } : screen; };
        const tiers = {
          structure: compareStructure(screen, state, prototype, app.capture, { native: !['web', 'electron'].includes(target.platform) }),
          tokens: compareTokens(without('tokens'), prototype, app.capture, { tokens, ...settings.tokens }),
          layout: compareLayout(scene.screen, without('layout'), prototype, app.capture, { ...settings.layout, viewport: settings.viewport }),
          visual: compareVisual(without('visual'), prototype, app.capture, settings.visual)
        };
        const applied = (target.deviations ?? []).filter(item => screen.anchors.some(anchor => anchor.id === item.anchor));
        if (applied.length) entry.deviations = applied;
        if (tiers.visual.images?.diff) await write('diff', tiers.visual.images.diff);
        for (const tier of TIERS) {
          const { images, ...rest } = tiers[tier];
          entry.tiers[tier] = settings.tiers[tier] === 'off' ? { status: 'NOT_RUN', reasons: ['tier is off for this target'] } : rest;
        }
        // Proposal 0005: an approved maintainer waiver lets a failed T1–T3 tier pass the gate while it keeps its findings.
        const exempt = applyWaivers(waivers, { target: target.id, manifestHash, scene: { id, variant: target.variant ?? null, tiers: entry.tiers }, policy: settings.tiers });
        entry.status = tierVerdict(exempt.gate, settings.tiers);
        if (exempt.applied.length) { entry.waived = exempt.applied.map(item => ({ tier: item.tier, waiverId: item.id })); usedWaivers.push(...exempt.applied); }
        if (exempt.skipped.length) entry.waiverSkipped = exempt.skipped;
        const elements = path.join(sceneDir, 'elements.json');
        await writeFile(elements, `${JSON.stringify({ prototype: prototype.elements, application: app.capture.elements }, null, 2)}\n`);
        entry.artifacts.push(elements);
      }
      artifacts.push(...entry.artifacts);
      results.push(entry);
    }
    const report = reportFile;
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, renderReport(target, results, usedWaivers));
    artifacts.push(report);
    const statuses = results.map(scene => scene.status);
    const status = statuses.includes('FAIL') ? 'FAIL' : statuses.every(item => item === 'PASS') ? 'PASS' : 'NOT_RUN';
    const failing = results.filter(scene => scene.status !== 'PASS').map(scene => `${scene.id}: ${scene.reason ?? TIERS.filter(tier => scene.tiers[tier]?.status === 'FAIL').join(', ')}`);
    return { status, mode: 'anchors', target: target.id, platform: target.platform, regression: settings.regression, tiers: summarize(results, settings.tiers), scenes: results.map(({ reportDir, ...scene }) => scene), artifacts, prototypeSource: 'version', contract: { extractorVersion: contract.extractorVersion, screens: Object.keys(contract.screens) }, ...(usedWaivers.length && { waivers: usedWaivers }), ...(failing.length && { reason: failing.join('; ') }) };
  };
  return superviseBrowser(outDir, hooks, run);
}

const SKIP_DIRS = new Set(['.git', '.protoflow', 'node_modules', 'test-results', 'playwright-report', 'build', 'dist', '.gradle', 'DerivedData', 'Pods']);
/** Where each anchor ID literally appears in the target's code: a hint for the executor, rebuilt after each PASS. */
export async function updateAnchorIndex(root, config, contract, targetId) {
  const target = selectTarget(config, targetId);
  const projectRoot = await realpath(root);
  const base = target.root && target.root !== '.' ? await projectPath(root, target.root) : projectRoot;
  const ids = [...new Set(Object.values(contract.screens).flatMap(screen => screen.anchors.map(anchor => anchor.id)))];
  const anchors = Object.fromEntries(ids.map(id => [id, []]));
  const prototypeDir = await projectPath(root, config.prototypeDir);
  const walk = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (SKIP_DIRS.has(item.name)) continue;
      const file = path.join(directory, item.name);
      if (file === prototypeDir) continue;
      if (item.isDirectory()) { await walk(file); continue; }
      if (!item.isFile() || (await stat(file)).size > 1024 * 1024) continue;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)); } catch { continue; }
      const lines = text.split('\n');
      for (const id of ids) {
        const quoted = [`"${id}"`, `'${id}'`, `\`${id}\``];
        lines.forEach((line, index) => { if (quoted.some(token => line.includes(token))) anchors[id].push({ file: path.relative(projectRoot, file).split(path.sep).join('/'), line: index + 1 }); });
      }
    }
  };
  await walk(base);
  const index = { schemaVersion: 1, target: target.id, updatedAt: new Date().toISOString(), anchors };
  await writeJson(await projectPath(root, `.protoflow/targets/${target.id}/anchor-index.json`), index);
  return index;
}
export async function anchorIndex(root, config, targetId) {
  return readJson(await projectPath(root, `.protoflow/targets/${selectTarget(config, targetId).id}/anchor-index.json`), null);
}
