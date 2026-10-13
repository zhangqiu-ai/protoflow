# 提案 0002：Android、Flutter 與 Expo target

| 項目 | 內容 |
|---|---|
| 狀態 | 已接受（§12 決策 1–3：安裝環境、UiAutomator runner、target variants）；P0、P3.0–P3.4、P5.1–P5.2 已實作，見 §13；Expo（P3.5）待辦 |
| 日期 | 2026-10-13 |
| 前置 | [提案 0001](0001-anchor-contracts.md)（錨點、外部驅動器協定、P3／P5）、v0.3.x iOS 驅動器（[原生 target](../native-targets.md)） |
| 影響範圍 | 新增 Android 參考驅動器、原生樹共用模組、target variants（一份程式碼多個執行平台）、Expo（CNG）建置約定、應用雜湊排除 git 忽略檔案、`examples/mobile` |

## 1. 摘要

v0.3 以 XCUITest 參考驅動器完成 iOS 與 React Native（iOS）。本提案補上 0001 暫停的 P3（Android）與 P5（Flutter），並處理一個 iOS 階段刻意迴避的問題：**同一份程式碼跑在多個平台**（Flutter、React Native 的 iOS＋Android）。

1. **Android 參考驅動器**：與 iOS 對稱——引擎自帶一個 UiAutomator instrumentation runner，依 package name 驅動任何 Android 應用（Compose、View、React Native、Flutter），擷取無障礙樹與截圖，Node 端解讀並裁到內容區域。
2. **共用原生樹**：把 `src/drivers/ios-tree.js` 的解讀規則抽成平台中立的 `native-tree`，iOS 與 Android 各提供「原始節點 → 正規化節點」的轉換，T1 文字、可互動、可編輯、幾何包含等規則只寫一次。
3. **Flutter 不需要新驅動器**：Flutter 3.19+ 的 `Semantics(identifier:)` 在 iOS 對應 `accessibilityIdentifier`、在 Android 對應 `resource-id`，直接沿用兩個平台驅動器。
4. **Target variants**：一個 target（一份程式碼、一個 root、一條交付分支）可以有多個執行變體（例如 `ios`、`android`），每個版本必須在所有 required 變體都 PASS 才算該 target 接受。這同時解決 Flutter 與跨平台 React Native。
5. **Expo**：驅動器與 React Native 相同；差異在建置（不能用 Expo Go，必須產出自己的 `.app`／`.apk`）與 Continuous Native Generation（`ios/`、`android/` 由 prebuild 產生且被 git 忽略）。前置條件是應用雜湊排除 git 忽略的檔案（§4 D7），否則獨立審查關卡會擋下交付——這個缺陷同樣影響現有的 bare React Native。

## 2. 現況與缺口

| 項目 | 現況 |
|---|---|
| 配置 | `platform` 已有 `android`、`flutter`；`external` 驅動器協定可用 |
| 分層驗收 | 原生預設（T4 advisory、`affected+smoke`、截圖取樣 T2）已在 iOS 驗證 |
| iOS 驅動器 | 可驅動 Flutter iOS（未驗證 Flutter 的語意樹形狀） |
| Android | 無驅動器、無範例；本機無 JDK、`adb`、模擬器、系統映像 |
| Flutter | 無範例；本機無 Flutter SDK |
| 一份程式碼多平台 | 多目標要求各 target 有獨立、不巢狀的 `root`；同一份 RN／Flutter 程式碼無法同時當 iOS 與 Android 兩個 target |
| Expo | 未驗證；現有 RN 範例為 RN CLI bare 專案 |
| 交付與 git 忽略檔案 | 應用雜湊不看 `.gitignore`，只排除固定的 `RUNTIME_DIRS`；`examples/mobile` 實測 RN codegen 的 28 個被忽略檔案計入雜湊，獨立審查要求雜湊中每個檔案都在已提交的 tree，原生 target 的自動交付會 BLOCKED（v0.3 只驗收到 verify，未覆蓋交付）。修復進行中 |

## 3. 目標與非目標

**目標**

