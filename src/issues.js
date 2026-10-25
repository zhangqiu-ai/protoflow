import { hash, projectPath, readJson, writeJson, withLock } from './util.js';
import { resolveDeliveryDestination, githubApi } from './delivery-scope.js';
import { planIssue } from './planner.js';
import { versionQueue, deliveredVersions } from './queue.js';

/**
 * Proposal 0003 §6.1–6.2: GitHub Issues intake and triage. Open issues carrying `issues.label` are processed in number
 * order: authorised authors' issues are snapshotted and triaged by the read-only Claude planner; the decision is
 * published as an AI-labelled comment and a `<label>:<status>` label. Implementation (P5) picks up `planned` issues.
 * Issue content is untrusted data throughout; ProtoFlow only reads issues and writes comments and labels.
 */
export const ISSUE_STATUSES = ['planned', 'needs-info', 'needs-human', 'rejected', 'waiting-prototype', 'in-progress', 'blocked', 'done'];
const DECISION_STATUS = { implement: 'planned', 'needs-info': 'needs-info', 'needs-human': 'needs-human', reject: 'rejected', 'wait-prototype': 'waiting-prototype' };
const LABEL_COLORS = { skip: 'ededed', planned: '0e8a16', 'needs-info': 'fbca04', 'needs-human': 'd93f0b', rejected: 'cccccc', 'waiting-prototype': 'c5def5', 'in-progress': '1d76db', blocked: 'b60205', done: '5319e7' };
const WRITERS = ['admin', 'maintain', 'write'];
const MAX_TRIAGE_FAILURES = 3;
// Local states an issue closed on GitHub leaves: nothing has started on it, so closing it settles it ('closed' is local only).
const CONVERGE = ['new', 'triage-failed', 'needs-info', 'needs-human', 'rejected', 'blocked', 'planned', 'waiting-prototype'];
const statePath = '.protoflow/issues/state.json';

/** schemaVersion 1 projects have one implicit application target. */
const issueTargets = config => config.schemaVersion === 2 ? config.targets.map(target => ({ id: target.id, platform: target.platform, root: target.root ?? '.' })) : [{ id: 'application', platform: 'web', root: '.' }];
/** The target id of a project's single stream (stream null). */
export const defaultIssueTarget = config => issueTargets(config)[0].id;

export function issueSettings(config) {
  const issues = config.issues;
  if (!issues?.enabled) return null;
  const all = issueTargets(config), ids = issues.targets ?? all.map(target => target.id);
  const unknown = ids.filter(id => !all.some(target => target.id === id));
  if (unknown.length) throw new Error(`issues.targets names unknown targets: ${unknown.join(', ')}`);
  return {
    label: issues.label ?? 'protoflow', authors: issues.authors ?? ['OWNER', 'MEMBER', 'COLLABORATOR'],
    targets: all.filter(target => ids.includes(target.id)),
    maxTriagePerSync: issues.maxTriagePerSync ?? 3, remote: issues.remote ?? config.runner?.delivery?.remote ?? 'origin',
    // all: every open issue is AI work (authorised authors only), not just those carrying the label; <label>:skip opts one out.
    all: issues.all === true
  };
}
const statusLabel = (settings, status) => `${settings.label}:${status}`;
const streamTarget = (config, target) => config.schemaVersion === 2 ? target : undefined;

/**
 * Frozen prototype versions a target has not accepted yet, or not yet delivered with runner delivery: the application
 * is still to get them through the prototype stream. Triage reads them (the latest accepted prototype is not the whole
 * story), and an issue one of them already answers waits for it instead of being implemented or rejected.
 */
