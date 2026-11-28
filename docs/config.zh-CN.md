# 项目配置：`.sandcastle/sandcastle.config.ts`

中文 | [English](config.md)

`onboard` 按探测结果生成。必填的只有 `install`、`isolation`、`gate`，其余都有默认值。

```ts
import { defineProject, readHostEnv, runHostScript, toContainerHost, withDbSuffix } from "sandpipe";

export default defineProject({
  install: { onSandboxReady: "pnpm install --frozen-lockfile" },
  isolation: {
    // 每张票独立的测试库或前缀，并行的票互不清表。runId 是票号，main 上的兜底检查是 "main"
    // .env 里是 DATABASE_URL=postgres://test@localhost/shop_test，进沙箱的是 postgres://test@host.containers.internal/shop_test_i<runId>
    env: (runId) => ({
      DATABASE_URL: withDbSuffix(toContainerHost(readHostEnv(".env").DATABASE_URL ?? "postgres://test@localhost/shop_test"), `_i${runId}`),
    }),
    // 关沙箱后在宿主机上回收这张票的资源（删库等）。失败只记日志
    cleanup: async (runId) => {
      await runHostScript("node", ["scripts/drop-test-db.js", `_i${runId}`], `#${runId} 回收失败`);
    },
  },
  gate: {
    script: ({ baseRef }) => "pnpm typecheck && pnpm lint && pnpm test",
    testFile: /test\/\S+\.test\.ts/,
    typecheck: "pnpm typecheck",
  },
});
```

`import "sandpipe"` 不需要项目里装这个包，运行时会指向你装的 `sandpipe`。

## 必填

| 字段 | 说明 |
|---|---|
| `install.onSandboxReady` | 沙箱建好后装依赖的命令（在 linux 容器里跑） |
| `install.copyToWorktree` | 可选。从宿主机拷进 worktree 的路径，省掉从头安装 |
| `isolation.env(runId)` | 进沙箱的环境变量：独立的测试库、key 前缀等 |
| `isolation.cleanup(runId)` | 可选。关沙箱后回收这张票的测试资源 |
| `isolation.hostEnvFiles` | 可选。config 从宿主机读的 env 文件（相对项目根，比如 `[".env", ".env.test"]`），`sandpipe doctor` 检查它们存在，缺了警告。不写时 doctor 扫 config 源码里引号包着的 `.env` / `.env.*` 路径（不算 `.sandcastle/` 下的和 `*.example` / `*.sample`） |
| `gate.script({ baseRef })` | 合并门槛，在沙箱里用 `sh -c` 跑，退出码 0 算通过 |
| `gate.testFile` | 测试文件路径的正则，用来从门槛输出里认出失败的文件 |
| `gate.typecheck` | 等人审的 PR rebase 之后只跑这条命令 |
| `gate.services` | 可选。门槛依赖的服务，`[{ name, host, port }]`（比如 `[{ name: "postgres", host: "localhost", port: 5432 }]`）。`sandpipe run` 启动时逐个用 TCP 连一次，有连不上的就报错退出，写明服务名和 `host:port`；`sandpipe doctor` 每个服务输出一行 ok / fail。`host` 写宿主机能直连的地址 |

门槛脚本的输出约定（可选，用来按依赖选测试、识别偶发失败）：

- 输出一行 `GATE_TIER: selected …`，表示只跑了按依赖选出的测试；没有这一行就算完整测试。
- 环境变量 `GATE_FULL=1` 时必须跑完整测试（`baseline` 和 main 上的兜底检查会设）。
- 失败的文件单独重跑后通过时，输出 `GATE_FLAKY`。它前面列出重跑过的文件，后面是第一次失败的摘要。流水线会为这些文件开 `flaky` 票。
- 门槛依赖的服务连不上时（退出码非 0，且输出某一行命中 `ECONNREFUSED`、`getaddrinfo ENOTFOUND` / `EAI_AGAIN`、`Cannot connect to the Docker daemon` / `Cannot connect to Podman`），终端打出那一行，不开 fix 会话、不算失败，稍后整步重跑；重试用完仍连不上就打 stuck，评论写明那一行。项目自己的连接类报错用可选的 `gate.envErrorPattern`（正则，比如 `/MongoServerSelectionError/`）追加。`No test files found` 和普通的断言失败不算。
- 输出按纯文本逐行解析，ANSI 转义码会被去掉。门槛默认设了 `NO_COLOR=1` / `FORCE_COLOR=0`，想要颜色就在 `gate.env` 里设 `NO_COLOR: ""`；门槛脚本自己 grep 失败行时不要依赖颜色码。

## 隔离辅助函数

`sandpipe` 导出，给 `isolation.env` / `cleanup` 用。config 在宿主机上被加载，它们都跑在宿主机，相对路径按项目根算。

| 函数 | 做什么 |
|---|---|
| `readHostEnv(files, projectRoot?)` | 读宿主机上的一个或多个 env 文件（比如 `[".env", ".env.test"]`）并合并，后面的覆盖前面的。不存在的文件跳过，不报错 |
| `toContainerHost(value)` | 把 `localhost` / `127.0.0.1` 换成 `host.containers.internal`，沙箱才连得上宿主机上的服务 |
| `withDbSuffix(url, suffix)` | 给库名或前缀加后缀（比如 `` `_i${runId}` ``）。保留 query（`?authSource=admin`）和结尾的 `/`；不含 `://` 的值直接拼接。URL 没有库名时抛错，不让测试打到开发库 |
| `runHostScript(command, args, label)` | 在宿主机上跑回收脚本。成功返回 stdout；失败打一行警告（`label` 加 stderr 前 500 字）并返回 `undefined`，从不抛错 |

