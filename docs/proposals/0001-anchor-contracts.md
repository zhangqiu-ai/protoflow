# 提案 0001：以語意錨點與 UI 合約取代元件映射

| 項目 | 內容 |
|---|---|
| 狀態 | 已接受；P0、P1（含真實驗收）與外部驅動器協定已完成（見 §16） |
| 日期 | 2026-10-08 |
| 影響範圍 | 配置 schema、checkpoint／來源凍結、Context Package、驗證、Runner／交付 |
| 相關文件 | [架構](../architecture.md)、[Git Runner](../git-runner.md)、[原型拆分](../prototype-structure.md)、[整合協定](../integrations.md) |

## 1. 摘要

ProtoFlow 的目標是通用的原型驅動開發：同一份 HTML 原型，驅動 Web、Electron、iOS、Android、Flutter、React Native 等不同架構的正式應用。現行的 `mappings` 以「原型檔案 glob + 原型 CSS selector + 應用 CSS selector + 應用元件檔案路徑」描述對應關係，隱含三個只在 Web 成立的前提：應用畫面是 DOM、一塊區域等於一個實作檔案、一致等於像素與 computed style 相同。

本提案以三個平台中立的概念取代它：

1. **語意錨點（anchor）**：設計者在原型元素標上穩定 ID（`data-pf="checkout.summary"`），是唯一的跨平台識別。
2. **UI 合約（contract）**：引擎從每個凍結的原型版本自動抽取「畫面 × 狀態」下的錨點結構、文字、互動、token 與相對版面，作為驗收依據與變更範圍來源。
3. **目標與驅動器（target / driver）**：每個應用平台一個 target，由驅動器以該平台原生的可測試性標記（`data-testid`、`accessibilityIdentifier`、`testTag`、`Key`、`testID`）定位錨點、驅動狀態並回傳截圖與元素樹。

驗收改為**分層**：結構語意（所有平台必過）→ token → 相對版面 → 視覺相似度（Web 可要求像素級，原生平台用感知相似度）。實作位置由執行代理以錨點 ID 搜尋程式碼取得，不再由人維護檔案路徑。

版本佇列、凍結版本、證據 hash 綁定、依序推進、交付與批准流程維持不變。

## 2. 背景與問題

### 2.1 現行 mapping 的職責

`mappings` 在引擎中同時承擔三件事：

| 職責 | 現行實作 | 程式位置 |
|---|---|---|
| 變更範圍 | 原型檔案命中 `prototypeFiles` glob → mapping id | `src/sessions.js` `classifyChanges` |
| 實作指引 | Context 帶入 mapping 的 `component` 路徑；未映射變更拒絕建立 context | `src/workflow.js` `createContext` |
| 驗收定位 | 以 `prototype`／`application` CSS selector 量測幾何、computed style、區域像素；變更 mapping 需有 PASS 場景覆蓋 | `src/visual.js`、`src/workflow.js` `verify` |

此外，schema 強制五個欄位（`src/config.js`），Runner 以 mapping id 與 `prototypeFiles` 作為不可變的路由所有權（`src/runner.js` `configureRunner`），`doctor` 要求至少一筆 mapping。

### 2.2 問題

**P1 只適用 DOM。** iOS（SwiftUI／UIKit）、Android（Compose／View）、Flutter（canvas 繪製）、React Native 的原生 view 都沒有 CSS selector 與 computed style。引擎目前以 `visual.mode: "native"` 記錄 `NOT_RUN`，等於非 Web 平台沒有自動驗收。

**P2 「一個區域 = 一個檔案」不成立。** 原生 UI 的一塊區域常分散在 View、修飾器、主題、資源檔；同一原型區域在多平台專案中同時對應 iOS、Android、Web 三份實作，現行結構只能 1:1。

**P3 像素與 CSS 相等不是跨平台的正確標準。** 字型渲染、DPI、安全區、平台控制項（導覽列、鍵盤、捲動回彈）本來就不同；要求原生平台像素等同 HTML 原型，結果只會是永遠 FAIL 或把門檻放寬到失去意義。

**P4 人工維護成本高，實際使用已退化。** 真實驗收專案 `protoflow-test` 最終只保留一筆 mapping：`prototype/**` → `#panel` → `app/index.html`。範圍判斷與實作指引因此失效（任何改動都命中它、Codex 仍需讀整個專案），新頁面與新功能仍需人工 `runner configure` 更換場景與測試。

### 2.3 仍然需要解決的問題

映射背後的三個職責是真實需求：知道這次改了**哪些畫面與元素**、告訴執行者**要改什麼**、知道應用的**哪一塊要與原型的哪一塊比對**。本提案保留這三個職責，改變承載它們的資料。

## 3. 目標與非目標

### 目標

