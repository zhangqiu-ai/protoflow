# 提案 0003：Claude 規劃與驗收、Codex 實作；GitHub Issues 自動處理

| 項目 | 內容 |
|---|---|
| 狀態 | 已接受（2026-10-14），決策見 §9；P1–P5 已實作，P6 待真實驗收 |
| 前置 | [提案 0001](0001-anchor-contracts.md)（錨點、分層驗收、獨立審查）、[提案 0002](0002-android-flutter.md)、v0.3.6 |
| 影響範圍 | 新增規劃者角色與 Claude adapter；獨立審查改為可插拔供應者並預設 Claude；新增 Issue 串流（收件、分流、執行、交付、結案） |

## 1. 摘要

目前同一個供應者（Codex）既實作又審查，規劃則隱含在執行代理的單次 prompt 裡。本提案把角色分開，並套用到兩條流程：

| 角色 | 供應者 | 權限 | 產出 |
|---|---|---|---|
| 規劃者（planner） | Claude | 唯讀 | 方案：決定、範圍、步驟、驗收條件、需新增的測試、風險 |
| 執行者（executor） | Claude Sonnet（預設）；Codex（額度不足或並行時） | worktree 可寫（沙箱） | 程式碼與測試修改 |
| 驗證（verification） | 引擎 | 執行 build、functional、T1–T4 | 確定性的分層結果 |
| 驗收者（acceptor） | Claude | 唯讀、全新 session | 逐條對照驗收條件與證據的 verdict |

兩條流程：

1. **原型對齊**（既有）：原型版本 → Claude 規劃 → Codex 實作 → 分層驗收（有界修復）→ Claude 驗收 → 自動批准 → 交付。
2. **GitHub Issues**（新增）：帶標籤的 Issue → Claude 分流與規劃 → Codex 實作 → 該 target 的完整驗收（含原型一致性回歸）→ Claude 驗收 → PR `Fixes #n` → 合併並結案。

執行者與驗收者來自不同供應者，獨立性不再只靠「不同 session」。分層驗收仍是確定性的閘門，Claude 驗收不能取代它，只能在其之上判斷。

## 2. 現況與缺口

| 項目 | 現況 |
|---|---|
| 規劃 | 沒有獨立規劃步驟；Codex 從 context 直接實作，驗收條件只有原型錨點契約 |
| 審查 | `scripts/codex-review-adapter.js`；閘門寫死 `provider: "codex"` 與 Codex JSONL trace 格式 |
| Issues | 不處理；Issue 只能由人轉成原型變更或手動修改 |
| Claude CLI | 本機桌面 app 內建 CLI 可非互動執行（`-p --output-format json --json-schema --tools`），但獨立程序未登入 |

## 3. Claude adapter（共用）

一支 `scripts/claude-adapter.js`，以模式區分規劃與驗收，引擎透過明確配置的 argv 與 stdin JSON 呼叫（沿用 AGENTS.md 的整合原則）：

```text
claude -p --output-format stream-json --verbose --json-schema <schema>
       --tools Read,Grep,Glob --permission-mode dontAsk
       --no-session-persistence --setting-sources "" --strict-mcp-config
       --model <model> --max-budget-usd <limit>
```

- **唯讀**：`--tools` 只開 `Read`、`Grep`、`Glob`；不開 Bash、Edit、Write、WebFetch、MCP。
- **隔離**：不載入使用者設定（`--setting-sources ""`）、不持久化 session、每次全新 session。
- **結構化輸出**：`--json-schema` 強制 verdict／plan 格式；引擎再以自己的 schema 驗證。
- **可驗證的 trace**：保存完整 stream-json。引擎檢查 trace 中只有一個 session、結果 `success`、`structured_output` 存在，並逐一檢查 `tool_use` 名稱都在允許清單內。任何寫入或執行類工具出現就 BLOCKED。
- **成本上限**：`--max-budget-usd` 與 adapter 的 `timeoutMs`。
- **登入**：使用者以 `claude setup-token` 取得長期 token，放在啟動 ProtoFlow 的環境變數（`CLAUDE_CODE_OAUTH_TOKEN`），或使用 `ANTHROPIC_API_KEY`。ProtoFlow 不保存、不讀取、不轉送憑證，只把環境原樣交給子程序；缺少時該步驟為 `NOT_RUN`。
- **可執行檔綁定**：與 Codex 相同，從可信 PATH 或明確路徑解析 `claude`，絕對路徑與 SHA-256 綁定進 request 與 run。

## 4. 規劃者

### 4.1 輸入與輸出

輸入（stdin JSON，全部標為不受信任資料）：原型版本的 manifest 與錨點契約、或 Issue 標題／內文／留言；target 配置摘要；上一個被拒或失敗嘗試的證據摘要（若有）。

輸出（`PLN-*` 紀錄，存於 `.protoflow/plans/`，hash 綁定）：

