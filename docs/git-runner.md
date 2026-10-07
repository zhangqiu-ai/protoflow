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

每個來源提交先保存完整子目錄（HTML、CSS、腳本、二進位素材），固定 SHA、content hash、diff 與 mapping，再發布 deterministic manifest。掃描 cursor 逐筆原子更新；無原型變更的提交只更新 scannedSha。資源必須位於同一子目錄，靜態 HTML/CSS/JS 引用（含 srcset、poster、inline module／importmap）的缺失或可變 URL 資源會報錯；不下載第三方 CDN 或猜測子目錄外依賴。資源 URL 明確拒絕反斜線與 C0／DEL 控制字元，避免瀏覽器 URL 正規化與 POSIX 檔名語義不同；HTML 資源／CSS 屬性與 srcdoc 只支援一次解碼的 `amp`、`quot`、`apos`、`lt`、`gt`、`colon`、`Tab`、`NewLine` 具名 entity，以及數字 entity，其他完整 `&name;` 形式保守拒絕；解碼後的控制字元仍拒絕。`&amp;sol;` 只變成字面 `&sol;`，不二次解碼；普通 onclick 的 `&&` 不受 entity gate 影響。snapshot 限制每檔 2 MiB、總計 20 MiB、1000 檔；symlink／submodule 報錯。 MVP 未包含完整 JS module parser：inline module／importmap、script／iframe／embed／object 的可執行 data: 資源一律拒絕，普通 image data: 可保留；JS 檔與普通 inline script 的 import／re-export 語法（包括插入註解、動態 import）也保守拒絕，需提供已打包且無模組載入語法的 vendored script；script src／href 僅接受 UTF-8 文字的本地 .js／.mjs／.cjs，副檔名不分大小寫，未知格式或非 UTF-8 腳本會拒絕。 所有 UTF-8 檔中的 `xml-stylesheet` processing instruction 未支援，一律阻塞，需改用已凍結的 CSS link；`.xml`／`.xhtml`／`.xht` 文件全局拒絕，即使未被引用或直接作為場景。iframe／embed／object 僅支援已稽核的本地 `.html`／`.htm`／`.svg` 文件，不接受其他副檔名、二進位圖片，或以 `type` 宣告繞過限制。帶 namespace prefix 的 XML／SVG element（例如 `s:image`）也拒絕；普通無前綴 SVG 與 `xlink:href` attribute 仍支援。script／style 必須有 canonical closing tag 才能稽核 body，缺少結尾直接阻塞；以第一個 tag name 後接 ASCII 空白、`/` 或 `>` 的 closing prefix 為準，若有額外 attribute／slash 等非 canonical 形式就拒絕，不越過它尋找較後的結尾。所有 script body（含 JSON data block 與帶 src）中的 `<!--` escaped 狀態未支援，一律拒絕。起始 tag 無法完整稽核時保守拒絕，不支援瀏覽器容錯修補的 malformed markup；quoted attribute 及已稽核的普通 HTML script／style body 會完整跳過，不把其中的 `<` 比較式當成 tag。SVG 文件或含 `<svg>` 的 HTML 中，script／style body 的資源子標記（含 namespace prefix）保守拒絕，不能當作 HTML raw text 略過；此限制套用該文件全部 script／style，可能拒絕其中只作字串的資源標記。SVG／混合文件的 script body 先按上述 entity subset 解碼再稽核 JS；style body 同樣解碼稽核，普通 `&&` 與非資源 `<b` 比較式仍可使用。資源存在檢查只接受 snapshot 自有檔案，`constructor`／`toString` 等 Object prototype 名稱不能代替缺失資源。`meta http-equiv="refresh"` 自動導頁未支援，即使本地目標也一律拒絕。HTML／CSS／SVG 同樣必須是 UTF-8，不能當 binary 略過資源稽核；真正圖片等二進位素材照常凍結。stylesheet link 與 CSS @import 僅接受已稽核的本地 `.css` 文字文件，不接受未知副檔名或以 MIME type 繞過。CSS url／@import 使用同一掃描器，完整保留引號內空格；不支援的 escape 或無法解析的 URL／import 會保守拒絕。檢查可能因字串或註解內的模組關鍵字而拒絕；它保證上述靜態形式不會略過，不能證明任意 runtime fetch、eval 或其他計算式網路行為已凍結。 不透明的 `@import data:` 與 `image()`、`image-set()`、`-webkit-image-set()`、`src()` 等未支援資源函式也會阻塞；一般自包含圖片／字型的 `url(data:...)` 可保留。

掃描採 branch first-parent 歷史，merge 視為一個整合版本。既有 cursor 不再位於該鏈（rewind、force push 或改接歷史）會保存 `HISTORY_REWRITTEN` 並停止，不能跳過。source repository／branch／path／startSha 一旦產生進度即固定；更換來源需由開發者備份並另行初始化狀態，MVP 不自動刪除／重置既有證據。

