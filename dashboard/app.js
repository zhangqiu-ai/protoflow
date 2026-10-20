// ProtoFlow dashboard (proposal 0004). Plain DOM, no build step: every value is inserted as text, never as HTML.
const TOKEN = document.querySelector('meta[name="protoflow-token"]').content;
const app = document.getElementById('app'), crumb = document.getElementById('crumb'), conn = document.getElementById('conn');

const STAGES = [['plan', '規劃'], ['execute', '實作'], ['verify', '驗收'], ['review', '獨立審查'], ['deliver', '交付']];
const STAGE_LABEL = { idle: '閒置', blocked: '阻塞', plan: '規劃', execute: '實作', verify: '驗收', review: '獨立審查', deliver: '交付' };
const STATUS = { PASS: ['通過', 'ok'], FAIL: ['未過', 'bad'], NOT_RUN: ['未執行', ''], BLOCKED: ['阻塞', 'bad'], RUNNING: ['進行中', 'now'], PENDING: ['等待', ''], STOPPED: ['已停止', 'warn'], MERGED: ['已合併', 'ok'], PR_OPEN_MANUAL: ['待你合併', 'warn'], REVOKED: ['已撤回', ''], COMMITTED: ['已提交', 'now'], HEALTHY: ['健康', 'ok'], DEGRADED: ['連線異常', 'bad'], DOWN: ['已停止', 'bad'], STARTING: ['啟動中', 'now'], NOT_INSTALLED: ['未常駐', 'warn'], HEARTBEAT: ['前景執行', 'now'], UNKNOWN: ['未知', ''], IDLE: ['閒置', ''] };
const ISSUE = { planned: ['已規劃', 'now'], 'needs-info': ['需要資訊', 'warn'], 'needs-human': ['需要你決定', 'warn'], rejected: ['不處理', ''], 'in-progress': ['實作中', 'now'], blocked: ['阻塞', 'bad'], done: ['完成', 'ok'], new: ['新', ''], 'triage-failed': ['分流失敗', 'bad'], closed: ['已關閉', ''] };
const PHASE = { execute: '執行者', build: '建置', functional: '功能測試', visual: '比對', 'visual-driver': '畫面擷取' };
const ACT = { say: '說明', read: '讀取', edit: '編輯', write: '新增', run: '執行', search: '搜尋', tool: '工具', done: '結束' };
const TIERS = [['structure', '結構'], ['tokens', '配色'], ['layout', '版面'], ['visual', '視覺']];

/** Element helper: h('div.card', {attr}, ...children); strings become text nodes. */
function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name);
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const chip = (status, map = STATUS) => { const [label, tone] = map[status] ?? [status ?? '—', '']; return h(`span.chip${tone ? `.${tone}` : ''}`, {}, label); };
const ago = iso => { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分前` : s < 86400 ? `${Math.floor(s / 3600)} 小時前` : `${Math.floor(s / 86400)} 天前`; };
const clock = iso => iso ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
const elapsed = iso => { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return `已 ${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`; };
const model = role => role ? `${role.provider === 'claude' ? 'Claude' : role.provider === 'codex' ? 'Codex' : role.provider}${role.model ? ` · ${role.model}` : ''}` : '未設定';
const targetName = target => target ?? '應用';

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
  source.onerror = () => { conn.textContent = '重新連線中…'; conn.className = 'conn'; };
  source.onmessage = message => render(JSON.parse(message.data));
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
  crumb.textContent = '所有專案';
  if (!data.projects.length) {
    app.replaceChildren(h('section.card', {}, h('h2', {}, '還沒有專案'), h('p.muted', {}, '在專案目錄執行 protoflow dashboard add --project .，或安裝常駐服務（runner service install）時會自動加入。')));
    return;
  }
  app.replaceChildren(
    h('div.top', {}, h('div', {}, h('span.eyebrow', {}, 'ProtoFlow'), h('h1', {}, `${data.projects.length} 個專案`)),
      h('div.tiles', {}, h('div.tile', {}, h('span', {}, '待你處理'), h('b', {}, String(data.projects.reduce((sum, project) => sum + (project.attention ?? 0), 0)))), h('div.tile', {}, h('span', {}, '進行中'), h('b', {}, String(data.projects.filter(project => project.streams?.some(stream => !['idle', 'blocked'].includes(stream.stage))).length))))),
    h('div.grid', {}, data.projects.map(project => h('a.card.proj', { href: `#/p/${project.id}` },
      h('div.card-h', {}, h('h2', {}, project.name), project.service ? chip(project.service.status) : null),
      project.error ? h('p.muted', {}, `讀取失敗：${project.error}`) : [
        h('div', {}, project.streams.map(stream => h('div.row', {}, h('b', {}, targetName(stream.target)), chip(stream.stage === 'idle' ? 'IDLE' : stream.stage === 'blocked' ? 'BLOCKED' : 'RUNNING'), h('span.muted', {}, stream.stage === 'idle' ? (stream.lastDelivery ? `最近交付 ${ago(stream.lastDelivery.updatedAt)}` : '') : `${STAGE_LABEL[stream.stage] ?? stream.stage}${stream.phase ? ` · ${PHASE[stream.phase] ?? stream.phase}` : ''}${stream.current?.summary ? ` · ${stream.current.summary}` : ''}`)))),
        h('div.row', {}, project.attention ? h('span.chip.warn', {}, `待你處理 ${project.attention}`) : h('span.chip.ok', {}, '沒有待處理'), project.issues.open ? h('span.chip', {}, `Issue ${project.issues.open}`) : null, h('span.muted', {}, project.lastEvent ? `最後事件 ${ago(project.lastEvent.at)}` : ''))
      ])))
  );
}