- **G1 平台中立的識別**：同一錨點 ID 在所有目標平台指向同一個設計元素。
- **G2 多目標**：一個原型版本可驅動多個 target，各自依序推進與交付。
- **G3 自動範圍**：由原型版本間的合約差異得出變更的畫面、狀態、錨點，不依賴人工 glob。
- **G4 免維護實作位置**：不再要求配置元件檔案路徑；位置由執行代理搜尋錨點取得，並自動累積索引。
- **G5 誠實的分層驗收**：每層對每個平台明確 PASS／FAIL／NOT_RUN；無法執行的層不能算通過。
- **G6 保留既有保證**：FIFO、凍結版本、證據綁定、交付與自動批准標記不受影響。
- **G7 漸進遷移**：Web／Electron 先行，v1 配置在相容模式下繼續可用。

### 非目標

- 不自動產生各平台程式碼（仍由 Codex 等執行代理實作）。
- 不追求原生平台與 HTML 原型像素相同。
- 不提供裝置農場、雲端模擬器或實機管理；驅動器在本機或專案自備的 CI 執行。
- 不以 AI 視覺判斷作為唯一驗收門檻（見 §7.5）。
- 不改變 Windows 監督限制（仍保守拒絕自動恢復）。

## 4. 核心概念

### 4.1 錨點（anchor）

設計者在原型 HTML 標記需要追蹤的元素：

```html
<main data-pf="checkout" data-pf-role="screen">
  <section data-pf="checkout.summary" data-pf-role="region">
    <h2 data-pf="checkout.summary.title">Order summary</h2>
    <ul>
      <li data-pf="checkout.summary.item" data-pf-repeat>...</li>
    </ul>
    <p data-pf="checkout.summary.total">$42.00</p>
  </section>
  <button data-pf="checkout.pay" data-pf-role="action">Pay now</button>
</main>
```

| 屬性 | 規則 |
|---|---|
| `data-pf` | ID，語法 `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`，以 `.` 表示層級；同一畫面狀態內唯一（`data-pf-repeat` 除外） |
| `data-pf-role` | `screen`、`region`、`element`（預設）、`action`、`input` |
| `data-pf-repeat` | 清單項目樣板；驗收比較數量（依 fixture）與第一項內容，不要求唯一 |
| `data-pf-visual-only` | 無語意的裝飾或繪圖（插畫、圖表），只參與 T4 視覺層 |
| `data-pf-text="dynamic"` | 文字由資料決定（時間、金額），T1 只檢查存在與格式類型，不比對內容 |

規則：

- 每個原型頁面必須有且只有一個 `role="screen"` 錨點，建議放在 `<body>`，使整頁（含導覽）都在畫面內；應用端同樣在頁面根元素標上畫面 ID。缺少時該提交不成為版本（§16.3），不自動產生（自動產生的 ID 無法跨版本穩定）。
- 錨點 ID 是設計契約：改名等於刪除舊錨點並新增錨點，合約差異會如實呈現。
- 未標錨點的元素仍被凍結與渲染，變更時歸到最近的祖先錨點；至少歸到所在畫面。
- 合約記錄每個錨點的**自身文字**（不含巢狀錨點內的文字），子元素文字變更不會讓所有祖先也被標為變更。

### 4.2 畫面與狀態（screen × state）

- **畫面**：一個帶 `role="screen"` 錨點的原型頁面。
- **狀態**：從畫面初始狀態出發，經 fixture 與互動步驟到達的狀態。`initial` 永遠存在。
- 狀態宣告放在與頁面同目錄的 sidecar `*.pf.json`，隨原型一起提交與凍結，由設計端擁有：

```json
{
  "schemaVersion": 1,
  "screen": "checkout",
  "states": {
    "initial": { "fixture": "cart-two-items" },
    "paying": { "from": "initial", "steps": [{ "action": "tap", "anchor": "checkout.pay" }] },
    "card-error": {
      "from": "initial",
      "steps": [
        { "action": "fill", "anchor": "checkout.card", "value": "4000 0000 0000 0002" },
        { "action": "tap", "anchor": "checkout.pay" }
      ],
      "expect": { "visible": ["checkout.card.error"], "hidden": ["checkout.success"] }
    }
  },
  "fixtures": { "cart-two-items": { "items": 2 } }
}
```

步驟只引用錨點，不引用 CSS selector，因此同一份狀態定義可由任何平台的驅動器重放。`action` 為平台中立詞彙：`tap`、`fill`、`clear`、`select`、`toggle`、`scroll-to`、`back`、`wait-for`。fixture 名稱由各 target 解譯成自己的資料注入方式（Web 的 `window.__PROTOFLOW_FIXTURE__`、原生的 launch argument 或 mock server）。

### 4.3 UI 合約（contract）

合約分兩部分（實作時的調整，原因見 §16.2）：

