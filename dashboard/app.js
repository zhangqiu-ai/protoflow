// ProtoFlow dashboard (proposal 0004). Plain DOM, no build step: every value is inserted as text, never as HTML.
let token = document.querySelector('meta[name="protoflow-token"]').content;
const app = document.getElementById('app'), crumb = document.getElementById('crumb'), conn = document.getElementById('conn'), ver = document.getElementById('ver');

const STAGES = [['plan', '規劃'], ['execute', '實作'], ['verify', '驗收'], ['review', '審查'], ['deliver', '交付']];
const STAGE_LABEL = { idle: '閒置', blocked: '阻塞', plan: '規劃', execute: '實作', verify: '驗收', review: '審查', deliver: '交付' };
const STATUS = { PASS: ['通過', 'ok'], FAIL: ['未過', 'bad'], NOT_RUN: ['未執行', ''], BLOCKED: ['阻塞', 'bad'], RUNNING: ['進行中', 'ok'], PENDING: ['等待', ''], STOPPED: ['已停止', 'warn'], MERGED: ['已合併', 'ok'], PR_OPEN_MANUAL: ['待你合併', 'warn'], REVOKED: ['已撤回', ''], COMMITTED: ['已提交', 'ok'], HEALTHY: ['常駐', 'ok'], DEGRADED: ['連線異常', 'bad'], STALLED: ['無回應', 'bad'], DOWN: ['已停止', 'bad'], STARTING: ['啟動中', 'ok'], NOT_INSTALLED: ['未常駐', ''], HEARTBEAT: ['前景執行', 'ok'], UNKNOWN: ['未知', ''] };
const ISSUE = { planned: ['已規劃', 'ok'], 'needs-info': ['需要資訊', 'warn'], 'needs-human': ['需要你決定', 'warn'], rejected: ['不處理', ''], 'waiting-prototype': ['等原型版本', 'ok'], 'in-progress': ['實作中', 'ok'], blocked: ['阻塞', 'bad'], done: ['完成', 'ok'], new: ['新', ''], 'triage-failed': ['分流失敗', 'bad'], closed: ['已關閉', ''] };
const ISSUE_ACTION = { handback: '已交回 AI', 'answer-issue': '已回答', 'close-issue': '已關閉' };
const PHASE = { execute: '執行者', build: '建置', functional: '功能測試', visual: '比對', 'visual-driver': '畫面擷取' };
const TIERS = [['structure', '結構'], ['tokens', '配色'], ['layout', '版面'], ['visual', '視覺']];
const ICON = {
  merge: 'M5 3v12M13 3v3a4 4 0 0 1-4 4H5', tag: 'M3 3h6l6 6-6 6-6-6zM6.5 6.5h.01', issue: 'M9 2.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM9 6v3.5M9 12.2h.01',
  retry: 'M3.5 9a5.5 5.5 0 1 0 1.6-3.9M3.5 3.5v3h3', review: 'M7.5 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM11 11l4 4', alert: 'M9 3 2.5 14.5h13zM9 7.5v3M9 12.6h.01', check: 'm4 9.5 3.2 3L14 6', back: 'M10 3 5 8l5 5', clock: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 5v3.3l2 1.4',
  grid: 'M3.5 3.5h4v4h-4zM10.5 3.5h4v4h-4zM3.5 10.5h4v4h-4zM10.5 10.5h4v4h-4z', inbox: 'M2.5 10.5h3.6l1.2 2h3.4l1.2-2h3.6M2.5 10.5l2-6.5h9l2 6.5v4.5h-13z',
  bell: 'M5 12.5V8.5a4 4 0 0 1 8 0v4l1.3 1.5H3.7zM7.4 16h3.2', copy: 'M6.5 6.5h8v8.5h-8zM3.5 11.5V3h8', fix: 'M9 2.5a4.5 4.5 0 0 0-2.6 8.2v2.3h5.2v-2.3A4.5 4.5 0 0 0 9 2.5zM7 15.5h4'
};

