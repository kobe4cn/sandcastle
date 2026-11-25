# 更新记录

## 未发布

- 新增配置 `language: "zh" | "en"`（默认 `zh`）：issue、PR、评论用什么语言写。onboard 按提交历史判断并写进配置。
- `sandpipe --help` 打印用法。
- prep 提示词说明宿主机工作目录里有未提交改动和被忽略的文件，指引以基线分支为准；进度评论第一行写 `模型档案：<档案名>`。

## 0.1.1

- 改名为 `sandpipe`，发布到 npm：`npm i -g sandpipe` 或 `pnpm add -g sandpipe`。`upgrade` 按安装方式用 npm 或 pnpm 升级。
- `doctor` 新增两项检查：`.claude/`、`.gitignore` 是否已推送到主分支；`GH_TOKEN` 能否读写本仓库的 issue、读 PR。
- Python 项目：`[tool.mypy]` 配了 `files` 时，类型检查命令不再加 ` .`。

## 0.1.0

第一个发布版本。

- 命令：`onboard`（接入新项目）、`doctor`（跑前检查，`--fix` 建标签）、`baseline`（main 上跑一次完整门槛）、`run`（跑流水线）、`update`（刷新项目 `.claude/` 下的文件）、`upgrade`（装最新版）。
- 平台：GitHub（`gh` CLI）。GitLab 还没做。
- 新项目默认 `autoMerge: false`、`maxParallel: 1`，接入步骤见 `docs/onboarding-checklist.md`。