export async function pendingPrototypes(root, config, targets) {
  const found = new Map();
  for (const target of targets) {
    const queue = await versionQueue(root, config, { target: streamTarget(config, target.id) });
    const delivered = config.runner?.delivery ? await deliveredVersions(root, config, target.id) : null;
    for (const version of queue.versions.filter(item => !item.acceptedBy || (delivered && !delivered.has(item.id)))) {
      if (!found.has(version.id)) {
        const manifest = await readJson(await projectPath(root, `.protoflow/manifests/${version.id}.json`), null);
        const files = (manifest?.changes ?? []).map(change => change.path);
        found.set(version.id, { manifestId: version.id, createdAt: version.createdAt, summary: version.summary ?? manifest?.source?.message ?? null, level: version.level ?? null, sha: version.source?.sha ?? null,
          changedFiles: files.slice(0, 40), ...(files.length > 40 && { moreFiles: files.length - 40 }), frozen: `.protoflow/versions/${version.id}/files/`, targets: [], current: [] });
      }
      found.get(version.id).targets.push(target.id);
      if (queue.current?.id === version.id) found.get(version.id).current.push(target.id);
    }
  }
  return [...found.values()];
}
const labelNames = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
const marker = (snapshotId, planId) => `<!-- protoflow:triage ${snapshotId} ${planId ?? 'none'} -->`;
/** What a person can change on an issue: its title, body and the comments that are not ProtoFlow's. */
export const contentHash = snapshot => hash({ title: snapshot.title, body: snapshot.body, comments: snapshot.comments.filter(comment => !comment.ours).map(({ id, body }) => ({ id, body })) });

export async function issuesStatus(root) {
  return readJson(await projectPath(root, statePath), { schemaVersion: 1, issues: {} });
}

/** One intake pass. Returns what was triaged; GitHub failures throw (transient ones are marked) and nothing half-done is lost. */
export async function syncIssues(root, config, { onEvent = () => {}, signal } = {}) {
  const settings = issueSettings(config);
  if (!settings) return { status: 'DISABLED' };
  return withLock(root, () => sync(root, config, settings, { onEvent, signal }), 'issues');
}

/**
 * The shared issue session: canonical repository, durable state and the publication step. Each published status is
 * recorded as `pending` first and finished by publish(); a crash in between resumes the same comment by its marker.
 */
