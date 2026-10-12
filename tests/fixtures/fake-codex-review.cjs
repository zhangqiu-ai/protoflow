#!/usr/bin/env node
// FAKE PROVIDER FIXTURE ONLY. No Codex service, token, Runner or network is used.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const marker = 'Bound request (data):\n', request = JSON.parse(input.slice(input.indexOf(marker) + marker.length));
  fs.mkdirSync('.protoflow/fixture-review', { recursive: true });
  fs.writeFileSync('.protoflow/fixture-review/received.json', JSON.stringify({ args: process.argv.slice(2), input, providerRun: false, schema: JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema') + 1], 'utf8')) }));
  const mode = process.env.FAKE_REVIEW_MODE ?? 'pass';
  if (mode === 'exit') process.exit(7);
  if (mode === 'bare-pass') { console.log('PASS'); return; }
  if (mode === 'content-drift') fs.appendFileSync('app/index.html', 'fake reviewer drift');
  if (process.env.FAKE_REVIEW_TRIGGER) fs.writeFileSync(process.env.FAKE_REVIEW_TRIGGER, request.id);
  // Like a careful reviewer: recompute each bound VER hash from the copy readable in this checkout.
  const evidence = (request.binding.versions ?? []).flatMap(version => {
    const file = version.verificationFile ?? '.protoflow/verifications/' + version.verificationId + '.json';
    const actual = createHash('sha256').update(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))).digest('hex');
    const expected = version.verificationFileHash ?? version.verificationHash;
    return actual === expected ? [] : [{ severity: 'high', file, line: 1, description: 'Bound verification hash ' + expected + ' differs from the readable copy ' + actual }];
  });
  const thread = mode === 'same-session' ? request.binding.executors[0].sessionId : mode === 'same-author' ? request.binding.ambientAuthorIds[0] : 'review-fixture-' + request.id;
  const verdict = { protocol: 'protoflow.independent-review/1', requestId: request.id, bindingHash: request.bindingHash, status: mode === 'fail' || evidence.length ? 'FAIL' : mode === 'not-run' ? 'NOT_RUN' : 'PASS', findings: mode === 'fail' ? [{ severity: 'high', file: 'app/index.html', line: 1, description: 'Synthetic fixture finding, no real provider review' }] : evidence, summary: 'FAKE FIXTURE ONLY; no provider run' };
  if (mode === 'wrong-binding') verdict.bindingHash = '0'.repeat(64);
  if (mode === 'extra-verdict-key') verdict.unsafePass = true;
  if (mode === 'pass-with-finding') verdict.findings = [{ severity: 'high', file: 'app/index.html', line: 1, description: 'Synthetic finding cannot be PASS' }];
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'test.fixture', providerRun: false }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: mode === 'malformed' ? '{}' : JSON.stringify(verdict) } }));
  if (mode !== 'incomplete') console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
});