- **G1** Android（Compose 與 View）範例應用在模擬器上 T1–T3 required PASS，故障情境（無模擬器、逾時、安裝失敗）分別記 NOT_RUN／FAIL 且有測試。
- **G2** React Native 同一份程式碼在 iOS 與 Android 都 PASS，並只交付一次。
- **G3** Flutter 範例應用在 iOS 與 Android 模擬器上 T1 PASS（0001 的 P5 條件），目標 T1–T3。
- **G4** iOS 與 Android 的事實解讀規則一致（同一份測試覆蓋）。
- **G5** Expo（CNG、當前 SDK）範例在 iOS 與 Android 變體 T1–T3 PASS，且自動交付（commit／PR／合併）在原生 target 上實際走通一次。

**非目標**

- 實機、裝置農場、雲端模擬器。
- Android 以外的 Linux／Windows 主機上的 iOS；Windows 上的受監督執行（沿用 0001）。
- Flutter Web／Desktop target（Web 已由 `playwright-web` 涵蓋）。
- 以 AI 視覺判斷取代分層驗收。

## 4. 關鍵決策（含建議）

### D1 Android 驅動技術

| 方案 | 優點 | 缺點 |
|---|---|---|
| **A. UiAutomator instrumentation runner（建議）** | 與 iOS XCUITest 對稱；`waitForIdle`、`setText` 可靠（含非 ASCII）；`UiAutomation.takeScreenshot` 與無障礙樹一次取得；可內建量測 inset 的 probe activity | 需 JDK 17 與 Gradle 建置 runner（一次、快取） |
| B. 純 `adb`：`uiautomator dump` + `screencap` + `input` | 不需建置任何 APK | `dump` 在動畫中常失敗；`input text` 只支援 ASCII、需跳脫；無 idle 等待，容易不穩 |
| C. Maestro／Appium | 生態成熟 | 額外常駐服務與依賴；輸出仍需轉換；版本與授權由第三方掌控 |

建議 A，且 runner 內用與 iOS 相同的「原始樹 + 截圖」輸出格式，解讀全部在 Node 端。B 只作為 runner 無法建置時的診斷手段，不作為驗收路徑。

### D2 錨點在 Android 的定位

| 框架 | 寫法 | UiAutomator 看到的 |
|---|---|---|
| Compose | `Modifier.testTag("tasks.add")`，畫面根節點 `Modifier.semantics { testTagsAsResourceId = true }` | `resource-id = "tasks.add"` |
| View | `android:id` 不能含 `.`、`-`：以 `locator.transform` 可逆轉換，`.` → `__`、`-` → `_`（錨點語法不含 `_`，轉換可逆） | `resource-id = "<package>:id/tasks__add"`（比對時去掉 package 前綴） |
| React Native | `testID="tasks.add"` | RN 以 `viewIdResourceName` 暴露為 `resource-id`（P3.0 spike 驗證版本行為） |
| Flutter | `Semantics(identifier: "tasks.add")`；region 用 `Semantics(container: true, identifier: …)` | `resource-id = "tasks.add"` |

0001 §5 對 View 寫的是 `.` → `_`；因 `-` 也不是合法資源名字元，本提案改為 `.` → `__`、`-` → `_`，報告保留原始錨點 ID。

### D3 啟動約定

- **原生 Android**：`am start -n <package>/<activity> --es PROTOFLOW_SCREEN <screen> --es PROTOFLOW_STATE <state> --es PROTOFLOW_FIXTURE <json>`；Activity 以 `intent.getStringExtra` 讀取。活動名稱由 `--activity` 指定，省略時用 launcher activity。
- **React Native（跨平台）**：iOS 是 launch arguments（`Settings.get`），Android 是 intent extras。範例提供一個 20 行的 `protoflowLaunch()` helper：Android 端在 `MainActivity` 以 `getLaunchOptions()` 把 extras 當 initial props 傳入，JS 端統一從 props／`Settings` 讀取。
- **Flutter**：同一個 helper 概念：iOS 用 `NSUserDefaults`（launch arguments）、Android 用 intent extras，以一個極小的 `MethodChannel`（或 `--dart-define` 無法動態傳值，故不採用）在啟動時取得。範例內附。

### D4 內容區域與密度

