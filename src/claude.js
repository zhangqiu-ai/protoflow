import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { hash } from './util.js';

/** Tools a planner or acceptor may use; StructuredOutput is how `--json-schema` returns its result. */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const ALLOWED = new Set([...CLAUDE_READ_ONLY_TOOLS, 'StructuredOutput']);
/** The executor may also edit files and run commands, confined by --restricted and the Bash sandbox. */
export const CLAUDE_EXECUTOR_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
const EXECUTOR = new Set(CLAUDE_EXECUTOR_TOOLS);
/**
 * The one subagent an executor may delegate to (scripts/claude-exec-adapter.js --subagent-model): the executor's tools
 * without Agent, so it cannot nest, under the same --restricted file confinement, Bash sandbox and budget as its parent.
 * The CLI lists the delegation tool as Task in the session start and calls it Agent.
 */
export const CLAUDE_WORKER = 'protoflow-worker';
const DELEGATE = new Set(['Agent', 'Task']);
/** Built-in subagent types, denied so the executor can only delegate to the worker (the trace check catches any newer one). */
const BUILT_IN_AGENTS = ['general-purpose', 'Explore', 'Plan', 'claude', 'claude-code-guide', 'statusline-setup'];
const SESSION = /^[A-Za-z0-9_-]{8,100}$/;

export function claudeBlocked(message, reasonCode = 'CLAUDE_TRACE_INVALID') {
  const error = new Error(message);
  error.code = 'CLAUDE_BLOCKED'; error.reasonCode = reasonCode;
  return error;
}

/**
 * The claude executable as { path, hash }: an explicit path (adapter --claude or PROTOFLOW_CLAUDE), else the first
 * `claude` on an absolute PATH entry. Hashing binds the exact binary into every request and run.
 */
export async function resolveClaudeExecutable(explicit = process.env.PROTOFLOW_CLAUDE) {
  const candidates = explicit ? [explicit] : (process.env.PATH ?? '').split(path.delimiter).filter(prefix => path.isAbsolute(prefix)).map(prefix => path.join(prefix, 'claude'));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      return { path: resolved, hash: hash(await fs.readFile(resolved)) };
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw claudeBlocked(explicit ? `Claude executable ${explicit} is not an executable file` : 'Claude executable is unavailable on the trusted PATH; set PROTOFLOW_CLAUDE or pass --claude', 'CLAUDE_UNAVAILABLE');
}

/** A failed result that says the provider could not run (no login, no credit), as opposed to a judgment. */
const ENVIRONMENT = /not logged in|please run \/login|invalid api key|authentication|credit balance|unauthorized|403|401/i;

/**
 * Verify a `claude -p --output-format stream-json --verbose` trace: exactly one fresh session whose init offered only
 * read-only tools, in dontAsk mode and without MCP servers; no tool use outside that set; every event in the same
 * session; and one final successful result carrying structured output. Returns what the engine binds. An executor
 * session that offers the worker subagent may delegate to it and to nothing else; what its workers do is held to the
 * executor tools, and the delegations and the models that served them are returned as `subagents`.
 */
