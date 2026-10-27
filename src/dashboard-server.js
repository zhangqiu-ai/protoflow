import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash } from './util.js';
import { listProjects, dashboardSnapshot } from './dashboard-data.js';
import { runAction } from './dashboard-actions.js';
import { serviceStatus } from './runner-service.js';

/**
 * Proposal 0004 D2: the local dashboard. Listens on 127.0.0.1 only, serves the page and its assets from the engine,
 * project snapshots as JSON and as server-sent events, screenshots from a project's .protoflow/artifacts, and the D3
 * actions behind a per-start token embedded in the page. Host and Origin are checked so another site cannot reach it.
 */
const ASSETS = fileURLToPath(new URL('../dashboard/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const IMAGE = /^\.protoflow\/artifacts\/[A-Za-z0-9._/-]+\.(png|jpe?g)$/;
// Fields that change every second without new information; a push (and a redraw) happens only when anything else changes.
const VOLATILE = new Set(['generatedAt', 'beatAgeSeconds']);
const stable = data => hash(JSON.stringify(data, (key, value) => VOLATILE.has(key) ? undefined : value));

/** What a project card shows per target: where it is, for how long, and the executor's latest action while it works. */
export function overviewStream(stream) {
  const live = stream.live?.running ? { executor: stream.live.executor, model: stream.live.model, subagentModel: stream.live.subagentModel ?? null, totals: stream.live.totals, last: stream.live.actions.at(-1) ?? null } : null;
  return { target: stream.target, stage: stream.stage, phase: stream.phase, phaseStartedAt: stream.phaseStartedAt, deviceWait: stream.deviceWait ?? null, paused: stream.paused === true, stopped: stream.stopped === true,
    current: stream.current && { summary: stream.current.summary, status: stream.current.status, manifestId: stream.current.manifestId, attempts: stream.current.attempts, attemptStartedAt: stream.current.attemptStartedAt, error: stream.current.error },
    live, lastEvent: stream.lastEvent ? { event: stream.lastEvent.event, at: stream.lastEvent.at } : null, lastDelivery: stream.deliveries[0] ?? null };
}

export function createDashboardServer({ home = os.homedir(), host = '127.0.0.1', port = 7420, token = randomBytes(24).toString('hex'), pollMs = 3000, healthTtlMs = 20000, service = process.platform === 'darwin', actions = runAction, snapshotOf = dashboardSnapshot } = {}) {
  const healthCache = new Map();
  const health = async root => {
    if (!service) return null;
    const cached = healthCache.get(root);
    if (cached && Date.now() - cached.at < healthTtlMs) return cached.value;
    const value = await serviceStatus(root).catch(error => ({ status: 'UNKNOWN', reason: error.message }));
    healthCache.set(root, { at: Date.now(), value });
    return value;
  };
  const project = async id => (await listProjects({ home })).find(item => item.id === id) ?? null;
  // The overview and a project page polling in the same moment read the project once.
  const recent = new Map();
  const snapshot = entry => {
    const hit = recent.get(entry.root);
    if (hit && Date.now() - hit.at < pollMs / 2) return hit.promise;
    const promise = health(entry.root).then(known => snapshotOf(entry.root, { health: known }));
    recent.set(entry.root, { at: Date.now(), promise });
    promise.catch(() => recent.delete(entry.root));
    return promise;
  };
  const overview = async () => {
    const out = [];
    for (const entry of await listProjects({ home })) {
      try {
        const view = await snapshot(entry);
        out.push({ id: entry.id, name: entry.name, root: entry.root, paused: view.project.paused ?? null, service: view.service, roles: view.roles, attention: view.attention.length, inbox: view.attention, streams: view.streams.map(overviewStream), issues: { open: view.issues.filter(issue => !['done', 'closed'].includes(issue.status)).length, inProgress: view.issues.filter(issue => issue.status === 'in-progress').length }, lastEvent: view.events[0] ?? null, engineVersion: view.engineVersion });
      } catch (error) { out.push({ id: entry.id, name: entry.name, root: entry.root, error: error.message.slice(0, 300) }); }
    }
    return { protocol: 'protoflow.dashboard-overview/1', generatedAt: new Date().toISOString(), projects: out };
  };

  const allowedHosts = () => [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
  const send = (response, status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // One poll per view however many pages watch it: they share each result, a page that joins paints at once from the
  // last one, and a view nobody watches stops polling.
  const hubs = new Map();
  let stopped = false;
  const stream = (request, response, key, produce) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let hub = hubs.get(key);
    if (!hub) {
      hub = { clients: new Set(), digest: null, message: null, timer: null };
      const tick = async () => {
        let out;
        try { const data = await produce(); const digest = stable(data); if (digest !== hub.digest) { hub.digest = digest; hub.message = out = `data: ${JSON.stringify(data)}\n\n`; } else out = ': ping\n\n'; }
        catch (error) { out = `event: failure\ndata: ${JSON.stringify({ error: error.message.slice(0, 300) })}\n\n`; }
        for (const client of hub.clients) client.write(out);
        if (hub.clients.size && !stopped) hub.timer = setTimeout(tick, pollMs); else if (hubs.get(key) === hub) hubs.delete(key);
      };
      hubs.set(key, hub);
      hub.timer = setTimeout(tick, 0);
    }
    hub.clients.add(response);
    if (hub.message) response.write(hub.message);
    request.on('close', () => hub.clients.delete(response));
  };

  const server = http.createServer(async (request, response) => {
    try {
      // DNS rebinding and cross-site requests: only this loopback host, and a same-origin Origin when one is sent.
      if (!allowedHosts().includes(request.headers.host ?? '')) return send(response, 403, { error: 'Host not allowed' });
      if (request.headers.origin && !allowedHosts().some(item => request.headers.origin === `http://${item}`)) return send(response, 403, { error: 'Origin not allowed' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = (await fs.readFile(path.join(ASSETS, 'index.html'), 'utf8')).replace('%%TOKEN%%', token);
        return send(response, 200, page, TYPES['.html']);
      }
      if (request.method === 'GET' && parts[0] === 'assets' && parts.length === 2 && /^[a-z0-9-]+\.(js|css)$/.test(parts[1])) {
        return send(response, 200, await fs.readFile(path.join(ASSETS, parts[1])), TYPES[path.extname(parts[1])]);
      }
      if (parts[0] !== 'api') return send(response, 404, { error: 'Not found' });
      if (request.method === 'GET' && url.pathname === '/api/projects') return send(response, 200, await overview());
      if (request.method === 'GET' && url.pathname === '/api/stream') return stream(request, response, 'overview', overview);
      const entry = parts[1] === 'projects' && parts[2] ? await project(parts[2]) : null;
      if (!entry) return send(response, 404, { error: 'Unknown project' });
      if (request.method === 'GET' && parts.length === 3) return send(response, 200, await snapshot(entry));
      if (request.method === 'GET' && parts[3] === 'stream') return stream(request, response, entry.id, () => snapshot(entry));
      if (request.method === 'GET' && parts[3] === 'file') {
        const relative = url.searchParams.get('path') ?? '';
        if (!IMAGE.test(relative) || relative.split('/').includes('..')) return send(response, 400, { error: 'Only screenshots under .protoflow/artifacts' });
        const view = await snapshot(entry);
        for (const base of [entry.root, ...view.streams.map(item => item.runner?.worktree).filter(Boolean)]) {
          const file = path.join(base, relative);
          const real = await fs.realpath(file).catch(() => null);
          if (real && real.startsWith(await fs.realpath(base))) return send(response, 200, await fs.readFile(real), TYPES[path.extname(real).toLowerCase()]);
        }
        return send(response, 404, { error: 'Screenshot not found' });
      }
      if (request.method === 'POST' && parts[3] === 'actions') {
        if (request.headers['x-protoflow-token'] !== token) return send(response, 403, { error: 'Missing or wrong dashboard token' });
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 16384) return send(response, 413, { error: 'Request too large' }); }
        let parsed;
        try { parsed = JSON.parse(body); } catch { return send(response, 400, { error: 'Expected JSON' }); }
        try { return send(response, 200, await actions(entry.root, parsed)); }
        catch (error) { return send(response, error.statusCode ?? 409, { error: error.message.slice(0, 600) }); }
        // The next push shows what the action changed instead of a snapshot read just before it.
        finally { recent.delete(entry.root); }
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) { return send(response, 500, { error: error.message.slice(0, 300) }); }
  });
  return {
    server, token,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(`http://${host}:${server.address().port}/`)); }),
    close: () => new Promise(resolve => { stopped = true; for (const hub of hubs.values()) clearTimeout(hub.timer); hubs.clear(); server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

const ENGINE_PACKAGE = new URL('../package.json', import.meta.url);
const engineVersion = async () => JSON.parse(await fs.readFile(ENGINE_PACKAGE, 'utf8')).version;

/**
 * Resolves with the new version once the engine checkout on disk is no longer the version this process loaded (a pull
 * or a release): a project config using a field the loaded schema does not know would otherwise fail to read until
 * someone restarts the dashboard. A read failure (mid-checkout) is retried on the next check.
 */
export function watchEngineVersion(loaded, { intervalMs = 5000, read = engineVersion } = {}) {
  let timer;
  const changed = new Promise(resolve => {
    const check = async () => {
      const current = await read().catch(() => loaded);
      if (current !== loaded) return resolve(current);
      timer = setTimeout(check, intervalMs);
    };
    timer = setTimeout(check, intervalMs);
  });
  return { changed, stop: () => clearTimeout(timer) };
}

/**
 * `protoflow dashboard serve`: runs until SIGINT/SIGTERM. Under the LaunchAgent it also stops when the engine on disk
 * changes version, and launchd (KeepAlive) starts it again on the new code; in the foreground it only says so.
 */
export async function serveDashboard({ port = 7420, home, onListen = () => {}, reloadOnUpgrade = false, log = event => console.log(JSON.stringify(event)), watch = watchEngineVersion } = {}) {
  const loaded = await engineVersion();
  const dashboard = createDashboardServer({ port, home });
  const url = await dashboard.listen();
  await onListen(url);
  const engine = watch(loaded);
  let stop;
  const signal = new Promise(resolve => { stop = () => resolve(null); process.once('SIGINT', stop); process.once('SIGTERM', stop); });
  let upgraded = await Promise.race([signal, engine.changed]);
  if (upgraded !== null && !reloadOnUpgrade) {
    log({ event: 'engine-upgraded', loaded, current: upgraded, hint: 'restart `protoflow dashboard serve` to read configs with the new engine' });
    upgraded = await signal;
  }
  engine.stop();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await dashboard.close();
  if (upgraded) log({ event: 'engine-upgraded', loaded, current: upgraded, action: 'exit for launchd to restart on the new engine' });
  return upgraded ? { status: 'RELOAD', url, loaded, current: upgraded } : { status: 'STOPPED', url };
}
