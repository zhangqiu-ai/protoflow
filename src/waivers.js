import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson, id, hash, projectPath } from './util.js';
import { selectTarget, targetSettings } from './targets.js';
import { streamTargets, runnerStatePath } from './streams.js';

/**
 * Proposal 0005: a maintainer waiver lets one failing tier of one scene (and variant) of one prototype version pass
 * the version gate, for an engine limitation that cannot be fixed in the application. The tier still runs and keeps
 * its FAIL and findings; only the gate looks past it, and only while every finding is one the maintainer waived.
 * Agents and the CLI may only request a waiver; a person listed in policy.waivers.reviewers decides it on the dashboard.
 */
export const WAIVABLE = ['structure', 'tokens', 'layout'];
const DIRECTORY = '.protoflow/waivers';
const ID = /^WVR-[A-Za-z0-9-]+$/;

export const waiverReviewers = config => config.policy?.waivers?.reviewers ?? null;
export const findingsHash = findings => hash([...findings].sort());
/** What an approval binds: change any of these and the approval no longer holds. */
export const waiverHash = waiver => hash({ target: waiver.target ?? null, scene: waiver.scene, variant: waiver.variant ?? null, tier: waiver.tier, manifestHash: waiver.manifestHash, findingsHash: waiver.findingsHash });

export async function listWaivers(root) {
  const directory = await projectPath(root, DIRECTORY);
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const waivers = [];
  for (const name of names.filter(item => /^WVR-[A-Za-z0-9-]+\.json$/.test(item)).sort()) waivers.push(await readJson(path.join(directory, name)));
  return waivers;
}
export async function loadWaiver(root, waiverId) {
  if (!ID.test(waiverId ?? '')) throw new Error('Invalid waiver id');
  const waiver = await readJson(await projectPath(root, `${DIRECTORY}/${waiverId}.json`), null);
  if (!waiver) throw new Error(`Waiver ${waiverId} not found`);
  return waiver;
}
const save = async (root, waiver) => { await writeJson(await projectPath(root, `${DIRECTORY}/${waiver.id}.json`), waiver); return waiver; };

/** A verification recorded in the project or in one of its runner worktrees (a failed one lives only there). */
export async function findVerification(root, config, verificationId) {
  if (!/^VER-[A-Za-z0-9-]+$/.test(verificationId ?? '')) throw new Error('Invalid verification id');
  const roots = [root];
  for (const stream of streamTargets(config)) {
    const runner = await readJson(await projectPath(root, runnerStatePath(config, stream)), null);
    if (runner?.worktree) roots.push(runner.worktree);
  }
  for (const base of roots) {
    const report = await readJson(path.join(base, `.protoflow/verifications/${verificationId}.json`), null);
    if (report) return { report, root: base };
  }
  throw new Error(`Verification ${verificationId} not found in the project or its runner worktrees`);
}

const sameScene = (waiver, target, scene) => (waiver.target ?? null) === (target ?? null) && waiver.scene === scene.id && (waiver.variant ?? null) === (scene.variant ?? null);

/** Why an approved-looking waiver does not cover these findings, or null when it does. */
export function waiverMismatch(waiver, { manifestHash, findings }) {
  if (waiver.status !== 'approved') return waiver.status === 'requested' ? 'requested, not approved yet' : `waiver is ${waiver.status}`;
  if (waiver.decision?.waiverHash !== waiverHash(waiver) || findingsHash(waiver.findings) !== waiver.findingsHash) return 'waiver changed after approval';
  if (waiver.manifestHash !== manifestHash) return 'waiver belongs to another prototype version';
  if (!findings.length) return 'the tier has no findings to waive';
  const waived = new Set(waiver.findings);
  const fresh = findings.filter(finding => !waived.has(finding));
  return fresh.length ? `findings changed: ${fresh.length} not waived (${fresh[0].slice(0, 160)})` : null;
}

/**
 * Apply waivers to one compared scene before its verdict. A required T1–T3 tier that failed passes the gate only when
 * an approved waiver for this target, scene, variant, tier and manifestHash lists every current finding; the tier keeps
 * its FAIL and reasons and records the waiver. Returns the tiers as the gate sees them, the waivers used and the ones
 * that did not apply (and why).
 */
export function applyWaivers(waivers, { target, manifestHash, scene, policy }) {
  const gate = { ...scene.tiers }, applied = [], skipped = [];
  for (const tier of WAIVABLE) {
    const result = scene.tiers[tier];
    if ((policy[tier] ?? 'required') !== 'required' || result?.status !== 'FAIL') continue;
    const candidates = waivers.filter(waiver => waiver.tier === tier && waiver.status !== 'rejected' && sameScene(waiver, target, scene));
    for (const waiver of candidates) {
      const why = waiverMismatch(waiver, { manifestHash, findings: result.reasons ?? [] });
      if (why) { skipped.push({ id: waiver.id, tier, why }); continue; }
      result.waiver = { id: waiver.id, waiverHash: waiverHash(waiver) };
      gate[tier] = { ...result, status: 'PASS' };
      applied.push({ id: waiver.id, target: target ?? null, scene: scene.id, variant: scene.variant ?? null, tier, findings: [...(result.reasons ?? [])], reason: waiver.reason, engineIssue: waiver.engineIssue ?? null });
      break;
    }
  }
  return { gate, applied, skipped };
}

/**
 * Request a waiver from a verification's scene evidence: the findings are copied verbatim, never written by hand. Only
 * `requested` waivers are created here; the screenshots of that scene are kept under .protoflow/artifacts/<waiver id>/
 * so the maintainer can judge them on the dashboard even when the verification lived only in a runner worktree.
 */
