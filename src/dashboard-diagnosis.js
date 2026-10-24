import { transientFailure } from './delivery-scope.js';

/**
 * Why something is blocked, in a person's terms: a known failure text (an expired login, a quota, the network, a full
 * disk...) becomes what to do before retrying. Unknown texts give null; the dashboard always shows the raw reason too.
 * Steps mark commands and config keys with backticks.
 */
const SERVICE = '`protoflow runner service uninstall` → `protoflow runner service install`';
const login = text => {
  if (/gh auth login|GitHub CLI|api\.github\.com|Bad credentials|\bgh\b/i.test(text)) return { who: 'GitHub CLI', command: 'gh auth login', check: 'gh auth status' };
  if (/codex/i.test(text)) return { who: 'Codex', command: 'codex login', check: null };
  return { who: 'Claude', command: 'claude', then: '在 Claude Code 裡輸入 `/login`', check: null };
};
const RULES = [
  { kind: 'auth', test: /OAuth|session expired|not logged in|log ?in again|Failed to authenticate|authentication (failed|required)|invalid (x-)?api[ -]?key|\b401\b|Unauthorized|Bad credentials/i,
    make: text => { const who = login(text); return { title: `${who.who} 登入失效`, steps: [`在終端機執行 \`${who.command}\`${who.then ? `，${who.then}` : ''}，以 Runner 服務同一個使用者重新登入`, ...(who.check ? [`以 \`${who.check}\` 確認已登入`] : []), '回到這裡重試'], command: who.command }; } },
  { kind: 'quota', test: /rate.?limit|usage limit|quota|\b429\b|Too Many Requests|credit balance|overloaded/i,
    make: () => ({ title: '額度或速率限制', steps: ['等額度恢復再重試，通常幾分鐘到數小時', '經常發生時，在 `policy.executor.fallback` 設定備援執行者'], command: null }) },
  { kind: 'disk', test: /ENOSPC|No space left on device/i,
    make: () => ({ title: '磁碟空間不足', steps: ['清出磁碟空間', '以 `protoflow runner gc` 列出可清理的舊 worktree，確認後加 `--apply`', '回到這裡重試'], command: 'protoflow runner gc' }) },
  { kind: 'network', test: transientFailure,
    make: () => ({ title: '網路或代理連線失敗', steps: ['確認網路與代理可用', `代理設定改過時，以 ${SERVICE} 讓服務帶入新的代理變數`, '回到這裡重試'], command: null }) },
  { kind: 'missing-tool', test: /spawn \S+ ENOENT|command not found|No such file or directory.*\b(git|gh|claude|codex|node|npm|xcodebuild|gradle)\b/i,
    make: () => ({ title: '找不到需要的命令', steps: ['確認工具已安裝並能在終端機執行', `Runner 服務使用安裝時解析的絕對路徑，新裝或搬移工具後以 ${SERVICE} 重新解析`, '回到這裡重試'], command: null }) },
  { kind: 'not-configured', test: /adapter is not configured|is not configured|Missing config/i,
    make: () => ({ title: '缺少設定', steps: ['依錯誤訊息補上 `protoflow.config.json` 的設定（例如 `adapters.<name>.command`）', `服務已在執行時，以 ${SERVICE} 套用`, '回到這裡重試'], command: null }) },
  { kind: 'timeout', test: /timed out|timeout|SIGTERM|SIGKILL/i,
    make: () => ({ title: '執行超時', steps: ['看終端機最後的動作，找出卡住的步驟', '工作本來就需要更久時，調高對應 adapter 的 `command.timeoutMs`', '回到這裡重試'], command: null }) },
  { kind: 'permission', test: /EACCES|permission denied|\b403\b|Resource not accessible|must have (push|admin|write) access/i,
    make: () => ({ title: '權限不足', steps: ['確認檔案權限，或 GitHub 帳號對這個 repo 有寫入權限（`gh auth status`）', '回到這裡重試'], command: 'gh auth status' }) },
  { kind: 'conflict', test: /merge conflict|\bCONFLICT\b|non-fast-forward|not fast-forward|diverged/i,
    make: () => ({ title: '分支衝突', steps: ['在交付分支上解決衝突，或讓基準分支與交付分支重新對齊', '回到這裡重試'], command: null }) }
];

/** A runner reasonCode decides first; an environment block still tells a login from the network by its text. */
const BY_CODE = {
  environment: text => (RULES.find(rule => rule.kind === 'auth').test.test(text) ? RULES.find(rule => rule.kind === 'auth') : RULES.find(rule => rule.kind === 'network')),
  stalled: () => ({ kind: 'stalled', make: () => ({ title: '修復沒有進展', steps: ['看最後兩次驗收的失敗項，判斷是應用真的做不到，還是驗收誤判', '是驗收誤判時回報 ProtoFlow；是需求或原型的問題時先修改原型', '處理後重試；要放寬判定可調高 `policy.stallRounds`（0 為關閉）'], command: null }) }),
  'repair-limit': () => ({ kind: 'repair-limit', make: () => ({ title: '修復次數用完', steps: ['看最後一次驗收的失敗項與執行紀錄', '處理後重試；需要更多次自動修復時調高 `policy.maxRepairAttempts`'], command: null }) }),
  'base-moved': () => ({ kind: 'base-moved', make: () => ({ title: '基底分支已移動', steps: ['先合併或關閉尚未處理的交付 PR', '要放棄未交付的版本、在目前的基底重新開始時，執行 `protoflow runner rebase`', '回到這裡重試'], command: 'protoflow runner rebase' }) })
};
export function diagnose(text, reasonCode = null) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const coded = BY_CODE[reasonCode]?.(text);
  if (coded) return { kind: coded.kind, ...(reasonCode === 'environment' && { reasonCode }), ...coded.make(text) };
  for (const rule of RULES) {
    if (typeof rule.test === 'function' ? rule.test(text) : rule.test.test(text)) return { kind: rule.kind, ...rule.make(text) };
  }
  return null;
}
