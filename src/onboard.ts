// sandcastle-pipeline onboard：把 Sandcastle 装进一个新项目（在项目根目录运行）。
//
// 1. 探测（detect.ts，只读文件和 git）：语言、包管理、命令、托管平台、文档、测试、迁移、依赖的服务。
// 2. 生成文件，已存在的一律跳过、不覆盖：
//      .sandcastle/sandcastle.config.ts  怎么跑（安装、隔离、门槛），按探测结果填好
//      .sandcastle/PROJECT.md            项目知识草稿（探测到的事实 + 待补的章节）
//      .sandcastle/models.json、.env.example、.gitignore、Containerfile
//      .claude/hooks/sandcastle-context.mjs、.claude/agents/screenshot-checker.md，并在 .claude/settings.json 里登记 hook
// 3. 补全 PROJECT.md（默认开，--no-agent 跳过）：宿主机上跑一次 claude -p，读代码把草稿写成完整的 PROJECT.md，
//    只许改这一个文件；写完按 parseProjectDoc 校验。需要人确认的点打印出来并存进 .sandcastle/logs/onboard.md。

import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/podman";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProject, type ProjectFacts } from "./detect.ts";
import { parseProjectDoc } from "./project-doc.ts";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HOOK_FILE = "sandcastle-context.mjs";

// ---------------------------------------------------------------------------
// 生成内容（纯函数，便于测试）
// ---------------------------------------------------------------------------

const q = (s: string) => JSON.stringify(s);

/** 生成的配置 import 什么：项目装了这个包就用包名，否则用本仓库的绝对路径。 */
export function importSpecifier(root: string): string {
  return existsSync(join(root, "node_modules", "sandcastle-pipeline")) ? "sandcastle-pipeline" : join(TOOL_ROOT, "src", "index.ts");
}

export function configSource(f: ProjectFacts, importFrom: string): string {
  const gateSteps = [f.commands.typecheck, f.commands.lint, f.commands.test].filter(Boolean) as string[];
  const gate = gateSteps.length
    ? gateSteps.join(" && ")
    : "echo '门槛还没配：改 .sandcastle/sandcastle.config.ts 的 gate.script' && exit 1";
  const forgeLine =
    f.forge.kind === "gitlab"
      ? "  // forge: gitlabForge(),  // 远端是 GitLab：GitLab Forge 还没做，接入前先别跑"
      : "  // forge: githubForge(),  // 默认 GitHub（宿主机的 gh）";
  const services = f.services.length
    ? [
        `    // 探测到 docker compose 里的服务：${f.services.join("、")}。沙箱（podman）经 host.containers.internal 访问宿主机上的它们；`,
        "    // 每张票用独立的库名 / 前缀（加 runId），并行的沙箱才不会互相清表。例：",
        "    //   DATABASE_URL: `postgres://user:pass@host.containers.internal:5432/app_test_i${runId}`,",
      ]
    : ["    // 测试依赖外部服务（数据库、缓存、对象存储）时，在这里给每张票独立的库名 / 前缀（加 runId）。"];
  return [
    "// Sandcastle 项目配置：编排脚本里随项目变的部分（由 sandcastle-pipeline onboard 生成，按需修改）。",
    "// 字段说明见 sandcastle-pipeline 的 src/profile.ts；完整例子见它的 examples/duckdb_crm/sandcastle.config.ts。",
    `import { defineProject } from ${q(importFrom)};`,
    "",
    "export default defineProject({",
    forgeLine,
    ...(f.remote !== "origin" ? [`  remote: ${q(f.remote)},`] : []),
    ...(f.baseBranch !== "main" ? [`  baseBranch: ${q(f.baseBranch)},`] : []),
    "  // 同时实现几张票：受测试依赖的服务（连接数）与机器负载限制",
    "  maxParallel: 2,",
    "",
    "  install: {",
    "    // 沙箱建好后装依赖（容器是 linux，宿主机拷进来的原生包可能用不了）",
    `    onSandboxReady: ${q(f.install)},`,
    ...(f.copyToWorktree.length ? [`    copyToWorktree: ${JSON.stringify(f.copyToWorktree)},`] : []),
    "  },",
    "",
    "  isolation: {",
    "    env: (runId) => ({",
    ...services,
    "      SANDCASTLE_RUN_ID: runId,",
    "    }),",
    "    // cleanup: async (runId) => { /* 关沙箱后删掉这张票的测试库 */ },",
    "  },",
    "",
    "  gate: {",
    "    // 合并门槛：退出码 0 算通过。输出约定（GATE_TIER / GATE_FLAKY）见 src/profile.ts 的 GateConfig，可以不用。",
    `    script: () => ${q(gate)},`,
    `    testFile: /${f.testFilePattern.replace(/\//g, "\\/")}/,`,
    `    typecheck: ${q(f.commands.typecheck ?? f.commands.lint ?? "true")},`,
    "  },",
    "",
    ...(f.migrations
      ? [
          `  // 迁移（${f.migrations.tool}，${f.migrations.dir}/）：两张票各加一个迁移时 rebase 没有文本冲突也可能分叉，`,
          "  // 可以配 integrity 在合并前检查，见 examples/duckdb_crm 的「迁移链」。",
          "",
        ]
      : []),
    "  // 几张票会同时往末尾追加的索引文件（CHANGELOG、测试目录……），列在这里的不算「改同一个文件」，可以并行。",
    "  appendOnlyFiles: [],",
    "});",
    "",
  ].join("\n");
}

