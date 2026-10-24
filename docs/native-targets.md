# 原生 target：iOS、Android、React Native、Expo 與 Flutter

ProtoFlow 以外部驅動器協定（`schemas/driver-request.schema.json` → `schemas/driver-response.schema.json`）接入原生平台，並內建兩個參考驅動器：

| 驅動器 | 平台 | 方式 | 適用框架 |
|---|---|---|---|
| `scripts/ios-driver.js` | iOS 模擬器 | XCUITest，依 bundle identifier 驅動 | SwiftUI、UIKit、React Native（含 Expo）、Flutter |
| `scripts/android-driver.js` | Android 模擬器（AVD） | UiAutomator instrumentation，依 package 驅動 | Compose、View、React Native（含 Expo）、Flutter |

兩者輸出相同的原始格式（無障礙樹＋整個螢幕截圖），由引擎的 `src/drivers/native-tree.js` 以同一套規則解讀（iOS 直接使用 XCUITest 類型，Android 先經 `src/drivers/android-tree.js` 正規化）。同一份程式碼跑在多個平台（React Native、Flutter）時以 [target 變體](#target-變體一份程式碼多個平台) 表達。可執行範例見 [examples/mobile](../examples/mobile/)。

## 需求

**iOS**：macOS、Xcode（含 iOS Simulator runtime），不需要 Java、Maestro 或 idb。一台專用模擬器：

```sh
xcrun simctl create "ProtoFlow iPhone 17" com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0
```

**Android**：JDK 17（`JAVA_HOME`）、Android SDK（`ANDROID_HOME`，含 platform-tools、emulator、platforms、build-tools 與系統映像）、一個專用 AVD。建議整數密度與硬體鍵盤，讓截圖尺寸精確、`fill` 不叫出軟體鍵盤：

```sh
avdmanager create avd -n ProtoFlow_Pixel -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
# ~/.android/avd/ProtoFlow_Pixel.avd/config.ini
hw.lcd.density=480
hw.keyboard=yes
```

AVD 名稱不能有空格。驅動器需要時以無視窗模式開機（`-no-window`），模擬器在擷取後繼續執行，與 iOS 模擬器相同視為裝置服務。

**Flutter**：Flutter SDK 在 `PATH` 上（3.19 以上，`Semantics(identifier:)`）。Codex 執行者要能跑 `flutter test`，adapter argv 需加 `--add-dir <Flutter SDK> --add-dir ~/.dart-tool（絕對路徑） --network`，見 [整合：專案工具鏈的沙箱權限](integrations.md#專案工具鏈的沙箱權限--add-dir--network)。

沒有 Xcode／JDK／SDK、找不到模擬器或 AVD、開機或安裝逾時、驅動器 runner 無法建置時，該場景記為 `NOT_RUN`，不會 PASS；應用回報安裝錯誤、閃退、無法到達畫面或步驟失敗則是 `FAIL`。擷取沒有產出結果（`NOT_RUN`，例如 XCUITest 偶發的 `xcodebuild exit null`）時，引擎自動重擷取一次，場景記錄 `captureRetry`（第一次的原因）；兩次都沒有結果才記為 `NOT_RUN`。`FAIL` 不重擷取。

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
  "functional": { "argv": ["xcodebuild", "test", "-project", "ios/App.xcodeproj", "-scheme", "App",
    "-destination", "platform=iOS Simulator,name=ProtoFlow iPhone 17", "-derivedDataPath", "ios/build/DerivedData", "CODE_SIGNING_ALLOWED=NO", "-quiet"] },
  "viewport": { "width": 402, "height": 778, "scale": 3 }
}
```

```json
{
  "id": "android",
  "platform": "android",
  "root": "android",
  "driver": {
    "kind": "external",
    "command": {
      "argv": ["node", "/absolute/protoflow/scripts/android-driver.js",
        "--package", "com.example.app", "--avd", "ProtoFlow_Pixel",
        "--apk", "android/app/build/outputs/apk/debug/app-debug.apk"],
      "timeoutMs": 900000
    }
  },
  "build": { "argv": ["android/gradlew", "-p", "android", "--no-daemon", "-q", "assembleDebug"] },
  "functional": { "argv": ["android/gradlew", "-p", "android", "--no-daemon", "-q", "testDebugUnitTest"] },
  "viewport": { "width": 360, "height": 730, "scale": 3 }
}
```

| iOS 參數 | 說明 |
|---|---|
| `--bundle-id` | 目標應用的 bundle identifier（必填） |
| `--device` | 模擬器名稱或 UDID（必填）；只使用指定的裝置，不會自動建立或選用其他裝置 |
| `--app` | 每次擷取前安裝的 `.app`，相對專案根目錄；省略時使用模擬器上已安裝的版本 |

| Android 參數 | 說明 |
|---|---|
| `--package` | 目標應用的 package（必填） |
| `--avd` | AVD 名稱（必填）；未開機時由驅動器開機 |
| `--apk` | 每次擷取前安裝的 APK，相對專案根目錄；裝置上同 package 若以其他金鑰簽章（另一個 checkout、或執行代理自行建置安裝），先解除安裝再安裝，回應的 `log` 會註明 |
| `--activity` | 啟動的 Activity 類別；省略時用 launcher activity |

| 共用參數 | 說明 |
|---|---|
| `--frame` | `safe-area`（預設）只比較內容區域；`device` 比較整個螢幕，含系統列 |
| `--timeout-ms` | 單一步驟的等待時間，預設 10000 |
| `--launch-url` | 以 deep link 啟動，取代啟動參數（iOS）或預設 launcher intent（Android），見 [deep link 啟動](#deep-link-啟動) |
| `--launch-timeout-ms` | 應用啟動到畫面錨點出現的等待時間，預設 60000（React Native 冷啟動需載入 JS bundle） |
| `--cache` | runner 與內容區域快取，預設 `.protoflow/cache/<ios\|android>-driver` |

驗證 PASS 需要 build、functional 與視覺三者都 PASS。`functional` 是應用自己的測試，不能由驅動器代替：SwiftUI／UIKit 用 XCUITest，Compose 用 Robolectric 上的 Compose UI test（JVM，不需模擬器），React Native 用 Jest，Flutter 用 `flutter test`。未配置時整體為 `NOT_RUN`。

Gradle 需要 `JAVA_HOME`：ProtoFlow 以不經 shell 的 argv 執行命令，請在啟動 ProtoFlow 的環境中匯出 `JAVA_HOME` 與 `ANDROID_HOME`。

ProtoFlow 監督每個命令的程序群組：命令結束後同一群組仍有程序存活時，會終止整個群組並把該步驟記為 FAIL。Gradle 與 Kotlin 的編譯 daemon 正是這類程序，因此 Android 專案（含 React Native、Flutter 的 `android/`）的 `gradle.properties` 需要：

```properties
org.gradle.daemon=false
kotlin.compiler.execution.strategy=in-process
```

直接呼叫 `gradlew` 時再加 `--no-daemon`。`flutter build apk` 會透過 Gradle 建置，同樣依 `gradle.properties` 生效。

Flutter 的 Android 建置在 Apple Silicon 上會以 Rosetta 執行 x86_64 的 `font-subset`（圖示字型子集化），曾在 Gradle 管線中無限期等待；沒有使用圖示字型、或不在意 APK 大小的驗收建置建議加 `--no-tree-shake-icons`（範例即如此，乾淨副本建置約 30 秒）。Robolectric 在 SDK 36 需要 Java 21；以 JDK 17 執行時，在 `src/test/resources/robolectric.properties` 設 `sdk=35`。

`platform` 為 `ios`、`android`、`react-native` 或 `flutter` 時採原生預設：T4 視覺為 advisory（感知相似度），回歸範圍 `affected+smoke`；T1–T3 required。

### viewport 與內容區域

驅動器先量出裝置的內容區域：iOS 用自帶 host 應用的安全區域，Android 用 probe activity 的系統列與 cutout inset。每台裝置在每個 runner 版本量一次並快取（驅動器原始碼改變時快取一併失效）。截圖裁到內容區域，畫面錨點的邊界就是這個區域；內容區域取整到整數點／dp，使 `viewport × scale` 與截圖像素完全相等（Android 的 136 px 狀態列在 3× 是 45.33 dp）。

target 的 `viewport` 必須等於該裝置的內容區域，原型也在同一尺寸下渲染；尺寸不符時驗證會明確 FAIL 並列出實際尺寸。iPhone 17（iOS 27）為 `402×778@3`，480 dpi 的 1080×2400 AVD（Android 16 手勢導覽）為 `360×730@3`。

因此原型設計的是**內容區域**：不畫狀態列、導覽列或 home indicator；頁面根元素（建議 `<body data-pf="…" data-pf-role="screen">`）填滿 viewport。

## 應用端約定

### 啟動參數

| 平台 | 驅動器傳入 | 應用讀取 |
|---|---|---|
| iOS | launch arguments `-PROTOFLOW_SCREEN <screen> -PROTOFLOW_STATE <state> -PROTOFLOW_FIXTURE <json>` | `UserDefaults.standard.string(forKey: "PROTOFLOW_SCREEN")` |
| Android | 字串 intent extras `PROTOFLOW_SCREEN`、`PROTOFLOW_STATE`、`PROTOFLOW_FIXTURE` | `intent.getStringExtra("PROTOFLOW_SCREEN")` |
| React Native | 同上 | iOS：`Settings.get('PROTOFLOW_SCREEN')`；Android：`MainActivity` 的 `getLaunchOptions()` 把 extras 轉成根元件的 initial props |
| Flutter | 同上 | 一個 `MethodChannel('dev.protoflow/launch')`，iOS 在 `AppDelegate`、Android 在 `MainActivity` 回傳上述值 |
| Expo Router | `--launch-url` 的 deep link（見下節） | 路由即畫面；`state`、`fixture` 是 query 參數（`useLocalSearchParams`） |

應用以這些值**直接打開該畫面**並套用 fixture，等同 Web target 的 `urlTemplate`。帶有 `PROTOFLOW_SCREEN` 時建議停用動畫。五種寫法都在 `examples/mobile` 中。

### deep link 啟動

畫面本身就是路由的應用（Expo Router、React Navigation linking）以 URL 打開畫面較自然。驅動器參數 `--launch-url` 是 URL 模板：

```text
--launch-url "protoflowtasks://{screen}?state={state}&fixture={fixture}"
```

`{screen}`、`{state}` 是場景的值，`{fixture}` 是 fixture 資料的 JSON（無 fixture 時 `{}`），三者都經 percent-encoding。模板必須含 `{screen}` 與 URL scheme，不能有其他 `{…}` 佔位符；不合格時驅動器在碰到裝置前就回報 `NOT_RUN`。

- iOS：先結束應用，再以 `XCUIApplication.open(URL)` 冷啟動；不再傳 launch arguments。
- Android：以 `ACTION_VIEW` intent（資料為該 URL，限定 `--package`）啟動，`PROTOFLOW_*` extras 照樣附上；應用的 Activity 需有對應 scheme 的 intent filter（Expo 由 `app.json` 的 `scheme` 產生）。
- 驗證產物的 `driver/job.json` 記錄展開後的 `launchUrl`；畫面錨點未出現時，失敗原因會列出該 URL。

### 錨點標記

| 框架 | 寫法 |
|---|---|
| SwiftUI | `.accessibilityIdentifier("tasks.add")`；畫面與 region 容器另加 `.accessibilityElement(children: .contain)`，否則識別碼會被套到每個子元素 |
| UIKit | `view.accessibilityIdentifier = "tasks.add"` |
| Compose | `Modifier.testTag("tasks.add")`；畫面根節點加 `Modifier.semantics { testTagsAsResourceId = true }` |
| Android View | `android:id` 不能含 `.`、`-`：以可逆轉換 `.` → `__`、`-` → `_`（`@+id/tasks__add`）；錨點語法不含 `_`，驅動器還原時不會混淆 |
| React Native | `testID="tasks.add"`；可點擊元件加 `accessibilityRole="button"`，讓它被視為 action |
| Flutter | `Semantics(identifier: "tasks.add")`；畫面與 region 用 `Semantics(container: true, explicitChildNodes: true, identifier: …)`；讀取無障礙樹需要語意樹，啟動時呼叫 `SemanticsBinding.instance.ensureSemantics()` |

隱藏的錨點（原型中 `hidden`）在原生端可以完全不渲染，視同隱藏。原生無障礙樹只分得出文字、密碼與搜尋欄位，讀不到鍵盤類型，因此原生 target 比對結構時，原型的 `email`、`tel`、`url`、`number` 輸入視為文字欄位；密碼仍需對應安全輸入。

React Native 注意事項：

- Fabric 會把 iOS 的無障礙樹壓平：帶 `testID` 的 `View` 在 XCUITest 中是沒有子元素的葉節點，文字與按鈕是同層的兄弟元素。驅動器以幾何包含（中心點落在容器範圍內）組出容器文字，與 SwiftUI 的階層結果一致。
- flex 欄位預設把子元素撐滿寬度；原型中只佔文字寬度的段落（例如錯誤訊息），`Text` 需加 `alignSelf: 'flex-start'`，否則 T3 寬度不符。
- iOS 27 強制 UIScene 生命週期；RN 0.87 模板的 `AppDelegate` 直接建立 `UIWindow`，啟動即中斷。需加入 `UIApplicationSceneManifest` 與 `SceneDelegate`（見 `examples/mobile/react-native/ios`）。
- 以 Release 配置建置，JS bundle 打包進 `.app`／APK；驗收不依賴 Metro。

Expo 注意事項（Continuous Native Generation，範例為 SDK 58、Expo Router）：

- Expo Go 不能作為驗收對象（bundle id 屬於 Expo Go，JS 由 Metro 載入）；build 要產出自己的 `.app`／APK。`ios/`、`android/` 由 prebuild 產生且被 Git 忽略，因此 target 的 `build` 先執行 `expo prebuild --clean`（重建原生專案並 `pod install`），變體的 `build` 再以 `xcodebuild`／`gradlew assembleRelease` 建置 Release。CocoaPods 需要 UTF-8 locale：範例把 `LANG=en_US.UTF-8 expo prebuild --clean` 寫成 npm script，ProtoFlow 以 argv 呼叫 `npm --prefix expo run prebuild`。
- 原生設定只能經 config plugin，手改 `ios/`、`android/` 會被下一次 prebuild 覆蓋。範例的 `plugins/with-protoflow.js` 只寫 `gradle.properties`：關閉 Gradle／Kotlin daemon（見上），並只建 `arm64-v8a`。
- SDK 58 的 prebuild 模板已採用 UIScene（`SceneDelegate` 與 `UIApplicationSceneManifest`），iOS 27 不需另外修補；Android 也不需修改 `MainActivity`，因為畫面由 deep link 打開。
- 每個原型畫面是一個路由（`app/<screen>.tsx`），`app.json` 的 `scheme` 提供 deep link；Stack 關閉標題列（`headerShown: false`，原型只畫內容區域）與轉場動畫。由 deep link 直接打開的畫面沒有上一頁，返回需改以 `router.replace`。
- 功能測試用 `jest-expo` preset 與 `expo-router/testing-library` 的 `renderRouter('./app', { initialUrl })`，在真實路由樹上驗證；`@testing-library/react-native` 14 的 `fireEvent` 是非同步的，需 `await`。
- Runner worktree 沒有 `node_modules`：以 `runner.setup` 執行 `npm --prefix expo ci`。

Compose 與 Flutter 注意事項：

- 可點擊的 `Box`／`Row` 在 Android 無障礙樹中是 `View`，文字在子節點：只含文字的可點擊容器視為按鈕，標籤取子節點文字。
- `BasicTextField` 的 placeholder（`decorationBox`）是輸入框的子文字節點，Flutter 在 iOS 把 hint 放在輸入框的 label；兩者在輸入框空白時都視為 placeholder，不計入外層容器文字。
- Compose 對可點擊元件強制 48 dp 觸控高度；T1 的兄弟順序以閱讀順序（見下方「閱讀順序」）判斷，較高的觸控區不會被誤判為在上方。

### 鍵盤

`fill` 會叫出軟體鍵盤（Android AVD 設硬體鍵盤時不會）。狀態的最後一步完成時鍵盤必須已收起（例如送出後結束編輯），否則擷取 FAIL，因為鍵盤會遮住畫面，原型中也不存在。失焦後鍵盤是非同步收起的（Flutter 需要數個影格），Android 驅動器最多等 3 秒，只有仍在螢幕上（範圍非空）的輸入法視窗才算可見。

## 驅動器如何回報元素

| 協定欄位 | iOS 來源 | Android 來源 |
|---|---|---|
| `count`、`bounds` | 同一識別碼的元素數量；第一個元素的 frame，換算為內容區域座標 | 同一 `resource-id`（去掉 `<package>:id/` 並還原轉換）的節點數；`boundsInScreen` 的 px ÷ density。捲動區外的節點被裁切時，以 `boundsInParent` 的尺寸還原（見下） |
| `visible` | frame 與內容區域相交且尺寸大於 0，或是捲動區已捲出畫面的內容 | `isVisibleToUser` 且與內容區域相交，或是捲動區已捲出畫面的內容 |
| `text` | 文字元素、按鈕取 label；輸入框取值，空白時取 placeholder（或 label）；容器依閱讀順序串接可見子元素的 label（同 `innerText`，不含輸入值，含捲出畫面的內容）；開關等控制項本身沒有文字 | 同左：`TextView` 取 text、`EditText` 取 text，空白時取 hint 或子文字 |
| `interactive`、`editable`、`inputType`、`role` | 依 XCUITest 元素類型 | 依 className 與 `isClickable`／`isCheckable`／`isEditable`／`isPassword` 正規化為相同類型；可勾選的 `Button`（`ToggleButton`、帶 checked 狀態的 React Native 按鈕）視為按鈕，文字取其標籤 |
| `style` | 不提供；T2 改以截圖在元素範圍內取樣主色比較 | 同左 |

**捲出畫面的內容**：網頁原型在 Playwright 中把折線以下的元素算作可見，文字也算進容器；原生平台只回報螢幕上的部分。為使兩邊一致，位於捲動區（iOS 的 `scrollView`／`table`／`collectionView`，Android 的 `isScrollable` 節點或 `ScrollView`、`HorizontalScrollView`、`RecyclerView`、`ListView`）內、中心落在捲動區之外的元素（或其所在的捲動區本身已捲出，例如折線以下的橫向列表）視為已渲染：`visible` 為 true，文字算進包含該捲動區的容器。不在任何捲動區內的畫面外元素（例如停在螢幕外的抽屜）仍不可見。Android 的 UiAutomator 還會把捲出節點的螢幕邊界裁到捲動區邊緣並回報 `isVisibleToUser` 為 false；驅動器另外回報節點的 `boundsInParent` 尺寸與 `isScrollable`，正規化時被夾住的那一側依尺寸往外還原並恢復可見。夾住的線可能是捲動區的外框，也可能是它的內距邊緣（React Native 裁到內距，siyue 實測在外框內 18 px），所以以離捲動區邊緣較近的一側為被夾住的一側（在下方的保留真實上緣，在上方或被上內距裁掉一截的保留真實下緣），兩側一樣近時保持原樣；本身被外層裁切的捲動區（例如折線以下的橫向列表），其內容沿該方向沿用外層的邊緣。捲動區內未被裁切卻不可見的節點（例如透明度為 0）仍不可見。容器文字依閱讀順序串接時，同一個捲動區的內容視為一整塊、放在捲動區的位置，和 DOM 的文件順序一致：疊在捲動區上方的固定分頁列排在捲動內容之後，不會插在折線上下之間。實測 siyue（React Native）在 iPhone 上原型可見、應用判為不可見的錨點從 31 個降為 0 個。

**閱讀順序**：容器文字與 T1 兄弟順序都依閱讀順序，由上而下分列，同一列再由左至右。兩個元素符合下列任一條件就算同一列：

- 垂直中心相差不超過較矮者高度的一半。
- 左右並排（水平不重疊），而且其中一個的垂直中心落在另一個的高度範圍內。

第二條對應左圖右文的版面：較高的圓環或圖示排在右側整疊文字之前，和 DOM 順序一致。例如 siyue `growth.goal` 的 84 pt 進度環在右側單行標題之前。

水平重疊的元素（疊在背景上的文字、上下堆疊的文字行）仍依中心點上下排序。

開關等控制項常以旁邊的可見標題作為無障礙名稱。這類控制項的 label 若與容器內其他文字相同，不論是否相鄰都略過；網頁的 checkbox 也沒有文字。

這兩條規則以 siyue 的 1,419 次歷史擷取（iPhone、iPad、Android）（16,765 個錨點文字）回放驗證：與原型一致的錨點從 14,830 個增為 14,896 個，原本一致的沒有任何一個變成不一致。

步驟對應：`tap` 點擊、`fill`／`clear` 點擊後清空再輸入（輸入後讀回欄位值；忙碌的模擬器可能漏字，不符時重打，最多三次，仍不符則 FAIL 並列出欄位實際內容；密碼欄位無法讀回不驗證）、`toggle` 點開關、`select` 調整 picker 或點選選項、`scroll-to` 捲動直到可見、`back` 返回、`wait-for` 等待出現。Android 在畫面錨點出現後先等 UI 閒置再重放步驟，擷取前清除 UiAutomation 快取並等無障礙樹穩定（Compose 會延遲發布語意變更）。

原始證據保存在驗證產物的 `driver/` 目錄：`job.json`（啟動參數與步驟）、`raw.json`（完整無障礙樹）、`device.png`（整個螢幕）、`screen.png`（比較用的裁切圖），失敗時另有 `failure.png`。

## target 變體：一份程式碼、多個平台

React Native 與 Flutter 的同一份程式碼同時是 iOS 與 Android 應用。若拆成兩個 target，兩條交付分支會修改同一批檔案而衝突，因此以 `variants` 表達：

```json
{
  "id": "flutter",
  "platform": "flutter",
  "root": "flutter",
  "functional": { "argv": ["flutter/tool/flutterw", "test"] },
  "deviations": [{ "anchor": "settings.notify-toggle", "allow": ["layout"] }],
  "variants": [
    { "id": "ios", "driver": { "kind": "external", "command": { "argv": ["node", "…/ios-driver.js", "--bundle-id", "…", "--device", "ProtoFlow iPhone 17", "--app", "flutter/build/ios/iphonesimulator/Runner.app"] } },
      "build": { "argv": ["flutter/tool/flutterw", "build", "ios", "--simulator", "--debug"] }, "viewport": { "width": 402, "height": 778, "scale": 3 } },
    { "id": "android", "driver": { "kind": "external", "command": { "argv": ["node", "…/android-driver.js", "--package", "…", "--avd", "ProtoFlow_Pixel", "--apk", "flutter/build/app/outputs/flutter-apk/app-release.apk"] } },
      "build": { "argv": ["flutter/tool/flutterw", "build", "apk", "--release"] }, "viewport": { "width": 360, "height": 730, "scale": 3 } }
  ]
}
```

- target 仍是 FIFO、worktree、Codex 執行與交付的單位：一條交付分支，一次合併。
- `driver` 與 `variants` 擇一。變體必須有 `id` 與 `driver`，可覆寫 `build`、`viewport`、`tiers`、`regression`、`visual`、`layout`、`tokens`、`deviations`、`locator`、`timeoutMs`；`functional`、`root`、`platform` 屬於 target。
- build：先執行 target 的 `build`（若有），再依序執行每個變體的 `build`，記錄於 `build.variants`。
- 驗收：依序擷取每個變體，證據在 `<target>/<variant>/<scene>`，報告在 `<target>/<variant>/report.html`；verification 的 `visual.variants` 列出各變體狀態，場景帶 `variant` 欄位。所有 `required`（預設）變體都 PASS 時 target 才 PASS；`"required": false` 的變體只記錄（例如仍在建置中的平台），失敗的 build 也不阻擋。至少要有一個必要變體。建置沒有 PASS 的變體（或 target 自身的建置失敗時的所有變體）不執行擷取：App 無法啟動，每個場景只會等到驅動器的啟動逾時；該變體記為 NOT_RUN，原因寫明 `build:<變體> FAIL; captures skipped`，失敗原因在 `build` 的記錄中。
- 給執行代理的 context 說明這份程式碼在哪些變體上驗收，要求修改在每個必要變體都成立。

## 平台慣例差異（deviations）

原生控制項的尺寸與外觀跟著平台走，例如 Material 3 開關寬 52 dp，原型（iOS 樣式）為 61。逐錨點宣告已審核的差異：

```json
"deviations": [{ "anchor": "settings.notify-toggle", "allow": ["layout"] }]
```

`allow` 中的 `tokens`、`layout`、`visual` 讓該錨點在對應層級（T2、T3、T4）不參與比較；畫面錨點與 T1 結構永遠比較。其他值只記錄。套用的差異寫入場景證據的 `deviations`，供審查確認。

## 生成檔與自動交付

原生專案的 build 會產生大量檔案。application hash（context、verify、review 與交付共用）排除兩類：

- 任何深度的 `RUNTIME_DIRS`：DerivedData、Pods、`.gradle`、xcuserdata、node_modules 等，不論是否有 Git。
- Git checkout 中被忽略的**未追蹤**檔，例如 React Native 的 `ios/build/generated/`（codegen）、`vendor/`、`.bundle/`、`ios/.xcode.env.local`，Gradle 的 `build/`，Flutter 的 `build/` 與 `.dart_tool/`，以及 Expo Continuous Native Generation 產生並忽略的整個 `ios/`／`android/`。

因此 build 或 functional 重新產生這些檔案不會讓驗收記為 `changedDuringVerification`，交付 commit 不含它們，獨立 review gate 也不會因「application bytes 與 commit tree 不符」而 BLOCKED。已追蹤的原生檔案（例如手寫的 `ios/` 專案、`Podfile.lock`，或用 `git add -f` 加入的檔）照常綁定。

這表示 evidence 只證明被 commit 的內容；被忽略的生成檔由 target 的 `build` 負責。請讓 build 從 commit 可重複地重建它們（例如先 `pod install`，Expo 用 `npx expo prebuild --clean`），不要依賴手動放在 worktree 中、無法從 commit 重建的忽略檔。非 Git 專案只排除 `RUNTIME_DIRS`。細節見 [Git 忽略的檔案](independent-review.md#git-忽略的檔案)。

## 效能與限制

- iOS 每個場景是一次 `xcodebuild test-without-building`，約 15–40 秒；Android 每個場景是一次 instrumentation，約 5–10 秒。runner 只在驅動器原始碼或 Xcode／JDK 版本改變時重新建置。
- T2 只比較取樣的主色，不比較字級與字重；字型與排版差異由 T3 相對版面與 T4 感知相似度觀察。兩邊都有截圖、但沒有任何錨點在兩邊都有單一主色（例如只有整頁根錨點、底下內容混雜）時，T2 仍為 PASS，`sampled` 為 0 並附 `note` 說明沒有可取樣的錨點；只有缺截圖時才是 `NOT_RUN`。
- 驅動器只在本機或專案自備的 CI 上執行，不提供裝置農場或實機；CI 不執行模擬器驗收（`tests/e2e/ios.spec.js`、`tests/e2e/android.spec.js` 為設定環境變數才執行的真實驗收）。

## 驗收紀錄

### 2026-10-12：iOS

`examples/mobile` 在 iPhone 17 模擬器（iOS 27.0、Xcode 27.0）以真實 XCUITest 驗證同一個原型版本：

| target | build | functional | T1 結構 | T2 token | T3 版面 | T4 視覺（advisory） |
|---|---|---|---|---|---|---|
| `ios`（SwiftUI） | PASS | PASS（XCUITest 3/3） | PASS | PASS | PASS | 整體相似度 0.978–0.993 |
| `react-native`（RN 0.87.1，Release） | PASS | PASS（Jest 3/3） | PASS | PASS | PASS | 整體相似度 0.983–0.992 |

5 個場景（tasks：initial、empty-error、added；settings：initial、saved）在兩個 target 都通過必要層級。T4 未達每個區域 0.92 的門檻，主因是 Chromium 與 iOS 的字型渲染差異；它是 advisory，不阻擋驗收。

過程中發現並修正：iOS 27 開關尺寸為 61×28（原型需跟著平台更新）；RN 0.87 模板需改用 UIScene；RN `Text` 需 `alignSelf: 'flex-start'` 才與只佔文字寬度的段落一致。系統高負載時（`simctl` 一次操作數分鐘）曾出現安裝或啟動逾時，均記為 `NOT_RUN`，重跑後 PASS。

### 2026-10-13：Android、Flutter 與 target 變體

同一個原型版本在 iPhone 17 模擬器（iOS 27.0）與 AVD `ProtoFlow_Pixel`（Android 16／API 36、1080×2400、480 dpi）上，四個 target 全部接受，`release.version` 前進到該版本：

| target | 變體 | build | functional | T1–T3 | T4 整體相似度（advisory） |
|---|---|---|---|---|---|
| `ios`（SwiftUI） | — | PASS | XCUITest 3/3 | PASS | 0.978–0.993 |
| `android`（Compose） | — | PASS | Robolectric 3/3 | PASS（開關 `layout` deviation） | 0.975–0.984 |
| `react-native`（0.87.1） | `ios`、`android` | PASS／PASS | Jest 3/3 | PASS／PASS | 0.983–0.992／0.973–0.983 |
| `flutter`（3.47.7） | `ios`、`android` | PASS／PASS | `flutter test` 3/3 | PASS／PASS | 0.975–0.984／0.978–0.983 |

Android 每個場景約 5–10 秒；整個 Compose target（build、functional、5 個場景）約 40 秒，React Native 兩個變體約 2 分鐘，Flutter 兩個變體約 1 分 45 秒。過程中發現並修正的事項見 [提案 0002 §13](proposals/0002-android-flutter.md)。

### 2026-10-14：protoflow-test 真實自動交付（iOS、Android、Flutter）

在 `zhangqiu-ai/protoflow-test` 以 Runner 全自動處理兩個原型版本：Codex 執行代理實作 → build／functional／T1–T4 分層驗收 → 有界修復 → 獨立唯讀 Codex 審查 → automated approval（`ai:` 身分）→ 每個 target 各自的 PR 與合併。三個必要 target 都交付後 `release.version` 前進（`basis: "delivery"`）。

| 版本 | iOS（SwiftUI） | Android（Compose） | Flutter（`ios`＋`android` 變體） |
|---|---|---|---|
| v(a) `2fc9e77`：靛藍主色與「My day」標題 | PR #15 | PR #16 | PR #17 |
| v(b) `dc8811c`：新增可展開的 About 畫面 | PR #20 | PR #19 | PR #18 |

驗收中發現並修正的引擎缺陷（v0.3.4）：

| 現象 | 修正 |
|---|---|
| Codex 串流中斷後自動重連，trace 中的 `Reconnecting... 1/5` 讓審查關卡判定「沒有完成的 session」 | turn 內、之後仍完成的重連通知不算失敗 |
| 多 target 審查要求整個 repository 符合新版本，因尚未交付的 Flutter 判 Android FAIL | binding 帶 `scope`，兄弟 target 不在審查範圍 |
| Flutter 輸入框失焦後鍵盤非同步收起，Android 驅動器誤判鍵盤仍可見 | 輸入法視窗須在螢幕上持續 3 秒才算可見 |
| 執行代理沙箱無法寫入 Flutter SDK、`~/.dart-tool` 且不能綁定 127.0.0.1，無法跑 `flutter test` | adapter 的 `--add-dir`、`--network` |
| 執行代理經 adb 以其他金鑰簽章重裝受測應用，驗收 APK 無法覆蓋安裝 | 驅動器替換以其他金鑰簽章的已安裝版本 |
| `runner configure` 同步到 worktree 的配置變更，被當成「基底改了共享檔」 | 內容逐位元相同的基底變更可整合 |
| 執行代理把 `GRADLE_USER_HOME` 放進專案，26,437 個快取檔被驗收並提交 | 驗證的 `hygiene` 檢查；執行代理指示快取放在專案外；審查 diff 過大時清楚回報 |
| 送給執行代理的 context 夾帶逐檔雜湊與完整 `git status`，超過 Codex 輸入上限 | 只送雜湊與檔案數，`git` 欄位截到 64 KB；adapter 先行檢查上限 |
| 被拒、未發布的交付 commit 留在祖先中，修復後的交付會把它們帶進共用分支 | 提交前丟棄被拒歷史；已建立在其上的未發布交付退役重做 |
| 一個 target 改了共享頂層檔（`.gitignore`），兄弟 target 的交付永久 BLOCKED | Runner 合併新基底並以 reverify 重新驗收 |
| Runner 在記錄 PID 前被終止，`runner retry` 只能人工修改紀錄 | `runner retry --recover-unknown-start` 由引擎確認並記錄 |
| reviewer 依含狀態列的整螢幕截圖誤判 iOS 畫面下移；執行代理照做兩次都被 T1／T3 擋下 | 審查提示說明各證據檔；拒收 findings 須對照證據檢驗，拒收附被拒驗證摘要 |
| 模型滿載等供應端暫時錯誤讓版本 BLOCKED | 同一 attempt 有界退避重試 |

reviewer 的真實發現也在過程中被修正：Android 開關未勾選時沿用 Material 3 預設色（`layout` deviation 不豁免顏色），重開後由執行代理修正並重新驗收。所有 automated approval 都標示為 AI 證據，遠端分支不含任何被拒內容（以 `git log -- '*gradle-user-home*'` 驗證）。證據摘要保存在驗收專案的 `evidence/mobile-real-acceptance-20261014.json`。

### 2026-10-14／15：第三、四個版本與首次零介入

| 版本 | iOS | Android | Flutter | 人工介入 |
|---|---|---|---|---|
| v(c) `7a40653` | PR #21 | PR #22 | PR #23 | 11 次 |
| v(d) `25da01f`：About 顯示版本號、詳情可收合 | PR #24 | PR #25 | PR #26 | **0** |

v(c) 的每次介入都對應一個引擎缺口，在 v0.3.6–v0.3.8 修正：執行代理逾時與孤兒 Gradle 程序、`~/.gradle` 沙箱權限、已發布交付的保護、過期基底重建、PASS 後網路失敗的重審、審查被中斷、`runner configure` 改寫有未結交付的 worktree 配置、Android 模擬器輔助程序被誤清理。v(d) 在 v0.3.8 上從推送原型到最後一個 target 合併共 32 分 43 秒，每個 target 各一次審查、零修復、零阻擋，`release.version` 自動前進；唯一的自動處置是執行與驗證後停止殘留的 Xcode `DTServiceHub`。證據摘要：驗收專案的 `evidence/zero-intervention-20261015.json`。

### 2026-10-15：Claude 規劃與驗收、GitHub Issues（提案 0003 P6）

規劃者與驗收者為 Claude Opus，執行者為 Claude Sonnet（Codex 備援未被觸發），在同一個行動驗收專案上跑一個原型版本與 5 個 Issue。

| 項目 | 結果 |
|---|---|
| v(e) `cd94bf9`：Settings 新增預設開啟的「Weekly summary」 | iOS #30、Android #31、Flutter #32；Flutter 首次被 Claude 驗收拒收，自動重開、重新規劃並修正後交付 |
| #33 點設定名稱不會切換（原型以 `<label>` 包住開關） | Flutter #35、iOS #36、Android #37，Issue 自動結案；Flutter 首次修改破壞 settings 結構層，原型回歸驗證擋下，修復一輪後通過 |
| #34 Flutter 補「只有空白」與「前後空白」的測試 | #38，自動結案 |
| #27、#28：原型沒有定義的新互動 | `needs-human`，規劃者建議改走原型流程（判斷正確） |
| #29「App 很慢」 | `needs-info`，留言列出 5 個問題 |

Claude 費用約 6 美元（規劃 1.56、執行 1.39、驗收 3.09）。這輪不是零介入：兩次環境修正（runner 缺 Homebrew 路徑、`~/.local/bin/node` 被移除）、改出符合原型的 Issue，以及兩個引擎修正：v0.3.10（已退役交付讓 target 永遠不接 Issue）、v0.3.11（同一 Issue 其他 target 合併後 base 前進、停止被當成阻塞、重複的開始留言）。證據摘要：驗收專案的 `evidence/p6-claude-issues-20261015.json`。

### 2026-10-18：前後端分流的零介入驗收（v0.3.13）

規劃與驗收為 Claude Opus；執行者依 `policy.executor.routes` 分流：前端（原型與前端 Issue）由 Claude Sonnet、後端 Issue 由 Codex。Runner 在驗收開始前啟動一次，之後全程未接觸 Runner、配置或 GitHub。

| 項目 | 規劃 | 執行者 | 結果 |
|---|---|---|---|
| v(f) `3ab42c5`：空白任務提示改為「Type a task name first.」 | Opus | Sonnet | iOS #41（修復一輪）、Android #42、Flutter #43 |
| #39 iOS、Android 在輸入框按 Return 不會新增任務（原型為 `<form>`） | Opus：`frontend`，L1 | Sonnet | iOS #44、Android #45，自動結案 |
| #40 Android 新增驗證抽成純 Kotlin 函式並加 JVM 單元測試 | Opus：`backend`，L1 | Codex | #46，自動結案（Codex 實作、Claude 驗收） |

從推送原型到最後一次合併共 53 分鐘：人工介入 0、阻塞 0、審查拒收 0、執行者備援 0、修復 1。Claude 費用約 4.25 美元（規劃與分流 1.47、執行 0.72、驗收 2.06；Codex 另計）。證據摘要：驗收專案的 `evidence/zero-intervention-routes-20261018.json`。

### 2026-10-18：Expo（SDK 58、Expo Router、CNG）與自動交付（提案 0002 P3.5）

**範例**：`PROTOFLOW_EXPO=1` 的 Playwright 真實驗收（`tests/e2e/android.spec.js`）把 `examples/mobile` 複製成乾淨的 Git checkout（不含 `expo/ios`、`expo/android`），由 target build 執行 `expo prebuild --clean`，再建置 iOS、Android Release：

| target | build | functional | T1 結構 | T2 token | T3 版面 | 啟動 |
|---|---|---|---|---|---|---|
| `expo`（變體 `ios`、`android`） | PASS | PASS（jest-expo 5/5） | PASS | PASS | PASS | deep link，`job.json` 記錄 `protoflowtasks://settings?state=initial&fixture=%7B%7D` |

整個測試 17.4 分鐘（prebuild 與 `pod install`、兩個 Release 建置、10 個場景）；prebuild 重新產生的被忽略原生專案沒有造成 `changedDuringVerification`。

**自動交付**：獨立驗收專案（protoflow-test 的 `expo-acceptance` 分支，原型來源 `protoflow-expo-20261018`）只有 `expo` 一個 target，規劃與驗收為 Claude Opus、執行者為 Claude Sonnet，`runner.setup` 為 `npm --prefix expo ci`。原型 v1 `03778d7`（標題下顯示任務數量）：

1. 第一輪 verify PASS（兩變體 T1–T3 PASS），獨立審查以一個低嚴重度發現（JSX 屬性間缺空格）判 FAIL，Runner 自動拒收；但因為唯一的 target 回報 BLOCKED，Runner 判定全部卡住而結束（exit 3）。這是引擎缺陷：多 target 專案有其他 target 讓迴圈繼續，所以先前未出現。已修正：自動拒收回傳 `REOPENED`，同一輪立即重開並修復（上限仍是 `MAX_AUTOMATED_REOPENINGS`）。
2. 重新啟動 Runner 一次後，規劃、修復、verify PASS、獨立審查 PASS，交付 [protoflow-test#47](https://github.com/zhangqiu-ai/protoflow-test/pull/47) 自動合併（變更 `expo/app/tasks.tsx`、`expo/src/ui.tsx` 與功能測試）。

從推送原型到合併 49 分鐘，人工介入 1（上述重啟），Claude 費用約 1.40 美元（規劃 0.47、執行 0.25、審查 0.68）。T4 為 advisory：場景整體相似度 0.947–0.992，低於門檻的元素是標題列字型渲染。證據摘要：驗收專案的 `evidence/expo-p35-20261018.json`。
