# sandpipe：开发说明

使用说明见 README.md（英文）和 README.zh-CN.md（中文），会随安装包发布。这份只在私有仓库里。

## 文档的语言

- 给人看的手册（README、`docs/config`、`docs/onboarding-checklist`）中英各一份：`X.md` 是英文，`X.zh-CN.md` 是中文。改一份就同步另一份；`test/docs-i18n.test.ts` 检查两份的标题结构和表格行数一致。
- 给 agent 看的（`prompts/`、`claude/`）只有一份，不翻译。
- `docs/internal/` 是内部文档（设计说明、测试计划），只用中文，不发布。
- 代码注释中英对照：模块头和 JSDoc 先写中文、再写对应的英文（JSDoc 会进 `dist/types/` 的声明文件）；短注释写成 `// 中文 / English`。`npm run check:comments` 列出不合格的注释，`test/comments.test.ts` 在 `npm test` 里检查（范围是 `src/`、`scripts/`、`claude/hooks/`，测试文件不查）。

在 [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle)（沙箱、跑 agent、worktree）之上的 issue → PR → 合并流水线，
从 duckdb_crm 的 `.sandcastle/` 抽出来：prep 拆票写指引、确定性排期（blocker、同文件冲突）、implement + review（revise 打回）、
测试门槛（选测、偶发失败重跑与开票）、自动合并与 rebase 补救、PR 打回、接手外部 PR、按阶段配模型、上下文预算 hook。

## 结构

| 路径 | 内容 |
|---|---|
| `src/cli.ts` | 命令行入口：`run`（默认）、`onboard`、`doctor`、`baseline` |
| `src/doctor.ts` | 跑之前的检查：配置、宿主机 env 文件、PROJECT.md、浏览器验收（有网页界面时）、合并条件（有 CI workflow 却设了 `checks: "none"` 时警告）、缺口清单、models.json、.env、平台登录与权限、标签、Sandcastle 票的 Blocked by 引用、远端分支、镜像、hook、.gitignore |
| `src/main.ts` | 编排（调度、build、land）。不含项目细节，不直接调 gh |
| `src/detect.ts` `src/onboard.ts` `src/open-questions.ts` `prompts/onboard.md` | 接入新项目：探测、生成配置、agent 补全 PROJECT.md 并写缺口清单，校验清单格式和「写到哪」的节名 |
| `src/claude-conflict.ts` | onboard / update 遇到 `.claude/` 下本工具的文件和模板不同时：显示差异，问保留 / 覆盖 / 另存 `.new` |
| `src/forge.ts` | **Forge** 接口：托管平台上的 issue / 标签 / PR / 合并 |
| `src/forges/github.ts` | GitHub 实现（gh CLI） |
| `src/merge-checks.ts` | 合并前等 forge 检查（CI）：检查结果归类、带超时的轮询 |
| `src/browser-gate.ts` | 浏览器验收作为合并的硬条件：哪些改动算改了页面、验收缺什么、留不留 PR |
| `src/merge-flow.ts` | 合并收尾的编排：等检查（不占空位、放开宿主机锁）→ 合并 → 分支保护 / rebase 补救 → 留 PR；依赖由 main.ts 注入 |
| `src/profile.ts` | **ProjectProfile**：项目配置（测试隔离、门槛、安装、一致性检查、文案）与默认值 |
| `src/isolation.ts` | 给 config 的 `isolation.env` / `cleanup` 用的辅助函数（从包入口导出）：读宿主机 env 文件、换宿主机地址、加库名后缀、跑回收脚本 |
| `src/project-doc.ts` | 解析 `.sandcastle/PROJECT.md`、渲染提示词 |
| `prompts/` | 通用提示词模板（implement / review / prep / rebase）与共享片段（设计决定、编码规范、票的大小） |
| `src/gate-progress.ts` | 门槛进度：输出实时写进 `.sandcastle/logs/gate-*.log`、心跳、用时文案 |
| `src/shell.ts` | 宿主机命令（超时、远端重试） |
| `src/guide.ts` `src/pr-body.ts` `src/models.ts` | 票正文解析、空转退出原因、PR 正文、模型档案 |
| `templates/.sandcastle/` | 装到新项目的 PROJECT.md 模板、配置模板、Containerfile、models.json |
| `claude/` | 上下文预算 hook、screenshot-checker 子代理、prep-ticket 和 fill-project-docs skill（后者附 NOTICE，改编自 mattpocock/skills，MIT） |
| `examples/duckdb_crm/` | 第一个接入方的完整配置 |
| `docs/` | 用户手册（中英两份）；`docs/internal/` 是内部文档 |

## 在项目里用