const bullet = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

/** PROJECT.md 草稿：探测得到的事实先填上，其余留注释给 agent / 人补。 */
export function projectDocDraft(f: ProjectFacts): string {
  const c = f.commands;
  const cmdLines = [
    c.typecheck && `类型检查：\`${c.typecheck}\``,
    c.lint && `lint：\`${c.lint}\``,
    c.testFile && `跑单个测试文件：\`${c.testFile}\``,
    c.format && `格式化：\`${c.format}\``,
  ].filter(Boolean) as string[];
  const docLines = f.docs.filter((d) => !/^README\.md$/.test(d)).map((d) => `\`${d}\``);
  const sections = [
    `# PROJECT.md（${f.name}）`,
    "",
    "<!-- 由 sandcastle-pipeline onboard 生成的草稿。章节规则见 sandcastle-pipeline 的 templates/.sandcastle/PROJECT.md。 -->",
    "",
    "## 概况",
    "",
    "<!-- 待补：这是什么项目、给谁用；入口在哪。 -->",
    "",
    bullet([
      `语言：${f.language}${f.packageManager ? `（包管理 ${f.packageManager}）` : ""}`,
      `顶层目录：${f.topDirs.map((d) => `\`${d}/\``).join("、") || "（无）"}`,
    ]),
    "",
    ...(f.services.length
      ? ["## 运行环境", "", `测试依赖的服务：${f.services.join("、")}。连接已经由环境变量配好，不要改连接配置。`, ""]
      : []),
    "## 开发命令",
    "",
    cmdLines.length ? bullet(cmdLines) : "<!-- 待补：类型检查、lint、跑单个测试文件的命令 -->",
    "",
    "## 测试",
    "",
    f.testDirs.length ? bullet([`测试在 ${f.testDirs.map((d) => `\`${d}/\``).join("、")}`]) : "<!-- 待补：测试放哪、用什么框架 -->",
    "",
    ...(docLines.length ? ["## 领域与文档", "", bullet([`先读：${docLines.join("、")}`]), ""] : []),
    ...(f.migrations
      ? [
          "## 合并冲突",
          "",
          bullet([`${f.migrations.tool} 迁移（\`${f.migrations.dir}/\`）冲突时不要手工合并，rebase 结束后删掉本票的迁移重新生成。`]),
          "",
        ]
      : []),
    "## 提交",
    "",
    bullet([
      `按仓库现有风格写${f.commitLanguage === "zh" ? "中文" : "英文"}提交信息（看 \`git log -n 3 --format=%B ${f.remote}/${f.baseBranch}\`）。`,
    ]),
    "",
  ];
  return sections.join("\n");
}

