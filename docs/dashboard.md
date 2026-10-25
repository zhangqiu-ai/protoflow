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

維護者豁免（[提案 0005](proposals/0005-maintainer-waivers.md)）需另外啟用，列出可以決定豁免的人；面板上的 `reviewer` 必須在這份名單裡才能核准、拒絕或撤回豁免：

```json
{ "policy": { "waivers": { "reviewers": ["張秋"] } } }
```

`reviewers` 至少一個、不重複，不得以 `ai:` 開頭。沒有這個欄位時整個功能關閉，申請也會被拒絕。

## 畫面

視覺為「清晨觀測台」：霧白底、單一薄荷綠表示健康與進度，琥珀色只用在需要你的地方，唯一的深色面是執行代理的終端機。文字精簡，狀態用圖形表達；動效只放在有即時狀態的地方（脈動、管線流光、圓環填充、終端機游標），進場動畫只在進入頁面時播一次，即時更新不重播，系統開啟「減少動態效果」時全部停用。介面支援淺色與深色模式，手機寬度下單欄排列。

- **側邊欄**：每一頁左側都列出總覽、「等你」（全部待你的數量）與所有專案；每個專案一列：名稱、最需要注意的 target 所在階段（阻塞優先，其次進行中，否則完成／閒置）、五格階段進度、狀態點（進行中脈動、阻塞為紅）與待你的數量，點一下即切換到該專案，選取標記會滑到目前頁面。<kbd>⌥</kbd>+<kbd>↑</kbd>／<kbd>↓</kbd> 在任何位置切換上一個／下一個專案，焦點在清單內時 <kbd>↑</kbd> <kbd>↓</kbd> 移動焦點；<kbd>[</kbd> 或頂端按鈕把側邊欄收成只剩圖示（待你數量改為角標，滑過顯示專案名稱與狀態），選擇記在瀏覽器裡。寬度 900px 以下改為抽屜：按頂端按鈕開啟，選定頁面、點遮罩或按 Esc 關閉。
- **等你（收件匣）**：所有專案需要你的事集中在一頁，依專案分組，最緊急的在前（Runner 異常 → 阻塞 → 審查未過／豁免待核准 → 可合併／待核准 → Issue），卡片與操作和專案頁相同，可直接在這裡處理。總覽標題的「N 件等你決定」連到這裡。
- **分頁標題與通知**：分頁標題與圖示顯示待你的件數（例如「(3) ProtoFlow 儀表板」），切到別的分頁也看得到。在「等你」頁按「開啟桌面通知」並允許瀏覽器通知後，頁面在背景時出現新的待辦會發出桌面通知（點一下回到該專案）；頁面在前景時改為頁內提示。通知只在儀表板頁面開著（可在背景）時運作，選擇記在瀏覽器裡。
- **總覽**：一句話標題（專案數、等你決定的件數）與三個圓環（常駐、進行中、等你）；每個專案一張卡：Runner 狀態、每個 target 一條迷你管線（規劃 → 實作 → 驗收 → 審查 → 交付，進行中的路段有流光）、規劃者與前後端執行者的頭像（O = Opus、S = Sonnet、C = Codex）、待你的數量、未結 Issue 數與最後事件時間。有 target 正在工作時，卡片頂端有流光，並多一條即時進度：目前版本、階段與第幾輪、經過時間，以及執行代理最新的一個動作與累計的編輯／命令數。
- **專案**：
  - **角色與狀態**：規劃、前端、後端各用哪個模型（滑過顯示完整名稱），Runner 狀態、ADR 狀態、合併與批准方式。
  - **管線**：所有 target 收在同一張卡，每個 target 一列、階段名稱只在表頭出現一次；已完成節點打勾、目前節點脈動，旁邊是目前版本摘要、階段與經過時間；阻塞時顯示原因。
  - **終端機**：沒有代理在工作時收成一條；工作時逐行顯示它的實際動作（說明、讀檔、編輯、執行的命令、結束），底部列出改動的檔案；取自執行期間寫入 worktree 的 `.protoflow/live/execute.jsonl`。
  - **需要你**：見下節；核准成功後卡片轉為已簽署狀態。阻塞的版本、交付、Issue 與 Runner 異常，若原因是可辨識的失敗，卡片會附上診斷：哪一種問題（例如「Claude 登入失效」、網路或代理、額度、磁碟空間、找不到命令、缺少設定、超時、權限、分支衝突）、處理步驟與可一鍵複製的命令；處理後按「已處理，重試」。無法辨識的原因只顯示原文。阻塞的版本帶 Runner 的 `reasonCode` 時先依代碼診斷（`environment` 再依原文分辨登入、網路或建置環境（建置在這台機器上跑不起來，例如 hermes-engine 退回原始碼建置而缺 cmake），`stalled` 為「修復沒有進展」，`repair-limit` 為「修復次數用完」，`base-moved` 為「基底分支已移動」並附 `protoflow runner rebase`）。每張卡片右上角顯示已等待的時間（例如「等了 3 小時 5 分」），快照的 attention 項目以 `since` 欄位提供開始等待的時間，未知時為 `null`。
  - **原型 ↔ App**：最新驗收的通過率圓環、建置／功能測試／比對狀態，以及每個場景的原型與 App 截圖並排放在仿真機框（手機、平板或瀏覽器，依變體與 target 平台判斷）；四個圓點依序代表結構、配色、版面（必須通過）與視覺（原生平台僅供參考）。用維護者豁免通過的層級是紫色圓點、場景標示「附豁免」，大圖對照的層級標示「附豁免通過」，通過率旁註明其中幾個場景附豁免；圓點滑過顯示豁免編號。多 target 或多變體可切換。點任一張截圖開啟大圖對照：「並排」顯示原型與 App 原尺寸，「疊圖」把兩張疊在一起、拖動分界線比對差異；下方列出各層結果與原因，← → 切換場景，Esc 關閉。
  - **維護者豁免**：啟用豁免且有已決定的豁免時出現：每筆的狀態（已核准、已拒絕、已撤回）、場景與層級、發現數、原因與編號，已核准的可按「撤回」。核准者名單顯示在標題列。
  - **版本、交付、Issue、動態**：版本時間軸（驗收用到豁免的版本標示「附豁免通過 N 項」）、交付與 PR、Issue 狀態，以及帶近一小時事件量曲線的事件流（`.protoflow/runner/events.jsonl`）。

頁面以 server-sent events 即時更新，只在內容變化時重繪；側邊欄在整個瀏覽期間沿用總覽的資料流，專案頁另開該專案的資料流。伺服器對同一個畫面只輪詢一次，結果分給所有開著的頁面，同一時間總覽與專案頁讀同一個專案也只讀一次；沒有頁面在看的畫面停止輪詢，專案頁切到背景時暫停它的資料流，回到前景再接上。`protoflow dashboard snapshot --project PATH` 輸出同一份資料（`protoflow.dashboard/1` JSON）。

## 待你處理與核准

| 項目 | 何時出現 | 面板操作 | 綁定 |
|---|---|---|---|
| 交付 PR 待你合併 | `runner.delivery.merge: "manual"` 的交付已通過驗證與獨立審查 | 核准並合併 | PR 仍開啟、head 等於審查過的交付 commit 才以 `--match-head-commit` 合併；以你的 GitHub 身分執行，交付紀錄寫入 `manualMerge`；直接在 GitHub 合併的 PR 在下一次 `delivery sync` 記為 `manualMerge`（`via: "github"`）後，這張卡片就不再出現 |
| Issue 需要你決定 | Issue 為 `needs-human`、`blocked` 或 `rejected` | 交回 AI | 以你的 GitHub 身分移除狀態標籤；Runner 下一輪確認你有寫入權限後重新分流 |
| 版本待人工核准 | 沒有 `policy.autoApprove` 的專案，已 PASS 的版本；有開 autoApprove 的專案只限驗收用到維護者豁免的版本（交付停在 `WAIVER_APPROVAL_REQUIRED`，卡片註明附豁免通過幾項） | 核准版本 | 在該 target 的 Runner worktree 建立並核准審查，綁定驗收 hash，複製回專案；審查者為 `dashboard.reviewer` |
| 豁免待核准 | 有 `requested` 的維護者豁免（CLI 申請，或 runner 依修復代理標示的引擎限制自動申請） | 核准豁免／拒絕 | 卡片附那次驗收的原型與 App 截圖（申請時複製到 `.protoflow/artifacts/<WVR-id>/`）、原因、引擎問題與發現全文；`dashboard.reviewer` 必須列在 `policy.waivers.reviewers`。核准寫入 `waiverHash`，綁定 target、場景、變體、層級、版本的 `manifestHash` 與發現；下一次驗收發現仍是子集時才套用 |
| 撤回豁免 | 「維護者豁免」區塊裡已核准的豁免 | 撤回 | 豁免改為 `revoked`，下一次驗收不再套用；已經用它通過的驗收保留原紀錄 |
| 審查未過 | 交付被獨立審查判為 FAIL 並附發現（沒有 `policy.autoApprove` 的專案；有開的專案由 runner 自動退回，退回超過 3 次才交給人） | 退回重修 | 以 `dashboard.reviewer` 的名字對該版驗收記錄人工「要求修改」（`changes_requested`），帶上審查的發現；Runner 下一輪重開版本、撤回被否決的交付，執行代理帶著發現修復。被否決的版本不再出現在「版本待人工核准」 |
| 版本阻塞 | 目前版本 BLOCKED | 重試 | `runner retry`（先處理阻塞原因） |

每個操作都要先在對話框確認，結果（含失敗）寫入專案的 `.protoflow/dashboard/actions.jsonl`。AI 不會透過面板以人的身分核准；請求中指定的審查者會被忽略。L3 架構決策（ADR）目前只顯示狀態，核准仍在 ADR 檔案中進行。

## 安全

伺服器只監聽 127.0.0.1，拒絕其他 `Host` 與跨來源的 `Origin`；寫入操作需要每次啟動時隨機產生、只內嵌在頁面裡的權杖；服務重啟後仍開著的頁面送出舊權杖被拒時，會從頁面重新取得目前的權杖再送一次。截圖只提供專案 `.protoflow/artifacts/` 內的 PNG／JPEG。

## 尚未支援

手機查看（提案 0004 D4）：計畫以 `dashboard export` 產生快照並由 Skill 發布成 Artifact。