- **靜態合約**：由凍結的 HTML 與 sidecar 確定性解析，不需瀏覽器，記錄 `extractorVersion`。checkpoint／來源掃描時計算，用於 lint、變更範圍、分級與 Context；manifest 保存由它算出的 `scope`。`protoflow contract show --manifest <id>` 可檢視。
- **渲染量測**：token、版面、截圖與元素事實，在受監督的 verify 中由驅動器擷取，連同 hash 存入驗證證據。

靜態合約對每個畫面記錄錨點（含角色、父子、順序、自身文字、輸入型別）、解析後的狀態、fixture 與資源引用；以下欄位中的 `tokens`、`layout`、`render` 則屬渲染量測：

| 欄位 | 內容 |
|---|---|
| `anchors[]` | `id`、`role`、`parent`、兄弟順序、`repeat`、可見性 |
| `text` | 正規化文字（合併空白、去除不可見字元），標記 `dynamic` 者只記類型 |
| `inputs` | 型別（email／password／number…）、必填、placeholder、驗證訊息錨點 |
| `actions` | 錨點與其導向的狀態（由 sidecar `from`／`steps` 推得） |
| `tokens` | 錨點的前景色、背景色、字級、字重、圓角對應到的 design token 名稱（無對應則記原值） |
| `layout` | 正規化幾何：相對 screen 的比例位置與尺寸、兄弟間的上下左右關係、對齊、包含關係 |
| `render` | 參考截圖（每個定義的 viewport 一張）與每個錨點的 bounds |

`layout` 只記錄關係與比例，不記絕對像素；Web target 可另外啟用絕對像素比較（§7.4）。

### 4.4 Design token

原型可提供 `prototype/tokens.json`（W3C Design Tokens 格式）。合約抽取時把 computed 值反查成 token 名稱；各 target 以自己的方式實作 token（CSS 變數、Swift `Color`、Compose `MaterialTheme`），驗收比對的是 token 名稱與色差，不是 CSS 字串。沒有 tokens 檔時 T2 只比對原值並放寬容差，報告標註 `tokens: none`。

### 4.5 目標（target）

一個 target 是一個應用實作：

```json
{
  "targets": [
    {
      "id": "web",
      "platform": "web",
      "root": "apps/web",
      "driver": { "kind": "playwright-web", "baseUrl": "http://127.0.0.1:4173" },
      "build": { "argv": ["npm", "run", "build", "-w", "apps/web"] },
      "functional": { "argv": ["npx", "playwright", "test", "-c", "apps/web/playwright.config.ts"] },
      "locator": { "attribute": "data-testid" },
      "tiers": { "structure": "required", "tokens": "required", "layout": "required", "visual": "required" },
      "visual": { "mode": "pixel", "maxDiffRatio": 0.01 }
    },
    {
      "id": "android",
      "platform": "android",
      "root": "apps/android",
      "driver": { "kind": "external", "command": { "argv": ["node", "tools/maestro-driver.mjs"], "timeoutMs": 300000 } },
      "build": { "argv": ["./gradlew", "-p", "apps/android", "assembleDebug"] },
      "functional": { "argv": ["./gradlew", "-p", "apps/android", "connectedDebugAndroidTest"] },
      "locator": { "strategy": "testTag" },
      "tiers": { "structure": "required", "tokens": "required", "layout": "required", "visual": "advisory" },
      "visual": { "mode": "perceptual", "minSimilarity": 0.92 },
      "deviations": [{ "anchor": "checkout", "allow": ["system-navigation-bar"] }]
    }
  ]
}
```

- `required` 層必須 PASS；`advisory` 層記錄結果但不阻擋；`off` 不執行並記為 `NOT_RUN (off)`。
- `deviations` 是審核過的平台慣例差異白名單（例如原生導覽列取代原型 header），逐錨點宣告，進入證據與 PR 摘要。

## 5. 錨點在各平台的定位約定

應用端元素必須帶上與原型完全相同的錨點 ID。各平台使用自己原生的可測試性標記，不需要額外框架：

| 平台 | 標記方式 | 驅動器可用的查詢 |
|---|---|---|
| Web | `data-testid="checkout.pay"`（或設定的屬性名） | Playwright `getByTestId` |
| Electron | 同 Web（renderer 是 DOM） | Playwright `_electron` |
| iOS（SwiftUI） | `.accessibilityIdentifier("checkout.pay")` | XCUITest、Maestro `id:` |
| iOS（UIKit） | `view.accessibilityIdentifier = "checkout.pay"` | 同上 |
| Android（Compose） | `Modifier.testTag("checkout.pay")`，根節點啟用 `testTagsAsResourceId` | Compose test、UiAutomator、Maestro `id:` |
| Android（View） | `android:tag` 或以 `locator.transform` 轉為合法 resource id（`.` → `_`） | Espresso、UiAutomator |
| Flutter | `Semantics(identifier: "checkout.pay")`（Flutter 3.19+）或 `ValueKey` | integration_test、Maestro |
| React Native | `testID="checkout.pay"` | Detox、Maestro |

