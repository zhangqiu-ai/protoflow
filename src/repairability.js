/**
 * Which verification failures an executor can repair in the application, and whether a repair round changed anything.
 * A scene that fails only because the driver captured at the wrong size, the build never produced the declared output
 * or the frozen prototype cannot reach the state is a configuration or prototype problem: more repair attempts cannot
 * fix it, so the runner blocks at once (reasonCode `verification-config`) instead of spending the attempts.
 */
export const UNREPAIRABLE_KINDS = {
  'capture-size': 'the driver captured the application at a size other than the target viewport (target viewport/scale or device setting)',
  'build-output': 'the build did not produce an output the target declares (build command or outputs)',
  'prototype-unreachable': 'the frozen prototype cannot reach this state (fix the prototype)',
  'tier-off': 'a tier that is off for this target failed (target tiers setting)'
};
const KINDS = [
  { kind: 'capture-size', test: /^application (viewport|screenshot) .* does not match requested/ },
  { kind: 'build-output', test: /does not exist; the target's build must produce it/ },
  { kind: 'prototype-unreachable', test: /^prototype state is unreachable/ }
];
const TIER_OFF = 'tier is off for this target';

/** What a verification failed on: one key per failing check, build variant or scene. */
export function failureKeys(report) {
  const keys = ['build', 'functional', 'hygiene'].filter(section => report?.[section]?.status && report[section].status !== 'PASS');
  for (const [name, result] of Object.entries(report?.build?.variants ?? {})) if (result?.status !== 'PASS') keys.push(`build:${name}`);
  // A scene a failing-first repair check skipped was not verified: it is not a failure (nor evidence of a PASS).
  const scenes = (report?.visual?.scenes ?? []).filter(scene => scene.status !== 'PASS' && !scene.skipped).map(scene => sceneKey(scene));
  keys.push(...scenes);
  if (report?.visual?.status && report.visual.status !== 'PASS' && !scenes.length) keys.push('visual');
  if (report?.changedDuringVerification) keys.push('changedDuringVerification');
  return keys;
}
/** The failing test a test runner names (Playwright `1) [project] › file:line`) and the first error line after it. */
export function functionalFailure(report) {
  const output = report?.functional?.status && report.functional.status !== 'PASS' ? `${report.functional.stdout ?? ''}\n${report.functional.stderr ?? ''}` : '';
  const lines = output.split('\n').map(item => item.trim());
  return [lines.find(item => /^\d+\) /.test(item)), lines.find(item => /^\w*Error\b.*:|\bENOENT\b/.test(item))].filter(Boolean).join(' — ').slice(0, 400) || null;
}
const sceneKey = scene => `scene:${scene.variant ? `${scene.variant}/` : ''}${scene.id}`;
const failingTiers = scene => Object.entries(scene.tiers ?? {}).filter(([, tier]) => tier?.status && tier.status !== 'PASS');
/** Every reason a failing scene gives: its own reason and the reasons of its failing tiers. */
const sceneReasons = scene => [scene.reason, ...failingTiers(scene).flatMap(([, tier]) => tier.reasons ?? [])].filter(reason => typeof reason === 'string' && reason.trim()).map(reason => reason.trim());
function reasonKind(reason, tier) {
  if (tier && tier.reasons?.length === 1 && tier.reasons[0].trim() === TIER_OFF) return 'tier-off';
  return KINDS.find(item => item.test.test(reason))?.kind ?? null;
}
/**
 * Split a report's failures into those an executor cannot repair in the application (every reason of the scene is
 * of an unrepairable kind) and the rest. Build, functional, hygiene and changedDuringVerification keys are always
 * repairable here; environment failures are NOT_RUN and handled by the runner before this.
 */
export function classifyFailures(report) {
  const unrepairable = [];
  const repairable = [];
  const scenes = new Map((report?.visual?.scenes ?? []).map(scene => [sceneKey(scene), scene]));
  for (const key of failureKeys(report)) {
    const scene = scenes.get(key);
    if (!scene) { repairable.push(key); continue; }
    const tiers = failingTiers(scene);
    const kinds = new Set();
    let repairableReason = false;
    for (const [, tier] of tiers) {
      const reasons = (tier.reasons ?? []).map(reason => String(reason).trim()).filter(Boolean);
      if (!reasons.length) { repairableReason = true; continue; }
      for (const reason of reasons) { const kind = reasonKind(reason, tier); kind ? kinds.add(kind) : (repairableReason = true); }
    }
    if (scene.reason) { const kind = reasonKind(String(scene.reason).trim(), null); kind ? kinds.add(kind) : (repairableReason = true); }
    if (!kinds.size || repairableReason) { repairable.push(key); continue; }
    unrepairable.push({ key, kind: [...kinds][0], reasons: [...new Set(sceneReasons(scene))] });
  }
  return { unrepairable, repairable };
}
/** One line naming the unrepairable failures by kind, e.g. `capture-size: iphone/a, ipad/a; build-output: android/b`. */
export function unrepairableSummary(classified) {
  const byKind = new Map();
  for (const item of classified?.unrepairable ?? []) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item.key.replace(/^scene:/, '')]);
  let budget = 8;
  const parts = [];
  let hidden = 0;
  for (const [kind, keys] of byKind) {
    const shown = keys.slice(0, Math.max(budget, 0));
    hidden += keys.length - shown.length;
    budget -= shown.length;
    if (shown.length) parts.push(`${kind}: ${shown.join(', ')}`);
  }
  return `${parts.join('; ')}${hidden ? ` and ${hidden} more` : ''}`;
}
const buildVerdict = report => JSON.stringify([report?.build?.status ?? null, Object.entries(report?.build?.variants ?? {}).map(([name, result]) => [name, result?.status ?? null]).sort()]);
/**
 * Two reports fail identically when they fail the same keys, the same build verdict (and per variant), the same
 * functional verdict with the same first failing test, and every failing scene fails the same tiers for the same
 * reasons. When a repair round leaves all of that byte-identical, the executor changed nothing that matters, so one such
 * round is a stall whatever policy.stallRounds says.
 */
export function identicalFailures(previous, current) {
  if (!previous || !current) return false;
  const before = failureKeys(previous);
  const after = failureKeys(current);
  if (before.length !== after.length || !before.every(key => after.includes(key))) return false;
  if (buildVerdict(previous) !== buildVerdict(current)) return false;
  if ((previous.functional?.status ?? null) !== (current.functional?.status ?? null)) return false;
  if (current.functional?.status && current.functional.status !== 'PASS' && functionalFailure(previous) !== functionalFailure(current)) return false;
  const signature = report => Object.fromEntries((report.visual?.scenes ?? []).filter(scene => scene.status !== 'PASS' && !scene.skipped).map(scene => [sceneKey(scene), JSON.stringify([
    scene.status ?? null, (scene.reason ?? '').trim(),
    failingTiers(scene).map(([name, tier]) => [name, tier.status, (tier.reasons ?? []).map(reason => String(reason).trim())]).sort((a, b) => a[0].localeCompare(b[0]))
  ])]));
  const left = signature(previous);
  const right = signature(current);
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value);
}
