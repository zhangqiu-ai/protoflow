import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { staticContract } from './anchors.js';
import { superviseBrowser, urlFor } from './browser.js';
import { captureWeb } from './drivers/web.js';
import { captureExternal } from './drivers/external.js';
import { compareStructure, compareTokens, compareLayout, compareVisual, tierVerdict, flattenTokens, TIERS } from './tiers.js';
import { projectPath, writeJson, readJson } from './util.js';

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
/** P1 runs one target per stream; multi-target queues are phase P2. */
export function primaryTarget(config) {
  if (!config.targets?.length) throw new Error('schemaVersion 2 requires at least one target');
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

function fillTemplate(template, { screen, page, state }, prototypeDir) {
  const relative = path.posix.relative(prototypeDir.split(path.sep).join('/'), page).replace(/\.html?$/i, '');
  return template.replaceAll('{screen}', screen).replaceAll('{page}', relative).replaceAll('{state}', state);
}

/** Capture request for one scene (schemas/driver-request.schema.json); web targets use the same fields internally. */
export function driverRequest(target, settings, scene, screen, state, outputDir) {
  const anchors = [...new Set([...screen.anchors.map(anchor => anchor.id), ...state.expect.visible, ...state.expect.hidden])];
  return {
    schemaVersion: 1, kind: 'capture', target: { id: target.id, platform: target.platform, root: target.root ?? '.' },
    screen: scene.screen, state: scene.state, page: screen.page,
    fixture: { name: state.fixture, data: state.fixture ? screen.fixtures[state.fixture] : {} },
    steps: state.steps, anchors, viewport: settings.viewport, outputDir
  };
}

async function captureApplication(root, config, target, settings, browser, scene, request, hooks) {
  if (target.driver?.kind === 'external') {
    // External drivers are supervised child processes like the browser itself.
    let pid = null;
    await hooks.onBeforeSpawn?.('visual-driver');
    const outcome = await captureExternal(root, target, request, { signal: hooks.signal, onStart: async childPid => { pid = childPid; await hooks.onStart?.('visual-driver', childPid); } });
    await hooks.onFinish?.('visual-driver', pid, { status: outcome.status, processGroupActive: false });
    return outcome;
  }
  if (target.driver?.kind !== 'playwright-web') return { status: 'NOT_RUN', reason: `driver kind ${target.driver?.kind} is not available in this phase` };
  const template = target.driver.urlTemplate;
  if (!template) return { status: 'FAIL', reason: 'playwright-web target requires driver.urlTemplate' };
  const filled = fillTemplate(template, { ...scene, page: request.page }, config.prototypeDir);
  let url;
  try { url = /^https?:/.test(filled) ? filled : await urlFor(root, filled); }
  catch (error) { return { status: 'FAIL', reason: `application screen ${scene.screen} is not reachable at ${filled}: ${error.message}` }; }
  try {
    return { status: 'PASS', capture: await captureWeb(browser, { url, attribute: settings.locator.attribute, anchors: request.anchors, steps: request.steps, fixture: request.fixture.data, viewport: settings.viewport, timeoutMs: target.timeoutMs }) };
  } catch (error) { return { status: 'FAIL', reason: `application could not reach ${scene.screen}.${scene.state}: ${error.message.split('\n')[0]}` }; }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function renderReport(target, scenes) {
  const rows = scenes.map(scene => {
    const tiers = TIERS.map(tier => `<td class="${escapeHtml(scene.tiers[tier]?.status ?? 'NOT_RUN')}">${escapeHtml(scene.tiers[tier]?.status ?? 'NOT_RUN')}</td>`).join('');
    const reasons = [scene.reason, ...TIERS.flatMap(tier => (scene.tiers[tier]?.reasons ?? []).map(reason => `${tier}: ${reason}`))].filter(Boolean);
    const image = name => scene.artifacts.find(file => file.endsWith(`/${name}.png`));
    const images = ['prototype', 'application', 'diff'].filter(image).map(name => `<figure><figcaption>${name}</figcaption><img alt="${name}" src="${escapeHtml(path.relative(path.dirname(scene.reportDir), image(name)))}"></figure>`).join('');
    return `<section><h2>${escapeHtml(scene.id)} — ${escapeHtml(scene.status)}</h2><table><tr><th>structure</th><th>tokens</th><th>layout</th><th>visual</th></tr><tr>${tiers}</tr></table><ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul><div class="images">${images}</div></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ProtoFlow anchor review</title><style>body{font:15px system-ui;margin:24px;background:#fafafa;color:#111}section{border:1px solid #ddd;background:#fff;padding:16px;margin:20px 0}td,th{border:1px solid #ddd;padding:4px 10px}.PASS{color:#06713b}.FAIL{color:#b00020;font-weight:700}.NOT_RUN{color:#8a6d00}.images{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;max-width:32%}img{max-width:100%;border:1px solid #eee}</style><h1>ProtoFlow anchor review — target ${escapeHtml(target.id)} (${escapeHtml(target.platform)})</h1><p>T1 structure, T2 tokens, T3 layout, T4 visual. Required tiers decide acceptance; advisory tiers are informational.</p>${rows}</html>`;
}

function summarize(scenes, policy) {
  const tiers = {};
  for (const tier of TIERS) {
    const statuses = scenes.map(scene => scene.tiers[tier]?.status ?? 'NOT_RUN');
    tiers[tier] = { policy: policy[tier] ?? 'required', status: statuses.includes('FAIL') ? 'FAIL' : statuses.length && statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT_RUN' };
  }
  return tiers;
}

/**
 * Verify one target against a frozen prototype version. Returns a visual-phase result compatible with verification
 * records: { status, mode: 'anchors', target, tiers, scenes, artifacts, prototypeSource: 'version' }.
 */
export async function verifyTarget(root, config, manifest, version, { outDir, signal, onBeforeSpawn, onStart, onFinish } = {}) {
  const target = primaryTarget(config);
  const settings = targetSettings(target);
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
  const run = async browser => {
    const results = [];
    const artifacts = [];
    for (const scene of scenes) {
      if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
      const screen = contract.screens[scene.screen];
      const state = screen.states[scene.state];
      const id = `${scene.screen}.${scene.state}`;
      const sceneDir = path.join(outDir, target.id, id);
      await mkdir(sceneDir, { recursive: true });
      const entry = { id, screen: scene.screen, state: scene.state, affected: scene.affected, status: 'FAIL', tiers: {}, artifacts: [], reportDir: path.join(outDir, 'report.html') };
      const request = driverRequest(target, settings, scene, screen, state, `${outRelative}/${target.id}/${id}/driver`);
      const { anchors } = request;
      let prototype;
      try {
        const url = pathToFileURL(await projectPath(root, `${version.directory}/${screen.page}`)).href;
        prototype = await captureWeb(browser, { url, attribute, anchors, steps: state.steps, fixture: request.fixture.data, viewport: settings.viewport });
      } catch (error) {
        entry.reason = `prototype state is unreachable: ${error.message.split('\n')[0]}`;
        results.push(entry); continue;
      }
      const app = await captureApplication(root, config, target, settings, browser, scene, request, hooks);
      const write = async (name, buffer) => { const file = path.join(sceneDir, `${name}.png`); await writeFile(file, buffer); entry.artifacts.push(file); };
      await write('prototype', prototype.screenshot);
      if (app.status !== 'PASS') {
        entry.status = app.status; entry.reason = app.reason;
        for (const tier of TIERS) entry.tiers[tier] = { status: app.status === 'FAIL' ? 'FAIL' : 'NOT_RUN', reasons: [app.reason] };
      } else {
        if (app.capture.screenshot) await write('application', app.capture.screenshot);
        const tiers = {
          structure: compareStructure(screen, state, prototype, app.capture),
          tokens: compareTokens(screen, prototype, app.capture, { tokens, ...settings.tokens }),
          layout: compareLayout(scene.screen, screen, prototype, app.capture, settings.layout),
          visual: compareVisual(screen, prototype, app.capture, settings.visual)
        };
        if (tiers.visual.images?.diff) await write('diff', tiers.visual.images.diff);
        for (const tier of TIERS) {
          const { images, ...rest } = tiers[tier];
          entry.tiers[tier] = settings.tiers[tier] === 'off' ? { status: 'NOT_RUN', reasons: ['tier is off for this target'] } : rest;
        }
        entry.status = tierVerdict(entry.tiers, settings.tiers);
        const elements = path.join(sceneDir, 'elements.json');
        await writeFile(elements, `${JSON.stringify({ prototype: prototype.elements, application: app.capture.elements }, null, 2)}\n`);
        entry.artifacts.push(elements);
      }
      artifacts.push(...entry.artifacts);
      results.push(entry);
    }
    const report = path.join(outDir, 'report.html');
    await writeFile(report, renderReport(target, results));
    artifacts.push(report);
    const statuses = results.map(scene => scene.status);
    const status = statuses.includes('FAIL') ? 'FAIL' : statuses.every(item => item === 'PASS') ? 'PASS' : 'NOT_RUN';
    const failing = results.filter(scene => scene.status !== 'PASS').map(scene => `${scene.id}: ${scene.reason ?? TIERS.filter(tier => scene.tiers[tier]?.status === 'FAIL').join(', ')}`);
    return { status, mode: 'anchors', target: target.id, platform: target.platform, regression: settings.regression, tiers: summarize(results, settings.tiers), scenes: results.map(({ reportDir, ...scene }) => scene), artifacts, prototypeSource: 'version', contract: { extractorVersion: contract.extractorVersion, screens: Object.keys(contract.screens) }, ...(failing.length && { reason: failing.join('; ') }) };
  };
  return superviseBrowser(outDir, hooks, run);
}

const SKIP_DIRS = new Set(['.git', '.protoflow', 'node_modules', 'test-results', 'playwright-report', 'build', 'dist', '.gradle', 'DerivedData', 'Pods']);
/** Where each anchor ID literally appears in the target's code: a hint for the executor, rebuilt after each PASS. */
export async function updateAnchorIndex(root, config, contract) {
  const target = primaryTarget(config);
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
export async function anchorIndex(root, config) {
  return readJson(await projectPath(root, `.protoflow/targets/${primaryTarget(config).id}/anchor-index.json`), null);
}