- 與 iOS 相同：driver 的 probe activity 以 `WindowInsets` 量測狀態列與導覽列 inset（每台裝置／方向快取），截圖裁到內容區域，畫面錨點的邊界即內容區域，target `viewport` 必須等於內容區域的 dp 尺寸。
- 密度：Pixel 預設 420 dpi（2.625），原型在 Chromium 以 `deviceScaleFactor: 2.625` 渲染時，`round(width × 2.625)` 可能與裝置截圖差 1 px。**建議建立整數密度（480 dpi，scale 3）的專用 AVD**，維持「尺寸必須完全相等」的既有保證；不放寬 `captureSizeIssues`。
- 軟體鍵盤：AVD 以硬體鍵盤模式啟動並設定 `show_ime_with_hard_keyboard=0`，`fill` 不會叫出鍵盤；最後若 IME 視窗存在仍 FAIL（同 iOS）。
- 動畫：driver 在擷取前設定 `window_animation_scale`、`transition_animation_scale`、`animator_duration_scale` 為 0。

### D5 一份程式碼多平台：target variants

現行多目標假設「一個 target = 一份程式碼 = 一個 root = 一條交付分支」。若把 RN 的 iOS 與 Android 當兩個 target，兩條交付分支會各自修改同一批檔案而互相衝突。建議：

```json
{
  "id": "mobile",
  "platform": "react-native",
  "root": "react-native",
  "build": { "argv": ["…"] },
  "functional": { "argv": ["npm", "--prefix", "react-native", "test", "--", "--ci"] },
  "variants": [
    { "id": "ios", "driver": { "kind": "external", "command": { "argv": ["node", "…/ios-driver.js", "…"] } },
      "build": { "argv": ["xcodebuild", "…"] }, "viewport": { "width": 402, "height": 778, "scale": 3 } },
    { "id": "android", "driver": { "kind": "external", "command": { "argv": ["node", "…/android-driver.js", "…"] } },
      "build": { "argv": ["./gradlew", "-p", "react-native/android", "assembleRelease"] }, "viewport": { "width": 411, "height": 843, "scale": 3 },
      "required": true }
  ]
}
```

- target 仍是交付與 FIFO 的單位：一個 worktree、一條交付分支、一個 Codex 執行。
- verification 依序跑每個變體的 build 與擷取，記錄 `variants.<id>`；target 的 visual 狀態 = 所有 `required` 變體都 PASS。`required: false` 的變體只記錄（例如某平台尚在建置中）。
- 變體可覆寫 `driver`、`build`、`viewport`、`tiers`、`visual`、`deviations`；`functional` 與 `root` 屬於 target。
- 沒有 `variants` 的 target 行為完全不變（單一隱含變體）。

### D6 Flutter 驅動方式

沿用 iOS／Android 平台驅動器（黑箱，經無障礙樹），不採用 `integration_test` 的 Dart 端驅動。理由：與其他平台一致、不需在應用中內嵌測試入口、驗收的是使用者實際看到的語意樹。已知差異在 §6 處理。

### D7 Expo 與 git 忽略的產生檔

**應用雜湊（前置修復）**：`applicationFingerprint` 與審查綁定排除 git 忽略的未追蹤檔案（`git ls-files --others --ignored --exclude-standard`），已追蹤的檔案即使符合忽略規則仍計入；非 git 專案維持 `RUNTIME_DIRS`。證據因此只綁定「會被提交的內容」；被忽略的產生檔由 build 負責重建，並由視覺與功能驗收覆蓋其效果。

**建置**：Expo Go 不能作為驗收對象（bundle id 屬於 Expo Go，JS 由 Metro 載入）。target 的 `build` 必須產生自己的二進位：

| 方式 | iOS | Android |
|---|---|---|
| prebuild + 原生建置（建議，無雲端依賴） | `npx expo prebuild --platform ios --no-install` → `pod install` → `xcodebuild … -configuration Release` | `npx expo prebuild --platform android` → `./gradlew assembleRelease` |
| `npx expo run:<platform> --configuration Release` | 可，但會嘗試啟動模擬器與 app，與驅動器的裝置管理重疊 | 同左 |
| `eas build --local`（模擬器 profile） | 可產生 `.app`（tar.gz） | 可產生 `.apk` |

`verify` 在 build 之後才計算驗證前的雜湊，prebuild 產生的檔案不會被誤判為「驗證期間改動」；配合上述雜湊修復，也不會阻擋交付。

