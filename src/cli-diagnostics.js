/*
 * Imported first by bin/protoflow.js. Node runtime warnings (for example the FORCE_COLOR/NO_COLOR notice emitted
 * while built-in modules load) are held and written as `ProtoFlow diagnostic:` lines before the CLI's final output,
 * so stdout stays pure JSON and the last stderr line of a failure is always its JSON error.
 */
const pending = [];
process.removeAllListeners('warning');
process.on('warning', warning => pending.push(`${warning.name}: ${warning.message}`));

export function flushDiagnostics() {
  for (const line of pending.splice(0)) process.stderr.write(`ProtoFlow diagnostic: ${line}\n`);
}
// Warnings raised after the final output are still reported rather than lost.
process.on('exit', flushDiagnostics);
