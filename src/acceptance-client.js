import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runCommand } from './util.js';

/** Project-side SDK for the framework-independent protoflow.acceptance/1 JSONL contract. */
export async function acceptanceClient() {
  const pending = new Map(); let sequence = 0, requestResolve, requestReject, disconnected = null;
  const first = new Promise((resolve, reject) => { requestResolve = resolve; requestReject = reject; });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let request;
  const fail = error => {
    disconnected = error; requestReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  input.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!request) {
        if (message.protocol !== 'protoflow.acceptance/1' || message.schemaVersion !== 1) throw new Error('Unsupported acceptance request');
        request = message; requestResolve(message);
      } else {
        const waiter = pending.get(message.ack);
        if (!waiter) throw new Error('Unexpected acceptance acknowledgement');
        pending.delete(message.ack);
        message.ok ? waiter.resolve(message) : waiter.reject(new Error(message.error ?? 'Acceptance event rejected'));
      }
    } catch (error) { fail(error); }
  });
  input.on('close', () => fail(new Error('Acceptance supervisor disconnected')));
  const event = message => new Promise((resolve, reject) => {
    if (disconnected) return reject(disconnected);
    const seq = ++sequence; pending.set(seq, { resolve, reject });
    process.stdout.write(`${JSON.stringify({ ...message, seq })}\n`, error => {
      if (error) { pending.delete(seq); reject(error); }
    });
  });
  await first;
  return {
    request,
    starting: id => event({ type: 'process-starting', id }),
    started: (id, pid) => event({ type: 'process-started', id, pid, pgid: pid }),
    notStarted: (id, error) => event({ type: 'process-not-started', id, error }),
    finished: (id, status = 'PASS') => event({ type: 'process-finished', id, status }),
    result: data => event({ ...data, type: 'result' }),
    close: () => { input.close(); process.stdin.destroy(); }
  };
}

/** The command bridge receives argv only after the supervisor acknowledges its durable PID. */
export async function runAcceptanceCommand(client, id, command, { env } = {}) {
  let pid = null;
  const result = await runCommand(client.request.projectRoot, {
    argv: [process.execPath, fileURLToPath(new URL('../scripts/acceptance-command.js', import.meta.url))],
    timeoutMs: command.timeoutMs ?? 120000
  }, command, {
    env,
    onBeforeSpawn: () => client.starting(id),
    onStart: async processId => { pid = processId; await client.started(id, processId); }
  });
  if (pid === null && result.spawned === false) await client.notStarted(id, result.error ?? 'Command bridge was not spawned');
  else if (!result.processGroupActive) await client.finished(id, result.status);
  else throw new Error('Project test command process group remains active');
  return result;
}