## 浏览器验收

有网页界面的项目，PROJECT.md 写了「浏览器验收」一节，agent 才会在沙箱里起 dev server、用浏览器点一遍改过的页面；没有这一节（只有 HTML 注释也算没有），改页面的票只能留 PR 给人看；探测到网页界面或配了 `browser.pagePaths` 时，`sandpipe run` 启动时和 `sandpipe doctor` 都会警告。配了这一节，改了页面的票（diff 命中 `browser.pagePaths`、有 `.browser-check/`、或 reviewer 的 `browser-check` 是 `done` / `missing`）要自动合并还得满足：至少一张截图；`RESULT.md` 存在、列表 / 表格行里没有 ❌ / ⚠、引用的截图文件都在；reviewer 的 `browser-check` 是 `done`（reviewer 要自己看截图、对照票的 Browser check 逐条给出 `<browser-verdict>`，逐条全 ✅ 且与 `RESULT.md` 一致才给 `done`），且 reviewer 的逐条 `browser-verdict` 存在、没有 ❌ / ❓ 行（给了 `done` 却没有逐条结论、或有这样的行，即使 `RESULT.md` 全 ✅ 也挡）。缺哪条就留 PR，终端和 PR 评论逐条写出来。验收在 implement 结束时记下当时的提交：之后 revise / fix 改了命中 `browser.pagePaths` 的文件（从那个提交到 HEAD 的 diff），截图已过期，留 PR；恢复路径（没记提交）或取不到这段 diff 时也按过期处理。rebase 补救里 agent 解冲突改到了页面（冲突文件加上新出现在 diff 里的文件）时不 push、留 PR。改动没碰页面时旧的验收照常有效。不会自动重做浏览器验收，由人重新验收。改了页面但票的实现指引里没有 `- **Browser check**` 一项时，PR 的 Browser check 一节和一条 PR 评论会提示补 prep 规则。PR 的 Browser check 一节先写评审结论（reviewer 的 `<browser-verdict>`，没给时写明），再写 implement 自评（`RESULT.md`）。implement 还会把票里 Browser check 的关键步骤沉淀成 Playwright 测试提交到仓库：等待页面稳定（等元素可见或可交互、等网络空闲或等具体响应、web-first 断言），不用 `waitForTimeout` / sleep 固定延时；测试放哪、怎么单跑按「浏览器验收」一节写的来（模板注释里提示要写 e2e 目录和单跑命令）。review 把「改了页面却没提交对应的测试」「测试里用固定延时代替等待」列为要修的问题，打回 implementer。项目接没接浏览器 e2e 的判断：「浏览器验收」一节写了 e2e 目录和单跑命令、或仓库里已有 e2e 测试才算接了；两条都不满足时 implement 跳过沉淀（不装依赖、不建 e2e 配置，浏览器验收照旧做，`RESULT.md` 末尾写一行「本项目没接浏览器 e2e，未沉淀测试」），review 按同样条件跳过核对、不因缺测试打回。