- `locator.transform` 只允許可逆的字元替換，報告保留原始錨點 ID。
- Web 正式版若不希望出現測試屬性，可在 production build 移除；驗收在測試建置上執行並於證據註明建置變體。原生的 accessibility identifier 不影響使用者，一般無需移除。

## 6. 驅動器協定

驅動器與既有 adapter 相同：明確配置的 argv、stdin JSON、stdout JSON、無 shell、受 Runner 程序組監督。內建 `playwright-web` 與 `playwright-electron`；其他平台以 `external` 接入，引擎提供參考實作但不內建裝置管理。

請求：

```json
{
  "schemaVersion": 1,
  "kind": "capture",
  "target": { "id": "android", "platform": "android", "root": "apps/android" },
  "screen": "checkout",
  "state": "card-error",
  "fixture": { "name": "cart-two-items", "data": { "items": 2 } },
  "steps": [
    { "action": "fill", "anchor": "checkout.card", "value": "4000 0000 0000 0002" },
    { "action": "tap", "anchor": "checkout.pay" }
  ],
  "anchors": ["checkout", "checkout.summary", "checkout.pay", "checkout.card.error"],
  "viewport": { "width": 412, "height": 915, "scale": 2.625 },
  "outputDir": ".protoflow/artifacts/VER-…/android/checkout.card-error"
}
```

回應：

```json
{
  "schemaVersion": 1,
  "status": "PASS",
  "screenshot": "screen.png",
  "viewport": { "width": 412, "height": 915, "scale": 2.625 },
  "elements": [
    { "anchor": "checkout.pay", "count": 1, "visible": true, "enabled": true,
      "bounds": { "x": 16, "y": 820, "width": 380, "height": 56 },
      "text": "Pay now", "role": "button",
      "style": { "foreground": "#FFFFFF", "background": "#0D766E" } }
  ],
  "missing": [],
  "log": "driver.log"
}
```

- `status` 只表示驅動器是否完成擷取；驗收判斷一律由引擎依合約與回傳資料計算。
- `style` 可選。驅動器無法提供時，T2 改由截圖在錨點 bounds 內取樣（§7.2）。
- 模擬器／裝置不可用、驅動器缺失、逾時：該 target 的視覺相關層記 `NOT_RUN` 並附原因，永遠不會變成 PASS。
- 所有路徑相對 `outputDir`，引擎計算並保存每個檔案的 SHA256，與現行 `artifactHashes` 一致。

## 7. 分層驗收

每個 target、每個受影響的「畫面 × 狀態」依序執行四層。結果寫入 verification，per-target per-tier 為 PASS／FAIL／NOT_RUN。

### 7.1 T1 結構與語意（所有平台必須通過）

- 合約中的每個錨點在應用端存在；非 `repeat` 者恰好一個，`repeat` 者數量符合 fixture。
- 可見性、啟用狀態一致；`expect.visible`／`expect.hidden` 成立。
- 文字相等（正規化後；`dynamic` 只比類型；多語系依 target locale 對照翻譯表）。
- 角色相容（`action` 必須可點擊、`input` 必須可輸入）。
- 兄弟錨點的順序一致（閱讀順序，依平台換算 RTL）。
- 狀態轉換可重現：sidecar 的每個狀態都能由驅動器到達。

### 7.2 T2 Token

- Web／Electron：比對 computed style 反查得到的 token 名稱。
- 原生：優先使用驅動器回傳的 `style`；否則在錨點 bounds 內取樣主要前景與背景色，以 CIEDE2000 ΔE 判斷是否落在 token 色的容差內（預設 ΔE ≤ 3）。
- 字級比較以平台換算（pt／sp／px 依 scale 正規化），容差預設 ±1。

### 7.3 T3 相對版面

- 比對合約 `layout` 中的關係：上下左右順序、包含、對齊（容差以 viewport 比例表示，預設 2%）。
- 尺寸比例：錨點寬高相對 screen 的比例差在容差內（預設 5%）。
- `deviations` 允許的差異（例如系統導覽列占位）先套用再比較。

### 7.4 T4 視覺

- `pixel`（Web／Electron 預設）：沿用現行像素比對與幾何容差，可對 required 錨點逐一比對。
- `perceptual`（原生預設）：原型以相同 viewport 與 scale 重新渲染，對每個錨點區域計算 SSIM，低於 `minSimilarity` 判 FAIL；整畫面另算一次，供報告使用。
- 視覺報告延用現行 HTML 報告，增加 target 分頁與逐層結果。

### 7.5 AI 視覺判斷（可選、僅供參考）

可配置以多模態模型比較原型與應用截圖，輸出差異清單。結果記為 `advisory`，進入 PR 摘要與報告，但不能讓 required 層由 FAIL 變 PASS，也不能取代 T1。原因：結果不可重現、難以綁定證據 hash。若專案日後要把它設為門檻，需另立提案並與 `autoApprove` 一樣明確標示 `automated judgement`。