/** Element helper: h('div.card', {attr}, ...children); strings become text nodes. */
function h(tag, attrs, ...children) { return build(document.createElement(tag.split('.')[0]), tag, attrs, children); }
/** The same for SVG. */
function s(tag, attrs, ...children) { return build(document.createElementNS('http://www.w3.org/2000/svg', tag.split('.')[0]), tag, attrs, children); }
function build(node, tag, attrs, children) {
  const classes = tag.split('.').slice(1);
  if (classes.length) node.setAttribute('class', classes.join(' '));
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.setAttribute('class', [node.getAttribute('class'), value].filter(Boolean).join(' '));
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const icon = (path, size = 18) => s('svg', { width: size, height: size, viewBox: '0 0 18 18', 'aria-hidden': 'true' }, s('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const pill = (status, map = STATUS) => { const [label, tone] = map[status] ?? [status ?? '—', '']; return h(`span.pill${tone ? `.${tone}` : ''}`, {}, label); };
const ago = iso => { if (!iso) return '—'; const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return sec < 60 ? '剛剛' : sec < 3600 ? `${Math.floor(sec / 60)} 分前` : sec < 86400 ? `${Math.floor(sec / 3600)} 小時前` : `${Math.floor(sec / 86400)} 天前`; };
const clock = iso => iso ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const elapsed = iso => { if (!iso) return ''; const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); const m = Math.floor(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : `${m}:${String(sec % 60).padStart(2, '0')}`; };
/** How long something has waited for a person, in words: 等了 12 分鐘 / 3 小時 5 分 / 2 天. */
const waited = iso => { if (!iso || Number.isNaN(Date.parse(iso))) return null; const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)); return min < 1 ? '剛剛開始等' : min < 60 ? `等了 ${min} 分鐘` : min < 1440 ? `等了 ${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}` : `等了 ${Math.floor(min / 1440)} 天`; };
const targetName = target => target ?? '應用';
const initial = name => [...String(name ?? '?')][0].toUpperCase();
const active = stream => !['idle', 'blocked'].includes(stream.stage) && !stream.stopped && !stream.paused;

/** One avatar per distinct agent: the planner leads, then the executors by area. */
function agents(roles) {
  if (!roles) return [];
  const glyph = role => /opus/i.test(role.model ?? '') ? 'O' : /sonnet/i.test(role.model ?? '') ? 'S' : /haiku/i.test(role.model ?? '') ? 'H' : role.provider === 'codex' ? 'C' : initial(role.provider);
  const name = role => `${role.provider === 'claude' ? 'Claude' : role.provider === 'codex' ? 'Codex' : role.provider}${role.model ? ` · ${role.model}` : ''}`;
  const out = [], seen = new Set();
  for (const [role, label, lead] of [[roles.planner, '規劃', true], [roles.executors?.frontend, '前端', false], [roles.executors?.backend, '後端', false]]) {
    if (!role?.provider) continue;
    const key = `${role.provider}:${role.model ?? ''}`;
    if (seen.has(key)) { out.find(item => item.key === key).labels.push(label); continue; }
    seen.add(key); out.push({ key, glyph: glyph(role), kind: lead ? 'lead' : role.provider, name: name(role), labels: [label] });
  }
  return out;
}
const avatar = agent => h(`span.agent.${agent.kind}`, { title: `${agent.labels.join('／')}：${agent.name}` }, agent.glyph);

/** Apple-Watch-like ring. */
function gauge(label, value, fraction, color) {
  const c = 2 * Math.PI * 34;
  return h('div.gauge', {}, h('div.dial', {},
    s('svg', { width: 84, height: 84, viewBox: '0 0 84 84', role: 'img', 'aria-label': `${label} ${value}` },
      s('circle', { cx: 42, cy: 42, r: 34, fill: 'none', stroke: 'var(--line2)', 'stroke-width': 7 }),
      s('circle.arc', { cx: 42, cy: 42, r: 34, fill: 'none', stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': (c * (1 - Math.min(1, Math.max(0, fraction)))).toFixed(1), transform: 'rotate(-90 42 42)', style: `--c:${c.toFixed(1)}` })),
    h('b', {}, String(value))), h('span', {}, label));
}
/** Where a stream is on plan → deliver: index of the current node, and whether earlier nodes are done. */
function position(stream) {
  if (stream.stage === 'blocked') return { at: 0, tone: 'bad' };
  if (stream.stopped) return { at: Math.max(0, STAGES.findIndex(([key]) => key === stream.stage)), tone: 'stop' };
  if (stream.stage === 'idle') return { at: ['MERGED', 'COMMITTED'].includes(stream.deliveries?.[0]?.status ?? stream.lastDelivery?.status) || stream.versions?.[0]?.status === 'PASS' ? STAGES.length : -1, tone: 'idle' };
  return { at: STAGES.findIndex(([key]) => key === stream.stage), tone: 'now' };
}
const glyphOf = action => ({ say: '◆', read: '↗', edit: '✎', write: '+', run: '▸', search: '⌕', agent: '⑂', tool: '·', done: action.ok === false ? '✕' : '✓' })[action.kind] ?? '·';
const ACT = { say: '說明', read: '讀取', edit: '編輯', write: '新增', run: '執行', search: '搜尋', agent: '子 Agent', tool: '工具', done: '結束' };
/** A verification waiting for a simulator or emulator that another runner holds. */
const deviceWaitLabel = stream => stream.deviceWait ? `等待模擬器（被 ${[stream.deviceWait.project ?? '另一個專案', stream.deviceWait.target].filter(Boolean).join('/')} 使用）` : null;
/** The live strip on a project card: which version, which phase, how long, and the executor's latest action. */
function nowStrip(stream) {
  const since = stream.deviceWait?.since ?? stream.phaseStartedAt ?? stream.current?.attemptStartedAt;
  const phase = deviceWaitLabel(stream) ?? (stream.phase ? PHASE[stream.phase.split(':')[0]] ?? stream.phase : STAGE_LABEL[stream.stage]);
  const round = stream.current?.attempts > 1 ? `第 ${stream.current.attempts} 輪` : null;
  const live = stream.live, last = live?.last;
  const who = live ? (live.executor === 'codex' ? 'C' : /opus/i.test(live.model ?? '') ? 'O' : 'S') : null;
  return h('div.strip', { 'aria-label': `${targetName(stream.target)} 進行中` },
    h('div.strip-h', {},
      who ? h(`span.agent.${live.executor === 'codex' ? 'codex' : 'claude'}.working`, { title: `${live.model ?? live.executor} 工作中` }, who) : h('span.spin', { 'aria-hidden': 'true' }),
      h('div', {}, h('b', { title: stream.current?.summary ?? '' }, stream.current?.summary ?? targetName(stream.target)),
        h('small', {}, [targetName(stream.target), phase, round].filter(Boolean).join(' · '))),
      h('span.timer', { 'data-since': since ?? '' }, elapsed(since))),
    last ? h('div.strip-act', { title: last.text }, h(`span.k-${last.kind}`, { 'aria-hidden': 'true' }, glyphOf(last)), h('span', {}, `${ACT[last.kind] ?? last.kind} `), h('code', {}, last.text),
      live.totals ? h('em', {}, `✎${live.totals.edits} ▸${live.totals.commands}${live.totals.subagents ? ` ⑂${live.totals.subagents}` : ''}`) : null) : null);
}
function miniTrack(stream) {
  const { at, tone } = position(stream);
  const fraction = at <= 0 ? 0 : Math.min(at, STAGES.length - 1) / (STAGES.length - 1);
  const label = stream.stopped ? '已停止' : stream.stage === 'idle' ? (at === STAGES.length ? '完成' : '閒置') : STAGE_LABEL[stream.stage] ?? stream.stage;
  return h('div.mini', {}, h('span', {}, targetName(stream.target)),
    h('div.rail', { role: 'img', 'aria-label': `${targetName(stream.target)}：${label}` }, h('i.bed'), h('i.fill', { style: `width:calc((100% - 12px) * ${fraction})` }), active(stream) ? h('i.flow', { style: `width:calc((100% - 12px) * ${fraction})` }) : null,
      h('div.dots', {}, STAGES.map(([, name], i) => h(`span.dot${i < at ? '.done' : i === at ? `.${tone === 'bad' || tone === 'stop' ? tone : 'now'}` : ''}${i === at && tone === 'now' ? '.live-dot' : ''}`, { title: name })))),
    h(`em${['now', 'bad', 'stop'].includes(tone) ? `.${tone}` : ''}`, { title: stream.stopped ? `停在${STAGE_LABEL[stream.stage] ?? stream.stage}，runner 沒在跑` : null }, label));
}

function toast(text, bad = false) {
  const box = document.getElementById('toast');
  box.textContent = text; box.className = bad ? 'bad' : ''; box.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, bad ? 9000 : 5000);
}

// ---- data: the overview stream feeds the sidebar for the whole visit (and the overview page); a project page adds its own ----
let source = null, overviewData = null;
const viewing = () => source ?? overview;
const setConn = live => { conn.textContent = live ? '即時' : '重新連線中'; conn.className = live ? 'conn live' : 'conn'; };
function watch(stream, onData) {
  stream.onopen = () => { if (stream === viewing()) setConn(true); };
  stream.onerror = () => { if (stream === viewing()) setConn(false); };
  stream.onmessage = message => onData(JSON.parse(message.data));
  stream.addEventListener('failure', message => { if (stream === viewing()) toast(`讀取失敗：${JSON.parse(message.data).error}`, true); });
  return stream;
}
// Entrance motion plays once per view; later pushes redraw in place without replaying it.
function paint(render, data) { render(data); app.classList.remove('swap'); setTimeout(() => document.body.classList.add('settled'), 900); }
const overview = watch(new EventSource('/api/stream'), data => {
  overviewData = data;
  renderSide(data);
  badge(data);
  notifyNew(data);
  if (!source) paint(view() === 'inbox' ? renderInbox : renderOverview, data);
});
// The service mints a new token each time it starts, so a page left open across a restart (an upgrade, a launchd
// relaunch) holds a stale one: on that refusal, read the current token from a fresh copy of the page and send once more.
async function freshToken() {
  const page = await (await fetch('/', { cache: 'no-store' })).text();
  return new DOMParser().parseFromString(page, 'text/html').querySelector('meta[name="protoflow-token"]')?.content ?? token;
}
async function act(projectId, body, label) {
  const post = () => fetch(`/api/projects/${projectId}/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-protoflow-token': token }, body: JSON.stringify(body) });
  let response = await post();
  if (response.status === 403 && (await response.clone().json().catch(() => ({}))).error === 'Missing or wrong dashboard token') {
    token = await freshToken();
    response = await post();
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  toast(`${label}：完成${result.next ? `。${result.next}` : ''}`);
  return result;
}

// ---- overview ----
function renderOverview(data) {
  crumb.textContent = '';
  const projects = data.projects;
  ver.textContent = projects.find(project => project.engineVersion)?.engineVersion ? `v${projects.find(project => project.engineVersion).engineVersion}` : '';
  if (!projects.length) {
    app.replaceChildren(h('section.hero.rise', {}, h('div', {}, h('span.label', {}, '所有專案'), h('h1', {}, '還沒有專案'))),
      h('p.empty', {}, '在專案目錄執行 protoflow dashboard add --project .'));
    return;
  }
  const healthy = projects.filter(project => ['HEALTHY', 'HEARTBEAT'].includes(project.service?.status)).length;
  const busy = projects.filter(project => project.streams?.some(active)).length;
  const due = projects.reduce((sum, project) => sum + (project.attention ?? 0), 0);
  app.replaceChildren(
    h('section.hero.rise', {}, h('div', {}, h('span.label', {}, '所有專案'),
      h('h1', {}, `${projects.length} 個專案`, h('br'), due ? h('a.to-inbox', { href: '#/inbox' }, h('b', {}, `${due} 件`), '等你決定') : ['一切', h('b', {}, '順暢')])),
      h('div.gauges', {}, gauge('常駐', healthy, healthy / projects.length, 'var(--mint)'), gauge('進行中', busy, busy / projects.length, 'var(--ink)'),
        gauge('等你', due, projects.filter(project => project.attention).length / projects.length, 'var(--amber)'))),
    h('section.cards', {}, projects.map((project, index) => h(`a.card.rise${project.streams?.some(active) ? '.busy' : ''}`, { href: `#/p/${project.id}`, style: `animation-delay:${index * 60}ms` },
      h('div.card-h', {}, h('div.ident', {}, h('span.tile', {}, initial(project.name)), h('div', {}, h('b', {}, project.name), h('small', {}, project.root?.split('/').slice(-2).join('/') ?? ''))),
        project.paused ? h('span.pill.warn', { title: project.paused.reason ?? '' }, '已暫停') : project.service ? pill(project.service.status) : null),
      project.error ? h('p.empty', {}, `讀取失敗：${project.error}`) : [
        h('div.tracks', {}, project.streams.map(miniTrack)),
        project.streams.filter(active).map(nowStrip),
        h('div.card-f', {}, h('div.agents', {}, agents(project.roles).map(avatar)),
          h('div.meta', {}, project.attention ? h('span.due', {}, '待你', h('b', {}, String(project.attention))) : null,
            project.issues?.open ? h('span', { title: '未結 Issue' }, `#${project.issues.open}`) : null,
            h('span.when', {}, ago(project.lastEvent?.at))))
      ])))
  );
}