onboard 生成的 Containerfile 不管有没有网页界面都装好 playwright-cli 和 Chromium。onboard 会先读项目已有的验收资料（README、测试说明、旧的 `.sandcastle` 提示词、`scripts/` 里建验收数据的脚本），能拼出下面四步就写这一节，拼不全就把缺的信息（dev server 启动命令与端口、验收数据怎么建、登录方式与账号、dev server 要的变量）列进缺口清单。后端项目加了前端：在 PROJECT.md 加浏览器验收一节（照下面的示例），并配 `browser.pagePaths`（见「可选」），沙箱已经装好浏览器。

- **dev server 要的变量放进 `isolation.env`**：dev server 在沙箱里读的变量（数据库、会话密钥、对象存储等）都要出现在 `isolation.env` 的返回值里，少一个就起不来。用上一节的 `readHostEnv` 从宿主机 env 文件读出来，指向本机服务的值过一遍 `toContainerHost`。
- **用独立的库**：和测试一样，库名用 `withDbSuffix` 加上 `` `_i${runId}` `` 后缀，验收数据不会碰到开发库，也不会和并行的票互相清表（写法见开头的示例）。
- **验收数据**：在 PROJECT.md 这一节第一步写建数据的命令（种子脚本、建账号）；给人验收时的固定准备步骤写在 `acceptancePrep`（见「可选」）。
- **写法**：按「准备数据、后台起服务并等它能访问、登录、查日志」四步写清命令、端口和账号。拿不准沙箱里能不能起来就先不写，doctor 会一直提示。

示例（命令、端口、账号换成项目自己的）：

