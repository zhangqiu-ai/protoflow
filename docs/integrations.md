# 整合接口

## 通用命令

配置 command 為 null 或 `{ "argv": ["program", "arg"], "timeoutMs": 120000 }`。cwd 是目標 project。引擎不開 shell，不插入動態 shell 字串；預設超時兩分鐘、輸出上限 4 MiB，超時／超量會終止 subprocess group。非零 exit code 是 FAIL；null 是 NOT_RUN。

## 安裝 Spec Kit 與 BMad

`protoflow install` 在安裝 ProtoFlow Skill 後依序處理 `specKit`、`bmad`：先偵測（Spec Kit：`.specify/` 或 `.agents/skills/speckit*`；BMad：`_bmad/` 或 `.agents/skills/bmad*`／`bmod*`），已存在則記錄 `present` 並略過；否則執行 `adapters.<id>.install` argv，cwd 是目標專案，預設超時 10 分鐘。配置沒有 `install` 欄位或沒有配置檔時使用引擎預設；`null` 記錄 `NOT_RUN` 並提醒手動安裝。

```json
{"adapters":{
  "specKit":{"command":null,"install":{"argv":["uvx","--from","specify-cli","specify","init","--here","--force","--non-interactive","--integration","codex","--script","sh"],"timeoutMs":600000}},
  "bmad":{"command":null,"install":{"argv":["npx","--yes","skills","add","bmad-code-org/BMAD-METHOD","--skill","*","--agent","codex","--yes"],"timeoutMs":600000}}
}}
```

預設命令依兩個專案的官方文件：Spec Kit 對既有專案使用 `specify init --here --force --integration <key>`，Codex 整合把 skills 放在 `.agents/skills`；BMad 以 skills CLI 安裝，之後在 Codex 執行 `bmad setup`。上游 CLI 變更時改寫配置即可，不需修改引擎。安裝器退出碼零但沒有留下偵測依據時判為 FAIL。每筆結果保存 argv、exit code、stdout／stderr 尾段與 `changed`（安裝前後專案 fingerprint 的差異檔案），`notices` 另輸出到 stderr 提醒開發者。安裝器是被信任的外部程式，引擎不隔離它們的檔案寫入；執行前應有可檢查的 Git 基準。

## Adapter 協定

外部 planning/execution adapter 接收 stdin JSON，不應假設 engine source 存在目標專案內。不要在配置存 token；工具使用既有的本機授權機制。Spec Kit／BMad 的 agent skills 不是終端命令，必須由了解該框架的 adapter 或當前 agent 執行。

## Spec Kit

`prepare --adapter specKit --manifest ID` 傳入 `{schemaVersion:1,kind:"specKit",manifest,manifestHash,mappings,expected}`。adapter 產生 specification、acceptance criteria、plan、tasks。stdout 是：

```json
{"status":"ready","artifacts":["specs/feature/spec.md","specs/feature/plan.md","specs/feature/tasks.md"]}
```

每個 artifact 必須實際存在、非空、在專案內。引擎保存 hash；退出碼零但 artifact 缺失仍 FAIL。`context --spec specs/feature/spec.md` 代表選擇已核對的規格 evidence；初版不宣稱能自動判斷規格的語義完整性。

