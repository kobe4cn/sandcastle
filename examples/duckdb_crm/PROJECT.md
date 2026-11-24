# PROJECT.md（duckdb_crm）

<!-- 内容取自 duckdb_crm 原来的 .sandcastle/*-prompt.md、CODING_STANDARDS.md、DECISIONS.md 里的项目专有部分。 -->

## 概况

CRM 数据分析平台：从各 B 端企业（租户）的外部数据源只读地汇入 CRM、流量与交易数据，映射到统一的标准模型，计算指标与标签，并通过接口供外部系统调用。领域术语见根目录 `CONTEXT.md`。

- 技术栈：TypeScript、React Router v7（框架模式，`app/routes/`）、Drizzle ORM + PostgreSQL（平台元数据）、DuckDB / DuckLake（业务数据，对象存储上）、Vitest。包管理用 pnpm（脚本也可以 `npm run`）。
- `app/`：Web 应用；服务端代码在 `app/.server/`（`db/schema.ts` 是平台 PG 的表结构），`app/i18n/` 是翻译表。
- `drizzle/`：drizzle-kit 生成的迁移。`scripts/`：运维与开发脚本。`test/`：测试。`docs/`：文档，`docs/adr/` 是架构决定。

## 运行环境

测试连的 PG、MySQL、MongoDB、对象存储都已经通过环境变量配好（宿主机上的容器，每张票独立的库），不要改连接配置。

## 开发命令

- 类型检查：`npm run typecheck`
- 跑单个测试文件：`npx vitest run <file>`
- 改了 `app/i18n/en.client.json` / `en.server.json` 的，提交前跑 `npm run i18n:sort`（词条按键排序，并行的票才不会在文件末尾冲突）。
- 改了 `app/` 下源文件的，提交前跑 `npm run i18n:ratchet`（几秒）：新增了没接入翻译的中文会失败。按报错接入翻译；按 ADR-0060 本就该留中文的（给模型看的工具返回、知识库原文等），跑 `npm run i18n:ratchet -- --update --allow-increase` 显式调高基线，并在提交信息里写明理由。
- 平台 PG 的表结构改在 `app/.server/db/schema.ts`，迁移用 `npm run db:generate -- --name <名字>` 生成，不手写。

## 测试

- 写测试前读 `test/README.md`（夹具、helper、模板），不要去读测试框架和夹具的源码。
- 相似的已有测试：`grep -n` `test/CATALOG.md` 找，不要整读。
- 新增测试文件要在 `test/CATALOG.md` 加一行；新增夹具 helper 要写进 `test/README.md`。
- 测试走公开接口（模块导出的函数、HTTP 路由）。

## 编码规范

另见根目录 `CODING_STANDARDS.md`（并发、和同类功能保持一致、注释与命名），两份都要按。

- 用户可见文字、提交信息、issue / PR 正文、代码注释用中文；标识符用英文。
- 字符串排序一律经 `app/lib/compare.ts`（ADR-0045）：给用户看的名字用 `cmpName`，内部键用对应的比较函数；不要直接用 `localeCompare`。
- 同一个类型只定义一次：表列已经用 `$type<…>()` 声明了形状，就从 `schema.ts` 导出复用。
- 一个模块的同一种失败（如输入不合法的 400）只用一种错误类型；唯一约束冲突转成 400。
- 拿用户输入算指纹、去重或比较之前，先做和存储时一样的规范化（trim 等）。
- 每个查询都按 `tenant_id` 限定；别的租户的对象一律当作不存在（400 / 404，不泄露存在性）。
- 写操作先检查权限（如 `definitions:draft`、`sources:write`、`publish`），和同类功能保持一致。
- 敏感字段（ADR-0005）不进日志、审计 detail、检索文本、目录 Markdown、模型请求。
- 审计：新动作要登记；detail 只放 ID 与类型，不记用户输入的原文。改到目录的动作要进 `CATALOG_ACTIONS`。
- 业务数据只落 DuckLake（ADR-0002），平台 PG 只存元数据。
- 页面改动遵守 `docs/agents/ui.md`。

## 领域与文档

- 术语按 `CONTEXT.md`，其中标了「避免」的词不要用；新增或修改领域术语时更新它。
- 架构决定：先读索引 `docs/adr/README.md`，只打开相关的 ADR；新 ADR 在索引里加一行。新增或修改 ADR 本身不是留 PR 的理由。

## 必须停下

- 和某条 ADR 冲突，或要改 ADR 定下的方向。
- 改工具（给模型调用的 tool）的输入输出语义。
- 涉及租户隔离、敏感字段（ADR-0005）的处理。

## 合并冲突

- **两边都在追加的文件**：`test/CATALOG.md`、`test/README.md`、`CONTEXT.md`、`docs/adr/README.md`、翻译表 `app/i18n/en.client.json` / `en.server.json`、审计动作登记、导出列表等。翻译表两边的键都保留，然后跑 `npm run i18n:sort` 重新排序、合并相同的重复键（它报同一个键两种译文时，按主分支上已有的那条留下）。
- 中文棘轮基线 `test/i18n-ratchet-baseline.json` 冲突时先任取一边，再跑 `npm run i18n:ratchet -- --update` 按合并后的代码重算（只会下调；它拒绝写入说明合并后的代码中文变多了，按报错处理）。
- **`app/.server/db/schema.ts`**：两边的表、列都保留。
- **drizzle 迁移**（`drizzle/<时间戳>_<名字>/`）：不要手工合并 `migration.sql` 或 `snapshot.json`。rebase 中先只解决 `schema.ts`（迁移目录原样保留）；**rebase 全部结束后**再删掉**本票**加的迁移目录，重新 `npm run db:generate -- --name <原来的名字>`。新目录要排在主分支最新迁移之后，`snapshot.json` 的 `prevIds` 要指向它。看一眼新的 `migration.sql`：只能有本票的改动。重新生成的迁移单独提交，提交信息「重新生成迁移，接在 … 之后」。

## 浏览器验收

`test/README.md` 的「浏览器验收」一节是给宿主机写的（ego-browser、开发库 `crm_platform`）；在沙箱里按这里做。

1. 准备：`node --import tsx scripts/browser-lab.ts`（在这张票自己的验收库里建租户 `crmlab-smoke` 与 `admin@` / `eng@` / `an@crmlab-smoke.test`，环境变量已配好）。
2. 起 dev server：`npx react-router dev --port 5180 --strictPort > /tmp/dev.log 2>&1 &`，等 `curl -s -o /dev/null http://localhost:5180/login` 成功。
3. 登录：`playwright-cli open http://localhost:5180/login` → `snapshot` 找邮箱框和「发送登录链接」的 ref → `fill` / `click` → `grep -o 'http://localhost:5180/auth/verify?token=[A-Za-z0-9_-]*' /tmp/dev.log | tail -1` → `goto` 这个链接 → **点「登录」按钮** → 地址离开 `/auth` 才算登录。换角色先点「退出登录」。
4. 验收租户是空的：需要的数据（数据源、定义等）在页面上自己建，建不出来就写进结论。截图除了对照 Browser check，还要对照 `docs/agents/ui.md`。
5. 查错时 `grep -n -i error /tmp/dev.log`。首次加载时 vite 的 `Failed to fetch dynamically imported module` / 依赖预构建重载是噪声，刷新后不再出现就忽略。

## 人工验收

宿主机上用开发库 `crm_platform` 和 `npm run dev`。

## 提交

- 按仓库现有风格写中文提交信息（看 `git log -n 3 --format=%B origin/main`）：一行说明做了什么，然后是关键决定、改动的文件、验证结果（typecheck、跑过的测试文件与用例数）。
- 新增测试文件要在 `test/CATALOG.md` 加一行；加了 ADR 要更新 `docs/adr/README.md`。
