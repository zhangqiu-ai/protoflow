# 原生範例：iOS、Android、React Native、Expo 與 Flutter

同一份手機原型（`prototype/`，兩個畫面 tasks、settings）驅動五份應用程式碼、八個執行平台：

```text
prototype/        手機尺寸的 HTML 原型，data-pf 錨點與 *.pf.json 狀態
ios/              SwiftUI 應用（target ios），accessibilityIdentifier；XCUITest 功能測試
android/          Compose 應用（target android），testTag + testTagsAsResourceId；Robolectric 功能測試
react-native/     React Native 0.87.1（target react-native，變體 ios、android），testID；Jest 功能測試
expo/             Expo SDK 58 + Expo Router（target expo，變體 ios、android），CNG、deep link 啟動；jest-expo 功能測試
flutter/          Flutter 3.47（target flutter，變體 ios、android），Semantics(identifier:)；flutter test
protoflow.config.json   五個 target，release.requireTargets 要求全部接受
```

應用遵守 [原生 target 約定](../../docs/native-targets.md)：以 `PROTOFLOW_SCREEN` 啟動參數（iOS launch argument、Android intent extra）直接打開畫面；畫面與 region 容器把錨點放在容器上。Expo 不讀啟動參數，而是由驅動器的 `--launch-url` 以 deep link `protoflowtasks://<screen>?state=…&fixture=…` 打開路由。React Native、Expo 與 Flutter 是一份程式碼兩個平台，以 [target 變體](../../docs/native-targets.md#target-變體一份程式碼多個平台) 表達，交付只有一次。

## 環境

- iOS：macOS、Xcode，模擬器 `ProtoFlow iPhone 17`：

  ```sh
  xcrun simctl create "ProtoFlow iPhone 17" com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0
  ```

- Android：JDK 17、Android SDK，AVD `ProtoFlow_Pixel`（480 dpi、硬體鍵盤，見原生 target 文件）；執行前匯出 `JAVA_HOME`、`ANDROID_HOME`。
- React Native：`cd react-native && npm install`，`cd ios && LANG=en_US.UTF-8 pod install`。
- Expo：`cd expo && npm install`。`ios/`、`android/` 不提交，由 target 的 build（`expo prebuild --clean`，含 `pod install`）每次重新產生；不需要 EAS 帳號。
- Flutter：`flutter` 在 `PATH`；`flutter/tool/flutterw` 讓命令在 Flutter 專案內執行。

## 執行

在共享引擎根目錄：

```sh
node bin/protoflow.js checkpoint --project examples/mobile --summary "Mobile v1"
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target ios
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target android
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target react-native
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target expo
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target flutter
node bin/protoflow.js queue --project examples/mobile
```

`verify` 先以 target（與每個變體）的 `build` 建置，執行 `functional`，再逐一場景由驅動器安裝、啟動、重放步驟並擷取。報告位於 `.protoflow/artifacts/VER_ID/<target>[/<variant>]/report.html`。React Native 以 Release 建置（JS bundle 打包進 app／APK），不需要 Metro。

Android（含 Expo、React Native 的 Android 變體）與 Flutter 的開關使用 Material 3 尺寸（52 dp），與原型的 iOS 樣式（61 pt）不同，以 `deviations` 宣告為已審核的平台差異。