```json
{
  "decision": "implement | needs-info | needs-human | reject",
  "level": "L1 | L2 | L3",
  "targets": ["ios"],
  "summary": "…",
  "steps": ["…"],
  "acceptanceCriteria": [{ "id": "AC1", "text": "…", "evidence": "test | tier | screenshot | code" }],
  "tests": ["…"],
  "risks": ["…"],
  "questions": ["…"]
}
```

### 4.2 規則

- **原型流程**：決定只能是 `implement` 或 `needs-human`。原型版本是權威，方案不能刪減錨點契約；驗收條件至少涵蓋版本中每個變更的錨點與狀態。
- **L3** 一律 `needs-human`：沿用提案 0001，架構決策仍需人類 ADR。
- 方案進入 Codex context 的 `plan` 欄位，指示文字說明：方案是規劃者的建議，原型與分層驗收才是權威；與兩者矛盾的步驟不實作，在報告中說明。
- **重新規劃**：修復次數用盡、或同一版本被驗收者拒收時，下一輪先重新規劃，並帶上失敗證據。實作上版本每次開始執行都會重新規劃：資料帶 `rejections` 與 `previous`（上一份方案、嘗試次數、最後的失敗原因）。
- 原型流程的方案每條驗收條件另帶 `anchors`（涉及的錨點 id）；`targets`、`needs-info`、`reject` 留給 Issues 流程（P4）。

## 5. 驗收者（獨立審查改為可插拔，預設 Claude）

- `adapters.independentReview` 改為 `{ provider: "claude" | "codex", command }`；預設 Claude。既有 Codex 路徑保留，作為替代與回退。
- 閘門的 run 協定新增 `provider: "claude"`，配對 Claude trace 驗證器（§3）。其餘綁定不變：requestId、bindingHash、commit、tree、base、verification、executor provenance、live attestation、merge identity。
- 驗收提示在既有內容之外，加上方案的 `acceptanceCriteria`。verdict 新增 `criteria`：逐條 `{ id, status: PASS|FAIL|NOT_RUN, evidence }`。任何一條 FAIL 或有 finding，就是 FAIL。
- 獨立性檢查：驗收者 session 不得等於任何執行者或規劃者 session，供應者與執行者不同時記錄 `crossProvider: true`。
- 自動拒收（v0.3.5）與重新審查（v0.3.5）照常適用。

## 6. GitHub Issues 串流

### 6.1 收件

- `issues.label`（預設 `protoflow`）的開啟 Issue，依編號 FIFO。
- **作者授權**：只有 `author_association` 為 OWNER、MEMBER、COLLABORATOR 的 Issue 會自動處理；其他加上 `protoflow:needs-human`，等人確認後重新加標籤。
- 以 `gh api` 讀取並快照（標題、內文、留言、標籤、作者），hash 綁定成 `ISS-<n>-<hash>` 紀錄。Issue 內容在執行期間被修改時，以快照為準，結案留言會註明。

### 6.2 分流與標籤生命週期

| 標籤 | 意義 |
|---|---|
| `protoflow` | 待處理 |
| `protoflow:planned` | 已出方案，方案以留言發布（標示為 AI） |
| `protoflow:needs-info` | 規劃者提出問題（留言），等待補充；有新留言後重新規劃 |
| `protoflow:needs-human` | L3、未授權作者、或規劃者判斷需人工 |
| `protoflow:rejected` | 規劃者判斷無效或重複，附理由，不自動關閉 |
| `protoflow:in-progress` | 執行中 |
| `protoflow:blocked` | 修復用盡或閘門 BLOCKED，留言附證據 |
| `protoflow:done` | PR 合併，Issue 由 `Fixes #n` 關閉 |

### 6.3 執行、驗收與交付

- **worktree 與分支**：每個 target 一個 Issue worktree（`worktree-<hash>-issues-<target>`），分支 `protoflow/issue-<n>`。從當前 base 開始；跨 target 的 Issue 依方案拆成每個 target 一個交付。
- **排程**：原型串流優先；某 target 的原型串流閒置時才處理該 target 的 Issue，避免兩條流程同時修改同一批檔案。
- **驗證**：該 target 的 build、functional，以及對**最新已接受原型版本**的完整分層驗收。修 Issue 不能破壞原型一致性。另外，方案要求新增的測試必須出現在 diff 中，且 functional 通過。
- **驗收與交付**：Claude 驗收 → 自動批准（`policy.autoApprove`）→ PR 標題 `Fix #n: …`，內文 `Fixes #n`，附方案、驗收條件逐條結果與證據 → 合併 → Issue 自動關閉，加上 `protoflow:done` 與結案留言。
- **衝突**：Issue 合併使 base 前進時，原型串流沿用 v0.3.3 起的整合與 reverify 規則。

### 6.4 安全