應用在 `.protoflow/runner/worktree-<source-hash>` 的獨立本機分支實作。初始內容從目前主 checkout 複製，包含使用者尚未提交修改，但不碰主 checkout、index 或 HEAD；之後所有版本延續同一隔離 worktree。`runner.setup` 在此安裝依賴；server 類專案需自行提供可重複 setup／build／functional 命令及可用 visual URL，Runner 不猜測 server 命令。引擎與目標專案都不自動 commit、push、合併或發布；結果供開發者 review 後自行移交。

每版呼叫真實配置的 Codex adapter，獨立跑 build → Playwright functional → frozen visual。全部 PASS 才更新 completedSha 並前進。修復最多 `policy.maxRepairAttempts` 次；每次記錄 context、execution 與 verification。L2 需 `runner.spec` 的已核對規格，L3 還需 `runner.adr` 綁定當版 manifestHash 的人類決策；缺少即阻塞。配置變更後已有 worktree 會拒絕自動沿用。停止後可用 `runner configure` 明確更新操作設定，保存前後 config hashes 與原設定，保留應用修改與所有 attempts；source／prototypeDir／mapping id 和 prototypeFiles 所有權不能變。再 `runner retry` 恢復當前版本。

正常停止會終止當前 subprocess group、保存 STOPPED；下一次 start 不擅自重試。setup、Codex、build／functional 與 visual Chromium 在 spawn 前先保存 STARTING／pid:null 意圖，再保存 PID／PGID 與完成時間；正常返回且能證明 spawned:false（例如 ENOENT 或 spawn 前取消）的意圖可記錄已完成，仍可重新配置／重試；PID 尚未落地時崩潰，未知 PID 會保守阻止自動恢復，需人工檢查可能留下的程序。Visual 透過 Playwright BrowserServer 保存 browser PID／PGID，停止時關閉或終止整組並確認結束；launch 已嘗試但未取得 PID 的錯誤也保留未知啟動意圖，不能自動略過。POSIX 恢復檢查整個 subprocess group；leader 已死而 child 仍活也會阻止 retry／setup。命令正常退出但同組程序未退出時會終止該組並記錄 FAIL，不能 PASS 前進；尚未確認全組結束就不寫完成時間。 若 processGroupActive 仍為 true，立即阻塞，不能啟動後續 functional／visual、repair 或新 Codex；每次新 attempt 前也重新檢查舊的未完成程序，保留其 phase／PID／失敗證據。Windows 無法確認整個程序樹，MVP 保守拒絕受監督命令的自動執行／恢復；命令不得自行 detached／轉移子程序 group，這些形式不在 MVP 的自動恢復保證內。異常退出的 RUNNING 同樣需 `runner retry`，避免重複執行者；死 PID 的本機鎖可恢復，活躍或缺少 owner 的鎖拒絕略過。若 PASS verification 已落地但 completedSha 尚未更新，retry 後會核對 application/frozen/artifact hashes 再復原完成記錄。

## 證據與順序

`.protoflow/source/state.json` 保存 scannedSha、completedSha、ordinal、每版狀態與 attempts；`.protoflow/runner/state.json` 保存 worktree、初始 application SHA／hash、branch、設定 hash。原型 checkpoint 使用既有 `.protoflow/manifests/` 與 `.protoflow/versions/`。執行的完整 JSONL／stderr 位於 worktree `.protoflow/contexts/EXEC-*.json`；主 checkout 與 worktree 均保留 verification、按 verification ID 分開的 PNG／diff／HTML 報告，綁定 manifestHash、prototypeHash、application hash 與來源 SHA。

Git manifest 以 source ordinal 排序，避免同毫秒或 Git 作者日期造成亂序。Runner status 的 PASS 是自動產品驗證；人類 Review／Baseline 仍需使用者明確批准，不由 Skill 或 Runner 代簽。

## 可重複測試

`tests/git-runner.test.js` 使用明確本機 Git fixture 檢查補抓、去重、重寫、資源完整性、失敗阻塞、dirty files 保護及 stop／鎖恢復；其中失敗 argv 是單元測試替身，沒有 provider 執行。`npm run test:e2e` 是 Node.js Playwright runner 的實際瀏覽器測試。實際 GitHub + Codex 驗收須另保留來源 SHA、EXEC JSONL、verification 與截圖，不能用 fixture 冒充。

內建 Codex adapter 可在 argv 加 `--model <本機 CLI 支援模型>`、`--ephemeral`，只影響本次執行，不改全域模型設定或登入。預設模型不受目前帳號支援時，保存 provider 失敗、選擇官方可用模型，再用 configure／retry 重試同版。