1. 在项目根目录 `npx tsx <本仓库>/src/cli.ts onboard`：
   - 探测语言、包管理、命令、托管平台、文档、测试、迁移、compose 里的服务、env 文件里指向本机服务的变量、提交信息的语言（提交少于 5 条时按文档的主要语言推断；onboard 给了 `--lang` 时它优先）（`src/detect.ts`，只读文件和 git）；
   - 生成 `.sandcastle/` 下的 `sandcastle.config.ts`（按 env 文件里指向本机的变量生成 isolation.env 初稿，没有时按 compose 服务猜）、`PROJECT.md` 草稿、`models.json`、`.env.example`、`.gitignore`、`Containerfile`，
     装 `.claude/hooks/sandcastle-context.mjs`（上下文预算）与 `screenshot-checker` 子代理，并在 `.claude/settings.json` 里登记 hook；`.sandcastle/` 下已存在的文件一律跳过，`.claude/` 下本工具的文件（`CLAUDE_FILES`）已存在且和模板不同时，显示 `git diff --no-index --stat`，问保留 / 覆盖 / 另存 `.new` / 看完整 diff，非交互时另存 `.new`（`src/claude-conflict.ts`，`sandpipe update` 同样处理）；
   - 让宿主机的 claude（默认 opus，`--model` 换，`--no-agent` 跳过）读代码把 `PROJECT.md` 写完整，只许改 PROJECT.md 和缺口清单 `.sandcastle/OPEN-QUESTIONS.md`（已存在的不动）；
     写完用 `parseOpenQuestions` 校验；`sandcastle.config.ts` 的建议打印出来，并存进 `.sandcastle/logs/onboard.md`。
   - 早于缺口清单接入的项目跑 `onboard --questions-only`：提示词是 `prompts/onboard-questions.md`，agent 读现有 PROJECT.md 和代码，只许写缺口清单；
     不生成其他文件、不写 logs。清单已存在或没有 PROJECT.md 时打印提示后退出。
2. 看一遍 `PROJECT.md`（项目知识，给 agent 看）与 `sandcastle.config.ts`（怎么跑：测试隔离、门槛），填 `.sandcastle/.env`，建镜像。
3. `npx tsx <本仓库>/src/cli.ts doctor`：逐项给出 ✓ / ⚠ / ✗ 和修法，有 ✗ 退出码为 1；`--fix` 把缺的标签建上（只有这一项会写东西）。
4. `npx tsx <本仓库>/src/cli.ts baseline`：在沙箱里对 `origin/main` 跑一次完整门槛，只报告、不开票。
5. 跑：`npx tsx <本仓库>/src/cli.ts`（`SANDCASTLE_ONLY=12,13` 只做这几张票）。onboard 生成的配置是 `autoMerge: false`、`maxParallel: 1`：
   全部通过的票也只留 PR。金丝雀票、真实小票都没问题后再放开，完整步骤见 [docs/onboarding-checklist.md](docs/onboarding-checklist.md)。

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
npm run build      # esbuild 打包、压缩到 dist/（npm pack 前自动跑）
```

开发时可以不打包，直接 `npx tsx <本仓库>/src/cli.ts <命令>`。

## 发版

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 加一节 `## <版本>`。
2. 提交，`git tag v<版本> && git push --tags`。
3. `.github/workflows/release.yml` 跑类型检查和测试，`npm pack` 后把 `sandpipe.tgz` 发到公开仓库 `package.json` 的 `sandcastle.releases`。

公开的只有安装包（压缩过的 JS、提示词、模板、`docs/config`、`docs/onboarding-checklist` 的中英两份），见 `package.json` 的 `files`。
`examples/`、其余 `docs/`、测试和源码都不发布。往这些发布的文件里写东西时，不要写进具体项目（比如 duckdb_crm）的内部信息。

一次性准备：
- 建公开仓库（`sandcastle.releases`），里面只放 README。
- 建 fine-grained token：只给这个公开仓库 Contents 读写权限；在私有仓库加成 secret `RELEASES_TOKEN`。

## 现状

- 第 1、2 步已完成：抽出 Forge 与 ProjectProfile，duckdb_crm 的项目差异全在 `examples/duckdb_crm/sandcastle.config.ts`。
- 第 4 步已完成：提示词通用化，项目知识收进 `PROJECT.md`（duckdb_crm 的见 `examples/duckdb_crm/PROJECT.md`）。
- `docs/internal/` 里的 sandcastle.md 等仍是 duckdb_crm 的写法，不发布。
- 第 9 步已完成：打包（esbuild）、发版流程、`update` / `upgrade`、prep-ticket skill 通用化并由 onboard 安装。
- 第 6、7、8 步已完成：`onboard`、`doctor`、接入检查清单（`baseline` 命令与 `autoMerge` 开关）。
- 还没有 GitLab Forge。
