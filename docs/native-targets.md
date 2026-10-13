# 原生 target：iOS 與 React Native

ProtoFlow 以外部驅動器協定（`schemas/driver-request.schema.json` → `schemas/driver-response.schema.json`）接入原生平台。引擎內建 iOS 參考驅動器 `scripts/ios-driver.js`：在 iOS 模擬器上以 XCUITest 依 bundle identifier 驅動任何應用，因此同時支援 SwiftUI、UIKit 與 React Native（iOS）。可執行範例見 [examples/mobile](../examples/mobile/)。

## 需求

- macOS、Xcode（含 iOS Simulator runtime）。驅動器不需要 Java、Maestro 或 idb。
- 一台專用模擬器，例如：

  ```sh
  xcrun simctl create "ProtoFlow iPhone 17" com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0
  ```

- 目標應用能建置成模擬器用的 `.app`（target 的 `build` 命令負責）。

沒有 Xcode、找不到模擬器、模擬器無法開機、安裝逾時或驅動器 runner 無法建置時，該場景記為 `NOT_RUN`，不會 PASS；應用回報安裝錯誤、無法到達畫面或步驟失敗則是 `FAIL`。

## 配置

```json
{
  "id": "ios",
  "platform": "ios",
  "root": "ios",
  "driver": {
    "kind": "external",
    "command": {
      "argv": ["node", "/absolute/protoflow/scripts/ios-driver.js",
        "--bundle-id", "com.example.app", "--device", "ProtoFlow iPhone 17",
        "--app", "ios/build/DerivedData/Build/Products/Debug-iphonesimulator/App.app"],
      "timeoutMs": 900000
    }
  },
  "build": { "argv": ["xcodebuild", "build", "-project", "ios/App.xcodeproj", "-scheme", "App", "-configuration", "Debug",
    "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "ios/build/DerivedData", "CODE_SIGNING_ALLOWED=NO", "-quiet"] },
  "viewport": { "width": 402, "height": 778, "scale": 3 }
}
```

| 參數 | 說明 |
|---|---|
| `--bundle-id` | 目標應用的 bundle identifier（必填） |
| `--device` | 模擬器名稱或 UDID（必填）；只使用指定的裝置，不會自動建立或選用其他裝置 |
| `--app` | 每次擷取前安裝的 `.app`，相對專案根目錄；省略時使用模擬器上已安裝的版本 |
| `--frame` | `safe-area`（預設）只比較安全區域內的內容；`device` 比較整個螢幕，含狀態列 |
| `--timeout-ms` | 單一步驟的等待時間，預設 10000 |
| `--launch-timeout-ms` | 應用啟動到畫面錨點出現的等待時間，預設 60000（React Native 冷啟動需載入 JS bundle） |
| `--cache` | runner 與安全區域快取，預設 `.protoflow/cache/ios-driver` |

驗證 PASS 需要 build、functional 與視覺三者都 PASS。`functional` 是應用自己的測試，不能由驅動器代替：SwiftUI／UIKit 用專案內的 XCUITest（`xcodebuild test -destination 'platform=iOS Simulator,name=…'`），React Native 用 Jest（`npm --prefix <root> test -- --ci`）。未配置時整體為 `NOT_RUN`。

`platform` 為 `ios` 或 `react-native` 時採原生預設：T4 視覺為 advisory（感知相似度），回歸範圍 `affected+smoke`；T1–T3 required。

### viewport 與安全區域

驅動器先用自帶的 host 應用量出裝置的安全區域（每台裝置量一次並快取），截圖裁到安全區域，畫面錨點的邊界就是這個區域。target 的 `viewport` 必須等於該裝置的安全區域尺寸，原型也在同一尺寸下渲染；尺寸不符時驗證會明確 FAIL，並列出實際尺寸。iPhone 17（iOS 27）為 `402×778@3`。

因此原型設計的是**內容區域**：不需要畫狀態列或 home indicator；頁面根元素（建議 `<body data-pf="…" data-pf-role="screen">`）填滿 viewport。

## 應用端約定

### 啟動參數

驅動器以 launch arguments 啟動應用：

```
-PROTOFLOW_SCREEN <screen> -PROTOFLOW_STATE <state> -PROTOFLOW_FIXTURE <fixture JSON>
```

這些值進入 `NSArgumentDomain`，應用以 `UserDefaults.standard.string(forKey: "PROTOFLOW_SCREEN")`（React Native：`Settings.get('PROTOFLOW_SCREEN')`）讀取，**直接打開該畫面**並套用 fixture。這等同 Web target 的 `urlTemplate`。帶有 `PROTOFLOW_SCREEN` 時建議停用動畫（`UIView.setAnimationsEnabled(false)`）。

### 錨點標記

| 框架 | 寫法 |
|---|---|
| SwiftUI | `.accessibilityIdentifier("tasks.add")`；畫面與 region 容器另加 `.accessibilityElement(children: .contain)`，否則識別碼會被套到每個子元素 |
| UIKit | `view.accessibilityIdentifier = "tasks.add"` |
| React Native | `testID="tasks.add"`；可點擊元件加 `accessibilityRole="button"`，讓它被視為 action |

