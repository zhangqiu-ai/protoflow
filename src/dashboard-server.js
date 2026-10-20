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

export function createDashboardServer({ home = os.homedir(), host = '127.0.0.1', port = 7420, token = randomBytes(24).toString('hex'), pollMs = 3000, healthTtlMs = 20000, service = process.platform === 'darwin', actions = runAction } = {}) {
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
  const snapshot = async entry => dashboardSnapshot(entry.root, { health: await health(entry.root) });
  const overview = async () => {
    const out = [];
    for (const entry of await listProjects({ home })) {
      try {
        const view = await snapshot(entry);
        out.push({ id: entry.id, name: entry.name, root: entry.root, service: view.service, roles: view.roles, attention: view.attention.length, streams: view.streams.map(stream => ({ target: stream.target, stage: stream.stage, phase: stream.phase, current: stream.current && { summary: stream.current.summary, status: stream.current.status, manifestId: stream.current.manifestId }, live: stream.live?.running ? { executor: stream.live.executor, model: stream.live.model } : null, lastDelivery: stream.deliveries[0] ?? null })), issues: { open: view.issues.filter(issue => !['done', 'closed'].includes(issue.status)).length, inProgress: view.issues.filter(issue => issue.status === 'in-progress').length }, lastEvent: view.events[0] ?? null, engineVersion: view.engineVersion });
      } catch (error) { out.push({ id: entry.id, name: entry.name, root: entry.root, error: error.message.slice(0, 300) }); }
    }
    return { protocol: 'protoflow.dashboard-overview/1', generatedAt: new Date().toISOString(), projects: out };
  };

  const allowedHosts = () => [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
  const send = (response, status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const stream = (request, response, produce) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let last = null, closed = false;
    const tick = async () => {
      if (closed) return;
      try { const data = await produce(); const digest = stable(data); if (digest !== last) { last = digest; response.write(`data: ${JSON.stringify(data)}\n\n`); } else response.write(': ping\n\n'); }
      catch (error) { response.write(`event: failure\ndata: ${JSON.stringify({ error: error.message.slice(0, 300) })}\n\n`); }
      if (!closed) timer = setTimeout(tick, pollMs);
    };
    let timer = setTimeout(tick, 0);
    request.on('close', () => { closed = true; clearTimeout(timer); });
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
      if (request.method === 'GET' && url.pathname === '/api/stream') return stream(request, response, overview);
      const entry = parts[1] === 'projects' && parts[2] ? await project(parts[2]) : null;
      if (!entry) return send(response, 404, { error: 'Unknown project' });
      if (request.method === 'GET' && parts.length === 3) return send(response, 200, await snapshot(entry));
      if (request.method === 'GET' && parts[3] === 'stream') return stream(request, response, () => snapshot(entry));
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
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) { return send(response, 500, { error: error.message.slice(0, 300) }); }
  });
  return {
    server, token,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(`http://${host}:${server.address().port}/`)); }),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

/** `protoflow dashboard serve`: runs until SIGINT/SIGTERM. */
export async function serveDashboard({ port = 7420, home, onListen = () => {} } = {}) {
  const dashboard = createDashboardServer({ port, home });
  const url = await dashboard.listen();
  await onListen(url);
  await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await dashboard.close();
  return { status: 'STOPPED', url };
}
