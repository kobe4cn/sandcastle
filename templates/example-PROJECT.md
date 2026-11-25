# PROJECT.md（示例：虚构的网店后台 shop-admin）

<!-- onboard 把它作为「写成什么样」的参考给 agent；项目是虚构的，只看写法，不要照抄内容。 -->

## 概况

网店后台：商家管理商品、库存、订单与退款，运营看销售报表。领域术语见根目录 `GLOSSARY.md`。

- 技术栈：TypeScript、Fastify（`src/server/`）、React + Vite（`src/web/`）、Prisma + PostgreSQL、Redis（会话与队列）、Vitest。包管理用 pnpm。
- `src/server/routes/`：HTTP 接口，一个资源一个文件；`src/server/jobs/`：队列任务；`prisma/schema.prisma`：表结构。
- `prisma/migrations/`：迁移。`scripts/`：运维脚本。`test/`：测试。`docs/adr/`：架构决定。

## 运行环境

测试连的 PG 与 Redis 已经通过环境变量配好（每张票独立的库和 key 前缀），不要改连接配置。

## 开发命令

- 类型检查：`pnpm typecheck`；lint：`pnpm lint`
- 跑单个测试文件：`pnpm vitest run <file>`
- 改了 `prisma/schema.prisma` 的，用 `pnpm prisma migrate dev --name <名字>` 生成迁移，不手写 SQL。

## 测试

- 写测试前读 `test/README.md`（夹具：`createShop()`、`loginAs(role)`）。
- 接口测试用 `app.inject()` 走 HTTP，不直接调路由内部函数。
- 每个测试自己建数据，不依赖其他测试留下的数据。

## 编码规范

- 用户可见文字、提交信息用中文；标识符用英文。
- 金额一律用整数「分」，只在展示时格式化（`src/shared/money.ts`）。
- 每个查询都按 `shopId` 限定；别的店铺的对象一律返回 404。
- 写操作先查权限（`requireRole("staff")` 等），和同类接口保持一致。

## 领域与文档

- 术语按 `GLOSSARY.md`；新增术语时更新它。
- 架构决定：先读 `docs/adr/README.md` 索引，只打开相关的 ADR；新 ADR 在索引里加一行。

## 必须停下

- 改动和某条 ADR 冲突。
- 涉及支付回调、退款金额计算。

## 合并冲突

- **两边都在追加的文件**：`GLOSSARY.md`、`docs/adr/README.md`、`test/README.md`：两边的内容都保留。
- **Prisma 迁移**：不要手工合并 `migration.sql`。rebase 结束后删掉本票加的迁移目录，重新 `pnpm prisma migrate dev --name <原来的名字>`，提交信息写「重新生成迁移」。

## 浏览器验收

1. 准备：`pnpm seed:demo`（建演示店铺和 `owner@demo.test` / `staff@demo.test`）。
2. 起服务：`pnpm dev --port 5180 > /tmp/dev.log 2>&1 &`，等 `curl -s -o /dev/null http://localhost:5180/login` 成功。
3. 登录：`playwright-cli open http://localhost:5180/login`，用演示账号登录，地址离开 `/login` 才算登录成功。
4. 查错时 `grep -n -i error /tmp/dev.log`。

## 人工验收

宿主机上 `pnpm seed:demo && pnpm dev`，用演示账号登录。

## 提交

- 中文提交信息：一行说明做了什么，然后写关键决定、改动的文件、验证结果（typecheck、跑过的测试文件）。
