#!/usr/bin/env node
// FAKE claude CLI for tests only: emits a stream-json trace shaped like `claude -p --output-format stream-json --verbose`.
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'pass';
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLAUDE_RECORD) fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, input, cwd: process.cwd() }));
  if (mode === 'screenshots') {
    // An executor that reads screenshots: stream-json echoes each image as base64 twice, plus one long tool output.
    const png = Buffer.alloc(512 * 1024, 7).toString('base64');
    const write = event => process.stdout.write(`${JSON.stringify(event)}\n`);
    write({ type: 'system', subtype: 'init', session_id: 'fake-session-a', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], mcp_servers: [], model: 'claude-fake', permissionMode: 'acceptEdits' });
    for (let index = 0; index < 8; index++) {
      write({ type: 'assistant', session_id: 'fake-session-a', message: { content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'Read', input: { file_path: `shot-${index}.png` } }] } });
      write({ type: 'user', session_id: 'fake-session-a', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: [{ type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } }] }] }, tool_use_result: { type: 'image', file: { base64: png, type: 'image/png' } } });
    }
    write({ type: 'assistant', session_id: 'fake-session-a', message: { content: [{ type: 'tool_use', id: 'toolu_log', name: 'Bash', input: { command: 'npm test' } }] } });
    write({ type: 'user', session_id: 'fake-session-a', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_log', content: `FIRST LINE\n${'x'.repeat(200 * 1024)}\nLAST LINE` }] } });
    write({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-a', result: 'done', total_cost_usd: 0.01 });
    return;
  }
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
