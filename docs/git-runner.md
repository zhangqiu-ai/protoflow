# Git 提交驅動的本機 Runner

正式應用的觸發來源是 GitHub 原型分支的新提交。Runner 不監聽本機 prototype 檔案；Skill 提供接入與操作指引，持續執行由前景 Node.js Runner 負責。

## 接入既有專案

在共享 ProtoFlow checkout 執行 `npm ci`、`npx playwright install chromium`。可直接用 `node /absolute/shared/protoflow/bin/protoflow.js`，或安裝本機 npm package 的 CLI。目標專案需有 Git HEAD，先保留並檢查現有工作，再執行：

```sh
protoflow init --project /path/to/app \
  --repository https://github.com/owner/design.git \
  --branch prototypes --path prototype \
  --start-sha EXACT_40_CHARACTER_BASE_COMMIT
protoflow install --project /path/to/app --skip-integrations
```

`init` 寫入 Git source 與內建 Codex adapter 的共享絕對路徑，保留既有設定。既有專案已配置時，由開發者明確將以下欄位合併至設定；不要期待重跑 init 覆寫設定。將 `.protoflow/` 加入 `.gitignore`，填好 mappings、build、Node.js Playwright functional 與 visual scenes。完整範例見 `templates/protoflow.git.config.json`。

```json
{
  "source": {
    "kind": "git",
    "repository": "https://github.com/owner/design.git",
    "branch": "prototypes",
    "path": "prototype",
    "startSha": "EXACT_40_CHARACTER_BASE_COMMIT"
  },
  "runner": {
    "pollMs": 15000,
    "applicationRef": "HEAD",
    "setup": {"argv": ["npm", "ci"], "timeoutMs": 600000}
  }
}
```

`startSha` 是已知設計基準，從它之後逐筆取得 first-parent 提交；基準可尚未包含原型目錄。省略時首次只接入 branch tip，之後逐筆追蹤新提交。GitHub HTTPS 與 SSH URL 使用既有 Git 登入；設定不能內嵌 token。絕對本機 Git 路徑只供 fixture／離線開發，驗收報告必須明確區分它與實際 GitHub 提交。

## 執行與恢復

```sh
protoflow doctor --project /path/to/app
protoflow source scan --project /path/to/app
protoflow queue --project /path/to/app
protoflow runner start --project /path/to/app --once
# 持續輪詢：省略 --once；Ctrl+C 停止
protoflow runner status --project /path/to/app
# 檢查並解決失敗／中斷原因後，明確允許重試當前版本：
# 若是 adapter 或驗證設定錯誤，先修改設定並明確綁定新的設定：
protoflow runner configure --project /path/to/app
protoflow runner retry --project /path/to/app
protoflow runner start --project /path/to/app --once
```

`doctor` 檢查本機 Git HEAD、來源設定格式、Codex CLI、驗證設定、Chromium 與已安裝 Skill。它不呼叫 provider 或代替實際來源 fetch／登入驗收。`source scan` 與 `runner start` 實際 fetch，失敗會保存原因；離線時已凍結版本仍可處理。重新連線後依 durable scannedSha 補抓。`--once` 掃描一次並處理目前所有待辦，遇 BLOCKED／NOT_RUN 立即停止；沒有新版本不重跑 Codex。一般 start 每 15 秒掃描；不安裝開機服務。

