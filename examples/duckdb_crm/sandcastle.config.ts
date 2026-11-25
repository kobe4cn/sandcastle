// duckdb_crm 的 Sandcastle 项目配置：原来写死在 .sandcastle/main.ts 里的项目差异，原文搬过来。
// 放到 duckdb_crm 的 .sandcastle/sandcastle.config.ts 即可（import 路径换成安装好的包名）。

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { defineProject, trySh } from "sandpipe";

// ---------------------------------------------------------------------------
// 测试依赖的服务：宿主机 apple container 里的 PG / MySQL / MongoDB / SeaweedFS，
// 端口发布在宿主机上，podman 容器经 host.containers.internal 访问。
// 连接信息取自宿主机的 .env（S3_*）与 .env.test（TEST_*），把 localhost 换成宿主机地址；
// 每张票的库名 / 前缀再加 `_i<n>`，并行的沙箱互不清表（worker 后缀 `_w<i>` 加在它后面）。
// ---------------------------------------------------------------------------

const HOST_FROM_CONTAINER = "host.containers.internal";
const readEnvFile = (file: string): Record<string, string | undefined> => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {});
const hostEnv = { ...readEnvFile(".env"), ...readEnvFile(".env.test") };
const toContainer = (value: string) => value.replace(/\b(localhost|127\.0\.0\.1)\b/g, HOST_FROM_CONTAINER);
const withDbSuffix = (url: string, suffix: string) => {
  const u = new URL(url);
  u.pathname = `${u.pathname}${suffix}`;
  return u.toString();
};

const SERVICE_KEYS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_URL_STYLE", "S3_USE_SSL"];
const serviceEnv = Object.fromEntries(SERVICE_KEYS.flatMap((k) => (hostEnv[k] ? [[k, toContainer(hostEnv[k])]] : [])));

function testEnv(issueId: string): Record<string, string> {
  const suffix = `_i${issueId}`;
  const env: Record<string, string> = {
    ...serviceEnv,
    TEST_PLATFORM_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_platform_test"), suffix),
    TEST_SOURCE_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_source_test"), suffix),
    // 宿主机 PG 是 pgvector/pgvector:pg17-trixie（db_script/pg_setup.sh），pgvector 契约用例在沙箱里也跑（#850）
    TEST_PGVECTOR_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_vector_test"), suffix),
    // 源端测试账号名按票区分（scripts/test-resource-names.ts 的 CRM_TEST_RUN_SUFFIX），并行的沙箱不共用账号
    CRM_TEST_RUN_SUFFIX: suffix,
    CRM_TEST_WORKERS: "4",
    // 沙箱负载比本地约慢一倍（#439），vitest.config.ts 把 testTimeout / hookTimeout 乘成 180 s / 120 s，超时类偶发失败不再逐文件放宽（#461）
    CRM_TEST_TIMEOUT_SCALE: "2",
  };
  const { TEST_MONGO_URL, TEST_MYSQL_URL, TEST_S3_LAKE_URI } = hostEnv;
  if (TEST_MONGO_URL) env.TEST_MONGO_URL = withDbSuffix(toContainer(TEST_MONGO_URL), suffix);
  if (TEST_MYSQL_URL) env.TEST_MYSQL_URL = withDbSuffix(toContainer(TEST_MYSQL_URL), suffix);
  if (TEST_S3_LAKE_URI) env.TEST_S3_LAKE_URI = TEST_S3_LAKE_URI + suffix;
  return { ...env, ...browserEnv(suffix) };
}

