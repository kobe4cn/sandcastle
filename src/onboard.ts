// sandpipe onboard：把 Sandcastle 装进一个新项目（在项目根目录运行）。
// sandpipe onboard: install Sandcastle into a new project (run in the project root).
//
// 1. 探测（detect.ts，只读文件和 git）：语言、包管理、命令、托管平台、文档、测试、迁移、依赖的服务。
//    Detect (detect.ts, reads files and git only): language, package manager, commands, forge, docs, tests, migrations, services.
// 2. 生成文件，.sandcastle/ 下已存在的一律跳过、不覆盖；.claude/ 下本工具的文件已存在且和模板不同时，问保留 / 覆盖 / 另存 .new（claude-conflict.ts）。
//    注释都是中英两行；PROJECT.md 草稿和配置的 language 按 --lang（没给时按提交信息的语言）：
//    Generate files, skipping existing ones under .sandcastle/; for this tool's .claude/ files that exist but differ from the template, ask keep / overwrite / save as .new (claude-conflict.ts).
//    Comments are always a Chinese line plus an English line; the PROJECT.md draft and the config's language follow --lang (default: the commit message language):
//      .sandcastle/sandcastle.config.ts  怎么跑（安装、隔离、门槛） / how to run (install, isolation, gate)
//      .sandcastle/PROJECT.md            项目知识草稿 / project knowledge draft
//      .sandcastle/models.json、.env.example、.gitignore、Containerfile
//      .claude/ 下的 hook、子代理、skills（CLAUDE_FILES，给 agent 看，只有一种语言），并在 .claude/settings.json 里登记 hook
//      the hook, subagent and skills under .claude/ (CLAUDE_FILES, agent-facing, one language only), registering the hook in .claude/settings.json
// 3. 补全 PROJECT.md（默认开，--no-agent 跳过）：宿主机上跑一次 claude -p，读代码把草稿写完整，拿不准的写进缺口清单 OPEN-QUESTIONS.md；
//    只许改这两个文件（清单已存在时只许改 PROJECT.md）；写完按 parseProjectDoc 和 parseOpenQuestions 校验。
//    claude 用的是本机 Claude Code 登录的账号（和 .env 里的 token 无关）；stderr 和笔记全文只在 --verbose 打（stderr 按行加 [claude] 前缀），
//    失败时把退出码和 stderr 末尾几行单独写成醒目的警告。
//    Complete PROJECT.md (on by default, --no-agent skips it): one claude -p on the host reads the code, finishes the draft and puts open points into OPEN-QUESTIONS.md;
//    it may edit only those two files (only PROJECT.md if the list already exists); then validated with parseProjectDoc and parseOpenQuestions.
//    claude runs under the local Claude Code login (unrelated to the token in .env); stderr and the full notes print only under --verbose (stderr line-prefixed with [claude]),
//    and failures get the exit code and the last stderr lines as their own prominent warning.
// 4. 终端输出按阶段收成摘要（探测、文件、agent、校验各一到两行，detectSummary / filesSummary / validationSummary，agent 段是 agentStartHint 开始行加 agentDoneLine 完成行）；--verbose 打完整明细。
//    要人处理的（另存为 .new 的冲突文件、PROJECT.md 校验失败、agent 失败、GitLab 警告）永远单独成醒目的一行，不被计数收掉。
//    Terminal output is summarized per stage (detection, files, agent, validation, one to two lines each: detectSummary / filesSummary / validationSummary, the agent stage being agentStartHint's start line plus agentDoneLine's done line); --verbose prints the full details.
//    Things needing a human (a conflict file saved as .new, a PROJECT.md validation failure, an agent failure, the GitLab warning) always get their own prominent line and are never folded into the counts.

import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/podman";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askChoice, type ClaudeResolution, type Decide, resolveClaudeFile } from "./claude-conflict.ts";
import { detectProject, type ProjectFacts, type ServiceEnvKey } from "./detect.ts";
import type { Language } from "./i18n.ts";
import { DEFAULT_LABELS } from "./profile.ts";
import { OPEN_QUESTIONS, readOpenQuestions, unknownSectionTargets } from "./open-questions.ts";
import { parseProjectDoc, SECTIONS, SECTIONS_EN } from "./project-doc.ts";
import { setTermLanguage, t, termLanguage } from "./term.ts";
import { RELEASES_REPO } from "./version.ts";

export const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HOOK_FILE = "sandcastle-context.mjs";

// ---------------------------------------------------------------------------
// 生成内容（纯函数，便于测试） / Generated content (pure functions, easy to test)
// ---------------------------------------------------------------------------

const q = (s: string) => JSON.stringify(s);
/** 按语言二选一（PROJECT.md 草稿正文、终端以外的单语内容）。 / Pick by language (PROJECT.md draft body and other single-language content). */
const pick = (lang: Language) => (zh: string, en: string) => (lang === "en" ? en : zh);
/** 生成文件里的注释：中文一行、英文一行。 / Comments in generated files: one Chinese line, one English line. */
/** 正则源码写成配置里的字面量（/.../） / Regex sources as literals for the config (/.../) */
const regexLiterals = (sources: string[]) => sources.map((p) => String(new RegExp(p)));
const note = (indent: string, zh: string, en: string) => [`${indent}// ${zh}`, `${indent}// ${en}`];

/** 用户手册在工具里的路径，按语言选中文版或英文版。 / Path of a user manual in the tool, Chinese or English copy by language. */
export const manual = (name: "config" | "onboarding-checklist", lang: Language) => `docs/${name}${lang === "en" ? "" : ".zh-CN"}.md`;

/**
 * env 文件里没扫到时的兜底：探测到的服务 → 按惯例的键名；perTicketDb 表示要加库名后缀（每张票独立的库），否则只换主机。
 * Fallback when the env files yield nothing: detected service → conventional key; perTicketDb means add a database-name suffix (one database per ticket), otherwise only swap the host.
 */
const SERVICE_ENV_KEYS: Record<string, ServiceEnvKey> = {
  postgres: { key: "DATABASE_URL", perTicketDb: true },
  mysql: { key: "DATABASE_URL", perTicketDb: true },
  mongodb: { key: "MONGODB_URI", perTicketDb: true },
  redis: { key: "REDIS_URL", perTicketDb: false },
  s3: { key: "S3_ENDPOINT", perTicketDb: false },
  elasticsearch: { key: "ELASTICSEARCH_URL", perTicketDb: false },
  rabbitmq: { key: "RABBITMQ_URL", perTicketDb: false },
  kafka: { key: "KAFKA_BROKERS", perTicketDb: false },
  clickhouse: { key: "CLICKHOUSE_URL", perTicketDb: false },
};

/**
 * 按服务顺序猜键名；惯例键名已被前面的服务占用时（postgres 和 mysql 都是 DATABASE_URL）改用 <服务>_URL，不丢服务。
 * Guess keys in service order; when the conventional key is already taken (postgres and mysql both use DATABASE_URL), use <SERVICE>_URL so no service is dropped.
 */
const guessServiceEnv = (services: string[]) =>
  services.reduce<ServiceEnvKey[]>((keys, s) => {
    const k = SERVICE_ENV_KEYS[s];
    if (!k) return keys;
    return [...keys, keys.some((x) => x.key === k.key) ? { ...k, key: `${s.toUpperCase()}_URL` } : k];
  }, []);