// ---- project ----
const selected = {}, done = new Map();
// Answers being typed into issue cards, so a live update that redraws the page keeps the text, the focus and the caret.
const drafts = new Map();
function replaceApp(...nodes) {
  const field = document.activeElement?.dataset?.draft ? { key: document.activeElement.dataset.draft, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  app.replaceChildren(...nodes);
  const again = field && [...app.querySelectorAll('[data-draft]')].find(node => node.dataset.draft === field.key);
  if (again) { again.focus({ preventScroll: true }); again.setSelectionRange(field.start, field.end); }
}
/** Every target in one panel: a row per target, the stage names once as column heads so the nodes line up. */
function pipelines(streams) {
  const lane = stream => {
    // A paused lane keeps its place on the track, drawn at rest.
    const { at, tone: live } = position(stream), tone = stream.paused && live === 'now' ? 'idle' : live;
    const fraction = at <= 0 ? 0 : Math.min(at, STAGES.length - 1) / (STAGES.length - 1);
    const since = stream.phaseStartedAt ?? stream.current?.attemptStartedAt;
    const sub = [stream.current?.summary, deviceWaitLabel(stream) ?? (stream.phase ? PHASE[stream.phase.split(':')[0]] ?? stream.phase : null), stream.phase?.includes(':') ? stream.phase.split(':')[1] : null].filter(Boolean).join(' · ');
    const state = stream.paused ? (stream.stage === 'idle' ? '已暫停' : `已暫停（${STAGE_LABEL[stream.stage] ?? stream.stage}）`) : stream.stopped ? `已停止（${STAGE_LABEL[stream.stage] ?? stream.stage}）` : stream.stage === 'idle' ? (at === STAGES.length ? '完成' : '閒置') : STAGE_LABEL[stream.stage] ?? stream.stage;
    return h(`div.lane${active(stream) ? '.on' : ''}`, { 'aria-label': `${targetName(stream.target)}：${state}` },
      h('div.lane-name', {}, h('b', {}, targetName(stream.target)), sub ? h('span', { title: sub }, sub) : null),
      h('div.track', {}, h('i.bed'), h('i.fill', { style: `width:calc((100% - 2 * var(--inset)) * ${fraction})` }), active(stream) ? h('i.flow', { style: `width:calc((100% - 2 * var(--inset)) * ${fraction})` }) : null,
        h('ol', {}, STAGES.map(([, label], i) => h(`li${i < at ? '.done' : i === at ? `.${tone === 'bad' || tone === 'stop' ? tone : 'now'}${tone === 'idle' ? '.idle' : ''}` : ''}`, { title: label },
          h(`span.node${i === at && tone === 'now' ? '.live-dot' : ''}`, {}, i < at ? icon(ICON.check, 14) : i === at && tone === 'bad' ? '!' : ''), h('span.sr', {}, label))))),
      h('div.lane-state', {}, h(`em${['now', 'bad', 'stop'].includes(tone) ? `.${tone}` : ''}`, {}, state),
        h('span.timer', { 'data-since': active(stream) ? since ?? '' : '' }, active(stream) ? elapsed(since) : stream.lastEvent ? ago(stream.lastEvent.at) : '')),
      stream.current?.error ? h('p.why-line', {}, stream.current.error) : null);
  };
  return h('section.panel.pipes.rise', { 'aria-label': '管線' },
    h('div.lane.lane-head', { 'aria-hidden': 'true' }, h('span.label', {}, '管線'), h('ol', {}, STAGES.map(([, label]) => h('li', {}, label))), h('span')),
    streams.map(lane));
}
function consoleCard(streams) {
  const stream = streams.find(item => item.live?.running) ?? streams.find(item => item.live) ?? null;
  const live = stream?.live;
  const lines = live?.actions ?? [];
  const list = h('ol.acts', { 'aria-label': '執行者動作' }, lines.map((action, i) => h(`li.${action.kind}${action.ok === false ? '.fail' : ''}`, { style: `animation-delay:${Math.min(i, 12) * 40}ms` },
    h(`span.k-${action.kind}`, { 'aria-hidden': 'true' }, glyphOf(action)),
    h('span', { title: action.text }, action.text))),
    live?.running ? h('li.cursor', { 'aria-hidden': 'true' }, h('span', {}, '›'), h('i')) : null);
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  return h(`div.console.rise${live ? '' : '.idle'}`, {},
    h('div.console-h', {}, h('div.lights', {}, h('i'), h('i'), h('i')),
      live ? h(`span.who${live.executor === 'codex' ? '.codex' : ''}`, {}, h('b', {}, live.executor === 'codex' ? 'C' : /opus/i.test(live.model ?? '') ? 'O' : 'S'), `${live.model ?? live.executor}${live.subagentModel ? ` + ${live.subagentModel}` : ''} · ${targetName(stream.target)}`) : h('span', {}, 'agent'),
      h('span', {}, live ? (live.running ? `編輯 ${live.totals.edits} · 命令 ${live.totals.commands}${live.totals.subagents ? ` · 子 Agent ${live.totals.subagents}` : ''}` : `上次 ${ago(live.updatedAt)}`) : '')),
    live ? [list, live.files?.length ? h('div.files', {}, live.files.slice(-6).map(file => h('span', { title: file }, file.split('/').pop()))) : null]
      : h('p.quiet', {}, '目前沒有代理在工作'));
}
// Most urgent first: the service, then blocked work, rejected reviews, merges and approvals, then issues.
const URGENCY = { service: 0, 'blocked-version': 1, 'delivery-blocked': 1, 'review-rejected': 2, waiver: 2, 'manual-merge': 3, review: 3, issue: 4 };
const TIER_NAME = { structure: '結構', tokens: '配色', layout: '版面', visual: '視覺' };
const KIND = { service: 'Runner 異常', 'blocked-version': '阻塞', 'delivery-blocked': '交付受阻', 'review-rejected': '審查未過', 'manual-merge': '可合併', review: '待核准', issue: 'Issue 等你' };
const byUrgency = items => [...items].sort((a, b) => (URGENCY[a.kind] ?? 5) - (URGENCY[b.kind] ?? 5));
/** Text with `code` spans, as nodes. */
const withCode = text => String(text).split('`').map((part, i) => i % 2 ? h('code', {}, part) : part);
/** What to do about a blocked item when the engine recognises its failure: the steps, a command to copy, then retry. */
function diagnosisBlock(diagnosis) {
  if (!diagnosis) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(diagnosis.command); toast(`已複製：${diagnosis.command}`); } catch { toast(`無法複製，請手動輸入 ${diagnosis.command}`, true); } };
  return h('div.diag', { 'aria-label': `診斷：${diagnosis.title}` },
    h('div.diag-h', {}, icon(ICON.fix, 16), h('b', {}, diagnosis.title),
      diagnosis.command ? h('button.copy', { type: 'button', title: '複製命令', 'aria-label': `複製命令 ${diagnosis.command}`, onclick: copy }, h('code', {}, diagnosis.command), icon(ICON.copy, 14)) : null),
    h('ol', {}, diagnosis.steps.map(step => h('li', {}, withCode(step)))));
}
/** One card per item waiting for a person, with the action it allows; the same cards on a project page and in the inbox. */
function askCards(projectId, items, many, projectName = '') {
  const run = async (box, made, label, question, result, key) => {
    // A body can be read from the card when the button is pressed (an answer typed into it).
    const body = typeof made === 'function' ? made() : made;
    if (!body || !confirm(question)) return;
    box.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const response = await act(projectId, body, label);
      done.set(key ?? keyOf(body), `${result}${response.next ? ` · ${response.next}` : ''}`);
      if (key) drafts.delete(key);
      rerender();
    } catch (error) { toast(`${label}失敗：${error.message}`, true); box.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  };
  const keyOf = body => JSON.stringify(body);
  const card = (item, glyph, title, sub, extra, buttons, key = null) => {
    const body = buttons?.[0]?.body;
    const signed = key ? done.get(key) : body && typeof body !== 'function' ? done.get(keyOf(body)) : null;
    const box = h(`div.ask.rise${signed ? '.done' : buttons ? '' : '.calm'}`, {},
      h('div.ask-h', {}, h('span.glyph', {}, icon(signed ? ICON.check : glyph)), h('div', {}, h('b', {}, title), sub ? h('p', { title: sub }, sub) : null),
        !signed && waited(item.since) ? h('span.waited', { title: `從 ${new Date(item.since).toLocaleString()} 開始等` }, waited(item.since)) : null), extra);
    if (signed) box.append(h('div.signed', {}, icon(ICON.check, 16), h('span', {}, signed)));
    else if (buttons) box.append(h('div.btns', {}, buttons.map((button, i) => button.href ? h('a.btn', { href: button.href, target: '_blank', rel: 'noopener' }, button.label)
      : h(`button.btn${i === 0 ? '.primary' : ''}`, { type: 'button', onclick: () => run(box, button.body, button.label, button.question, button.result, key) }, button.label))));
    return box;
  };
  return byUrgency(items).map(item => {
    const where = many ? `${targetName(item.target)} · ` : '';
    const diagnosis = diagnosisBlock(item.diagnosis);
    if (item.kind === 'manual-merge') return card(item, ICON.merge, `${where}${item.title} 可合併`, `已驗收並通過獨立審查 · ${item.commit?.slice(0, 7) ?? ''}`, null,
      [{ label: '核准並合併', body: { action: 'merge', target: item.target, deliveryId: item.deliveryId }, question: `確定以你的 GitHub 身分合併 ${item.title}？只會合併審查過的 commit。`, result: '已核准 · 合併中' }, item.pr ? { label: 'GitHub', href: item.pr } : null].filter(Boolean));
    if (item.kind === 'issue' && item.waiting === 'runner') return card(item, ICON.issue, `#${item.number} ${item.title ?? ''}`, `${ISSUE_ACTION[item.handedBack?.action] ?? '已交回'}，等 runner 處理`, diagnosis,
      item.url ? [{ label: 'GitHub', href: item.url }] : null);
    if (item.kind === 'issue') {
      const key = `${projectId}:issue:${item.number}`;
      const answer = done.get(key) ? null : h('textarea.answer', { rows: 3, maxlength: 20000, placeholder: '回答上面的問題（以你的 GitHub 身分留言，AI 會帶著你的回答重新分流）', 'aria-label': `回答 #${item.number}`, 'data-draft': key, oninput: event => drafts.set(key, event.target.value) });
      if (answer) answer.value = drafts.get(key) ?? '';
      const text = () => { const value = answer?.value.trim(); if (!value) { toast('請先寫下回答', true); answer.focus(); return null; } return { action: 'answer-issue', number: item.number, text: value }; };
      return card(item, ICON.issue, `#${item.number} ${item.title ?? ''}`, item.reason ?? (ISSUE[item.status] ?? [item.status])[0],
        [item.questions?.length ? h('ul.qs', {}, item.questions.map(question => h('li', { title: question }, question))) : null, diagnosis, answer],
        [{ label: '回答並交回', body: text, question: `確定以你的 GitHub 身分在「${projectName}」的 #${item.number} 留言回答，並交回 AI 重新分流？`, result: '已回答 · 等重新分流' },
          { label: '交回 AI', body: { action: 'handback', number: item.number }, question: `確定不回答、直接把 #${item.number} 交回 AI？沒有新資訊時 AI 會照自己的建議決定；再交回一次就不會重跑分流。`, result: '已交回 AI' },
          { label: '不處理，關閉', body: { action: 'close-issue', number: item.number }, question: `確定以你的 GitHub 身分關閉 #${item.number}（不處理）？`, result: '已關閉' },
          item.url ? { label: 'GitHub', href: item.url } : null].filter(Boolean), key);
    }
    if (item.kind === 'review') return card(item, ICON.tag, `${where}${item.title} 待核准`, item.waivers ? `驗收 ${item.verificationId} 附豁免通過 ${item.waivers} 項，需要你核准` : `驗收 ${item.verificationId} 已通過`, null,
      [{ label: '核准版本', body: { action: 'approve', target: item.target, manifestId: item.manifestId, verificationId: item.verificationId }, question: `確定以你的名字核准這個版本？核准綁定驗收 ${item.verificationId}${item.waivers ? `，其中 ${item.waivers} 項是附豁免通過` : ''}。`, result: '已核准' }]);
    if (item.kind === 'waiver') return card(item, ICON.alert, `${where}豁免待核准：${item.title}`, `${item.reason}${item.engineIssue ? ` · ${item.engineIssue}` : ''}`,
      [h('div.waiver-shots', {}, [['prototype', '原型'], ['application', 'App']].map(([key, label]) => h('figure', {}, item[key] ? h('img', { src: fileUrl(projectId, item[key]), alt: `${label}截圖`, loading: 'lazy' }) : h('div.miss', {}, '無截圖'), h('figcaption', {}, label)))),
        h('ul.findings', {}, item.findings.map(finding => h('li', { title: finding }, finding))),
        h('small.muted', {}, `${TIER_NAME[item.tier] ?? ''}層級 ${item.findingCount} 項發現 · 驗收 ${item.verificationId} · 申請者 ${item.requestedBy?.name ?? ''}`)],
      [{ label: '核准豁免', body: { action: 'approve-waiver', waiverId: item.waiverId }, question: `確定以你的名字核准這個豁免？只涵蓋版本 ${item.manifestId} 的這 ${item.findingCount} 項發現；發現一變或原型改版就失效。`, result: '已核准豁免' },
        { label: '拒絕', body: { action: 'reject-waiver', waiverId: item.waiverId }, question: '確定拒絕這個豁免？版本會繼續因這些發現而失敗。', result: '已拒絕' }]);
    if (item.kind === 'review-rejected') return card(item, ICON.review, `${where}${item.title} 審查未過`, item.reason,
      h('ul.findings', {}, item.findings.map(finding => h(`li.${finding.severity}`, { title: finding.description }, finding.file ? h('code', {}, finding.file.split('/').pop()) : null, finding.description))),
      [{ label: '退回重修', body: { action: 'request-changes', target: item.target, deliveryId: item.deliveryId }, question: `同意獨立審查的 ${item.findings.length} 項發現，把這個版本退回給執行代理重修？會以你的名字記錄「要求修改」，綁定這次驗收。`, result: '已退回 · 下一輪重修' }]);
    if (item.kind === 'blocked-version' && item.reasonCode === 'needs-human' && item.canAnswer) {
      const key = `${projectId}:version:${item.target ?? ''}:${item.manifestId}`;
      const answer = done.get(key) ? null : h('textarea.answer', { rows: 3, maxlength: 4000, placeholder: '回答規劃者的問題（記錄為你的回答，規劃者重新規劃時會讀到）', 'aria-label': `回答 ${item.title}`, 'data-draft': key, oninput: event => drafts.set(key, event.target.value) });
      if (answer) answer.value = drafts.get(key) ?? '';
      const text = () => { const value = answer?.value.trim(); if (!value) { toast('請先寫下回答', true); answer.focus(); return null; } return { action: 'retry', target: item.target, answer: value }; };
      return card(item, ICON.retry, `${where}${item.title} 需要你決定`, item.reason, [diagnosis, answer],
        [{ label: '回答並重試', body: text, question: `確定把回答送到「${projectName}」的 ${item.title}，並重試這個版本？規劃者會帶著你的回答重新規劃。`, result: '已回答 · 重新排入' },
          { label: '重試', body: { action: 'retry', target: item.target }, question: '確定不回答、直接重試這個版本？規劃者沒有新資訊時多半會給出同樣的答案。', result: '已重新排入' }], key);
    }
    if (item.kind === 'blocked-version') return card(item, ICON.retry, `${where}${item.title} 阻塞`, item.reason, diagnosis,
      [{ label: item.diagnosis ? '已處理，重試' : '重試', body: { action: 'retry', target: item.target }, question: item.diagnosis ? `確定已依「${item.diagnosis.title}」的步驟處理，並重試這個版本？` : '確定已處理阻塞原因並重試這個版本？', result: '已重新排入' }]);
    return card(item, ICON.alert, item.title ?? item.kind, item.reason, [diagnosis, item.pr ? h('a', { href: item.pr, target: '_blank', rel: 'noopener' }, 'GitHub') : null], null);
  });
}
function decisions(snapshot) {
  const items = snapshot.attention;
  const cards = askCards(snapshot.project.id, items, snapshot.streams.length > 1, snapshot.project.name);
  const open = items.filter(item => item.actions?.length).length;
  return h('div.decide', { 'aria-label': '需要你' },
    h('div.decide-h', {}, h('span.label', {}, '需要你'), h('b', {}, String(open))),
    cards.length ? cards : h('div.ask.calm', {}, h('div.ask-h', {}, h('span.glyph', {}, icon(ICON.check)), h('div', {}, h('b', {}, '沒有需要你決定的事')))),
    h('div.calm-note', {}, icon(ICON.clock, 16), '以你的 GitHub 身分執行 · 記錄於 actions.jsonl'));
}

