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
| `src/shell.ts` | 宿主机命令（超时、远端重试） |
| `src/guide.ts` `src/pr-body.ts` `src/models.ts` | 票正文解析、PR 正文、模型档案 |
| `templates/.sandcastle/` | 装到新项目的提示词、Containerfile、models.json、配置模板 |
| `claude/` | 上下文预算 hook、screenshot-checker 子代理、prep-ticket skill |
| `examples/duckdb_crm/` | 第一个接入方的完整配置 |
| `docs/` | 状态机、票的大小规则等（从 duckdb_crm 复制，尚未通用化） |

## 在项目里用

1. 把 `templates/.sandcastle/` 拷进项目，改 `sandcastle.config.ts`。
2. 在项目根目录：`npx tsx <本仓库>/src/main.ts`（`SANDCASTLE_ONLY=12,13` 只做这几张票）。

## 开发

```bash
npm install
npm run typecheck
npm test
```

## 现状

- 第 1、2 步已完成：抽出 Forge 与 ProjectProfile，duckdb_crm 的项目差异全在 `examples/duckdb_crm/sandcastle.config.ts`。
- 提示词（`templates/.sandcastle/*-prompt.md`）与 `docs/` 仍是 duckdb_crm 的写法（引用 CLAUDE.md、test/README.md 等），下一步改成引用标准的项目档案。
- 还没有 GitLab Forge、`onboard`、`doctor`。
