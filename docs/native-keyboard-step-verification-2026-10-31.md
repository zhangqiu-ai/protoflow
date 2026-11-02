# 原生輸入後定位與等待的回應判定

2026-10-31；隔離工作目錄 `/Users/feature/.codex/worktrees/protoflow-native-control-text-ya7uxi/protoflow`。本輪只修改通用 `nativeResponse` 的編輯意圖判定、相關持久測試與文件；不修改 UIKit probe、Swift、登入或比較門檻。其他代理的差量另行保留。

## 問題與修正

使用端已保留同一 App 的原生記錄：`qa-jit-note-scroll-44f8-nQXJAk/raw.json` 為 `PASS`，`keyboardVisible:true`、實測鍵盤 `{x:0,y:451,width:375,height:216}`，Save 的 exists／enabled／hittable 皆為 true。主代理另已檢視實際 PNG。本輪作者只讀核對 raw 與步驟，不執行該原生情境。舊回應策略只看最後一步，因此 `fill` 後接 `scroll-to` 會被誤認為應已結束輸入。

修正只略過尾端 `scroll-to`／`wait-for`，再由最近的其他動作判斷：只有 `fill`／`clear` 建立編輯意圖；`tap`、`toggle`、`select`、`back`、未知動作會中斷，沒有先前輸入或只有定位／等待也不允許可見鍵盤。後續新的 `fill` 可以重新建立編輯意圖。

鍵盤範圍、螢幕／內容裁切、遮蔽座標、鍵盤子樹排除與原有幾何判定不改。缺少實測鍵盤 frame 仍是 `NOT_RUN`；停在螢幕外或未顯示的鍵盤不產生遮罩。這不是新增任意遮蔽區域。

## 持久回歸

新增 Node 與 Node Playwright 測試都直接呼叫正式 `nativeResponse`，處理同一明確標示 synthetic 的 PNG／原生樹 fixture；不是模擬回傳成功，也不是原生裝置驗收。

```sh
node --test tests/native-keyboard-steps.test.js
npx playwright test --config tests/native-keyboard-playwright.config.js
```

來源未修正時，Node **2 PASS／4 FAIL**；Playwright **2 PASS／2 FAIL**。輸入後定位／等待及缺少鍵盤 frame 的預期分別重現為錯誤的 `FAIL`；原有中斷操作、沒有先前輸入、螢幕外與未顯示鍵盤的負例維持預期。

修正後，同樣 Playwright **4/4 PASS**，覆蓋輸入後定位／等待、PNG 裁切尺寸、實測 occluded、keyboard subtree 排除、中斷操作、無 frame 的 `NOT_RUN` 與螢幕外不遮罩。連同既有 iOS driver／responsive／完整替換／啟動準備／native-control-text 測試，Node **38/38 PASS**：

```sh
node --test tests/native-keyboard-steps.test.js tests/ios-driver.test.js \
  tests/ios-responsive-driver.test.js tests/ios-public-input-replacement.test.js \
  tests/ios-launch-preparation.test.js tests/native-control-text.test.js
```

原始紀錄保留於 `/tmp/protoflow-keyboard-neutral-node-red.log`、`/tmp/protoflow-keyboard-neutral-playwright-red.log`、`/tmp/protoflow-keyboard-neutral-node-green.log`、`/tmp/protoflow-keyboard-neutral-playwright-green.log`。來源與測試雜湊保留於 `/tmp/protoflow-keyboard-neutral-hashes.json`。

本輪沒有啟動原生 App、登入真實帳號、呼叫 provider 或執行 commit。Swift/JIT 未改，因此沒有重複編譯。使用端主代理仍須核對同一實際 raw 的重新判定及後續整體原生驗證；本記錄不宣稱 TestFlight 已交付。
