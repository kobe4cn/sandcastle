# 更新记录

## Unreleased

- onboard 生成缺口清单 `.sandcastle/OPEN-QUESTIONS.md`（提交进仓库），取代原来只打印到终端、只存在 `logs/` 里的拿不准的点。每条一行 `- [类别] 问题 → 写到哪`，类别是 `规范` / `意图`（英文项目 `convention` / `intent`）；清单已存在就不碰。写完校验格式，结尾提示剩几条，以及在 Claude Code 里运行 `/fill-project-docs`。
- onboard 的 agent 可写的文件从只有 PROJECT.md 改成一个列表（PROJECT.md 和缺口清单）。
- 探测文档时认 `GLOSSARY.md`。
- `sandpipe onboard --questions-only`：给早于缺口清单接入的项目补一份 `.sandcastle/OPEN-QUESTIONS.md`。agent 读现有 PROJECT.md 和代码找缺口，只许写这份清单，不生成、不改动其他文件；清单已存在时提示删掉后重跑。
- `sandpipe doctor` 新增「项目知识」检查，读缺口清单：还有 N 条时警告，提示在 Claude Code 里运行 `/fill-project-docs`；清单不存在时警告，提示运行 `sandpipe onboard --questions-only`；清单为空时通过；格式错时警告并指出行号。这项检查不会不通过；没有 PROJECT.md 时不做。
- 新增 `/fill-project-docs` skill（装在 `.claude/skills/fill-project-docs/`，附 NOTICE）：在 Claude Code 里和人逐条补完缺口清单，一次问一个问题，能从代码查到的事实不问人；答案按类别写进 PROJECT.md 对应的节、术语表（`CONTEXT.md` / `GLOSSARY.md`，都没有就新建 `GLOSSARY.md`）或 ADR，写完从清单删掉这一条；之后可选梳理核心术语，跑 `sandpipe doctor` 自检，人确认后提交。已接入的项目要跑 `sandpipe update` 才装得上；`sandpipe doctor` 会在它缺失或被改过时警告。
- 缺口清单的「写到哪」不再指向 PROJECT.md 里不存在的节：onboard（含 `--questions-only`）的提示词列出可用的节名（中文项目列中文那套，英文项目列英文那套），写明不能新建节，放不进的写最接近的那一节，清单示例也按项目语言给（英文项目的示例用英文类别和节名）；onboard 写完校验清单时，目标节名不认识的条目打印警告并给出行号（只警告，不算格式错误）。
- prep 遇到缺意图信息的票（业务规则、领域术语、红线、设计原因在票、注入的项目知识和代码里都找不到）不再猜着做：打 `sandcastle:stuck` + `ready-for-human`，评论写明缺什么、应该写进哪份文档（PROJECT.md 的哪一节、术语表或 ADR），提示在 Claude Code 里运行 `/fill-project-docs` 补上后去掉标签。不新增标签，缺口清单不注入提示词（closes #7）。
- 中英文 README 新增「前提」一节：产出质量取决于写下来的意图，缺的部分 onboard 会带你补；用一张表列出事实、规范、意图三类项目知识能否从代码推出、由谁补，并说明只涉及事实的票（修 bug、照已有的样子加字段）没有这些文档也能做。中英文接入清单在 doctor 和门槛基线之间加「补文档（建议）」一步：看 doctor 的「项目知识」检查（老项目先跑 `sandpipe onboard --questions-only`），运行 `/fill-project-docs`，把术语表和 ADR 推到 main；原来的第 2–5 步顺延为第 3–6 步（closes #8）。
- 门槛长时间运行时有进度了：每次门槛开始打印 `📄 #<票号> 门槛输出实时写进 <路径>`，输出逐行实时写进 `.sandcastle/logs/gate-<票号>-<时间戳>.log`（同一张票重跑另开新文件），运行中每 5 分钟打印一次心跳 `⏳ #<票号> 门槛已跑 X 分钟，输出见 <路径>`（日志写不进时警告一次，门槛照跑）。baseline、run（含修复后重跑、rebase 补救）和 main 兜底都生效。档位（`GATE_TIER`）、`GATE_FLAKY`、`GATE_TIME` 仍按完整输出判断（closes #10）。
- config 新增可选字段 `isolation.hostEnvFiles`：声明 config 从宿主机读的 env 文件（比如 `.env`、`.env.test`）。`sandpipe doctor` 新增「宿主机 env 文件」检查，其中有文件在项目根下不存在时警告并提示从 `.env.example` 复制或向同事要，都在时通过；没声明时扫 config 源码里引号包着的 `.env` / `.env.*` 路径（不算 `.sandcastle/` 下的和 `*.example` / `*.sample`），已有的 config 不改也能报出缺失；什么都没找到时不出现这一项（closes #11）。

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
