import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexTrace } from '../src/delivery-review.js';

const thread = { type: 'thread.started', thread_id: '01a137b3-d4ce-75f3-9f69-091a64d18781' };
const reply = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{"status":"PASS"}' } };
const reconnect = { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)' };
const jsonl = events => events.map(event => JSON.stringify(event)).join('\n');
const trace = (...middle) => jsonl([thread, { type: 'turn.started' }, ...middle, reply, { type: 'turn.completed', usage: {} }]);

test('a completed fresh session yields its id and final verdict', () => {
  const result = readCodexTrace(trace(), { finalVerdict: true });
  assert.equal(result.sessionId, thread.thread_id);
  assert.deepEqual(result.verdict, { status: 'PASS' });
});

test('a stream reconnect notice inside a turn that completes is not a failure', () => {
  const result = readCodexTrace(trace(reconnect, reconnect), { finalVerdict: true });
  assert.equal(result.sessionId, thread.thread_id);
  assert.deepEqual(result.verdict, { status: 'PASS' });
});

test('other errors, failed turns and reconnects outside the completed turn still block', () => {
  for (const bad of [
    trace({ type: 'error', message: 'unexpected status 401 Unauthorized' }),
    trace({ type: 'error' }),
    trace({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
    jsonl([thread, { type: 'turn.started' }, reconnect]),
    jsonl([thread, { type: 'turn.started' }, reply, { type: 'turn.completed' }, reconnect]),
    jsonl([thread, reconnect, { type: 'turn.started' }, reply, { type: 'turn.completed' }]),
    jsonl([thread, { type: 'turn.started' }, { type: 'turn.completed' }, { type: 'turn.started' }, { type: 'turn.completed' }])
  ]) assert.throws(() => readCodexTrace(bad), /no single completed fresh session/);
});
