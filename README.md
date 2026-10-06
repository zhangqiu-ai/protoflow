# ProtoFlow

ProtoFlow 是可透過 Codex Skill 接入的原型驅動工程引擎。共享 Node.js 引擎持有流程、協定與驗證；目標專案安裝輕量 Skill、配置及 AGENTS 約定，保留自己的原型、實作和回歸測試。

**v0.1 可執行：**原型目錄監聽、Design Session／checkpoint、Git diff／Change Manifest、L0–L3 路由、Spec Kit／BMad 邊界、Codex 執行接口、瀏覽器視覺驗證、有限修復迴圈、人工 Review 與 UI Baseline。初版採本機 JSON 證據，沒有雲端服務或畫布 UI。

```mermaid
flowchart LR
  P[Prototype] --> S[Session / Checkpoint]
  S --> M[Manifest / L0–L3]
  M --> C[Codex Context]
  M --> K[Spec Kit / ADR]
  K --> C
  C --> A[Application]
  A --> V[Build / Playwright / Visual]
  V -->|失敗且有 adapter| C
  V --> R[Human Review]
  R --> B[UI Baseline]
```

## 安裝共享引擎

需要 Node.js 22+、npm、Git，以及 Playwright Chromium。初版尚未發布到 npm；使用 checkout 或本機打包檔安裝。

```sh
git clone https://github.com/zhangqiu-ai/protoflow.git
cd protoflow
npm ci
npx playwright install chromium
npm run validate
# 選用：將這份共享引擎的 CLI 加到 PATH
npm link
```

也可直接使用 `node /absolute/path/protoflow/bin/protoflow.js`，不需全域安裝。所有以下命令的 `protoflow` 都可替換為此形式。

```sh
protoflow init --project /path/to/app
protoflow install --project /path/to/app
```

目標專案新增 `protoflow.config.json`、`.agents/skills/protoflow/` 和 AGENTS managed block，**不複製引擎**。既有配置、既有 Skill 及使用者 AGENTS 內容保留；重複執行會列出 skipped。