```markdown
## 浏览器验收

1. 准备：`pnpm db:seed`（建 `admin@example.com` / `password` 账号）。
2. 起服务：`pnpm dev --port 3000 > /tmp/dev.log 2>&1 &`，等 `curl -s -o /dev/null http://localhost:3000/login` 成功。
3. 登录：`playwright-cli open http://localhost:3000/login`，用上面的账号登录，地址离开 `/login` 才算登录成功。
4. 查错时 `grep -n -i error /tmp/dev.log`。
```

项目有 Playwright e2e（onboard 探测到根目录的 `playwright.config.{ts,js,mjs,cjs}`，或 package.json 有 `test:e2e` / `e2e` script）时，onboard 把 e2e 命令接在 `gate.script` 末尾由合并门槛跑：改坏了页面、即使 diff 没命中 `browser.pagePaths`，也会被门槛拦下。Playwright 的基准截图目录（`-snapshots/`）同时默认进 `protectedPaths`——更新基准的票只能留 PR 由人确认，不自动合并。已有的 e2e 没被探测到时（命令不叫 `test:e2e` / `e2e`、根目录也没有 playwright 配置文件），把 e2e 命令手动接在 `gate.script` 末尾即可，依赖装 `@playwright/test`（devDependency）。项目有页面但门槛没跑 e2e 时，onboard 的探测摘要和 `sandpipe doctor` 的「浏览器 e2e」一项都会提示怎么接。门槛里跑 e2e 要注意：

- dev server 由 Playwright 配置里的 `webServer` 在门槛内自己起；`gate.services` 只在宿主机做 TCP 预检，不负责起服务。e2e 依赖的服务（数据库等）写进 `gate.services`，沙箱里要能访问到：指向本机服务的值在 `isolation.env` 里过一遍 `toContainerHost`（见上面的「隔离辅助函数」）。
- 沙箱镜像装了 Chromium（`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`）但没有 `@playwright/test`；版本不匹配时在 `install.onSandboxReady` 里加跑 `playwright install chromium`。
- 失败 spec 的路径要能被 `gate.testFile` 的正则认出来，fix 和偶发失败重跑才用得上（node 的默认 `\S+\.(test|spec)\.[cm]?[jt]sx?` 已盖住 `e2e/xxx.spec.ts`）。
- 不要把 e2e 加进 `gate.typecheck`（它只在 rebase 留 PR 时跑）。

## 可选

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoMerge` | `true` | `false` 时全部通过的票也只留 PR 等人合并（onboard 生成 `false`，见 onboarding-checklist.zh-CN.md） |
| `mergeRequires` | `{ checks: "all", timeoutMinutes: 30 }` | 自动合并除了门槛还要等什么：`checks` 取 `"all"`（PR 上的检查全部通过）、`"required"`（只看必需检查）或 `"none"`（只看门槛，给 CI 不可靠的项目用）。PR 上没有检查时不阻塞合并。有检查失败、或等了 `timeoutMinutes` 分钟还没跑完时留 PR（`sandcastle:pr-open`），评论列出是哪些检查。等的时候这张票不占实现的空位 |
| `language` | `"zh"` | issue、PR、评论用的语言，`"zh"` 或 `"en"`：脚本写的固定文字（PR 正文、评论、自动开的票）和 agent 写的内容都跟着变，验收说明的三个小标题也按语言检查。终端输出也跟着变（设 `SANDPIPE_LANG=zh\|en` 可以单独指定；没有项目配置时看 `LANG`）。提交信息的语言看 PROJECT.md「提交」一节。onboard 取 `--lang`，没给时按最近的提交信息判断，提交少于 5 条时按项目文档的主要语言（PROJECT.md 草稿会注明是推断的） |
| `maxParallel` | 2 | 同时实现的票数，上限看测试依赖的服务和机器负载 |
| `remote` / `baseBranch` | `origin` / `main` | |
| `mergeMethod` | `rebase` | |
| `mainCheckEvery` | 4 | 按依赖选测试的票每合并几张，对 main 跑一次完整测试 |
| `implementMaxSessions` | 3 | 一张票最多开几次全新的 implement 会话 |
| `reviseMax` | 2 | reviewer 最多打回几次 |
| `contextBudget` | 150000 | 单个会话的上下文预算（token） |
| `agentIdleTimeoutS` | 2400 | agent 多久没输出算卡死 |
| `pollIntervalMs` / `maxIdlePolls` | 10 分钟 / 12 | 调度间隔；连续空转多少次后结束。`Infinity` 表示一直运行（不空闲退出）——守护进程下用它：systemd / launchd 停服务时发 SIGTERM，和 Ctrl-C 一样收尾，退出码 143 |
| `preflight.minFreeGb` | 5 | 磁盘预检的阈值：工作目录和容器存储（podman 的 GraphRoot）的最低剩余空间（GB）。`sandpipe doctor` 各查一行：够 ✓ 写剩余；低于阈值 ✗ 写剩余 / 阈值，fix 给清理命令（`podman image prune`、`podman system prune`、`git worktree prune`）；量不到只 ⚠（比如 macOS 的 podman machine 下 GraphRoot 在虚拟机里，宿主机上量不到）。配置里自定义了 `sandbox` 时不查容器存储。`sandpipe run` 每轮也查，不够时暂停开新会话 |
| `spendLimit.ticketTokens` | 不限 | 单票花费上限（token）：开每个会话之前（implement、review、rebase、re-review、prep 都算）把 `usage.jsonl` 里这张票的全部记录折算成 token 求和——每条记录有 `models`（各模型合计，含子代理）就取它，没有取主行；输入、缓存写、缓存读、输出四项相加（缓存读往往比其他几项大一个数量级，上限要按这个口径设），撞限额的 `limited` 记录、第三方档案的记录同样计入，跨运行、重启后照旧有效。已用 ≥ 上限就不开这个会话：票打 `sandcastle:stuck`，评论写明已用多少、上限多少，提示先调大上限再去掉标签（不调大的话，去掉标签后下一个会话会马上再次停下）；会话中途超出不打断，下一个会话才停；`sandpipe doctor` 显示上限和今日已用 |
| `spendLimit.dayTokens` | 不限 | 当天合计上限（token）：按运行机器的本地日期，把 `usage.jsonl` 里当天的全部记录（全部票、全部阶段，口径同 `spendLimit.ticketTokens`）求和。已用 ≥ 上限就不再开新会话——主循环预检暂停本轮调度（不打 stuck；终端写明当天已用、上限和恢复时间），等下一个会话的票占着空位等到 0 点；正在跑的会话不被打断，做完为止。prep 也不在持着宿主机锁时睡到 0 点：超限时本轮剩余的 prep 跳过。本地 0 点后自动恢复（按日历算下一个本地 0 点，不用 +24h，夏令时切换日也准）；`sandpipe doctor` 显示上限和今日已用 |
| `labels` | 见下 | 改标签名 |
| `sandbox(env)` | podman | 换沙箱实现（`@ai-hero/sandcastle` 的 SandboxProvider）。`env` 要原样传进容器：里面把 Claude 凭据清空，别家档案的会话才读不到 |
| `notify.env` | `SANDPIPE_NOTIFY_WEBHOOK` | 主动通知：存 webhook URL 的 `.sandcastle/.env` 变量名（文件里为空时取宿主机同名环境变量；没配 URL 时什么都不发——URL 不进配置文件、日志和评论，沙箱 env 里清空，agent 拿不到）。票被打 stuck（宿主机打的，或 prep 会话打的——会话结束后查一次标签才知道）、留 PR 给人、main 兜底完整测试失败（main-broken）、一个阶段的全部档案撞上限额进入等待（和限额评论一起去重：同一次等待只发一条，重启后不重复）、prep 撞限额（每个进程一条）、`run` 异常退出时 POST 一条 JSON（`{ text, event, issue, url, reason }`；`text` 是给人看的一行，Slack incoming webhook 直接认；飞书、企业微信、钉钉的群机器人要各自的格式，不兼容）；发送失败（抛错、5xx、429）等 5 秒重试一次，仍失败才打一行警告，不阻塞运行（4xx 不重试；异常退出那条和 `doctor --notify-test` 也不重试）。异常退出那条在进程退出前发（最多等 10 秒），只认默认变量名 `SANDPIPE_NOTIFY_WEBHOOK`：cli 不加载项目配置，自定义了 `notify.env` 的项目异常退出时收不到。`sandpipe doctor` 把它列入检查：配了 URL 时发一次请求看能不能连上（连不上只警告），`sandpipe doctor --notify-test` 改发一条 `test` 事件的测试消息（`--fix` 时不发） |
| `integrity` | 无 | 合并前的一致性检查：`{ name, command(head, baseRef), broken(baseRef) }`。比如检查数据库迁移链有没有分叉：rebase 没有文本冲突，迁移链也可能断 |
| `appendOnlyFiles` | `[]` | 只追加的索引文件。几张票同时追加不算改同一个文件，可以并行 |
| `acceptancePrep(branch)` | 无 | 改了页面的票，PR「验收说明」最前面固定的准备步骤 |
| `browser.pagePaths` | `[]` | 页面文件路径（相对仓库根）的正则数组，如 `[/^app\/routes\//]`；票改到匹配的文件算「改了页面」。onboard 按探测到的前端框架（next、remix / react-router、nuxt / vue、svelte、astro，其它有网页界面的项目按 `src/` 下的 tsx / jsx / vue / svelte / css）写默认值，没有网页界面不写 |
| `protectedPaths` | `[]` | 受保护路径（相对仓库根、不带前导 `/`，和 `git diff --name-only` 的输出一致）的正则数组，如 `[/^\.github\//, /^migrations\//]`。票的最终 diff（review / 打回 / fix 之后）改到命中的文件就不自动合并，留 PR，评论逐条列出「文件 — 命中的规则」；rebase 时 agent 解过冲突的，push 前重取 diff 再查一次。配了规则但取不到 diff 时也留 PR。票的实现指引里写一项 `- **Protected**: \`path\`, \`dir/\``（相对仓库根，`/` 结尾表示目录下所有文件，否则与 diff 里的文件全等）可以放行这些文件：被允许的命中不挡合并，PR 正文多一节 `## Protected paths` 标出来（已有 PR 时出现在更新评论里；rebase 解冲突后新改到的放行文件另发一条评论）。开头的 `./`、`/` 会去掉；因受保护路径留 PR 时，评论会列出一个文件都没匹配上的放行项。`onboard` 按探测结果写默认值：有快照（`__snapshots__/` 或 `.snap`）写 `/(^\|\/)__snapshots__\//`、`/\.snap$/`，有 Playwright 快照目录写 `/-snapshots\//`（有网页界面或探测到 Playwright e2e 的项目即使还没有快照文件也默认写它，见「浏览器验收」一节），有 `.github/workflows/` 写 `/^\.github\/workflows\//`，探测到迁移目录写 `/^<目录>\//`，都没有就不写；`sandpipe doctor` 列出当前的规则。lockfile 不进默认值（加依赖的票都会改它），需要的项目自己加（见 `docs/adr/0003-protected-paths.md`） |
| `trustedAuthors` | `[]` | 额外视为可信的票作者登录名，例如没装成 GitHub App 的机器人账号。票作者是机器人、在这个名单里、或在仓库有 admin / write 权限（maintain 算 write）才算可信；不可信、又没有 `sandcastle:trusted` 的票不 prep、不开工，打 `needs-triage` 并评论一次。评论里的标记（代拍板、评审已过、reprep、限额等待）和 PR 上的 `/sandcastle`、Request changes 也只认可信作者的。agent 在沙箱里读评论只看 `author_association` 是 OWNER / MEMBER / COLLABORATOR 或机器人的，不看这个名单 |
| `beforeSchedule()` | 无 | 每次调度开头在宿主机上跑的维护 |
| `texts` | 通用版 | 自动开的票和内联提示词的正文 |

