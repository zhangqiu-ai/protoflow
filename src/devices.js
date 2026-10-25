import { link, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { hash } from './util.js';

/*
 * Simulators and emulators are machine-wide: two runners that drive the same one at once (two projects, or two targets
 * of one project) kill each other's XCUITest runs. A verification holds every device its commands name, from the first
 * command that needs one until it ends. Locks live under ~/.protoflow/devices (PROTOFLOW_DEVICE_LOCKS overrides it)
 * and are taken in arrival order, so a runner that verifies again right away cannot starve one that waits.
 */

/** The directory that holds one folder per device: `lock` (the holder) and `queue/` (one ticket per waiter). */
export const deviceLockDir = () => process.env.PROTOFLOW_DEVICE_LOCKS || path.join(os.homedir(), '.protoflow', 'devices');

/**
 * The devices a command names: its own `devices`, `--device X` and `--avd X` of the drivers, the `name=` or `id=` of an
 * xcodebuild `-destination` (never a generic one) and the serial of `adb -s X`. A command that reaches a device
 * through a script lists it in `devices`.
 */
export function commandDevices(command) {
  if (!command?.argv) return [];
  const argv = command.argv, found = [...(command.devices ?? [])];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') && argv[i].startsWith('--') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    const value = inline ?? argv[i + 1];
    if (typeof value !== 'string') continue;
    if (['--device', '--avd'].includes(flag)) found.push(value);
    else if (flag === '-destination' && !/(^|,)\s*generic\//.test(value)) {
      const named = value.split(',').map(part => part.trim().match(/^(?:id|name)=(.+)$/)).find(Boolean);
      if (named) found.push(named[1]);
    } else if (flag === '-s' && path.basename(argv[0]) === 'adb') found.push(value);
  }
  return [...new Set(found.map(item => item.trim()).filter(Boolean))].sort();
}

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const readHolder = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
/** A holder or ticket of a process that is gone; only processes of this host can be checked. */
const stale = holder => Boolean(holder) && holder.host === os.hostname() && !alive(holder.pid);
/** Files are written whole under a temporary name first, so a reader never sees half a holder. */
const writeWhole = async (file, data) => { const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(data)); return temporary; };

/**
 * Take every device in `devices` (sorted, so two verifications never wait on each other) and return a release
 * function. `holder` says who holds them (project, target, manifestId, phase). `onWait({ device, holder })` is called
 * once each time the device it waits for is held by someone else; an aborted signal leaves the queue and throws.
 */
export async function acquireDevices(devices, holder, { signal, onWait, pollMs = 2000, dir = deviceLockDir() } = {}) {
  const held = [];
  const release = async () => { for (const lock of held.splice(0).reverse()) await lock.release(); };
  try {
    for (const device of [...new Set(devices)].sort()) held.push(await acquire(device, holder, { signal, onWait, pollMs, dir }));
  } catch (error) { await release(); throw error; }
  return release;
}

async function acquire(device, holder, { signal, onWait, pollMs, dir }) {
  const folder = path.join(dir, hash(device).slice(0, 24));
  await mkdir(path.join(folder, 'queue'), { recursive: true });
  const token = `${Date.now().toString().padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const record = { ...holder, device, token, pid: process.pid, host: os.hostname(), since: new Date().toISOString() };
  const ticket = path.join(folder, 'queue', `${token}.json`), lockFile = path.join(folder, 'lock');
  await rename(await writeWhole(ticket, record), ticket);
  let seen = null;
  try {
    for (;;) {
      if (signal?.aborted) { const error = new Error(`STOPPED: waiting for device ${device} was interrupted`); error.code = 'RUNNER_STOPPED'; throw error; }
      // Tickets of processes that died while waiting would block the queue for ever.
      const queue = [];
      for (const name of (await readdir(path.join(folder, 'queue')).catch(() => [])).filter(item => item.endsWith('.json')).sort()) {
        const waiter = await readHolder(path.join(folder, 'queue', name));
        if (name !== `${token}.json` && stale(waiter)) await rm(path.join(folder, 'queue', name), { force: true });
        else queue.push({ name, waiter });
      }
      let current = await readHolder(lockFile);
      if (current && stale(current)) { await rm(lockFile, { force: true }); current = null; }
      if (!current && queue[0]?.name === `${token}.json`) {
        // link() fails when the lock exists, so only one waiter takes it, and it appears with its whole content.
        const temporary = await writeWhole(lockFile, { ...record, acquiredAt: new Date().toISOString() });
        try {
          await link(temporary, lockFile);
          await rm(ticket, { force: true });
          return { release: async () => { if ((await readHolder(lockFile))?.token === token) await unlink(lockFile).catch(() => {}); } };
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await rm(temporary, { force: true }); }
      }
      const blocker = current ?? queue[0]?.waiter;
      if (blocker && blocker.token !== token && seen !== blocker.token) { seen = blocker.token; await onWait?.({ device, holder: blocker }); }
      try { await delay(pollMs, undefined, { signal }); } catch { /* the loop reports the stop */ }
    }
  } catch (error) { await rm(ticket, { force: true }); throw error; }
}

/** Who a device holder is, for messages: "project/target (manifest, phase)". */
export const describeHolder = holder => `${holder?.project ?? 'another project'}${holder?.target ? `/${holder.target}` : ''}${holder?.manifestId ? ` (${holder.manifestId}${holder.phase ? `, ${holder.phase}` : ''})` : ''}`;
