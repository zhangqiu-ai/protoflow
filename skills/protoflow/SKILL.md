---
name: protoflow
description: Use ProtoFlow to turn prototype changes into mapped application changes with design sessions, change manifests, policy gates, verification, and human review in configured projects.
---

# ProtoFlow

ProtoFlow 是共享引擎。本 Skill 引導設計輸入到正式實作的流程，目標專案只保留 Skill、`protoflow.config.json`、`AGENTS.md` 約定與 `.protoflow/` 證據。使用已安裝的 `protoflow` CLI；若命令不可用，先定位共享引擎並使用 `node <engine>/bin/protoflow.js`，不要將引擎複製進目標專案。

## 原型結構與映射

按可獨立瀏覽、修改及驗收的頁面適度拆分原型，再抽出實際共用的 tokens、styles、scripts 與 assets。保留既有應用元件架構，不將原型目錄鏡像到應用；同一 HTML 可列入多筆 mapping，分別指向頁面中不同區域的應用元件。不要套用其他專案或範例的頁面、元件名稱。

每個 mapping 的 `prototypeFiles` 明確包含其頁面與消費的共用資源；修改共用檔案時，核對所有命中的 mapping 及相應驗證場景。引擎採檔案粒度的保守展開，selector 只定位／驗證，不能根據某個 DOM 區塊、CSS 變數或 import 推測引擎已排除其他影響。移動／刪除檔案時同步資源引用、映射、場景與回歸測試；調整後建立新 checkpoint／context，不沿用過期證據。

建立或補齊映射時，先執行 `protoflow mappings suggest --project <root>` 取得依目標專案原型頁面與引用資源產生的草稿；再閱讀應用程式碼，為每個區域填入實際存在的 `component` 與兩邊 selector，必要時把一頁拆成多筆 mapping，並核對 `sharedResources`、`orphanFiles`、`unmappedFiles`。草稿不寫入配置，修改配置前向使用者說明對應關係。拆分方法見共享引擎的 `docs/prototype-structure.md`；`examples/modular/` 只是示範專案。checkpoint 保存 hash 與 Git evidence，不提供 Git 版本選取／鎖定，也不自動 commit。

## 工作流程

1. 讀取專案約定與配置。尚未接入時執行 `protoflow init --project <root>` 與 `protoflow install --project <root>`，再設定 prototype → application/component 映射。既有配置與 Skill 安裝會保留。`install` 也會安裝 Spec Kit 與 BMad（已存在則略過）：把結果中的 `notices` 與各整合的 `changed` 檔案告訴使用者，安裝失敗時給出手動命令；BMad 安裝後提醒使用者執行 `bmad setup`。`protoflow status` 可查看兩者是否已安裝。
2. 原型可隨時修改並 checkpoint，多個版本會排隊。**推進正式應用前先執行 `protoflow queue --project <root>`**，只處理 `current` 版本，完成它的 context → execute → verify（或 repair）直到 PASS，再處理下一個；不要跳到 `waiting` 中較新的版本，也不要把多個版本合併成一次實作。實作時讀取 context 的 `prototypeVersion.prototypeDir`（該版本的凍結副本），不要讀現行 `prototypeDir`，因為它可能已是更新的版本。命令回傳 `BLOCKED`（退出碼 3）代表跨版本操作，應回到 `queue.current`；不得設定 `policy.sequentialVersions: false`、刪除或偽造 `.protoflow/` 證據來繞過順序。
3. `protoflow session start --project <root>` 建立 Design Session；讓 `protoflow watch --project <root>` 收集 prototype 變更，或使用 `protoflow checkpoint --project <root> --session <id> --summary "設計變更"` 明確建立 checkpoint。`--level` 是使用者意圖；政策只能提高最低等級。
4. 讀取 checkpoint 的 Git diff、Change Manifest、映射與分類理由。L0 樣式／視覺細節；L1 局部 UI 結構／互動；L2 資料／API 等功能變更需 Spec Kit 證據；L3 架構／安全影響另需 BMad／ADR 證據。配置外部工具時讀取 [整合邊界](references/integrations.md)。
5. 使用 `protoflow context --project <root> --manifest <id>` 取得執行上下文。L2/L3 依需要提供 `--spec <path>`、`--adr <path>`。只改 manifest 映射範圍；未映射輸入先修正配置，不能擅自猜測目標元件。
6. 配置 Codex adapter 後，執行 `protoflow execute --project <root> --context <id>` 檢查乾跑 request，再於授權範圍內加上 `--execute` 實際執行；也可由目前 Codex 依上下文直接實作，再執行 verify。
7. `protoflow verify --project <root> --manifest <id>` 執行 build、functional、visual，原型端使用該版本的凍結副本。PASS 後佇列前進到下一個版本。新增／變更／修復功能需維護目標專案 Node.js Playwright 回歸測試並使用 runner。尚未配置或尚未執行的驗證是 `NOT_RUN`，不能當作通過。
8. 失敗時執行 `protoflow repair --project <root> --manifest <id> --execute`；它依配置的 `maxRepairAttempts` 停止。讀取每次驗證與修復記錄，上限耗盡或缺少外部 adapter 時報告具體阻塞。
9. `protoflow review create --project <root> --manifest <id> --verification <id>` 建立人工 Review。將實際差異與驗證證據呈現給使用者；只有明確人類批准後才執行 `protoflow review approve --project <root> --review <id> --reviewer <human-id>`。不要將自己的判斷登記為人類批准。
10. `protoflow baseline create --project <root> --review <id>` 保存已批准的 UI Baseline。內容或驗證變更會使舊批准失效，應重新 verify／review。

執行時以 CLI 回傳的 session ID 與證據路徑為準；先使用 `protoflow --help` 確認命令。不得自動 commit、push、部署或覆寫既有 Baseline；報告通過、失敗、未執行與仍需人類確認的事項。