隱藏的錨點（原型中 `hidden`）在原生端可以完全不渲染，視同隱藏。

React Native 注意事項：

- Fabric 會把無障礙樹壓平：帶 `testID` 的 `View` 在 XCUITest 中是沒有子元素的葉節點，文字與按鈕是同層的兄弟元素。驅動器以幾何包含（中心點落在容器範圍內）組出容器文字，與 SwiftUI 的階層結果一致。
- flex 欄位預設把子元素撐滿寬度；原型中只佔文字寬度的段落（例如錯誤訊息），`Text` 需加 `alignSelf: 'flex-start'`，否則 T3 寬度不符。
- iOS 27 強制 UIScene 生命週期；RN 0.87 模板的 `AppDelegate` 直接建立 `UIWindow`，啟動即中斷。需加入 `UIApplicationSceneManifest` 與 `SceneDelegate`（見 `examples/mobile/react-native/ios`）。
- 以 Release 配置建置，JS bundle 打包進 `.app`；驗收不依賴 Metro。冷啟動載入 bundle 較慢，畫面出現的等待時間由 `--launch-timeout-ms` 控制。

### 鍵盤

`fill` 會叫出軟體鍵盤。狀態的最後一步完成時鍵盤必須已收起（例如送出後結束編輯），否則擷取 FAIL，因為鍵盤會遮住畫面，原型中也不存在。

## 驅動器如何回報元素

| 協定欄位 | iOS 來源 |
|---|---|
| `count`、`bounds` | 同一識別碼的元素數量；第一個元素的 frame，換算為內容區域座標 |
| `visible` | frame 與內容區域相交且尺寸大於 0 |
| `text` | 文字元素、按鈕取 label；輸入框取值，空白時取 placeholder；容器依閱讀順序串接子元素的 label（同 `innerText`，不含輸入值）；開關等控制項本身沒有文字 |
| `interactive`、`editable`、`inputType`、`role` | 依 XCUITest 元素類型：按鈕、連結為可互動；輸入框、開關、滑桿等為可編輯；`switch` 對應 `checkbox`，`textField` 對應 `text` |
| `style` | 不提供；T2 改以截圖在元素範圍內取樣主色比較 |

步驟對應：`tap` 點擊、`fill`／`clear` 點擊後清空再輸入（輸入後讀回欄位值；忙碌的模擬器可能漏字，不符時清空並逐字重打，最多三次，仍不符則 FAIL 並列出欄位實際內容；密碼欄位無法讀回不驗證）、`toggle` 點開關、`select` 調整 picker 或點選選項、`scroll-to` 向上滑動直到可點擊、`back` 點導覽列返回、`wait-for` 等待出現。

原始證據保存在驗證產物的 `driver/` 目錄：`job.json`（啟動參數與步驟）、`raw.json`（完整無障礙樹）、`device.png`（整個螢幕）與 `screen.png`（比較用的裁切圖）。

## 效能與限制

- 每個場景是一次 `xcodebuild test-without-building`，約 15–40 秒；runner 只在驅動器原始碼或 Xcode 版本改變時重新建置。
- React Native 目前只驗收 iOS；Android（含 React Native Android）需要 Android 參考驅動器，尚未提供。
- T2 只比較取樣的主色，不比較字級與字重；字型與排版差異由 T3 相對版面與 T4 感知相似度觀察。
- 驅動器只在本機或專案自備的 macOS CI 上執行，不提供裝置農場或實機。

## 驗收紀錄（2026-10-12）

`examples/mobile` 在 iPhone 17 模擬器（iOS 27.0、Xcode 27.0）以真實 XCUITest 驗證同一個原型版本：

| target | build | functional | T1 結構 | T2 token | T3 版面 | T4 視覺（advisory） |
|---|---|---|---|---|---|---|
| `ios`（SwiftUI） | PASS | PASS（XCUITest 3/3） | PASS | PASS | PASS | 整體相似度 0.978–0.993 |
| `react-native`（RN 0.87.1，Release） | PASS | PASS（Jest 3/3） | PASS | PASS | PASS | 整體相似度 0.983–0.992 |

5 個場景（tasks：initial、empty-error、added；settings：initial、saved）在兩個 target 都通過必要層級，`release.requireTargets` 的版本因此被接受。T4 未達每個區域 0.92 的門檻，主因是 Chromium 與 iOS 的字型渲染差異；它是 advisory，不阻擋驗收。

過程中發現並修正：iOS 27 開關尺寸為 61×28（原型需跟著平台更新）；RN 0.87 模板需改用 UIScene；RN `Text` 需 `alignSelf: 'flex-start'` 才與只佔文字寬度的段落一致。系統高負載時（`simctl` 一次操作數分鐘）曾出現安裝或啟動逾時，均記為 `NOT_RUN`，重跑後 PASS。

