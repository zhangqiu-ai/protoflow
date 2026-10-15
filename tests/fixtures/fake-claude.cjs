#!/usr/bin/env node
// FAKE claude CLI for tests only: emits a stream-json trace shaped like `claude -p --output-format stream-json --verbose`.
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'pass';
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLAUDE_RECORD) fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, input, cwd: process.cwd() }));
  const session = mode === 'mixed' ? 'fake-session-b' : 'fake-session-a';
  const tools = mode === 'write-tool' ? ['Read', 'Grep', 'Glob', 'Bash', 'StructuredOutput'] : ['Glob', 'Grep', 'Read', 'StructuredOutput'];
  // Review modes answer the bound request through the consts the bridge put into --json-schema.
  const schema = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : null;
  const review = mode.startsWith('review-') && schema?.properties?.requestId?.const
    ? { protocol: 'protoflow.independent-review/1', requestId: schema.properties.requestId.const, bindingHash: schema.properties.bindingHash.const, status: mode === 'review-fail' ? 'FAIL' : 'PASS', findings: mode === 'review-fail' ? [{ severity: 'high', file: 'app/index.html', line: 1, description: 'Synthetic Claude fixture finding, no real provider review' }] : [], summary: 'FAKE CLAUDE FIXTURE ONLY; no provider run' }
    : null;
  const output = review ?? (process.env.FAKE_CLAUDE_OUTPUT ? JSON.parse(process.env.FAKE_CLAUDE_OUTPUT) : { status: 'PASS' });
  const events = [
    { type: 'system', subtype: 'init', session_id: 'fake-session-a', tools, mcp_servers: [], model: 'claude-fake', permissionMode: mode === 'default-mode' ? 'default' : 'dontAsk' },
    { type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', name: mode === 'uses-edit' ? 'Edit' : 'Read', input: { file_path: 'README.md' } }] } },
    { type: 'user', session_id: 'fake-session-a', message: { content: [{ type: 'tool_result', content: 'FAKE FIXTURE ONLY' }] } },
    mode === 'not-logged-in'
      ? { type: 'result', subtype: 'success', is_error: true, session_id: 'fake-session-a', result: 'Not logged in · Please run /login', total_cost_usd: 0 }
      : { type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-a', result: 'done', structured_output: mode === 'bad-output' ? { status: 'MAYBE' } : output, total_cost_usd: 0.01 }
  ];
  process.stdout.write(events.map(event => JSON.stringify(event)).join('\n') + '\n');
});