### 7.6 接受條件

- 一個原型版本在某 target 上**被接受**：該 target 所有 required 層在所有受影響（及配置的回歸）場景皆為 PASS，且證據綁定 manifestHash、contractHash、應用 hash。
- `NOT_RUN` 的 required 層＝未接受。
- 版本的整體狀態由各 target 狀態彙總：`accepted`（全部 required target 接受）、`partial`、`pending`。

## 8. 變更範圍

- **合約差異**：與前一版本的合約比較，得出新增／刪除／改名（以刪除＋新增呈現）／文字變更／token 變更／版面變更的錨點，以及新增／刪除的畫面與狀態。
- **資源圖補強**：共用資源（CSS、腳本、素材）的變更由來源稽核已建立的引用圖展開到所有消費畫面，再由合約差異確認實際受影響錨點；合約無差異但資源有變（例如字型檔替換）時，以畫面層級列入範圍並要求 T4。
- **驗收場景**：受影響畫面的全部狀態，加上 target 的 `regression` 設定（`affected`（預設）、`all`、或指定畫面清單）。
- **分級**：L0–L3 分級保留，改以合約差異為主要輸入（例如只有 token 變更 → L0；新增 `input`／`action` 或狀態 → 至少 L1；sidecar 宣告資料來源 → L2）。規則仍只能提高等級。
- **未標錨點的變更**：歸到最近的祖先錨點；若只能歸到 screen，報告標示「低精度範圍」，提醒設計者補錨點，但不阻擋。

這取代了 `prototypeFiles` glob 與「未映射即拒絕」的規則；唯一的阻擋條件變成「頁面缺少 screen 錨點」或「sidecar 無效」。

## 9. 實作指引與錨點索引

Context Package 對每個 target 提供：

- 合約差異、受影響畫面與狀態、凍結原型路徑（沿用 `prototypeVersion.prototypeDir`）；
- target 的平台、根目錄、定位約定（例如「Compose 以 `Modifier.testTag` 標記」）；
- **錨點索引提示**：`.protoflow/targets/<id>/anchor-index.json` 中各錨點目前出現在哪些檔案與行號。

索引由引擎自動維護：每次 target 驗收 PASS 後，在 target 根目錄搜尋所有錨點 ID 的字面出現位置並保存，附應用 hash。它只是提示，過期時執行代理自行搜尋；任何人都不需要手動編輯它。新增錨點時，執行指示要求代理在對應元件加上平台標記並維護該平台的功能測試。

## 10. 配置 schema v2

```json
{
  "schemaVersion": 2,
  "prototypeDir": "prototype",
  "anchors": {
    "attribute": "data-pf",
    "requireScreenAnchor": true,
    "tokens": "prototype/tokens.json"
  },
  "targets": [ { "id": "web", "platform": "web", "…": "見 §4.5" } ],
  "classification": { "rules": [] },
  "policy": { "maxRepairAttempts": 3, "sequentialVersions": true, "autoApprove": false },
  "source": { "kind": "git", "repository": "https://github.com/owner/design.git", "branch": "prototypes", "path": "prototype" },
  "runner": { "pollMs": 15000, "delivery": { "branch": "protoflow/delivery", "baseBranch": "main", "merge": "none" } },
  "adapters": { "codex": { "command": null } }
}
```

- 移除：`mappings`、頂層 `verification`、頂層 `visual.scenes`（改由 sidecar 狀態與 target 定義產生場景）。
- `runner.delivery` 與 worktree 改為 per-target：每個 target 一個 worktree、一條交付分支（`<branch>/<targetId>`）。單一 target 時行為與現在相同。
- 不可變的路由所有權由「source + prototypeDir + mapping 所有權」改為「source + prototypeDir + target id 集合」。

## 11. 對現有引擎的影響

| 模組 | 變更 |
|---|---|
| `src/config.js`、`schemas/` | 新增 v2 schema；v1 經相容層載入（§12） |
| `src/source.js`、`src/versions.js` | 凍結後抽取合約，寫入 `contract.json`；稽核 screen 錨點與 sidecar |
| `src/contract.js`（新） | 合約抽取（Chromium）、合約差異、錨點語法檢查 |
| `src/sessions.js` | `classifyChanges` 以合約差異為主、檔案層級為輔 |
| `src/workflow.js` | `createContext` 改帶合約差異與 target 資訊，移除「未映射拒絕」；`verify` 依 target 與層級彙總 |
| `src/visual.js` → `src/drivers/playwright-web.js`、`src/tiers/*.js` | 擷取與比較分離；四層各自模組化 |
| `src/drivers/external.js`（新） | 外部驅動器協定、程序組監督、NOT_RUN 規則 |
| `src/queue.js`、`src/runner.js`、`src/delivery.js` | per-target 佇列、worktree 與交付；版本彙總狀態 |
| `src/mappings.js` → `src/anchors.js` | `protoflow anchors suggest`：建議錨點 ID 與 sidecar 骨架；`anchors lint`：檢查重複、語法、缺 screen |
| Skill、AGENTS block | 改寫映射章節為錨點與平台標記約定 |

