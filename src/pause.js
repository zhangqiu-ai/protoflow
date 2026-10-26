import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectPath, runCommand, writeJson } from './util.js';
import { streamTargets, loadProgress } from './streams.js';
import { PAUSE, projectPause, recordEvent, retryRunner } from './runner.js';

/**
 * A person pauses a project's development and resumes it later. While paused the runner takes no work: no version
 * runs, no issue is triaged or repaired, and a foreground runner returns PAUSED; source scans go on, so new prototype
 * commits are frozen in order. Nothing in progress is undone: stopped and unfinished versions and their worktrees stay
 * as they are, and resuming continues from there.
 */
const HISTORY = '.protoflow/pause-history.jsonl';

/** Who acts: `ai:<agent>` is an AI, any other name a person; by default the configured reviewer or the Git user. */
export async function pauseActor(root, config, by = null) {
  const given = typeof by === 'string' ? by.trim() : '';
  if (given) return { kind: given.startsWith('ai:') ? 'ai' : 'human', name: given };
  if (config.dashboard?.reviewer?.trim()) return { kind: 'human', name: config.dashboard.reviewer.trim() };
  const git = await runCommand(root, { argv: ['git', 'config', 'user.name'], timeoutMs: 10000 }).catch(() => null);
  return { kind: 'human', name: git?.status === 'PASS' && git.stdout.trim() ? git.stdout.trim() : os.userInfo().username };
}

async function remember(root, record) {
  const file = await projectPath(root, HISTORY);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);
  await recordEvent(root, record);
}

export async function pauseProject(root, config, { reason = null, by = null, via = 'cli' } = {}) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length > 1000) throw new Error('--reason is longer than 1000 characters');
  const current = await projectPause(root);
  if (current) return { status: 'PASS', already: true, paused: current };
  const paused = { schemaVersion: 1, pausedAt: new Date().toISOString(), by: await pauseActor(root, config, by), reason: text || null, via };
  await writeJson(await projectPath(root, PAUSE), paused);
  await remember(root, { at: paused.pausedAt, event: 'project-paused', by: paused.by, reason: paused.reason, via });
  return { status: 'PASS', paused, next: 'The runner takes no work until protoflow project resume; a version in hand finishes its current pass first' };
}

/**
 * Resume a paused project. A version a stop interrupted (STOPPED) runs again, as runner retry would do; a BLOCKED
 * version keeps waiting for its own decision.
 */
export async function resumeProject(root, config, { by = null, via = 'cli' } = {}) {
  const paused = await projectPause(root);
  if (!paused) return { status: 'PASS', already: true, paused: null };
  const retried = [], kept = [];
  for (const stream of streamTargets(config)) {
    const current = (await loadProgress(root, config, stream)).entries.find(entry => entry.status !== 'PASS');
    if (current?.status !== 'STOPPED') continue;
    try { await retryRunner(root, config, { target: stream, via }); retried.push({ target: stream, manifestId: current.manifestId }); }
    catch (error) { kept.push({ target: stream, manifestId: current.manifestId, reason: error.message.slice(0, 300) }); }
  }
  const actor = await pauseActor(root, config, by);
  await fs.rm(await projectPath(root, PAUSE), { force: true });
  const at = new Date().toISOString();
  await remember(root, { at, event: 'project-resumed', by: actor, pausedAt: paused.pausedAt, via, ...(retried.length && { retried }) });
  return { status: 'PASS', resumed: { at, by: actor }, paused, retried, ...(kept.length && { kept }), next: kept.length ? 'Inspect the versions in kept, then runner retry' : 'The runner continues on its next pass' };
}

export async function pauseStatus(root) {
  return { status: 'PASS', paused: await projectPause(root) };
}
