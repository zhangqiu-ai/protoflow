# 原型適度拆分與元件映射

先按可獨立瀏覽、修改及驗收的頁面拆分原型，再整理真正共用的資源。按鈕、標籤等細節不需要各自形成原型檔案，除非已有獨立場景或多人協作需要。

原型服務設計理解，應用服務產品實作。ProtoFlow 不規定原型目錄或應用元件的結構：頁面、資源與元件名稱都屬於目標專案，引擎與模板不預設任何元件。原型頁面的區域透過 mapping 對應應用元件；目錄與檔案數量不必相同，也不要為了匹配原型而重組現有應用。

## 原型目錄

`prototypeDir` 可配置；其下的子目錄依專案習慣命名。常見做法是把頁面與共用資源分開，例如：

```text
<prototypeDir>/
├── <頁面目錄>/        # 每個可獨立瀏覽與驗收的頁面一個 HTML
├── <共用樣式目錄>/    # tokens、版面等跨頁樣式
├── <腳本目錄>/        # 原型互動
└── <素材目錄>/        # 實際存在的圖片、字型、圖示
```

這只是示意，不是必要結構。單頁原型、按功能分組或沿用設計工具的匯出結構都可以；不要為了目錄完整而建立空目錄或過度抽象。`init` 只建立配置、AGENTS 約定與 prototype 目錄，不產生頁面、元件或測試。

## 從原型產生 mapping 草稿

先讓引擎讀取專案自己的原型，再由開發者或代理依應用實際元件補完：

```sh
protoflow mappings suggest --project <root>
```

輸出是唯讀 JSON，不會寫入配置：

| 欄位 | 內容 |
|---|---|
| `pages` | `prototypeDir` 內的每個 HTML 頁面，及其透過 `<link>`、`<script>`、`src`／`srcset`、`<style>`、CSS `@import`／`url()`、JavaScript `import` 遞移引用的原型檔案 |
| `pages[].unresolved` | 引用了但不在原型目錄內的路徑，通常是錯誤引用或外部資源 |
| `sharedResources` | 被兩個以上頁面引用的資源；修改時影響全部消費頁面 |
| `orphanFiles` | 沒有頁面引用的檔案；需判斷是否屬於某個 mapping |
| `unmappedFiles` | 現有配置的 `prototypeFiles` 尚未涵蓋的檔案 |
| `mappings` | 每頁一筆草稿；`prototypeFiles` 已填入頁面與其資源，`component`、`prototype`、`application` 為 `null` |

草稿的 `null` 欄位必須以目標專案實際存在的元件路徑和 selector 填寫，引擎不會猜測。草稿只是起點：一個頁面通常要拆成多筆 mapping（例如頁面中不同區域對應不同元件），連結到其他頁面的 `<a href>` 不算依賴，而沒有直接引用、卻會間接影響布局的共用資源（例如改變高度的頁首樣式）也需人工列入。引擎在 checkpoint 時不會使用這份引用分析，路由仍只看配置的 `prototypeFiles`。

## 一個原型檔對多個應用元件

同一頁面 HTML 可列入多筆 mapping，分別指向不同應用元件；同一個應用元件也可以在不同頁面各有 mapping，保留各頁的驗證場景。`prototype` 與 `application` 欄位是兩邊頁面的 CSS selector，`component` 是應用中實作該區域的檔案路徑：

```json
{
  "id": "<page>-<region>",
  "prototypeFiles": ["<prototypeDir>/<page>.html", "<prototypeDir>/<shared>.css"],
  "prototype": "<原型頁面中的區域 selector>",
  "application": "<應用頁面中的對應 selector>",
  "component": "<應用中實作此區域的檔案>"
}
```

欄位格式見 [配置模板](../templates/protoflow.config.json)；模板的值皆為佔位符。[多頁範例](../examples/modular/) 是一個可執行的示範專案，其頁面與元件名稱只屬於該範例，不要複製到其他專案。

## 共用資源的影響範圍

`prototypeFiles` 是變更來源清單，包含頁面本身與該 mapping 消費的共用資源。checkpoint 路由不解析 HTML 的 stylesheet/script 引用、JavaScript import、CSS 變數使用或 asset URL；這些關係由配置維護，`mappings suggest` 只協助起草。

修改共用 tokens 時，所有引用它的頁面區域都可能改變；修改某個區塊的樣式，若改變其高度或間距，同頁其他區域的位置也可能改變。即使其他區域沒有直接引用該樣式，這種布局的間接影響仍需列入其 `prototypeFiles`。

圖片、字型與圖示同樣適用：素材應明確列入使用它的 mapping；若它會改變整頁布局，也列入受影響的其他 mapping。可以使用精確檔案清單或 `*`／`**`／`?` glob；範圍較大的 glob 便於維護，但會保守觸發更多 mapping。不要用所有原型檔都共用一個 glob，卻宣稱已做到精準路由。

檔案命中多筆 mapping 時全部列入 Change Manifest；priority 不排除影響。同一共用檔案即使只修改一個 CSS 變數，引擎也不會判斷哪些區域實際使用它。selector 可將各元件的幾何、樣式與像素結果分開呈現，但不會把 HTML diff 縮成特定 DOM 節點。此保守展開可能增加驗證工作；漏列消費者則可能漏掉影響，因此要核對清單，不能只接受第一個命中的元件。

## 場景與功能驗證

每個頁面都要能獨立載入，並由場景覆蓋該頁的全部 mapping。共用資源修改時，所有消費頁面都需驗證，避免只在其中一頁通過就認定其他頁也正確。原型與應用使用各自的 HTML／CSS／JavaScript；驗證比較獨立結果，應用元件不讀取原型頁面作為產品實作。

場景 URL 需要的 server 由專案啟動；fixture、viewport、theme、locale、互動步驟與遮罩要明確配置。視覺驗證不能取代表單送出、頁面切換等互動的功能測試；將 Node.js Playwright runner 接到 `verification.functional`，保留測試在專案內。

共享 CSS 修改通常推斷為 L0；局部頁面結構／互動為 L1，未知 script 或資料邏輯可能為 L2。拆分檔案不會降低分類等級，L2／L3 仍需相應 spec／ADR。不要為了避開政策而把程式改寫進看似低風險的檔案。

## 移動、刪除與證據

移動／刪除頁面或資源時，同步修改 HTML/script 資源引用、`prototypeFiles`、component 映射、場景 URL／selector 與回歸測試。保留舊路徑的影響資訊直到該次遷移 checkpoint 的新增／刪除都能路由；直接從所有 mapping 刪掉舊路徑，可能使刪除變更成為 unmapped。遷移已記錄後可清理條目；清理配置後重新建立 context 與驗證證據。

修改配置與原型後建立新 checkpoint／context，重新驗證與人工 Review，不沿用既有批准。空映射、資源引用錯誤、selector 不唯一或不可見、漏掉受影響場景都應修正，而不是以 screenshot 存在視為通過。

目前 checkpoint 保存內容 hash、文字快照／diff 與 Git evidence；二進位資產只有 hash metadata，不能視為可還原的完整資產備份。這個流程不提供 Git 版本選取／鎖定、DOM 精準 diff 或自動提交。Git commit／push 需使用者另外授權；`.protoflow/` 產生的資料應依目標專案自己的忽略或移交策略處理。