/** 生成代码里取 env 的属性：合法标识符用点，否则用方括号。 / Property access in generated code: dot for valid identifiers, brackets otherwise. */
const prop = (obj: string, key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${obj}.${key}` : `${obj}[${q(key)}]`);

export function configSource(f: ProjectFacts, importFrom: string, lang: Language = f.commitLanguage): string {
  const gateSteps = [f.commands.typecheck, f.commands.lint, f.commands.test].filter(Boolean) as string[];
  const gate = gateSteps.length ? gateSteps.join(" && ") : "echo 'gate.script not configured / 门槛还没配：.sandcastle/sandcastle.config.ts' && exit 1";
  const forgeLine =
    f.forge.kind === "gitlab"
      ? note("  ", "forge: gitlabForge(),  远端是 GitLab：GitLab Forge 还没做，接入前先别跑", "forge: gitlabForge(),  the remote is GitLab: the GitLab forge isn't done yet, don't run it")
      : note("  ", "forge: githubForge(),  默认 GitHub（宿主机的 gh）", "forge: githubForge(),  GitHub by default (the host's gh)");
  const scanned = f.serviceEnv.length > 0;
  const keys = scanned ? f.serviceEnv : guessServiceEnv(f.services);
  const listed = keys.map((k) => k.key);
  const isolation = keys.length
    ? [
        "  isolation: {",
        ...(scanned
          ? note(
              "    ",
              `从 ${f.serviceEnvFrom.join("、")} 里找到指向本机服务的变量：${listed.join("、")}。少了的照着加一行，不该进沙箱的删掉。`,
              `Variables pointing at local services found in ${f.serviceEnvFrom.join(", ")}: ${listed.join(", ")}. Add a line for any that are missing; delete any that shouldn't reach the sandbox.`,
            )
          : note(
              "    ",
              `探测到 docker compose 里的服务：${f.services.join("、")}，env 文件里没找到连接串，下面的键名是按惯例猜的，改成项目实际用的（看代码里读的变量），有几个库、几个中间件就写几行。`,
              `Services found in docker compose: ${f.services.join(", ")}. No connection strings were found in env files, so the key names below are guesses by convention; change them to what the project actually uses (see the variables the code reads), one line per database or middleware.`,
            )),
        ...note(
          "    ",
          "每次运行从项目根的 .env 读这些变量，localhost 换成 host.containers.internal（沙箱经它访问宿主机），数据库各自加 _i<runId> 后缀，并行的沙箱才不会互相清表；URL 没写库名时 withDbSuffix 会报错，宁可停下也不让测试打到开发库。",
          "Each run reads these from the project root's .env, swaps localhost for host.containers.internal (how the sandbox reaches the host) and adds an _i<runId> suffix to each database so parallel sandboxes don't wipe each other's tables. withDbSuffix throws when a URL has no database name, so tests stop rather than hit the dev database.",
        ),
        "    env: (runId) => {",
        '      const host = readHostEnv(".env");',
        "      const suffix = `_i${runId}`;",
        "      const env: Record<string, string> = { SANDCASTLE_RUN_ID: runId };",
        ...keys.map(({ key, perTicketDb }) => {
          const [h, e] = [prop("host", key), prop("env", key)];
          return perTicketDb ? `      if (${h}) ${e} = withDbSuffix(toContainerHost(${h}), suffix);` : `      if (${h}) ${e} = toContainerHost(${h});`;
        }),
        "      return env;",
        "    },",
        ...note(
          "    ",
          "关沙箱后删掉这张票的测试库：在宿主机上跑回收脚本（失败只警告），用时从 sandpipe 再 import runHostScript。例：",
          "Drop this ticket's test database after the sandbox closes: run a cleanup script on the host (failures only warn); import runHostScript from sandpipe when you use it. E.g.:",
        ),
        '    //   cleanup: async (runId) => { await runHostScript("node", ["scripts/drop-test-db.ts", `_i${runId}`], `#${runId} drop test db`); },',
        "  },",
      ]
    : [
        "  isolation: {",
        "    env: (runId) => ({",
        ...note(
          "      ",
          "测试依赖外部服务（数据库、缓存、对象存储）时，在这里给每张票独立的库名 / 前缀（加 runId）。",
          "If tests use external services (database, cache, object storage), give each ticket its own database name / prefix here (add runId).",
        ),
        "      SANDCASTLE_RUN_ID: runId,",
        "    }),",
        ...note("    ", "cleanup: async (runId) => { /* 关沙箱后删掉这张票的测试库 */ },", "cleanup: async (runId) => { /* drop this ticket's test database after the sandbox closes */ },"),
        "  },",
      ];
  const imports = keys.length ? "defineProject, readHostEnv, toContainerHost, withDbSuffix" : "defineProject";
  return [
    ...note("", "Sandcastle 项目配置：编排脚本里随项目变的部分（由 sandpipe onboard 生成，按需修改）。", "Sandcastle project config: the project-specific part of the pipeline (generated by sandpipe onboard, edit as needed)."),
    ...note("", "字段说明见 sandpipe 的 docs/config.zh-CN.md。", "Fields are described in sandpipe's docs/config.md."),
    `import { ${imports} } from ${q(importFrom)};`,
    "",
    "export default defineProject({",
    ...forgeLine,
    ...(f.remote !== "origin" ? [`  remote: ${q(f.remote)},`] : []),
    ...(f.baseBranch !== "main" ? [`  baseBranch: ${q(f.baseBranch)},`] : []),
    ...note("  ", "issue、PR、评论和终端输出用什么语言（\"zh\" / \"en\"）", "Language for issues, PRs, comments and terminal output (\"zh\" / \"en\")"),
    `  language: ${q(lang)},`,
    ...note(
      "  ",
      "试跑期：只开 PR 不合并、一次一张。按 docs/onboarding-checklist.zh-CN.md 走完前几张票再打开自动合并、调高并行数。",
      "Trial period: open PRs without merging, one ticket at a time. Follow docs/onboarding-checklist.md through the first few tickets before enabling auto-merge and raising parallelism.",
    ),
    "  autoMerge: false,",
    ...note("  ", "同时实现几张票：受测试依赖的服务（连接数）与机器负载限制", "How many tickets to implement at once: limited by the services the tests use (connections) and machine load"),
    "  maxParallel: 1,",
    "",
    "  install: {",
    ...note("    ", "沙箱建好后装依赖（容器是 linux，宿主机拷进来的原生包可能用不了）", "Install dependencies once the sandbox is ready (the container is linux; native packages copied from the host may not work)"),
    `    onSandboxReady: ${q(f.install)},`,
    ...(f.copyToWorktree.length ? [`    copyToWorktree: ${JSON.stringify(f.copyToWorktree)},`] : []),
    "  },",
    "",
    ...isolation,
    "",
    "  gate: {",
    ...note(
      "    ",
      "合并门槛：退出码 0 算通过。输出约定（GATE_TIER / GATE_FLAKY，可以不用）见 docs/config.zh-CN.md。",
      "Merge gate: exit code 0 means pass. Output conventions (GATE_TIER / GATE_FLAKY, optional) are in docs/config.md.",
    ),
    `    script: () => ${q(gate)},`,
    `    testFile: /${f.testFilePattern.replace(/\//g, "\\/")}/,`,
    `    typecheck: ${q(f.commands.typecheck ?? f.commands.lint ?? "true")},`,
    "  },",
    "",
    ...(f.migrations
      ? [
          ...note(
            "  ",
            `迁移（${f.migrations.tool}，${f.migrations.dir}/）：两张票各加一个迁移时 rebase 没有文本冲突也可能分叉，可以配 integrity 在合并前检查（比如迁移链是否接在 main 最新的迁移之后）。`,
            `Migrations (${f.migrations.tool}, ${f.migrations.dir}/): when two tickets each add one, the chain can fork without a text conflict on rebase; set integrity to check before merging (e.g. that the chain follows main's latest migration).`,
          ),
          "",
        ]
      : []),
    ...(f.pagePaths.length
      ? [
          ...note(
            "  ",
            "页面文件的路径（按探测到的前端框架给的默认值，按项目实际目录改）：票改到这些文件就算「改了页面」，要做浏览器验收。",
            "Page file paths (defaults for the detected frontend framework; adjust to the project's real layout): a ticket touching these counts as \"changing pages\" and needs a browser check.",
          ),
          `  browser: { pagePaths: [${regexLiterals(f.pagePaths).join(", ")}] },`,
          "",
        ]
      : []),
    ...(f.protectedPaths.length
      ? [
          ...note(
            "  ",
            "受保护路径（按探测结果给的默认值：快照、CI workflow、迁移目录……）：票改到命中的文件就不自动合并，留 PR 给人看。lockfile 等需要的自己加，见 sandpipe 的 docs/config.zh-CN.md。",
            "Protected paths (defaults from what was detected: snapshots, CI workflows, migration directory…): a ticket touching a matching file isn't auto-merged; the PR is left for a human. Add lockfiles etc. yourself if needed, see sandpipe's docs/config.md.",
          ),
          `  protectedPaths: [${regexLiterals(f.protectedPaths).join(", ")}],`,
          "",
        ]
      : []),
    ...note(
      "  ",
      "几张票会同时往末尾追加的索引文件（CHANGELOG、测试目录……），列在这里的不算「改同一个文件」，可以并行。",
      "Index files several tickets append to at once (CHANGELOG, test catalog…); files listed here don't count as \"changing the same file\", so those tickets can run in parallel.",
    ),
    "  appendOnlyFiles: [],",
    "});",
    "",
  ].join("\n");
}

const bullet = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

/** 草稿里还没写完的地方用这个开头（doctor 按它数）。 / Marker for unfinished parts of the draft (doctor counts these). */
export const TODO_MARK = /<!--\s*(待补|TODO)/g;

/**
 * PROJECT.md 草稿：探测得到的事实先填上，其余留注释给 agent / 人补。英文项目用英文章节标题。
 * PROJECT.md draft: detected facts filled in, the rest left as comments for the agent or a human. English projects get English section titles.
 */
