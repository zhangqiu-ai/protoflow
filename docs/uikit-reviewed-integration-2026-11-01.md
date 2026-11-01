# 已審核 UIKit 文字與捲動候選整合

本地 SDK 整合，尚未 commit／共享安裝或發布。保留先前 13 檔 settling 實作，依已審核 Screen v2（含 v1）、Nested eligibility 與 Scroll end patch 合併；同檔不同區段分別套用，不以整檔互覆。

## 邊界

只有既有 UIKit probe opt-in 才使用真實階層、公開文字所有權及完整觀測多層 scroll 的衍生資格。原單層資格、AX 預設、blocked／input／ambiguous guards 與正式 strict pair 均保留。多層資格只影響解讀，raw renderEligible／clip／hierarchy 不改。缺少 scroll metadata 不猜測；transform、未完整包住下一 viewport 的中間 clip、未知 geometry 拒絕。

`scroll-to value:end` 只支援 Web 與具有 current UIKit probe／公開 adjustedContentInset 的 iOS，仍拒絕巢狀 scroll。它只證明最終唯一 anchor 所屬的當下 scope／endpoint，不保跨步物件身分或 extent 不變。詳見[終點契約](scroll-end-contract.md)。Siyue collector 的四個 getter 為獨立 App patch，本 SDK 整合不修改該 App。

## 歷史證據

- Screen v2 外部 manifest：`2f8dfb0c8733cc6bb7a3deada0c932940289adccf81605ce15e8a5382c5690c0`。243 Node／64 Playwright；原 24 次回歸失敗及最終同測試 RED 11 PASS／6 FAIL 保留。
- Nested 外部 manifest：`16396e7cbfc437fa47d7d1e1b38c04a78bc647a3e420796a324ae951fefa2742`。43 Node／34 Playwright runner 純 interpreter 案例；原 31 PASS／3 FAIL 保留。不是 browser page 或 Native 驗收。
- End 外部 manifest：`33d28c99a4f581f987a855506cd34e24f5bc0fc295a2c93b0007a05a6c732985`。46 Node／12 Playwright（10 真 DOM＋2 Swift helper mock），另有真 SDK typecheck／collector getter syntax check；Native NOT_RUN。文案收窄 amendment：`9ba82ab6ccc444d9eb0e40aded0eaff73511c407335433b7e3d5c494cd90d0be`。
- Settling 原 875 Node（874 PASS／1 SKIP）、60 Playwright 與 Root 的隔離 BYOK Native 單場診斷，見[原記錄](uikit-settling-verification-2026-11-01.md)。它不構成本次合併 source 的 Native 證據。

所有歷史結果各依原 source／範圍解讀，不加總為本次執行。原 41 required-tier FAIL、原 raw、候選及中斷紀錄保留，沒有重寫為 PASS。

## 本次整合驗證

最終實際執行：`npm run check` 通過（238 JavaScript／6 published schemas／8 example-template configs）；`npm test` 為 970 案，969 PASS／1 SKIP／0 FAIL（285.499 秒）；單次 `npx --no-install playwright test --config tests/uikit-reviewed-integration-playwright.config.js --output <private-output>` 為 130 PASS／0 FAIL／0 retry（32.4 秒）。先前 959 案的一個整合失敗先保全，再套上述最小 atomic 修正；沒有刪除失敗或降低空縮圖斷言。

新增設定只調度相關既有與新持久案例，沒有啟動原生 driver、Simulator、Android、Electron 或 provider。130 案包含真 Chromium DOM、Foundation／Swift helper mock／實際 SDK typecheck，以及純 interpreter 案例，均不等於真 Native 驗收。紀錄位於本機外部 `/private/tmp/siyue-sdk-reviewed-three-batch-integration-g5o2c433/`，包含 first full RED、修正前 source、最終完整 Node／Playwright logs、凍結 manifest 與原候選雜湊；原候選、原 raw 與舊 SDK 證據不覆寫。

真 Native／新 collector App build／required-tier 比較／整輪 207／73 與 TestFlight 尚未執行；本地檢查不得替代。

## 新整合反例與原子群組修正

第一次完整 Node 執行為 959 案：957 PASS／1 FAIL／1 SKIP。新 nested 資格使父按鈕的真 UIKit 文字取得校正資格；原子群組因 descendant 的 derived AX mapping 被父重建移除而整組拒絕，空縮圖仍留下原 AX 祖先 aggregate。完整 RED 與當時 40 檔 bytes／mode 已外部保存，不改空縮圖的原斷言。

新增分支位於原 atomic scopes loop，僅在原 parts 全為 changed 真 AX 祖先且 actual UIKit 真 descendant、frame／role／visibility／privacy 完整關聯時，以原 AX traversal 排除祖先 label。選中的非空部分還須唯一、真子路徑、公開文字來源與相同文字、frame、rendered 與完整祖先非隱藏／非 transform。任何失敗仍整組 failClosed，不在 blocked group 後旁路、不偽掛回節點或假稱 nested 支援舊結果。候選 manifest `aec7bcfa3565c9bcd850215bb54166791e1850490473a4d6d1cd0d7e0d4293d8`；同最終 Node 25 案 22 PASS／3 FAIL → 25 PASS，PW 2 案 1 PASS／1 FAIL → 2 PASS（含原縮圖及合法非空 caption 控制）。舊「nested 未支援」父 scope 測試明確遷移為已觀測的真 public caption；縮圖仍必須為空，所有原失敗保留。