`install` 接著把 [Spec Kit](https://github.com/github/spec-kit) 與 [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) 安裝到目標專案，供 L2 規格與 L3 架構決策使用。命令取自配置的 `adapters.specKit.install`／`adapters.bmad.install`（`init` 寫入預設值，可改寫；`null` 表示不安裝）：

| 整合 | 預設 argv | 偵測依據 |
|---|---|---|
| Spec Kit | `uvx --from specify-cli specify init --here --force --non-interactive --integration codex --script sh` | `.specify/`、`.agents/skills/speckit*` |
| BMad | `npx --yes skills add bmad-code-org/BMAD-METHOD --skill * --agent codex --yes` | `_bmad/`、`.agents/skills/bmad*`／`bmod*` |

已偵測到的整合會略過，不重複安裝。需要 `uv`（Spec Kit）與 Node.js／Git（BMad）並可連網。執行前先 commit 或 stash，安裝後檢查 diff：`specify init --force` 可能覆寫其自身管理的路徑，結果的 `changed` 列出每個安裝器新增或修改的檔案。安裝結果與提醒寫入 JSON 的 `integrations`／`notices`，同時以 `ProtoFlow:` 前綴輸出到 stderr；任一安裝失敗時退出碼為 `1`。BMad 安裝後在 Codex 請 `bmad` skill 執行 `bmad setup`。`--skip-integrations` 只偵測並提醒，`protoflow status` 也會顯示兩者的安裝狀態。

個人 Skill 安裝（只偵測整合，不安裝）：

```sh
protoflow install --personal --project /path/to/app
```

依此使用者環境的安裝政策，來源為 `/Users/feature/GitHub/skills/protoflow`，Codex discovery 是 `/Users/feature/.codex/skills/protoflow` 的個別 symlink。其他機器可使用 `--source-dir` 和 `--discovery-dir`。細節見 [Skill 安裝](docs/skill-installation.md)。

## 接入配置

`init` 產生保守預設：沒有臆測的元件映射、沒有外部 adapter、沒有驗證命令。填入真實配置後開始流程。參考 [完整模板](templates/protoflow.config.json)、[可執行 Demo](examples/demo/protoflow.config.json) 與 [配置協定](schemas/config.schema.json)。

```json
{
  "schemaVersion": 1,
  "prototypeDir": "prototype",
  "mappings": [{
    "id": "chat-input",
    "prototypeFiles": ["prototype/chat.html", "prototype/chat.css"],
    "prototype": "#chat-input",
    "application": "[data-ui='chat-input']",
    "component": "src/ChatInput.tsx",
    "priority": "critical"
  }],
  "classification": {"rules": [{"pattern": "prototype/auth/**", "level": "L3"}]},
  "policy": {"maxRepairAttempts": 3, "requireHumanReview": true},
  "verification": {
    "build": {"argv": ["npm", "run", "build"]},
    "functional": {"argv": ["npx", "playwright", "test"]}
  },
  "visual": {
    "maxDiffRatio": 0.01,
    "geometryTolerance": 1,
    "scenes": [{
      "id": "chat.default",
      "prototypeUrl": "http://127.0.0.1:3001/chat.html",
      "applicationUrl": "http://127.0.0.1:3000/chat",
      "viewport": {"width": 1440, "height": 900},
      "mappings": ["chat-input"]
    }]
  }
}
```

`prototypeFiles` 是專案相對路徑 glob，支援 `*`、`**`、`?`。`prototype`／`application` 是各自頁面的 CSS selector；`component` 是實作檔案路徑。每個映射 selector 必須唯一且可見。配置以 schema 驗證，拒絕未知欄位、無效門檻和專案外檔案路徑。

將 `.protoflow/` 加入目標專案的 `.gitignore`，或明確選擇 evidence 版本化方式；`init` 會保留既有忽略策略。

### 原型適度拆分

先依可獨立瀏覽、修改和驗收的頁面拆分，再整理共用 tokens、styles、scripts 與 assets。原型目錄不必對應應用元件目錄；同一 HTML 可透過多筆 mapping 對應導覽、頁面內容等不同元件。共用資源必須明確列入每個受影響 mapping 的 `prototypeFiles`，引擎依檔案變更保守展開影響範圍，selector 只用於定位與視覺驗證。

引擎與模板不預設任何頁面或元件。`protoflow mappings suggest` 掃描目標專案自己的原型頁面及其引用的樣式、腳本與素材，輸出每頁一筆 mapping 草稿；`component` 與 selector 留空，由開發者依專案實際元件填寫後再寫入配置。參考 [原型拆分指南](docs/prototype-structure.md) 與 [多頁可執行範例](examples/modular/)（範例的頁面與元件只屬於該範例）。checkpoint 路由不解析 DOM 差異或 import 依賴圖，也不自動 commit 原型。

## 核心命令

| 命令 | 作用 |
|---|---|
| `init` / `install [--skip-integrations]` | 建立配置與約定／安裝 Skill、Spec Kit 與 BMad |
| `mappings suggest` | 依原型頁面與引用資源產生 mapping 草稿（唯讀） |
| `session start` / `session list` | 設計會話及修改前快照 |
| `watch [--once]` | 檔案輪詢、idle debounce、checkpoint |
| `checkpoint [--session ID]` | 精確 before/after Manifest |
| `prepare --adapter specKit\|bmad --manifest ID` | 執行明確配置的規格／架構 adapter |
| `context --manifest ID [--spec PATH] [--adr PATH]` | 建立有映射與政策閘門的 Context Package |
| `execute --context ID [--execute]` | 乾跑 request 或實際 Codex adapter |
| `verify --manifest ID` | build、functional、視覺與證據 hash |
| `repair --manifest ID [--execute]` | 驗證→修復→再驗證，最多配置次數 |
| `review create --manifest ID --verification ID` | 建立待人工判斷資料 |
| `review approve\|reject\|request-changes --review ID --reviewer NAME` | 記錄人工決定 |
| `baseline create --review ID` / `baseline show` | 保存批准節點／讀取最新節點 |
| `queue` | 原型版本佇列；應用端只處理 `current` |
| `status` | 會話、最新 Baseline、版本佇列及 Spec Kit／BMad 安裝狀態 |

各命令接受 `--project PATH`。輸出 JSON；`watch` 先輸出 `ready`，每個穩定修改批次輸出 `checkpoint`。退出碼：`0` 成功，`1` 錯誤／驗證失敗，`2` 未執行／仍需 Review，`3` 應用端跨原型版本操作被拒絕。不自動 Git add、commit、push 或部署。

### 原型版本佇列

原型可以隨時修改並連續 checkpoint；每個 checkpoint 是一個原型版本，依建立順序排隊。正式應用依原型版本自動推進，因此應用端必須**按順序逐一**處理：`context`、`prepare`、`execute`、`verify`、`repair` 只接受佇列的 `current`，也就是最早一個還沒有驗收的版本。版本驗收的條件是一份 `PASS` 的 verification，綁定該 manifest hash 與原型內容 hash。對後面的版本操作會被拒絕，輸出 `{"status":"BLOCKED","queue":{…}}` 並以退出碼 `3` 結束；已驗收的版本也不能再被重新實作。

```sh
protoflow queue --project /path/to/app   # current、waiting、lastAccepted 與每個版本的驗收狀態
```

- 每個 checkpoint 會把該版本的原型完整凍結到 `.protoflow/versions/<manifest-id>/`（含二進位素材），並以 manifest 的 `afterHash` 核對完整性。Context 的 `prototypeVersion.prototypeDir` 指向凍結副本，執行代理讀取該版本而不是現行原型。
- `verify` 也比對凍結版本：專案相對路徑的 scene 直接改指向副本；http scene 在 URL 路徑以 `/<prototypeDir>/` 開頭時自動攔截並由副本回應，其他 server 配置需設定 `visual.prototypeBaseUrl`（對應 `prototypeDir/` 的 URL）。
- 應用的 project hash 不含原型目錄，設計者持續修改原型不會讓應用端的 context／verification／review 失效。
- 設計命令（`session`、`checkpoint`、`watch`）使用 `.protoflow/design.lock`，應用命令使用 `.protoflow/active.lock`，兩邊可以同時進行。
- 放行只需 verify `PASS`；人工 Review／Baseline 照舊可對已驗收版本補做。不需要依序推進的專案可設定 `policy.sequentialVersions: false`；代理不得自行關閉。

### 修改與批准

```sh
protoflow session start --project /path/to/app --label "Adjust chat input"
# 編輯 prototype；使用回傳的 session ID
protoflow checkpoint --project /path/to/app --session SESSION_ID
protoflow context --project /path/to/app --manifest MANIFEST_ID
protoflow execute --project /path/to/app --context CONTEXT_ID
# 確認 request 與授權後，加入 --execute 執行已配置的 adapter
protoflow verify --project /path/to/app --manifest MANIFEST_ID
protoflow review create --project /path/to/app --manifest MANIFEST_ID --verification VERIFICATION_ID
# 真實人類看過視覺報告並明確批准後：
protoflow review approve --project /path/to/app --review REVIEW_ID --reviewer HUMAN_NAME
protoflow baseline create --project /path/to/app --review REVIEW_ID
```

`watch` 持有設計端鎖（`.protoflow/design.lock`）；應用端命令可同時執行，其他設計命令（session、checkpoint）需先以 Ctrl+C 停止 watch。中斷的 active session 可在下次 watch 恢復。鎖會在正常退出釋放；若程序意外退出，先核對 `.protoflow/active.lock/owner.json` 或 `.protoflow/design.lock/owner.json` 的 owner 是否仍活躍，再人工恢復，不能因鎖看起來舊就刪除。

初次 checkpoint 包含現有未追蹤原型。新增或未知 JavaScript 通常屬 L2，需 `--spec`；`--level` 與規則只能提高等級。L3 額外需要綁定 `manifestHash`、`status: approved` 和真實 reviewer 的 ADR JSON。詳細範例見 [協定與狀態](docs/protocols.md)。

## Demo

Demo 的 prototype 與 app 是獨立 HTML，包含建立 Design Session 的互動。Demo 命令應從 repository 根目錄執行：

```sh
node bin/protoflow.js init --project examples/demo
node bin/protoflow.js install --skip-integrations --project examples/demo
node bin/protoflow.js checkpoint --project examples/demo
# 使用 checkpoint 回傳的 ID；提供已備妥的 Demo specification
node bin/protoflow.js context --project examples/demo --manifest MANIFEST_ID --spec specs/demo.md
npm run demo
```

在第二個 terminal：

```sh
node bin/protoflow.js verify --project examples/demo --manifest MANIFEST_ID
```

驗證會生成 `.protoflow/artifacts/VER_ID/visual-review.html`、prototype/app 截圖、side-by-side、overlay、diff，以及逐元件幾何／樣式／像素結果。Demo 的 functional 命令使用此 checkout 的 Playwright runner；搬到其他專案時改成該專案自己的命令。Demo 試跑只建立 pending Review，不代替真實產品批准。

## 外部工具與驗證界線

Spec Kit／BMad 由 `install` 安裝到目標專案，但仍是獨立工具：它們的 skills 由 Codex 或開發者在對話中使用，ProtoFlow 產生 request，接受 adapter 回傳的實際 artifact，**不把 agent skill 當 terminal 命令**。安裝與 adapter 接口已用本機測試替身驗證；真實安裝依賴網路與兩個上游專案的 CLI。官方來源：[Spec Kit](https://github.com/github/spec-kit)、[BMad](https://github.com/bmad-code-org/BMAD-METHOD)。

Codex 橋接在 `scripts/codex-adapter.js`：配置 `argv: ["node", "/absolute/shared-engine/scripts/codex-adapter.js"]`。它將 Context Package 經 stdin 交給 `codex exec --json --sandbox workspace-write -`；需要已安裝且可使用的 Codex。命令參數已對照本機 CLI help 和 [官方非互動模式](https://developers.openai.com/codex/noninteractive)。Adapter 退出成功只表示程序完成，最終是否可批准仍由 `verify` 決定。

視覺驗證固定 viewport、DPR、locale、theme、timezone、fixture、互動步驟與遮罩；比較 geometry、computed styles、全視窗與每個元件區域。任何映射失敗、未映射變更、缺失覆蓋都不能靠整頁平均值通過。原生 UI、動畫時序、真正裝置和後端 provider 驗收需另接專案測試；native 模式記錄 `NOT_RUN`。詳見 [架構](docs/architecture.md) 與 [整合協定](docs/integrations.md)。

## 驗證與擴充

```sh
npm run check       # JavaScript syntax + 配置 schema
npm test            # 安裝、分類、watch、協定、政策及過期證據
npm run test:e2e    # Node.js Playwright runner：互動、視覺、CLI完整流程、修復迴圈
npm run validate   # 全部
npm pack           # 可移交的本機 npm package；不會 publish
```

測試隔離在暫存專案；人工批准測試使用明確的 synthetic reviewer，沒有批准真實專案。CI 保存相同 runner 流程。Node API 從 `src/index.js` 匯出；CLI 是薄入口，adapter 使用版本化 JSON。下一步是在真實目標專案填入映射、固定測試資料、配置 build／Playwright 與 Codex adapter，再由人類驗收第一個 Baseline。