export function projectDocDraft(f: ProjectFacts, lang: Language = f.commitLanguage): string {
  const L = pick(lang);
  const h = (key: keyof typeof SECTIONS) => `## ${lang === "en" ? SECTIONS_EN[key] : SECTIONS[key]}`;
  const todo = (zh: string, en: string) => L(`<!-- 待补：${zh} -->`, `<!-- TODO: ${en} -->`);
  const list = (items: string[]) => items.join(L("、", ", "));
  const c = f.commands;
  const cmdLines = [
    c.typecheck && L(`类型检查：\`${c.typecheck}\``, `Type check: \`${c.typecheck}\``),
    c.lint && `lint${L("：", ": ")}\`${c.lint}\``,
    c.testFile && L(`跑单个测试文件：\`${c.testFile}\``, `Run one test file: \`${c.testFile}\``),
    c.format && L(`格式化：\`${c.format}\``, `Format: \`${c.format}\``),
  ].filter(Boolean) as string[];
  const docLines = f.docs.filter((d) => !/^README\.md$/.test(d)).map((d) => `\`${d}\``);
  const commitLang = f.commitLanguage === "zh" ? L("中文", "Chinese") : L("英文", "English");
  const n = f.recentCommits.length; // 提交历史条数 / Number of commits in the history
  const history = n === 0 ? L("还没有提交", "There are no commits yet") : L(`提交历史只有 ${n} 条`, `The history has only ${n} commit${n === 1 ? "" : "s"}`);
  const commitBasisNote = {
    commits: undefined,
    docs: L(`${history}，提交语言按项目文档的主要语言推断。`, `${history}; the commit language was inferred from the project docs.`),
    lang: L(`${history}，提交语言按 \`--lang\` 推断。`, `${history}; the commit language was inferred from \`--lang\`.`),
    "few-commits":
      n === 0
        ? L(`${history}，提交语言没法判断，先按英文写。`, `${history}, so the commit language couldn't be judged; English for now.`)
        : L(`${history}，提交语言按这几条推断，可能不准。`, `${history}; the commit language was inferred from these few commits and may be wrong.`),
  }[f.commitLanguageBasis];
  const sections = [
    L(`# PROJECT.md（${f.name}）`, `# PROJECT.md (${f.name})`),
    "",
    L(
      "<!-- 由 sandpipe onboard 生成的草稿。章节规则见 sandpipe 的 templates/.sandcastle/PROJECT.md。 -->",
      "<!-- Draft generated by sandpipe onboard. Section rules are in sandpipe's templates/.sandcastle/PROJECT.md. -->",
    ),
    "",
    h("overview"),
    "",
    todo("这是什么项目、给谁用；入口在哪。", "what this project is, who uses it, where the entry points are."),
    "",
    bullet([
      L(`语言：${f.language}${f.packageManager ? `（包管理 ${f.packageManager}）` : ""}`, `Language: ${f.language}${f.packageManager ? ` (package manager ${f.packageManager})` : ""}`),
      `${L("顶层目录：", "Top-level directories: ")}${list(f.topDirs.map((d) => `\`${d}/\``)) || L("（无）", "(none)")}`,
    ]),
    "",
    ...(f.services.length
      ? [
          h("environment"),
          "",
          L(`测试依赖的服务：${list(f.services)}。连接已经由环境变量配好，不要改连接配置。`, `Services the tests use: ${list(f.services)}. Connections are already configured via environment variables; don't change them.`),
          "",
        ]
      : []),
    h("commands"),
    "",
    cmdLines.length ? bullet(cmdLines) : todo("类型检查、lint、跑单个测试文件的命令", "commands for type checking, lint, and running one test file"),
    "",
    h("testing"),
    "",
    f.testDirs.length
      ? bullet([L(`测试在 ${list(f.testDirs.map((d) => `\`${d}/\``))}`, `Tests live in ${list(f.testDirs.map((d) => `\`${d}/\``))}`)])
      : todo("测试放哪、用什么框架", "where tests live and which framework"),
    "",
    ...(docLines.length ? [h("domain"), "", bullet([`${L("先读：", "Read first: ")}${list(docLines)}`]), ""] : []),
    ...(f.migrations
      ? [
          h("conflicts"),
          "",
          bullet([
            L(
              `${f.migrations.tool} 迁移（\`${f.migrations.dir}/\`）冲突时不要手工合并，rebase 结束后删掉本票的迁移重新生成。`,
              `Don't merge ${f.migrations.tool} migration (\`${f.migrations.dir}/\`) conflicts by hand: after the rebase, delete this ticket's migrations and regenerate them.`,
            ),
          ]),
          "",
        ]
      : []),
    h("commit"),
    "",
    bullet([
      L(
        `按仓库现有风格写${commitLang}提交信息（看 \`git log -n 3 --format=%B ${f.remote}/${f.baseBranch}\`）。`,
        `Write commit messages in ${commitLang}, following the repo's existing style (see \`git log -n 3 --format=%B ${f.remote}/${f.baseBranch}\`).`,
      ) + (commitBasisNote ? L("", " ") + commitBasisNote : ""),
    ]),
    "",
  ];
  return sections.join("\n");
}

/**
 * 基于模板的 Containerfile：按项目语言补工具链。浏览器验收那段（playwright-cli + Chromium）所有项目都保留：后端项目后来加了前端，只要在 PROJECT.md 补「浏览器验收」一节，不用重建镜像模板。
 * Containerfile from the template: add the project's toolchain. The browser-check block (playwright-cli + Chromium) stays for every project: when a backend project later adds a frontend, adding the Browser check section to PROJECT.md is enough, no template change needed.
 */
