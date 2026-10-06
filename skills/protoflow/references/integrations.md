# 配置與整合邊界

先設定 `prototypeDir`，再填寫 `mappings`。每筆映射有穩定 `id`、觸發變更的 `prototypeFiles`、prototype 與 application 頁面的 CSS 選擇器 `prototype`／`application`、專案內實作檔案 `component` 與 `priority`（`critical`／`high`／`normal`／`low`）。沒有映射時不會猜測實作路徑；同一變更可觸發多筆映射，priority 是評審的重要程度。

外部執行命令使用 JSON argv，不能用 shell 字串：

```json
{
  "adapters": {
    "codex": { "command": { "argv": ["node", "tools/codex-adapter.mjs"], "timeoutMs": 120000 } },
    "specKit": { "command": { "argv": ["node", "tools/spec-adapter.mjs"], "timeoutMs": 120000 } },
    "bmad": { "command": { "argv": ["node", "tools/adr-adapter.mjs"], "timeoutMs": 120000 } }
  },
  "verification": {
    "build": { "argv": ["npm", "run", "build"], "timeoutMs": 120000 },
    "functional": { "argv": ["npx", "playwright", "test"], "timeoutMs": 120000 }
  }
}
```

adapter 透過 stdin 接收結構化執行上下文 JSON，以專案根目錄為工作目錄。Spec Kit／BMad adapter 必須產生專案內真實證據檔案，並以 stdout JSON 回傳 `{"status":"ready","artifacts":["specs/change.md"]}`；引擎檢查回傳檔案存在。這是邊界協定，不能宣稱已內建或執行特定版本的 Spec Kit／BMad。亦可先人工產生證據，再由 `--spec`／`--adr` 明確提供。

`protoflow install` 會依 `adapters.specKit.install`／`adapters.bmad.install` argv 把 Spec Kit 與 BMad 安裝到專案（已偵測到則略過，`null` 不安裝），並在 `notices` 回報結果；安裝框架不等於已配置 `command` adapter。

配置完成後，`protoflow prepare --project <root> --manifest <id> --adapter specKit` 或 `--adapter bmad` 會執行相應 adapter。L3 的 ADR 必須是 JSON，包含 `status: "approved"`、真實人類 `reviewer`、當前 Change Manifest 的 `manifestHash` 與非空 `decision`；`prepare` 的 request 提供該 hash。人工決策不得由 adapter 自行偽造。

視覺驗證需配置 `visual.scenes`，使同一 viewport 的 prototype 與 application 可被 runner 擷取；依引擎 schema 設定 URL、尺寸與幾何選擇器。像素差異與幾何比較僅代表已測場景，不取代互動功能測試與人類設計評審。未配置場景不會產生假的視覺通過結果。