## 进程守护

无人值守长跑（过夜、周末）时，把 `sandpipe run` 交给进程守护，在跑 worktree 的那台机器上：Linux 用 systemd，macOS 用 launchd。一个项目一个实例——运行锁会让同一项目的第二个实例马上报错退出。配 `maxIdlePolls: Infinity`（见「可选」表）让它不自己退出：默认下连续空转到数就以退出码 0 退出，`Restart=on-failure` 不会拉起，launchd 的 `KeepAlive` 则每次空闲退出都重启一轮。

- **路径与环境**：`WorkingDirectory` 设为项目根。用户 unit / launchd 代理不继承 shell 的环境：`HOME` 要设（gh 和 Claude 的配置在里面），`PATH` 要能找到 `node`、`git`、`gh`、`podman`。跑发版的包——全局安装（`sandpipe run`），或固定版本的 `npx sandpipe@<version> run` / `pnpm dlx sandpipe@<version> run`。
- **重启策略**：systemd 用 `Restart=on-failure` 加 `RestartSec`（重启间隔拉开，环境坏掉时不会疯狂打转）；`KillMode=mixed` 让停服务的 SIGTERM 到主进程，剩下的子进程清掉。失败的重启计入 systemd 的启动限制——长跑的服务把 `StartLimitBurst` 调大。launchd 用 `KeepAlive`。
- **停服务**：`systemctl stop`（或 `launchctl unload`）发 SIGTERM，和 Ctrl-C 一样收尾——列出进行中的会话、释放运行锁、退出码 143——守护自己发起的停止不会再拉起。systemd 默认把退出码 143 当失败（停服务后 unit 显示 `failed`），所以示例里配了 `SuccessExitStatus=143`。`kill -9` 后残留的 `run.lock` 由下次启动接管。
- **日志**：终端输出进 journald（`journalctl --user -u sandpipe.service`）或 launchd 的 `StandardOutPath` / `StandardErrorPath` 文件，后者不会自动轮转——长跑自己配 newsyslog。`.sandcastle/logs/` 下的文件由流水线自己清：`.log` 最后修改超过 14 天就删，`errors.log` 到 10 MB 轮转为 `errors.log.1`；`usage.jsonl` 等数据文件不删。
- **凭据与环境变量**：Claude 凭据照旧放 `.sandcastle/.env`——unit / plist 里不写任何密钥。可选环境变量：`SANDPIPE_LANG`（zh / en，只管终端）、`SANDPIPE_NOTIFY_WEBHOOK`（异常退出那条在 `.sandcastle/.env` 里为空时从宿主机环境变量取）、`SANDCASTLE_ONLY`（逗号分隔票号；守护进程下一般不设）。