- Issue 內容是不受信任的資料（prompt injection）：三個角色的提示都明確標示；執行者沙箱不開放額外權限；Issue 中的指令、連結、附件不會被執行或下載。
- 規劃者與驗收者唯讀，且 trace 驗證工具清單；執行者的修改只經由交付 commit 進入共用分支，並受 hygiene 與 scope 檢查。
- 只處理授權作者的 Issue；不處理含 `secrets`、`.env`、憑證路徑的修改（沿用交付的 protected path）。
- GitHub 寫入只用既有 `gh` 登入：留言、標籤、PR、合併。所有 AI 產出都標示為 AI，不冒充人類。

## 7. 配置

```json
{
  "adapters": {
    "codex": { "command": { "argv": ["node", "/abs/protoflow/scripts/codex-adapter.js", "--model", "…"] } },
    "planner": { "command": { "argv": ["node", "/abs/protoflow/scripts/claude-adapter.js", "--model", "claude-opus-5-5", "--max-budget-usd", "5"] } },
    "independentReview": { "provider": "claude", "command": { "argv": ["node", "/abs/protoflow/scripts/claude-review-adapter.js", "--model", "claude-opus-5-5", "--max-budget-usd", "5"] } }
  },
  "issues": { "enabled": true, "label": "protoflow", "authors": ["OWNER", "MEMBER", "COLLABORATOR"], "targets": ["ios", "android", "flutter"] }
}
```

未配置 `adapters.planner` 時維持現行行為（Codex 直接依 context 實作）；`independentReview.provider` 省略時為 `codex`，既有專案相容。

## 8. 分階段計畫

| 階段 | 內容 | 完成條件 |
|---|---|---|
| P1 Claude adapter | `scripts/claude-adapter.js`、可執行檔解析、trace 驗證器、假 CLI fixture | 單元測試：唯讀工具驗證、結構化輸出、NOT_RUN／BLOCKED 分類 |
| P2 Claude 驗收者 | 閘門可插拔供應者、`criteria` verdict、cross-provider 記錄 | 既有交付測試全過；Claude 供應者的假 CLI 測試 |
| P3 規劃者（原型流程） | `PLN` 紀錄、context `plan`、重新規劃 | 單元與 E2E；未配置時行為不變。**已實作**：`src/planner.js`、runner 規劃步驟、交付綁定 `versions[].plan`（見 [integrations](../integrations.md#claude-規劃者提案-0003)） |
| P4 Issues 收件與分流 | 輪詢、授權、快照、標籤、留言 | 假 `gh` 測試涵蓋每個標籤轉換。**已實作**：`src/issues.js`、`protoflow issues sync|status`、runner 每輪分流（見 [integrations](../integrations.md#github-issues-收件與分流提案-0003-p4)） |
| P5 Issues 執行與交付 | Issue worktree、驗證、PR `Fixes #n`、結案 | 本機 Git fixture 走完一次 Issue 交付。**已實作**：`src/issue-runner.js`；Issue 修改在閒置 target 的 runner worktree 內進行（不另建 worktree），以 reverify 最新已接受版本作為原型一致性回歸 |
| P6 真實驗收 | protoflow-test：一個新原型版本與 3 個 Issue（UI 修正、邏輯修正、需補充資訊）全程零介入 | 全部合併或正確停在 `needs-info`；證據紀錄 |

版本依 AGENTS.md 只遞增第三段，每個階段可獨立發布。

## 9. 決策

使用者已確認（2026-10-14）：

1. **角色**：Claude 規劃與驗收、Codex 實作，原型對齊與 GitHub Issues 兩條流程一致。
2. **模型與執行者**：規劃與驗收用 `claude-opus-5-5`。**執行者預設 Claude Sonnet（`claude-sonnet-5-5`）**；Sonnet 額度不足（限流、用量上限）時，同一個 attempt 自動改由 Codex 重做；需要並行時（例如多個 target 同時處理），額外的工作交給 Codex。Claude 執行者在 worktree 內可寫，沙箱強度不得低於 Codex `workspace-write`，並沿用 hygiene 與 scope 檢查。執行者與驗收者同為 Anthropic 時，獨立性由全新 session、不同模型、驗收者唯讀（trace 證明）以及 session 不重複保證，紀錄 `crossProvider: false`。
3. **原型流程也先經過 Claude 規劃**：方案把每個錨點與狀態轉成逐條驗收條件。
4. **原型優先**：某個 target 的原型串流閒置時才處理它的 Issue。
5. **Codex 審查保留為替代供應者**，主要使用 Claude 驗收；新專案預設 Claude。

依授權決定（可調整）：每次規劃或驗收預設上限 5 美元；只自動處理 OWNER／MEMBER／COLLABORATOR 的 Issue。

需要使用者處理：**Claude 非互動登入**。請在一般終端機安裝獨立的 Claude Code CLI 後執行 `claude setup-token`，把產生的 token 設為啟動 ProtoFlow 的環境變數 `CLAUDE_CODE_OAUTH_TOKEN`；或提供 `ANTHROPIC_API_KEY`。在此之前，P1–P5 以假 CLI 完成開發與測試，P6 真實驗收等登入完成後進行。