官方：[Spec Kit](https://github.com/github/spec-kit)。現行流程與安裝方式依該專案文件確認，不在 ProtoFlow 內硬編碼其 agent skill 語法。

## BMad / ADR

僅有需要架構判斷的 L3 強制此邊界，其他等級可自行接入。BMad adapter 相同 stdout 協定；內容是方案／tradeoffs／ADR，而非 application code。L3 透過 `context --adr decisions/ADR-001.json` 接入明確的人工 decision：

```json
{
  "status":"approved",
  "reviewer":"REAL_HUMAN_ID",
  "manifestHash":"SHA256_OF_EXACT_MANIFEST",
  "decision":"Chosen architecture and rationale",
  "alternatives":["Alternative A","Alternative B"],
  "reversible":true
}
```

使用 `prepare` 回傳的 `request.manifestHash`，或讀取 context/request 中的 hash。只有真實人類批准後填入 approved；缺少批准、內容或 hash 不匹配，context 不能建立。修改決策內容必須重建 context，再驗證／Review。官方：[BMad](https://github.com/bmad-code-org/BMAD-METHOD)。

## Codex

`execute --context ID` 只產生 request。`--execute` 執行配置命令，stdin 是完整 context 加 `kind:"implement"`／`"repair"`。包含 manifest、prototype diff/hash、mappings、project hashes/Git、spec／ADR、驗證配置，以及 repair 的上一份 verification。完整原型快照保留在 session，adapter 可讀取目標專案目前的原型檔案。adapter 負責修改 mapped application code 和重複測試，不批准 Review／Baseline、不修改 prototype。

**大型原型 diff**：context 整體（以縮排 JSON 計）限制在 900 KiB 內，低於 Codex 1,048,576 字元的輸入上限。單檔 diff 超過 32 KiB，或有一行超過 2,000 字元（例如整頁 HTML 產生在同一行，改一個屬性就等於新舊兩整頁），不放進 context，改為 `diffOmitted: true`，並附上 `diffSize`、`diffLines`、`excerpts`（每處變更前後各約 160 字元）、`frozenAfter`（本版凍結檔 `.protoflow/versions/<manifestId>/files/<path>`）與 `frozenBefore`（依 `beforeHash` 找到的上一版凍結檔）。執行代理自行讀取或比對這兩個檔案。manifest 的 `git.diff` 與各 change 的 `diff` 是同一份內容，只保留後者，前者改為 `diffOmitted` 與大小。仍超過預算時，所有 diff 都改為參照；還是超過就不呼叫執行代理，直接 FAIL，原因列出最大的欄位（含第二層，例如 `anchors.screens`）。這在送出時套用，舊引擎已凍結的 manifest 也適用，不需要重新凍結。EXEC 紀錄保留完整 request（交付審查用它核對 manifest），另在 `sent` 記下實際送出內容的 hash、大小與被省略 diff 的檔案。

內建橋接配置：

```json
{"adapters":{"codex":{"command":{"argv":["node","/absolute/shared/protoflow/scripts/codex-adapter.js"],"timeoutMs":120000}}}}
```

這是合併到既有配置的片段，不是完整 config。橋接執行 `codex exec --json --sandbox workspace-write -`，從 stdin 傳入 prompt。可於 adapter argv 指定 `--model MODEL` 與 `--ephemeral`；仍固定 workspace-write，不接受繞過 sandbox 的參數。程序結果、stdout JSONL 與 stderr 保存至 execution evidence；exit zero 不代替產品驗證。官方：[Codex 非互動模式](https://developers.openai.com/codex/noninteractive)。

### Claude 執行者與 Codex 備援（提案 0003）

`policy.executor` 選擇執行者；未配置時維持 Codex（與既有專案相容）。提案 0003 的預設為 Claude Sonnet，額度不足時由 Codex 接手：

```json
{
  "policy": { "executor": { "primary": "claude", "fallback": "codex", "routes": { "frontend": "claude", "backend": "codex" } } },
  "adapters": {
    "claude": { "command": { "argv": ["node", "/absolute/shared/protoflow/scripts/claude-exec-adapter.js", "--model", "claude-sonnet-5-5", "--max-budget-usd", "10"], "timeoutMs": 1800000 } },
    "codex": { "command": { "argv": ["node", "/absolute/shared/protoflow/scripts/codex-adapter.js"], "timeoutMs": 1800000 } }
  }
}
```

- `scripts/claude-exec-adapter.js` 以 `claude -p --restricted` 執行：檔案工具限制在 worktree（`--add-dir` 可加絕對路徑），只開 Read、Grep、Glob、Edit、Write、Bash；Bash 在 OS 沙箱內執行且不允許退回非沙箱；編輯自動接受，其他需要確認的操作一律拒絕；不載入使用者設定、MCP 或保存的 session。stdout 是完整的 stream-json trace，作為執行證據；trace 中任何超出這組工具的呼叫都會讓執行失敗，只有 CLI 以「No such tool available」拒絕、根本不存在於 session 的工具名稱（例如模型把 `Bash` 寫成 `bash`）不算使用。
- 執行指示與 Codex 相同（`src/executor-prompt.js`）。
- **依工作分流**（`routes`，可省略）：前端工作（每個原型版本，以及規劃者標為 `area: "frontend"` 或 `"mixed"` 的 Issue）交給 `routes.frontend`，只動非前端程式碼的 Issue（`area: "backend"`：資料、網路、儲存、服務、建置或測試工具，使用者看不到的變更）交給 `routes.backend`。被分流的執行者額度不足時，由 `primary`／`fallback` 中的另一個接手。這樣前端與後端的工作分別消耗兩邊的額度；規劃與驗收不受影響。未設定 `routes` 時，所有工作照 `primary`／`fallback`。
- **備援**：主要執行者回報額度或限流（usage limit、rate limit、quota、overloaded、429／529、model at capacity）時，同一個 attempt 改由 `fallback` 重做一次，attempt 記錄 `executor` 與 `executorFallback`，並發出 `executor-fallback` 事件。其他失敗照一般規則處理（暫時性重試、失敗 attempt、修復上限）。
- **交付證據**：EXEC 紀錄帶 `executor`。Claude 執行者的 trace 以執行者規則驗證（單一 session、工具不超出上述集合、`acceptEdits` 或 `dontAsk`、成功結束），binding 的 `executors` 記錄 `executor: "claude"` 與 session；Codex 紀錄維持原格式。
- **登入**：Claude CLI 從啟動 ProtoFlow 的環境取得憑證（`claude setup-token` 產生的 `CLAUDE_CODE_OAUTH_TOKEN`，或 `ANTHROPIC_API_KEY`）。ProtoFlow 不讀取或保存憑證；未登入時 Claude 回報失敗，有備援時改由 Codex 執行。

### Claude 規劃者（提案 0003）

配置 `adapters.planner` 後，runner 在每個原型版本開始實作前，先以唯讀 Claude session 規劃；未配置時行為不變：

```json
{ "adapters": { "planner": { "command": { "argv": ["node", "/absolute/shared/protoflow/scripts/claude-adapter.js", "--model", "claude-opus-5-5", "--max-budget-usd", "5"], "timeoutMs": 900000 } } } }
```

- **輸入**：版本 manifest 摘要、target、scope、受影響畫面的錨點契約、全部錨點 id、先前的審查 findings（`rejections`），以及同一版本再次執行時的 `previous`：上一份方案、失敗原因、最後一次驗收的摘要（`lastVerification`：編號、狀態、失敗項、functional 第一個失敗的測試與錯誤、每個失敗畫面未通過的層級與原因，最多 20 個畫面、每層 8 條）與維護者以 `runner retry --answer` 給的回答（`answers`，最近 5 則）。有 `lastVerification` 時，規劃者被告知驗收由 ProtoFlow 在執行代理的沙箱外執行、是權威結果，執行代理自己的沙箱跑不了檢查不是環境問題，也不是 `needs-human` 的理由；有 `answers` 時，最新的回答是維護者對它所回答問題的決定，不再為同一個問題回 `needs-human`。全部以不受信任資料傳入。
- **輸出**：`PLN-*` 紀錄存於 worktree 的 `.protoflow/plans/`，含 session、trace hash、request hash、model、費用與正規化後的方案（`planHash`）。引擎自行重驗 raw trace（單一 session、只用 Read／Grep／Glob、`dontAsk`、無 MCP），不採信橋接程式的摘要。
- **引擎規則**：L3 版本（以引擎分級或規劃者回報的等級為準）在 context 帶有已核准（`status: approved`、具名 `reviewer`、非空 `decision`）且 `manifestHash` 綁定該版的 ADR 時，可維持 `implement`：ADR 的決策與 scope 會放進規劃請求的 `adr`，方案加上 `engineNotes` 記錄依據；缺少或不符時一律改為 `needs-human`，規劃者自己回答 `needs-human` 也不會被改寫。Issue 分流不帶 ADR，L3 仍一律交給人；方案未涵蓋的錨點自動補上 `AC-engine` 條件（維持凍結契約，由分層驗收檢查）。
- **決定**：`implement` 時，方案放進執行者 context 的 `plan`（步驟、驗收條件、測試、風險）；原型與分層驗收仍是權威，矛盾的步驟不實作並在報告中說明。`needs-human` 時版本停在 BLOCKED，原因帶規劃者的問題。
- **失敗**：規劃者無法給出有效方案（未登入、trace 不合規、輸出不符 schema、逾時）時記錄 `planError`、發出 `plan-failed` 事件，版本照常不帶方案實作。
- **驗收綁定**：交付時 binding 的 `versions[].plan` 綁定方案 id、`planHash`、規劃者 session 與驗收條件；方案檔被改動或屬於其他版本時交付 BLOCKED。驗收者逐條檢查條件，未滿足者以條件 id 回報 finding；驗收者 session 不得等於任何規劃者、執行者或作者 session。

### GitHub Issues 收件與分流（提案 0003 P4）

配置 `issues.enabled` 與 `adapters.planner` 後（schemaVersion 1 專案視為單一 target `application`），runner 每輪在原型串流之後處理帶標籤的 Issue，原型串流跑很久（例如修復中）時也每 5 分鐘在背景同步一次（同一時間只有一個 Issue 工作，不會撞鎖）；也可手動執行 `protoflow issues sync`，以 `issues status` 查看狀態：

```json
{ "issues": { "enabled": true, "label": "protoflow", "authors": ["OWNER", "MEMBER", "COLLABORATOR"], "targets": ["ios", "android", "flutter"], "maxTriagePerSync": 3 } }
```

- **範圍**：只讀取交付 remote（`issues.remote`，預設 `runner.delivery.remote` 或 `origin`）解析出的正式 GitHub 倉庫；每個 API 端點都必須在 `repos/<owner>/<name>/` 之下。讀取遇到網路暫時錯誤會原地重試，寫入（留言、標籤）一律不重試。
- **收件**：帶 `issues.label` 的開啟 Issue（不含 PR），依編號處理。設 `issues.all: true` 時改為處理**所有**開啟的 Issue（逐頁讀取，最多 1,000 個），由 AI 接手整個 Issue 列表；加上 `<label>:skip`（預設 `protoflow:skip`，首次執行時建立）的 Issue 一律略過。作者授權規則不變。每次分流前快照標題、內文、留言、標籤與作者，存成 `.protoflow/issues/snapshots/ISS-<n>-<hash>.json`。
- **授權**：作者的 `author_association` 不在 `issues.authors` 時不呼叫規劃者，直接標 `needs-human`。維護者移除該標籤即重新分流；引擎從 Issue events 找出移除者，確認其有 write、maintain 或 admin 權限才算數，否則發出 `issue-unconfirmed` 並繼續等待。
- **分流**：唯讀 Claude 規劃者（與原型流程同一套 trace 驗證）回答 `implement`、`needs-info`、`needs-human`、`reject` 或 `wait-prototype`，並給出 targets、步驟、驗收條件、需新增的測試、風險與問題。引擎規則：L3、缺 targets／步驟／驗收條件／測試的 `implement`、沒有問題的 `needs-info`，一律改為 `needs-human`。每輪最多規劃 `maxTriagePerSync` 個 Issue；規劃失敗下一輪重試，連續 3 次失敗轉 `needs-human`。
- **佇列中的原型版本**：分流資料帶 `prototypeVersions`：Issue targets 尚未接受（設定 `runner.delivery` 時為尚未交付）的已凍結原型版本，每筆有 manifestId、摘要、變更檔案、凍結副本路徑（`.protoflow/versions/<id>/files/`）、等待中的 targets 與正在處理的 targets（`current`）。規劃者被要求先讀這些版本，不能只看最後已接受的原型就說「原型沒變」；其中某版已經做了 Issue 要的變更時回答 `wait-prototype` 並指定 `prototypeVersion`（必須是給它的版本之一，否則引擎改為 `needs-human`）。Issue 標為 `<label>:waiting-prototype`，記下 `prototypeVersion` 與要等的 targets（方案 targets 與該版等待中 targets 的交集）；之後每次同步檢查：該版在這些 targets 都已接受（與交付）時，留言說明並以 `completed` 關閉 Issue（狀態 `done`，發出 `issue-done`）；該版被 `runner supersede` 併入後續版本時改等那一版；從佇列消失又沒有後續版本時重新分流。維護者移除 `waiting-prototype` 標籤也會重新分流。等原型版本的 Issue 不出現在面板的「需要你」。
- **發布**：決定以標示為 AI 的留言發布（含規劃者模型、方案 id、session、快照 id），並把 Issue 的狀態標籤換成 `<label>:planned`、`needs-info`、`needs-human`、`rejected` 或 `waiting-prototype`（首次執行時自動建立 8 個狀態標籤）。決定先寫入 `.protoflow/issues/state.json` 再發布；中途中斷時下一輪依留言開頭的標記續做，不會重複留言。`rejected` 不會自動關閉 Issue。
- **再分流**：`needs-info` 的 Issue 有新的非 ProtoFlow 留言時重新規劃，資料帶上一份方案；`needs-human`、`rejected`、`waiting-prototype` 在維護者移除狀態標籤後重新分流。
- **沒回答就交回**：`needs-human` 的 Issue 被交回時，若標題、內文與非 ProtoFlow 留言都和上次分流時相同（`state.json` 的 `contentHash`），規劃者的資料帶 `previous.handedBackWithoutAnswer: true`，並被要求不再問同樣的問題：依自己的建議答案決定 `implement`（把假設寫進摘要與驗收條件）或 `reject`；只有上次沒提過的理由或 L3 才回 `needs-human`。這次仍是 `needs-human` 時，之後再沒回答就交回不會再呼叫規劃者，只留言說明「沒有新資訊，請回答或關閉」並列出未答的問題，發出 `issue-unchanged`；Issue 有新留言或內容改變後恢復正常分流。
- **在 GitHub 關閉**：尚未開始實作的 Issue（`new`、`triage-failed`、`needs-info`、`needs-human`、`rejected`、`blocked`、`planned`、`waiting-prototype`）在 GitHub 被關閉或刪除後，下一次同步在本機記為 `closed`（只存在 `state.json`，不加標籤），原因寫明關閉者與 `state_reason`，發出 `issue-closed`，面板不再列出。重新開啟的 Issue 視為新請求重新分流。
- **實作（P5）**：需要 `policy.autoApprove` 與 `runner.delivery.merge: "auto"`。原型優先：某個 target 的 runner 閒置、所有已接受版本都已交付且合併（被拒收而退役的交付 `REVOKED` 也算已結案）、worktree 沒有未提交修改（與目前 base 內容逐位元相同的修改除外，例如 `runner configure` 同步進來的配置，會先還原再隨快轉帶回）時，runner 每輪替該 target 處理一個 `planned` Issue（已開始的優先，其次編號最小者）。Issue 等待的原因每次改變時發出一筆 `issue-waiting` 事件。
  1. 把該 target 的 runner worktree 快轉到目前的 base，Issue 轉為 `in-progress`（AI 留言）。
  2. 執行者依方案修改（context 帶 `issue` 與 `plan`；Issue 內容標為不受信任資料），再以 `reverify` 對該 target **最新已接受的原型版本**跑完整驗證（build、functional、分層），確保修 Issue 不破壞原型一致性。方案列出測試時，修改必須新增或修改測試檔，否則視為失敗並進入修復；修復上限沿用 `policy.maxRepairAttempts`，執行者額度與暫時性錯誤的處理與原型流程相同。
  3. 提交 `Fix #n: <標題>`（trailer 含 `Fixes #n`、快照、方案、驗證與 base），獨立審查的 binding 改為 `issue`（快照、方案驗收條件與測試、規劃者 session）加上一筆 `regression: true` 的版本驗證；驗收者不得是規劃者或執行者 session。審查 FAIL 不重審。
  4. 自動批准（標示為 AI）、推送到 `protoflow/issue-<n>`（多 target 為 `protoflow/issue-<n>/<target>`）、開 PR（內文 `Fixes #n`；尚有其他 target 未合併時為 `Part of #n`；設定 `runner.delivery.prBodyTrailers` 時末尾附加這些行，見 [PR 正文附加行](git-runner.md#pr-正文附加行prbodytrailers)）、目標分支為 `runner.delivery.baseBranch`、以 `--match-head-commit` 合併，再把 runner worktree 對齊到合併 commit。
  5. 方案的所有 target 都合併後，Issue 加上 `done`、AI 結案留言並關閉（非預設分支不會因 `Fixes #n` 自動關閉，因此由引擎關閉）。
  - 修復用盡、審查 FAIL 或其他阻擋時，該 target 的修改被丟棄、worktree 回到開始時的 base，Issue 標 `blocked` 並附原因與 findings，原型串流繼續。有寫入權限的維護者移除 `blocked` 標籤後，Issue 重新分流，已合併的 target 保留。
  - base 在發布前前進（例如同一個 Issue 的其他 target 先合併）時，已提交的修正被丟棄、從新的 base 重做（最多 3 次，記在 `restarts` 與 `history`）；尚未提交的工作每次接續都先丟棄未完成的修改並快轉到目前的 base。
  - Runner 停止不算阻塞：被中止的工作保持 RUNNING，下一輪重做。網路暫時錯誤保留進度，下一輪續做；重啟後失去引擎見證的審查會重新審查（最多 3 次）。每個 Issue 只發一則「開始實作」留言。

### 專案工具鏈的沙箱權限（`--add-dir`、`--network`）

workspace-write 只允許寫入專案 worktree，且禁止網路。有些工具鏈即使只跑本機測試也需要更多權限，執行者因此無法驗證自己的修改，只能盲改：

| 工具鏈 | 需要 | adapter argv |
|---|---|---|
| Flutter（`flutter test`） | 寫入 SDK 的 `bin/cache` 與 `~/.dart-tool`；測試程序綁定 127.0.0.1 | `--add-dir <Flutter SDK> --add-dir <家目錄>/.dart-tool --network` |
| Gradle（Android、React Native／Flutter 的 `android/`） | 寫入 `~/.gradle`（wrapper、依賴快取）；否則執行代理會改用暫存的 `GRADLE_USER_HOME` 與 `user.home`，較慢，且 debug 簽章金鑰不同 | `--add-dir <家目錄>/.gradle`（建議） |

`--add-dir DIR`（可重複，必須是絕對路徑）轉為 `codex exec --add-dir DIR`；`--network` 轉為 `-c sandbox_workspace_write.network_access=true`。Codex 的 macOS 沙箱無法只開放 loopback，`--network` 會同時開放對外網路，也讓執行者能連上本機的 adb server：實測中執行者曾自行建置 APK、解除安裝並重裝模擬器上的受測應用（簽章用它暫時 `user.home` 下的 debug keystore），Android 驅動器因此會替換以其他金鑰簽章的已安裝版本。只在工具鏈確實需要時啟用。兩者都是明確配置的 argv，預設不開；變更後走 `runner configure`。在 `codex sandbox -c sandbox_mode='"workspace-write"' … -- <測試命令>` 中可先確認最小權限。

### 執行者隔離（`ignoreUserConfig`）

預設情況下執行者會載入開發者的 `$CODEX_HOME/config.toml`（通常是 `~/.codex/config.toml`）。若其中啟用 memories，執行 session 可能讀取個人記憶並把內容寫入 EXEC JSONL；交付時獨立 reviewer 會讀這份 trace，等於把與本專案無關的個人資料交給另一個 session 並留在專案證據中。啟用隔離：

```json
{"adapters":{"codex":{"command":{"argv":["node","/absolute/shared/protoflow/scripts/codex-adapter.js"],"timeoutMs":600000},"ignoreUserConfig":true}}}
```

引擎在 stdin JSON 加上 `executor: {"ignoreUserConfig": true}`；內建橋接收到後改為執行 `codex exec --json --sandbox workspace-write --ignore-user-config -c features.memories=false -c approval_policy="never" -`，`executor` 不放入給模型的 Context Package。手動配置 argv 時也可直接在 adapter argv 加 `--ignore-user-config`。自訂 executor adapter 須自行實作此欄位，引擎無法替它保證隔離。獨立 review adapter 一律以 `--ignore-user-config` 執行，不需要也不接受此欄位。

取捨：`--ignore-user-config` 只略過 `config.toml`，登入仍使用 `CODEX_HOME` 的 `auth.json`；但 config 裡的 `model`、推理強度、自訂 `model_providers`／profile、MCP servers、`sandbox_workspace_write`（例如網路存取）與 approval 設定都不再生效。依賴這些設定的專案需改以 adapter argv 的 `--model` 指定模型，或讓 `runner.setup` 先完成需要網路的安裝；只能經自訂 provider 登入的環境無法使用隔離。`$CODEX_HOME/AGENTS.md` 等全域指示與 skills 不屬於 `config.toml`，不在此開關的保證範圍內。欄位預設為 `false`，既有配置行為不變；在已有 Runner worktree 的專案變更需走 `runner configure`。

## 視覺／功能驗證

`verification.build`、`functional` 是 argv 命令。build（含 target 與變體的 `build`）可加 `outputs`：必須產出的檔案或目錄，相對於執行建置的 worktree 根目錄（Runner 在 `.protoflow/runner/worktree-*` 建置，不是專案 checkout），不可為絕對路徑或含 `..`；命令 exit 0 但缺少任一產出時 build 記為 FAIL。build、functional 與 external driver 的命令可加 `devices`：命令會用到、但 argv 沒有寫出的模擬器名稱或 UDID（例如經由 `npm run test:ios`）；驗收期間獨占這些裝置（見 [Git Runner](git-runner.md) 的裝置獨占）。functional 必須接目標專案持久保存的 Playwright regression assets；目標應用的登入 fixture、routes、server 啟動和 API mock 由專案測試負責。引擎測試使用真實 Playwright runner，沒有以手動 browser clicks 取代 E2E。

`visual.scenes` 指定 URL／viewport／fixture／steps／masks／mappings。相對路徑解析為 project-contained file URL，http(s) URL 需先啟動 target server。fixture 透過 `window.__PROTOFLOW_FIXTURE__`、`fixture.localStorage`、`fixture.cookies` 注入；產品需配合消費 fixture。動態時間／隨機資料要自行固定或 mask，外框仍參與 geometry/style 檢查。

目前 `steps.action` 支援 click／fill；更複雜導航與 API 狀態由目標測試或場景 URL 建立。native 模式明確 NOT_RUN。不是所有 test command 名稱都能證明執行了 Playwright；接入者需用自己的回歸 runner，並核對命令 log 與 test artifacts。
