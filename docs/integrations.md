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

這是合併到既有配置的片段，不是完整 config。橋接執行 `codex exec --json --sandbox workspace-write -`，從 stdin 傳入 prompt。可於 adapter argv 指定 `--model MODEL` 與 `--ephemeral`；仍固定 workspace-write，不接受繞過 sandbox 的參數。程序結果、stdout JSONL 與 stderr 保存至 execution evidence；exit zero 不代替產品驗證。官方：[Codex 非互動模式](https://developers.openai.com/codex/noninteractive)。

### Claude 執行者與 Codex 備援（提案 0003）

`policy.executor` 選擇執行者；未配置時維持 Codex（與既有專案相容）。提案 0003 的預設為 Claude Sonnet，額度不足時由 Codex 接手：

```json
{
  "policy": { "executor": { "primary": "claude", "fallback": "codex" } },
  "adapters": {
    "claude": { "command": { "argv": ["node", "/absolute/shared/protoflow/scripts/claude-exec-adapter.js", "--model", "claude-sonnet-5-5", "--max-budget-usd", "10"], "timeoutMs": 1800000 } },
    "codex": { "command": { "argv": ["node", "/absolute/shared/protoflow/scripts/codex-adapter.js"], "timeoutMs": 1800000 } }
  }
}
```

- `scripts/claude-exec-adapter.js` 以 `claude -p --restricted` 執行：檔案工具限制在 worktree（`--add-dir` 可加絕對路徑），只開 Read、Grep、Glob、Edit、Write、Bash；Bash 在 OS 沙箱內執行且不允許退回非沙箱；編輯自動接受，其他需要確認的操作一律拒絕；不載入使用者設定、MCP 或保存的 session。stdout 是完整的 stream-json trace，作為執行證據。
- 執行指示與 Codex 相同（`src/executor-prompt.js`）。
- **備援**：主要執行者回報額度或限流（usage limit、rate limit、quota、overloaded、429／529、model at capacity）時，同一個 attempt 改由 `fallback` 重做一次，attempt 記錄 `executor` 與 `executorFallback`，並發出 `executor-fallback` 事件。其他失敗照一般規則處理（暫時性重試、失敗 attempt、修復上限）。
- **交付證據**：EXEC 紀錄帶 `executor`。Claude 執行者的 trace 以執行者規則驗證（單一 session、工具不超出上述集合、`acceptEdits` 或 `dontAsk`、成功結束），binding 的 `executors` 記錄 `executor: "claude"` 與 session；Codex 紀錄維持原格式。
- **登入**：Claude CLI 從啟動 ProtoFlow 的環境取得憑證（`claude setup-token` 產生的 `CLAUDE_CODE_OAUTH_TOKEN`，或 `ANTHROPIC_API_KEY`）。ProtoFlow 不讀取或保存憑證；未登入時 Claude 回報失敗，有備援時改由 Codex 執行。

### 專案工具鏈的沙箱權限（`--add-dir`、`--network`）

workspace-write 只允許寫入專案 worktree，且禁止網路。有些工具鏈即使只跑本機測試也需要更多權限，執行者因此無法驗證自己的修改，只能盲改：

| 工具鏈 | 需要 | adapter argv |
|---|---|---|
| Flutter（`flutter test`） | 寫入 SDK 的 `bin/cache` 與 `~/.dart-tool`；測試程序綁定 127.0.0.1 | `--add-dir <Flutter SDK> --add-dir <家目錄>/.dart-tool --network` |
| Gradle（Android、React Native／Flutter 的 `android/`） | 寫入 `~/.gradle`（wrapper、依賴快取）；否則執行代理會改用暫存的 `GRADLE_USER_HOME` 與 `user.home`，較慢，且 debug 簽章金鑰不同 | `--add-dir <家目錄>/.gradle`（建議） |

`--add-dir DIR`（可重複，必須是絕對路徑）轉為 `codex exec --add-dir DIR`；`--network` 轉為 `-c sandbox_workspace_write.network_access=true`。Codex 的 macOS 沙箱無法只開放 loopback，`--network` 會同時開放對外網路，也讓執行者能連上本機的 adb server：實測中執行者曾自行建置 APK、解除安裝並重裝模擬器上的受測應用（簽章用它暫時 `user.home` 下的 debug keystore），Android 驅動器因此會替換以其他金鑰簽章的已安裝版本。只在工具鏈確實需要時啟用。兩者都是明確配置的 argv，預設不開；變更後走 `runner configure`。在 `codex sandbox -c sandbox_mode='"workspace-write"' … -- <測試命令>` 中可先確認最小權限。

### 執行者隔離（`ignoreUserConfig`）

預設情況下執行者會載入開發者的 `$CODEX_HOME/config.toml`（通常是 `~/.codex/config.toml`）。若其中啟用 memories，執行 session 可能讀取個人記憶並把內容寫入 EXEC JSONL；交付時獨立 reviewer 會讀這份 trace，等於把與本專案無關的個人資料交給另一個 session 並留在專案證據中。啟用隔離：

```json
{"adapters":{"codex":{"command":{"argv":["node","/absolute/shared/protoflow/scripts/codex-adapter.js"],"timeoutMs":600000},"ignoreUserConfig":true}}}
```

引擎在 stdin JSON 加上 `executor: {"ignoreUserConfig": true}`；內建橋接收到後改為執行 `codex exec --json --sandbox workspace-write --ignore-user-config -c features.memories=false -c approval_policy="never" -`，`executor` 不放入給模型的 Context Package。手動配置 argv 時也可直接在 adapter argv 加 `--ignore-user-config`。自訂 executor adapter 須自行實作此欄位，引擎無法替它保證隔離。獨立 review adapter 一律以 `--ignore-user-config` 執行，不需要也不接受此欄位。

取捨：`--ignore-user-config` 只略過 `config.toml`，登入仍使用 `CODEX_HOME` 的 `auth.json`；但 config 裡的 `model`、推理強度、自訂 `model_providers`／profile、MCP servers、`sandbox_workspace_write`（例如網路存取）與 approval 設定都不再生效。依賴這些設定的專案需改以 adapter argv 的 `--model` 指定模型，或讓 `runner.setup` 先完成需要網路的安裝；只能經自訂 provider 登入的環境無法使用隔離。`$CODEX_HOME/AGENTS.md` 等全域指示與 skills 不屬於 `config.toml`，不在此開關的保證範圍內。欄位預設為 `false`，既有配置行為不變；在已有 Runner worktree 的專案變更需走 `runner configure`。

## 視覺／功能驗證

`verification.build`、`functional` 是 argv 命令。functional 必須接目標專案持久保存的 Playwright regression assets；目標應用的登入 fixture、routes、server 啟動和 API mock 由專案測試負責。引擎測試使用真實 Playwright runner，沒有以手動 browser clicks 取代 E2E。

`visual.scenes` 指定 URL／viewport／fixture／steps／masks／mappings。相對路徑解析為 project-contained file URL，http(s) URL 需先啟動 target server。fixture 透過 `window.__PROTOFLOW_FIXTURE__`、`fixture.localStorage`、`fixture.cookies` 注入；產品需配合消費 fixture。動態時間／隨機資料要自行固定或 mask，外框仍參與 geometry/style 檢查。

目前 `steps.action` 支援 click／fill；更複雜導航與 API 狀態由目標測試或場景 URL 建立。native 模式明確 NOT_RUN。不是所有 test command 名稱都能證明執行了 Playwright；接入者需用自己的回歸 runner，並核對命令 log 與 test artifacts。