export async function requestWaiver(root, config, { verificationId, report = null, reportRoot = root, scene: sceneId, variant = null, tier, reason, engineIssue = null, requestedBy }) {
  const reviewers = waiverReviewers(config);
  if (!reviewers?.length) throw new Error('Waivers are off for this project; a maintainer enables them with policy.waivers.reviewers');
  if (!WAIVABLE.includes(tier)) throw new Error(tier === 'visual' ? 'Visual (T4) findings can never be waived' : `Unknown tier ${tier}; waivable tiers are ${WAIVABLE.join(', ')}`);
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('A waiver request needs --reason');
  if (engineIssue !== null && (typeof engineIssue !== 'string' || !engineIssue.trim())) throw new Error('--engine-issue must name the engine issue');
  if (!requestedBy?.name?.trim() || !['human', 'ai'].includes(requestedBy.kind) || (requestedBy.kind === 'ai') !== requestedBy.name.startsWith('ai:')) throw new Error('requestedBy must be a person or an ai: identity');
  const source = report ? { report, root: reportRoot } : await findVerification(root, config, verificationId);
  const verification = source.report;
  const scene = (verification.visual?.scenes ?? []).find(item => item.id === sceneId && (item.variant ?? null) === (variant ?? null));
  if (!scene) throw new Error(`Verification ${verification.id} has no scene ${sceneId}${variant ? ` for variant ${variant}` : ''}`);
  const result = scene.tiers?.[tier];
  if (result?.status !== 'FAIL' || !result.reasons?.length) throw new Error(`Scene ${sceneId} ${tier} did not fail with findings in ${verification.id}`);
  if (config.schemaVersion === 2) {
    const policy = targetSettings(selectTarget(config, verification.target)).tiers;
    if ((policy[tier] ?? 'required') !== 'required') throw new Error(`${tier} is ${policy[tier]} for this target and does not hold the gate; nothing to waive`);
  }
  const findings = [...result.reasons];
  const draft = { target: verification.target ?? null, scene: scene.id, variant: scene.variant ?? null, tier, manifestHash: verification.manifestHash, findingsHash: findingsHash(findings) };
  const existing = (await listWaivers(root)).find(waiver => ['requested', 'approved'].includes(waiver.status) && waiverHash(waiver) === waiverHash(draft));
  if (existing) return { ...existing, existing: true };
  const waiver = {
    schemaVersion: 1, id: id('WVR'), status: 'requested', ...draft, manifestId: verification.manifestId, verificationId: verification.id,
    findings, reason: reason.trim(), engineIssue: engineIssue?.trim() ?? null, requestedBy: { kind: requestedBy.kind, name: requestedBy.name.trim() }, requestedAt: new Date().toISOString(),
    evidence: [], decision: null
  };
  for (const name of ['prototype.png', 'application.png', 'diff.png']) {
    const file = (scene.artifacts ?? []).find(item => path.basename(item) === name);
    if (!file) continue;
    const target = await projectPath(root, `.protoflow/artifacts/${waiver.id}/${name}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.copyFile(path.isAbsolute(file) ? file : path.join(source.root, file), target); waiver.evidence.push(path.relative(await fs.realpath(root), target)); } catch { /* the findings stay the evidence */ }
  }
  return save(root, waiver);
}

/** A maintainer's decision (dashboard only): approve or reject a request, or revoke an approved waiver. */
export async function decideWaiver(root, config, waiverId, { status, reviewer, notes = '' }) {
  if (!['approved', 'rejected', 'revoked'].includes(status)) throw new Error('Invalid waiver decision');
  const reviewers = waiverReviewers(config);
  if (!reviewers?.length) throw new Error('Waivers are off for this project (policy.waivers.reviewers)');
  if (!reviewer?.trim() || reviewer.trim().startsWith('ai:')) throw new Error('Only a person decides a waiver; an ai: identity never does');
  if (!reviewers.includes(reviewer.trim())) throw new Error(`${reviewer} is not a waiver reviewer (policy.waivers.reviewers: ${reviewers.join(', ')})`);
  const waiver = await loadWaiver(root, waiverId);
  const at = new Date().toISOString();
  if (status === 'revoked') {
    if (waiver.status !== 'approved') throw new Error(`Waiver ${waiverId} is ${waiver.status}; only an approved waiver can be revoked`);
    return save(root, { ...waiver, status: 'revoked', revocation: { reviewer: reviewer.trim(), reviewerKind: 'human', at, notes } });
  }
  if (waiver.status !== 'requested') throw new Error(`Waiver ${waiverId} is already ${waiver.status}`);
  if (findingsHash(waiver.findings) !== waiver.findingsHash) throw new Error(`Waiver ${waiverId} findings do not match their hash`);
  return save(root, { ...waiver, status, decision: { status, reviewer: reviewer.trim(), reviewerKind: 'human', at, notes, ...(status === 'approved' && { waiverHash: waiverHash(waiver) }) } });
}

/** The project's waivers are the record; a runner worktree verifies against a copy refreshed before each verification. */
export async function shareWaivers(root, worktree) {
  if (!worktree || path.resolve(worktree) === path.resolve(root)) return;
  const target = await projectPath(worktree, DIRECTORY);
  await fs.rm(target, { recursive: true, force: true });
  const source = await projectPath(root, DIRECTORY);
  if (await fs.stat(source).catch(() => null)) await fs.cp(source, target, { recursive: true });
}
