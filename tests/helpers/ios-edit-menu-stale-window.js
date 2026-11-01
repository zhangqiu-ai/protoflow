import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const sourceURL = new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url);
const fixtureURL = new URL('../fixtures/ios-edit-menu-stale-window.swift', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Exercises actual SDK Swift methods using Foundation query shims, never a Simulator or an App. */
export async function runStaleWindowModel({ outputDirectory } = {}) {
  const source = await readFile(sourceURL, 'utf8');
  const start = '    private func fieldValue(', end = '    /// Typing can drop';
  if (source.split(start).length !== 2 || source.split(end).length !== 2 || source.indexOf(start) >= source.indexOf(end)) {
    throw new Error('one actual SDK public-input method region is required');
  }
  const helpers = source.slice(source.indexOf(start), source.indexOf(end));
  const fixture = await readFile(fixtureURL, 'utf8'), marker = '    // ACTUAL_SDK_PUBLIC_INPUT_HELPERS';
  if (fixture.split(marker).length !== 2) throw new Error('one Foundation fixture insertion point is required');
  const directory = outputDirectory ?? await mkdtemp(path.join(tmpdir(), 'protoflow-edit-menu-refresh-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonical = await realpath(directory), file = path.join(canonical, 'main.swift'), binary = path.join(canonical, 'protocol');
  await writeFile(file, fixture.replace(marker, helpers), { mode: 0o600 });
  let build;
  try {
    build = await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
  } catch (error) {
    await writeFile(path.join(canonical, 'compile.log'), (error.stdout ?? '') + (error.stderr ?? ''), { mode: 0o600 });
    throw new Error(`Foundation fixture compilation failed; see ${path.join(canonical, 'compile.log')}`, { cause: error });
  }
  await writeFile(path.join(canonical, 'compile.log'), build.stdout + build.stderr, { mode: 0o600 });
  let result;
  try { result = { ...await exec(binary, [], { timeout: 5000 }), code: 0 }; }
  catch (error) {
    if (error.code !== 1) throw error;
    result = { stdout: error.stdout, stderr: error.stderr, code: 1 };
  }
  await writeFile(path.join(canonical, 'result.json'), result.stdout, { mode: 0o600 });
  if (await readFile(sourceURL, 'utf8') !== source) throw new Error('SDK source changed during Foundation verification');
  const report = { ...JSON.parse(result.stdout), sourceSha256: digest(source), sourcePath: await realpath(sourceURL),
    exitCode: result.code, outputDirectory: canonical };
  await writeFile(path.join(canonical, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
