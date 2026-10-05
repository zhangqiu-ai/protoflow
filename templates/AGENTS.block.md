<!-- protoflow:begin -->
## ProtoFlow 接入約定

- 讀取 `protoflow.config.json` 及可用的 `protoflow` Skill；引擎使用共享安裝，目標專案不複製引擎程式碼。
- prototype 是設計輸入；先建立 Design Session 與 checkpoint，再依 Change Manifest、映射及 L0–L3 政策執行變更。保留使用者未提交內容與 Git index。
- L2 必須有 Spec Kit 規格證據，L3 必須再有 BMad／ADR 決策證據；產生提示、檔案或截圖不等於已完成驗證。
- 新增、變更、修復可由瀏覽器覆蓋的功能時，維護專案內 Node.js Playwright 回歸測試並以 runner 執行。
- 修復循環以配置的上限停止；記錄真實 build、functional、visual 結果，未執行記錄為 `NOT_RUN`。
- 人工 Review 與 UI Baseline 必須綁定當前 manifest、prototype、application 與驗證證據；自動代理不得代替人類批准。
<!-- protoflow:end -->