export async function openIssues(root, config) {
  const settings = issueSettings(config);
  const { repository } = await resolveDeliveryDestination(root, settings.remote);
  const file = await projectPath(root, statePath);
  const state = await readJson(file, null) ?? { schemaVersion: 1, repository: { id: repository.id, nameWithOwner: repository.nameWithOwner }, issues: {} };
  if (state.repository.id !== repository.id) throw new Error(`Issue state belongs to ${state.repository.nameWithOwner}, not ${repository.nameWithOwner}`);
  const save = () => writeJson(file, state);
  // ProtoFlow 0.3.9-0.3.10 recorded a stopped runner as a blocked fix; such work resumes and its block is never published.
  let repaired = false;
  for (const entry of Object.values(state.issues)) {
    if (entry.pending?.status === 'blocked' && entry.pending.reason === 'Stopped') { delete entry.pending; repaired = true; }
    for (const work of Object.values(entry.targets ?? {})) if (work.status === 'BLOCKED' && work.error === 'Stopped') { work.status = 'RUNNING'; delete work.error; delete work.completedAt; repaired = true; }
  }
  if (repaired) await save();
  const api = (endpoint, options) => githubApi(root, repository, endpoint, options);
  const base = `repos/${repository.nameWithOwner}`;
  async function publish(entry, pending) {
    const comments = await api(`${base}/issues/${entry.number}/comments?per_page=100`);
    let comment = comments.find(item => (item.body ?? '').startsWith(pending.marker));
    comment ??= await api(`${base}/issues/${entry.number}/comments`, { method: 'POST', body: { body: pending.body } });
    const current = labelNames(await api(`${base}/issues/${entry.number}`));
    const target = statusLabel(settings, pending.status);
    if (!current.includes(target)) await api(`${base}/issues/${entry.number}/labels`, { method: 'POST', body: { labels: [target] } });
    for (const name of current.filter(name => name !== target && ISSUE_STATUSES.some(status => statusLabel(settings, status) === name))) {
      await api(`${base}/issues/${entry.number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
    if (pending.close) await api(`${base}/issues/${entry.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    const after = await api(`${base}/issues/${entry.number}`);
    Object.assign(entry, { status: pending.status, decidedAt: comment.created_at ?? new Date().toISOString(), commentId: comment.id, commentCount: after.comments ?? 0, reason: pending.reason });
    entry.history.push({ status: pending.status, at: new Date().toISOString(), ...(pending.snapshotId && { snapshotId: pending.snapshotId }), ...(pending.planId && { planId: pending.planId }), commentId: comment.id, ...(pending.reason && { reason: pending.reason }) });
    delete entry.pending; await save();
  }
  /** Record a new status durably, then publish its AI-labelled comment and label. */
  async function transition(entry, pending) { entry.pending = pending; await save(); await publish(entry, pending); }
  return { settings, repository, state, save, api, base, publish, transition };
}

async function sync(root, config, settings, { onEvent, signal }) {
  const { repository, state, save, api, base, publish, transition } = await openIssues(root, config);

  const names = [...ISSUE_STATUSES, 'skip'];
  const wanted = names.map(status => statusLabel(settings, status));
  if (state.labels !== hash(wanted)) {
    const existing = new Set((await api(`${base}/labels?per_page=100`)).map(label => label.name));
    for (const status of names) {
      const name = statusLabel(settings, status);
      if (!existing.has(name)) await api(`${base}/labels`, { method: 'POST', body: { name, color: LABEL_COLORS[status], description: status === 'skip' ? 'ProtoFlow leaves this issue alone' : `ProtoFlow issue automation: ${status}` } });
    }
    state.labels = hash(wanted); await save();
  }

  // With issues.all every open issue is listed (page by page); otherwise only those carrying the label.
  const listed = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${base}/issues?${settings.all ? '' : `labels=${encodeURIComponent(settings.label)}&`}state=open&sort=created&direction=asc&per_page=100&page=${page}`);
    listed.push(...batch);
    if (batch.length < 100 || page >= 10) break;
  }
  const skip = statusLabel(settings, 'skip');
  const open = listed.filter(issue => !issue.pull_request && !labelNames(issue).includes(skip)).sort((a, b) => a.number - b.number);
  const results = [];
  // An issue closed on GitHub before ProtoFlow started on it is settled: it no longer waits for a person or the AI.
  const listedNumbers = new Set(listed.map(issue => issue.number));
  for (const entry of Object.values(state.issues).filter(item => CONVERGE.includes(item.status) && !item.pending && !listedNumbers.has(item.number))) {
    if (signal?.aborted) break;
    let issue;
    try { issue = await api(`${base}/issues/${entry.number}`); }
    catch (error) { if (!/HTTP (404|410)/.test(error.message)) throw error; issue = { state: 'closed', gone: true }; }
    if (issue.state !== 'closed') continue;
    const previous = entry.status, at = new Date().toISOString();
    entry.status = 'closed'; entry.closedAt = issue.closed_at ?? at;
    entry.reason = issue.gone ? 'The issue is no longer on GitHub' : `Closed on GitHub${issue.closed_by?.login ? ` by ${issue.closed_by.login}` : ''}${issue.state_reason ? ` (${issue.state_reason})` : ''}`;
    entry.history.push({ status: 'closed', at, reason: entry.reason }); await save();
    await onEvent({ event: 'issue-closed', number: entry.number, previous, reason: entry.reason });
    results.push({ number: entry.number, status: 'closed', previous });
  }
  let triaged = 0, prototypes = null;
  for (const issue of open) {
    if (signal?.aborted) break;
    const entry = state.issues[issue.number] ??= { number: issue.number, status: 'new', history: [] };
    const labels = labelNames(issue);
    let confirmedBy = null;
    if (entry.pending) { await publish(entry, entry.pending); results.push({ number: issue.number, status: entry.status, resumed: true }); continue; }
    // An issue waiting for a prototype version closes once that version reached every target it waits on; a version
    // that left the queue (superseded) is followed into the version that folded it in, or else the issue is triaged again.
    let waitGone = false;
    if (entry.status === 'waiting-prototype' && labels.includes(statusLabel(settings, entry.status))) {
      const outcome = await awaitPrototype(entry);
      if (outcome.status === 'done') {
        const lines = [`<!-- protoflow:issue-prototype ${issue.number} ${entry.prototypeVersion} -->`, `**ProtoFlow issue (AI, automated)** · status \`${statusLabel(settings, 'done')}\``, '',
          `Prototype version \`${entry.prototypeVersion}\`${outcome.summary ? ` (${outcome.summary})` : ''}, which makes the change this issue asks for, was accepted${config.runner?.delivery ? ' and delivered' : ''} for ${entry.waitTargets.join(', ')}.`, '',
          'Closed automatically: the change reached the application through the prototype stream. This closure is automated, not a human approval.'];
        await transition(entry, { status: 'done', close: true, marker: lines[0], body: lines.join('\n'), reason: `Prototype version ${entry.prototypeVersion} reached ${entry.waitTargets.join(', ')}` });
        await onEvent({ event: 'issue-done', number: issue.number, prototypeVersion: entry.prototypeVersion });
        results.push({ number: issue.number, status: 'done', prototypeVersion: entry.prototypeVersion });
        continue;
      }
      if (outcome.status !== 'gone') continue;
      waitGone = true;
    }
    if (waitGone) {
      // Triaged again below: the version it waited for is no longer queued.
    } else if (['needs-human', 'rejected', 'blocked', 'waiting-prototype'].includes(entry.status)) {
      // A maintainer re-opens triage by removing the status label; only people with write access count.
      if (labels.includes(statusLabel(settings, entry.status))) continue;
      confirmedBy = await labelRemover(issue.number, statusLabel(settings, entry.status));
      if (!confirmedBy) { if (!entry.unconfirmedRemoval) { entry.unconfirmedRemoval = new Date().toISOString(); await save(); await onEvent({ event: 'issue-unconfirmed', number: issue.number, status: entry.status }); } continue; }
    } else if (entry.status === 'needs-info') {
      if ((issue.comments ?? 0) <= (entry.commentCount ?? 0)) continue;
    } else if (!['new', 'triage-failed', 'closed'].includes(entry.status)) continue;

    const snapshot = await takeSnapshot(issue.number);
    if (entry.status === 'needs-info' && !snapshot.comments.some(comment => !comment.ours && comment.createdAt > entry.decidedAt)) { entry.commentCount = issue.comments; await save(); continue; }
    const authorized = settings.authors.includes(snapshot.authorAssociation) || Boolean(confirmedBy) || entry.confirmedBy;
    if (confirmedBy) { entry.confirmedBy = confirmedBy; delete entry.unconfirmedRemoval; }
    // A blocked fix a maintainer re-opened is triaged again; targets that already merged keep their delivery.
    if (confirmedBy && entry.status === 'blocked') entry.targets = Object.fromEntries(Object.entries(entry.targets ?? {}).filter(([, work]) => work.status === 'MERGED'));
    if (!authorized) {
      await decide(entry, snapshot, null, 'needs-human', `Issue author association ${snapshot.authorAssociation} is not in issues.authors; a maintainer must confirm it by removing the ${statusLabel(settings, 'needs-human')} label.`);
      results.push({ number: issue.number, status: entry.status, reason: 'unauthorized-author' });
      continue;
    }
    // A person handed a needs-human issue back without answering it or changing it: the planner is told so once, and
    // asked to decide on its own recommendation; a second bare handback does not run the planner again.
    const unchanged = Boolean(confirmedBy) && entry.status === 'needs-human' && Boolean(entry.planId) && await previousContent(entry) === contentHash(snapshot);
    if (!unchanged) delete entry.repeatedNeedsHuman;
    if (unchanged && entry.repeatedNeedsHuman) {
      const questions = (await previousPlan(entry))?.questions ?? [];
      await decide(entry, snapshot, null, 'needs-human', `Handed back again without an answer or a change to the issue since plan ${entry.planId}; ProtoFlow does not triage it again until the issue changes. Answer in a comment (the dashboard's answer does this) or close the issue.${questions.length ? ` Open questions: ${questions.join(' / ')}` : ''}`);
      await onEvent({ event: 'issue-unchanged', number: issue.number, planId: entry.planId });
      results.push({ number: issue.number, status: entry.status, reason: 'unchanged' });
      continue;
    }
    if (triaged >= settings.maxTriagePerSync) { results.push({ number: issue.number, status: entry.status, deferred: true }); continue; }
    triaged++;
    const earlier = entry.planId ? await previousPlan(entry) : null;
    const previous = earlier && unchanged ? { ...earlier, handedBackWithoutAnswer: true } : earlier;
    prototypes ??= await pendingPrototypes(root, config, settings.targets);
    let plan;
    try { plan = await planIssue(root, config, snapshot, { targets: settings.targets, previous, prototypes, signal }); }
    catch (error) {
      if (!error.planner) throw error;
      entry.failures = (entry.failures ?? 0) + 1; entry.status = 'triage-failed'; entry.error = error.message.slice(0, 500);
      entry.history.push({ status: 'triage-failed', at: new Date().toISOString(), reason: entry.error }); await save();
      await onEvent({ event: 'issue-triage-failed', number: issue.number, failures: entry.failures, reason: error.message.slice(0, 200) });
      if (entry.failures >= MAX_TRIAGE_FAILURES) await decide(entry, snapshot, null, 'needs-human', `The planner failed ${entry.failures} times: ${entry.error}`);
      results.push({ number: issue.number, status: entry.status, error: entry.error });
      continue;
    }
    if (!plan) { results.push({ number: issue.number, status: 'NOT_RUN', reason: 'adapters.planner is not configured' }); continue; }
    if (unchanged && DECISION_STATUS[plan.plan.decision] === 'needs-human') entry.repeatedNeedsHuman = new Date().toISOString();
    await decide(entry, snapshot, plan, DECISION_STATUS[plan.plan.decision]);
    await onEvent({ event: 'issue-triaged', number: issue.number, status: entry.status, planId: plan.id, targets: plan.plan.targets, costUsd: plan.costUsd });
    results.push({ number: issue.number, status: entry.status, planId: plan.id });
  }
  return { status: 'PASS', repository: repository.nameWithOwner, open: open.length, results };

  async function takeSnapshot(number) {
    const issue = await api(`${base}/issues/${number}`);
    const comments = await api(`${base}/issues/${number}/comments?per_page=100`);
    const content = {
      number, repository: { id: repository.id, nameWithOwner: repository.nameWithOwner }, title: issue.title, body: issue.body ?? '', author: issue.user?.login ?? null,
      authorAssociation: issue.author_association, labels: labelNames(issue), updatedAt: issue.updated_at,
      comments: comments.map(comment => ({ id: comment.id, author: comment.user?.login ?? null, authorAssociation: comment.author_association, body: comment.body ?? '', createdAt: comment.created_at, ours: (comment.body ?? '').startsWith('<!-- protoflow:') }))
    };
    const snapshot = { schemaVersion: 1, id: `ISS-${number}-${hash(content).slice(0, 12)}`, capturedAt: new Date().toISOString(), ...content, hash: hash(content) };
    await writeJson(await projectPath(root, `.protoflow/issues/snapshots/${snapshot.id}.json`), snapshot);
    return snapshot;
  }
  async function labelRemover(number, label) {
    const events = await api(`${base}/issues/${number}/events?per_page=100`);
    const removal = events.filter(event => event.event === 'unlabeled' && event.label?.name === label).at(-1);
    if (!removal?.actor?.login) return null;
    const permission = await api(`${base}/collaborators/${encodeURIComponent(removal.actor.login)}/permission`);
    return WRITERS.includes(permission?.permission) || WRITERS.includes(permission?.role_name) ? removal.actor.login : null;
  }
  async function previousPlan(entry) {
    const record = await readJson(await projectPath(root, `.protoflow/plans/${entry.planId}.json`), null);
    return record ? { id: record.id, decision: record.plan.decision, summary: record.plan.summary, questions: record.plan.questions } : null;
  }
  async function previousContent(entry) {
    if (entry.contentHash) return entry.contentHash;
    const earlier = entry.snapshotId && /^ISS-[A-Za-z0-9-]+$/.test(entry.snapshotId) ? await readJson(await projectPath(root, `.protoflow/issues/snapshots/${entry.snapshotId}.json`), null) : null;
    return earlier ? contentHash(earlier) : null;
  }
  /** Where the prototype version an issue waits for stands: done for every target it waits on, still queued, or gone. */
  async function awaitPrototype(entry) {
    let id = entry.prototypeVersion;
    for (let hops = 0; hops < 10; hops++) {
      const versions = [];
      for (const target of entry.waitTargets) {
        const queue = await versionQueue(root, config, { target: streamTarget(config, target) });
        const version = queue.versions.find(item => item.id === id);
        if (!version) break;
        const delivered = config.runner?.delivery ? await deliveredVersions(root, config, target) : null;
        versions.push({ ...version, done: Boolean(version.acceptedBy) && (!delivered || delivered.has(id)) });
      }
      if (versions.length === entry.waitTargets.length) return versions.every(version => version.done) ? { status: 'done', summary: versions[0].summary ?? null } : { status: 'waiting' };
      const queue = await versionQueue(root, config, { target: streamTarget(config, entry.waitTargets[0]) });
      let into = null;
      for (const version of queue.versions) if ((await readJson(await projectPath(root, `.protoflow/manifests/${version.id}.json`), null))?.supersedes?.includes(id)) into = version.id;
      if (!into) return { status: 'gone' };
      entry.history.push({ status: 'waiting-prototype', at: new Date().toISOString(), reason: `Prototype version ${id} was folded into ${into}` });
      entry.prototypeVersion = id = into; await save();
    }
    return { status: 'gone' };
  }
  async function decide(entry, snapshot, plan, status, reason = null) {
    entry.snapshotId = snapshot.id; entry.contentHash = contentHash(snapshot); if (plan) { entry.planId = plan.id; delete entry.error; }
    if (status === 'waiting-prototype') {
      const version = prototypes.find(item => item.manifestId === plan.plan.prototypeVersion);
      const named = plan.plan.targets.filter(target => version.targets.includes(target));
      entry.prototypeVersion = version.manifestId; entry.waitTargets = named.length ? named : version.targets;
    } else { delete entry.prototypeVersion; delete entry.waitTargets; }
    await transition(entry, { status, snapshotId: snapshot.id, planId: plan?.id ?? null, reason, marker: marker(snapshot.id, plan?.id), body: commentBody(settings, snapshot, plan, status, reason, entry) });
  }
}

