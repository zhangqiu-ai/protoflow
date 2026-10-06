# 整合接口

## 通用命令

配置 command 為 null 或 `{ "argv": ["program", "arg"], "timeoutMs": 120000 }`。cwd 是目標 project。引擎不開 shell，不插入動態 shell 字串；預設超時兩分鐘、輸出上限 4 MiB，超時／超量會終止 subprocess group。非零 exit code 是 FAIL；null 是 NOT_RUN。

## 安裝 Spec Kit 與 BMad

`protoflow install` 在安裝 ProtoFlow Skill 後依序處理 `specKit`、`bmad`：先偵測（Spec Kit：`.specify/` 或 `.agents/skills/speckit*`；BMad：`_bmad/` 或 `.agents/skills/bmad*`／`bmod*`），已存在則記錄 `present` 並略過；否則執行 `adapters.<id>.install` argv，cwd 是目標專案，預設超時 10 分鐘。配置沒有 `install` 欄位或沒有配置檔時使用引擎預設；`null` 記錄 `NOT_RUN` 並提醒手動安裝。

```json
{"adapters":{
  "specKit":{"command":null,"install":{"argv":["uvx","--from","specify-cli","specify","init","--here","--force","--non-interactive","--integration","codex","--script","sh"],"timeoutMs":600000}},
  "bmad":{"command":null,"install":{"argv":["npx","--yes","skills","add","bmad-code-org/BMAD-METHOD","--skill","*","--agent","codex","--yes"],"timeoutMs":600000}}
}}
```

預設命令依兩個專案的官方文件：Spec Kit 對既有專案使用 `specify init --here --force --integration <key>`，Codex 整合把 skills 放在 `.agents/skills`；BMad 以 skills CLI 安裝，之後在 Codex 執行 `bmad setup`。上游 CLI 變更時改寫配置即可，不需修改引擎。安裝器退出碼零但沒有留下偵測依據時判為 FAIL。每筆結果保存 argv、exit code、stdout／stderr 尾段與 `changed`（安裝前後專案 fingerprint 的差異檔案），`notices` 另輸出到 stderr 提醒開發者。安裝器是被信任的外部程式，引擎不隔離它們的檔案寫入；執行前應有可檢查的 Git 基準。

## Adapter 協定

外部 planning/execution adapter 接收 stdin JSON，不應假設 engine source 存在目標專案內。不要在配置存 token；工具使用既有的本機授權機制。Spec Kit／BMad 的 agent skills 不是終端命令，必須由了解該框架的 adapter 或當前 agent 執行。

## Spec Kit

`prepare --adapter specKit --manifest ID` 傳入 `{schemaVersion:1,kind:"specKit",manifest,manifestHash,mappings,expected}`。adapter 產生 specification、acceptance criteria、plan、tasks。stdout 是：

```json
{"status":"ready","artifacts":["specs/feature/spec.md","specs/feature/plan.md","specs/feature/tasks.md"]}
```

每個 artifact 必須實際存在、非空、在專案內。引擎保存 hash；退出碼零但 artifact 缺失仍 FAIL。`context --spec specs/feature/spec.md` 代表選擇已核對的規格 evidence；初版不宣稱能自動判斷規格的語義完整性。

官方：[Spec Kit](https://github.com/github/spec-kit)。現行流程與安裝方式依該專案文件確認，不在 ProtoFlow 內硬編碼其 agent skill 語法。

## BMad / ADR

僅有需要架構判斷的 L3 強制此邊界，其他等級可自行接入。BMad adapter 相同 stdout 協定；內容是方案／tradeoffs／ADR，而非 application code。L3 透過 `context --adr decisions/ADR-001.json` 接入明確的人工 decision：

```json
{
  "status":"approved",
  "reviewer":"REAL_HUMAN_ID",
  "manifestHash":"SHA256_OF_EXACT_MANIFEST",
  "decision":"Chosen architecture and rationale",
  "alternatives":["Alternative A","Alternative B"],
  "reversible":true
}
```

使用 `prepare` 回傳的 `request.manifestHash`，或讀取 context/request 中的 hash。只有真實人類批准後填入 approved；缺少批准、內容或 hash 不匹配，context 不能建立。修改決策內容必須重建 context，再驗證／Review。官方：[BMad](https://github.com/bmad-code-org/BMAD-METHOD)。

## Codex

`execute --context ID` 只產生 request。`--execute` 執行配置命令，stdin 是完整 context 加 `kind:"implement"`／`"repair"`。包含 manifest、prototype diff/hash、mappings、project hashes/Git、spec／ADR、驗證配置，以及 repair 的上一份 verification。完整原型快照保留在 session，adapter 可讀取目標專案目前的原型檔案。adapter 負責修改 mapped application code 和重複測試，不批准 Review／Baseline、不修改 prototype。

內建橋接配置：

```json
{"adapters":{"codex":{"command":{"argv":["node","/absolute/shared/protoflow/scripts/codex-adapter.js"],"timeoutMs":120000}}}}
```

這是合併到既有配置的片段，不是完整 config。橋接執行 `codex exec --json --sandbox workspace-write -`，從 stdin 傳入 prompt。程序結果、stdout JSONL 與 stderr 保存至 execution evidence；exit zero 不代替產品驗證。官方：[Codex 非互動模式](https://developers.openai.com/codex/noninteractive)。

## 視覺／功能驗證

`verification.build`、`functional` 是 argv 命令。functional 必須接目標專案持久保存的 Playwright regression assets；目標應用的登入 fixture、routes、server 啟動和 API mock 由專案測試負責。引擎測試使用真實 Playwright runner，沒有以手動 browser clicks 取代 E2E。

`visual.scenes` 指定 URL／viewport／fixture／steps／masks／mappings。相對路徑解析為 project-contained file URL，http(s) URL 需先啟動 target server。fixture 透過 `window.__PROTOFLOW_FIXTURE__`、`fixture.localStorage`、`fixture.cookies` 注入；產品需配合消費 fixture。動態時間／隨機資料要自行固定或 mask，外框仍參與 geometry/style 檢查。

目前 `steps.action` 支援 click／fill；更複雜導航與 API 狀態由目標測試或場景 URL 建立。native 模式明確 NOT_RUN。不是所有 test command 名稱都能證明執行了 Playwright；接入者需用自己的回歸 runner，並核對命令 log 與 test artifacts。
