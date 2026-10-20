# 提案 0004：多專案儀表板

| 項目 | 內容 |
|---|---|
| 狀態 | 已接受（2026-10-20），D1–D3 已實作（v0.3.23；v0.3.24 重新設計介面，使用說明見 [docs/dashboard.md](../dashboard.md)）；D4（手機查看）待做 |
| 前置 | [提案 0003](0003-claude-plans-codex-builds.md)、v0.3.22 常駐 Runner 服務 |
| 影響範圍 | Runner 事件持久化、執行代理即時 trace、`dashboard` 命令、本機網頁、面板上的核准操作 |

## 1. 背景：思玥的進度面板

思玥（siyue）以 claude.ai Artifact 做了「思玥重寫進度」面板：

- **靜態部分**：session 暫存區的 Python 產生器讀 OpenSpec `tasks.md`、最新 VER、截圖、`git log` 與手寫 `notes.json`，把資料連同 base64 截圖寫進 HTML（約 340 KB）後發布。
- **即時部分**：session 以 Monitor 跑監看腳本，輪詢 runner 狀態、執行中的程序與 worktree 最近修改的檔案；狀態一變，session 以 ArtifactData 寫入頁面資料庫 `live/runner`，頁面即時訂閱。
- **核准**：頁面資料庫 `approvals` 集合，擁有者按核准或退回後寫回資料庫並以留言通知 Claude，由 session 接手。

版面（先即時工作，再決策、進度、證據）成熟可用。限制：即時與核准都依賴一個持續開著的 Claude session；產生器與監看腳本不在 repo、寫死思玥的路徑與畫面；「Agent 在做什麼」只能從檔案修改時間推測；只看單一專案。

## 2. 決策（使用者確認，2026-10-20）

1. 主要介面是本機網頁（即時、多專案、不依賴 Claude）；手機查看放到 D4。
2. 第一版就要能在面板上核准。
3. 面板與 Runner 一樣以 launchd 常駐、開機啟動。

## 3. 設計

### 3.1 引擎資料（D1）

- **事件持久化**：Runner 每個事件附上時間寫入 `.protoflow/runner/events.jsonl`（超過 5 MB 輪替為 `events.1.jsonl`）。
- **執行代理即時 trace**：執行期間把執行代理的 stdout（Claude stream-json 或 Codex JSONL）同步寫到 worktree 的 `.protoflow/live/execute.jsonl`，面板從中解析真正的動作：讀檔、編輯、執行命令、代理的說明文字。
- **快照**：`protoflow dashboard snapshot` 輸出 `protoflow.dashboard/1` JSON：服務健康、各 target 目前階段與角色模型、即時動作、版本佇列與方案、Issue、最新驗收矩陣與截圖路徑、交付、待處理清單與最近事件。
- **專案登記**：`~/.protoflow/projects.json`；`runner service install` 自動登記，也可 `dashboard add|remove|list`。

### 3.2 本機網頁（D2）

- `protoflow dashboard serve [--port 7420]`：只監聽 127.0.0.1；總覽頁列出所有登記專案，專案頁顯示即時工作、待你處理、版本與 Issue、驗收矩陣與截圖對照、交付與事件。以 SSE 推送快照變化，截圖直接從專案讀取（只允許 `.protoflow/` 內的影像）。
- `protoflow dashboard service install|uninstall|status`：launchd LaunchAgent，登入啟動、異常重啟，與 Runner 服務相同的工具解析與代理傳遞。

### 3.3 核准與操作（D3）

面板上的操作都對應引擎既有的命令與綁定規則，並寫入 `.protoflow/dashboard/actions.jsonl`（時間、操作、操作者、綁定的 hash、結果）：

| 操作 | 適用 | 綁定 |
|---|---|---|
| 核准並合併交付 PR | `runner.delivery.merge: "manual"` 的交付（`PR_OPEN_MANUAL`） | PR 仍開啟、head 等於審查過的交付 commit，以 `--match-head-commit` 合併 |
| 交回 AI | `needs-human`、`blocked`、`rejected` 的 Issue | 以操作者自己的 GitHub 身分移除狀態標籤，引擎記錄 `confirmedBy` |
| 核准版本 | 沒有 `policy.autoApprove`、已 PASS 待人工審查的版本 | `review create` + `approve`，綁定 verification hash，審查者為設定的人名 |
| 重試 | BLOCKED 的版本 | `runner retry` |

安全：伺服器只監聽 127.0.0.1，檢查 `Host` 與 `Origin`，寫入操作需要每次啟動隨機產生、內嵌於頁面的權杖。AI 永遠不會以人的身分核准；面板操作者即本機使用者。L3 ADR 的核准牽涉 Runner worktree 內的檔案，第一版只唯讀顯示。

### 3.4 手機查看（D4，待做）

`protoflow dashboard export` 產生自帶資料的 HTML 快照，由 Skill 發布成 Artifact；核准可沿用思玥的 Artifact 資料庫與留言做法。

## 4. 分階段

| 階段 | 內容 | 驗收 |
|---|---|---|
| D1 | 事件持久化、即時 trace、`dashboard snapshot`、專案登記 | 單元測試；三個專案都能產出快照 |
| D2 | `dashboard serve`、總覽與專案頁、SSE、launchd 服務 | Playwright E2E；實際接上專案 |
| D3 | 核准並合併、交回 AI、核准版本、重試，稽核紀錄 | 單元與 E2E 測試；實際操作一次 |
| D4 | `dashboard export` 與 Artifact 發布；思玥改用引擎面板 | 手機開啟驗證 |
