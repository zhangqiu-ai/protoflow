---
name: protoflow
description: Use ProtoFlow to turn prototype changes into mapped application changes with design sessions, change manifests, policy gates, verification, and human review in configured projects.
---

# ProtoFlow

ProtoFlow 是共享引擎。本 Skill 引導設計輸入到正式實作的流程，目標專案只保留 Skill、`protoflow.config.json`、`AGENTS.md` 約定與 `.protoflow/` 證據。使用已安裝的 `protoflow` CLI；若命令不可用，先定位共享引擎並使用 `node <engine>/bin/protoflow.js`，不要將引擎複製進目標專案。

## 語意錨點（schemaVersion 2）

`protoflow.config.json` 為 `schemaVersion: 2` 時以錨點取代 mapping（共享引擎 `docs/proposals/0001-anchor-contracts.md`）：

- 原型每頁一個畫面錨點（`<body data-pf="<screen>" data-pf-role="screen">`），追蹤的元素以 `data-pf="<screen>.<name>"` 標記，`data-pf-role` 為 region／element／action／input；狀態寫在 `<page>.pf.json`。新頁面或缺錨點時先執行 `protoflow anchors suggest --patch-file .protoflow/anchors.patch`，把建議交給使用者審閱 ID 後才提交原型；不要自行在原型 repo 推送錨點修改。`protoflow anchors lint` 必須 PASS。
- 實作時讀 context 的 `anchors`：`screens` 是本版受影響畫面的合約，`target.convention` 說明本平台如何帶上錨點 ID，`anchorIndex` 列出既有錨點在程式碼中的位置。每個錨點必須以**完全相同的 ID** 出現在應用中；畫面需可由 `urlTemplate`（Web）或外部驅動器到達。以錨點 ID 搜尋程式碼找實作位置，不需要也不要新增 mapping。
- verify 的 `visual.tiers` 依序是 structure（文字、數量、順序、互動、sidecar 期望）、tokens、layout、visual；`visual.scenes[].tiers[].reasons` 指出具體錨點。修復時依原因修改應用，不修改原型、合約或門檻。
- v1 專案遷移：`protoflow migrate anchors` 產生草稿（原型 patch、應用 patch、v2 配置）；原型 patch 屬設計端，套用前需使用者確認。

## 原型結構與映射（schemaVersion 1）

按可獨立瀏覽、修改及驗收的頁面適度拆分原型，再抽出實際共用的 tokens、styles、scripts 與 assets。保留既有應用元件架構，不將原型目錄鏡像到應用；同一 HTML 可列入多筆 mapping，分別指向頁面中不同區域的應用元件。不要套用其他專案或範例的頁面、元件名稱。

每個 mapping 的 `prototypeFiles` 明確包含其頁面與消費的共用資源；修改共用檔案時，核對所有命中的 mapping 及相應驗證場景。引擎採檔案粒度的保守展開，selector 只定位／驗證，不能根據某個 DOM 區塊、CSS 變數或 import 推測引擎已排除其他影響。移動／刪除檔案時同步資源引用、映射、場景與回歸測試；調整後建立新 checkpoint／context，不沿用過期證據。

建立或補齊映射時，先執行 `protoflow mappings suggest --project <root>` 取得依目標專案原型頁面與引用資源產生的草稿；再閱讀應用程式碼，為每個區域填入實際存在的 `component` 與兩邊 selector，必要時把一頁拆成多筆 mapping，並核對 `sharedResources`、`orphanFiles`、`unmappedFiles`。草稿不寫入配置，修改配置前向使用者說明對應關係。拆分方法見共享引擎的 `docs/prototype-structure.md`；`examples/modular/` 只是示範專案。本機 checkpoint 保存 hash 與 Git evidence；Git source checkpoint 額外固定來源 SHA，不自動 commit。

## GitHub 提交來源與本機 Runner

配置 `source.kind: git` 時，正式應用由指定 GitHub repo／branch／path 的提交觸發；不要啟動本機 `watch` 或用現行 prototype 檔案建立應用版本。讀共享引擎 `docs/git-runner.md` 與 `templates/protoflow.git.config.json`。`init --repository URL --branch BRANCH --path PATH [--start-sha SHA]` 可接入新專案，既有設定須明確合併；安裝 Skill 不會啟動背景程序。

先 `doctor`、`source scan`、`queue`，核對 frozen checkpoint 與 mapping，再於既有授權範圍啟動 `runner start [--once]`。Runner 在隔離 worktree 逐筆 execute／verify／bounded repair，Skill 本身不常駐；不用開機服務或擴大登入權限。source state 的 scannedSha 與 completedSha 不同，只有前版全部 PASS 才可前進。`runner status` 顯示每版 attempts、verificationId 與 worktree；截圖須綁定 manifestHash／prototypeHash／Git SHA。

