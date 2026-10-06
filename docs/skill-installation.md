# 以 Codex Skill 接入其他專案

ProtoFlow 引擎只安裝一次；每個目標專案保留配置、Skill、專案約定與執行證據。

```sh
# 在 ProtoFlow checkout 安裝依賴並註冊共享 CLI
npm install
npm link

# 在其他專案接入
protoflow init --project /absolute/path/to/project
protoflow install --project /absolute/path/to/project
```

`init` 建立 `protoflow.config.json`、prototype 目錄，並在 `AGENTS.md` 追加 `protoflow:begin/end` 區塊。重複執行保留現有配置與約定；既有配置的 `prototypeDir` 會繼續使用。`install` 將 instruction package 安裝到 `.agents/skills/protoflow`，既有目的地會跳過。它不複製 `src/`、`bin/` 或依賴。之後安裝 Spec Kit 與 BMad 到同一專案並輸出提醒；命令、偵測與失敗處理見 [整合接口](integrations.md#安裝-spec-kit-與-bmad)，`--skip-integrations` 只偵測不安裝。

初始配置的 `mappings` 與 `visual.scenes` 為空；以 `protoflow mappings suggest` 從原型起草，參考 [配置模板](../templates/protoflow.config.json) 的欄位填入實際路徑，再設定 build／functional 與 adapter。這些命令預設為 `null`，初版不會在未配置時啟動外部代理或宣稱驗證通過。

## 個人安裝

```sh
protoflow install --personal --project /absolute/path/to/project
```

依使用者個人安裝約定，來源目錄為 `/Users/feature/GitHub/skills/protoflow`，另建立 `/Users/feature/.codex/skills/protoflow` 單一 Skill 的 symlink。個人安裝只偵測並提醒 Spec Kit／BMad，不安裝到專案。來源或 discovery 目的地存在時跳過，包括斷裂 symlink；不替換 `.codex/skills` 目錄、不覆寫既有 Skill。可用 CLI `--source-dir`／`--discovery-dir` 指定其他環境的等價目錄。

更新共享引擎不會偷偷更新目標專案的 Skill；更新 instruction package 應先檢查既有目的地與使用者修改，再明確處理。CLI 詳細命令以 `protoflow --help` 為準；[Skill 入口](../skills/protoflow/SKILL.md) 提供 session、驗證、修復、人工評審與 Baseline 的操作流程。