## 12. 遷移

1. **相容**：`schemaVersion: 1` 的配置沿用原有 mapping 路徑，行為不變；兩種配置可在不同專案並存（§16.2）。
2. **`protoflow migrate anchors`**：讀取 v1 mapping 與原型，產生（a）`prototype.patch`：畫面錨點（`<body>`）與由 mapping 原型 selector 定位的元素錨點，交給設計端提交到原型 repo；（b）`application.patch`：在 mapping 元件或 v1 場景顯示它的應用頁面中加上 `data-testid`；（c）`protoflow.config.v2.json`（由 v1 場景推導 `urlTemplate`）；（d）`manual` 清單列出無法自動處理的 selector。全部為草稿，寫入 `.protoflow/migration/`，不修改原型或應用。
3. **舊版本的合約**：已凍結的版本若沒有 `contract.json`，可從凍結的 HTML 補抽；補抽結果記錄當下的 `extractorVersion` 並標示「回溯抽取」。佇列中已接受的版本不受影響。
4. **切換時機**：原型 repo 的錨點提交會成為新的原型版本，依 FIFO 處理；從該版本起使用 v2 驗收。v1 與 v2 的證據並存，不重寫。

## 13. 分階段計畫

| 階段 | 內容 | 完成條件 |
|---|---|---|
| P0 規格 ✅ | 審定錨點語法、sidecar、合約、驅動器協定的 JSON Schema；決定 §15 待決問題 | Schema 與範例檢入；本提案狀態改為「已接受」 |
| P1 Web 錨點化 ✅ | `contract.js`、合約差異範圍、`playwright-web` 驅動器、T1–T4、v1 相容層、`anchors suggest/lint`、`migrate anchors` | 單元與 Playwright E2E 覆蓋四層；`protoflow-test` 遷移到錨點並以真實 GitHub＋Codex 跑完至少兩個版本（含新增畫面且**不需** `runner configure`） |
| P2 多目標 ✅、Electron 驅動器（另一工作進行中） | `targets[]`、per-target 佇列／worktree／交付、`playwright-electron` | 同一原型驅動 Web 與 Electron 兩個 target，各自 PASS 並各自交付 |
| P3 Android | `external` 驅動器協定實作、Maestro 參考驅動器、T2 取樣與 T4 感知相似度 | Compose 範例應用在模擬器上 T1–T3 required PASS；故障情境（無模擬器、逾時）記 NOT_RUN 且有測試 |
| P4 iOS | XCUITest 或 Maestro 參考驅動器（macOS 限定） | SwiftUI 範例應用在模擬器上 T1–T3 required PASS |
| P5 Flutter／React Native | 定位約定與參考驅動器 | 各一個範例應用 T1 PASS |

每個階段都需維護可重複測試；真實驗收保存來源 SHA、執行紀錄、驗證與截圖，不以 fixture 冒充。

## 14. 風險與取捨

| 風險 | 影響 | 緩解 |
|---|---|---|
| 設計者需要加錨點 | 接入成本、遺漏 | `anchors suggest` 產生建議；`anchors lint` 在來源掃描時回報；未標元素歸到祖先錨點，不阻擋 |
| 錨點改名造成大量差異 | 範圍膨脹 | 合約差異如實呈現；`anchors suggest` 偵測疑似改名並在報告提示 |
| 原生驅動器慢且不穩定 | Runner 卡住、誤判 | 逾時與重試記錄於證據；不可用時 NOT_RUN；受程序組監督 |
| T2／T3／T4 門檻主觀 | 誤報或漏報 | 預設值保守並可逐 target 調整；所有原始量測值保存在證據；`deviations` 需審核 |
| 合約抽取漏掉語意（canvas、SVG 繪圖） | T1 無法覆蓋 | `data-pf-visual-only` 交由 T4；報告標註覆蓋率 |
| 多 target 進度分歧 | 平台版本不一致 | 版本彙總狀態（accepted／partial／pending）；交付分支各自獨立；`queue` 顯示各 target 的 current |
| 測試屬性進入正式版 | Web 產物膨脹或暴露內部命名 | 允許 production build 移除；驗收證據註明建置變體 |
| 引擎複雜度上升 | 維護成本 | 擷取與比較分離、層級模組化；v1 相容層在 P2 後評估移除 |

## 15. 決策

2026-10-08 審定：