// 关沙箱后回收这张票的测试资源（scripts/drop-test-resources.ts：PG 库与租户角色、PG / MySQL 源端测试账号、MySQL / MongoDB 库、对象存储前缀与账号）。
// 每次关沙箱都收，不等票合并：再跑这张票（revise、rebase）时 global-setup 与夹具会重新建库。
// 在宿主机上跑，连接取自宿主机的 .env / .env.test（不做 host.containers.internal 替换）；异步执行，不卡住并行的另一张票。
// 回收失败只打日志，不影响票的结果；留下的可以之后 `pnpm sandcastle:cleanup --all` 补收。
async function dropTestResources(issueId: string) {
  const args = [
    "--env-file-if-exists=.env",
    "--env-file-if-exists=.env.test",
    "--import",
    "tsx",
    "scripts/drop-test-resources.ts",
    `_i${issueId}`,
  ];
  try {
    const { stdout } = await promisify(execFile)("node", args, { encoding: "utf8" });
    console.log(`  🧹 #${issueId} ${stdout.trim().split("\n").slice(1).join("；")}`);
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    console.warn(
      `  ⚠ #${issueId} 测试资源回收失败（之后可用 pnpm sandcastle:cleanup _i${issueId} 补收）：${(stderr || stdout || String(e)).trim().slice(0, 500)}`,
    );
  }
}

// 本机 seaweedfs 的 filer 元数据日志会一直占卷，卷数到上限后门槛里对象存储全部超时（见 docs/agents/sandcastle.md）。
// 每次调度开头删两天前的日志目录和已清空的整卷；失败只打日志。
function pruneSeaweedMetalog() {
  const r = trySh("scripts/prune-seaweed-metalog.sh", []);
  console.log(r.ok ? `  🧹 ${r.out}` : `  ⚠ 元数据日志清理失败：${r.out.slice(0, 300)}`);
}

// 浏览器验收用的 dev server 与 scripts/browser-lab.ts：独立的平台库（不碰开发库 crm_platform，也不被测试清表）、
// 本地湖目录、固定的测试主密钥、发信打到日志。vitest.config.ts 会为测试覆盖这几个变量，门槛不受影响。
function browserEnv(suffix: string): Record<string, string> {
  return {
    PLATFORM_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_platform_browser"), suffix),
    PLATFORM_LAKE_URI: "/tmp/crm_browser_lake",
    PLATFORM_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    MAILER: "console",
  };
}

// ---------------------------------------------------------------------------
// 合并门槛
// ---------------------------------------------------------------------------

