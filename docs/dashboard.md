# 儀表板

一個本機網頁看所有接入 ProtoFlow 的專案：每個 target 現在在做什麼、執行代理實際的動作、需要你決定的事、驗收矩陣與截圖對照、交付與事件。資料全部來自各專案自己的 `.protoflow/` 狀態，不依賴 Claude session。設計與決策見 [提案 0004](proposals/0004-dashboard.md)。

## 啟用

```sh
# 登記專案（runner service install 會自動登記）
protoflow dashboard add --project /path/to/app [--label 顯示名稱]
protoflow dashboard list

# 常駐服務：登入時啟動、異常重啟（macOS launchd）
protoflow dashboard service install [--port 7420]
protoflow dashboard service status
# 或前景執行
protoflow dashboard serve [--port 7420]
```

打開 `http://127.0.0.1:7420/`。專案登記在 `~/.protoflow/projects.json`；`dashboard remove --project PATH` 取消登記。服務日誌在 `~/.protoflow/dashboard.out.log` 與 `dashboard.err.log`。服務安裝時解析 `git`、`gh` 的絕對路徑並帶入網路代理變數，與 [常駐 Runner](git-runner.md#常駐服務macos-launchd) 相同。

選用設定：

```json
{ "dashboard": { "name": "思玥", "reviewer": "張秋" } }
```

`name` 是面板上的專案名稱（預設為資料夾名稱）；`reviewer` 是在面板上核准版本時記錄的人名（預設為 `git config user.name`），不得以 `ai:` 開頭。

## 畫面

視覺為「清晨觀測台」：霧白底、單一薄荷綠表示健康與進度，琥珀色只用在需要你的地方，唯一的深色面是執行代理的終端機。文字精簡，狀態用圖形表達；動效只放在有即時狀態的地方（脈動、管線流光、圓環填充、終端機游標），進場動畫只在進入頁面時播一次，即時更新不重播，系統開啟「減少動態效果」時全部停用。介面支援淺色與深色模式，手機寬度下單欄排列。

- **總覽**：一句話標題（專案數、等你決定的件數）與三個圓環（常駐、進行中、等你）；每個專案一張卡：Runner 狀態、每個 target 一條迷你管線（規劃 → 實作 → 驗收 → 審查 → 交付，進行中的路段有流光）、規劃者與前後端執行者的頭像（O = Opus、S = Sonnet、C = Codex）、待你的數量、未結 Issue 數與最後事件時間。有 target 正在工作時，卡片頂端有流光，並多一條即時進度：目前版本、階段與第幾輪、經過時間，以及執行代理最新的一個動作與累計的編輯／命令數。
- **專案**：
  - **角色與狀態**：規劃、前端、後端各用哪個模型（滑過顯示完整名稱），Runner 狀態、ADR 狀態、合併與批准方式。
  - **管線**：所有 target 收在同一張卡，每個 target 一列、階段名稱只在表頭出現一次；已完成節點打勾、目前節點脈動，旁邊是目前版本摘要、階段與經過時間；阻塞時顯示原因。
  - **終端機**：沒有代理在工作時收成一條；工作時逐行顯示它的實際動作（說明、讀檔、編輯、執行的命令、結束），底部列出改動的檔案；取自執行期間寫入 worktree 的 `.protoflow/live/execute.jsonl`。
  - **需要你**：見下節；核准成功後卡片轉為已簽署狀態。
  - **原型 ↔ App**：最新驗收的通過率圓環、建置／功能測試／比對狀態，以及每個場景的原型與 App 截圖並排放在仿真機框（手機、平板或瀏覽器，依變體與 target 平台判斷）；四個圓點依序代表結構、配色、版面（必須通過）與視覺（原生平台僅供參考）。多 target 或多變體可切換。點任一張截圖開啟大圖對照：「並排」顯示原型與 App 原尺寸，「疊圖」把兩張疊在一起、拖動分界線比對差異；下方列出各層結果與原因，← → 切換場景，Esc 關閉。
  - **版本、交付、Issue、動態**：版本時間軸、交付與 PR、Issue 狀態，以及帶近一小時事件量曲線的事件流（`.protoflow/runner/events.jsonl`）。

頁面以 server-sent events 即時更新，只在內容變化時重繪。`protoflow dashboard snapshot --project PATH` 輸出同一份資料（`protoflow.dashboard/1` JSON）。

## 待你處理與核准

| 項目 | 何時出現 | 面板操作 | 綁定 |
|---|---|---|---|
| 交付 PR 待你合併 | `runner.delivery.merge: "manual"` 的交付已通過驗證與獨立審查 | 核准並合併 | PR 仍開啟、head 等於審查過的交付 commit 才以 `--match-head-commit` 合併；以你的 GitHub 身分執行，交付紀錄寫入 `manualMerge` |
| Issue 需要你決定 | Issue 為 `needs-human`、`blocked` 或 `rejected` | 交回 AI | 以你的 GitHub 身分移除狀態標籤；Runner 下一輪確認你有寫入權限後重新分流 |
| 版本待人工核准 | 沒有 `policy.autoApprove` 的專案，已 PASS 的版本 | 核准版本 | 在該 target 的 Runner worktree 建立並核准審查，綁定驗收 hash，複製回專案；審查者為 `dashboard.reviewer` |
| 版本阻塞 | 目前版本 BLOCKED | 重試 | `runner retry`（先處理阻塞原因） |

每個操作都要先在對話框確認，結果（含失敗）寫入專案的 `.protoflow/dashboard/actions.jsonl`。AI 不會透過面板以人的身分核准；請求中指定的審查者會被忽略。L3 架構決策（ADR）目前只顯示狀態，核准仍在 ADR 檔案中進行。

## 安全

伺服器只監聽 127.0.0.1，拒絕其他 `Host` 與跨來源的 `Origin`；寫入操作需要每次啟動時隨機產生、只內嵌在頁面裡的權杖。截圖只提供專案 `.protoflow/artifacts/` 內的 PNG／JPEG。

## 尚未支援

手機查看（提案 0004 D4）：計畫以 `dashboard export` 產生快照並由 Skill 發布成 Artifact。