/** 基于模板的 Containerfile：没有网页界面就去掉浏览器验收那段。 */
export function containerfileSource(template: string, f: ProjectFacts): string {
  let out = template;
  if (!f.webUi) out = out.replace(/# 浏览器验收[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*\n\n/, "");
  const toolchain: Partial<Record<ProjectFacts["language"], string>> = {
    python:
      "RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/* && pip3 install --break-system-packages uv\n\n",
    go: 'RUN curl -fsSL https://go.dev/dl/go1.24.0.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz\nENV PATH="/usr/local/go/bin:$PATH"\n\n',
    rust: "RUN apt-get update && apt-get install -y build-essential && rm -rf /var/lib/apt/lists/*\n\n",
  };
  const extra = toolchain[f.language];
  if (extra) out = out.replace("# Build-args for UID/GID", `# ${f.language} 工具链\n${extra}# Build-args for UID/GID`);
  if (f.forge.kind === "gitlab")
    out = out.replace("# Install GitHub CLI", "# TODO：远端是 GitLab，要装 glab（GitLab Forge 还没做）\n# Install GitHub CLI");
  return out;
}

/** 流水线在 worktree 里写、不提交的目录（浏览器验收产物、playwright-cli 会话、验收说明）。 */
export const WORKSPACE_IGNORES = [".browser-check/", ".playwright-cli/", ".pr-notes/"];

/** 项目根目录 .gitignore 补上流水线的工作目录；已有的不重复加。返回新内容，不用改时返回 undefined。 */
export function mergeGitignore(existing: string): string | undefined {
  const have = new Set(existing.split("\n").map((l) => l.trim().replace(/^\//, "")));
  const missing = WORKSPACE_IGNORES.filter((p) => !have.has(p) && !have.has(p.slice(0, -1)));
  if (!missing.length) return undefined;
  const sep = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}# Sandcastle：沙箱里浏览器验收的截图与结论、playwright-cli 会话、验收说明（编排脚本读出后附到 PR，不提交）\n${missing.join("\n")}\n`;
}

type HookEntry = { matcher: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/** 在 .claude/settings.json 里登记上下文预算 hook；已登记的不重复加。 */
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
// ---------------------------------------------------------------------------

type Outcome = { file: string; status: "写入" | "已存在，跳过" | "已更新" | "无需改动" };

function writeIfMissing(root: string, file: string, content: string | (() => string)): Outcome {
  const path = join(root, file);
  if (existsSync(path)) return { file, status: "已存在，跳过" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : content());
  return { file, status: "写入" };
}

const tool = (p: string) => readFileSync(join(TOOL_ROOT, p), "utf8");

export function installFiles(root: string, f: ProjectFacts): Outcome[] {
  const out: Outcome[] = [
    writeIfMissing(root, ".sandcastle/sandcastle.config.ts", () => configSource(f, importSpecifier(root))),
    writeIfMissing(root, ".sandcastle/PROJECT.md", () => projectDocDraft(f)),
    writeIfMissing(root, ".sandcastle/models.json", () => tool("templates/.sandcastle/models.json")),
    writeIfMissing(root, ".sandcastle/.env.example", () => tool("templates/.sandcastle/.env.example")),
    writeIfMissing(root, ".sandcastle/.gitignore", () => tool("templates/.sandcastle/.gitignore")),
    writeIfMissing(root, ".sandcastle/Containerfile", () => containerfileSource(tool("templates/.sandcastle/Containerfile"), f)),
    writeIfMissing(root, `.claude/hooks/${HOOK_FILE}`, () => tool(`claude/hooks/${HOOK_FILE}`)),
    writeIfMissing(root, ".claude/agents/screenshot-checker.md", () => tool("claude/agents/screenshot-checker.md")),
  ];
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
  out.push({ file: ".gitignore", status: ignoreAfter === undefined ? "无需改动" : ignoreBefore ? "已更新" : "写入" });
  out.push({ file: ".claude/settings.json", status: changed ? (Object.keys(existing).length ? "已更新" : "写入") : "无需改动" });
  return out;
}

// ---------------------------------------------------------------------------
// agent 补全 PROJECT.md
// ---------------------------------------------------------------------------

export function onboardPrompt(f: ProjectFacts): string {
  const facts = JSON.stringify({ ...f, root: undefined }, null, 2);
  return tool("prompts/onboard.md")
    .replace("{{FACTS}}", () => facts)
    .replace("{{TEMPLATE}}", () => tool("templates/.sandcastle/PROJECT.md"))
    .replace("{{EXAMPLE}}", () => tool("examples/duckdb_crm/PROJECT.md"));
}

function runAgent(root: string, f: ProjectFacts, model: string): string {
  const allowed = [
    "Read",
    "Grep",
    "Glob",
    "Edit(.sandcastle/PROJECT.md)",
    "Bash(git log:*)",
    "Bash(git ls-files:*)",
    "Bash(ls:*)",
    "Bash(wc:*)",
    "Bash(grep:*)",
    "Bash(sed -n:*)",
    "Bash(head:*)",
  ];
  return execFileSync(
    "claude",
    ["-p", onboardPrompt(f), "--model", model, "--allowedTools", allowed.join(","), "--output-format", "text"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30 * 60_000,
    },
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function onboard(argv: string[], root = process.cwd()) {
  const noAgent = argv.includes("--no-agent");
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : "opus";

  const f = detectProject(root);
  console.log(
    `探测：${f.name}（${f.language}${f.packageManager ? ` / ${f.packageManager}` : ""}），远端 ${f.remote} → ${f.forge.kind}${f.forge.path ? ` ${f.forge.path}` : ""}，基线 ${f.baseBranch}`,
  );
  console.log(
    `  命令：${
      Object.entries(f.commands)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join("；") || "（没探测到）"
    }`,
  );
  console.log(
    `  文档：${f.docs.join("、") || "（无）"}；测试目录：${f.testDirs.join("、") || "（无）"}；服务：${f.services.join("、") || "（无）"}；迁移：${f.migrations ? `${f.migrations.tool} ${f.migrations.dir}` : "（无）"}；网页界面：${f.webUi ? "有" : "无"}`,
  );
  if (f.forge.kind === "gitlab") console.warn("  ⚠ 远端是 GitLab：GitLab Forge 还没做，文件照常生成，但先别跑");

  const docExisted = existsSync(join(root, ".sandcastle/PROJECT.md"));
  for (const o of installFiles(root, f))
    console.log(`  ${o.status === "已存在，跳过" || o.status === "无需改动" ? "·" : "✓"} ${o.file}：${o.status}`);

  if (noAgent || docExisted) {
    if (docExisted) console.log("PROJECT.md 已存在，不再让 agent 重写。");
  } else {
    console.log(`\n让 agent（${model}）读代码补全 .sandcastle/PROJECT.md，几分钟……`);
    try {
      const notes = runAgent(root, f, model);
      mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
      writeFileSync(join(root, ".sandcastle/logs/onboard.md"), notes);
      console.log(`\n${notes.trim()}\n（已存到 .sandcastle/logs/onboard.md）`);
    } catch (e) {
      console.warn(`  ⚠ agent 补全失败，PROJECT.md 保留草稿：${String((e as Error).message).slice(0, 300)}`);
    }
  }

  try {
    parseProjectDoc(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8"));
    console.log("✓ PROJECT.md 校验通过");
  } catch (e) {
    console.warn(`⚠ PROJECT.md 校验没过：${(e as Error).message}`);
  }

  console.log(
    [
      "",
      "接下来：",
      "  1. 看一遍 .sandcastle/PROJECT.md 和 sandcastle.config.ts（门槛、测试隔离），改成符合项目实际的样子",
      "  2. cp .sandcastle/.env.example .sandcastle/.env，填 token",
      `  3. 建镜像：podman build -t ${defaultImageName(root)} -f .sandcastle/Containerfile .sandcastle`,
      `  4. sandcastle-pipeline doctor --fix 检查一遍（顺带建好标签），然后给一张小票打上 Sandcastle 标签试跑：SANDCASTLE_ONLY=<票号> sandcastle-pipeline`,
      `  （生成的配置 import 自 ${importSpecifier(root)}）`,
    ].join("\n"),
  );
}