const NEXT = {
  planned: 'ProtoFlow will implement this plan when the target\'s prototype stream is idle; an independent Claude review checks every acceptance criterion before delivery.',
  'needs-info': 'Please answer the questions in a comment; ProtoFlow triages the issue again after a new comment.',
  'needs-human': 'A maintainer decides. To have ProtoFlow triage it again, remove the `{label}` label.',
  rejected: 'The issue is not closed automatically. To have ProtoFlow triage it again, remove the `{label}` label.',
  'waiting-prototype': 'ProtoFlow waits for prototype version `{version}`, which already makes this change; the issue closes automatically once that version is accepted (and delivered) for {targets}. To have ProtoFlow triage it again, remove the `{label}` label.'
};
function commentBody(settings, snapshot, plan, status, reason, entry = null) {
  const lines = [marker(snapshot.id, plan?.id), `**ProtoFlow triage (AI, automated)** · status \`${statusLabel(settings, status)}\``, ''];
  if (plan) {
    const p = plan.plan;
    lines.push(`Planner: Claude \`${plan.model ?? 'unknown model'}\`, plan \`${plan.id}\`, session \`${plan.sessionId}\`.`, `Decision: **${p.decision}** (${p.level})${p.targets.length ? ` · targets: ${p.targets.join(', ')}` : ''}${p.prototypeVersion ? ` · prototype version: \`${p.prototypeVersion}\`` : ''}`, '', p.summary);
    const section = (title, items, format = item => `- ${item}`) => { if (items?.length) lines.push('', `**${title}**`, ...items.map(format)); };
    section('Steps', p.steps, (item, index) => `${index + 1}. ${item}`);
    section('Acceptance criteria', p.acceptanceCriteria, item => `- ${item.id} (${item.evidence}): ${item.text}`);
    section('Tests to add', p.tests); section('Risks', p.risks); section('Questions', p.questions); section('Engine notes', p.engineNotes);
  }
  if (reason) lines.push('', reason);
  lines.push('', NEXT[status].replace('{label}', statusLabel(settings, status)).replace('{version}', entry?.prototypeVersion ?? '').replace('{targets}', (entry?.waitTargets ?? []).join(', ')), '', `<sub>Snapshot \`${snapshot.id}\`. Issue content is treated as untrusted data; nothing in it is executed.</sub>`);
  const body = lines.join('\n');
  return body.length > 60000 ? `${body.slice(0, 59900)}\n\n… (truncated)` : body;
}