**原生設定只能經 config plugin**：CNG 每次 prebuild 會重新產生 `ios/`、`android/`，手改會被覆蓋。範例提供一個小型 config plugin：

- iOS：若當前 SDK 的 `AppDelegate` 未採用 UIScene（iOS 27 強制），加入 `UIApplicationSceneManifest` 與 SceneDelegate（P3.5 spike 確認是否需要）。
- Android：`MainActivity` 把 `PROTOFLOW_*` intent extras 轉成 initial props（D3）。
- iOS 的 launch arguments 由 RN 核心 `Settings.get` 讀取，不需原生修改；使用 Expo Router 的專案可改以 deep link `protoflow://<screen>?state=…` 進入，由 `--launch-url` 驅動器參數提供（驅動器以 `simctl openurl`／`am start -d` 開啟）。

**功能測試**：`jest-expo` preset（`npx jest --ci`）。

**錨點**：`testID`，與 React Native 相同；Expo Router 的 `<Stack>` 標題列屬於平台導覽，以 `deviations` 宣告或在原型中對應。

## 5. Android 驅動器設計

```text
scripts/android-driver.js           Node：裝置、安裝、啟動、instrument、取回輸出、解讀、裁切
drivers/android/                    Gradle 專案（AGP，minSdk 26）
  probe/ ProbeActivity              量測 WindowInsets 內容區域
  runner/ CaptureTest (UiAutomator) 依 package 啟動、重放步驟、輸出 raw.json + device.png
src/drivers/native-tree.js          平台中立解讀（由 ios-tree.js 抽出）
src/drivers/android-tree.js         UiAutomator 節點 → 正規化節點
```

**流程**（每個場景一次，與 iOS 相同）：`adb devices` 找到指定 AVD（不存在 → NOT_RUN 並提示 `avdmanager create`；未開機 → `emulator -avd … -no-window -no-snapshot-save` 開機並等待 `sys.boot_completed`）→ 關動畫 → `adb install -r`（安裝逾時 NOT_RUN、安裝錯誤 FAIL）→ runner 未快取則 `./gradlew assembleDebug assembleAndroidTest`（以 runner 原始碼與 AGP/JDK 版本為鍵）→ `adb push job.json` → `adb shell am instrument -w -e job …` → `adb pull` 輸出 → Node 解讀。

**事實對應**

| 協定欄位 | Android 來源 |
|---|---|
| `count`、`bounds` | 同一 `resource-id`（套用 transform 後）的節點數；第一個節點的 `boundsInScreen`，px ÷ density 轉 dp，減去內容區域原點 |
| `visible` | `isVisibleToUser` 且與內容區域相交 |
| `text` | `TextView` 類取 `text`；`EditText` 取 `text`，空白時 `hintText`；`Checkable`（Switch、CheckBox）本身無文字；容器依閱讀順序串接子節點（Compose／Flutter 的語意樹通常有階層，RN 可能扁平，沿用幾何包含規則） |
| `interactive`、`editable`、`inputType` | `isClickable`／`isCheckable`／`isEditable`；`className` 對應 `button`、`textField`、`switch` 等正規化類型；`EditText` 的 `inputType` 密碼位元對應 `password` |
| `enabled` | `isEnabled` |
| `style` | 不提供；T2 以截圖取樣 |

**步驟對應**：`tap` → `UiObject2.click()`；`fill` → `setText()` 後讀回（不符則清空重設，最多三次，與 iOS 相同語義）；`clear` → `clear()`；`toggle` → 點擊 checkable；`select` → Spinner／Dropdown 點選項目；`scroll-to` → `UiScrollable.scrollIntoView`；`back` → `pressBack()`；`wait-for` → `wait(Until.hasObject)`。

**NOT_RUN／FAIL 規則**沿用 iOS：環境（無 JDK、無 SDK、AVD 不存在、開機或安裝逾時、runner 無法建置、`adb` 失聯）為 NOT_RUN；應用（安裝錯誤、閃退、畫面錨點未出現、步驟失敗、IME 未收起）為 FAIL；失敗時保留 `failure.png` 與樹。

## 6. Flutter

