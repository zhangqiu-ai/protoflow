#!/usr/bin/env node
// Decides whether a CI run needs the code checks: documentation-only changes skip them.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Markdown anywhere and everything under docs/ are documentation; any other path needs the code checks. */
export function needsCodeChecks(files) {
  if (!files.length) return true; // Unknown range (new branch, forced history): run everything.
  return files.some(file => !(file.startsWith('docs/') || file.endsWith('.md')));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  let files = [];
  if (base && !/^0+$/.test(base)) {
    try { files = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch { files = []; }
  }
  const code = needsCodeChecks(files);
  console.log(`${files.length} changed file(s); code checks: ${code}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
}
