import fs from 'node:fs/promises';
import path from 'node:path';
import { deliveryGit as git } from './delivery-scope.js';
import { assertMergedIndependentReview } from './delivery-review.js';
import { projectPath, readJson, writeJson, fingerprint, hash } from './util.js';
import { runnerStatePath, worktreeSuffix } from './streams.js';

/** The successful delivery process may adopt only its unchanged, genuinely reviewed merge; each target aligns its own Runner. */
export async function alignDeliveredRunner(root, config, worktree, delivery, target = null) {
  const file = await projectPath(root, runnerStatePath(config, target));
  const runner = await readJson(file, null);
  if (!runner) return { status: 'NOT_RUN', reason: 'No registered native Runner; isolated delivery leaves its checkout unchanged' };
  if (runner.afterMergeAlignment !== true) return { status: 'NOT_RUN', reason: 'Legacy Runner has not enabled managed post-merge alignment' };
  const expected = await projectPath(root, `.protoflow/runner/worktree-${hash(config.source).slice(0, 12)}${worktreeSuffix(config, target)}`);
  const rootReal = await fs.realpath(root);
  const expectedReal = await fs.realpath(expected);
  if ((await fs.lstat(expected)).isSymbolicLink() || await fs.realpath(runner.worktree) !== expectedReal || await fs.realpath(worktree) !== expectedReal || expectedReal === rootReal || runner.configHash !== hash(config) || runner.status !== 'IDLE') throw new Error('Runner identity/configuration must be valid before alignment');
  if (await fs.realpath(await git(worktree, ['rev-parse', '--show-toplevel'])) !== await fs.realpath(expected)) throw new Error('Runner checkout identity changed');
  const common = async cwd => fs.realpath(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])));
  const commonDir = await common(root);
  if (commonDir !== await common(worktree)) throw new Error('Runner belongs to another Git repository');
  const gitFile = path.join(expectedReal, '.git');
  if (!(await fs.lstat(gitFile)).isFile()) throw new Error('Runner must have its own linked worktree Git file');
  const pointer = /^gitdir: (.+)\n?$/.exec(await fs.readFile(gitFile, 'utf8'));
  const gitDir = await fs.realpath(await git(worktree, ['rev-parse', '--absolute-git-dir']));
  if (!pointer || gitDir === commonDir || path.dirname(gitDir) !== await fs.realpath(path.join(commonDir, 'worktrees')) || await fs.realpath(path.resolve(expectedReal, pointer[1])) !== gitDir || await fs.realpath((await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim()) !== await fs.realpath(gitFile)) throw new Error('Runner private Git directory/backlink is not a registered managed worktree');
  await git(worktree, ['check-ref-format', '--branch', runner.branch]);
  const branch = await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']);
  const registrations = (await git(root, ['worktree', 'list', '--porcelain'])).split('\n\n');
  const registered = registrations.some(block => block.split('\n').includes(`worktree ${expectedReal}`) && block.split('\n').includes(`branch refs/heads/${runner.branch}`));
  if (!registered || branch !== `refs/heads/${runner.branch}`) throw new Error('Runner managed branch/registration changed');
  if (delivery.status !== 'MERGED' || delivery.commit !== await git(worktree, ['rev-parse', 'HEAD'])) throw new Error('Runner HEAD differs from the merged delivery');
  const review = await assertMergedIndependentReview(root, config, delivery.independentReviewId, delivery.mergeCommit);
  if (review.binding.checkout.gitDir !== gitDir || review.binding.checkout.commonDir !== commonDir || review.binding.checkout.branch !== branch) throw new Error('Runner Git identity differs from the witnessed review');
  if (review.binding.commit !== delivery.commit || review.binding.remote.baseSha !== delivery.baseSha || review.sessionId !== delivery.independentSessionId || delivery.approval?.independentReviewId !== review.id || delivery.approval.reviewer !== `ai:codex-independent-review:${review.sessionId}`) throw new Error('Merged delivery is not bound to the live independent review');
  await git(worktree, ['diff', '--quiet']);
  const before = await fingerprint(worktree);
  await git(worktree, [`--git-dir=${gitDir}`, `--work-tree=${expectedReal}`, 'merge', '--ff-only', delivery.mergeCommit]);
  if ((await fingerprint(worktree)).hash !== before.hash) throw new Error('Application bytes changed during Runner alignment');
  const result = { status: 'PASS', deliveryId: delivery.id, previousHead: delivery.commit, head: delivery.mergeCommit, applicationHash: before.hash, alignedAt: new Date().toISOString() };
  runner.alignmentHistory = [...(runner.alignmentHistory ?? []), result];
  runner.base = delivery.mergeCommit;
  await writeJson(file, runner);
  return result;
}