示例（systemd 用户 unit，`~/.config/systemd/user/sandpipe.service`；`systemctl --user enable --now sandpipe` 启用——不开 `loginctl enable-linger` 时用户单元登出后跟着停）：

```ini
[Unit]
Description=sandpipe run（我的项目）
# 失败的重启计入 systemd 的启动限制，长跑的服务留出余量
StartLimitBurst=10

[Service]
WorkingDirectory=/path/to/project
# 用户 unit 不继承 shell 的 PATH——node、git、gh、podman 在哪要写全
Environment=PATH=/home/you/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/you
ExecStart=/home/you/.local/share/pnpm/sandpipe run
Restart=on-failure
RestartSec=30
# 停服务的 SIGTERM 到主进程，正常收尾（退出码 143），剩下的子进程清掉
KillMode=mixed
# SIGTERM 后的退出码 143 是正常停止，不算失败
SuccessExitStatus=143

[Install]
WantedBy=default.target
```

示例（launchd 代理，`~/Library/LaunchAgents/com.example.sandpipe.plist`；macOS 上 podman 跑在虚拟机里、开机不会自己起——先 `podman machine start`，或给虚拟机也配一个代理）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.sandpipe</string>
  <key>WorkingDirectory</key>
  <string>/path/to/project</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/sandpipe</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/you</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/sandpipe.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/sandpipe.log</string>