1. **跨 target 接受**：各 target 獨立依序推進、各自交付。同步發佈需求放在發佈層：可選 `release.requireTargets: ["web", "ios"]`，`queue` 與報告顯示版本在各 target 的 accepted／partial 狀態（隨 P2 多目標實作）。
2. **狀態定義**：只支援 sidecar `<page>.pf.json`。沒有 sidecar 時只有 `initial`，不是錯誤。
3. **screen 錨點**：強制。缺少時該提交不成為版本，附 `anchors suggest` 產生的修改建議，由巡查通知設計端。
4. **AI 視覺判斷**：維持 advisory，只能提高關注度，不能讓 FAIL 變 PASS 或否決 PASS；累積 P3／P4 原生資料後再評估。
5. **Token 格式**：引擎只認 W3C Design Tokens；Style Dictionary v4（DTCG）可直接使用，Tailwind 等以 argv 轉換器輸出 W3C。
6. **回歸範圍**：依平台預設——Web／Electron `all`；原生 `affected+smoke`（受影響畫面全部狀態＋其他畫面 `initial`），並由巡查定期全量。

## 16. 實作紀錄

### 16.1 已完成

| 項目 | 位置 |
|---|---|
| 錨點解析、靜態合約、sidecar、lint、範圍、分級、建議與 patch | `src/anchors.js` |
| 四層比較（CIEDE2000、W3C token、相對版面、像素／SSIM） | `src/tiers.js` |
| Playwright web 驅動器、外部驅動器協定 | `src/drivers/web.js`、`src/drivers/external.js` |
| 場景、驗證編排、報告、錨點索引 | `src/targets.js` |
| 受監督的瀏覽器啟動（v1 與 v2 共用） | `src/browser.js` |
| v1 → v2 遷移草稿 | `src/migrate.js`、`protoflow migrate anchors` |
| CLI：`anchors lint|suggest`、`contract show`、`migrate anchors` | `src/anchor-commands.js` |
| 發佈的 JSON Schema（與引擎同步檢查） | `schemas/config.v2.schema.json`、`anchor-sidecar`、`static-contract`、`driver-request`、`driver-response` |
| 可執行範例 | `examples/anchors/` |

測試：`tests/anchors.test.js`、`tests/tiers.test.js`、`tests/targets.test.js`（單元）；`tests/e2e/anchors.spec.js`（真實 Chromium：四層通過、各層各自偵測漂移、新增畫面不需改配置、無效錨點不成版本、外部驅動器的原生式取樣與感知比較、裝置不可用記 NOT_RUN、v1 modular 範例遷移後以 v2 驗收通過）。CIEDE2000 以 Sharma 等人的參考數據驗證。

### 16.2 與草案的差異

- **合約分靜態與渲染兩部分**（§4.3）。渲染需要 Chromium，而 Runner 要求所有瀏覽器程序受程序組監督；把渲染放在 verify 內，checkpoint 與 Context 保持便宜且確定。manifest 保存 `scope`，不保存 `contractHash`；驗證證據保存渲染量測與 hash。
- **錨點自身文字**（§4.1），使範圍精確。
- **v1 相容**：未提供「v1 mapping 轉成合成錨點」的執行期相容層；`schemaVersion: 1` 的配置直接沿用原引擎路徑（行為完全不變），遷移由 `migrate anchors` 草稿完成。兩條路徑並存，風險較低。
- **單一 target**：P1 時 v2 schema 限 `targets` 一筆；P2 已解除（§16.6）。

### 16.3 無效提交的處理

Git 來源中錨點無效的提交不發佈為版本；`source/state.json` 的 `rejected[]` 記錄錯誤，掃描繼續。下一個有效提交的 diff 從上一個有效版本起算（該提交的變更不會遺失），並記為 `foldedInto`。這維持「不跨版本」：無效提交本來就不是一個設計版本。

### 16.4 真實驗收（2026-10-08）

`protoflow-test` 以獨立分支執行：原型來源 `protoflow-anchors-20261008`（自 `6f5cb38` 起），應用分支 `anchors-acceptance`，交付分支 `protoflow/anchors-delivery`，真實 GitHub fetch 與真實 Codex（`gpt-5.6-terra`），`policy.autoApprove` 自動批准。

| 版本 | 內容 | 等級／範圍 | Codex 修改 | 結果 |
|---|---|---|---|---|
| `85223b1` | 為登入與對話畫面加入錨點與 sidecar 狀態 | L2／`chat`、`login` | `app/chat.html`、`app/index.html` 加上 `data-testid`，更新測試 | 第一次 PASS；四層全過；PR #7 合併 |
| `76b9a0a` | 新增 help 畫面 | L1／`help` | 新增 `app/help.html`、`app/help.css`、`tests/help.spec.js` | 第一次只有 Codex 自寫的功能測試失敗（四層已過），有限修復一次後 PASS；PR #8 合併 |