// 失败摘要只取 vitest 的 Failed Tests / Failed Suites 一节（去掉颜色、每行截断），不 grep 日志里的 Error。
// 完整测试在沙箱里要跑 ~40 分钟，负载下个别用例会偶发失败：失败的文件不超过 GATE_RERUN_MAX 个时单独重跑一次，
// 重跑通过算通过，但输出 GATE_FLAKY 让 PR 上标出来。retrieval-golden 的 KNOWN_GAPS 是 it.fails，不影响退出码。
//
// 按依赖选测试（2026-11-24，规则见 docs/agents/sandcastle.md「合并门槛怎么选测试」）：
// - 每次都跑 test/http 全部与 test/ 根目录的单元测试。test/http 的 harness 另起 vite、用 ssrLoadModule 加载整个应用，
//   vitest 的依赖图看不到它和 app/ 的关系（改 workbench-ai.ts 选不到 test/http/workbench.test.ts），所以不能靠依赖图选。
// - test/pipeline 只跑 `vitest related <分支改到的文件>` 选中的，加上分支改到的 pipeline 测试文件本身。
// - 退回完整测试：改到 FULL_PATHS（依赖图看不到的测试基础设施：配置、全局 setup、HTTP harness、迁移、依赖、镜像）；
//   选中的 pipeline 文件超过总数一半（改核心模块时几乎全选，挑着跑省不了多少）；vitest related 失败或超时；GATE_FULL=1。
// - rebase 后重跑也走同一套规则（分支相对新 main 的改动已含冲突文件）；两张票合在一起才出的问题由
//   main 上定期的兜底完整测试发现（见 runMainFullCheck）。
// 输出里有一行 GATE_TIER: full|selected，脚本据此计数、写进 PR。
const GATE_RERUN_MAX = 3;
const FULL_PATHS = String.raw`^(vitest\.config\.ts|vite\.config\.ts|test/global-setup\.ts|test/setup-env\.ts|test/http/harness\.ts|drizzle/|package\.json$|pnpm-lock\.yaml$|\.sandcastle/Containerfile$)`;
const gateSelect = (BASE_REF: string) => String.raw`
changed=$(git diff --name-only "$(git merge-base HEAD ${BASE_REF})" HEAD)
existing=$(printf '%s\n' "$changed" | while read -r f; do [ -n "$f" ] && [ -f "$f" ] && printf '%s ' "$f"; done)
infra=$(printf '%s\n' "$changed" | grep -E '${FULL_PATHS}' | head -5)
total=$(ls test/pipeline/*.test.ts | wc -l | tr -d ' '); limit=$((total / 2))
tier=full; reason=""
if [ "$GATE_FULL" = "1" ]; then reason="GATE_FULL=1"
elif [ -n "$infra" ]; then reason="改到依赖图看不到的测试基础设施：$(echo $infra)"
else
  picked=""
  if [ -n "$existing" ]; then
    if timeout 300 npx vitest related $existing --run --passWithNoTests --reporter=verbose --testNamePattern=__gate_select_none__ > /tmp/gate-related.log 2>&1; then
      picked=$(plain /tmp/gate-related.log | grep -oE 'test/pipeline/[^ ]+\.test\.ts' | sort -u)
    else reason="vitest related 失败或超时（见 /tmp/gate-related.log）"
    fi
  fi
  if [ -z "$reason" ]; then
    picked=$(printf '%s\n%s\n' "$picked" "$(printf '%s\n' "$changed" | grep -E '^test/pipeline/.+\.test\.ts$' | while read -r f; do [ -f "$f" ] && echo "$f"; done)" | grep . | sort -u)
    n=$(printf '%s\n' "$picked" | grep -c .)
    if [ "$n" -gt "$limit" ]; then reason="依赖图选中 $n 个 pipeline 测试文件，超过总数 $total 的一半"
    else tier=selected
    fi
  fi
fi
`;
const gateScript = (BASE_REF: string) => String.raw`
plain() { sed 's/\[[0-9;]*m//g' "$1"; }
failures() { plain "$1" | sed -n '/Failed \(Tests\|Suites\)/,/Test Files/p' | grep -v 'Test Files' | cut -c1-300 | head -80; }
totals() { plain "$1" | grep -E "Test Files|Tests " | tail -2; }
${gateSelect(BASE_REF)}
unit=$(ls test/*.test.ts test/*.test.tsx 2>/dev/null | tr '\n' ' ')
if [ "$tier" = selected ]; then
  echo "GATE_TIER: selected（test/http 全部、test/ 根目录单元测试，加 test/pipeline 里依赖图选中的 $n / $total 个）"
  [ -n "$picked" ] && printf '%s\n' "$picked" | sed 's/^/  /'
  testcmd="npx vitest run test/http $(echo $picked)"
else
  echo "GATE_TIER: full（$reason）"
  testcmd="npx vitest run test/http test/pipeline"
fi
# 跑一段测试：通过返回 0；失败文件不超过 GATE_RERUN_MAX 个时单独重跑一次，重跑通过记 GATE_FLAKY
stage() {
  log=$1; shift
  "$@" > $log 2>&1 && { totals $log; return 0; }
  files=$(plain $log | grep -oE "FAIL +test/[^ ]+\.test\.tsx?" | awk '{print $2}' | sort -u)
  count=$(printf '%s
' "$files" | grep -c .)
  if [ "$count" -eq 0 ] || [ "$count" -gt ${GATE_RERUN_MAX} ]; then
    echo "测试失败（失败文件 $count 个，不重跑）："; failures $log; totals $log; return 1
  fi
  echo "测试有 $count 个文件失败，单独重跑一次："; echo "$files"
  npx vitest run $files > $log.rerun 2>&1 || { echo "重跑仍失败："; failures $log.rerun; totals $log.rerun; return 1; }
  echo "GATE_FLAKY: 重跑通过。第一次的失败："; failures $log; totals $log
}
npm run typecheck > /tmp/gate-typecheck.log 2>&1 || { plain /tmp/gate-typecheck.log | tail -40; exit 1; }
# 先跑 test/ 根目录的单元测试（约 1–2 分钟）：i18n 棘轮这类几秒就能报的失败不用等 40 分钟的完整测试
if [ -n "$unit" ]; then
  echo "单元测试（test/ 根目录）："
  stage /tmp/gate-unit.log npx vitest run $unit || exit 1
fi
stage /tmp/gate-test.log $testcmd || exit 1
`;