// ---- project ----
let selected = {};
function stageBar(stage) {
  const index = STAGES.findIndex(([key]) => key === stage);
  return h('ol.stages', {}, STAGES.map(([key, label], i) => h(`li${stage === 'blocked' && i === 0 ? '.bad' : index > i ? '.done' : index === i ? '.now' : ''}`, {}, h('i'), label)));
}
function liveLane(project, stream) {
  const live = stream.live;
  const executorRole = live ? { provider: live.executor, model: live.model } : null;
  const role = stream.phase === 'execute' || live?.running ? model(executorRole) : stream.phase ? PHASE[stream.phase.split(':')[0]] ?? stream.phase : STAGE_LABEL[stream.stage];
  const lane = h('div.lane', {},
    h('div.lane-h', {}, h('h3', {}, targetName(stream.target)), chip(stream.stage === 'idle' ? 'IDLE' : stream.stage === 'blocked' ? 'BLOCKED' : 'RUNNING'),
      stream.current?.summary ? h('span.muted', {}, stream.current.summary) : null),
    stageBar(stream.stage),
    h('div.who', {}, h(`div.avatar${stream.stage === 'idle' ? '.idle' : ''}`, {}, (role ?? '·').slice(0, 2)), h('div', {}, h('b', {}, role ?? '—'), h('div.muted', {}, stream.phase ? `${PHASE[stream.phase.split(':')[0]] ?? stream.phase}${stream.phase.includes(':') ? ` · ${stream.phase.split(':')[1]}` : ''}` : stream.lastEvent ? `最後事件：${stream.lastEvent.event}（${ago(stream.lastEvent.at)}）` : '尚無事件')),
      h('span.timer', { 'data-since': stream.phaseStartedAt ?? stream.current?.attemptStartedAt ?? '' }, elapsed(stream.phaseStartedAt ?? stream.current?.attemptStartedAt))),
    stream.current?.error ? h('p', { class: 'muted' }, `原因：${stream.current.error}`) : null);
  if (live) {
    lane.append(h('div.row', {}, h('span.eyebrow', {}, `執行者動作 · ${live.running ? '進行中' : `上次執行 ${ago(live.updatedAt)}`}`), h('span.muted', {}, `編輯 ${live.totals.edits} · 命令 ${live.totals.commands} · 讀取 ${live.totals.reads}`)),
      live.actions.length ? h('ol.acts', {}, live.actions.slice().reverse().map(action => h('li', {}, h('span.k', {}, ACT[action.kind] ?? action.kind), h(`span.t${['run', 'edit', 'write', 'read'].includes(action.kind) ? '.code' : ''}${action.ok === false ? '.fail' : ''}`, {}, action.text)))) : h('p.muted', {}, '還沒有動作。'));
  }
  return lane;
}
function attentionCard(project, items) {
  const card = h('section.card', { 'aria-labelledby': 'att-h' }, h('div.card-h', {}, h('h2', { id: 'att-h' }, '待你處理'), h('span.muted', {}, '核准會以你的身分執行，並記錄在 .protoflow/dashboard/actions.jsonl')));
  if (!items.length) { card.append(h('div.empty', {}, '目前沒有需要你決定的事。')); return card; }
  const run = async (button, body, label, question) => {
    if (!confirm(question)) return;
    button.disabled = true;
    try { await act(project.project.id, body, label); } catch (error) { toast(`${label}失敗：${error.message}`, true); } finally { button.disabled = false; }
  };
  card.append(h('div.att', {}, items.map(item => {
    const box = h(`div.item${item.actions.length ? '.ask' : ''}`, {});
    if (item.kind === 'manual-merge') {
      box.append(h('h3', {}, `${targetName(item.target)}：交付 ${item.title} 待你合併`), h('p', {}, `已通過驗證與獨立審查；只會合併審查過的 commit ${item.commit?.slice(0, 7) ?? ''}。`),
        h('div.btns', {}, h('button.btn.primary', { type: 'button', onclick: event => run(event.currentTarget, { action: 'merge', target: item.target, deliveryId: item.deliveryId }, '核准並合併', `確定以你的 GitHub 身分合併 ${item.title}？`) }, '核准並合併'), item.pr ? h('a.btn', { href: item.pr, target: '_blank', rel: 'noopener' }, '在 GitHub 查看') : null));
    } else if (item.kind === 'issue') {
      box.append(h('h3', {}, `#${item.number} ${item.title ?? ''}`), h('div.row', {}, chip(item.status, ISSUE)), item.reason ? h('p', {}, item.reason) : null,
        item.questions?.length ? h('ul.why', {}, item.questions.map(question => h('li', {}, question))) : null,
        h('div.btns', {}, h('button.btn.primary', { type: 'button', onclick: event => run(event.currentTarget, { action: 'handback', number: item.number }, '交回 AI', `確定把 #${item.number} 交回 AI 重新分流？這會以你的 GitHub 身分移除狀態標籤。`) }, '核准：交回 AI'), item.url ? h('a.btn', { href: item.url, target: '_blank', rel: 'noopener' }, '在 GitHub 查看') : null));
    } else if (item.kind === 'review') {
      box.append(h('h3', {}, `${targetName(item.target)}：${item.title}`), h('p', {}, `驗收 ${item.verificationId} 已通過，等待人工核准。`),
        h('div.btns', {}, h('button.btn.primary', { type: 'button', onclick: event => run(event.currentTarget, { action: 'approve', target: item.target, manifestId: item.manifestId, verificationId: item.verificationId }, '核准版本', `確定以你的名字核准這個版本？核准綁定驗收 ${item.verificationId}。`) }, '核准版本')));
    } else if (item.kind === 'blocked-version') {
      box.append(h('h3', {}, `${targetName(item.target)}：${item.title} 阻塞`), item.reason ? h('p', {}, item.reason) : null,
        h('div.btns', {}, h('button.btn', { type: 'button', onclick: event => run(event.currentTarget, { action: 'retry', target: item.target }, '重試', '確定已處理阻塞原因並重試這個版本？') }, '重試')));
    } else {
      box.append(h('h3', {}, item.title ?? item.kind), item.reason ? h('p', {}, item.reason) : null, item.pr ? h('a', { href: item.pr, target: '_blank', rel: 'noopener' }, item.pr) : null);
    }
    return box;
  })));
  return card;
}
function verificationCard(project, streams) {
  const withVer = streams.filter(stream => stream.verification);
  if (!withVer.length) return null;
  const key = 'ver';
  const current = withVer.find(stream => String(stream.target) === selected[key]) ?? withVer[0];
  const ver = current.verification;
  const variants = [...new Set(ver.scenes.map(scene => scene.variant ?? ''))];
  const vkey = `variant:${current.target}`;
  const variant = variants.includes(selected[vkey]) ? selected[vkey] : variants[0];
  const scenes = ver.scenes.filter(scene => (scene.variant ?? '') === variant);
  const image = file => file ? h('img', { src: `/api/projects/${project.project.id}/file?path=${encodeURIComponent(file)}`, alt: '', loading: 'lazy' }) : h('div.miss', {}, '沒有截圖');
  const card = h('section.card', {},
    h('div.card-h', {}, h('div', {}, h('h2', {}, '驗收'), h('span.muted.mono', {}, `${ver.id} · `), chip(ver.status), h('span.muted', {}, ` 建置 `), chip(ver.build), h('span.muted', {}, ` 功能測試 `), chip(ver.functional)),
      withVer.length > 1 ? h('div.segs', { role: 'tablist' }, withVer.map(stream => h('button.seg', { type: 'button', role: 'tab', 'aria-selected': String(stream === current), onclick: () => { selected[key] = String(stream.target); rerender(); } }, targetName(stream.target)))) : null),
    variants.length > 1 ? h('div.segs', { role: 'tablist' }, variants.map(name => h('button.seg', { type: 'button', role: 'tab', 'aria-selected': String(name === variant), onclick: () => { selected[vkey] = name; rerender(); } }, `${name}${ver.variants?.[name] ? `（建置${(STATUS[ver.variants[name]] ?? [ver.variants[name]])[0]}）` : ''}`))) : null,
    h('div.scroll', {}, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '畫面'), TIERS.map(([, label]) => h('th', {}, label)))),
      h('tbody', {}, scenes.map(scene => h('tr', {}, h('th', {}, scene.screen, h('small', {}, `${scene.id}`)), TIERS.map(([tier]) => h('td', {}, tier === 'visual' && scene.tiers[tier] !== 'NOT_RUN' ? h('span.chip', {}, '參考') : chip(scene.tiers[tier])))))))),
    h('p.muted', {}, '結構、配色、版面必須通過；視覺比對在原生平台只供參考。'),
    h('div.shots', {}, scenes.slice(0, 24).map(scene => h('article.shot', {}, h('div.shot-h', {}, h('h4', {}, scene.id), chip(scene.status)),
      h('div.pair', {}, h('figure', {}, image(scene.prototype), h('figcaption', {}, '原型')), h('figure', {}, image(scene.application), h('figcaption', {}, 'App'))),
      scene.reasons.length ? h('ul.why', {}, scene.reasons.map(reason => h('li', {}, reason))) : null))));
  return card;
}
function versionsCard(streams) {
  const rows = streams.flatMap(stream => stream.versions.map(version => ({ ...version, target: stream.target })));
  return h('section.card', {}, h('div.card-h', {}, h('h2', {}, '原型版本')),
    rows.length ? h('div.scroll', {}, h('table', {}, h('thead', {}, h('tr', {}, ['target', '版本', '狀態', '嘗試', '說明'].map(label => h('th', {}, label)))),
      h('tbody', {}, rows.slice(0, 24).map(row => h('tr', {}, h('td', {}, targetName(row.target)), h('td.mono', {}, row.sha?.slice(0, 7) ?? row.manifestId), h('td', {}, chip(row.status)), h('td', {}, String(row.attempts)), h('td', {}, row.summary ?? row.error ?? ''))))))
      : h('div.empty', {}, '還沒有原型版本。'));
}
function issuesCard(issues) {
  return h('section.card', {}, h('div.card-h', {}, h('h2', {}, 'GitHub Issues')),
    issues.length ? h('div.scroll', {}, h('table', {}, h('thead', {}, h('tr', {}, ['#', '標題', '狀態', '類型', 'target'].map(label => h('th', {}, label)))),
      h('tbody', {}, issues.map(issue => h('tr', {}, h('td', {}, issue.url ? h('a', { href: issue.url, target: '_blank', rel: 'noopener' }, `#${issue.number}`) : `#${issue.number}`), h('td', {}, issue.title ?? ''), h('td', {}, chip(issue.status, ISSUE)), h('td', {}, issue.area ?? ''),
        h('td', {}, Object.entries(issue.targets).map(([target, work]) => h('div.row', {}, h('span', {}, target), chip(work.status), work.pr ? h('a', { href: work.pr, target: '_blank', rel: 'noopener' }, 'PR') : null))))))))
      : h('div.empty', {}, '沒有 Issue。'));
}
function deliveriesCard(streams) {
  const rows = streams.flatMap(stream => stream.deliveries.map(delivery => ({ ...delivery, target: stream.target }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return h('section.card', {}, h('div.card-h', {}, h('h2', {}, '交付')),
    rows.length ? h('ul.log', {}, rows.slice(0, 12).map(row => h('li', {}, h('time', {}, clock(row.updatedAt)), h('div.row', {}, h('b', {}, targetName(row.target)), chip(row.manualMerge ? 'MERGED' : row.status), row.pr ? h('a', { href: row.pr, target: '_blank', rel: 'noopener' }, `PR #${row.prNumber}`) : null, row.error ? h('span.muted', {}, row.error) : null))))
      : h('div.empty', {}, '還沒有交付。'));
}
function eventsCard(events) {
  return h('section.card', {}, h('div.card-h', {}, h('h2', {}, '事件'), h('span.muted', {}, '.protoflow/runner/events.jsonl')),
    events.length ? h('ul.log', {}, events.slice(0, 30).map(event => h('li', {}, h('time', {}, clock(event.at)), h('span', {}, `${event.target ? `${event.target} · ` : ''}${event.event}${event.number ? ` #${event.number}` : ''}${event.status ? ` · ${event.status}` : ''}${event.reason ? ` · ${String(event.reason).slice(0, 160)}` : event.error ? ` · ${String(event.error).slice(0, 160)}` : ''}`)))) : h('div.empty', {}, '還沒有事件（Runner 自 v0.3.23 起記錄）。'));
}
let lastProject = null;
function renderProject(snapshot) {
  lastProject = snapshot;
  const project = snapshot.project;
  crumb.textContent = project.name;
  const roles = snapshot.roles;
  app.replaceChildren(
    h('div.top', {}, h('div', {}, h('span.eyebrow', {}, project.root), h('h1', {}, project.name),
      h('dl.kv', {}, h('dt', {}, 'Runner'), h('dd', {}, chip(snapshot.service.status), snapshot.service.version ? ` v${snapshot.service.version}` : '', snapshot.service.reason ? ` · ${snapshot.service.reason}` : ''),
        h('dt', {}, '規劃／驗收'), h('dd', {}, `${model(roles.planner)}／${model(roles.acceptor)}`),
        h('dt', {}, '執行者'), h('dd', {}, `前端 ${model(roles.executors.frontend)} · 後端 ${model(roles.executors.backend)}${roles.executors.fallback ? ` · 備援 ${roles.executors.fallback}` : ''}`),
        project.delivery ? [h('dt', {}, '交付'), h('dd', {}, `${project.delivery.baseBranch} · ${project.delivery.merge === 'manual' ? '由你合併' : '自動合併'}${project.autoApprove ? ' · 自動批准（AI）' : ' · 人工批准'}`)] : null)),
      h('div.tiles', {}, h('div.tile', {}, h('span', {}, '待你處理'), h('b', {}, String(snapshot.attention.length))), h('div.tile', {}, h('span', {}, '進行中的 Issue'), h('b', {}, String(snapshot.issues.filter(issue => issue.status === 'in-progress').length))))),
    h('section.card', {}, h('div.card-h', {}, h('div', {}, h('span.eyebrow', {}, '現在進行'), h('h2', {}, snapshot.streams.some(stream => !['idle', 'blocked'].includes(stream.stage)) ? '工作中' : '沒有進行中的工作')), h('span.muted', {}, `更新 ${clock(snapshot.generatedAt)}`)),
      h('div.grid', {}, snapshot.streams.map(stream => liveLane(snapshot, stream)))),
    attentionCard(snapshot, snapshot.attention),
    verificationCard(snapshot, snapshot.streams),
    h('div.two', {}, versionsCard(snapshot.streams), issuesCard(snapshot.issues)),
    h('div.two', {}, deliveriesCard(snapshot.streams), eventsCard(snapshot.events)),
    snapshot.adr ? h('section.card', {}, h('div.card-h', {}, h('h2', {}, '架構決策（ADR）'), chip(snapshot.adr.status === 'approved' ? 'PASS' : 'PENDING')), h('dl.kv', {}, h('dt', {}, '檔案'), h('dd.mono', {}, snapshot.adr.path), h('dt', {}, '審查者'), h('dd', {}, snapshot.adr.reviewer ?? '—'), h('dt', {}, '決策'), h('dd', {}, snapshot.adr.decision ?? '—')), h('p.muted', {}, 'ADR 的核准目前在檔案中進行；面板只顯示狀態。')) : null
  );
}
const rerender = () => { if (lastProject) renderProject(lastProject); };
setInterval(() => document.querySelectorAll('[data-since]').forEach(node => { if (node.dataset.since) node.textContent = elapsed(node.dataset.since); }), 1000);

function route() {
  const match = /^#\/p\/([0-9a-f]{12})$/.exec(location.hash);
  lastProject = null;
  if (match) subscribe(`/api/projects/${match[1]}/stream`, renderProject);
  else subscribe('/api/stream', renderOverview);
}
window.addEventListener('hashchange', route);
route();
