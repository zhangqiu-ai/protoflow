import path from 'node:path';
import { runCommand } from './util.js';

/** Why a blocked version waits, in the words the dashboard uses. */
const REASON = {
  environment: '環境問題（登入、網路或建置環境），修好後重試',
  stalled: '修復沒有進展',
  'repair-limit': '修復次數用完',
  'needs-human': '規劃代理需要人決定',
  execution: '執行代理失敗',
  'not-run': '驗收無法執行',
  'base-moved': '基底分支已移動'
};

/**
 * The desktop notification for a runner event that needs a person: a version that blocked, an issue fix that blocked,
 * an issue a maintainer decides or a waiver request (proposal 0005). Other events give null.
 */
export function notificationFor(event, project) {
  const where = event.target ? `${project} · ${event.target}` : project;
  const first = text => String(text ?? '').split('\n')[0].slice(0, 160);
  if (event.event === 'blocked') return { title: `ProtoFlow · ${where}`, subtitle: `版本阻塞：${REASON[event.reasonCode] ?? '需要處理'}`, message: first(event.reason) };
  if (event.event === 'issue-blocked') return { title: `ProtoFlow · ${where}`, subtitle: 'Issue 修復阻塞', message: first(event.reason) };
  if (event.event === 'waiver-requested') return { title: `ProtoFlow · ${where}`, subtitle: '豁免待核准', message: first(`${event.scene}${event.variant ? ` / ${event.variant}` : ''} · ${event.tier}：${event.findings} 項發現，執行代理標示為引擎限制`) };
  if (event.event === 'issue-triaged' && event.status === 'needs-human') return { title: `ProtoFlow · ${where}`, subtitle: `Issue #${event.number} 需要人決定`, message: '' };
  return null;
}

/**
 * Post the notification on macOS (osascript), unless `notifications.desktop` is false. Best-effort: a failure never
 * stops the runner. Test processes (NODE_TEST_CONTEXT) never post to the person's desktop.
 */
export async function notifyDesktop(root, config, event, { run = runCommand, platform = process.platform, env = process.env } = {}) {
  if (config.notifications?.desktop === false || platform !== 'darwin' || env.NODE_TEST_CONTEXT) return null;
  const note = notificationFor(event, config.dashboard?.name ?? path.basename(root));
  if (!note) return null;
  // The texts are passed as arguments, never spliced into the AppleScript source.
  const argv = ['osascript', '-e', 'on run argv', '-e', 'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)', '-e', 'end run', note.title, note.subtitle, note.message];
  try { await run(root, { argv, timeoutMs: 10000 }); } catch { /* notifications are advisory */ }
  return note;
}
