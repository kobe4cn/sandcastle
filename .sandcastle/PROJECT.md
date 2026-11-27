# PROJECT.md（sandpipe）

## 概况

sandpipe：在 `@ai-hero/sandcastle`（沙箱、跑 agent、worktree）之上的 issue → PR → 合并流水线（prep 拆票、排期、implement + review、测试门槛、自动合并、rebase 补救）。以 npm 包发布，用户在自己的项目里跑 `sandpipe onboard / doctor / run`。本仓库也用发版后的 sandpipe 处理自己的票（自举，ADR 0004）。结构总表见 `DEVELOPMENT.md`「结构」，先读它。

- 技术栈：TypeScript（ESM，直接用 `.ts` 后缀 import，`tsx` 运行）、Node ≥ 22.18、Vitest、esbuild 打包到 `dist/`。没有网页界面。
- 入口：`src/cli.ts`（`run` 默认、`onboard`、`doctor`、`baseline`、`update`、`upgrade`）；编排在 `src/main.ts`（不含项目细节、不直接调 gh，平台操作走 `src/forge.ts` 接口，GitHub 实现在 `src/forges/github.ts`）；包入口 `src/index.ts`（`defineProject`、isolation 辅助函数）。
- `src/`：源码，判断逻辑尽量抽成纯函数放在独立模块（`browser-gate.ts`、`protected-paths.ts`、`re-review.ts`、`trust.ts`…），main.ts 只编排。
- `prompts/`：给 agent 的通用提示词模板，不写任何具体项目的路径或命令；`{{P_…}}` 由 PROJECT.md 各节填入（`src/project-doc.ts` 的 `SECTIONS`）。
- `templates/.sandcastle/`：onboard 装进目标项目的模板。`claude/`：hook、`screenshot-checker` 子代理、skills 的源文件。
- `docs/`：用户手册（中英两份）；`docs/internal/` 内部设计文档（只中文、不发布）；`docs/adr/` 架构决定；`docs/agents/` 给 agent skills 的配置。
- `scripts/`：`build.mjs`（打包）、`check-comments.mjs`（注释中英对照检查）。`examples/duckdb_crm/`：第一个接入方的完整配置。`test/`：测试。

## 开发命令

- 类型检查：`pnpm typecheck`（即 `tsc --noEmit`）
- 跑单个测试文件：`npx vitest run test/<名字>.test.ts`；全量：`pnpm test`
- 注释中英对照检查：`node scripts/check-comments.mjs`（改了 `src/`、`scripts/`、`claude/hooks/` 里的注释后跑；`test/comments.test.ts` 也会在全量测试里查）
- 两份锁文件都保留（沙箱用 `pnpm-lock.yaml`，发版 CI 用 `package-lock.json`）：改依赖（`package.json` 的 dependencies / devDependencies）时先 `pnpm install`、再 `npm install --package-lock-only`，两份一起提交；只改代码时不要动锁文件。
- 打包 `npm run build` 只在发版时需要，票里不用跑，也不要提交 `dist/`。
- 不要改 `package.json` 的 `version`、不要打 tag：发版由人做（DEVELOPMENT.md「发版」）。

## 测试

- Vitest，测试都在 `test/`，一个源模块大体对应一个 `test/<模块>.test.ts`（如 `src/browser-gate.ts` → `test/browser-gate.test.ts`）；新文件放这里即可，不需要登记。
- 找相似用例：`grep -n "<函数名>" test/*.ts`。判断逻辑测纯函数；编排类用注入的假依赖，照抄已有写法：`test/merge-flow.test.ts` 的 `fakeDeps`、`test/merge-checks.test.ts` 的 `fakeForge`、`test/forge-github.test.ts` / `test/doctor.test.ts` 的 `fakeGh`、`test/trust.test.ts` 的 `fake`。
- 需要临时仓库时用 `test/fixtures.ts` 的 `nodeRepo()`（node + pnpm，带 compose、迁移、origin）和 `pythonRepo()`。
- `vitest.config.ts` 把终端语言固定为中文（`SANDPIPE_LANG=zh`），英文文案要单独写用例断言（看已有的「英文文案」用例）。
- 不依赖任何外部服务；不要在测试里真的调 gh、podman 或网络。

## 编码规范

