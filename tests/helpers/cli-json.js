/**
 * Parse ProtoFlow CLI output by its contract: stdout carries the result (runner start prints JSONL events first,
 * then the pretty-printed result); on failure stdout is empty and the last stderr line is the JSON error.
 */
export function parseCliOutput(stdout = '', stderr = '') {
  const out = (stdout ?? '').trim();
  if (out) return JSON.parse(out.startsWith('{"event"') ? out.slice(out.lastIndexOf('\n{\n') + 1) : out);
  return JSON.parse((stderr ?? '').trim().split('\n').at(-1));
}
