# iOS 響應式原生擷取（選用）

本擴充只加入公開 XCTest 觀測與操作，不改 external driver 的 step schema。未指定新參數時，`safe-area`／`device` 與原有擷取行為保持原樣。

| 參數 | 行為與限制 |
| --- | --- |
| `--orientation portrait\|portrait-upside-down\|landscape-left\|landscape-right` | 擷取開始前設定公開 `XCUIDevice.orientation`；結束時還原。host safe-area cache 依明確 orientation 分開。 |
| `--rotate-after-steps <orientation>` | 完成既有步驟後實際旋轉，不重新啟動 App。只接受 `--frame device` 或 `app-window`，避免沿用旋轉前的 host crop。 |
| `--preserve-known-synthetic-inputs <anchor,anchor>` | 只接受 `session: qa` 且本次有非空 `fill` 的最多八個 anchor；XCTest 另拒絕 secure／非文字輸入。只輸出前後長度與是否保留，不輸出比較值。必須與旋轉參數合用。 |
| `--hittable-anchors <anchor,anchor>` | 最多十六個 anchor，於 `raw.json.nativeReachability` 記錄實際存在、enabled、`isHittable`；不點擊或執行主動作。 |
| `--appearance light\|dark` | 明確設定 Simulator 系統外觀；失敗回報 NOT_RUN。未指定時沿用既有 light 預設。App 主題須另由實際 UI 證明。 |
| `--frame app-window` | 必須有既有 `--uikit-probe-context`。先通過原本 build/session/time/兩次相同樣本驗證，再由真實 window frame、bounds 與 safe-area insets 計算 crop。 |

`app-window` 拒絕非有限或非數值欄位、負 inset、空內容、非零 bounds origin、window transform、frame／bounds／screen 幾何不一致、超出螢幕的 window。它不讀預期 viewport，也不修改 collector、tree、threshold 或 waiver。成功時另保存 `app-window-frame.json`，含來源、當前樣本 hash、window 與內容矩形；原始 `raw.json` 仍保留 XCTest 原記錄。

旋轉另於 `raw.json.responsiveObservations` 保存實際 window 前後 frame、尺寸是否改變、裝置 orientation 與已限定輸入的保留布林。設定 orientation 並不代表 App window 已轉向；驗收方必須檢查 `windowSizeChanged`。窄視窗必須來自 iPadOS 真實 App window 變化；縮放 macOS Simulator 外框不能作證。本擴充沒有私有 API 或模擬 window frame。

驗證：`node --test tests/ios-responsive-driver.test.js tests/ios-driver.test.js tests/uikit-probe.test.js tests/uikit-probe-text.test.js`。XCTest 另以 generic iOS Simulator `build-for-testing` 編譯。實際裝置與畫面驗證屬使用端驗收，本文件不代表已通過。
