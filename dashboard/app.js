// ProtoFlow dashboard (proposal 0004). Plain DOM, no build step: every value is inserted as text, never as HTML.
const TOKEN = document.querySelector('meta[name="protoflow-token"]').content;
const app = document.getElementById('app'), crumb = document.getElementById('crumb'), conn = document.getElementById('conn'), ver = document.getElementById('ver');

const STAGES = [['plan', '規劃'], ['execute', '實作'], ['verify', '驗收'], ['review', '審查'], ['deliver', '交付']];
const STAGE_LABEL = { idle: '閒置', blocked: '阻塞', plan: '規劃', execute: '實作', verify: '驗收', review: '審查', deliver: '交付' };
const STATUS = { PASS: ['通過', 'ok'], FAIL: ['未過', 'bad'], NOT_RUN: ['未執行', ''], BLOCKED: ['阻塞', 'bad'], RUNNING: ['進行中', 'ok'], PENDING: ['等待', ''], STOPPED: ['已停止', 'warn'], MERGED: ['已合併', 'ok'], PR_OPEN_MANUAL: ['待你合併', 'warn'], REVOKED: ['已撤回', ''], COMMITTED: ['已提交', 'ok'], HEALTHY: ['常駐', 'ok'], DEGRADED: ['連線異常', 'bad'], STALLED: ['無回應', 'bad'], DOWN: ['已停止', 'bad'], STARTING: ['啟動中', 'ok'], NOT_INSTALLED: ['未常駐', ''], HEARTBEAT: ['前景執行', 'ok'], UNKNOWN: ['未知', ''] };
const ISSUE = { planned: ['已規劃', 'ok'], 'needs-info': ['需要資訊', 'warn'], 'needs-human': ['需要你決定', 'warn'], rejected: ['不處理', ''], 'in-progress': ['實作中', 'ok'], blocked: ['阻塞', 'bad'], done: ['完成', 'ok'], new: ['新', ''], 'triage-failed': ['分流失敗', 'bad'], closed: ['已關閉', ''] };
const PHASE = { execute: '執行者', build: '建置', functional: '功能測試', visual: '比對', 'visual-driver': '畫面擷取' };
const TIERS = [['structure', '結構'], ['tokens', '配色'], ['layout', '版面'], ['visual', '視覺']];
const ICON = {
  merge: 'M5 3v12M13 3v3a4 4 0 0 1-4 4H5', tag: 'M3 3h6l6 6-6 6-6-6zM6.5 6.5h.01', issue: 'M9 2.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM9 6v3.5M9 12.2h.01',
  retry: 'M3.5 9a5.5 5.5 0 1 0 1.6-3.9M3.5 3.5v3h3', review: 'M7.5 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM11 11l4 4', alert: 'M9 3 2.5 14.5h13zM9 7.5v3M9 12.6h.01', check: 'm4 9.5 3.2 3L14 6', back: 'M10 3 5 8l5 5', clock: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 5v3.3l2 1.4'
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
const targetName = target => target ?? '應用';
const initial = name => [...String(name ?? '?')][0].toUpperCase();
const active = stream => !['idle', 'blocked'].includes(stream.stage);

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
  if (stream.stage === 'idle') return { at: ['MERGED', 'COMMITTED'].includes(stream.deliveries?.[0]?.status ?? stream.lastDelivery?.status) || stream.versions?.[0]?.status === 'PASS' ? STAGES.length : -1, tone: 'idle' };
  return { at: STAGES.findIndex(([key]) => key === stream.stage), tone: 'now' };
}
const glyphOf = action => ({ say: '◆', read: '↗', edit: '✎', write: '+', run: '▸', search: '⌕', tool: '·', done: action.ok === false ? '✕' : '✓' })[action.kind] ?? '·';
const ACT = { say: '說明', read: '讀取', edit: '編輯', write: '新增', run: '執行', search: '搜尋', tool: '工具', done: '結束' };
/** The live strip on a project card: which version, which phase, how long, and the executor's latest action. */
function nowStrip(stream) {
  const since = stream.phaseStartedAt ?? stream.current?.attemptStartedAt;
  const phase = stream.phase ? PHASE[stream.phase.split(':')[0]] ?? stream.phase : STAGE_LABEL[stream.stage];
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
      live.totals ? h('em', {}, `✎${live.totals.edits} ▸${live.totals.commands}`) : null) : null);
}
function miniTrack(stream) {
  const { at, tone } = position(stream);
  const fraction = at <= 0 ? 0 : Math.min(at, STAGES.length - 1) / (STAGES.length - 1);
  const label = stream.stage === 'idle' ? (at === STAGES.length ? '完成' : '閒置') : STAGE_LABEL[stream.stage] ?? stream.stage;
  return h('div.mini', {}, h('span', {}, targetName(stream.target)),
    h('div.rail', { role: 'img', 'aria-label': `${targetName(stream.target)}：${label}` }, h('i.bed'), h('i.fill', { style: `width:calc((100% - 12px) * ${fraction})` }), active(stream) ? h('i.flow', { style: `width:calc((100% - 12px) * ${fraction})` }) : null,
      h('div.dots', {}, STAGES.map(([, name], i) => h(`span.dot${i < at ? '.done' : i === at ? (tone === 'bad' ? '.bad' : '.now') : ''}${i === at && tone === 'now' ? '.live-dot' : ''}`, { title: name })))),
    h(`em${tone === 'now' ? '.now' : tone === 'bad' ? '.bad' : ''}`, {}, label));
}