每個來源提交先保存完整子目錄（HTML、CSS、腳本、二進位素材），固定 SHA、content hash、diff 與 mapping，再發布 deterministic manifest。掃描 cursor 逐筆原子更新；無原型變更的提交只更新 scannedSha。資源必須位於同一子目錄，靜態 HTML/CSS/JS 引用（含 srcset、poster、inline module／importmap）的缺失或可變 URL 資源會報錯；不下載第三方 CDN 或猜測子目錄外依賴。資源 URL 明確拒絕反斜線與 C0／DEL 控制字元，避免瀏覽器 URL 正規化與 POSIX 檔名語義不同；HTML 資源／CSS 屬性與 srcdoc 只支援一次解碼的 `amp`、`quot`、`apos`、`lt`、`gt`、`colon`、`Tab`、`NewLine` 具名 entity，以及數字 entity，其他完整 `&name;` 形式保守拒絕；解碼後的控制字元仍拒絕。`&amp;sol;` 只變成字面 `&sol;`，不二次解碼；普通 onclick 的 `&&` 不受 entity gate 影響。snapshot 限制每檔 2 MiB、總計 20 MiB、1000 檔；symlink／submodule 報錯。 MVP 未包含完整 JS module parser：inline module／importmap、script／iframe／embed／object 的可執行 data: 資源一律拒絕，普通 image data: 可保留；JS 檔與普通 inline script 的 import 語法（包括插入註解、動態 import）與 re-export（`export * from`、`export { … } from`）也保守拒絕，需提供已打包且無模組載入語法的 vendored script；script src／href 僅接受 UTF-8 文字的本地 .js／.mjs／.cjs，副檔名不分大小寫，未知格式或非 UTF-8 腳本會拒絕。 所有 UTF-8 檔中的 `xml-stylesheet` processing instruction 未支援，一律阻塞，需改用已凍結的 CSS link；`.xml`／`.xhtml`／`.xht` 文件全局拒絕，即使未被引用或直接作為場景。iframe／embed／object 僅支援已稽核的本地 `.html`／`.htm`／`.svg` 文件，不接受其他副檔名、二進位圖片，或以 `type` 宣告繞過限制。帶 namespace prefix 的 XML／SVG element（例如 `s:image`）也拒絕；普通無前綴 SVG 與 `xlink:href` attribute 仍支援。script／style 必須有 canonical closing tag 才能稽核 body，缺少結尾直接阻塞；以第一個 tag name 後接 ASCII 空白、`/` 或 `>` 的 closing prefix 為準，若有額外 attribute／slash 等非 canonical 形式就拒絕，不越過它尋找較後的結尾。所有 script body（含 JSON data block 與帶 src）中的 `<!--` escaped 狀態未支援，一律拒絕。起始 tag 無法完整稽核時保守拒絕，不支援瀏覽器容錯修補的 malformed markup；quoted attribute 及已稽核的普通 HTML script／style body 會完整跳過，不把其中的 `<` 比較式當成 tag。SVG 文件或含 `<svg>` 的 HTML 中，script／style body 的資源子標記（含 namespace prefix）保守拒絕，不能當作 HTML raw text 略過；此限制套用該文件全部 script／style，可能拒絕其中只作字串的資源標記。SVG／混合文件的 script body 先按上述 entity subset 解碼再稽核 JS；style body 同樣解碼稽核，普通 `&&` 與非資源 `<b` 比較式仍可使用。資源存在檢查只接受 snapshot 自有檔案，`constructor`／`toString` 等 Object prototype 名稱不能代替缺失資源。`meta http-equiv="refresh"` 自動導頁未支援，即使本地目標也一律拒絕。HTML／CSS／SVG 同樣必須是 UTF-8，不能當 binary 略過資源稽核；真正圖片等二進位素材照常凍結。stylesheet link 與 CSS @import 僅接受已稽核的本地 `.css` 文字文件，不接受未知副檔名或以 MIME type 繞過。CSS url／@import 使用同一掃描器，完整保留引號內空格；不支援的 escape 或無法解析的 URL／import 會保守拒絕。檢查可能因字串或註解內的 `import` 關鍵字而拒絕（文案中的「export … from」不會被視為 re-export）；它保證上述靜態形式不會略過，不能證明任意 runtime fetch、eval 或其他計算式網路行為已凍結。 不透明的 `@import data:` 與 `image()`、`image-set()`、`-webkit-image-set()`、`src()` 等未支援資源函式也會阻塞；一般自包含圖片／字型的 `url(data:...)` 可保留。

掃描採 branch first-parent 歷史，merge 視為一個整合版本。既有 cursor 不再位於該鏈（rewind、force push 或改接歷史）會保存 `HISTORY_REWRITTEN` 並停止，不能跳過。source repository／branch／path／startSha 一旦產生進度即固定；更換來源需由開發者備份並另行初始化狀態，MVP 不自動刪除／重置既有證據。

應用在 `.protoflow/runner/worktree-<source-hash>` 的獨立本機分支實作。初始內容從目前主 checkout 複製，包含使用者尚未提交修改，但不複製 Git 忽略的檔案（建置產物、`.env` 等由 setup 重建）；指向專案外的已追蹤 symlink 隨 checkout 保留，但不碰主 checkout、index 或 HEAD；之後所有版本延續同一隔離 worktree。`runner.setup` 在此安裝依賴；server 類專案需自行提供可重複 setup／build／functional 命令及可用 visual URL，Runner 不猜測 server 命令。引擎與目標專案都不自動 commit、push、合併或發布；結果供開發者 review 後自行移交。