// 排上队的门槛独占一份连接预算，用 8 个 worker（约 300 个连接）；agent 自己在另一个沙箱跑测试仍是 4 个
// worker（约 150 个），所以宿主机 PG 要 max_connections ≥ 600（db_script/pg_setup.sh）。
const GATE_WORKERS = "8";

// 仓库用 pnpm（package.json 的 packageManager）。拷进来的 node_modules 是宿主机 darwin 的，
// 缺 linux 原生包（rolldown、typescript-go），npm install 补不上，要用 pnpm 按锁文件重装。
const PNPM = JSON.parse(readFileSync("package.json", "utf8")).packageManager as string;

// drizzle 迁移按目录排序、靠 snapshot.json 的 prevIds 串成链。两张票各生成一个迁移时 rebase 没有文本冲突，
// 但链分叉了：本票加的第一个迁移的 prevIds 必须含 origin/main 最新迁移的 id，否则要重新生成。
const migrationChainOk = (head: string, BASE_REF: string) =>
  [
    `MIG=$(git diff --name-only --diff-filter=A ${BASE_REF}...${head} -- 'drizzle/*/snapshot.json' | sort | head -1)`,
    '[ -z "$MIG" ] && exit 0',
    `LATEST=$(git ls-tree --name-only ${BASE_REF} drizzle/ | sort | tail -1)`,
    `ID=$(git show ${BASE_REF}:$LATEST/snapshot.json | jq -r .id)`,
    `git show ${head}:$MIG | jq -e --arg id "$ID" '.prevIds | index($id)' > /dev/null`,
  ].join("; ");

