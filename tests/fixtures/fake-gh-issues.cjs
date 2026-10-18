#!/usr/bin/env node
// FAKE gh for tests only: the GitHub Issues REST endpoints ProtoFlow uses, backed by a JSON file (FAKE_GH_DB).
const fs = require('node:fs');
const db = process.env.FAKE_GH_DB;
const state = JSON.parse(fs.readFileSync(db, 'utf8'));
const args = process.argv.slice(2);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const method = flag('--method') ?? 'GET';
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
state.calls = [...(state.calls ?? []), { method, endpoint: args[1], body, host: process.env.GH_HOST ?? null }];
const save = () => fs.writeFileSync(db, JSON.stringify(state, null, 2));
const out = value => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (status, message) => { save(); process.stderr.write(`gh: ${message} (HTTP ${status})\n`); process.exit(1); };
if (args[0] !== 'api' || flag('--hostname') !== 'github.com') fail(400, `unsupported ${args.join(' ')}`);
if (state.failNext && state.failNext.method === method && args[1].includes(state.failNext.match)) { const failure = state.failNext; delete state.failNext; fail(failure.status ?? 502, failure.message ?? 'Bad Gateway'); }
const url = new URL(`https://api.github.com/${args[1]}`);
const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const [, owner, name, kind, number, sub, extra] = parts;
if (`${owner}/${name}` !== state.repository.full_name) fail(404, 'Not Found');
const now = () => new Date(Date.UTC(2026, 9, 14, 0, 0, state.clock = (state.clock ?? 0) + 1)).toISOString();
const issue = () => state.issues.find(item => item.number === Number(number)) ?? fail(404, 'Not Found');
const view = item => ({ number: item.number, title: item.title, body: item.body, user: { login: item.author }, author_association: item.association, state: item.state ?? 'open', labels: item.labels.map(label => ({ name: label })), comments: item.comments.length, updated_at: item.updatedAt ?? '2026-10-14T00:00:00Z', ...(item.pull ? { pull_request: {} } : {}) });
if (parts.length === 3 && method === 'GET') out(state.repository);
if (kind === 'labels' && !number) {
  if (method === 'GET') out(state.labels.map(label => ({ name: label })));
  if (method === 'POST') { state.labels.push(body.name); out({ name: body.name }); }
}
if (kind === 'issues' && !number && method === 'GET') {
  const label = url.searchParams.get('labels');
  if (Number(url.searchParams.get('page') ?? 1) > 1) out([]);
  out(state.issues.filter(item => (item.state ?? 'open') === 'open' && (label === null || item.labels.includes(label))).map(view));
}
if (kind === 'issues' && number && !sub && method === 'GET') out(view(issue()));
if (kind === 'issues' && number && !sub && method === 'PATCH') { const item = issue(); item.state = body.state; item.stateReason = body.state_reason; out(view(item)); }
if (kind === 'issues' && sub === 'comments') {
  const item = issue();
  if (method === 'GET') out(item.comments.map(comment => ({ id: comment.id, user: { login: comment.author }, author_association: comment.association ?? 'OWNER', body: comment.body, created_at: comment.createdAt })));
  if (method === 'POST') {
    const comment = { id: 9000 + (state.nextComment = (state.nextComment ?? 0) + 1), author: state.viewer, association: 'OWNER', body: body.body, createdAt: now() };
    item.comments.push(comment);
    if (state.crashAfterComment) { delete state.crashAfterComment; fail(502, 'Bad Gateway'); }
    out({ id: comment.id, created_at: comment.createdAt, body: comment.body });
  }
}
if (kind === 'issues' && sub === 'labels') {
  const item = issue();
  if (method === 'POST') { for (const label of body.labels) if (!item.labels.includes(label)) item.labels.push(label); out(item.labels.map(label => ({ name: label }))); }
  if (method === 'DELETE') { item.labels = item.labels.filter(label => label !== extra); out(item.labels.map(label => ({ name: label }))); }
}
if (kind === 'issues' && sub === 'events' && method === 'GET') out(issue().events ?? []);
if (kind === 'collaborators' && sub === 'permission' && method === 'GET') out({ permission: state.permissions?.[number] ?? 'none', role_name: state.permissions?.[number] ?? 'none' });
fail(400, `unsupported ${method} ${args[1]}`);
