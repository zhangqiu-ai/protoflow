// Shared test double for the GitHub CLI (see tests/delivery.test.js and tests/e2e/multi-target.spec.js).
/**
 * Local stand-in for the GitHub CLI: pull requests live in a JSON file and heads come from the real bare remote.
 * This exercises ProtoFlow's argv protocol only; real GitHub delivery is recorded separately as acceptance evidence.
 */
export const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const db = process.env.FAKE_GH_DB; const state = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : { prs: [], calls: [], environments: [] };
const args = process.argv.slice(2); state.calls.push(args);
state.environments.push({ GH_REPO: process.env.GH_REPO ?? null, GH_HOST: process.env.GH_HOST ?? null, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT ?? null });
const save = () => fs.writeFileSync(db, JSON.stringify(state));
const flag = name => args[args.indexOf(name) + 1];
const repository = args.includes('--repo') ? flag('--repo') : process.env.GH_REPO;
const head = (branch, target = repository) => execFileSync('git', ['ls-remote', 'https://' + target + '.git', 'refs/heads/' + branch]).toString().split('\t')[0] || null;
const find = key => state.prs.find(pr => pr.repository === repository && (String(pr.number) === key || pr.head === key));
const view = pr => ({ number: pr.number, url: 'https://' + pr.repository + '/pull/' + pr.number, state: pr.state, headRefOid: head(pr.head, pr.repository), baseRefOid: head(pr.base, pr.repository), baseRefName: pr.base, headRefName: pr.head, isDraft: pr.isDraft ?? false, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, mergedAt: pr.mergedAt ?? null, mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null, closedAt: pr.closedAt ?? null, body: pr.body ?? '' });
const repo = name => ({ id: name.endsWith('/application') ? 101 : 202, full_name: name.replace('github.com/', ''), html_url: 'https://' + name });
const rest = pr => ({ number: pr.number, html_url: view(pr).url, state: pr.state.toLowerCase(), head: { ref: pr.head, sha: pr.headSha ?? head(pr.head, pr.repository), repo: pr.headRepo ?? repo(pr.repository) }, base: { ref: pr.base, sha: pr.baseSha ?? head(pr.base, pr.repository), repo: repo(pr.repository) } });
const [group, verb] = args;
if (group === 'api' && verb === 'user') { save(); console.log(flag('--jq') === '.login' ? (process.env.FAKE_GH_VIEWER ?? 'fixture-person') : JSON.stringify({ login: process.env.FAKE_GH_VIEWER ?? 'fixture-person' })); process.exit(0); }
if (process.env.FAKE_GH_FAIL === verb) { save(); console.error(process.env.FAKE_GH_FAIL_MESSAGE ?? 'simulated gh ' + verb + ' failure'); process.exit(1); }
// One transient GitHub outage of the repository lookup, armed by a trigger file (written by the fake reviewer).
const outage = process.env.FAKE_GH_UNAVAILABLE_AFTER;
if (outage && group === 'api' && /^repos\/[^/]+\/[^/]+$/.test(verb) && fs.existsSync(outage)) { fs.unlinkSync(outage); save(); console.error('Get "https://api.github.com/' + verb + '": Service Unavailable'); process.exit(1); }
if (group === 'api' && /^repos\/protoflow-fixture\/[^/]+\/pulls\/\d+$/.test(verb) && flag('--hostname') === 'github.com') {
  const name = 'github.com/' + verb.split('/').slice(1, 3).join('/');
  const pr = state.prs.find(pr => pr.repository === name && String(pr.number) === verb.split('/').at(-1));
  console.log(JSON.stringify(rest(pr)));
}
else if (group === 'api' && /^repos\/protoflow-fixture\/[^/]+$/.test(verb) && flag('--hostname') === 'github.com' && process.env.GH_HOST === 'github.com') {
  const name = process.env.FAKE_GH_CANONICAL_NAME ?? verb.slice('repos/'.length);
  console.log(JSON.stringify({ id: Number(process.env.FAKE_GH_REPOSITORY_ID ?? (name.endsWith('/application') ? 101 : 202)), full_name: name, html_url: 'https://github.com/' + name }));
}
else if (group === 'pr' && verb === 'list') { console.log(JSON.stringify(state.prs.filter(pr => pr.repository === repository && pr.state === 'OPEN' && pr.head === flag('--head') && pr.base === flag('--base')).map(view))); }
else if (group === 'pr' && verb === 'create') { state.prs.push({ number: state.prs.length + 1, repository, head: flag('--head'), base: flag('--base'), title: flag('--title'), body: flag('--body'), state: 'OPEN', isDraft: args.includes('--draft'), comments: [] }); }
else if (group === 'pr' && verb === 'view') { console.log(JSON.stringify(view(find(args[2])))); }
else if (group === 'pr' && verb === 'comment') { find(args[2]).comments.push(flag('--body')); }
else if (group === 'pr' && verb === 'edit') { find(args[2]).body = flag('--body'); }
else if (group === 'pr' && verb === 'ready') { find(args[2]).isDraft = false; }
else if (group === 'pr' && verb === 'merge') {
  const pr = find(args[2]);
  if (flag('--match-head-commit') !== head(pr.head)) { save(); console.error('head moved'); process.exit(1); }
  pr.state = 'MERGED'; pr.mergeCommit = 'merge-' + pr.number; pr.mergedAt = new Date().toISOString(); pr.mergedBy = process.env.FAKE_GH_VIEWER ?? 'fixture-person';
  if (process.env.FAKE_GH_REAL_REMOTE) {
    const remote = process.env.FAKE_GH_REAL_REMOTE;
    const git = (...argv) => execFileSync('git', ['-C', remote, ...argv], { encoding: 'utf8' }).trim();
    const base = head(pr.base), app = head(pr.head);
    const tree = git('rev-parse', app + '^{tree}');
    pr.mergeCommit = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit-tree', tree, '-p', base, '-p', app, '-m', 'Actual local merge fixture');
    git('update-ref', 'refs/heads/' + pr.base, pr.mergeCommit);
    if (process.env.FAKE_GH_TAMPER_REVIEW) {
      const directory = process.env.FAKE_GH_ROOT + '/.protoflow/delivery/independent-reviews';
      const file = fs.readdirSync(directory).find(name => name.endsWith('.json'));
      const record = JSON.parse(fs.readFileSync(directory + '/' + file)); record.traceHash = '0'.repeat(64); fs.writeFileSync(directory + '/' + file, JSON.stringify(record));
    }
    if (process.env.FAKE_GH_TAMPER_RUNNER) {
      const file = process.env.FAKE_GH_ROOT + '/.protoflow/runner/state.json';
      const runner = JSON.parse(fs.readFileSync(file)); runner.worktree = process.env.FAKE_GH_ROOT; fs.writeFileSync(file, JSON.stringify(runner));
    }
  }
} else if (group === 'api' && process.env.FAKE_GH_ISSUES && /^repos\/[^/]+\/[^/]+\/(?:issues|labels|collaborators)\b/.test(verb)) {
  // Issue endpoints are served by the issue fixture with its own database (tests/fixtures/fake-gh-issues.cjs).
  save();
  const input = args.includes('--input') ? fs.readFileSync(0) : undefined;
  try { process.stdout.write(execFileSync(process.execPath, [process.env.FAKE_GH_ISSUES, ...args], { input, env: { ...process.env, FAKE_GH_DB: process.env.FAKE_GH_ISSUES_DB } })); process.exit(0); }
  catch (error) { process.stderr.write(error.stderr ?? ''); process.exit(error.status ?? 1); }
} else { save(); console.error('unsupported ' + args.join(' ')); process.exit(2); }
// 'lookup' is the pr list that finds a just-created PR; 'list' is the first discovery.
const phase = group === 'api' && verb.includes('/pulls/') ? 'pull-api' : verb === 'list' && state.calls.filter(call => call[1] === 'list').length > 1 ? 'lookup' : verb;
if (!state.drifted && process.env.FAKE_GH_DRIFT === phase) { fs.appendFileSync('app/index.html', '\nFAKE discovery drift'); state.drifted = true; }
save();
`;