export default defineProject({
  // 同时实现的票数：受 PG max_connections 与机器负载限制；3 个门槛同时跑完整测试会大面积超时（2026-11-07）
  maxParallel: 2,
  // 门槛失败后的 fix 会话要在后台重跑一批慢测试（单个文件就要 5 分钟以上），10 分钟就被判卡死（2026-11-23 #1141、#1160）。
  agentIdleTimeoutS: 40 * 60,
  install: {
    onSandboxReady: `npx -y ${PNPM} install --frozen-lockfile`,
    copyToWorktree: ["node_modules"],
  },
  isolation: {
    env: testEnv,
    cleanup: dropTestResources,
  },
  beforeSchedule: pruneSeaweedMetalog,
  gate: {
    script: ({ baseRef }) => gateScript(baseRef),
    env: { CRM_TEST_WORKERS: GATE_WORKERS },
    testFile: /test\/\S+\.test\.tsx?/,
    rerunMax: GATE_RERUN_MAX,
    typecheck: "npm run typecheck",
    selectedDescription: "按依赖选的测试（test/http 与单元测试全跑，test/pipeline 只跑依赖图选中的）",
  },
  // drizzle 迁移按目录排序、靠 snapshot.json 的 prevIds 串成链。
  integrity: {
    name: "迁移链",
    command: migrationChainOk,
    broken: (baseRef) => `本票的 drizzle 迁移没有接在 ${baseRef} 最新的迁移后面`,
  },
  // 只追加的索引文件：几张票同时往末尾追加行也不会真冲突（2026-11 #732）。
  // 翻译表 app/i18n/en.*.json 按键增加，几乎每张双语票都改，算追加型文件，双语票才能两张并行（2026-11-22）。
  // 中文棘轮基线：每张双语票按文件下调计数，冲突时 rebase 用 `npm run i18n:ratchet -- --update` 重算（2026-11-22）。
  appendOnlyFiles: [
    "test/CATALOG.md",
    "test/README.md",
    "CONTEXT.md",
    "docs/adr/README.md",
    "app/i18n/en.client.json",
    "app/i18n/en.server.json",
    "test/i18n-ratchet-baseline.json",
  ],
  acceptancePrep: (branch) =>
    [
      "### 准备（在宿主机上，连开发库 `crm_platform`）",
      "",
      `1. \`git checkout ${branch}\``,
      "2. 起 dev server：`MAILER=console npm run dev`（Magic Link 登录链接会打印在它的终端里）",
      "3. 建验收数据：`PLATFORM_DATABASE_URL` 指向开发库 `crm_platform` 跑 `node --import tsx scripts/browser-lab.ts`——对 `crm_platform` 跑迁移，建租户 `crmlab-smoke` 和成员 `admin@` / `eng@` / `an@crmlab-smoke.test`（可重复跑）",
      "4. 打开 `http://localhost:5173/login`，填上面的邮箱点「发送登录链接」，从 dev server 的终端里取链接登录",
    ].join("\n"),
  texts: {
    revisePrompt: ({ issueId, branch, title, items }) =>
      [
        `分支 ${branch}（issue #${issueId}：${title}）的 review 打回了，修改意见如下。`,
        "",
        items,
        "",
        `先 \`gh issue view ${issueId}\` 看验收标准，再逐条处理上面的意见。遵守 CLAUDE.md 的「Context budget」：从意见给的 file:line 出发，grep -n 定位，不要广泛探索。`,
        "改行为的意见先写或改测试（跑红再跑绿）。只跑改到的测试文件（`npx vitest run <file>`）和 `npm run typecheck`，不要跑完整测试。",
        `每条意见处理完提交一次，按仓库风格写中文提交信息、末尾 (#${issueId})。`,
        "某条意见你判断不该改（与票冲突、要人拍板），不要改，在输出里写明哪条、为什么。",
        `除了本票（issue #${issueId}）和本次会话里自己新开的 issue，不要改其他 issue 的标签或正文（评论除外）；本次会话之前开出的票（包括本票早先会话开的）也不能改。`,
        "最后输出 <promise>COMPLETE</promise>。",
      ].join("\n"),
    fixPrompt: ({ issueId, branch, gateOutput, rerunMax }) =>
      [
        `分支 ${branch}（issue #${issueId}）在合并门槛上失败，摘要如下；完整日志在 /tmp/gate-typecheck.log、/tmp/gate-unit.log（test/ 根目录单元测试，先跑）、/tmp/gate-test.log，重跑的在同名加 .rerun（用 grep 看，不要整读）。测试失败的文件不超过 ${rerunMax} 个时已经单独重跑过一次，仍失败才到你这里。`,
        "```",
        gateOutput,
        "```",
        "只修这些失败：用 `npx vitest run <file>` 跑失败的文件确认变绿，按仓库风格写中文提交信息、末尾 (#" + issueId + ")。",
        "如果失败与本票改动无关（偶发、环境问题）或不能确定怎么修，不要改代码，在输出里说明原因。",
        `除了本票（issue #${issueId}）和本次会话里自己新开的 issue，不要改其他 issue 的标签或正文（评论除外）；本次会话之前开出的票（包括本票早先会话开的）也不能改。`,
        "最后输出 <promise>COMPLETE</promise>。",
      ].join("\n"),
    flakyIssueBody: ({ files, seen, env, prior, summary }) => {
      const list = files.map((f) => `\`${f}\``).join("、");
      return [
        `${list} 在 ${seen}的完整测试里失败，单独重跑通过。沙箱里门槛的完整测试用 8 个 worker 并行（\`CRM_TEST_WORKERS=8\`，同一时间只跑一个），agent 自己跑测试用 4 个。`,
        "",
        env,
        ...(prior ? ["", prior] : []),
        "",
        "## 第一次的失败",
        "",
        summary,
        "",
        "## 怎么修",
        "",
        "按诊断难 bug 的做法：先有一条能让它稳定变红的命令，再改。",
        "",
        "- 先读失败摘要判断类型：超时（hook / 用例在负载下变慢）、随机数据撞上断言、用例之间共享状态或顺序依赖、外部服务连接。",
        '- 先查同样的报错是不是已经修过：`gh issue list --label flaky --state closed --search "<报错关键句>"`，再 `git log --oneline -S` / `--grep` 找对应提交。已经修过（失败的分支早于那个提交）就不用复现，提交信息写明是哪个提交修的、依据是什么。',
        "- 复现：要的是一条修复前变红、修复后变绿的命令。超时、随机数据类可以单跑这个文件，或和重夹具文件一起跑、在后台占满 CPU 再跑；跨进程 / 跨沙箱的竞争（共用的 PG 角色、库、对象等）单跑复现不了，照 #439 写一个并发用例让它稳定变红。重复单跑只作补充，总共不超过 20 分钟。复现不了就照摘要从代码推断原因，并在提交信息里写明推断依据。",
        "- 沙箱里全局超时已是 180 s / 120 s（`CRM_TEST_TIMEOUT_SCALE=2`），再超时先查是否真卡住，不要只是继续放宽。",
        "- 超时类：确认是负载下变慢才给单个 hook / 用例放宽超时（照 2bcb07a 的写法），不改全局配置。随机数据类：改断言或数据，让它不可能撞上。",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] 失败原因写进提交信息（复现命令，或推断的依据）",
        `- [ ] 修复后复现命令变绿、${list} 单跑通过（重复单跑总共不超过 20 分钟）；根因已被别的提交修掉时只核实、不改代码`,
        "- [ ] 不放宽全局超时，不删除或改弱断言",
      ].join("\n");
    },
    mainBrokenIssueBody: ({ sha, summary, commits }) =>
      [
        `Sandcastle 在 main 的 \`${sha}\` 上跑兜底完整测试（\`GATE_FULL=1\`，8 个 worker），没通过。`,
        "按依赖选测试的票只跑 test/http、test/ 根目录单元测试和依赖图选中的 test/pipeline 文件；这里失败说明要么依赖图漏选了，要么两张各自通过的票合在一起才出问题。",
        "",
        "## 失败摘要",
        "",
        summary,
        "",
        "## 上次兜底通过以来进 main 的提交",
        "",
        "```",
        commits.slice(0, 4000),
        "```",
        "",
        "## 怎么修",
        "",
        "- 先在 main 上单跑失败的文件确认能稳定复现；复现不了就按偶发失败处理（照 `flaky` 票的做法），在评论里写明。",
        "- 用上面的提交列表缩小范围（`git bisect run npx vitest run <失败的文件>`），找到引入问题的提交，修掉并补能锁住它的用例。",
        "- 如果是依赖图看不到的依赖导致漏选（某个文件改了、测试却没被选中），在评论里写明是哪个文件，交给人加进 `.sandcastle/sandcastle.config.ts` 的 `FULL_PATHS`。",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] 失败的测试文件在 main 上单跑通过；原因（哪个提交引入、为什么）写进提交信息",
        "- [ ] 不放宽全局超时，不删除或改弱断言",
        "- [ ] 是不是依赖图漏选导致的，在 issue 评论里写明结论",
      ].join("\n"),
  },
});
