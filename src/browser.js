import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { projectPath, processGroupAlive } from './util.js';

/** Resolve a scene URL: http(s) as-is, otherwise a project-contained file URL. */
export async function urlFor(root, value) {
  if (!value) throw new Error('Scene requires prototypeUrl and applicationUrl');
  if (/^https?:/.test(value)) return value;
  const parsed = new URL(value, pathToFileURL(`${path.resolve(root)}${path.sep}`));
  if (parsed.protocol !== 'file:') throw new Error(`Unsupported scene URL protocol: ${parsed.protocol}`);
  const canonicalRoot = await realpath(root);
  const target = await realpath(fileURLToPath(parsed));
  const validated = pathToFileURL(await projectPath(canonicalRoot, path.relative(canonicalRoot, target)));
  validated.search = parsed.search;
  validated.hash = parsed.hash;
  return validated.href;
}

/**
 * Launch Chromium as a supervised 'visual' phase: its PID/PGID is reported before work starts, and the whole group
 * must be gone before the phase completes. `work(browser)` returns the phase result ({ status, ... }).
 */
export async function superviseBrowser(outDir, { signal, onBeforeSpawn, onStart, onFinish } = {}, work) {
  if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
  if (process.platform === 'win32') return { status: 'NOT_RUN', reason: 'POSIX browser process-group supervision is required.', scenes: [], artifacts: [] };
  await mkdir(outDir, { recursive: true });
  let server, browser, pid = null, started = false, launchAttempted = false, result, failure, cleanupPromise, abortKill;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (!server) return;
    let closeError;
    const timer = setTimeout(() => { closeError ??= new Error('Visual browser close timed out; forcefully terminated its group'); server.kill().catch(() => {}); }, 5000);
    try { if (signal?.aborted) await (abortKill ?? server.kill()); else await server.close(); }
    catch (error) { closeError = error; }
    finally { clearTimeout(timer); }
    if (pid && processGroupAlive(pid)) {
      closeError ??= new Error('Visual browser closed with a surviving subprocess group; terminated the group and blocked advancement');
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Check the full group below. */ }
      const deadline = Date.now() + 2000;
      while (processGroupAlive(pid) && Date.now() < deadline) await delay(10);
    }
    if (closeError) throw closeError;
  })();
  const abort = () => {
    if (server) { abortKill ??= server.kill(); abortKill.catch(() => {}); cleanup().catch(() => {}); }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    started = true; await onBeforeSpawn?.('visual');
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    launchAttempted = true;
    // Playwright launches this POSIX child detached, so its PID is also its PGID.
    server = await chromium.launchServer({ timeout: 30000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    pid = server.process().pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Visual browser process identity is unavailable');
    await onStart?.('visual', pid);
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 10000 });
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    result = await work(browser);
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    try { await cleanup(); if (abortKill) await abortKill; } catch (error) { failure ??= error; }
    finally { signal?.removeEventListener('abort', abort); }
    const unknown = launchAttempted && (!Number.isSafeInteger(pid) || pid <= 0);
    const processGroupActive = unknown || (pid !== null && processGroupAlive(pid));
    const processResult = { status: failure || signal?.aborted || processGroupActive ? 'FAIL' : result?.status ?? 'FAIL', spawned: launchAttempted ? unknown ? null : true : false, processGroupActive, aborted: signal?.aborted ?? false, error: failure?.message ?? null };
    // An attempted launch without a PID cannot be proven finished. Leave STARTING durable.
    if (started && !unknown) await onFinish?.('visual', pid, processResult);
    if (processGroupActive) {
      const error = new Error(unknown ? 'Visual browser launch has unknown PID; inspect possible subprocesses before manual recovery' : 'Visual browser subprocess group remains active; stop it before further verification or repair');
      error.code = unknown ? 'PROCESS_START_UNKNOWN' : 'PROCESS_GROUP_ACTIVE'; error.phase = 'visual'; error.result = processResult;
      throw error;
    }
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    if (failure) throw failure;
  }
}

