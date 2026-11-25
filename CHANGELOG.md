# 更新记录

## Unreleased

- onboard 生成缺口清单 `.sandcastle/OPEN-QUESTIONS.md`（提交进仓库），取代原来只打印到终端、只存在 `logs/` 里的拿不准的点。每条一行 `- [类别] 问题 → 写到哪`，类别是 `规范` / `意图`（英文项目 `convention` / `intent`）；清单已存在就不碰。写完校验格式，结尾提示剩几条，以及在 Claude Code 里运行 `/fill-project-docs`。
- onboard 的 agent 可写的文件从只有 PROJECT.md 改成一个列表（PROJECT.md 和缺口清单）。
- 探测文档时认 `GLOSSARY.md`。
- `sandpipe onboard --questions-only`：给早于缺口清单接入的项目补一份 `.sandcastle/OPEN-QUESTIONS.md`。agent 读现有 PROJECT.md 和代码找缺口，只许写这份清单，不生成、不改动其他文件；清单已存在时提示删掉后重跑。

## 0.1.4

- npm 页面上 README 的相对链接（中文版、配置说明、接入清单）不再 404：`package.json` 的 `repository` 指向公开的 releases 仓库，发版时把 README 和文档同步过去。
- 发版 workflow 的 `actions/checkout`、`actions/setup-node` 升到 v7（不再跑在已弃用的 Node 20 上）。

## 0.1.3

- 用户手册中英两份：`README.md`、`docs/config.md`、`docs/onboarding-checklist.md` 是英文，同名的 `.zh-CN.md` 是中文。内部文档移到 `docs/internal/`。
- onboard 生成的文件（`sandcastle.config.ts`、`.gitignore`、`.env.example`、`Containerfile`）注释都是中英两行。
- 终端输出（流水线日志、doctor、onboard、`--help`、报错）按项目配置的 `language` 显示中文或英文；没有项目配置时看 `LANG`，`SANDPIPE_LANG=zh|en` 可以强制指定。
- 代码注释中英对照（声明文件里的说明也是两种语言），`npm test` 会检查。
- `sandpipe onboard --lang zh|en`：PROJECT.md 草稿（章节标题、待补标记）和配置里的 `language` 按它写，没给时按提交信息判断。

## 0.1.2

- 新增配置 `language: "zh" | "en"`（默认 `zh`）：issue、PR、评论用什么语言写。onboard 按提交历史判断并写进配置。
- `sandpipe --help` 打印用法。
- prep 提示词说明宿主机工作目录里有未提交改动和被忽略的文件，指引以基线分支为准；进度评论第一行写 `模型档案：<档案名>`。
- 带类型声明（`dist/types/`，package.json 的 `types`）。onboard 和 update 生成 `.sandcastle/tsconfig.json`，用 paths 把 `sandpipe` 指到本机装的这份工具，不是 Node 的项目也不用装任何依赖，编辑器里有类型提示，也没有告警。这个文件含本机路径，所以加进了 `.sandcastle/.gitignore`（老项目跑 `sandpipe update` 补上）；doctor 会检查它是不是指向当前版本。
- PROJECT.md 的章节标题中英文都认（`## Overview`、`## Commands`、`## Testing`、`## Commits`……），同一节只能写一次。
- 门槛用时不到一分钟时按秒显示。

## 0.1.1

- 改名为 `sandpipe`，发布到 npm：`npm i -g sandpipe` 或 `pnpm add -g sandpipe`。`upgrade` 按安装方式用 npm 或 pnpm 升级。
- `doctor` 新增两项检查：`.claude/`、`.gitignore` 是否已推送到主分支；`GH_TOKEN` 能否读写本仓库的 issue、读 PR。
- Python 项目：`[tool.mypy]` 配了 `files` 时，类型检查命令不再加 ` .`。

## 0.1.0

第一个发布版本。

- 命令：`onboard`（接入新项目）、`doctor`（跑前检查，`--fix` 建标签）、`baseline`（main 上跑一次完整门槛）、`run`（跑流水线）、`update`（刷新项目 `.claude/` 下的文件）、`upgrade`（装最新版）。
- 平台：GitHub（`gh` CLI）。GitLab 还没做。
- 新项目默认 `autoMerge: false`、`maxParallel: 1`，接入步骤见 `docs/onboarding-checklist.md`。