// ---- inbox: everything waiting for a person, across projects, most urgent first ----
function notifyToggle() {
  if (!('Notification' in window)) return null;
  const on = notifyOn(), denied = Notification.permission === 'denied';
  const click = async () => {
    if (on) store('protoflow.notify', 'off');
    else { if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') { toast('瀏覽器沒有允許通知', true); return renderInbox(overviewData); } store('protoflow.notify', 'on'); }
    renderInbox(overviewData);
  };
  return h(`button.btn.notify${on ? '.on' : ''}`, { type: 'button', disabled: denied, 'aria-pressed': String(on), onclick: click, title: denied ? '在瀏覽器的網站設定允許通知' : '有新的事等你決定時，在桌面通知你' },
    icon(ICON.bell, 16), denied ? '通知已被瀏覽器封鎖' : on ? '桌面通知已開啟' : '開啟桌面通知');
}
function renderInbox(data) {
  crumb.textContent = '等你';
  const groups = data.projects.filter(project => project.inbox?.length)
    .map(project => ({ project, items: project.inbox, top: Math.min(...project.inbox.map(item => URGENCY[item.kind] ?? 5)) }))
    .sort((a, b) => a.top - b.top || b.items.length - a.items.length);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  replaceApp(
    h('section.hero.rise', {}, h('div', {}, h('span.label', {}, '等你'), h('h1', {}, total ? [h('b', {}, `${total} 件`), '等你決定'] : ['一切', h('b', {}, '順暢')])), notifyToggle()),
    groups.length ? h('div.inbox', {}, groups.map(({ project, items }, index) => h('section.inbox-group.rise', { 'aria-label': project.name, style: `animation-delay:${index * 60}ms` },
      h('a.inbox-h', { href: `#/p/${project.id}` }, h('span.tile', {}, initial(project.name)), h('div', {}, h('b', {}, project.name), h('small', {}, headline(project).label)),
        h('span.due', {}, '待你', h('b', {}, String(items.length))), h('span.go', { 'aria-hidden': 'true' }, '→')),
      h('div.inbox-cards', {}, askCards(project.id, items, project.streams?.length > 1, project.name)))))
      : h('div.ask.calm.rise', {}, h('div.ask-h', {}, h('span.glyph', {}, icon(ICON.check)), h('div', {}, h('b', {}, '沒有需要你決定的事'), h('p', {}, '有新的事時，這裡和分頁標題會先告訴你')))));
}

function frameOf(project, stream, variant) {
  const name = `${variant ?? ''} ${project.targets?.find(target => target.id === stream.target)?.platform ?? ''} ${stream.target ?? ''}`.toLowerCase();
  return /ipad|tablet/.test(name) ? 'tablet' : /iphone|ios|android|flutter|phone|mobile|react-native/.test(name) ? 'phone' : 'browser';
}
const fileUrl = (projectId, file) => `/api/projects/${projectId}/file?path=${encodeURIComponent(file)}`;
/** Full-size comparison of one scene: side by side, or overlaid with a divider to drag; ← → step through scenes. */
function viewer(projectId, scenes, start) {
  document.querySelector('dialog.viewer')?.remove();
  let index = start, mode = selected.viewerMode ?? 'side', split = 50;
  const dialog = h('dialog.viewer', { 'aria-label': '原型與 App 對照' });
  const draw = () => {
    const scene = scenes[index];
    const image = (file, label) => file ? h('img', { src: fileUrl(projectId, file), alt: `${label}截圖`, draggable: 'false' }) : h('div.miss', {}, '無截圖');
    const tiers = TIERS.map(([tier, label]) => { const status = scene.tiers[tier]; const ref = tier === 'visual' && status !== 'NOT_RUN'; if (scene.waived?.[tier]) return h('span.pill.waived', { title: scene.waived[tier] }, `${label} 附豁免通過`); return h(`span.pill${ref ? '' : (STATUS[status] ?? [])[1] ? `.${STATUS[status][1]}` : ''}`, {}, `${label} ${ref ? '參考' : (STATUS[status] ?? [status])[0]}`); });
    let stage;
    if (mode === 'side') stage = h('div.v-side', {}, h('figure', {}, image(scene.prototype, '原型'), h('figcaption', {}, '原型')), h('figure', {}, image(scene.application, 'App'), h('figcaption', {}, 'App')));
    else {
      const top = h('div.v-top', { style: `clip-path:inset(0 ${100 - split}% 0 0)` }, image(scene.prototype, '原型'));
      const bar = h('div.v-bar', { style: `left:${split}%` });
      const range = h('input', { type: 'range', min: 0, max: 100, value: split, 'aria-label': '原型與 App 分界', oninput: event => { split = Number(event.target.value); top.style.clipPath = `inset(0 ${100 - split}% 0 0)`; bar.style.left = `${split}%`; } });
      stage = h('div.v-overlay', {}, h('div.v-frame', {}, image(scene.application, 'App'), top, bar, h('span.v-tag.l', {}, '原型'), h('span.v-tag.r', {}, 'App')), range);
    }
    dialog.replaceChildren(
      h('div.v-head', {},
        h('div', {}, h('b', {}, scene.id), h('small', {}, `${index + 1} / ${scenes.length}`)),
        h('div.segs', { role: 'tablist' }, [['side', '並排'], ['overlay', '疊圖']].map(([key, label]) => h('button.seg', { type: 'button', role: 'tab', 'aria-selected': String(mode === key), onclick: () => { mode = key; selected.viewerMode = key; draw(); } }, label))),
        h('button.v-close', { type: 'button', 'aria-label': '關閉', onclick: () => dialog.close() }, '✕')),
      stage,
      h('div.v-foot', {},
        h('button.v-nav', { type: 'button', 'aria-label': '上一個場景', disabled: index === 0, onclick: () => step(-1) }, '←'),
        h('div.v-info', {}, h('div.checks', {}, tiers), scene.reasons.length ? h('ul.why', {}, scene.reasons.map(reason => h('li', {}, reason))) : null),
        h('button.v-nav', { type: 'button', 'aria-label': '下一個場景', disabled: index === scenes.length - 1, onclick: () => step(1) }, '→')));
  };
  const step = delta => { const next = index + delta; if (next >= 0 && next < scenes.length) { index = next; draw(); } };
  dialog.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' && event.target.type !== 'range') step(-1); if (event.key === 'ArrowRight' && event.target.type !== 'range') step(1); });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  draw();
  document.body.append(dialog);
  dialog.showModal();
}
function evidence(snapshot) {
  const withVer = snapshot.streams.filter(stream => stream.verification);
  if (!withVer.length) return null;
  const current = withVer.find(stream => String(stream.target) === selected.ver) ?? withVer[0];
  const report = current.verification;
  const variants = [...new Set(report.scenes.map(scene => scene.variant ?? ''))];
  const vkey = `variant:${current.target}`;
  const variant = variants.includes(selected[vkey]) ? selected[vkey] : variants[0];
  const scenes = report.scenes.filter(scene => (scene.variant ?? '') === variant);
  const pass = scenes.filter(scene => scene.status === 'PASS').length;
  const waivedCount = scenes.filter(scene => scene.status === 'PASS' && Object.keys(scene.waived ?? {}).length).length;
  const c = 2 * Math.PI * 26, fraction = scenes.length ? pass / scenes.length : 0;
  const frame = frameOf(snapshot.project, current, variant);
  const shot = (file, label, open) => h('figure', {}, h(`button.device.${frame}`, { type: 'button', onclick: open, 'aria-label': `放大查看${label}` }, h('div.screen', {}, file ? h('img', { src: fileUrl(snapshot.project.id, file), alt: `${label}截圖`, loading: 'lazy' }) : h('div.miss', {}, '無截圖'))), h('figcaption', {}, label));
  const segs = (list, isOn, pick, label) => h('div.segs', { role: 'tablist' }, list.map(item => h('button.seg', { type: 'button', role: 'tab', 'aria-selected': String(isOn(item)), onclick: () => { pick(item); rerender(); } }, label(item))));
  return h('section.panel.rise', { 'aria-label': '驗收證據' },
    h('div.panel-h', {}, h('div.ev-h', {},
      h('div.donut', {}, s('svg', { width: 64, height: 64, viewBox: '0 0 64 64', role: 'img', 'aria-label': `通過 ${pass} / ${scenes.length}` },
        s('circle', { cx: 32, cy: 32, r: 26, fill: 'none', stroke: 'var(--line2)', 'stroke-width': 6 }),
        s('circle.arc', { cx: 32, cy: 32, r: 26, fill: 'none', stroke: fraction === 1 ? 'var(--mint)' : fraction ? 'var(--mint)' : 'var(--bad)', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': (c * (1 - fraction)).toFixed(1), transform: 'rotate(-90 32 32)', style: `--c:${c.toFixed(1)}`, class: 'gauge-arc' })),
        h('b', {}, `${Math.round(100 * fraction)}%`)),
      h('div', {}, h('b', {}, '原型 ↔ App'), h('small', {}, `${pass} / ${scenes.length} 場景${waivedCount ? `（其中 ${waivedCount} 個附豁免）` : ''} · `, h('span.mono', {}, report.id)))),
      h('div.checks', {}, withVer.length > 1 ? segs(withVer, stream => stream === current, stream => { selected.ver = String(stream.target); }, stream => targetName(stream.target)) : null,
        variants.length > 1 ? segs(variants, name => name === variant, name => { selected[vkey] = name; }, name => name) : null)),
    h('div.checks', {}, [['建置', report.variants?.[variant] ?? report.build], ['功能測試', report.functional], ['比對', report.visual ?? report.status]].map(([label, status]) => h(`span.pill${(STATUS[status] ?? [])[1] ? `.${STATUS[status][1]}` : ''}`, { title: status }, `${label} ${(STATUS[status] ?? [status])[0]}`))),
    scenes.length ? h('div.scenes', {}, scenes.slice(0, 24).map((scene, index) => h(`article.scene${scene.status === 'FAIL' ? '.fail' : ''}`, { 'aria-label': scene.id },
      h('div.pair', {}, shot(scene.prototype, '原型', () => viewer(snapshot.project.id, scenes, index)), shot(scene.application, 'App', () => viewer(snapshot.project.id, scenes, index))),
      h('div.scene-f', {}, h('b', { title: scene.id }, scene.id),
        h('span.tiers', { role: 'img', 'aria-label': TIERS.map(([tier, label]) => `${label} ${(STATUS[scene.tiers[tier]] ?? [scene.tiers[tier]])[0]}`).join('，') },
          TIERS.map(([tier, label]) => h(`i.${scene.waived?.[tier] ? 'waived' : tier === 'visual' && scene.tiers[tier] !== 'NOT_RUN' ? 'ref' : scene.tiers[tier]}`, { title: `${label}：${scene.waived?.[tier] ? `附豁免通過（${scene.waived[tier]}）` : tier === 'visual' && scene.tiers[tier] !== 'NOT_RUN' ? '參考' : (STATUS[scene.tiers[tier]] ?? [scene.tiers[tier]])[0]}` }))),
        Object.keys(scene.waived ?? {}).length ? h('span.pill.waived', { title: Object.values(scene.waived).join(', ') }, '附豁免') : null),
      scene.reasons.length ? h('ul.why', {}, scene.reasons.map(reason => h('li', {}, reason))) : null))) : h('p.empty', {}, '這個版本沒有比對場景'));
}
function sparkline(events) {
  const now = Date.now(), buckets = new Array(12).fill(0);
  for (const event of events) { const age = (now - Date.parse(event.at)) / 300000; if (age >= 0 && age < 12) buckets[11 - Math.floor(age)] += 1; }
  const max = Math.max(1, ...buckets);
  return s('svg', { width: 120, height: 28, viewBox: '0 0 120 28', role: 'img', 'aria-label': `近一小時 ${buckets.reduce((a, b) => a + b, 0)} 個事件` },
    s('polyline', { points: buckets.map((count, i) => `${(i * 120 / 11).toFixed(1)},${(25 - count / max * 21).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--mint)', 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}
const TONE = status => (STATUS[status] ?? ISSUE[status] ?? [])[1] ?? '';
function lists(snapshot) {
  const many = snapshot.streams.length > 1;
  const versions = snapshot.streams.flatMap(stream => stream.versions.map(version => ({ ...version, target: stream.target })));
  const deliveries = snapshot.streams.flatMap(stream => stream.deliveries.map(delivery => ({ ...delivery, target: stream.target }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const panel = (label, extra, body) => h('section.panel.rise', { 'aria-label': label }, h('div.panel-h', {}, h('span.label', {}, label), extra), body);
  const eventTone = event => /fail|block|error|stop/i.test(`${event.event}${event.status ?? ''}`) ? 'bad' : /merged|pass|deliver|complete|done/i.test(`${event.event}${event.status ?? ''}`) ? 'ok' : /human|manual|needs/i.test(`${event.event}${event.status ?? ''}`) ? 'warn' : 'ink';
  return h('div.quad', {},
    panel('版本', null, versions.length ? h('ol.timeline', {}, versions.slice(0, 8).map(version => h(`li.${version.status === 'RUNNING' ? 'now' : TONE(version.status) || 'idle'}`, {},
      h('div', {}, h('b', {}, `${many ? `${targetName(version.target)} · ` : ''}${version.sha?.slice(0, 7) ?? version.manifestId}`), h('span', { title: version.summary ?? version.error ?? '' }, version.summary ?? version.error ?? '')), version.waivers ? h('span.pill.waived', { title: '這個版本的驗收用到維護者豁免' }, `附豁免通過 ${version.waivers} 項`) : pill(version.status)))) : h('p.empty', {}, '還沒有原型版本')),
    panel('交付', null, deliveries.length ? h('ul.feed', {}, deliveries.slice(0, 8).map(delivery => h('li', {}, h('time', {}, clock(delivery.updatedAt)), h(`i.${delivery.manualMerge ? 'ok' : TONE(delivery.status) || 'ink'}`),
      h('span', { title: delivery.error ?? '' }, `${many ? `${targetName(delivery.target)} · ` : ''}${(STATUS[delivery.manualMerge ? 'MERGED' : delivery.status] ?? [delivery.status])[0]}`),
      delivery.pr ? h('a', { href: delivery.pr, target: '_blank', rel: 'noopener' }, `PR #${delivery.prNumber}`) : h('span')))) : h('p.empty', {}, '還沒有交付')),
    panel('Issue', null, snapshot.issues.length ? h('ul.feed', {}, snapshot.issues.slice(0, 8).map(issue => h('li', {},
      issue.url ? h('a.mono', { href: issue.url, target: '_blank', rel: 'noopener' }, `#${issue.number}`) : h('time', {}, `#${issue.number}`), h(`i.${TONE(issue.status) || 'ink'}`),
      h('span', { title: issue.title ?? '' }, issue.title ?? ''), h('span.muted', {}, (ISSUE[issue.status] ?? [issue.status])[0])))) : h('p.empty', {}, '沒有 Issue')),
    panel('動態', sparkline(snapshot.events), snapshot.events.length ? h('ul.feed', {}, snapshot.events.slice(0, 8).map(event => h('li', {}, h('time', {}, clock(event.at)), h(`i.${eventTone(event)}`),
      h('span', { title: event.reason ?? event.error ?? '' }, `${event.target && many ? `${event.target} · ` : ''}${event.event}${event.number ? ` #${event.number}` : ''}${event.status ? ` · ${event.status}` : ''}`), h('span')))) : h('p.empty', {}, '還沒有事件')));
}
/** Proposal 0005: approved waivers (a maintainer may revoke one) and recent decisions. */
function waiverPanel(snapshot) {
  const list = (snapshot.waivers?.waivers ?? []).filter(waiver => waiver.status !== 'requested').slice(0, 8);
  if (!snapshot.waivers?.enabled || !list.length) return null;
  const revoke = async (button, waiver) => {
    if (!confirm(`確定撤回豁免 ${waiver.id}？下一次驗收就不再套用；已經用它通過的驗收保留原紀錄。`)) return;
    button.disabled = true;
    try { await act(snapshot.project.id, { action: 'revoke-waiver', waiverId: waiver.id }, '撤回豁免'); }
    catch (error) { toast(`撤回豁免失敗：${error.message}`, true); button.disabled = false; }
  };
  const LABEL = { approved: ['已核准', 'waived'], rejected: ['已拒絕', ''], revoked: ['已撤回', ''] };
  return h('section.panel.rise', { 'aria-label': '維護者豁免' }, h('div.panel-h', {}, h('span.label', {}, '維護者豁免'), h('small.muted', {}, `核准者：${snapshot.waivers.reviewers.join('、')}`)),
    h('ul.waivers', {}, list.map(waiver => h('li', {}, h(`span.pill${LABEL[waiver.status]?.[1] ? `.${LABEL[waiver.status][1]}` : ''}`, {}, LABEL[waiver.status]?.[0] ?? waiver.status),
      h('span', { title: waiver.findings.join('\n') }, `${waiver.scene}${waiver.variant ? ` / ${waiver.variant}` : ''} · ${TIER_NAME[waiver.tier] ?? waiver.tier} · ${waiver.findingCount} 項 · ${waiver.reason}`),
      h('small.mono.muted', {}, waiver.id),
      waiver.status === 'approved' ? h('button.btn', { type: 'button', onclick: event => revoke(event.currentTarget, waiver) }, '撤回') : null))));
}
/**
 * A paused project says who paused it, when and why, with the button that resumes it; otherwise a folded control
 * pauses it. Either is recorded under the dashboard reviewer's name.
 */
function pauseBar(snapshot) {
  const id = snapshot.project.id, paused = snapshot.project.paused;
  const send = async (button, body, label, question) => {
    if (!confirm(question)) return;
    button.disabled = true;
    try { await act(id, body, label); } catch (error) { toast(`${label}失敗：${error.message}`, true); button.disabled = false; }
  };
  if (paused) {
    const who = paused.by?.name ?? null;
    return h('section.panel.paused-bar.rise', { 'aria-label': '已暫停' },
      h('div.paused-text', {}, h('span.pill.warn', {}, '已暫停'),
        h('b', {}, paused.reason ?? '沒有寫原因'),
        h('small.muted', { title: paused.since ? new Date(paused.since).toLocaleString() : '' }, [who ? `由 ${who} ` : '', paused.since ? `${ago(paused.since)}暫停` : '', ' · runner 不執行版本、不分流 issue，只凍結新的原型版本；未完成的版本與 worktree 保持原樣'].join(''))),
      h('button.btn.primary', { type: 'button', onclick: event => send(event.currentTarget, { action: 'resume' }, '恢復開發', '確定恢復開發？runner 會從停下的地方繼續，被停止的版本會重新執行。') }, '恢復開發'));
  }
  const reason = h('input.pause-reason', { type: 'text', maxlength: 1000, placeholder: '暫停原因（選填）', 'aria-label': '暫停原因' });
  return h('details.pause-ctl', {}, h('summary', {}, '暫停開發'),
    h('div', {}, reason, h('button.btn', { type: 'button', onclick: event => send(event.currentTarget, { action: 'pause', reason: reason.value.trim() || null }, '暫停開發', '確定暫停這個專案的開發？正在處理的版本會先做完這一輪，之後 runner 不再接新工作，直到你恢復。') }, '確定暫停')));
}
let lastProject = null;
function renderProject(snapshot) {
  lastProject = snapshot;
  const project = snapshot.project;
  crumb.textContent = project.name;
  if (snapshot.engineVersion) ver.textContent = `v${snapshot.engineVersion}`;
  const team = agents(snapshot.roles);
  replaceApp(
    h('header.head.rise', {}, h('div.ident', {}, h('a.back', { href: '#/', 'aria-label': '返回總覽' }, icon(ICON.back, 16)), h('span.tile', {}, initial(project.name)),
      h('div', {}, h('h1', { style: 'font-size:22px;font-weight:600;letter-spacing:-.015em' }, project.name), h('small', { title: project.root }, project.root))),
      h('div.roles', {}, team.map(agent => h('span.role', { title: agent.name }, avatar(agent), agent.labels.join('／'))),
        snapshot.adr ? h(`span.pill${snapshot.adr.status === 'approved' ? '.ok' : '.warn'}`, { title: snapshot.adr.path }, `ADR ${snapshot.adr.status === 'approved' ? '已核准' : '待核准'}`) : null,
        h(`span.pill${(STATUS[snapshot.service.status] ?? [])[1] ? `.${STATUS[snapshot.service.status][1]}` : ''}`, { title: snapshot.service.reason ?? '' }, (STATUS[snapshot.service.status] ?? [snapshot.service.status])[0]),
        h('span.pill.plain', { title: '交付與批准方式' }, `${project.delivery?.merge === 'manual' ? '你合併' : '自動合併'} · ${project.autoApprove ? 'AI 批准' : '人工批准'}`),
        project.paused ? null : pauseBar(snapshot))),
    project.paused ? pauseBar(snapshot) : '',
    pipelines(snapshot.streams),
    h('section.split', {}, consoleCard(snapshot.streams), decisions(snapshot)),
    evidence(snapshot) ?? '',
    waiverPanel(snapshot) ?? '',
    lists(snapshot));
}
const rerender = () => { if (lastProject) renderProject(lastProject); else if (view() === 'inbox' && overviewData) renderInbox(overviewData); };
setInterval(() => document.querySelectorAll('[data-since]').forEach(node => { if (node.dataset.since) node.textContent = elapsed(node.dataset.since); }), 1000);

// ---- title, icon and notifications: what waits for you reaches you on another tab or app ----
const favicon = document.getElementById('favicon');
const TITLE = document.title;
function badge(data) {
  const due = data.projects.reduce((sum, project) => sum + (project.attention ?? 0), 0);
  document.title = due ? `(${due}) ${TITLE}` : TITLE;
  const count = due > 99 ? '99+' : String(due);
  const dot = due ? `<circle cx="23" cy="9" r="9" fill="#D97706"/><text x="23" y="12.6" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${count.length > 1 ? 9 : 11}" font-weight="700" fill="#fff">${count}</text>` : '';
  favicon.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="17" height="17" rx="5" fill="#0E1116"/><rect x="11" y="11" width="17" height="17" rx="5" fill="#0FA98F" fill-opacity=".9"/>${dot}</svg>`)}`;
}
const notifyOn = () => 'Notification' in window && Notification.permission === 'granted' && stored('protoflow.notify') === 'on';
const itemKey = (project, item) => `${project.id}:${item.kind}:${item.deliveryId ?? item.verificationId ?? item.number ?? item.manifestId ?? item.status ?? ''}`;
let known = null;
/** A new item since the last push: a toast while you look at the page, a desktop notification (if allowed) while you don't. */
function notifyNew(data) {
  const keys = new Set(), fresh = [];
  for (const project of data.projects) {
    // A project that failed to read keeps its items, so a passing read error does not announce them again.
    if (project.error) { for (const key of known ?? []) if (key.startsWith(`${project.id}:`)) keys.add(key); continue; }
    for (const item of project.inbox ?? []) { const key = itemKey(project, item); keys.add(key); if (known && !known.has(key)) fresh.push({ project, item, key }); }
  }
  known = keys;
  if (!fresh.length) return;
  const say = ({ project, item }) => `${project.name} · ${KIND[item.kind] ?? item.kind}`;
  if (!document.hidden) { toast(fresh.length === 1 ? `新的事等你：${say(fresh[0])}` : `${fresh.length} 件新的事等你決定`); return; }
  if (!notifyOn()) return;
  for (const { project, item, key } of byUrgency(fresh.map(entry => ({ ...entry.item, entry }))).map(item => item.entry).slice(0, 3)) {
    const note = new Notification(say({ project, item }), { body: item.diagnosis?.title ?? item.title ?? item.reason ?? '', tag: key });
    note.onclick = () => { window.focus(); location.hash = `#/p/${project.id}`; note.close(); };
  }
}

// ---- sidebar: every project on every view, with where it is and what waits for a person ----
const side = document.getElementById('side'), navList = document.getElementById('nav-list'), navInd = side.querySelector('.nav-ind'), menu = document.getElementById('menu'), scrim = document.getElementById('scrim');
const narrow = matchMedia('(max-width:900px)');
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private window: the choice lasts this visit */ } };
/** The stream that most needs a look (blocked, then working), else whether every target is done. */
function headline(project) {
  if (project.error) return { label: '讀取失敗', tone: 'bad', stream: null };
  if (project.paused) return { label: '已暫停', tone: 'idle', stream: project.streams?.[0] ?? null };
  const streams = project.streams ?? [], where = stream => streams.length > 1 ? ` · ${targetName(stream.target)}` : '';
  const blocked = streams.find(stream => stream.stage === 'blocked');
  if (blocked) return { label: `阻塞${where(blocked)}`, tone: 'bad', stream: blocked };
  const working = streams.find(active);
  if (working) return { label: `${STAGE_LABEL[working.stage] ?? working.stage}${where(working)}`, tone: 'now', stream: working };
  const stopped = streams.find(stream => stream.stopped);
  if (stopped) return { label: `已停止${where(stopped)}`, tone: 'stop', stream: stopped };
  const finished = streams.filter(stream => position(stream).at === STAGES.length).length;
  if (finished && finished === streams.length) return { label: '完成', tone: 'ok', stream: streams[0] };
  return { label: finished ? `${finished}/${streams.length} 完成` : '閒置', tone: 'idle', stream: streams[0] ?? null };
}
const segments = stream => {
  const { at, tone } = stream ? position(stream) : { at: -1 };
  return h('span.nav-segs', { 'aria-hidden': 'true' }, STAGES.map((_, i) => h(`i${i < at ? '.done' : i === at ? `.${tone === 'bad' || tone === 'stop' ? tone : 'now'}` : ''}`)));
};
const currentId = () => /^#\/p\/([0-9a-f]{12})$/.exec(location.hash)?.[1] ?? null;
const view = () => currentId() ? 'project' : location.hash === '#/inbox' ? 'inbox' : 'overview';
const currentHref = () => currentId() ? `#/p/${currentId()}` : view() === 'inbox' ? '#/inbox' : '#/';
function renderSide(data = overviewData) {
  if (!data) return;
  const here = currentHref(), projects = data.projects;
  const focused = navList.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  const due = projects.reduce((sum, project) => sum + (project.attention ?? 0), 0);
  const item = (href, tile, name, sub, count, on, tip) => h(`a.nav-item${on ? '.here' : ''}`, { href, 'aria-current': on ? 'page' : null, 'data-tip': tip },
    h(`span.nav-tile${tile.home ? '.home' : ''}`, { 'data-due': count || null }, tile.glyph, tile.tone ? h(`i.nav-dot.${tile.tone}`) : null),
    h('span.nav-text', {}, h('b', {}, name), sub), count ? h('span.nav-due', { title: `${count} 件等你決定` }, String(count)) : null);
  navList.replaceChildren(
    item('#/', { home: true, glyph: icon(ICON.grid, 16) }, '總覽', h('small', {}, `${projects.length} 個專案`), 0, here === '#/', `總覽 · ${projects.length} 個專案`),
    item('#/inbox', { home: true, glyph: icon(ICON.inbox, 16) }, '等你', h('small', {}, due ? `${due} 件等你決定` : '沒有待辦'), due, here === '#/inbox', due ? `等你 · ${due} 件` : '等你 · 沒有待辦'),
    h('span.nav-label', { 'aria-hidden': 'true' }, '專案'),
    ...projects.map(project => {
      const head = headline(project);
      return item(`#/p/${project.id}`, { glyph: initial(project.name), tone: head.tone }, project.name,
        h('small', {}, h(`span.nav-state.${head.tone}`, {}, head.label), segments(head.stream)), project.attention, `#/p/${project.id}` === here, `${project.name} · ${head.label}`);
    }));
  if (focused) navList.querySelector(`a[href="${focused}"]`)?.focus();
  placeIndicator();
}
/** The highlight glides to the current item instead of jumping. */
function placeIndicator() {
  const on = navList.querySelector('.nav-item.here');
  navInd.style.opacity = on ? '1' : '0';
  if (on) { navInd.style.transform = `translateY(${on.offsetTop}px)`; navInd.style.height = `${on.offsetHeight}px`; }
  requestAnimationFrame(() => navInd.classList.add('ready'));
}
const syncMenu = () => menu.setAttribute('aria-expanded', String(narrow.matches ? document.body.classList.contains('side-open') : !document.body.classList.contains('side-mini')));
function setMini(on) { document.body.classList.toggle('side-mini', on); store('protoflow.sidebar', on ? 'mini' : 'full'); syncMenu(); }
function setDrawer(open) { document.body.classList.toggle('side-open', open); scrim.hidden = !open; syncMenu(); }
menu.addEventListener('click', () => narrow.matches ? setDrawer(!document.body.classList.contains('side-open')) : setMini(!document.body.classList.contains('side-mini')));
scrim.addEventListener('click', () => setDrawer(false));
// Picking the page already shown fires no hashchange, so the drawer closes on the click itself.
navList.addEventListener('click', event => { if (event.target.closest('.nav-item')) setDrawer(false); });
narrow.addEventListener('change', () => setDrawer(false));
// A collapsed sidebar names each project in a tip beside it, positioned outside the scrolling list.
const tip = h('div.nav-tip', { 'aria-hidden': 'true', hidden: true });
document.body.append(tip);
const showTip = event => {
  const link = event.target.closest?.('.nav-item');
  if (!link || narrow.matches || !document.body.classList.contains('side-mini')) { tip.hidden = true; return; }
  const box = link.getBoundingClientRect();
  tip.textContent = link.dataset.tip; tip.style.top = `${box.top + box.height / 2}px`; tip.style.left = `${box.right + 12}px`; tip.hidden = false;
};
navList.addEventListener('pointerover', showTip); navList.addEventListener('focusin', showTip);
navList.addEventListener('pointerleave', () => { tip.hidden = true; }); navList.addEventListener('focusout', () => { tip.hidden = true; });
side.addEventListener('transitionend', event => { if (event.target === side) placeIndicator(); });
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]') || event.target.closest?.('input,textarea,select,[contenteditable]')) return;
  if (event.key === 'Escape' && document.body.classList.contains('side-open')) return setDrawer(false);
  if (event.key === '[' && !event.metaKey && !event.ctrlKey && !event.altKey) return menu.click();
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const links = [...navList.querySelectorAll('a.nav-item')], step = event.key === 'ArrowDown' ? 1 : -1;
  // ⌥↑↓ switches project from anywhere; plain ↑↓ moves focus within the list.
  if (event.altKey) {
    // From the address, not the highlight: a quick second press lands before hashchange redraws the list.
    const at = currentHref();
    const next = links[links.findIndex(link => link.getAttribute('href') === at) + step];
    if (next) { event.preventDefault(); location.hash = next.getAttribute('href'); }
  } else if (links.includes(document.activeElement)) {
    event.preventDefault();
    links[Math.min(links.length - 1, Math.max(0, links.indexOf(document.activeElement) + step))].focus();
  }
});
if (stored('protoflow.sidebar') === 'mini') document.body.classList.add('side-mini');
syncMenu();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('side-ready')));

function route() {
  const id = currentId();
  lastProject = null;
  done.clear();
  document.body.classList.remove('settled');
  // The previous view dims until the next one paints, so a switch never flashes an empty page.
  if (app.childElementCount) app.classList.add('swap');
  window.scrollTo(0, 0);
  source?.close();
  source = null;
  setDrawer(false);
  renderSide();
  if (id) {
    crumb.textContent = overviewData?.projects.find(project => project.id === id)?.name ?? '';
    openProject();
  } else {
    setConn(overview.readyState === EventSource.OPEN);
    if (overviewData) paint(view() === 'inbox' ? renderInbox : renderOverview, overviewData);
  }
}
const openProject = () => { source = watch(new EventSource(`/api/projects/${currentId()}/stream`), data => paint(renderProject, data)); };
// A hidden page stops its project stream (the server stops polling a view nobody watches) and picks it up on return;
// the overview stream stays open, so the title and notifications keep up while you work elsewhere.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { source?.close(); return; }
  if (currentId() && source?.readyState === EventSource.CLOSED) openProject();
});
window.addEventListener('hashchange', route);
route();