BLOCKED／STOPPED／中斷 RUNNING 時先閱讀 execution／verification 的實際錯誤、保存已有修改，解決原因後才 `runner retry`。操作設定修改需先 `runner configure` 保存前後設定綁定，再 retry；不能變更來源與 mapping 所有權。不刪除／偽造進度、不跳到較新 SHA、不關閉 FIFO。歷史重寫應明確報告並停止。GitHub 推送／新建遠端分支必須在使用者已授權的具體範圍；本機 Git fixture 必須標記為 fixture，不能冒充真實來源驗收。L2／L3 規格與人工 ADR 邊界沿用既有流程，Runner 可配置 `runner.spec`／`runner.adr`。

以下 session／watch 步驟只供未配置 Git source 的相容本機設計流程。

## 工作流程

1. 讀取專案約定與配置。尚未接入時執行 `protoflow init --project <root>` 與 `protoflow install --project <root>`，再設定 prototype → application/component 映射。既有配置與 Skill 安裝會保留。`install` 也會安裝 Spec Kit 與 BMad（已存在則略過）：把結果中的 `notices` 與各整合的 `changed` 檔案告訴使用者，安裝失敗時給出手動命令；BMad 安裝後提醒使用者執行 `bmad setup`。`protoflow status` 可查看兩者是否已安裝。
2. 原型可隨時修改並 checkpoint，多個版本會排隊。**推進正式應用前先執行 `protoflow queue --project <root>`**，只處理 `current` 版本，完成它的 context → execute → verify（或 repair）直到 PASS，再處理下一個；不要跳到 `waiting` 中較新的版本，也不要把多個版本合併成一次實作。實作時讀取 context 的 `prototypeVersion.prototypeDir`（該版本的凍結副本），不要讀現行 `prototypeDir`，因為它可能已是更新的版本。命令回傳 `BLOCKED`（退出碼 3）代表跨版本操作，應回到 `queue.current`；不得設定 `policy.sequentialVersions: false`、刪除或偽造 `.protoflow/` 證據來繞過順序。
3. `protoflow session start --project <root>` 建立 Design Session；讓 `protoflow watch --project <root>` 收集 prototype 變更，或使用 `protoflow checkpoint --project <root> --session <id> --summary "設計變更"` 明確建立 checkpoint。`--level` 是使用者意圖；政策只能提高最低等級。
4. 讀取 checkpoint 的 Git diff、Change Manifest、映射與分類理由。L0 樣式／視覺細節；L1 局部 UI 結構／互動；L2 資料／API 等功能變更需 Spec Kit 證據；L3 架構／安全影響另需 BMad／ADR 證據。配置外部工具時讀取 [整合邊界](references/integrations.md)。
5. 使用 `protoflow context --project <root> --manifest <id>` 取得執行上下文。L2/L3 依需要提供 `--spec <path>`、`--adr <path>`。只改 manifest 映射範圍；未映射輸入先修正配置，不能擅自猜測目標元件。
6. 配置 Codex adapter 後，執行 `protoflow execute --project <root> --context <id>` 檢查乾跑 request，再於授權範圍內加上 `--execute` 實際執行；也可由目前 Codex 依上下文直接實作，再執行 verify。
7. `protoflow verify --project <root> --manifest <id>` 執行 build、functional、visual，原型端使用該版本的凍結副本。PASS 後佇列前進到下一個版本。新增／變更／修復功能需維護目標專案 Node.js Playwright 回歸測試並使用 runner。尚未配置或尚未執行的驗證是 `NOT_RUN`，不能當作通過。
8. 失敗時執行 `protoflow repair --project <root> --manifest <id> --execute`；它依配置的 `maxRepairAttempts` 停止。讀取每次驗證與修復記錄，上限耗盡或缺少外部 adapter 時報告具體阻塞。
9. `protoflow review create --project <root> --manifest <id> --verification <id>` 建立人工 Review。將實際差異與驗證證據呈現給使用者；只有明確人類批准後才執行 `protoflow review approve --project <root> --review <id> --reviewer <human-id>`。不要將自己的判斷登記為人類批准。專案配置 `policy.autoApprove: true` 時，Runner 交付流程會自動以 `ai:protoflow-runner` 批准並標記 `automated`；不要手動用 `--reviewer` 模擬此動作，也不要把 L3 ADR 當成可自動批准。
10. `protoflow baseline create --project <root> --review <id>` 保存已批准的 UI Baseline。內容或驗證變更會使舊批准失效，應重新 verify／review。

執行時以 CLI 回傳的 session ID 與證據路徑為準；先使用 `protoflow --help` 確認命令。不得自動 commit、push、部署或覆寫既有 Baseline；報告通過、失敗、未執行與仍需人類確認的事項。
