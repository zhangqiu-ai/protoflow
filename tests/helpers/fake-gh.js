// Shared test double for the GitHub CLI (see tests/delivery.test.js and tests/e2e/multi-target.spec.js).
/**
 * Local stand-in for the GitHub CLI: pull requests live in a JSON file and heads come from the real bare remote.
 * This exercises ProtoFlow's argv protocol only; real GitHub delivery is recorded separately as acceptance evidence.
 */
export const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const db = process.env.FAKE_GH_DB; const state = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : { prs: [], calls: [] };
const args = process.argv.slice(2); state.calls.push(args);
const save = () => fs.writeFileSync(db, JSON.stringify(state));
const flag = name => args[args.indexOf(name) + 1];
const head = branch => execFileSync('git', ['ls-remote', 'origin', 'refs/heads/' + branch]).toString().split('\t')[0] || null;
const find = key => state.prs.find(pr => String(pr.number) === key || pr.head === key);
const view = pr => ({ number: pr.number, url: 'https://github.test/pr/' + pr.number, state: pr.state, headRefOid: pr.mergedHead ?? head(pr.head), mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, mergedAt: pr.mergedAt ?? null });
const [group, verb] = args;
if (process.env.FAKE_GH_FAIL === verb) { save(); console.error('simulated gh ' + verb + ' failure'); process.exit(1); }
if (group === 'pr' && verb === 'list') { console.log(JSON.stringify(state.prs.filter(pr => pr.state === 'OPEN' && pr.head === flag('--head') && pr.base === flag('--base')).map(view))); }
else if (group === 'pr' && verb === 'create') { state.prs.push({ number: state.prs.length + 1, head: flag('--head'), base: flag('--base'), title: flag('--title'), state: 'OPEN', comments: [] }); }
else if (group === 'pr' && verb === 'view') { console.log(JSON.stringify(view(find(args[2])))); }
else if (group === 'pr' && verb === 'comment') { find(args[2]).comments.push(flag('--body')); }
else if (group === 'pr' && verb === 'merge') {
  const pr = find(args[2]);
  if (flag('--match-head-commit') !== head(pr.head)) { save(); console.error('head moved'); process.exit(1); }
  pr.state = 'MERGED'; pr.mergedHead = head(pr.head); pr.mergeCommit = 'merge-' + pr.number; pr.mergedAt = new Date().toISOString();
} else { save(); console.error('unsupported ' + args.join(' ')); process.exit(2); }
save();
`;
