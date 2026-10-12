import { projectPath, readJson, writeJson } from './util.js';
import { sourceStatus, saveSourceState } from './source.js';

/*
 * A stream is one target's FIFO progress over the shared prototype versions. Projects with a single target (and
 * every schemaVersion 1 project) keep the original layout: progress lives in the source state and the runner, worktree
 * and delivery use their original paths. With several targets each target advances independently and owns its files.
 */

export const isMultiTarget = config => config.schemaVersion === 2 && (config.targets?.length ?? 0) > 1;
/** Target ids the runner advances; [null] is the single original stream. */
export const streamTargets = config => isMultiTarget(config) ? config.targets.map(target => target.id) : [null];

function requireTarget(config, target) {
  if (!isMultiTarget(config)) return null;
  if (!target) throw new Error(`This project has several targets (${config.targets.map(item => item.id).join(', ')}); pass --target`);
  if (!config.targets.some(item => item.id === target)) throw new Error(`Unknown target: ${target}`);
  return target;
}

const progressPath = target => `.protoflow/targets/${target}/progress.json`;
export const runnerStatePath = (config, target) => requireTarget(config, target) ? `.protoflow/runner/${target}/state.json` : '.protoflow/runner/state.json';
export const worktreeSuffix = (config, target) => requireTarget(config, target) ? `-${target}` : '';
export const deliveryStatePath = (config, target) => requireTarget(config, target) ? `.protoflow/delivery/${target}.json` : '.protoflow/delivery/state.json';
export const deliveryBranch = (config, target) => requireTarget(config, target) ? `${config.runner.delivery.branch}/${target}` : config.runner.delivery.branch;

/**
 * Progress shaped like the source state ({ status, error, entries, completedSha }). For a target stream, new source
 * versions are appended as PENDING; source-level status (for example HISTORY_REWRITTEN) is always the shared one.
 */
export async function loadProgress(root, config, target) {
  const source = await sourceStatus(root);
  if (!requireTarget(config, target)) return source;
  const progress = await readJson(await projectPath(root, progressPath(target)), { schemaVersion: 1, target, entries: [], completedSha: null });
  for (const entry of source.entries) {
    if (!progress.entries.some(item => item.sha === entry.sha)) {
      progress.entries.push({ sha: entry.sha, manifestId: entry.manifestId, prototypeHash: entry.prototypeHash, ordinal: entry.ordinal, status: 'PENDING', attempts: [] });
    }
  }
  return { ...progress, status: source.status, error: source.error ?? null, scannedSha: source.scannedSha };
}
export async function saveProgress(root, config, target, state) {
  if (!requireTarget(config, target)) return saveSourceState(root, state);
  const { schemaVersion = 1, entries, completedSha = null } = state;
  await writeJson(await projectPath(root, progressPath(target)), { schemaVersion, target, entries, completedSha });
}

const UNFINISHED = ['BLOCKED', 'STOPPED', 'RUNNING'];
/** One target's position in its stream: the first non-PASS entry is current; no current entry means IDLE. */
export function progressSummary(progress) {
  const current = progress.entries.find(entry => entry.status !== 'PASS') ?? null;
  const counts = {};
  for (const entry of progress.entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { status: current?.status ?? 'IDLE', completedSha: progress.completedSha ?? null, current: current && { manifestId: current.manifestId, sha: current.sha }, counts };
}
/** PASS on every target; else the most urgent unfinished status; PARTIAL when only some targets passed. */
function combinedStatus(statuses) {
  if (statuses.every(status => status === 'PASS')) return 'PASS';
  return UNFINISHED.find(status => statuses.includes(status)) ?? (statuses.includes('PASS') ? 'PARTIAL' : 'PENDING');
}
/**
 * Source state for display. With several targets the shared entries are only scan records (their stored status stays
 * PENDING), so each entry's status is combined from the targets' progress, the stored value is kept as recordedStatus,
 * completedSha is the last version every target passed and statusBasis is "targets". Single-target projects (and
 * schemaVersion 1) get the source state unchanged.
 */
export async function sourceView(root, config, progress = null) {
  const source = await sourceStatus(root);
  if (!config || !isMultiTarget(config)) return source;
  progress ??= Object.fromEntries(await Promise.all(streamTargets(config).map(async stream => [stream, await loadProgress(root, config, stream)])));
  const entries = source.entries.map(entry => {
    const targets = Object.fromEntries(Object.entries(progress).map(([stream, state]) => [stream, state.entries.find(item => item.sha === entry.sha)?.status ?? 'PENDING']));
    return { ...entry, status: combinedStatus(Object.values(targets)), recordedStatus: entry.status, targets };
  });
  // completedSha: the last version every target has passed, in checkpoint order.
  const open = entries.findIndex(entry => entry.status !== 'PASS');
  const completed = open === -1 ? entries.at(-1) : entries[open - 1];
  return { ...source, statusBasis: 'targets', completedSha: completed?.sha ?? null, entries };
}