- **樹的形狀**：Flutter 會合併語意節點；沒有 `identifier` 的文字常被併入父節點的 `label`。範例以 `Semantics(container: true, identifier: …)` 標記 region，文字元件保持獨立節點；`native-tree` 的容器文字規則（階層，退回幾何包含）不需要 Flutter 專屬分支。P5 spike 確認 iOS 的 `accessibilityIdentifier` 與 Android 的 `resource-id` 都出現，若某版本不一致則記錄最低支援的 Flutter 版本。
- **語意啟用**：Flutter 只在有無障礙服務查詢時建立語意樹。UiAutomator 與 XCUITest 都會觸發，但第一次查詢可能為空；driver 等待畫面錨點出現的 `--launch-timeout-ms` 已涵蓋，必要時 runner 先查一次根節點再等待。
- **渲染差異**：Flutter 自繪文字（非系統文字元件），T4 相似度預期與原生相近或更好；字型差異同 iOS，T4 維持 advisory。
- **功能測試**：`flutter test`（widget tests，不需模擬器）作為 target 的 `functional`。
- **建置**：`flutter build ios --simulator --release` 與 `flutter build apk --release`，以 D5 的兩個 variants 表達。

## 7. 引擎變更

| 模組 | 變更 |
|---|---|
| `src/drivers/native-tree.js`（新） | 由 `ios-tree.js` 抽出：閱讀順序、容器文字（階層／幾何）、控制項語義、裁切、`iosResponse` → `nativeResponse`；`ios-tree.js` 只保留 XCUITest 類型對應 |
| `src/drivers/android-tree.js`（新） | UiAutomator 節點正規化、resource-id transform、密度換算 |
| `schemas/config.v2.schema.json` | target `variants[]`、`locator.transform` |
| `src/targets.js` | 依變體擷取並彙總；報告與證據按變體分目錄（`<target>/<variant>/<scene>`） |
| `src/workflow.js` | verification 記錄 `variants`；build 依變體執行 |
| `src/queue.js`、`src/streams.js` | 不變：接受仍以 target 為單位 |
| `src/util.js` | `RUNTIME_DIRS` 加入 `.cxx`、`.externalNativeBuild`（Gradle 原生建置輸出） |

## 8. 範例與驗收

- `examples/mobile/android`：Compose 應用，與 iOS 相同的 tasks／settings 兩畫面；功能測試用 JVM 上的 Compose UI test（Robolectric）以免 functional 依賴模擬器。
- `examples/mobile/react-native`：恢復 `android/`，改為 D5 的 `mobile` target（`ios`、`android` 兩變體）。
- `examples/mobile/flutter`：同兩畫面，`ios`、`android` 兩變體，`flutter test` 為 functional。
- `examples/mobile/expo`：當前 Expo SDK、CNG（`ios/`、`android/` 不提交）、config plugin、`jest-expo`；`ios`、`android` 兩變體。另以本機 Git fixture 對 Expo target 跑一次完整自動交付（commit → PR 替身 → 合併），證明 git 忽略的產生檔不再阻擋審查關卡。
- 手機原型沿用；Android 變體的 `viewport` 以專用 AVD 的內容區域為準。原型中 iOS 專屬的開關樣式在 Android 會使 T2／T4 略有差異，以 `deviations` 宣告或改為平台中立樣式。
- 真實驗收：`tests/e2e/android.spec.js`（`PROTOFLOW_ANDROID_DEVICE` 才執行）與 Flutter 對應測試；CI 不執行模擬器（GitHub 托管 runner 的 Android 模擬器需 KVM，留待之後評估）。

## 9. 環境需求（需使用者同意安裝）

| 項目 | 估計大小 | 安裝方式 |
|---|---|---|
| JDK 17（Temurin） | ~300 MB | `brew install --cask temurin@17` |
| Android SDK：platform-tools、emulator、platforms;android-36、build-tools | ~1.5 GB | 既有 `sdkmanager` |
| 系統映像 `system-images;android-36;google_apis;arm64-v8a` | ~2 GB | `sdkmanager` |
| AVD「ProtoFlow Pixel」（480 dpi，硬體鍵盤） | ~6 GB（使用後） | `avdmanager create avd` + config |
| Gradle（由 wrapper 下載）與依賴快取 | ~1 GB | 首次建置 |
| Flutter SDK（stable） | ~2.5 GB | `brew install --cask flutter` 或 git clone |
| Expo（`create-expo-app`、CocoaPods 依賴） | ~1 GB（每個範例的 node_modules 與 Pods） | npm；不需要 EAS 帳號 |