- 兩個版本之間沒有執行 `runner configure`：新畫面由 Codex 依原型實作，驗收自動納入（Web 預設全量回歸，第二版驗證 6 個場景）。
- 25 個錨點全部在錨點索引中找到應用端位置。
- PR #8 合併時遇到 GitHub 503，`delivery sync` 從失敗步驟續做，未重複 commit 或留言。
- 證據：驗收專案的 `.protoflow/acceptance/anchors-real-acceptance.json`（各 attempt 的 execution／verification、manifest／prototype／application hash、截圖 hash、程序紀錄）。

### 16.5 多目標（P2）

- `targets` 可有多筆；多筆時每個 target 必須有獨立、不互相巢狀的 `root`。單一 target 與 schemaVersion 1 專案的狀態檔、worktree 與交付分支完全不變。
- **各自依序推進**：每個 target 有自己的進度 `.protoflow/targets/<id>/progress.json`、Runner 狀態 `.protoflow/runner/<id>/state.json`、worktree `worktree-<hash>-<id>` 與交付分支 `<runner.delivery.branch>/<id>`。`runner start` 依序推進每個 target，一個 target 阻塞不影響其他 target；只有全部 target 都阻塞時連續模式才停止。
- **驗收**：verification 記錄 `target`；`versionQueue` 依 target 計算 `acceptedBy`，回傳每個 target 的 `current`／`waiting`／`lastAccepted`、每個版本的 `targets` 與 `acceptance`（accepted／partial／pending）。P2 之前沒有 `target` 欄位的驗證歸屬第一個 target。
- **應用 hash**：多目標時每個 target 的應用 hash 排除原型與其他 target 的 root，所以一個平台的修改不會使其他平台的 context、驗證或 Review 過期；共用檔案仍會。
- **發佈層**：`release.requireTargets` 使 `queue` 回報 `release.version`——所有必要 target 都已依序接受的最新版本。
- **CLI**：多目標時 `context`、`prepare`、`verify`、`repair`、`runner retry`、`delivery sync` 以 `--target <id>` 指定 target，缺少時明確報錯；`queue`、`runner status`、`delivery status` 顯示全部 target。
- **交付修正**：同一分支已有已合併的舊 PR 時，`gh pr create` 之後改以 open PR 查詢新 PR，且只有合併 head 等於交付 commit 才算 MERGED（`tests/delivery.test.js` 回歸測試）。
- 測試：`tests/streams.test.js`（per-target 佇列、release、舊驗證歸屬、進度、應用 hash）；`tests/e2e/multi-target.spec.js`（本機 Git 來源、兩個 target、真實 Chromium 四層驗收、自動批准、per-target 分支交付；一個 target 執行失敗時另一個照常推進，retry 後依序補上，release 隨最慢的 target 前進）。

### 16.6 尚未完成

- Electron 驅動器（`playwright-electron`）由另一份進行中的工作負責，完成後整合為多目標架構中的一種 target。
- P3–P5：Android／iOS／Flutter／React Native 參考驅動器與範例應用。本機已有 iOS 模擬器，尚未安裝 Android SDK。
- L2／L3 的規格與 ADR 仍由 `runner.spec`／`runner.adr` 靜態提供；每版自動產生規格不在本提案範圍。

## 附錄 A：合約片段

```json
{
  "schemaVersion": 1,
  "extractorVersion": "1.0.0",
  "manifestId": "git-6f5cb386…",
  "screens": {
    "chat": {
      "states": {
        "reply": {
          "anchors": [
            { "id": "chat", "role": "screen", "parent": null, "order": 0, "visible": true },
            { "id": "chat.messages", "role": "region", "parent": "chat", "order": 1, "visible": true },
            { "id": "chat.message.user", "role": "element", "parent": "chat.messages", "repeat": true, "count": 1,
              "text": "Hello, ProtoFlow!",
              "tokens": { "background": "color.surface.user-bubble", "foreground": "color.text.secondary", "fontSize": "font.size.body-sm" },
              "layout": { "box": [0.36, 0.42, 0.13, 0.05], "below": ["chat.message.bot"], "within": "chat.messages" } }
          ]
        }
      }
    }
  }
}
```

## 附錄 B：與現行 mapping 的對照

| 現行 | 本提案 |
|---|---|
| `mappings[].prototypeFiles` | 合約差異＋資源引用圖（自動） |
| `mappings[].prototype`（CSS selector） | 原型 `data-pf` 錨點 |
| `mappings[].application`（CSS selector） | target 的平台標記（`data-testid`／`accessibilityIdentifier`／`testTag`…） |
| `mappings[].component`（檔案路徑） | 執行代理搜尋＋自動錨點索引（提示） |
| `visual.scenes[].steps`（雙邊 selector） | sidecar 狀態，步驟只引用錨點 |
| 像素與 computed style 相等 | T1–T4 分層，按平台設定 required／advisory |
| `visual.mode: "native"` → NOT_RUN | 外部驅動器協定，原生平台可自動驗收 |
