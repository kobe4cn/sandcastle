# 自举：运行版本与被改代码隔离

## 背景

sandpipe 的能力已经够处理真实的票，我们打算让它处理 sandcastle 仓库自己的 issue（自举）。这时流水线改的是它自己：评审提示词、合并关卡、门槛脚本都在这个仓库里。如果流水线跑的就是 main 上的代码，agent 合进来一个放宽评审或绕过关卡的改动，下一张票就会被这个放宽过的流水线处理，坏改动能把自己批准进来。仓库是公开的，票的正文和评论还是提示词注入的入口（#64）。

## 决定

- **运行版本只来自发版**。自举时流水线一律用固定版本号的 npm 包，用 `pnpm dlx sandpipe@<版本>` 跑（不能装成本仓库的依赖：包名和本仓库同名）；不用 `npm link`，也不用本地 `dist/` 跑 main。流水线合进 main 的改动，要等人手动发版、并用新版跑通一张试点票后把命令里的版本号改过去，才变成运行版本。
- **决定"能不能合进来"的东西不让 agent 自己批准**。本仓库的 `protectedPaths`（ADR 0003）覆盖：`.github/workflows/`、`prompts/`、`.sandcastle/`、`claude/`、`.claude/`、`scripts/`、`package.json`，以及判合并、判票来源的 `src/merge-checks.ts`、`src/merge-flow.ts`、`src/re-review.ts`、`src/browser-gate.ts`、`src/gate-queue.ts`、`src/trust.ts`、`src/protected-paths.ts`、`src/forges/github.ts`（以 `.sandcastle/sandcastle.config.ts` 为准）。`src/` 的其余部分不保护，否则自动合并就没有意义了；删测试、放宽断言交给复审。
- **`.claude/` 里的副本跟运行版本走**。onboard / update 装进 `.claude/` 的 hook 和 skills 提交进仓库（沙箱从仓库 clone，要能看到），只在升级运行版本后用 `sandpipe update` 同步。它们和 `claude/` 下的源文件不一致是正常的，不要改成软链接，否则 agent 用的就是 main 上的最新 skill。
- **自动合并分阶段放开**。先只开 PR（`autoMerge: false`）；#57（全部子票）、#60、#64 做完，并且只开 PR 的模式下连续 5 张 PR 人没改就直接合了，才对本仓库开自动合并。#64 由人手动做，不交给流水线。

## 考虑过的方案

- **用 main 上的最新代码跑流水线**：否决。改动当场生效，坏改动会参与评审自己，也没有回退点。
- **`.claude/` 副本软链接到 `claude/`**：否决，理由同上，会绕过版本隔离。
- **把整个 `src/` 列为受保护路径**：否决。`src/` 就是产品本身，全保护的话自举就只能一直开 PR。只保护决定合并的那几个文件。
- **#64 交给流水线自己修**：否决。修"agent 会被注入"这个漏洞的过程本身就暴露在这个漏洞下。

## 后果

- 流水线合进来的改动不会立刻生效，要靠人发版；发版前多跑一张试点票（见 DEVELOPMENT.md「发版」）。
- 改评审提示词、合并关卡、门槛配置的票永远留 PR 给人合。
- 仓库里 `claude/` 和 `.claude/` 会有两份内容可能不同的文件，这是预期行为。
- 新增判合并的源文件时，要同步加进本仓库的 `protectedPaths`。