合計約 14 GB；本機剩餘 289 GB。下載經本機代理，可能遇到 503，安裝腳本需重試。

## 10. 分階段計畫

| 階段 | 內容 | 完成條件 | 估計 |
|---|---|---|---|
| P0 雜湊修復（進行中） | 應用雜湊與審查綁定排除 git 忽略檔案；回歸測試（舊程式碼 BLOCKED、新程式碼 PASS） | 原生 target 的交付不再因產生檔被擋；Web 專案雜湊不變 | 0.5–1 天 |
| P3.0 環境與 spike | 安裝 §9 的 Android 部分；以最小 Compose app 驗證 instrumentation 擷取、`testTagsAsResourceId`、RN `testID` 在 Android 的 `resource-id`、480 dpi 截圖尺寸 | spike 報告；確定 D1–D4 無需修改 | 0.5–1 天 |
| P3.1 共用原生樹 | `native-tree.js` 抽出；iOS 行為不變 | 既有 iOS 單元測試與真實 E2E 全過 | 0.5 天 |
| P3.2 Android 驅動器 | `drivers/android`、`scripts/android-driver.js`、`android-tree.js`；假 `adb`／錄製樹的單元測試（NOT_RUN／FAIL 分類、transform、密度、裁切） | 單元測試；真實模擬器擷取 tasks／settings | 2–3 天 |
| P3.3 Compose 範例 | `examples/mobile/android` + 功能測試；`tests/e2e/android.spec.js` | 5 個場景 T1–T3 PASS；漂移被 T1 抓到 | 1 天 |
| P5.1 Target variants | schema、驗證彙總、證據目錄、報告；單一變體相容 | 單元與 E2E；既有專案行為不變 | 1.5–2 天 |
| P3.4 React Native Android | RN 範例改為兩變體 target；launch helper | 同一份 RN 程式碼在 iOS 與 Android 都 PASS，一次交付 | 1 天 |
| P3.5 Expo | 當前 SDK 範例（CNG、config plugin、`jest-expo`）；spike 確認 UIScene 與 Android launch props；iOS 變體先驗收，Android 變體於 P3.2 後接上；原生 target 自動交付走通一次 | iOS 與 Android 變體 T1–T3 PASS；交付不被審查關卡擋下 | 1.5 天 |
| P5.2 Flutter | 安裝 SDK；`examples/mobile/flutter`；確認語意樹與 identifier | iOS 與 Android 變體 T1 PASS（目標 T1–T3） | 1.5 天 |
| P5.3 文件與發佈 | `docs/native-targets.md` 擴充為 iOS／Android／Flutter；0001 §13 狀態更新 | v0.4.0（Android＋variants）、v0.5.0（Flutter） | 0.5 天 |

合計約 10–13.5 個工作天。P0 是所有原生交付的前置；P3.1 與 P3.2 可平行；P5.1 是 P3.4、P3.5 與 P5.2 的前置（P3.5 的 iOS 部分可在 P5.1 前以單一變體先做）。