export function containerfileSource(template: string, f: ProjectFacts): string {
  let out = template;
  const toolchain: Partial<Record<ProjectFacts["language"], string>> = {
    python:
      "RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/* && pip3 install --break-system-packages uv\n\n",
    go: 'RUN curl -fsSL https://go.dev/dl/go1.24.0.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz\nENV PATH="/usr/local/go/bin:$PATH"\n\n',
    rust: "RUN apt-get update && apt-get install -y build-essential && rm -rf /var/lib/apt/lists/*\n\n",
  };
  // pnpm 不在 node 镜像里：以 root 全局装上 package.json 声明的版本，安装命令、门槛和 agent 都直接用。
  // pnpm isn't in the node image: install the version declared in package.json globally as root, so the install command, the gate and the agent can use it directly.
  if (f.packageManagerSpec)
    out = out.replace(/^# 对齐 UID\/GID/m, (m) => `# 包管理器\n# Package manager\nRUN npm install -g ${f.packageManagerSpec}\n\n${m}`);
  const extra = toolchain[f.language];
  if (extra) out = out.replace(/^# 对齐 UID\/GID/m, (m) => `# ${f.language} 工具链\n# ${f.language} toolchain\n${extra}${m}`);
  if (f.forge.kind === "gitlab")
    out = out.replace(
      /^# 装 GitHub CLI/m,
      (m) => `# TODO：远端是 GitLab，要装 glab（GitLab Forge 还没做）\n# TODO: the remote is GitLab, install glab (the GitLab forge isn't done yet)\n${m}`,
    );
  return out;
}

/** 流水线在 worktree 里写、不提交的目录（浏览器验收产物、playwright-cli 会话、验收说明）。 / Directories the pipeline writes in the worktree and never commits (browser-check output, playwright-cli sessions, acceptance notes). */
export const WORKSPACE_IGNORES = [".browser-check/", ".playwright-cli/", ".pr-notes/"];

/**
 * 往 .gitignore 内容里补上缺的条目（带一行说明注释）；已有的不重复加。返回新内容，不用改时返回 undefined。
 * Add missing entries to .gitignore content (with a one-line comment), skipping existing ones. Returns the new content, or undefined when nothing changes.
 */
export function mergeIgnore(existing: string, entries: string[], comment: string): string | undefined {
  const have = new Set(existing.split("\n").map((l) => l.trim().replace(/^\//, "")));
  const missing = entries.filter((p) => !have.has(p) && !(p.endsWith("/") && have.has(p.slice(0, -1))));
  if (!missing.length) return undefined;
  const sep = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}# ${comment}\n${missing.join("\n")}\n`;
}

/** 项目根目录 .gitignore 补上流水线的工作目录。 / Add the pipeline's working directories to the root .gitignore. */
export const mergeGitignore = (existing: string) =>
  mergeIgnore(
    existing,
    WORKSPACE_IGNORES,
    "Sandcastle：沙箱里浏览器验收的截图与结论、playwright-cli 会话、验收说明（编排脚本读出后附到 PR，不提交）\n" +
      "# Sandcastle: browser-check screenshots and results, playwright-cli sessions, acceptance notes (attached to the PR by the pipeline, not committed)",
  );

/** .sandcastle/ 下不提交的文件；onboard 按它生成 .sandcastle/.gitignore，老项目由 update 补上缺的。 / Files under .sandcastle/ that aren't committed; onboard writes .sandcastle/.gitignore from this, and update adds what older projects lack. */
export const SANDCASTLE_IGNORES = [".env", "logs/", "worktrees/", "tsconfig.json"];
export const mergeSandcastleIgnore = (existing: string) =>
  mergeIgnore(
    existing,
    SANDCASTLE_IGNORES,
    "Sandcastle：密钥、日志、worktree，以及指向本机工具路径的 tsconfig.json\n# Sandcastle: secrets, logs, worktrees, and tsconfig.json pointing at this machine's tool path",
  );

/** 声明文件在工具里的位置（npm run build 生成）。 */
export const TYPES_ENTRY = join(TOOL_ROOT, "dist/types/index.d.ts");

/**
 * .sandcastle/tsconfig.json：编辑器检查 .sandcastle/*.ts 用。项目不用装 sandpipe，paths 把 "sandpipe" 指到
 * 正在运行的这份工具的声明文件。路径因机器和版本而异，所以不提交，升级后由 sandpipe update 重写。
 * 不写 types：Node 项目照常带上自己的 @types/node，别的项目没有也不报错。
 * .sandcastle/tsconfig.json: lets the editor check .sandcastle/*.ts. The project doesn't install sandpipe; paths points "sandpipe" at
 * the declarations of the tool that is running. The path depends on the machine and version, so it isn't committed and sandpipe update rewrites it after upgrades.
 * No types: Node projects still get their own @types/node, and other projects don't error without it.
 */
export function typesTsconfig(entry = TYPES_ENTRY): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      paths: { sandpipe: [entry] },
    },
    include: ["*.ts"],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 本机相关、不提交的文件：tsconfig.json 写成当前版本，.sandcastle/.gitignore 补上缺的条目。返回有改动的文件。
 * Machine-specific, uncommitted files: write tsconfig.json for the current version and add missing entries to .sandcastle/.gitignore. Returns the changed files.
 */
export function syncLocalFiles(root: string): string[] {
  const changed: string[] = [];
  const write = (file: string, next: string | undefined) => {
    const path = join(root, file);
    if (next === undefined || (existsSync(path) && readFileSync(path, "utf8") === next)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    changed.push(file);
  };
  const ignore = join(root, ".sandcastle/.gitignore");
  write(".sandcastle/.gitignore", mergeSandcastleIgnore(existsSync(ignore) ? readFileSync(ignore, "utf8") : ""));
  write(".sandcastle/tsconfig.json", typesTsconfig());
  return changed;
}

type HookEntry = { matcher: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/**
 * 在 .claude/settings.json 里登记上下文预算 hook；已登记的不重复加。
 * Register the context budget hook in .claude/settings.json; skips it when already registered.
 */
export function mergeSettings(existing: Settings): { settings: Settings; changed: boolean } {
  const command = `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/${HOOK_FILE}`;
  const settings: Settings = structuredClone(existing);
  const hooks = (settings.hooks ??= {});
  let changed = false;
  for (const [event, matcher] of [
    ["PreToolUse", "Read"],
    ["PostToolUse", "*"],
  ] as const) {
    const list = (hooks[event] ??= []);
    if (list.some((e) => e.hooks?.some((h) => h.command.includes(HOOK_FILE)))) continue;
    list.push({ matcher, hooks: [{ type: "command", command }] });
    changed = true;
  }
  return { settings, changed };
}

// ---------------------------------------------------------------------------
// 写文件
// Writing files
// ---------------------------------------------------------------------------

type Outcome = { file: string; status: "skipped" | ClaudeResolution };

/** 终端上显示的状态。 / How a status is shown in the terminal. */
const statusText = (s: Outcome["status"]) =>
  ({
    written: t("写入", "written"),
    skipped: t("已存在，跳过", "exists, skipped"),
    updated: t("已更新", "updated"),
    unchanged: t("无需改动", "unchanged"),
    kept: t("已存在，保留", "kept existing"),
    "saved-new": t("新版另存为 .new", "new version saved as .new"),
  })[s];

function writeIfMissing(root: string, file: string, content: string | (() => string)): Outcome {
  const path = join(root, file);
  if (existsSync(path)) return { file, status: "skipped" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : content());
  return { file, status: "written" };
}

/**
 * 工具里的文件；标签名占位符按默认标签填上（给人和交互式 claude 看的副本）。
 * A file from the tool, with label placeholders filled with the default labels (copies for humans and interactive claude).
 */
export const toolFile = (p: string) =>
  readFileSync(join(TOOL_ROOT, p), "utf8").replace(/\{\{L_([A-Z_]+)\}\}/g, (m, key: string) => {
    const name = key.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof typeof DEFAULT_LABELS;
    return DEFAULT_LABELS[name] ?? m;
  });
const tool = toolFile;

/**
 * 本工具拥有的 .claude/ 文件（项目里的路径 → 工具里的路径）：onboard 和 update 都是缺了就装、相同不动，已存在且和模板不同时问保留 / 覆盖 / 另存 .new（resolveClaudeFile）。
 * .claude/ files owned by this tool (project path → tool path): onboard and update both install missing ones and leave identical ones alone; existing ones that differ from the template prompt for keep / overwrite / save as .new (resolveClaudeFile).
 */
export const CLAUDE_FILES: Record<string, string> = {
  [`.claude/hooks/${HOOK_FILE}`]: `claude/hooks/${HOOK_FILE}`,
  ".claude/agents/screenshot-checker.md": "claude/agents/screenshot-checker.md",
  ".claude/skills/prep-ticket/SKILL.md": "claude/skills/prep-ticket/SKILL.md",
  ".claude/skills/prep-ticket/ticket-sizing.md": "prompts/ticket-sizing.md",
  ".claude/skills/fill-project-docs/SKILL.md": "claude/skills/fill-project-docs/SKILL.md",
  ".claude/skills/fill-project-docs/NOTICE": "claude/skills/fill-project-docs/NOTICE",
};

/**
 * 同步 tsconfig.json 与 .sandcastle/.gitignore（直接刷新），CLAUDE_FILES 逐个按 resolveClaudeFile 处理，返回内容有变化的文件；
 * 另存了 .new 的不算变化，另外警告。升级工具后跑（sandpipe update）。
 * Sync tsconfig.json and .sandcastle/.gitignore (refreshed directly) and handle each CLAUDE_FILES entry with resolveClaudeFile; returns files whose content changed.
 * Files saved as .new don't count as changed and get a separate warning. Run after upgrading (sandpipe update).
 */
export async function updateClaudeFiles(root: string, decide: Decide = askChoice): Promise<string[]> {
  // 没接入过的目录（多半是在项目外运行）不往里写文件
  // Don't write into a directory that was never onboarded (usually run outside a project)
  if (!existsSync(join(root, ".sandcastle/sandcastle.config.ts")))
    throw new Error(
      t(
        `${root} 下没有 .sandcastle/sandcastle.config.ts：在已接入的项目根目录运行 update；新项目先跑 sandpipe onboard`,
        `No .sandcastle/sandcastle.config.ts under ${root}: run update in an onboarded project's root; for a new project run sandpipe onboard first`,
      ),
    );
  const changed: string[] = syncLocalFiles(root);
  for (const [file, src] of Object.entries(CLAUDE_FILES)) {
    const result = await resolveClaudeFile(root, file, tool(src), decide);
    if (result === "written" || result === "updated") changed.push(file);
    else if (result === "saved-new") console.warn(`⚠ ${file}.new`);
  }
  return changed;
}

/**
 * 全局 skill（~/.claude/skills/ 下，项目路径 → 工具路径）：任何仓库都能用 /prep-ticket，不必先 onboard。
 * 同名时个人级 skill 盖过项目级，所以装了全局的以后，sandcastle 项目里用的也是这一份；update 会顺带刷新它。
 * Global skills (under ~/.claude/skills/, path → tool path): /prep-ticket works in any repo without onboarding.
 * A personal skill shadows a project skill of the same name, so once installed this copy is used in sandcastle projects too; update refreshes it as well.
 */
export const GLOBAL_SKILL_FILES: Record<string, string> = {
  "skills/prep-ticket/SKILL.md": "claude/skills/prep-ticket/SKILL.md",
  "skills/prep-ticket/ticket-sizing.md": "prompts/ticket-sizing.md",
};

/** ~/.claude（测试里传临时目录）。 / ~/.claude (tests pass a temp dir). */
export const userClaudeDir = () => join(homedir(), ".claude");

/** 全局 skill 是否装过（有任一文件就算）。 / Whether the global skill is installed (any file counts). */
export const hasGlobalSkill = (claudeDir = userClaudeDir()) =>
  Object.keys(GLOBAL_SKILL_FILES).some((f) => existsSync(join(claudeDir, f)));

/** 和当前版本不一致或缺失的全局 skill 文件。 / Global skill files that are outdated or missing. */
export const staleGlobalSkillFiles = (claudeDir = userClaudeDir()) =>
  Object.entries(GLOBAL_SKILL_FILES)
    .filter(([file, src]) => {
      const path = join(claudeDir, file);
      return !existsSync(path) || readFileSync(path, "utf8") !== tool(src);
    })
    .map(([file]) => join(claudeDir, file));

/**
 * 把全局 skill 写成当前版本（sandpipe skill），返回内容有变化的文件。
 * Write the global skill at the current version (sandpipe skill); returns files whose content changed.
 */
export function installGlobalSkill(claudeDir = userClaudeDir()): string[] {
  const changed = staleGlobalSkillFiles(claudeDir);
  for (const path of changed) {
    const file = Object.keys(GLOBAL_SKILL_FILES).find((f) => join(claudeDir, f) === path)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tool(GLOBAL_SKILL_FILES[file]));
  }
  return changed;
}

/**
 * 装文件，已存在的跳过（.claude/ 下已存在的由 onboard 另行用 resolveClaudeFile 处理）。lang 定 PROJECT.md 草稿的语言和配置里的 language。
 * Install the files, skipping existing ones (onboard handles existing .claude/ files separately with resolveClaudeFile). lang sets the PROJECT.md draft language and the config's language.
 */
export function installFiles(root: string, f: ProjectFacts, lang: Language = f.commitLanguage): Outcome[] {
  const out: Outcome[] = [
    writeIfMissing(root, ".sandcastle/sandcastle.config.ts", () => configSource(f, "sandpipe", lang)),
    writeIfMissing(root, ".sandcastle/PROJECT.md", () => projectDocDraft(f, lang)),
    // 让 Node 把 .sandcastle/ 下的 .ts 当 ESM 加载（项目可能没有 package.json，或者是 CommonJS）
    // Make Node load .sandcastle/*.ts as ESM (the project may have no package.json, or be CommonJS)
    writeIfMissing(root, ".sandcastle/package.json", '{ "type": "module" }\n'),
    writeIfMissing(root, ".sandcastle/models.json", () => tool("templates/.sandcastle/models.json")),
    writeIfMissing(root, ".sandcastle/.env.example", () => tool("templates/.sandcastle/.env.example")),
    writeIfMissing(root, ".sandcastle/Containerfile", () => containerfileSource(tool("templates/.sandcastle/Containerfile"), f)),
    ...Object.entries(CLAUDE_FILES).map(([file, src]) => writeIfMissing(root, file, () => tool(src))),
  ];
  for (const file of syncLocalFiles(root)) {
    const o = out.find((x) => x.file === file);
    if (o) o.status = o.status === "written" ? "written" : "updated";
    else out.push({ file, status: "written" });
  }
  const settingsPath = join(root, ".claude/settings.json");
  const existing = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Settings) : {};
  const { settings, changed } = mergeSettings(existing);
  if (changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  const ignorePath = join(root, ".gitignore");
  const ignoreBefore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const ignoreAfter = mergeGitignore(ignoreBefore);
  if (ignoreAfter !== undefined) writeFileSync(ignorePath, ignoreAfter);
  out.push({ file: ".gitignore", status: ignoreAfter === undefined ? "unchanged" : ignoreBefore ? "updated" : "written" });
  out.push({ file: ".claude/settings.json", status: changed ? (Object.keys(existing).length ? "updated" : "written") : "unchanged" });
  return out;
}

// ---------------------------------------------------------------------------
// agent 补全 PROJECT.md
// Agent completes PROJECT.md
// ---------------------------------------------------------------------------

/**
 * onboard 的 agent 默认能写的文件：PROJECT.md 和缺口清单。`--questions-only` 只给缺口清单。
 * Files the onboard agent may write by default: PROJECT.md and the open questions list. `--questions-only` gets just the list.
 */
export const AGENT_WRITABLE = [".sandcastle/PROJECT.md", OPEN_QUESTIONS];

/**
 * 这次 agent 能写哪些文件：缺口清单和其他生成文件一样，已经存在就不让 agent 碰。要在 agent 跑之前算。
 * Which files the agent may write this time: like other generated files, an existing open questions list is left alone. Compute before the agent runs.
 */
export function agentWritable(root: string): string[] {
  return existsSync(join(root, OPEN_QUESTIONS)) ? AGENT_WRITABLE.filter((p) => p !== OPEN_QUESTIONS) : [...AGENT_WRITABLE];
}

/**
 * 缺口清单的格式说明（提示词正文是中文，英文项目的类别和标题换法写在开头的输出语言规则里）。
 * `factsHandling` 是代码里查得到的事实该怎么处理（一句话）：完整 onboard 时写进 PROJECT.md，`--questions-only` 时不记。
 * `lang` 决定列出哪一套 PROJECT.md 节名：中文项目列中文节名，英文项目列英文节名。
 * Format notes for the open questions list (the prompt body is Chinese; English projects get the category and heading swap in the output-language rule up front).
 * `factsHandling` says (as a sentence) what to do with facts found in the code: written into PROJECT.md in a full onboard, skipped with `--questions-only`.
 * `lang` picks which PROJECT.md section titles are listed: Chinese titles for Chinese projects, English titles for English ones.
 */
const browserTitle = (lang: Language) => (lang === "en" ? SECTIONS_EN.browser : SECTIONS.browser);
const questionsFormat = (factsHandling: string, lang: Language) => [
  `把拿不准、需要人补的点写进 \`${OPEN_QUESTIONS}\`，这份文件会提交进仓库，之后由人在 Claude Code 里逐条补完：`,
  "",
  "- 以 `# 缺口清单` 开头，下面每条一行：`- [类别] 问题 → 写到哪`。不编号、不加 ID，箭头只用 `→`。",
  "- 类别只有两种：`规范`（代码风格、测试写法、提交约定这类能从代码推一部分、但你拿不准的）和 `意图`（业务规则、领域术语、红线、设计原因这类只能由人说出来的）。",
  `- 「写到哪」写答案该进哪份文档。写进 PROJECT.md 的只能写成 \`PROJECT.md「节名」\`，节名只能取这几个：${Object.values(lang === "en" ? SECTIONS_EN : SECTIONS).map((s) => `「${s}」`).join("、")}。不能新建节，放不进这些节的答案写最接近的那一节。不写进 PROJECT.md 的，写术语表（GLOSSARY.md / CONTEXT.md）、ADR 之类的其他文件。`,
  `- 什么算缺口：意图层面的信息（术语表、红线、设计原因）在代码和文档里都找不到，或者规范拿不准。代码里查得到的事实不算，${factsHandling}`,
  `- 浏览器验收是必查的一类：项目有网页界面（事实里 \`webUi\` 为 true，或代码里有页面）、而 PROJECT.md 没有「${browserTitle(lang)}」一节时，必须逐条列出拼不出来的信息，类别写 \`规范\`，写到 \`PROJECT.md「${browserTitle(lang)}」\`：dev server 的启动命令与端口、验收数据怎么建（种子脚本、验收租户）、登录方式与账号、dev server 需要的环境变量（对照 config 的 \`isolation.env\`）。不要笼统写一条「浏览器验收怎么做」。`,
  "- 没有缺口时只写标题那一行。",
  "",
  "示例：",
  "",
  "```markdown",
  ...(lang === "en" ? QUESTIONS_EXAMPLE_EN : QUESTIONS_EXAMPLE),
  "```",
].join("\n");

/**
 * 缺口清单示例：中文项目一套、英文项目一套，节名和所在项目的 PROJECT.md 一致。
 * Open questions examples: one for Chinese projects, one for English ones, with section names matching that project's PROJECT.md.
 */
const QUESTIONS_EXAMPLE = [
  "# 缺口清单",
  "",
  `- [规范] dev server 怎么起、监听哪个端口？ → PROJECT.md「${SECTIONS.browser}」`,
  `- [意图] 哪些操作必须交给人（红线）？ → PROJECT.md「${SECTIONS.redLines}」`,
  `- [规范] 分支命名有没有约定？ → PROJECT.md「${SECTIONS.commit}」`,
  "- [意图] 项目还没有术语表 → GLOSSARY.md",
];
const QUESTIONS_EXAMPLE_EN = [
  "# Open questions",
  "",
  `- [convention] How is the dev server started, and on which port? → PROJECT.md「${SECTIONS_EN.browser}」`,
  `- [intent] Which operations must be left to a human (red lines)? → PROJECT.md「${SECTIONS_EN.redLines}」`,
  `- [convention] Is there a branch naming convention? → PROJECT.md「${SECTIONS_EN.commit}」`,
  "- [intent] The project has no glossary yet → GLOSSARY.md",
];

/**
 * 英文项目的清单写法：标题和类别换成英文。
 * How English projects write the list: English heading and categories.
 */
const QUESTIONS_EN = `Write the open questions list in English: start it with \`# Open questions\`, use the categories \`[convention]\` / \`[intent]\` instead of \`[规范]\` / \`[意图]\`, and name PROJECT.md sections by their English titles in the targets. `;

const writableList = (writable: string[]) => writable.map((p) => `\`${p}\``).join("、");
const factsJson = (f: ProjectFacts) => JSON.stringify({ ...f, root: undefined }, null, 2);
const ANSWER_EN = "Write your final notes in English too. The instructions below are in Chinese; read them, but answer in English.\n\n";

/**
 * 补全 PROJECT.md 的提示词。提示词本身是中文；英文项目在开头加一条输出语言规则（和流水线提示词的做法一样）。
 * `writable` 是 agent 能写的文件；缺口清单不在里面时，提示词要求 agent 不要动它。
 * Prompt for completing PROJECT.md. The prompt itself is Chinese; English projects get an output-language rule up front (as the pipeline prompts do).
 * `writable` lists the files the agent may write; when the open questions list isn't among them, the prompt tells the agent to leave it alone.
 */
export function onboardPrompt(f: ProjectFacts, lang: Language = f.commitLanguage, writable: string[] = AGENT_WRITABLE): string {
  const facts = factsJson(f);
  const listWritable = writable.includes(OPEN_QUESTIONS);
  const questions = listWritable ? questionsFormat("自己查清楚写进 PROJECT.md。", lang) : `\`${OPEN_QUESTIONS}\` 已存在，不要动它；拿不准的点在最后的输出里另起一段「拿不准的点」，每条一行。`;
  const rule =
    lang === "en"
      ? `Output language: write PROJECT.md in English and use the English section titles instead of the Chinese ones in the template below (${(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((k) => `${SECTIONS[k]} → \`## ${SECTIONS_EN[k]}\``).join(", ")}). ` +
        (listWritable ? QUESTIONS_EN : "") +
        ANSWER_EN
      : "";
  return rule + tool("prompts/onboard.md")
    .replace("{{WRITABLE}}", () => writableList(writable))
    .replace("{{QUESTIONS}}", () => questions)
    .replace("{{FACTS}}", () => facts)
    .replace("{{TEMPLATE}}", () => tool("templates/.sandcastle/PROJECT.md"))
    .replace("{{EXAMPLE}}", () => tool("templates/example-PROJECT.md"));
}

/**
 * `--questions-only` 的提示词：读现有 PROJECT.md 和代码找缺口，只许写缺口清单。
 * Prompt for `--questions-only`: read the existing PROJECT.md and the code for gaps; only the open questions list may be written.
 */
export function questionsPrompt(f: ProjectFacts, lang: Language, projectMd: string): string {
  const rule = lang === "en" ? `Output language: ${QUESTIONS_EN}${ANSWER_EN}` : "";
  return rule + tool("prompts/onboard-questions.md")
    .replace("{{FACTS}}", () => factsJson(f))
    .replace("{{PROJECT}}", () => projectMd.trim())
    .replace("{{WRITABLE}}", () => writableList([OPEN_QUESTIONS]))
    .replace("{{QUESTIONS}}", () => questionsFormat("不用记。", lang));
}

/**
 * `--questions-only` 能不能跑：不能跑时返回给人看的提示，能跑返回 null。
 * Whether `--questions-only` can run: a message for the user when it can't, null when it can.
 */
export function questionsOnlyPrecheck(root: string): string | null {
  if (existsSync(join(root, OPEN_QUESTIONS)))
    return t(`${OPEN_QUESTIONS} 已存在，删掉后重跑。`, `${OPEN_QUESTIONS} already exists; delete it and run again.`);
  if (!existsSync(join(root, ".sandcastle/PROJECT.md")))
    return t("没有 .sandcastle/PROJECT.md，先跑 sandpipe onboard。", "No .sandcastle/PROJECT.md; run sandpipe onboard first.");
  return null;
}

// claude 的 stderr 每行加这个前缀再转写，和 sandpipe 自己的提示区分开。
// Every echoed stderr line from claude gets this prefix, to tell it apart from sandpipe's own messages.
const CLAUDE_PREFIX = "  [claude] ";
// 失败信息里保留的 stderr 行数。 / How many stderr lines to keep in the failure message.
const STDERR_TAIL = 5;
// stdout 的上限（按字节），对齐原来 execFileSync 的 maxBuffer。 / stdout cap in bytes, matching the old execFileSync maxBuffer.
const MAX_STDOUT = 16 * 1024 * 1024;

/**
 * 按行加前缀的缓冲器：push 收 chunk，凑齐的完整行（前缀 + 换行）一次返回；半行留在缓冲里，flush 在结束时补出去。
 * Buffer 按 UTF-8 流式解码，chunk 边界落在多字节字符中间也不会出乱码。
 * Line-prefixing buffer: push() takes a chunk and returns the lines completed so far (prefix + newline each); a partial line stays buffered until flush() emits it at the end.
 * Buffers are decoded as streaming UTF-8, so a chunk boundary inside a multi-byte character doesn't garble it.
 */
export function prefixLines(prefix: string): { push(chunk: string | Buffer): string; flush(): string } {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: string | Buffer): string {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = buffer.split("\n");
      // 最后一段是半行，留到下一个 chunk 或 flush。
      // The last piece is a partial line, kept for the next chunk or the flush.
      buffer = lines.pop() ?? "";
      return lines.map((line) => prefix + line + "\n").join("");
    },
    flush(): string {
      buffer += decoder.end();
      if (!buffer) return "";
      const rest = prefix + buffer + "\n";
      buffer = "";
      return rest;
    },
  };
}

/**
 * 收 stdout 的 Buffer chunk：按字节数计上限，超了 push 返回 false；text 把收齐的字节整段按 UTF-8 解码，拆开的多字节字符能拼回来。
 * Collects stdout Buffer chunks: the cap counts bytes and push() returns false once it's exceeded; text() decodes all collected bytes as UTF-8 at once, so split multi-byte characters come back whole.
 */
export function outputCollector(maxBytes: number): { push(chunk: Buffer): boolean; text(): string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk: Buffer): boolean {
      chunks.push(chunk);
      bytes += chunk.length;
      return bytes <= maxBytes;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * claude 失败时的提示：退出码 / 原因在前，stderr 最后几行带 [claude] 前缀跟在后面，不吞掉 claude 自己的报错。
 * Failure text for claude: the exit code / reason first, then the last stderr lines with the [claude] prefix, so claude's own errors aren't swallowed.
 */
export function agentFailureMessage(reason: string, stderrLines: string[]): string {
  const tail = stderrLines.slice(-STDERR_TAIL).map((line) => `${CLAUDE_PREFIX}${line}`);
  return tail.length ? `${reason}\n${tail.join("\n")}` : reason;
}

/**
 * 在宿主机上跑一次 claude -p：stdout 收齐了返回；stderr 按行加 [claude] 前缀转写到终端（--verbose 时），最后几行总是收进失败信息。
 * Runs claude -p once on the host: stdout is collected and returned; stderr is echoed to the terminal line by line with the [claude] prefix (under --verbose), and its last lines always go into the failure message.
 */
function runAgent(root: string, prompt: string, model: string, writable: string[], verbose: boolean): Promise<string> {
  const allowed = [
    "Read",
    "Grep",
    "Glob",
    ...writable.map((p) => `Edit(${p})`),
    "Bash(git log:*)",
    "Bash(git ls-files:*)",
    "Bash(ls:*)",
    "Bash(wc:*)",
    "Bash(grep:*)",
    "Bash(sed -n:*)",
    "Bash(head:*)",
  ];
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const tail: string[] = [];
    const prefixer = prefixLines(CLAUDE_PREFIX);
    const child = spawn(
      "claude",
      ["-p", prompt, "--model", model, "--allowedTools", allowed.join(","), "--output-format", "text"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(agentFailureMessage(reason, tail)));
    };
    // 30 分钟没跑完就停掉，onboard 不能一直挂着。
    // Stop it after 30 minutes: onboard must not hang forever.
    timer = setTimeout(() => {
      child.kill();
      fail(t("claude 30 分钟没跑完，已停止", "claude didn't finish within 30 minutes; stopped it"));
    }, 30 * 60_000);
    // 转写 stderr 并留最后几行（去掉前缀），失败信息要用；转写只在 --verbose 时做，末尾几行总是收（关掉的只能是 write）。
    // Echo stderr and keep the last lines (prefix stripped) for the failure message; echoing happens only under --verbose, the tail is always collected (only the write can be turned off).
    const echo = (prefixed: string) => {
      if (prefixed && verbose) process.stderr.write(prefixed);
      for (const line of prefixed.split("\n")) {
        if (!line) continue;
        tail.push(line.slice(CLAUDE_PREFIX.length));
        if (tail.length > STDERR_TAIL) tail.shift();
      }
    };
    const stdout = outputCollector(MAX_STDOUT);
    child.stdout?.on("data", (chunk: Buffer) => {
      // 超过上限就停，免得失控的输出把内存吃满。
      // Stop past the cap so runaway output can't eat memory.
      if (!stdout.push(chunk)) {
        child.kill();
        fail(t(`claude 输出超过 ${MAX_STDOUT / 1024 / 1024}MB，已停止`, `claude produced more than ${MAX_STDOUT / 1024 / 1024}MB of output; stopped it`));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => echo(prefixer.push(chunk)));
    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(
        e.code === "ENOENT"
          ? t("没找到 claude 命令：本机没装 Claude Code？", "The claude command wasn't found: is Claude Code installed on this machine?")
          : `${t("claude 没跑起来：", "claude failed to start: ")}${e.message}`,
      );
    });
    child.on("close", (code) => {
      // 结束时把剩下的半行补出去，也计入末尾几行。
      // Emit the trailing partial line at the end and count it into the tail.
      echo(prefixer.flush());
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout.text());
      } else fail(t(`claude 退出码 ${code}`, `claude exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 入口
// Entry point
// ---------------------------------------------------------------------------

/**
 * `onboard --questions-only`：只让 agent 写缺口清单，不生成、不改动其他文件（也不写 logs）；agent 的 stderr 和笔记全文只在 --verbose 打，完成收成一行。
 * `onboard --questions-only`: the agent writes only the open questions list; no other file is generated or touched (no logs either); the agent's stderr and full notes print only under --verbose, the outcome is one line.
 */
async function questionsOnlyRun(root: string, f: ProjectFacts, model: string, lang: Language, verbose: boolean) {
  const blocked = questionsOnlyPrecheck(root);
  if (blocked) {
    console.log(blocked);
    return;
  }
  const projectMd = readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8");
  console.log(agentStartHint("questions", model));
  try {
    const notes = await runAgent(root, questionsPrompt(f, lang, projectMd), model, [OPEN_QUESTIONS], verbose);
    console.log(verbose ? `\n${notes.trim()}` : agentDoneLine("questions"));
  } catch (e) {
    console.warn(t("  ⚠ agent 失败：", "  ⚠ The agent failed: ") + String((e as Error).message));
    return;
  }
  const qc = checkOpenQuestions(root);
  if (qc.state === "ok") console.log(t(`✓ 缺口清单还有 ${qc.count} 条`, `✓ ${qc.count} open question(s) left`));
  for (const w of qc.warnings) console.warn(w);
  if (qc.count > 0) console.log(`\n${t("接下来：", "Next: ")}${fillDocsHint(qc.count)}`);
}

/**
 * 校验缺口清单，返回剩余条数和需要单独成行的警告（没生成、格式不对、「写到哪」指向 PROJECT.md 里没有的节）。
 * 「还有 N 条」的明细行不在这里打，由调用方按 --verbose / --questions-only 决定。
 * Validate the open questions list, returning how many are left plus warnings that each need their own line (missing, malformed, a target pointing to a PROJECT.md section that doesn't exist).
 * The "N left" detail line isn't printed here — callers decide via --verbose / --questions-only.
 */
function checkOpenQuestions(root: string): QuestionsCheck & { warnings: string[] } {
  try {
    const questions = readOpenQuestions(root);
    if (questions === null)
      return { count: 0, state: "missing", warnings: [t("⚠ 没有生成缺口清单", "⚠ No open questions list was generated")] };
    return {
      count: questions.length,
      state: "ok",
      warnings: unknownSectionTargets(questions).map(({ line, section }) =>
        t(
          `⚠ 缺口清单第 ${line} 行：「写到哪」指向 PROJECT.md 里没有的节「${section}」，只能用现有节名`,
          `⚠ Open questions line ${line}: target points to a PROJECT.md section that doesn't exist, "${section}"; use an existing section`,
        ),
      ),
    };
  } catch (e) {
    const message = (e as Error).message;
    return { count: 0, state: "invalid", message, warnings: [t("⚠ 缺口清单校验没过：", "⚠ The open questions list is invalid: ") + message] };
  }
}

export const fillDocsHint = (remaining: number) =>
  t(`在 Claude Code 里运行 /fill-project-docs，补完缺口清单（还剩 ${remaining} 条）`, `Run /fill-project-docs in Claude Code to work through the open questions (${remaining} left)`);

/**
 * 起 agent 前的提示：写明在本机用 claude -p 跑、用的是本机 Claude Code 登录的账号（不是 .sandcastle/.env 里的 token）。
 * Hint printed before starting the agent: says it runs claude -p locally under the local Claude Code login (not the token in .sandcastle/.env).
 */
export function agentStartHint(kind: "doc" | "questions", model: string): string {
  const head = t(
    `\n在本机用 claude -p 跑 agent（${model}，用本机 Claude Code 登录的账号，不是 .sandcastle/.env 里的 token）`,
    `\nRunning the agent locally with claude -p (${model}, under your local Claude Code login, not the token in .sandcastle/.env)`,
  );
  const tail =
    kind === "doc"
      ? t("，读代码补全 .sandcastle/PROJECT.md，几分钟……", " to read the code and complete .sandcastle/PROJECT.md, a few minutes…")
      : t(`，读 PROJECT.md 和代码，生成 ${OPEN_QUESTIONS}，几分钟……`, ` to read PROJECT.md and the code and write ${OPEN_QUESTIONS}, a few minutes…`);
  return head + tail;
}

/**
 * agent 段的完成行：doc 写明笔记存到了 .sandcastle/logs/onboard.md；questions-only 不写 logs，只写「完成」。
 * Done line for the agent stage: doc points at the notes saved to .sandcastle/logs/onboard.md; questions-only writes no logs, so it just says done.
 */
export function agentDoneLine(kind: "doc" | "questions"): string {
  return kind === "doc"
    ? t("完成，笔记见 .sandcastle/logs/onboard.md", "Done; notes in .sandcastle/logs/onboard.md")
    : t("完成", "Done");
}

/**
 * 「下一步」里填 .env 那一步：写明流水线用 .env 里的 token，与本机 Claude Code 登录无关。
 * The fill-in-.env step under "Next": says the pipeline uses the token from .env, independent of the local Claude Code login.
 */
export const envStepHint = () =>
  t(
    "cp .sandcastle/.env.example .sandcastle/.env，填流水线用的 token：CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成）或 ANTHROPIC_API_KEY；流水线只用这里面的 token，与本机 Claude Code 登录无关",
    "cp .sandcastle/.env.example .sandcastle/.env and fill in the token the pipeline uses: CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY; the pipeline reads only this file, independent of your local Claude Code login",
  );

/**
 * 提交历史不够判断时，显式给的 --lang 决定提交语言；提交够多时不动（界面语言和提交语言可以不同）。
 * When the history is too short to judge, an explicit --lang decides the commit language; with enough commits it's left alone (UI and commit language may differ).
 */
export function applyLangArg(f: ProjectFacts, langArg: Language | undefined): ProjectFacts {
  return langArg && f.commitLanguageBasis !== "commits" ? { ...f, commitLanguage: langArg, commitLanguageBasis: "lang" } : f;
}

/**
 * onboard 只在 git 仓库根目录运行：不是仓库时探测出的远端和基线是错的，在子目录里会把配置写到子目录。
 * onboard only runs in a git repository's root: outside a repository the detected remote and base are wrong, and in a subdirectory the config lands there.
 */
export function assertRepoRoot(root: string) {
  let top: string;
  try {
    top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(t(`${root} 不是 git 仓库：在目标项目的根目录运行`, `${root} isn't a git repository: run it in the target project's root`));
  }
  if (realpathSync(top) !== realpathSync(root))
    throw new Error(t(`不在仓库根目录（根目录是 ${top}）：cd 到仓库根目录再运行`, `Not in the repository root (the root is ${top}): cd to the repository root and run again`));
}

// ---------------------------------------------------------------------------
// 阶段摘要（默认输出；--verbose 才打完整明细）
// Stage summaries (the default output; full details print only under --verbose)
// ---------------------------------------------------------------------------

/**
 * 探测段的摘要（两行）：项目、语言与包管理、平台、基线；门槛、受保护路径条数、有无网页界面。
 * 受保护路径只给条数：正则字面量很长，要看时用 --verbose。
 * Summary of the detection stage (two lines): project, language and package manager, forge, base; gate, protected path count, web UI.
 * Protected paths are a count only: the regex literals run long; use --verbose to see them.
 */
export function detectSummary(f: ProjectFacts): string[] {
  const pm = f.packageManager ? `/${f.packageManager}` : "";
  const forge = `${f.forge.kind}${f.forge.path ? ` ${f.forge.path}` : ""}`;
  const gate = (["typecheck", "lint", "test"] as const).filter((k) => f.commands[k]).join(" + ") || t("没探测到", "none detected");
  const web = f.webUi ? t("有网页界面", "web UI") : t("无网页界面", "no web UI");
  // 续行缩进对齐「探测  」的显示宽度（中文标签是两个全角字符）
  // The continuation indent matches the display width of "探测  " (the Chinese label is two wide chars)
  return [
    t(
      `探测  ${f.name}（${f.language}${pm}）· ${forge} · 基线 ${f.baseBranch}`,
      `Detect  ${f.name} (${f.language}${pm}) · ${forge} · base ${f.baseBranch}`,
    ),
    t(
      `      门槛 ${gate} · 受保护路径 ${f.protectedPaths.length} 条 · ${web}`,
      `        gate ${gate} · ${f.protectedPaths.length} protected path(s) · ${web}`,
    ),
  ];
}

/**
 * 文件段的摘要（一行）：新建与跳过（已存在）的计数，有更新时附上；已存在没动的（skipped / kept / unchanged）都算「跳过」。
 * 另存为 .new 的不计数——它要人合并，摘要之外单独成行警告。
 * Summary of the file stage (one line): counts of written and skipped (already present) files, plus updated when nonzero; files left alone (skipped / kept / unchanged) all count as skipped.
 * .new saves aren't counted — they need a human merge and get their own warning line besides the summary.
 */
export function filesSummary(results: Outcome[]): string {
  const n = (status: Outcome["status"]) => results.filter((r) => r.status === status).length;
  const written = n("written");
  const skipped = n("skipped") + n("kept") + n("unchanged");
  const updated = n("updated");
  return t(
    `文件  新建 ${written} 个，跳过 ${skipped} 个（已存在）${updated ? `，更新 ${updated} 个` : ""}`,
    `Files  ${written} written, ${skipped} skipped (already present)${updated ? `, ${updated} updated` : ""}`,
  );
}

/** 缺口清单校验的结果：count 是剩余条数；missing（没生成）/ invalid（格式不对）时 count 为 0，invalid 的 message 是报错。 / Result of validating the open questions list: count is how many are left; 0 with missing (not written) / invalid (malformed), whose message holds the error. */
export type QuestionsCheck = { count: number; state: "ok" | "missing" | "invalid"; message?: string };

/**
 * 校验段的摘要（一行）：PROJECT.md 是否通过、缺口清单条数；没生成 / 没过的详细报错由调用方单独成行。
 * Summary of the validation stage (one line): whether PROJECT.md passed and the open question count; the details of a failure or a missing list get their own line from the caller.
 */
export function validationSummary(projectOk: boolean, q: QuestionsCheck): string {
  let questions: string;
  if (q.state === "ok") questions = t(`缺口清单 ${q.count} 条`, `${q.count} open question(s)`);
  else if (q.state === "missing") questions = t("缺口清单（没生成）", "open questions (not written)");
  else questions = t("缺口清单 ✗", "open questions ✗");
  return `${t("校验  ", "Checks  ")}PROJECT.md ${projectOk ? "✓" : "✗"} · ${questions}`;
}

export async function onboard(argv: string[], root = process.cwd(), decide: Decide = askChoice) {
  const noAgent = argv.includes("--no-agent");
  const questionsOnly = argv.includes("--questions-only");
  const verbose = argv.includes("--verbose");
  if (questionsOnly && noAgent)
    throw new Error(t("--questions-only 要靠 agent 生成清单，不能和 --no-agent 一起用", "--questions-only needs the agent to write the list; it can't be combined with --no-agent"));
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : "opus";
  const langArg = argv.includes("--lang") ? argv[argv.indexOf("--lang") + 1] : undefined;
  if (langArg !== undefined && langArg !== "zh" && langArg !== "en") throw new Error(t(`--lang 只能是 zh 或 en，收到「${langArg}」`, `--lang must be zh or en, got "${langArg}"`));

  assertRepoRoot(root);
  const f = applyLangArg(detectProject(root), langArg);
  // 生成的文件和之后的终端输出用同一种语言：--lang，没给时按提交信息。
  // Generated files and the terminal output from here on use one language: --lang, else the commit messages'.
  const lang: Language = langArg ?? f.commitLanguage;
  setTermLanguage(lang);
  for (const line of detectSummary(f)) console.log(line);
  if (verbose) {
    const none = t("（无）", "(none)");
    const list = (xs: string[]) => xs.join(t("、", ", ")) || none;
    console.log(
      t(
        `探测：${f.name}（${f.language}${f.packageManager ? ` / ${f.packageManager}` : ""}），远端 ${f.remote} → ${f.forge.kind}${f.forge.path ? ` ${f.forge.path}` : ""}，基线 ${f.baseBranch}`,
        `Detected: ${f.name} (${f.language}${f.packageManager ? ` / ${f.packageManager}` : ""}), remote ${f.remote} → ${f.forge.kind}${f.forge.path ? ` ${f.forge.path}` : ""}, base ${f.baseBranch}`,
      ),
    );
    const cmds = Object.entries(f.commands)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join(t("；", "; "));
    console.log(`  ${t("命令：", "Commands: ")}${cmds || t("（没探测到）", "(none detected)")}`);
    const migrations = f.migrations ? `${f.migrations.tool} ${f.migrations.dir}` : none;
    console.log(
      t(
        `  文档：${list(f.docs)}；测试目录：${list(f.testDirs)}；服务：${list(f.services)}；迁移：${migrations}；网页界面：${f.webUi ? "有" : "无"}`,
        `  Docs: ${list(f.docs)}; test dirs: ${list(f.testDirs)}; services: ${list(f.services)}; migrations: ${migrations}; web UI: ${f.webUi ? "yes" : "no"}`,
      ),
    );
    console.log(`  ${t("受保护路径：", "Protected paths: ")}${list(regexLiterals(f.protectedPaths))}`);
  }
  if (f.forge.kind === "gitlab" && !questionsOnly)
    console.warn(t("  ⚠ 远端是 GitLab：GitLab Forge 还没做，文件照常生成，但先别跑", "  ⚠ The remote is GitLab: the GitLab forge isn't done yet. Files are generated, but don't run it yet"));

  if (questionsOnly) return await questionsOnlyRun(root, f, model, lang, verbose);

  const docExisted = existsSync(join(root, ".sandcastle/PROJECT.md"));
  // 在生成文件和 agent 之前算：清单已存在就不让 agent 碰。
  // Computed before generating files and running the agent: an existing open questions list is off limits.
  const writable = agentWritable(root);
  const results: Outcome[] = [];
  for (const o of installFiles(root, f, lang)) {
    if (o.status === "skipped" && o.file in CLAUDE_FILES) o.status = await resolveClaudeFile(root, o.file, tool(CLAUDE_FILES[o.file]), decide);
    results.push(o);
    if (verbose) console.log(`  ${o.status === "skipped" || o.status === "unchanged" || o.status === "kept" ? "·" : "✓"} ${o.file}${t("：", ": ")}${statusText(o.status)}`);
  }
  console.log(filesSummary(results));
  // .new 要人合并：计数之外单独成醒目的一行（循环中间的提问和 saveNew 的警告照旧）
  // A .new needs a human merge: its own prominent line besides the counts (the mid-loop prompt and saveNew's warning stay as they are)
  for (const o of results)
    if (o.status === "saved-new")
      console.warn(
        t(
          `⚠ ${o.file} 和当前模板不同，新版另存为 ${o.file}.new；合并后删掉 .new`,
          `⚠ ${o.file} differs from the current template; the new version is saved as ${o.file}.new. Merge it, then delete the .new`,
        ),
      );

  if (noAgent || docExisted) {
    if (docExisted) console.log(t("PROJECT.md 已存在，不再让 agent 重写。", "PROJECT.md already exists; not asking the agent to rewrite it."));
  } else {
    console.log(agentStartHint("doc", model));
    try {
      const notes = await runAgent(root, onboardPrompt(f, lang, writable), model, writable, verbose);
      mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
      writeFileSync(join(root, ".sandcastle/logs/onboard.md"), notes);
      // 笔记全文只在 --verbose 打；默认一行完成摘要指向存进 logs 的文件。「拿不准的点」不另列，靠下面的校验行。
      // The full notes print only under --verbose; by default one done line points at the file saved into logs. Open points aren't listed separately — the validation line below covers them.
      if (verbose) console.log(`\n${notes.trim()}\n${t("（已存到 .sandcastle/logs/onboard.md）", "(saved to .sandcastle/logs/onboard.md)")}`);
      else console.log(agentDoneLine("doc"));
    } catch (e) {
      console.warn(t("  ⚠ agent 补全失败，PROJECT.md 保留草稿：", "  ⚠ The agent failed; PROJECT.md keeps the draft: ") + String((e as Error).message));
    }
  }

  let projectOk = true;
  let projectError: string | undefined;
  try {
    parseProjectDoc(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8"));
  } catch (e) {
    projectOk = false;
    projectError = (e as Error).message;
  }
  const qc = checkOpenQuestions(root);
  console.log(validationSummary(projectOk, qc));
  if (verbose && qc.state === "ok") console.log(t(`✓ 缺口清单还有 ${qc.count} 条`, `✓ ${qc.count} open question(s) left`));
  if (!projectOk) console.warn(t("⚠ PROJECT.md 校验没过：", "⚠ PROJECT.md is invalid: ") + projectError);
  for (const w of qc.warnings) console.warn(w);
  const remaining = qc.count;

  // 给网页链接而不是本机路径：pnpm 全局装的包路径很长，在终端里没法点。
  // Print a web link rather than a local path: packages installed globally with pnpm live under a very long path that can't be clicked in a terminal.
  const checklist = `https://github.com/${RELEASES_REPO}/blob/HEAD/${manual("onboarding-checklist", lang)}`;
  console.log(
    [
      "",
      t("接下来：", "Next:"),
      ...[
        t(
          "看一遍 .sandcastle/PROJECT.md 和 sandcastle.config.ts（门槛、测试隔离），改成符合项目实际的样子",
          "Read .sandcastle/PROJECT.md and sandcastle.config.ts (gate, test isolation) and make them match the project",
        ),
        ...(remaining > 0 ? [fillDocsHint(remaining)] : []),
        envStepHint(),
        `${t("建镜像：", "Build the image: ")}podman build -t ${defaultImageName(root)} -f .sandcastle/Containerfile .sandcastle`,
        t("sandpipe doctor --fix 检查一遍（顺带建好标签）", "sandpipe doctor --fix to check everything (and create the labels)"),
        t(
          `之后按 ${checklist}：baseline 跑一次完整门槛 → 金丝雀票 → 真实小票 → 打开自动合并`,
          `Then follow ${checklist}: baseline full gate → canary ticket → real small tickets → enable auto-merge`,
        ),
      ].map((step, i) => `  ${i + 1}. ${step}`),
    ].join("\n"),
  );
}