function toast(text, bad = false) {
  const box = document.getElementById('toast');
  box.textContent = text; box.className = bad ? 'bad' : ''; box.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, bad ? 9000 : 5000);
}

// ---- data: one EventSource per view, reconnecting on its own ----
let source = null;
function subscribe(url, render) {
  source?.close();
  source = new EventSource(url);
  source.onopen = () => { conn.textContent = '即時'; conn.className = 'conn live'; };
  source.onerror = () => { conn.textContent = '重新連線中'; conn.className = 'conn'; };
  // Entrance motion plays once per view; later pushes redraw in place without replaying it.
  source.onmessage = message => { render(JSON.parse(message.data)); setTimeout(() => document.body.classList.add('settled'), 900); };
  source.addEventListener('failure', message => toast(`讀取失敗：${JSON.parse(message.data).error}`, true));
}
async function act(projectId, body, label) {
  const response = await fetch(`/api/projects/${projectId}/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-protoflow-token': TOKEN }, body: JSON.stringify(body) });
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
      h('h1', {}, `${projects.length} 個專案`, h('br'), due ? [h('b', {}, `${due} 件`), '等你決定'] : ['一切', h('b', {}, '順暢')])),
      h('div.gauges', {}, gauge('常駐', healthy, healthy / projects.length, 'var(--mint)'), gauge('進行中', busy, busy / projects.length, 'var(--ink)'),
        gauge('等你', due, projects.filter(project => project.attention).length / projects.length, 'var(--amber)'))),
    h('section.cards', {}, projects.map((project, index) => h(`a.card.rise${project.streams?.some(active) ? '.busy' : ''}`, { href: `#/p/${project.id}`, style: `animation-delay:${index * 60}ms` },
      h('div.card-h', {}, h('div.ident', {}, h('span.tile', {}, initial(project.name)), h('div', {}, h('b', {}, project.name), h('small', {}, project.root?.split('/').slice(-2).join('/') ?? ''))),
        project.service ? pill(project.service.status) : null),
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
/** Every target in one panel: a row per target, the stage names once as column heads so the nodes line up. */
function pipelines(streams) {
  const lane = stream => {
    const { at, tone } = position(stream);
    const fraction = at <= 0 ? 0 : Math.min(at, STAGES.length - 1) / (STAGES.length - 1);
    const since = stream.phaseStartedAt ?? stream.current?.attemptStartedAt;
    const sub = [stream.current?.summary, stream.phase ? PHASE[stream.phase.split(':')[0]] ?? stream.phase : null, stream.phase?.includes(':') ? stream.phase.split(':')[1] : null].filter(Boolean).join(' · ');
    const state = stream.stage === 'idle' ? (at === STAGES.length ? '完成' : '閒置') : STAGE_LABEL[stream.stage] ?? stream.stage;
    return h(`div.lane${active(stream) ? '.on' : ''}`, { 'aria-label': `${targetName(stream.target)}：${state}` },
      h('div.lane-name', {}, h('b', {}, targetName(stream.target)), sub ? h('span', { title: sub }, sub) : null),
      h('div.track', {}, h('i.bed'), h('i.fill', { style: `width:calc((100% - 2 * var(--inset)) * ${fraction})` }), active(stream) ? h('i.flow', { style: `width:calc((100% - 2 * var(--inset)) * ${fraction})` }) : null,
        h('ol', {}, STAGES.map(([, label], i) => h(`li${i < at ? '.done' : i === at ? `.${tone === 'bad' ? 'bad' : 'now'}${tone === 'idle' ? '.idle' : ''}` : ''}`, { title: label },
          h(`span.node${i === at && tone === 'now' ? '.live-dot' : ''}`, {}, i < at ? icon(ICON.check, 14) : i === at && tone === 'bad' ? '!' : ''), h('span.sr', {}, label))))),
      h('div.lane-state', {}, h(`em${tone === 'now' ? '.now' : tone === 'bad' ? '.bad' : ''}`, {}, state),
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
      live ? h(`span.who${live.executor === 'codex' ? '.codex' : ''}`, {}, h('b', {}, live.executor === 'codex' ? 'C' : /opus/i.test(live.model ?? '') ? 'O' : 'S'), `${live.model ?? live.executor} · ${targetName(stream.target)}`) : h('span', {}, 'agent'),
      h('span', {}, live ? (live.running ? `編輯 ${live.totals.edits} · 命令 ${live.totals.commands}` : `上次 ${ago(live.updatedAt)}`) : '')),
    live ? [list, live.files?.length ? h('div.files', {}, live.files.slice(-6).map(file => h('span', { title: file }, file.split('/').pop()))) : null]
      : h('p.quiet', {}, '目前沒有代理在工作'));
}
function decisions(snapshot) {
  const items = snapshot.attention;
  const id = snapshot.project.id;
  const run = async (box, body, label, question, result) => {
    if (!confirm(question)) return;
    box.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const response = await act(id, body, label);
      done.set(keyOf(body), `${result}${response.next ? ` · ${response.next}` : ''}`);
      rerender();
    } catch (error) { toast(`${label}失敗：${error.message}`, true); box.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  };
  const keyOf = body => JSON.stringify(body);
  const card = (item, glyph, title, sub, extra, buttons) => {
    const body = buttons?.[0]?.body;
    const signed = body ? done.get(keyOf(body)) : null;
    const box = h(`div.ask.rise${signed ? '.done' : buttons ? '' : '.calm'}`, {},
      h('div.ask-h', {}, h('span.glyph', {}, icon(signed ? ICON.check : glyph)), h('div', {}, h('b', {}, title), sub ? h('p', { title: sub }, sub) : null)), extra);
    if (signed) box.append(h('div.signed', {}, icon(ICON.check, 16), h('span', {}, signed)));
    else if (buttons) box.append(h('div.btns', {}, buttons.map((button, i) => button.href ? h('a.btn', { href: button.href, target: '_blank', rel: 'noopener' }, button.label)
      : h(`button.btn${i === 0 ? '.primary' : ''}`, { type: 'button', onclick: () => run(box, button.body, button.label, button.question, button.result) }, button.label))));
    return box;
  };
  const cards = items.map(item => {
    const where = snapshot.streams.length > 1 ? `${targetName(item.target)} · ` : '';
    if (item.kind === 'manual-merge') return card(item, ICON.merge, `${where}${item.title} 可合併`, `已驗收並通過獨立審查 · ${item.commit?.slice(0, 7) ?? ''}`, null,
      [{ label: '核准並合併', body: { action: 'merge', target: item.target, deliveryId: item.deliveryId }, question: `確定以你的 GitHub 身分合併 ${item.title}？只會合併審查過的 commit。`, result: '已核准 · 合併中' }, item.pr ? { label: 'GitHub', href: item.pr } : null].filter(Boolean));
    if (item.kind === 'issue') return card(item, ICON.issue, `#${item.number} ${item.title ?? ''}`, item.reason ?? (ISSUE[item.status] ?? [item.status])[0],
      item.questions?.length ? h('ul.qs', {}, item.questions.map(question => h('li', { title: question }, question))) : null,
      [{ label: '交回 AI', body: { action: 'handback', number: item.number }, question: `確定把 #${item.number} 交回 AI 重新分流？這會以你的 GitHub 身分移除狀態標籤。`, result: '已交回 AI' }, item.url ? { label: 'GitHub', href: item.url } : null].filter(Boolean));
    if (item.kind === 'review') return card(item, ICON.tag, `${where}${item.title} 待核准`, `驗收 ${item.verificationId} 已通過`, null,
      [{ label: '核准版本', body: { action: 'approve', target: item.target, manifestId: item.manifestId, verificationId: item.verificationId }, question: `確定以你的名字核准這個版本？核准綁定驗收 ${item.verificationId}。`, result: '已核准' }]);
    if (item.kind === 'review-rejected') return card(item, ICON.review, `${where}${item.title} 審查未過`, item.reason,
      h('ul.findings', {}, item.findings.map(finding => h(`li.${finding.severity}`, { title: finding.description }, finding.file ? h('code', {}, finding.file.split('/').pop()) : null, finding.description))),
      [{ label: '退回重修', body: { action: 'request-changes', target: item.target, deliveryId: item.deliveryId }, question: `同意獨立審查的 ${item.findings.length} 項發現，把這個版本退回給執行代理重修？會以你的名字記錄「要求修改」，綁定這次驗收。`, result: '已退回 · 下一輪重修' }]);
    if (item.kind === 'blocked-version') return card(item, ICON.retry, `${where}${item.title} 阻塞`, item.reason, null,
      [{ label: '重試', body: { action: 'retry', target: item.target }, question: '確定已處理阻塞原因並重試這個版本？', result: '已重新排入' }]);
    return card(item, ICON.alert, item.title ?? item.kind, item.reason, item.pr ? h('a', { href: item.pr, target: '_blank', rel: 'noopener' }, 'GitHub') : null, null);
  });
  const open = items.filter(item => item.actions?.length).length;
  return h('div.decide', { 'aria-label': '需要你' },
    h('div.decide-h', {}, h('span.label', {}, '需要你'), h('b', {}, String(open))),
    cards.length ? cards : h('div.ask.calm', {}, h('div.ask-h', {}, h('span.glyph', {}, icon(ICON.check)), h('div', {}, h('b', {}, '沒有需要你決定的事')))),
    h('div.calm-note', {}, icon(ICON.clock, 16), '以你的 GitHub 身分執行 · 記錄於 actions.jsonl'));
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
    const tiers = TIERS.map(([tier, label]) => { const status = scene.tiers[tier]; const ref = tier === 'visual' && status !== 'NOT_RUN'; return h(`span.pill${ref ? '' : (STATUS[status] ?? [])[1] ? `.${STATUS[status][1]}` : ''}`, {}, `${label} ${ref ? '參考' : (STATUS[status] ?? [status])[0]}`); });
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
      h('div', {}, h('b', {}, '原型 ↔ App'), h('small', {}, `${pass} / ${scenes.length} 場景 · `, h('span.mono', {}, report.id)))),
      h('div.checks', {}, withVer.length > 1 ? segs(withVer, stream => stream === current, stream => { selected.ver = String(stream.target); }, stream => targetName(stream.target)) : null,
        variants.length > 1 ? segs(variants, name => name === variant, name => { selected[vkey] = name; }, name => name) : null)),
    h('div.checks', {}, [['建置', report.variants?.[variant] ?? report.build], ['功能測試', report.functional], ['比對', report.visual ?? report.status]].map(([label, status]) => h(`span.pill${(STATUS[status] ?? [])[1] ? `.${STATUS[status][1]}` : ''}`, { title: status }, `${label} ${(STATUS[status] ?? [status])[0]}`))),
    scenes.length ? h('div.scenes', {}, scenes.slice(0, 24).map((scene, index) => h(`article.scene${scene.status === 'FAIL' ? '.fail' : ''}`, { 'aria-label': scene.id },
      h('div.pair', {}, shot(scene.prototype, '原型', () => viewer(snapshot.project.id, scenes, index)), shot(scene.application, 'App', () => viewer(snapshot.project.id, scenes, index))),
      h('div.scene-f', {}, h('b', { title: scene.id }, scene.id),
        h('span.tiers', { role: 'img', 'aria-label': TIERS.map(([tier, label]) => `${label} ${(STATUS[scene.tiers[tier]] ?? [scene.tiers[tier]])[0]}`).join('，') },
          TIERS.map(([tier, label]) => h(`i.${tier === 'visual' && scene.tiers[tier] !== 'NOT_RUN' ? 'ref' : scene.tiers[tier]}`, { title: `${label}：${tier === 'visual' && scene.tiers[tier] !== 'NOT_RUN' ? '參考' : (STATUS[scene.tiers[tier]] ?? [scene.tiers[tier]])[0]}` })))),
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
      h('div', {}, h('b', {}, `${many ? `${targetName(version.target)} · ` : ''}${version.sha?.slice(0, 7) ?? version.manifestId}`), h('span', { title: version.summary ?? version.error ?? '' }, version.summary ?? version.error ?? '')), pill(version.status)))) : h('p.empty', {}, '還沒有原型版本')),
    panel('交付', null, deliveries.length ? h('ul.feed', {}, deliveries.slice(0, 8).map(delivery => h('li', {}, h('time', {}, clock(delivery.updatedAt)), h(`i.${delivery.manualMerge ? 'ok' : TONE(delivery.status) || 'ink'}`),
      h('span', { title: delivery.error ?? '' }, `${many ? `${targetName(delivery.target)} · ` : ''}${(STATUS[delivery.manualMerge ? 'MERGED' : delivery.status] ?? [delivery.status])[0]}`),
      delivery.pr ? h('a', { href: delivery.pr, target: '_blank', rel: 'noopener' }, `PR #${delivery.prNumber}`) : h('span')))) : h('p.empty', {}, '還沒有交付')),
    panel('Issue', null, snapshot.issues.length ? h('ul.feed', {}, snapshot.issues.slice(0, 8).map(issue => h('li', {},
      issue.url ? h('a.mono', { href: issue.url, target: '_blank', rel: 'noopener' }, `#${issue.number}`) : h('time', {}, `#${issue.number}`), h(`i.${TONE(issue.status) || 'ink'}`),
      h('span', { title: issue.title ?? '' }, issue.title ?? ''), h('span.muted', {}, (ISSUE[issue.status] ?? [issue.status])[0])))) : h('p.empty', {}, '沒有 Issue')),
    panel('動態', sparkline(snapshot.events), snapshot.events.length ? h('ul.feed', {}, snapshot.events.slice(0, 8).map(event => h('li', {}, h('time', {}, clock(event.at)), h(`i.${eventTone(event)}`),
      h('span', { title: event.reason ?? event.error ?? '' }, `${event.target && many ? `${event.target} · ` : ''}${event.event}${event.number ? ` #${event.number}` : ''}${event.status ? ` · ${event.status}` : ''}`), h('span')))) : h('p.empty', {}, '還沒有事件')));
}
let lastProject = null;
function renderProject(snapshot) {
  lastProject = snapshot;
  const project = snapshot.project;
  crumb.textContent = project.name;
  if (snapshot.engineVersion) ver.textContent = `v${snapshot.engineVersion}`;
  const team = agents(snapshot.roles);
  app.replaceChildren(
    h('header.head.rise', {}, h('div.ident', {}, h('a.back', { href: '#/', 'aria-label': '返回總覽' }, icon(ICON.back, 16)), h('span.tile', {}, initial(project.name)),
      h('div', {}, h('h1', { style: 'font-size:22px;font-weight:600;letter-spacing:-.015em' }, project.name), h('small', { title: project.root }, project.root))),
      h('div.roles', {}, team.map(agent => h('span.role', { title: agent.name }, avatar(agent), agent.labels.join('／'))),
        snapshot.adr ? h(`span.pill${snapshot.adr.status === 'approved' ? '.ok' : '.warn'}`, { title: snapshot.adr.path }, `ADR ${snapshot.adr.status === 'approved' ? '已核准' : '待核准'}`) : null,
        h(`span.pill${(STATUS[snapshot.service.status] ?? [])[1] ? `.${STATUS[snapshot.service.status][1]}` : ''}`, { title: snapshot.service.reason ?? '' }, (STATUS[snapshot.service.status] ?? [snapshot.service.status])[0]),
        h('span.pill.plain', { title: '交付與批准方式' }, `${project.delivery?.merge === 'manual' ? '你合併' : '自動合併'} · ${project.autoApprove ? 'AI 批准' : '人工批准'}`))),
    pipelines(snapshot.streams),
    h('section.split', {}, consoleCard(snapshot.streams), decisions(snapshot)),
    evidence(snapshot) ?? '',
    lists(snapshot));
}
const rerender = () => { if (lastProject) renderProject(lastProject); };
setInterval(() => document.querySelectorAll('[data-since]').forEach(node => { if (node.dataset.since) node.textContent = elapsed(node.dataset.since); }), 1000);

function route() {
  const match = /^#\/p\/([0-9a-f]{12})$/.exec(location.hash);
  lastProject = null;
  done.clear();
  document.body.classList.remove('settled');
  window.scrollTo(0, 0);
  if (match) subscribe(`/api/projects/${match[1]}/stream`, renderProject);
  else subscribe('/api/stream', renderOverview);
}
window.addEventListener('hashchange', route);
route();