</dict>
</plist>
```

## 模型

每个阶段用哪些档案写在 `.sandcastle/models.json`（每个阶段一个有序的档案列表、撞限额时换下一个，档案带 model、effort、env；当前的选择看 `sandpipe doctor`）。无论哪个档案，沙箱里的每条 claude 命令都关掉了 Claude Code 自带的提交 / PR 署名：`--settings '{"includeCoAuthoredBy":false,"attribution":{"commit":"","pr":""}}'`，优先级高于项目自己的 `.claude/settings.json`，在那里改不回来。提交和 PR 因此不带模型名的 `Co-Authored-By` 署名；不这么做的话，别家档案（把 `opus` 经 `ANTHROPIC_BASE_URL` 转到别家）的提交仍会被署名成 Anthropic 的模型，因为 Claude Code 只看得到别名。各阶段实际用的档案 / 模型记在 PR 正文的 Usage 表里。

## 标签

| 默认名 | 含义 |
|---|---|
| `Sandcastle` | 人工选中，流水线只处理带这个标签的票 |
| `sandcastle:prepped` | prep 已确认可以实现 |
| `sandcastle:pr-open` | 已开 PR，等人审 |
| `sandcastle:reviewed` | 评审已通过、正在跑门槛；运行被中断后，分支没变就直接跑门槛，不重新实现和评审。流水线第一次用到时自己建 |
| `sandcastle:merging` | 已开 PR、门槛已过，在等检查 / 合并；运行被中断后，下次运行接着等，不重新实现。流水线第一次用到时自己建 |
| `sandcastle:stuck` | 需要人介入，原因写在 issue 评论里 |
| `sandcastle:decided` | agent 替人拍板过设计决定，等人事后确认，看过后去掉 |
| `flaky` | 门槛里重跑才通过的测试，流水线自动开票 |
| `sandcastle:main-broken` | main 上的兜底完整测试失败，流水线自动开票，排在最前；开着时其他票不自动合并、留 PR 等修好（ADR 0007） |
| `sandcastle:waiting-main` | 被 main-broken 挡住留 PR 的票；main 修好后自动 rebase、重跑门槛再合并（ADR 0007）。流水线第一次用到时自己建 |
| `ready-for-agent` / `ready-for-human` | 拆票后的分流 |
| `needs-triage` | 票的作者没有写权限，等有写权限的人确认（`labels.needsTriage`）。流水线第一次用到时自己建 |
| `sandcastle:trusted` | 有写权限的人确认过这张票可以交给 Sandcastle（`labels.trusted`；打标签至少要 triage 权限）。流水线第一次用到时自己建 |

`sandpipe doctor --fix` 会建好缺的标签，并按 Containerfile 建好缺的镜像。

镜像构建时把 Containerfile 文件字节的 sha256 记在 `sandpipe.containerfile` label 上。label 与当前 Containerfile 对不上——包括没打过 label 的老镜像——时镜像算过期：`sandpipe doctor` 该项报 ⚠「Containerfile 改过，镜像过期」，`sandpipe doctor --fix` 按当前 Containerfile 重建。`sandpipe run` 启动时发现过期也用 ⚠ 警告一次、不挡运行（镜像不存在时不在这里报）。
