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

## 非密碼文字的完整替換

`fill`／`clear` 對 text field、text view 與 search field 使用公開 Select All 菜單，再刪除已選的完整內容，確認實際值為空才輸入。所有逐字重試沿用同一完整替換路徑。原本按目前字數 backspace 的方法會在游標落在中間時留下後綴；2026-10-31 compact 大字筆記原生場景已保留該真實失敗證據於使用端 `matrix-current-3e2f915ef607/compact-en-large-note/raw.json`。

Select All 必須真實存在且 `isHittable`；不存在、不可達或刪除後仍非空都回報 FAIL，不設定欄位值、不私有操作、不以座標強制點擊。密碼欄維持既有處理，不能讀回的密碼不增加值驗證。本次原生回歸使用既有英文系統編輯菜單；其他系統菜單語言未驗證時不得視為通過。

Focused guards：`node --test tests/ios-public-input-replacement.test.js`；實際原生回歸仍使用同一 immutable App／同一 compact-en-large-note，保留獨立重跑目錄，不能覆寫原始 RED。

## 短效 deep link 的啟動準備

需要短效一次性登入碼的 host wrapper 可同時傳入 `--launch-preparation-dir <directory>` 與 `--launch-preparation-token <64 lowercase hex>`，並指定 `--launch-url`。目錄必須已存在、為當前使用者所有、權限 `0700`，且是無符號連結的 canonical 絕對路徑。未指定兩參數時不建立通道；缺少其中一個或沒有 deep link 會在裝置操作前回報 `NOT_RUN`。

原生 job 的 `launchPreparation` 只包含 `directory`、短效 IPC `token` 與固定 `timeoutMs:15000`。這個 IPC token 不是發碼管理憑證；管理憑證只留在 host wrapper。XCTest 在既有裝置、safe-area 與 probe warm launch 完成後、實際 `app.open` 前，才以新的 UUID `requestId` 原子寫出 `request.json`（`0600`）：

```json
{"schemaVersion":1,"token":"<ephemeral IPC token>","requestId":"<fresh UUID>","bundleId":"<target bundle ID>"}
```

主機核對請求後才準備短效 URL，再原子寫出 `response.json`（`0600`）：

```json
{"schemaVersion":1,"token":"<same IPC token>","requestId":"<same UUID>","status":"ready","launchUrl":"example://screen?fixture=<fresh fixture>"}
```

XCTest 只接受相同 token／request ID 的回應；先前冷啟動留下的回應不會授權新的開啟。回應 URL 須維持原 URL 的 scheme、host、port 與 user-info。主機錯誤可回 `status:"error"`；錯誤、逾時、格式／權限錯誤或來源變更都回報 `NOT_RUN`，不使用原始或過期 URL。通道不改變登入碼有效期或單次使用限制。讀取回應拒絕符號連結、非普通檔案、其他擁有者、非 `0600` 權限、多個 hard link 與超過 64 KiB 的資料。

`raw.json.launchPreparation` 只保存 request ID 與實際請求、回應接受、開啟時間；不保存 URL、IPC token 或發碼憑證。實際 App 的登入與畫面仍須由各專案原生驗收證明，通道成功不等於登入成功。

驗證命令：`node --test tests/ios-launch-preparation.test.js`；`npx playwright test --config tests/launch-preparation-playwright.config.js` 使用實際 Swift Foundation 通道測試檔案交換，不啟動 Simulator。完整 XCTest 另以 generic iOS Simulator `build-for-testing` 編譯。
