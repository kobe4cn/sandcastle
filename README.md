# sandcastle-pipeline

把 GitHub issue 无人值守地做成 PR、过测试后合并的流水线，基于 [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle)。

流水线按顺序做这些事：

1. 拆票，写实现指引；
2. 按依赖和改动的文件排期；
3. 在 podman 沙箱里让 Claude Code 实现，由另一个会话审查，必要时打回重改；
4. 跑你定义的测试门槛；
5. 全部通过就合并，否则留 PR 给人看。

## 需要

- Node ≥ 22.18
- 已登录的 `gh`（`gh auth login`）
- podman（macOS 上还要 `podman machine start`）
- Claude Code 的凭据：订阅用户可用 `claude setup-token` 生成

## 安装

```bash
npm i -g https://github.com/kobe4cn/sandcastle-releases/releases/latest/download/sandcastle-pipeline.tgz
```

以后升级：`sandcastle-pipeline upgrade`，然后在各项目里跑 `sandcastle-pipeline update`。

## 接入一个项目

在项目根目录：

```bash
sandcastle-pipeline onboard          # 探测项目，生成 .sandcastle/，让 claude 读代码写好 PROJECT.md
cp .sandcastle/.env.example .sandcastle/.env    # 填 token
podman build -t sandcastle:<项目名> -f .sandcastle/Containerfile .sandcastle   # onboard 最后会打印准确的命令
sandcastle-pipeline doctor --fix     # 逐项检查，顺带建好标签
sandcastle-pipeline baseline         # 在沙箱里对 main 跑一次完整门槛
```

然后给 issue 打上 `Sandcastle` 标签，运行：

```bash
SANDCASTLE_ONLY=12 sandcastle-pipeline    # 只做 #12；不设就处理全部带标签的票
```

新项目默认只开 PR、不自动合并（`autoMerge: false`），一次只做一张票。按 [docs/onboarding-checklist.md](docs/onboarding-checklist.md) 走完金丝雀票、真实小票，确认没问题后再放开。

## 生成的文件

| 文件 | 作用 |
|---|---|
| `.sandcastle/PROJECT.md` | 给 agent 看的项目知识：概况、命令、测试、规范、红线、冲突处理、提交约定 |
| `.sandcastle/sandcastle.config.ts` | 怎么跑：装依赖、测试隔离、合并门槛。字段说明见 [docs/config.md](docs/config.md) |
| `.sandcastle/models.json` | 各阶段（prep / implement / review …）用哪个模型 |
| `.sandcastle/.env` | token，不提交 |
| `.sandcastle/Containerfile` | 沙箱镜像 |
| `.claude/` | 上下文预算 hook、截图查看子代理、`/prep-ticket` skill |

## 命令

| 命令 | 作用 |
|---|---|
| `sandcastle-pipeline [run]` | 跑流水线 |
| `sandcastle-pipeline onboard [--no-agent] [--model <名>]` | 接入新项目，已有的文件不覆盖 |
| `sandcastle-pipeline doctor [--fix]` | 跑之前的检查；有 ✗ 时退出码为 1 |
| `sandcastle-pipeline baseline` | 对 `origin/main` 跑一次完整门槛，只报告 |
| `sandcastle-pipeline update` | 把 `.claude/` 下本工具的文件刷成当前版本 |
| `sandcastle-pipeline upgrade` | 安装最新版本 |
| `sandcastle-pipeline --version` | |

现在只支持 GitHub，GitLab 还没做。