- 注释中英对照：模块头和 JSDoc 先写中文、再写对应英文；短注释写成 `// 中文 / English`。只写中文的注释会让 `test/comments.test.ts` 失败。测试文件不查。
- 终端输出、issue / PR 评论里的文案一律放进 `src/i18n.ts`，`zh` 和 `en` 两边都加（`en` 的类型是 `Messages`，少一边编译不过），不要在代码里写死中文或英文字符串。
- 判断类逻辑拿不到信息（取不到 diff、HEAD、权限）时按不通过处理（fail-closed），留 PR 并在评论里写明原因；和已有的 `browserStale`、`protectedHits`、`needsReReview` 保持一致。
- 只采纳可信作者的评论 / 标记（`src/trust.ts`、`trustedBodies`），新增读评论的地方也要过滤（ADR 0006）。
- `prompts/`、`templates/`、`docs/config*`、`docs/onboarding-checklist*`、README 会随包发布：里面不要写具体项目（如 duckdb_crm）的内部信息。
- `src/index.ts` 导出的 API 和 `ProjectProfile` 配置字段按兼容方式改：新字段可选、给默认值，老配置不改也能跑；不删除或改名已有导出 / 字段，不改变已有字段的含义。确需不兼容时停下问人（见「必须停下」），由人决定是否在 CHANGELOG 写迁移说明。
- `src/project-doc.ts` 的 `SECTIONS` / `SECTIONS_EN` 标题是契约，改名要同步 `templates/.sandcastle/PROJECT.md`、`templates/example-PROJECT.md`、`examples/duckdb_crm/PROJECT.md`、`prompts/onboard*.md`。

## 领域与文档

- 术语按根目录 `GLOSSARY.md`（项目知识、缺口清单、运行版本、自举、可信作者…）；新增术语时更新它。
- 架构决定：先读 `docs/adr/README.md` 索引，只打开相关的 ADR；新 ADR 取下一个编号，并在索引末尾加一行。
- 改了配置项或流水线行为：同步 `docs/config.md` 和 `docs/config.zh-CN.md` 两份（`test/docs-i18n.test.ts` 检查两份标题结构和表格行数一致）；README、`docs/onboarding-checklist` 同理中英各一份。
- 内部设计说明在 `docs/internal/sandcastle.md`（标签状态机、合并条件、评论标记、浏览器验收）；改了对应行为时同步。新增模块要在 `DEVELOPMENT.md`「结构」表里加一行。

## 必须停下

- 改动和某条 ADR 冲突（尤其 ADR 0004 自举隔离、ADR 0006 可信作者）。
- 票要求放宽合并关卡：评审 / 复审结论、受保护路径、浏览器验收门槛、可信作者过滤，或把 fail-closed 改成放行。
- 票要改受保护路径里的文件（`src/trust.ts`、`src/forges/github.ts` 的评论过滤、`src/protected-paths.ts` 及 ADR 0004 列出的判合并文件），而实现指引没有用 `**Protected**` 显式放行。新增判合并的源文件时也要停下，请人把它加进 `protectedPaths`。
- 票要求对 `src/index.ts` 导出的 API 或配置字段做不兼容的改动（删除、改名、改变含义、新增必填项）。
- 票要求在发布的文件里写进具体项目的内部信息，或改发版流程（`.github/workflows/release.yml`、`package.json` 的 `files` / `version`）。

## 合并冲突

- **两边都在追加的文件**：`CHANGELOG.md`（`## Unreleased` 下两边的条目都保留）、`GLOSSARY.md`、`docs/adr/README.md`、`DEVELOPMENT.md` 的「结构」表：两边的内容都保留。
- `src/i18n.ts`：两边新增的键在 `zh` 和 `en` 里都保留；同名键冲突时按各自用途改名。
- ADR 编号撞了：本票的 ADR 改用下一个空号，文件名、标题、索引行和正文里的引用（GLOSSARY、CHANGELOG、docs）一起改。
- `pnpm-lock.yaml` / `package-lock.json` 不手工合并：取 main 的版本后重新 `pnpm install`（并 `npm install --package-lock-only`）生成。

## 提交

- 中文提交信息，一段写完：先一句话说做了什么，冒号后写改了哪些文件 / 函数（如 `src/browser-gate.ts 的 browserProblems 加第 5 个参数 verdict`）、i18n 新增的键、测试文件里加了哪些用例、同步了哪些文档（「docs/config 中英、CHANGELOG 同步」），结尾 `（closes #n）`；评审后续的提交结尾写 `(#n)`。
- 例：`git log -n 3 --format=%B origin/main`。
- CHANGELOG：用户能感知的变化（行为、配置项、提示词、终端 / 评论文案、发布的文档）在 `CHANGELOG.md` 顶部的 `## Unreleased` 下加一条（没有这一节就新建在第一个版本节之前），写变化和关键函数 / 文件，结尾 `（closes #n）`。纯内部重构、只改测试、只改 `docs/internal/` / `docs/agents/` / 开发配置的票不加；评审后续只在改变了用户能感知的行为时补改已有条目，不另加新条目。