export function readClaudeTrace(trace, { executor = false } = {}) {
  let allowed = executor ? EXECUTOR : ALLOWED;
  const modes = executor ? ['dontAsk', 'acceptEdits'] : ['dontAsk'];
  if (typeof trace !== 'string' || !trace.trim()) throw claudeBlocked('Missing raw Claude trace');
  let events;
  try { events = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw claudeBlocked('Malformed raw Claude stream-json trace'); }
  const inits = events.filter(event => event.type === 'system' && event.subtype === 'init');
  // Only informational system events (e.g. dev_intent from the CLI's project scan) may precede the session start.
  if (inits.length !== 1 || events.slice(0, events.indexOf(inits[0])).some(event => event.type !== 'system')) throw claudeBlocked('Claude trace has no single session start');
  const init = inits[0];
  const delegating = executor && (init.agents ?? []).includes(CLAUDE_WORKER);
  if (delegating) allowed = new Set([...EXECUTOR, ...DELEGATE]);
  if (!SESSION.test(init.session_id ?? '')) throw claudeBlocked('Claude trace has no valid session id');
  if (events.some(event => event.session_id !== undefined && event.session_id !== init.session_id)) throw claudeBlocked('Claude trace mixes sessions');
  const scope = executor ? 'the executor set' : 'read-only';
  if (!Array.isArray(init.tools) || init.tools.some(tool => !allowed.has(tool))) throw claudeBlocked(`Claude session offered tools beyond ${scope}: ${(init.tools ?? []).filter(tool => !allowed.has(tool)).join(', ') || 'none listed'}`);
  if (!modes.includes(init.permissionMode)) throw claudeBlocked(`Claude session ran in permission mode ${init.permissionMode}, not ${modes.join(' or ')}`);
  if ((init.mcp_servers ?? []).length) throw claudeBlocked('Claude session loaded MCP servers');
  const calls = events.flatMap(event => event.type === 'assistant' ? (event.message?.content ?? []).filter(item => item?.type === 'tool_use').map(item => ({ ...item, subagent: Boolean(event.parent_tool_use_id) })) : []);
  // A call to a tool the session does not have (a model writing `bash` for `Bash`) is refused by the CLI and runs
  // nothing: it is not a use. Any other call outside the set is, whatever its result.
  const refused = new Set(events.flatMap(event => event.type === 'user' && Array.isArray(event.message?.content) ? event.message.content.filter(item => item?.type === 'tool_result' && item.is_error && /^<tool_use_error>Error: No such tool available: /.test(typeof item.content === 'string' ? item.content : '')).map(item => item.tool_use_id) : []));
  const ran = calls.filter(item => !(item.id && refused.has(item.id) && !init.tools.includes(item.name))), used = ran.map(item => item.name);
  // A worker has the executor tools only: a delegation from inside one is a nested subagent and outside the set.
  const forbidden = ran.filter(item => !(item.subagent ? EXECUTOR : allowed).has(item.name)).map(item => item.name);
  if (forbidden.length) throw claudeBlocked(`Claude session used tools beyond ${scope}: ${[...new Set(forbidden)].join(', ')}`);
  // A delegation to a denied built-in type (`--disallowedTools Agent(Explore)`) is refused and starts no subagent.
  const denied = new Set(events.flatMap(event => event.type === 'user' && Array.isArray(event.message?.content) ? event.message.content.filter(item => item?.type === 'tool_result' && item.is_error && /^Agent type '[^']*' has been denied by permission rule/.test(typeof item.content === 'string' ? item.content : '')).map(item => item.tool_use_id) : []));
  const delegations = ran.filter(item => DELEGATE.has(item.name) && !(item.id && denied.has(item.id)));
  const strays = delegations.filter(item => item.input?.subagent_type !== CLAUDE_WORKER).map(item => String(item.input?.subagent_type ?? 'unnamed'));
  if (strays.length) throw claudeBlocked(`Claude executor delegated to subagent types other than ${CLAUDE_WORKER}: ${[...new Set(strays)].join(', ')}`);
  const results = events.filter(event => event.type === 'result');
  // After the result only informational events may follow (system task_summary, rate_limit_event); no more turns.
  const after = results.length === 1 ? events.slice(events.indexOf(results[0]) + 1) : [];
  if (results.length !== 1 || after.some(event => ['assistant', 'user', 'result'].includes(event.type) || (event.type === 'system' && event.subtype === 'init'))) throw claudeBlocked('Claude trace has no single final result');
  const result = results[0];
  if (result.subtype !== 'success' || result.is_error) {
    const reason = String(result.result ?? result.subtype ?? 'unknown').slice(0, 500);
    throw claudeBlocked(`Claude session did not complete: ${reason}`, ENVIRONMENT.test(reason) ? 'CLAUDE_ENVIRONMENT' : 'CLAUDE_FAILED');
  }
  if (!executor && (!result.structured_output || typeof result.structured_output !== 'object' || Array.isArray(result.structured_output))) throw claudeBlocked('Claude trace has no structured output');
  return {
    sessionId: init.session_id, traceHash: hash(trace), output: result.structured_output ?? null, model: init.model ?? null,
    toolsUsed: [...new Set(used)], costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    // total_cost_usd and --max-budget-usd include the workers' spend.
    ...(delegations.length && { subagents: { count: delegations.length, models: [...new Set(events.filter(event => event.type === 'assistant' && event.parent_tool_use_id && event.message?.model).map(event => event.message.model))] } })
  };
}

/** The headless argv: read-only tools, no prompts, no user settings, MCP or saved session; one schema-bound answer. */
export function claudeArgv({ schema, model, maxBudgetUsd }) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
    '--tools', CLAUDE_READ_ONLY_TOOLS.join(','), '--permission-mode', 'dontAsk',
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
    ...(model ? ['--model', model] : []), ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])
  ];
}

/**
 * The executor argv: --restricted confines file tools to the working directory and protects settings, git and tool
 * configuration; the sandbox setting runs Bash under the OS sandbox without falling back to unsandboxed commands.
 * Edits are accepted without prompts; anything else that would ask is denied. No user settings, MCP or saved session.
 * With a subagent model the executor may also delegate to the worker subagent on that model (CLAUDE_WORKER), which
 * runs in the foreground (parallel workers still run at the same time); the built-in subagent types stay denied.
 */
export function claudeExecutorArgv({ model, maxBudgetUsd, addDirs = [], subagentModel = null }) {
  const worker = { description: 'Implements one independent subtask the ProtoFlow executor delegates, touching only the files it names', prompt: WORKER_PROMPT, model: subagentModel, tools: CLAUDE_EXECUTOR_TOOLS };
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--restricted',
    '--tools', [...CLAUDE_EXECUTOR_TOOLS, ...(subagentModel ? ['Agent'] : [])].join(','), '--allowedTools', 'Bash', '--permission-mode', 'acceptEdits',
    ...(subagentModel ? ['--agents', JSON.stringify({ [CLAUDE_WORKER]: worker }), '--disallowedTools', BUILT_IN_AGENTS.map(type => `Agent(${type})`).join(',')] : []),
    // Workers run in the foreground: a background one would finish after the session's result and start another turn.
    '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }, ...(subagentModel && { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } }) }),
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
    ...addDirs.flatMap(dir => ['--add-dir', dir]),
    ...(model ? ['--model', model] : []), ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])
  ];
}
const WORKER_PROMPT = "You are a ProtoFlow worker: the executor delegated one independent subtask of an application change to you. Follow the target project's AGENTS.md. Work only inside the current project and change only the files your task names; another worker may be changing other files at the same time. Do not modify the prototype, approve a review, create a baseline, commit, push, deploy or change external systems. Run the tests your task names; report the files you changed, the tests you ran with their results, and anything you could not finish.";
/** A failure that means this provider has no capacity for us now; the runner hands the attempt to the fallback executor. */
export const CLAUDE_QUOTA = /usage limit|rate.?limit|quota|credit balance|overloaded|\b(?:429|529)\b|too many requests/i;
