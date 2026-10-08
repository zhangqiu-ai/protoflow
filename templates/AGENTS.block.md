<!-- protoflow:begin -->
## ProtoFlow 接入約定

- 讀取 `protoflow.config.json` 及可用的 `protoflow` Skill；引擎使用共享安裝，目標專案不複製引擎程式碼。
- 配置 source.kind=git 時，GitHub 原型分支的提交是應用觸發來源；使用 source scan／runner start，不使用本機 watch。Skill 不作背景程序。
- prototype 是設計輸入；先建立 Design Session 與 checkpoint，再依 Change Manifest、映射及 L0–L3 政策執行變更。保留使用者未提交內容與 Git index。
- 原型可連續推送版本；正式應用依 `protoflow queue` 的 `current` 逐一推進，該版本 verify PASS 後才處理下一個，不跨版本或合併版本實作。實作讀取 context 的 `prototypeVersion.prototypeDir` 凍結副本。不得自行關閉 `policy.sequentialVersions`。
- 原型先按頁面適度拆分，不鏡像應用目錄；同一原型檔可對應多個應用元件。將頁面及共用 tokens、styles、scripts、assets 明確列入各消費者的 `prototypeFiles`，以檔案粒度保守核對全部受影響 mapping／場景。
- selector 僅定位與視覺驗證，不代表 DOM diff 或自動依賴分析。移動／刪除資源時同步引用、映射與測試；本機 checkpoint 不等於 Git 版本鎖定；Git source checkpoint 固定 SHA，不自動 commit。
- L2 必須有 Spec Kit 規格證據，L3 必須再有 BMad／ADR 決策證據；產生提示、檔案或截圖不等於已完成驗證。兩者由 `protoflow install` 安裝，`protoflow status` 顯示安裝狀態。
- mapping 依本專案實際元件填寫；可用 `protoflow mappings suggest` 起草，不套用範例的頁面或元件名稱。
- `schemaVersion: 2` 專案以語意錨點取代 mapping：原型 `data-pf` 錨點 ID 必須以相同 ID 出現在應用（Web `data-testid`、iOS `accessibilityIdentifier`、Android `testTag`、Flutter `Semantics(identifier:)`、RN `testID`）；`protoflow anchors lint` 須 PASS，錨點建議由使用者審閱後才提交原型。
- 新增、變更、修復可由瀏覽器覆蓋的功能時，維護專案內 Node.js Playwright 回歸測試並以 runner 執行。
- 修復循環以配置的上限停止；記錄真實 build、functional、visual 結果，未執行記錄為 `NOT_RUN`。
- Review 與 UI Baseline 必須綁定當前 manifest、prototype、application 與驗證證據。只有配置 `policy.autoApprove: true` 時，Runner 才以 `ai:protoflow-runner`（`reviewerKind: automated`）自動批准 PASS 版本；其他情況自動代理不得代替人類批准，任何時候都不得把自動批准登記成真人。L3 ADR 仍需真人決策。
<!-- protoflow:end -->
