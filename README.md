# sandcastle-pipeline

在 [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle)（沙箱、跑 agent、worktree）之上的 issue → PR → 合并流水线，
从 duckdb_crm 的 `.sandcastle/` 抽出来：prep 拆票写指引、确定性排期（blocker、同文件冲突）、implement + review（revise 打回）、
测试门槛（选测、偶发失败重跑与开票）、自动合并与 rebase 补救、PR 打回、接手外部 PR、按阶段配模型、上下文预算 hook。

## 结构

| 路径 | 内容 |
|---|---|
| `src/main.ts` | 编排（调度、build、land）。不含项目细节，不直接调 gh |
| `src/forge.ts` | **Forge** 接口：托管平台上的 issue / 标签 / PR / 合并 |
| `src/forges/github.ts` | GitHub 实现（gh CLI） |
| `src/profile.ts` | **ProjectProfile**：项目配置（测试隔离、门槛、安装、一致性检查、文案）与默认值 |
| `src/project-doc.ts` | 解析 `.sandcastle/PROJECT.md`、渲染提示词 |
| `prompts/` | 通用提示词模板（implement / review / prep / rebase）与共享片段（设计决定、编码规范、票的大小） |
| `src/shell.ts` | 宿主机命令（超时、远端重试） |
| `src/guide.ts` `src/pr-body.ts` `src/models.ts` | 票正文解析、PR 正文、模型档案 |
| `templates/.sandcastle/` | 装到新项目的 PROJECT.md 模板、配置模板、Containerfile、models.json |
| `claude/` | 上下文预算 hook、screenshot-checker 子代理、prep-ticket skill |
| `examples/duckdb_crm/` | 第一个接入方的完整配置 |
| `docs/` | 状态机、票的大小规则等（从 duckdb_crm 复制，尚未通用化） |

## 在项目里用

1. 把 `templates/.sandcastle/` 拷进项目，填 `PROJECT.md`（项目知识，给 agent 看）和 `sandcastle.config.ts`（怎么跑，给脚本用）。
2. 在项目根目录：`npx tsx <本仓库>/src/main.ts`（`SANDCASTLE_ONLY=12,13` 只做这几张票）。

不想往项目里放 `PROJECT.md` / `sandcastle.config.ts`（试用、配置放别处）时，设 `SANDCASTLE_PROJECT_DIR=<配置目录>`，例如 `SANDCASTLE_PROJECT_DIR=<本仓库>/examples/duckdb_crm`。`models.json`、`.env`、`logs/` 仍在项目的 `.sandcastle/` 里。

## 提示词怎么拼出来

`prompts/*.md` 是通用模板，不写任何项目的路径或命令。启动时：

- `{{P_…}}` 换成 `.sandcastle/PROJECT.md` 对应章节（章节表见 `src/project-doc.ts` 的 `SECTIONS`，各节进哪个阶段见 PROJECT.md 模板的注释）；
- `{{DOC_…}}` 换成共享片段（`decisions`、`coding-standards`、`ticket-sizing`），`{{L_…}}` 换成标签名，`{{FORGE}}` 换成平台的命令清单（`Forge.agentGuide()`）；
- `{{IF_BROWSER}}…{{ELSE_BROWSER}}…{{END_BROWSER}}` 按 PROJECT.md 有没有「浏览器验收」取一边；
- 其余 `{{TASK_ID}}`、`{{BRANCH}}` 等留给 sandcastle 在每次运行时替换。

项目要整份换掉某个模板时，放一份 `.sandcastle/prompts/<name>.md`。

## 开发

```bash
npm install
npm run typecheck
npm test
```

## 现状

- 第 1、2 步已完成：抽出 Forge 与 ProjectProfile，duckdb_crm 的项目差异全在 `examples/duckdb_crm/sandcastle.config.ts`。
- 第 4 步已完成：提示词通用化，项目知识收进 `PROJECT.md`（duckdb_crm 的见 `examples/duckdb_crm/PROJECT.md`）。
- `docs/` 与 `claude/skills/prep-ticket` 仍是 duckdb_crm 的写法，打包成插件时再改。
- 还没有 GitLab Forge、`onboard`、`doctor`。