每版呼叫真實配置的執行者 adapter（Codex，或 `policy.executor` 指定的 Claude），獨立跑 build → Playwright functional → frozen visual。配置 `adapters.planner` 時，版本每次開始執行前先由唯讀 Claude session 規劃（發出 `planned` 事件、entry 記錄 `planId`），方案進入每個 attempt 的 context；規劃者回答 `needs-human` 時版本 BLOCKED，規劃失敗則記錄 `planError`、發出 `plan-failed` 並照常實作（見 [integrations](integrations.md#claude-規劃者提案-0003)）。全部 PASS 才更新 completedSha 並前進。修復最多 `policy.maxRepairAttempts` 次；每次記錄 context、execution 與 verification。執行代理因供應端暫時問題失敗（模型滿載、限流、429／5xx、服務暫時不可用、串流中斷）時，同一個 attempt 以新 context 自動重試，最多 `policy.transientRetries` 次（預設 3，上限 5），間隔 `policy.transientRetryDelayMs`（預設 60000）起倍增；每次重試記在 attempt 的 `transientRetries` 並發出 `execute-retry` 事件，不計入修復次數。每次執行與驗證結束後，Runner 以 `lsof` 找出工作目錄仍在 Runner worktree 內的程序並終止（先 SIGTERM，3 秒後 SIGKILL），記在 attempt 的 `leftoverProcesses` 並發出 `leftover-processes` 事件：執行代理的沙箱會把命令放進自己的程序群組，實測中被終止的 Codex 留下的 Gradle 建置又下載了 40 分鐘。模擬器與 iOS 模擬器服務不在此列（Android SDK `emulator/` 目錄下的所有程式，包括 qemu、`netsimd`、`crashpad_handler`）；Android 驅動器也改以家目錄啟動模擬器。其他執行失敗（非零結束、adapter 逾時）與重試用盡的情況，算作一次失敗的 attempt：在 `maxRepairAttempts` 內進入下一輪，請求的 `repair.execution` 帶上失敗的 executionId、結束碼、是否逾時與原因（發出 `execute-failed` 事件）；用盡後才 BLOCKED。實測中執行代理在沙箱內處理 Gradle 超過 30 分鐘被 adapter 逾時終止，舊版本因此直接 BLOCKED。L2 需 `runner.spec` 的已核對規格，L3 還需 `runner.adr` 綁定當版 manifestHash 的人類決策；缺少即阻塞。配置變更後已有 worktree 會拒絕自動沿用。停止後可用 `runner configure` 明確更新操作設定，保存前後 config hashes 與原設定，保留應用修改與所有 attempts；target 有尚未結案的交付時不改寫該 worktree 的 `protoflow.config.json`（`configSync: "deferred"`），因為已審查的 tree 綁定 worktree 的位元組，變更改由 base 帶入並在整合時 reverify；source／prototypeDir／mapping id 和 prototypeFiles 所有權不能變。再 `runner retry` 恢復當前版本。

**以後續版本取代卡住的版本**：版本 BLOCKED 的原因是原型本身有錯時，修原型只會產生排在它後面的新版本，而 Runner 依序推進，修正永遠輪不到。確認後面的原型版本修好了以後，停在 BLOCKED（或 STOPPED）時由人執行 `runner supersede`：卡住的版本與它之後的所有版本合併成最新那一版，最新版的 manifest 以卡住版本的起點重新計算，範圍與分級涵蓋全部合併的變更（manifest 的 `supersedes` 列出被取代的版本）；被取代的版本退出佇列，manifest 與進度保存在 `.protoflow/superseded/<時間>/` 與 source state 的 `superseded`，事件時間線記一筆 `superseded`（被取代的版本、合併到的版本與存檔位置）。Runner worktree 保留，下一次 `runner start` 在既有實作上重新規劃、修正與驗收；L3 版本要先把 ADR 綁定到結果回報的 `manifestHash`。目前只支援單一 target；已接受的版本不能被取代。

**以目前引擎重新分級**：版本的 L0–L3 在掃描凍結時就寫入 manifest，之後引擎修正分級規則，已凍結的版本不會跟著改，`runner retry` 也只重跑同一份 manifest。舊引擎誤判等級、讓版本卡在不需要的 `--spec` 或 ADR 時，停在 BLOCKED（或 STOPPED）且 Runner 未在執行時，由人執行 `runner reclassify`：以同一份凍結原型與前一版為基準重新分級並重建 manifest，原型內容或基準和原 manifest 不符時拒絕；目前引擎判出相同等級時不做任何變更。舊 manifest 移到 `.protoflow/reclassified/<時間>/`，新 manifest 帶 `reclassified`（新舊等級、舊 manifestHash、引擎版本），source state 的 `reclassified` 保存原 entry 與其 attempts，事件時間線記一筆 `reclassified`；版本回到 PENDING，Runner worktree 保留。目前只支援單一 target。常駐服務整個迴圈持有專案鎖，需先 `runner service uninstall`，完成後再 `runner service install`。

**基底移動後重新開始**：單一 target 的交付是對當下的遠端基底審查的。Runner 每個版本開始執行（含規劃）前，先比對 runner worktree 與 `runner.delivery.baseBranch` 的最新提交：基底已在 worktree 中就照常執行；有人在上次交付合併後又提交到基底，而 worktree 的提交全都在基底裡、也沒有其他未提交的應用變更時，先快轉到最新基底再執行（發出 `base-aligned` 事件）；worktree 還有基底沒有的提交或變更時，版本在執行前就 BLOCKED（發出 `base-moved` 事件），原因寫明落後的基底與未交付的內容，不會等到交付審查才發現；遠端暫時讀不到時只發出 `base-check-failed` 事件並照常執行，交付前仍會再核對基底。多 target 仍在交付時整合或重新驗收。已經卡住的情況（例如交付因「Current remote base is not an ancestor」被擋）由人執行 `runner rebase`：所有未發布、未結案的交付改為 REVOKED（`revocation` 記錄原因、舊基底與新基底），worktree 的提交與未提交（未被忽略）的檔案保存在 `refs/protoflow/rebased/<時間>` 這個存檔 ref，worktree 重設到目前的基底；這些交付涵蓋的版本、已接受但尚未交付的版本與目前的版本回到 PENDING 並從頭執行，原 entry 與其 attempts 保存在 source state 的 `rebased`，事件時間線記一筆 `rebased`。已推送或已有 PR 的交付、仍開著的手動合併 PR、或已合併的交付不在基底中（基底被改寫）時拒絕。目前只支援單一 target；常駐服務需先 `runner service uninstall`，完成後再 `runner service install`。

正常停止會終止當前 subprocess group、保存 STOPPED；下一次 start 不擅自重試。setup、Codex、build／functional 與 visual Chromium 在 spawn 前先保存 STARTING／pid:null 意圖，再保存 PID／PGID 與完成時間；正常返回且能證明 spawned:false（例如 ENOENT 或 spawn 前取消）的意圖可記錄已完成，仍可重新配置／重試；PID 尚未落地時崩潰，未知 PID 會保守阻止自動恢復，需人工檢查可能留下的程序；確認後以 `runner retry --recover-unknown-start` 恢復：引擎先以 `lsof`（工作目錄）與 `ps`（命令列）確認沒有存活程序位於或引用該 Runner worktree，有則拒絕並列出 PID；確認無誤才把當前版本中沒有 PID 的啟動意圖記為 `NOT_STARTED`，並在意圖與 `retries` 保存檢查時間、方法與 worktree。此旗標不處理已有 PID 的程序，也不處理其他版本；`lsof` 不可用或輸出不完整時拒絕。執行代理若把子程序放到 worktree 之外的工作目錄，此檢查看不到它們，仍需人工判斷。反過來，Xcode 的 `DTServiceHub` 等系統輔助程序會脫離程序群組、以 worktree 為工作目錄長期存活，也會讓復原被拒；確認不是執行代理後終止它再重試。Visual 透過 Playwright BrowserServer 保存 browser PID／PGID，停止時關閉或終止整組並確認結束；launch 已嘗試但未取得 PID 的錯誤也保留未知啟動意圖，不能自動略過。POSIX 恢復檢查整個 subprocess group；leader 已死而 child 仍活也會阻止 retry／setup。命令正常退出但同組程序未退出時會終止該組並記錄 FAIL，不能 PASS 前進；尚未確認全組結束就不寫完成時間。 若 processGroupActive 仍為 true，立即阻塞，不能啟動後續 functional／visual、repair 或新 Codex；每次新 attempt 前也重新檢查舊的未完成程序，保留其 phase／PID／失敗證據。Windows 無法確認整個程序樹，MVP 保守拒絕受監督命令的自動執行／恢復；命令不得自行 detached／轉移子程序 group，這些形式不在 MVP 的自動恢復保證內。異常退出的 RUNNING 同樣需 `runner retry`，避免重複執行者；死 PID 的本機鎖可恢復，活躍或缺少 owner 的鎖拒絕略過。若 PASS verification 已落地但 completedSha 尚未更新，retry 後會核對 application/frozen/artifact hashes 再復原完成記錄。

### 回收 runner worktree

Runner 為每條來源路由（多目標時每個 target）保留一個 `.protoflow/runner/worktree-*`。來源、target 或驗收路線改變後，舊 worktree 不會被自動刪除。`protoflow runner gc` 列出本專案登記在 `git worktree list` 中、位於 `.protoflow/runner/worktree-*` 的 worktree 及大小，分為：

| 分類 | 條件 | `--apply` |
|---|---|---|
| `active` | 目前配置的某個 stream 的 runner state 指向它 | 保留 |
| `unsafe` | 未被使用，但有未提交改動、被 `git worktree lock` 鎖定、引用它的舊 state 仍是 RUNNING／INITIALIZING，或 setup 程序組仍存活 | 保留並列出原因 |
| `stale` | 未被使用且乾淨 | 先將其 `.protoflow`（不含 `node_modules`）封存到 `.protoflow/runner/archive/<名稱>-<時間>.tar.gz`，再 `git worktree remove`（不加 `--force`） |
| `missing` | 目錄已不存在 | `git worktree prune` |

本地 runner 分支只在其提交已被其他 branch、tag 或 remote-tracking ref 包含時刪除；否則保留並註明「its commits exist only on this branch」，worktree 移除不會遺失提交。不帶 `--apply` 時只讀，不取得鎖；`doctor` 的 `runner worktrees` 檢查顯示可回收的數量與大小。主 checkout 與 `.protoflow/runner` 以外的 worktree 一律不處理。

## 多目標（schemaVersion 2）

`targets` 有多筆時，Runner 對每個 target 維護獨立進度（`.protoflow/targets/<id>/progress.json`）、Runner 狀態（`.protoflow/runner/<id>/state.json`）、worktree（`worktree-<hash>-<id>`）與交付分支（`<runner.delivery.branch>/<id>`）。`runner start` 依序推進每個 target；某個 target BLOCKED 時，其他 target 繼續，`runner retry --target <id>` 只恢復該 target。`runner status`、`queue`、`delivery status` 顯示每個 target 的狀態。多目標時共享的 `.protoflow/source/state.json` 只是掃描紀錄：其 entries 的 `status` 停在掃描時的 `PENDING`、`completedSha` 不更新，真正進度在各 target 的 progress。因此 `runner status`（以及 `doctor` 的 `progress`、`source status`）不直接顯示該欄位：`source.statusBasis` 為 `"targets"`，每筆 entry 的 `status` 由各 target 合成（全部 PASS 為 `PASS`；任一 target `BLOCKED`／`STOPPED`／`RUNNING` 依此優先序顯示；只有部分 target PASS 為 `PARTIAL`；否則 `PENDING`），`targets` 列出各 target 的狀態，`recordedStatus` 保留檔案中的原值；`source.completedSha` 是所有 target 都已 PASS 的最新版本。`targets.<id>.summary` 摘要該 target 的 `status`（第一個未 PASS 版本的狀態，全部 PASS 時為 `IDLE`）、`completedSha`、`current` 與各狀態計數，`progress`／`runner` 仍是完整紀錄。這些只是讀取時的呈現，不改寫狀態檔；PASS 表示 verification 已接受，交付是否完成以 `delivery status` 為準。單一 target 與 schemaVersion 1 的輸出不變；`release.requireTargets` 的 `release.version` 是所有必要 target 都已完成的最新版本（依 checkpoint 順序取各 target 的共同前綴）。未啟用 `runner.delivery` 時「完成」指 verification 已接受（`release.basis: "verification"`）；啟用 `runner.delivery` 時（`release.basis: "delivery"`），該 target 的版本還必須已由交付完成：紀錄為 `MERGED`，或 `merge: "manual"` 下已交給人處理的 `PR_OPEN_MANUAL`。交付 BLOCKED／FAIL、尚未建立 PR 或已 `REVOKED` 的版本不計入 release；各版本的 `acceptance` 欄位仍只反映 verification。啟用 `runner.delivery` 時，每個 target 的交付各自需要獨立 AI review PASS（見下方自動交付）。單一 target 專案沿用原有檔案與路徑。

## CLI 輸出契約

stdout 只放結果 JSON（`runner start` 先輸出 JSONL 事件，最後是結果）；失敗時 stderr 最後一行是 JSON 錯誤，之前的行是提醒或 `ProtoFlow diagnostic:` 診斷。巡查或其他程式解析輸出時應依此規則，不要把整段 stderr 當 JSON。Node 執行期警告（例如同時設定 `FORCE_COLOR` 與 `NO_COLOR`，Node 24 在連結內建模組時就會發出）也一律轉成 `ProtoFlow diagnostic:` 行；Node 22 與 24 行為一致。

## 證據與順序

`.protoflow/source/state.json` 保存 scannedSha、completedSha、ordinal、每版狀態與 attempts；`.protoflow/runner/state.json` 保存 worktree、初始 application SHA／hash、branch、設定 hash。原型 checkpoint 使用既有 `.protoflow/manifests/` 與 `.protoflow/versions/`。執行的完整 JSONL／stderr 位於 worktree `.protoflow/contexts/EXEC-*.json`；主 checkout 與 worktree 均保留 verification、按 verification ID 分開的 PNG／diff／HTML 報告，綁定 manifestHash、prototypeHash、application hash 與來源 SHA。application hash 排除 prototype、`RUNTIME_DIRS` 與 checkout 中 Git 忽略的未追蹤檔；已追蹤檔即使符合忽略規則仍計入。非 Git 專案只排除 prototype 與 `RUNTIME_DIRS`。被忽略的生成檔可能影響本機 build，但不會被交付，由 build 命令負責重建。Runner 匯出到主 checkout 的 VER 與 worktree 的副本是同一筆紀錄，不再附加任何 Runner metadata（0.2.0 及以前會加上頂層 `runnerWorktree`；worktree 路徑只記在 Runner 狀態）。獨立 review 綁定主 checkout 的 VER，reviewer 讀 worktree 副本，因此兩者的 hash 必須一致。

Git manifest 以 source ordinal 排序，避免同毫秒或 Git 作者日期造成亂序。Runner status 的 PASS 是自動產品驗證；未啟用 `policy.autoApprove` 時，Review／Baseline 仍需使用者明確批准，不由 Skill 或 Runner 代簽。PASS 之後若有人工或獨立模型審查拒收（`rejected`／`changes_requested`），Runner 下一輪會把該 target 的同一版本重開為 PENDING 並重新執行；舊 PASS 與交付記在 `reopenings`（見提案 §16.8）。拒收只作用於它否決的那次驗收或更早的驗收；版本之後修好並以更新的 PASS 記錄時，舊拒收不再重開它。Runner worktree 重建（例如重新配置後）時，已通過版本的驗收會從專案的 `.protoflow/verifications/` 複製回 worktree，佇列才能正確前進到下一版。

重開版本原有的未完成交付會保留為 `REVOKED` 歷史，讓 Runner 能產生新的驗收證據；舊 commit、審查及 PR 記錄不刪除。若舊交付已發佈且 PR 仍開啟，可以先在本機修復，但新的交付不會更新共用遠端分支；須先在外部處理舊 PR，再以新 verification 及獨立審查交付。引擎不會自行關閉被拒的 PR。

`policy.autoApprove` 下，Runner 在交付被擋時自動做原本由操作者執行的兩件事，閘門本身不放寬：

- **審查 FAIL → 自動拒收**：獨立審查回傳 FAIL 且有 findings 時，Runner 以 `ai:codex-independent-review:<session>`、`reviewerKind: "model"` 對被接受的 verification 記錄 `changes_requested`；證據檔為 `.protoflow/delivery/automated-rejections/<AIR>.json`，並發出 `auto-rejected` 事件。這一步回傳 `REOPENED`（進展，不是阻塞），Runner 在同一輪立即重開版本並修復，只有一個 target 的專案也不會因此結束；findings 是要對照證據檢驗的主張。同一版本已重開 3 次時停止自動拒收，由人決定；NOT_RUN 也留給人。
- **重新審查**：重啟後已保存的 PASS 失去進程內認證，或審查在得到判斷前因暫時性網路問題 BLOCKED（上限 6 次只計算 provider 實際執行過的審查，provider 執行前的網路失敗不計入，由 Runner 的循環間隔控制頻率；紀錄沒有 `retryable` 旗標時以原因文字判斷，例如 `gh` 的 `Get "…": EOF`）時，Runner 自動走明確重試路徑，執行新的 provider 審查並發出 `review-retry` 事件。審查判斷永不重擲。

審查程序在回答前被停止或終止（例如 Runner 重啟；結束碼為 null、沒有輸出、沒有判斷）屬於基礎設施問題，標為可重試；這版之前的紀錄由 process 證據辨識。

未啟用 `autoApprove` 時行為不變，仍需 `review request-changes` 與 `delivery sync --retry-review`。

交付對 GitHub 的只讀請求（`git ls-remote`、`git fetch`、`gh api` 讀取、`gh pr list/view/checks`）遇到暫時性網路錯誤時，原地重試 `PROTOFLOW_NETWORK_RETRIES` 次（預設 2，間隔 1 秒、2 秒）；推送、建立 PR、留言與合併不原地重試，因為遺失的回應可能掩蓋已完成的寫入，這些由上述的步驟層級恢復處理。實測中本機代理約有 8% 的請求失敗，一次交付需要數十個請求。

被拒且從未發佈（沒有 push、沒有 PR）的 `REVOKED` 交付 commit 仍留在 Runner 分支上；修復後的新交付若以它為祖先，合併時會把被拒的內容（例如誤提交的工具快取）一起帶進共用分支。因此建立新交付 commit 前，若 `base..HEAD` 含這類 commit，引擎先 `git reset --soft` 到 HEAD 與 base 的分叉點再提交：檔案與驗收綁定的內容不變，只是歷史不再經過被拒的 commit；交付紀錄的 `discardedHistory` 保存原 HEAD、分叉點與被丟棄的交付。若仍有未結案的交付壓在這段歷史上則 BLOCKED。舊版引擎已在這類歷史上建立、但尚未發佈的交付，會在下一次 sync 被退役為 `REVOKED`（`revocation.revokedHistory`），版本重新排入交付並重新審查；遠端交付分支已含該 commit 時改為 BLOCKED，留待人工處理。實測中審查只看 `base..HEAD` 的淨 diff，看不出祖先中的 26,437 個快取檔，這條規則補上這個缺口。

## 自動交付（commit → PR → 合併）

設定 `runner.delivery` 後，每個 PASS 版本在 Runner 前進前完成交付：

```json
{
  "policy": {"autoApprove": true},
  "runner": {"delivery": {"remote": "origin", "branch": "protoflow/delivery", "baseBranch": "main", "merge": "auto", "draft": true, "paths": ["app", "package.json"], "prBodyTrailers": ["OpenSpec-Change: my-change"]}},
  "adapters": {"independentReview": {"command": {"argv": ["node", "/absolute/shared-engine/scripts/codex-review-adapter.js"], "timeoutMs": 600000}}}
}
```

1. 在隔離 worktree commit 應用改動，排除 `RUNTIME_DIRS`（`.protoflow/`、`node_modules`（含 symlink）、`test-results/`、`playwright-report/`、DerivedData、Pods、`.gradle`、xcuserdata）；Git 忽略的未追蹤檔（React Native codegen、Expo CNG 的 `ios/`／`android/` 等）不會被 stage，也不在 application hash 中，見 [Git 忽略的檔案](independent-review.md#git-忽略的檔案)。訊息列出 source、manifest 和 verification，獨立 review 尚未執行時不宣稱批准。
2. 使用新 Codex read-only session review 已 commit 的完整應用；session 必須不同於原 executor JSONL 中的所有 session 與已知作者 thread。嚴格 structured verdict PASS 且無 findings 才能通過，綁定 HEAD/tree、完整內容、source/manifest/new VER/hash 和當前 remote base SHA。缺配置、缺原始 execution provenance、FAIL／NOT_RUN 或漂移一律 BLOCKED。重開過的版本只核對最近一次重開之後的 executions（之前的屬於被否決的結果，可能在重建 stream 時已封存的 worktree 裡）；缺少 execution 記錄時，錯誤會指出缺少的 `.protoflow/contexts/EXEC-….json`，從執行它的 worktree 原樣補回後再重試審查。
3. `policy.autoApprove: true` 時才建立 `reviewerKind: automated` 的本地 Review／Baseline，明確引用独立 session 與 trace/hash；不冒充真人 ADR 或 GitHub review。接著普通推送至專用 `delivery.branch`，不推 main/base、不強推、不跟隨 tag。推送前、恢復時和合併前都重核對證據與 remote refs；只容許合法推送令 branch tip 精確成為被 review 的 commit。
4. 重用或建立 PR 並留言證據。PR 的目標分支是 `baseBranch`，可為任何分支（例如 `feature/mobile-rewrite`），不限 `main`；交付分支不得等於 `baseBranch`、`main` 或 `master`。`merge: "auto"` 以 `gh pr merge --merge --match-head-commit <commit>` 合併；不使用 `gh pr review --approve` 或 `--admin`，保留 branch protection。`"manual"`（兼容 `"none"`）留給人合併；draft PR 的後續 auto 版本必須通過自身 gate 才 ready 和 merge。已記錄 MERGED 的版本不重複處理。

### PR 正文附加行（`prBodyTrailers`）

目標 repo 的 CI 要求 PR 正文帶固定標記時（例如每個 PR 恰好一行 `OpenSpec-Change: <change-id>`），在 `runner.delivery` 設定 `prBodyTrailers`：

```json
{"runner": {"delivery": {"branch": "protoflow/delivery", "baseBranch": "feature/mobile-rewrite", "merge": "auto", "prBodyTrailers": ["OpenSpec-Change: rewrite-mobile-ui"]}}}
```

- 每項是一行 `Key: value`（key 為英文字母開頭的字母、數字與 `-`，冒號後一個空格，值不可為空、不可換行或以空白結尾），最多 10 項，key 不得重複；不符時 schema 驗證失敗，交付與 issue 修復回傳 BLOCKED。
- 建立 PR 時附加在正文末尾，與原正文以空行隔開。
- 重用既有的 open PR（之前建立或人工開的）時，先讀取正文：移除與設定 key 相同的舊行，再把設定的行附加在末尾；只有內容不同時才 `gh pr edit --body`。每個交付只檢查一次（`steps.prBodyAt`），在留言與合併之前完成。
- 同樣套用到 issue 修復的 PR（見 [GitHub Issues 收件與分流](integrations.md#github-issues-收件與分流提案-0003-p4)）。
- 只比對設定的 key：其他 key 的行（例如人工寫的 `OpenSpec-Exempt:`）原樣保留，若目標 CI 把它們算進同一條規則，需自行移除。
- 正文在 PR 建立後才修改時，GitHub 觸發 `pull_request` 的 `edited` 事件；目標 CI 只監聽 `opened`／`synchronize` 時，需重新執行檢查。

多目標時每個 target 依序以自己的 worktree、交付分支 `<delivery.branch>/<id>` 與紀錄 `.protoflow/delivery/<id>.json` 走完上述步驟，各自取得獨立 review PASS；一個 target BLOCKED 不阻擋其他 target。交付 commit 不得包含兄弟 target 的 root。兄弟 target 先合併令 base 前進時，只在 base 的變更全部位於兄弟 root／prototype／runtime 目錄、且本 target application hash 不變時，才把精確 base SHA merge 進本 target worktree 後再 review；否則 BLOCKED 並需在新 base 上重新驗收。詳見 [獨立 review 的多目標交付](independent-review.md#多目標交付schemaversion-2)。

push、PR、留言或合併失敗保存在 `.protoflow/delivery/state.json`（多目標為 `.protoflow/delivery/<id>.json`）；同一引擎程序內可從失敗步驟續做，不重複 commit 或留言。程序重啟後 `protoflow delivery sync` 不信任僅磁碟 PASS，須明確選定 deliveryId／reviewId 取得新實際 provider revalidation；`protoflow delivery status` 仍可讀取紀錄。需要 `gh` 已登入且對目標 repo 有寫入權。主 checkout 不會被 pull 或修改。

### 暫時性網路故障與明確重試

Git transport（`ls-remote`／`fetch`／`push`）與 `gh api`／`gh pr` 的網路錯誤、HTTP 5xx（例如 `Service Unavailable`、`Bad Gateway`）和代理的 `CONNECT tunnel failed` 屬於暫時性基礎設施故障，與 reviewer verdict 及 binding 漂移分開記錄：

- 交付步驟失敗時，交付紀錄與 `delivery sync` 結果帶 `retryable: true`；同一程序的下一次 sync 從失敗步驟續做。
- 發生在獨立 review 期間（provider 之前的 base 查詢，或 provider 回傳 PASS 之後的重新核對）時，AIR 紀錄為 `BLOCKED`，並帶 `retryable: true`、`reasonCode: "TRANSIENT_INFRASTRUCTURE"`。reviewer 回傳 FAIL、NOT_RUN 或任何 finding 的 attempt 永遠不會被標為 retryable。

重試必須明確選定當前交付與其當前 review attempt，必要時指定 target：

```bash
protoflow delivery sync --retry-review --delivery DLV-... --review AIR-... [--target web] --project /path/to/app
```

此命令總是建立新的 AIR 並實際執行 provider，接受以下情況：程序重啟後沒有 live attestation 的已保存 PASS；尚未 approval／push／PR 的 BLOCKED attempt；以及已 approval 或已 push 後，因暫時性網路故障 BLOCKED 的 attempt。新的 PASS 之後，引擎重新核對 commit、tree、base 與 PR 身份，建立引用新 AIR 的 automated approval（舊 approval 存入 `approvalHistory`），再續做 PR、留言與合併。reviewer 的 FAIL／NOT_RUN／finding 是最終判斷，任何情況都不重試；須記錄拒收（`review reject`）並在修復後以新 verification 交付。

獨立 review 的 BLOCKED 證據保持阻擋，不能以編輯狀態或自填 PASS 清除；需以上述明確重試取得新的實際 review，並保留所需新驗收證據。[重用接口與私有 provenance 格式](independent-review.md) 可供其他受保護的交付流程使用。若缺當前 base 物件，request 只 fetch 該精確 SHA（`--no-tags --no-write-fetch-head`），不移動 main、index 或工作檔案。

### 定期巡查（Codex 自動化）

在 Codex app 建立 heartbeat 自動化（例如每 30 分鐘），工作目錄為目標專案，prompt 範例：

> 在 <目標專案> 執行 `node <engine>/bin/protoflow.js runner start --once --project .`，再執行 `delivery sync` 與 `delivery status`。只根據 JSON 回報：新處理的原型 SHA、驗證結果、PR 連結與合併 commit；BLOCKED／FAIL 時回報原因與需要的操作。無新版本且無失敗時保持安靜。不要修改設定、證據或原型，不要手動批准或合併。

Codex 會在該自動化的對話串回覆結果（未讀提示點）。自動化需在 Codex app 中建立；引擎不寫入 Codex 設定。

## 可重複測試

`tests/git-runner.test.js` 使用明確本機 Git fixture 檢查補抓、去重、重寫、資源完整性、失敗阻塞、dirty files 保護及 stop／鎖恢復；其中失敗 argv 是單元測試替身，沒有 provider 執行。`npm run test:e2e` 是 Node.js Playwright runner 的實際瀏覽器測試。實際 GitHub + Codex 驗收須另保留來源 SHA、EXEC JSONL、verification 與截圖，不能用 fixture 冒充。

內建 Codex adapter 可在 argv 加 `--model <本機 CLI 支援模型>`、`--ephemeral`，只影響本次執行，不改全域模型設定或登入。預設模型不受目前帳號支援時，保存 provider 失敗、選擇官方可用模型，再用 configure／retry 重試同版。

執行者預設沿用開發者的 `~/.codex/config.toml`；其中啟用的 memories 會讓執行 session 讀取個人記憶，內容進入 EXEC JSONL，而獨立 reviewer 會讀這些 trace。設定 `adapters.codex.ignoreUserConfig: true` 讓執行者以 `--ignore-user-config` 隔離（取捨與細節見 [整合：Codex](integrations.md#codex)）。在已有 worktree 的專案啟用時，先停止 Runner、修改設定，再執行 `runner configure`。

## 常駐服務（macOS launchd）

前景執行的 `runner start` 在 session 結束、終端機關閉或程序被終止時就停止，且所有 target 都 BLOCKED 時會直接結束。正式專案改用常駐服務：

```sh
protoflow runner service install --project /path/to/app   # 另可加 --env KEY=VALUE
protoflow runner service status --project /path/to/app
protoflow runner service uninstall --project /path/to/app
```

- `install` 先檢查這個配置會用到的工具（`git`；交付或 Issues 需要 `gh`；Claude adapter 需要 `claude`；Codex adapter 需要 `codex`），在目前的 PATH 與 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` 中解析成絕對路徑，缺一個就 BLOCKED，不安裝。接著寫入 `~/Library/LaunchAgents/dev.protoflow.runner.<專案路徑雜湊>.plist`：以安裝時的 node 絕對路徑執行 `runner start --service`，PATH 為解析出的工具目錄加上安裝時的 PATH（例如 Flutter），並帶入 `JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`LANG`、網路代理（`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`ALL_PROXY` 及小寫寫法）與 `--env`；缺少代理時，經代理才能上網的機器會讓服務連不上 GitHub。登入時啟動（`RunAtLoad`），程序結束就重啟（`KeepAlive`，間隔至少 60 秒）；日誌在 `.protoflow/runner/service.out.log` 與 `service.err.log`，安裝紀錄在 `.protoflow/runner/service.json`。已有前景 Runner 持有鎖時拒絕安裝，避免服務因鎖而反覆重啟。
- `runner start --service` 是常駐模式：所有 target 都 BLOCKED 或來源暫時讀不到時不退出，繼續輪詢，等人處理後自動接手；只在 SIGTERM／SIGINT（`uninstall` 或 `launchctl bootout`）時停止。
- 每個事件附時間寫入 `.protoflow/runner/events.jsonl`（超過 5 MB 輪替為 `events.1.jsonl`）；執行代理執行期間，它的 stdout trace 同步寫到 Runner worktree 的 `.protoflow/live/execute.jsonl`，`execute.json` 記錄執行者、模型與 context。兩者供[儀表板](dashboard.md)顯示，寫入失敗不影響 Runner。
- Runner 每一輪、每個事件，以及執行期間每 60 秒都寫 `.protoflow/runner/heartbeat.json`（pid、版本、模式、心跳間隔 `beatIntervalMs`、最後一輪各 target 狀態、最後事件）。`service status` 回報 launchd 的 state、pid、啟動次數、最後結束碼與心跳距今秒數：launchd 正在執行且心跳來自同一個常駐 pid 時為 `HEALTHY`；同時心跳記錄連續幾輪讀不到來源或連不上 GitHub（`failingPasses`、`lastFailure`），連續 3 輪以上改報 `DEGRADED` 並附原因；程序存活但心跳超過 5 分鐘未更新時為 `STALLED`（程序無回應；v0.3.27 之前啟動的 Runner 只在每輪之間心跳，不做此判斷）；程序在跑但尚未心跳為 `STARTING`，未執行為 `DOWN`，未安裝為 `NOT_INSTALLED`。執行代理或原生畫面擷取長時間工作時心跳照常更新，所以 `HEALTHY` 代表 Runner 仍有回應。
- 升級引擎或改配置：`runner service uninstall` → `runner configure` → `runner service install`。其他作業系統回報 NOT_RUN，請以系統的服務管理器執行 `runner start --service`。
