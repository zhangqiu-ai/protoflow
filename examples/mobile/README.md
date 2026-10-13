# 原生範例：iOS（SwiftUI）與 React Native

同一份手機原型（`prototype/`，兩個畫面 tasks、settings）驅動兩個原生應用：

```text
prototype/        手機尺寸的 HTML 原型，data-pf 錨點與 *.pf.json 狀態
ios/              SwiftUI 應用，accessibilityIdentifier 帶相同錨點 ID
react-native/     React Native 應用，testID 帶相同錨點 ID（iOS 驗收）
protoflow.config.json   target ios（與 react-native），外部驅動器 scripts/ios-driver.js
```

應用遵守 [原生 target 約定](../../docs/native-targets.md)：讀取 `-PROTOFLOW_SCREEN` 啟動參數直接打開畫面；畫面與 region 容器以 `.accessibilityElement(children: .contain)`（SwiftUI）包住子元素。

在共享引擎根目錄執行（需要 macOS、Xcode 與名為 `ProtoFlow iPhone 17` 的模擬器）：

```sh
xcrun simctl create "ProtoFlow iPhone 17" com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0
node bin/protoflow.js checkpoint --project examples/mobile --summary "Mobile v1"
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target ios
```

React Native target 需要先安裝依賴（CocoaPods 需要 UTF-8 語系）：

```sh
cd examples/mobile/react-native && npm install
cd ios && LANG=en_US.UTF-8 pod install
node bin/protoflow.js verify --project examples/mobile --manifest MANIFEST_ID --target react-native
```

React Native 以 Release 配置建置，JS bundle 打包進 `.app`，驗證時不需要 Metro。`release.requireTargets` 要求兩個 target 都接受後版本才發佈。

兩個 target 都有自己的功能測試：SwiftUI 為 `ios/ProtoFlowTasksUITests`（XCUITest，`functional` 以 `xcodebuild test` 在同一台模擬器執行），React Native 為 `react-native/__tests__`（Jest）。

`verify` 先以 target 的 `build` 建置 `.app`，再逐一場景由驅動器安裝、啟動、重放步驟並擷取。報告位於 `.protoflow/artifacts/VER_ID/report.html`。