## 11. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 模擬器在本機過載時極慢（iOS 階段曾發生） | 驗收逾時、NOT_RUN | 專用 AVD、`-no-window`、單一模擬器；逾時一律 NOT_RUN 並保留證據 |
| RN `testID` 在 Android 的暴露方式隨版本變動 | Android 變體找不到錨點 | P3.0 spike 確認；必要時範例加 `accessibilityLabel` 以外的明確設定，或改 `nativeID` |
| Flutter 語意合併使容器文字或節點數與原型不同 | T1 誤報 | 範例約定 `Semantics(container: true)`；spike 後若需要，在 `native-tree` 加入 Flutter 合併規則並以錄製樹測試 |
| 非整數密度造成 1 px 尺寸差 | 尺寸檢查 FAIL | 建議 480 dpi AVD；不放寬引擎檢查 |
| target variants 改動驗證與證據結構 | 既有證據相容性 | 無 `variants` 時維持單一隱含變體；證據 schemaVersion 不變、只新增欄位 |
| 安裝下載經代理不穩 | 環境準備耗時 | 腳本重試；必要時離線鏡像 |
| Expo SDK 版本更新頻繁、prebuild 模板變動（例如 UIScene、AppDelegate 結構） | config plugin 失效、iOS 27 啟動中斷 | 範例鎖定 SDK 版本；plugin 只做最小修改並有 prebuild 後的檢查；SDK 升級時重跑真實驗收 |
| 排除 git 忽略檔案後，被忽略但影響建置的檔案（例如本機 `.env`）不在證據綁定內 | 同一雜湊可能對應不同建置結果 | 文件明示由 build 負責；視覺與功能驗收覆蓋實際效果；建議專案把影響建置的設定納入版本控制 |

## 12. 待決問題

1. 是否同意在本機安裝 §9 的工具（約 13 GB）並建立專用 AVD？
2. D1：採用 UiAutomator instrumentation runner（建議）？
3. D5：採用 target variants（建議），還是先接受「RN／Flutter 每個平台各一個 target、各自交付」的限制？
4. 發佈切分：Android＋variants 為 v0.4.0、Flutter 為 v0.5.0，或合併為一版？Expo 隨 v0.4.0（iOS 變體可更早，見 P3.5）？
5. Expo 建置方式：prebuild + 原生建置（建議，無雲端與帳號依賴），或允許專案改用 `eas build --local`？

## 13. 實作紀錄（2026-10-13）

| 階段 | 結果 |
|---|---|
| P0 雜湊修復 | 應用雜湊與審查綁定排除 git 忽略的未追蹤檔；`examples/mobile` 雜湊檔案由 81 降為 36（等於 git 追蹤的檔案）；Gradle／Flutter 的 `build/` 不再造成 `changedDuringVerification` |
| P3.0 環境 | JDK 17（Homebrew `openjdk@17`）、Android SDK（platform-tools、emulator、platforms 36／37、build-tools 36.0.0、`system-images;android-36;google_apis;arm64-v8a`）、AVD `ProtoFlow_Pixel`（1080×2400、480 dpi、硬體鍵盤）、Flutter 3.47.7 |
| P3.1 共用原生樹 | `src/drivers/native-tree.js`；`ios-tree.js` 只保留轉出；新增 `visible` 支援、不可見節點不計入容器文字、內容區域取整到整數點 |
| P3.2 Android 驅動器 | `drivers/android`（AGP 9.4.1、Gradle 9.8.1，Java 撰寫）、`scripts/android-driver.js`、`src/drivers/android-tree.js`；與 iOS 相同的 NOT_RUN／FAIL 分類、讀回輸入、失敗證據；runner 與 inset 快取以 runner 原始碼為鍵 |
| P3.3 Compose 範例 | `examples/mobile/android`；Robolectric（SDK 35，JDK 17）功能測試 3/3；模擬器上 5 個場景 T1–T3 PASS |
| P5.1 target variants | schema、`targetVariants`、逐變體 build 與擷取、彙總與證據目錄、doctor、context 說明；同時實作 0001 已定義但未生效的 `deviations` |
| P5.2 Flutter | `examples/mobile/flutter`（`ios`、`android` 兩變體）；`flutter test` 3/3；兩變體 5 個場景 T1–T3 PASS |
| P3.4 React Native Android | `react-native` target 改為 `ios`、`android` 兩變體；`MainActivity.getLaunchOptions()` 傳入啟動參數（真實驗收見 `docs/native-targets.md`） |

實作中修正的引擎規則：T1 兄弟順序改為閱讀順序（Compose 48 dp 觸控區）；可點擊且只含文字的容器視為按鈕；輸入框子文字或 label 作為 placeholder；Android 擷取前等 UI 閒置、清除 UiAutomation 快取並等無障礙樹穩定。

與草案的差異：Compose 功能測試用 Robolectric 而非 instrumentation（不依賴模擬器）；Android 驅動器以 Java 撰寫（少一個 Kotlin 外掛）；`deviations` 只接受 `tokens`、`layout`、`visual` 三個層名作為生效值。

