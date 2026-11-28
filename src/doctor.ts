// doctor：跑流水线之前把能在宿主机上查的都查一遍，每项给出结论和修法。
// 查：仓库根目录、配置能加载、宿主机依赖与 env 文件、PROJECT.md 与提示词能渲染、浏览器验收、合并条件（有 CI workflow 却不等检查时警告）、项目知识（缺口清单）、models.json、.env 的 token、通知 webhook（--notify-test 时发一条测试消息）、平台登录与权限、
// 标签、镜像（--fix 时补建 / 直接建，与 Containerfile 不一致时报过期、--fix 重建）、Sandcastle 票的 Blocked by 引用、开着的 main-broken 票、远端基础分支、沙箱镜像、门槛依赖的服务、磁盘剩余空间（工作目录、容器存储）、上下文预算 hook、.gitignore 里的工作目录、.claude/ 里本工具的文件、是否有新版本。
// 有一项 ✗ 退出码就是 1。
// doctor: before running the pipeline, check everything that can be checked on the host, giving a verdict and a fix for each.
// Checks: repository root, config loads, host dependencies and env files, PROJECT.md and prompts render, browser check, merge requirements (warns when there are CI workflows but checks aren't awaited), project knowledge (open questions list), models.json, .env tokens, the notify webhook (a test message with --notify-test), forge login and permissions,
// labels and the image (created / built with --fix, reported stale and rebuilt with --fix when it doesn't match the Containerfile), Blocked by references in Sandcastle tickets, open main-broken tickets, remote base branch, sandbox image, gate services, free disk space (working directory, container storage), context budget hook, working directories in .gitignore, this tool's files in .claude/, newer versions.
// Exit code 1 if any check is ✗.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/podman";
import { browserSetupWarning } from "./browser-gate.ts";
import { detectProject } from "./detect.ts";
import type { Forge, IssueState } from "./forge.ts";
import { blockersOf } from "./guide.ts";
import { messages } from "./i18n.ts";
import { buildImageArgs, containerfileHash, findContainerfile, imageLabel } from "./lifecycle.ts";
import { inspectModels } from "./models.ts";
import { createNotifier } from "./notify.ts";
import { setTermLanguage, t, termLanguage } from "./term.ts";
import { CLAUDE_FILES, fillDocsHint, manual, HOOK_FILE, hasGlobalSkill, staleGlobalSkillFiles, TODO_MARK, mergeGitignore, mergeSandcastleIgnore, toolFile, typesTsconfig } from "./onboard.ts";
import { OPEN_QUESTIONS, readOpenQuestions } from "./open-questions.ts";
import { CONFIG_FILE, configDir, loadProject, type Labels, type Project } from "./profile.ts";
import { containerStorePath, DEFAULT_MIN_FREE_GB, diskProblems, probeTcp, type Probe, type Statfs } from "./preflight.ts";
import { loadProjectDoc, renderPrompts } from "./project-doc.ts";
import { trySh, type TryResult } from "./shell.ts";
import { latestVersion, newer, VERSION } from "./version.ts";

export type Level = "ok" | "warn" | "fail";
export type Check = { name: string; level: Level; detail: string; fix?: string };
export type Runner = (cmd: string, args: string[]) => TryResult;

const ENV_FILE = ".sandcastle/.env";
const CLAUDE_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/**
 * --fix 补建标签用的颜色和说明（中文、英文）；说明写到平台上，按项目的 language 选。
 * Colors and descriptions (Chinese, English) for labels created by --fix; descriptions go to the forge, so they follow the project's language.
 */
const LABEL_META: Record<keyof Labels, [color: string, zh: string, en: string]> = {
  picked: ["5319e7", "交给 Sandcastle 无人值守地做", "Hand to Sandcastle to work unattended"],
  prepped: ["c5def5", "Sandcastle prep 已确认可实现", "Sandcastle prep confirmed it can be implemented"],
  prOpen: ["0e8a16", "Sandcastle 已开 PR，等人审", "Sandcastle opened a PR, waiting for review"],
  merging: ["bfdadc", "Sandcastle 已开 PR、门槛已过，在等检查 / 合并", "Sandcastle opened the PR and the gate passed; waiting for checks / merging"],
  reviewed: ["c2e0c6", "Sandcastle 评审已通过、正在跑门槛", "Review passed; Sandcastle is running the gate"],
  stuck: ["d93f0b", "Sandcastle 做不下去，需要人介入（见评论）", "Sandcastle is stuck and needs a human (see comments)"],
  decided: ["fef2c0", "agent 代拍板过设计决定，等人事后确认", "The agent made a design decision; confirm it afterwards"],
  flaky: ["fbca04", "偶发失败的测试（Sandcastle 门槛自动开票）", "Flaky test (opened automatically by the Sandcastle gate)"],
  mainBroken: ["d73a4a", "main 上的兜底完整测试失败（Sandcastle 自动开票）", "Fallback full test run on main failed (opened automatically by Sandcastle)"],
  waitingMain: ["d4c5f9", "被 main-broken 挡住留 PR 的票；main 修好后自动 rebase 重跑门槛再合并", "Held as a PR by a main-broken ticket; auto-rebased and re-gated once main is fixed"],
  readyForAgent: ["0075ca", "可以交给 agent 做", "Ready for an agent"],
  readyForHuman: ["e4e669", "需要人来做", "Needs a human"],
  needsTriage: ["d876e3", "票的作者没有写权限，等有写权限的人确认", "Ticket author lacks write access; waiting for a maintainer"],
  trusted: ["0e8a16", "有写权限的人确认过这张票可以交给 Sandcastle", "A maintainer confirmed this ticket can go to Sandcastle"],
};

/**
 * 流水线第一次用到时自己建（main.ts 里 ensureLabel），缺了不算问题。
 * Created by the pipeline when first needed (ensureLabel in main.ts), so missing ones aren't a problem.
 */
const AUTO_LABELS: (keyof Labels)[] = ["flaky", "mainBroken", "waitingMain", "merging", "reviewed", "needsTriage", "trusted"];

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 没声明 hostEnvFiles 时的启发式：取 config 源码里引号包着的 .env 或 .env.<后缀> 路径（.envrc 这类不算），去掉 .sandcastle/ 下的和示例文件；读不了源码就当没有。
 * Heuristic used when hostEnvFiles isn't declared: take quoted .env or .env.<suffix> paths from the config source (not .envrc and the like), dropping ones under .sandcastle/ and example files; an unreadable source counts as none.
 */
function scanEnvFiles(configFile: string): string[] {
  let source: string;
  try {
    source = readFileSync(configFile, "utf8");
  } catch {
    return [];
  }
  const found = [...source.matchAll(/["'`](\.env(?:\.[\w.-]+)?)["'`]/g)].map((m) => m[1]!);
  return [...new Set(found)].filter((p) => !p.startsWith(".sandcastle/") && !p.endsWith(".example") && !p.endsWith(".sample"));
}

export async function diagnose(opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  /** 测试里换成假实现；默认用配置里的 forge / A fake in tests; defaults to the config's forge */
  forge?: Forge;
  /** 缺的标签和镜像直接建上 / Create missing labels and the image */
  fix?: boolean;
  /**
   * --fix 建镜像用的函数（out 是构建的 stderr）；测试里换成假实现。
   * 默认直接 spawnSync podman（不走 run：那有 60s 超时，构建常常更久），stdout / stderr 原样进终端，不设超时。
   * Used by --fix to build the image (out is the build's stderr); a fake in tests.
   * By default spawns podman directly (not via run: its 60s timeout is often too short for builds), with stdout / stderr going to the terminal as is and no timeout.
   */
  build?: (args: string[]) => { ok: boolean; out: string };
  /** 查最新发布的版本；不给就不查（测试里不连网） / Looks up the latest release; not checked when absent (no network in tests) */
  latest?: () => Promise<string | undefined>;
  /** 连门槛依赖的服务；测试里换成假实现，默认 probeTcp / Connects to the gate's services; a fake in tests, probeTcp by default */
  probe?: Probe;
  /** 量磁盘剩余空间；不给就跳过「磁盘」一节（测试里不碰真实磁盘） / Measures free disk space; the Disk section is skipped when absent (no real disk in tests) */
  statfs?: Statfs;
  /** 检查通知 webhook；不给就跳过「通知」一节（测试里不连网） / Checks the notify webhook; the Notify section is skipped when absent (no network in tests) */
  notifyFetch?: typeof fetch;
  /** --notify-test：发一条测试消息（--fix 时不发，只做连通检查） / --notify-test: send a test message (not with --fix, which only checks reachability) */
  notifyTest?: boolean;
}): Promise<Check[]> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const run: Runner = opts.run ?? ((cmd, args) => trySh(cmd, args, 60_000));
  // 构建不能走 run（60s 超时），trySh 的 stdio 是 pipe、构建输出也显示不出来，所以单独 spawnSync。
  // The build can't go through run (its 60s timeout is often too short), and trySh's stdio is pipe so the build output wouldn't show; hence a separate spawnSync.
  const build = opts.build ?? ((args: string[]) => {
    const r = spawnSync("podman", args, { stdio: ["inherit", "inherit", "pipe"] });
    const out = r.stderr?.toString() ?? "";
    if (out) process.stderr.write(out);
    return { ok: r.status === 0, out };
  });
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string, fix?: string) => checks.push({ name, level, detail, fix });
  const rel = (p: string) => relative(cwd, p) || ".";

  // 先读配置：之后所有检查项的输出都跟项目语言。
  // Load the config first so every check's output follows the project's language.
  const dir = configDir(cwd, env);
  let project: Project | undefined;
  let configError: unknown;
  try {
    project = await loadProject(dir);
    setTermLanguage(project.language, env);
  } catch (e) {
    configError = e;
  }

  // ---- 仓库 ---- / Repository
  const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!top.ok) add(t("仓库", "Repository"), "fail", t("当前目录不是 git 仓库", "The current directory isn't a git repository"), t("在目标项目的根目录运行", "Run it in the target project's root"));
  else if (realpathSync(top.out.trim()) !== realpathSync(cwd))
    add(t("仓库", "Repository"), "fail", t(`不在仓库根目录（根目录是 ${top.out.trim()}）`, `Not in the repository root (the root is ${top.out.trim()})`), t("cd 到仓库根目录再运行", "cd to the repository root and run again"));
  else add(t("仓库", "Repository"), "ok", cwd);

  // ---- 配置 ---- / Config
  if (project) add(t("配置", "Config"), "ok", rel(join(dir, "sandcastle.config.ts")));
  else add(t("配置", "Config"), "fail", errText(configError), t("没有配置先跑 sandpipe onboard", "No config yet: run sandpipe onboard first"));

  // ---- 宿主机依赖 ---- / Host dependencies
  // copyToWorktree 从宿主机拷，cleanup 也在宿主机跑：刚 clone 的仓库没装依赖，沙箱拿不到 node_modules，回收脚本也起不来。
  // copyToWorktree copies from the host and cleanup runs on the host: a fresh clone without dependencies gives the sandbox no node_modules and the cleanup script can't start.
  if (project?.install.copyToWorktree?.length) {
    const paths = project.install.copyToWorktree;
    const missing = paths.filter((p) => !existsSync(join(cwd, p)));
    if (missing.length)
      add(
        t("宿主机依赖", "Host dependencies"),
        "warn",
        t(`copyToWorktree 里的 ${missing.join("、")} 在宿主机上不存在`, `${missing.join(", ")} from copyToWorktree don't exist on the host`),
        t("先在宿主机装一次依赖（比如 pnpm install）", "Install dependencies on the host first (e.g. pnpm install)"),
      );
    else add(t("宿主机依赖", "Host dependencies"), "ok", paths.join(t("、", ", ")));
  }

  // ---- 宿主机 env 文件 ---- / Host env files
  // isolation.env 常在宿主机读项目根的 .env / .env.test；新克隆的仓库没有它们（被 gitignore），config 不报错，只是悄悄少注入变量。
  // isolation.env often reads .env / .env.test from the project root on the host; a fresh clone lacks them (gitignored), and the config doesn't fail, it just silently injects fewer variables.
  if (project) {
    const envFiles = project.isolation.hostEnvFiles ?? scanEnvFiles(join(dir, CONFIG_FILE));
    const missing = envFiles.filter((p) => !existsSync(join(cwd, p)));
    if (missing.length)
      add(
        t("宿主机 env 文件", "Host env files"),
        "warn",
        t(
          `config 读取的 ${missing.join("、")} 在宿主机上不存在，进沙箱的环境变量会悄悄变少`,
          `${missing.join(", ")} read by the config don't exist on the host, so the sandbox silently gets fewer environment variables`,
        ),
        t("从 .env.example 复制一份或向同事要，再重跑 doctor", "Copy them from .env.example or ask a teammate, then run doctor again"),
      );
    else if (envFiles.length) add(t("宿主机 env 文件", "Host env files"), "ok", envFiles.join(t("、", ", ")));
  }
  const forge = opts.forge ?? project?.forge;

  // ---- PROJECT.md 与提示词 ---- / PROJECT.md and prompts
  // 解析失败时 doc 留空，后面的浏览器验收检查跳过。
  // doc stays undefined when parsing fails, and the browser check below is skipped.
  let doc: ReturnType<typeof loadProjectDoc> | undefined;
  try {
    doc = loadProjectDoc(dir);
    if (project && forge)
      rmSync(dirname(Object.values(renderPrompts({ doc, forgeGuide: forge.agentGuide(), labels: project.labels, dir, language: project.language }))[0]!), {
        recursive: true,
      });
    const source = readFileSync(join(dir, "PROJECT.md"), "utf8");
    const todo = source.match(TODO_MARK)?.length ?? 0;
    if (todo)
      add(
        "PROJECT.md",
        "warn",
        t(`还有 ${todo} 处「待补」，是没写完的草稿`, `${todo} TODO marker(s) left, the draft isn't finished`),
        t("跑 onboard 让 agent 补全，或手工写完", "Run onboard to let the agent finish it, or finish it by hand"),
      );
    else add("PROJECT.md", "ok", t("能渲染进提示词", "renders into the prompts"));
  } catch (e) {
    add("PROJECT.md", "fail", errText(e));
  }

  // ---- 浏览器验收 ---- / Browser check
  // 启发式检查，只警告：探测到网页界面或配了 browser.pagePaths，但 PROJECT.md 没写怎么在沙箱里起 dev server，改页面的票只能留给人看；
  // 文案和 run 启动时的警告共用 browserSetupWarning。PROJECT.md 解析失败上面已经报过，这里跳过。
  // A heuristic check that only warns: a web UI was detected or browser.pagePaths is set, but PROJECT.md doesn't say how to start the dev server in the sandbox, so tickets that change pages are left for a human;
  // the text is shared with run's startup warning via browserSetupWarning. A PROJECT.md parse failure was already reported above, so skip it here.
  if (doc && ((project?.browser.pagePaths.length ?? 0) > 0 || detectProject(cwd).webUi)) {
    const name = t("浏览器验收", "Browser check");
    if (doc.hasBrowser) add(name, "ok", t("PROJECT.md 写了浏览器验收", "PROJECT.md has a browser check"));
    else add(name, "warn", browserSetupWarning(manual("config", termLanguage())));
  }

  // ---- 合并条件 ---- / Merge requirements
  // 只看本地 .github/workflows，不查分支保护（读规则要 admin 权限）；只警告，--fix 不处理。配置加载失败时没有这一项。
  // Only looks at the local .github/workflows, not branch protection (reading the rules needs admin); only warns, --fix leaves it alone. Absent when the config fails to load.
  if (project) {
    const name = t("合并条件", "Merge requirements");
    const mode = project.mergeRequires.checks;
    const workflows = join(cwd, ".github/workflows");
    const hasWorkflow = existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f));
    if (!project.autoMerge) add(name, "ok", t("不自动合并（autoMerge: false），PR 留给人合并", "No auto-merge (autoMerge: false): PRs are left for a human to merge"));
    else if (mode === "none" && hasWorkflow)
      add(
        name,
        "warn",
        t(
          "仓库有 CI workflow，但 mergeRequires.checks 是 none：合并只看门槛、不等 CI",
          "The repository has CI workflows but mergeRequires.checks is none: merging only looks at the gate and doesn't wait for CI",
        ),
        t(
          `CI 覆盖了门槛没覆盖的东西时，要么加进 gate.script，要么把 checks 改回 "all" / "required"（见 ${manual("config", "zh")}）`,
          `If CI covers things the gate doesn't, either add them to gate.script or set checks back to "all" / "required" (see ${manual("config", "en")})`,
        ),
      );
    else
      add(
        name,
        "ok",
        mode === "all"
          ? t("门槛 + PR 上所有检查", "Gate + all checks on the PR")
          : mode === "required"
            ? t("门槛 + PR 上的必需检查", "Gate + required checks on the PR")
            : t("只看门槛（没有 CI workflow）", "Gate only (no CI workflows)"),
      );
  }

  // ---- 受保护路径 ---- / Protected paths
  // 只列出来给人看，状态总是 ok。配置加载失败时没有这一项。
  // Only listed for a human to see; always ok. Absent when the config fails to load.
  if (project)
    add(
      t("受保护路径", "Protected paths"),
      "ok",
      project.protectedPaths.length ? project.protectedPaths.map(String).join(t("、", ", ")) : t("未配置", "not configured"),
    );

  // ---- 项目知识 ---- / Project knowledge
  // 没有 PROJECT.md 时不查：上面已经提示先跑 onboard，这里再提示 --questions-only 会误导；清单路径相对仓库根，所以读 cwd 不读 dir。
  // Skipped without PROJECT.md: the checks above already say to run onboard, and suggesting --questions-only here would mislead; the list's path is relative to the repo root, so read cwd, not dir.
  if (existsSync(join(dir, "PROJECT.md"))) {
    const name = t("项目知识", "Project knowledge");
    try {
      const questions = readOpenQuestions(cwd);
      if (questions === null)
        add(
          name,
          "warn",
          t(`没有缺口清单 ${OPEN_QUESTIONS}`, `No open questions list ${OPEN_QUESTIONS}`),
          t("运行 sandpipe onboard --questions-only 生成", "Run sandpipe onboard --questions-only to generate it"),
        );
      else if (questions.length) add(name, "warn", fillDocsHint(questions.length));
      else add(name, "ok", t("缺口清单已经补完", "Open questions list is cleared"));
    } catch (e) {
      add(name, "warn", errText(e), t(`改好 ${OPEN_QUESTIONS} 里报错的那一行`, `Fix the reported line in ${OPEN_QUESTIONS}`));
    }
  }

  // ---- models.json ----
  let models: ReturnType<typeof inspectModels> | undefined;
  try {
    models = withCwd(cwd, inspectModels);
    const summary = Object.entries(models.phases)
      .map(([p, list]) => `${p}=${list.join("→")}`)
      .join(" ");
    if (models.warnings.length) add("models.json", "warn", [summary, ...models.warnings].join(t("；", "; ")));
    else add("models.json", "ok", summary);
  } catch (e) {
    add(
      "models.json",
      "fail",
      errText(e),
      t("照 templates/.sandcastle/models.json 改；引用的 ${VAR} 要在 .sandcastle/.env 里列出", "Follow templates/.sandcastle/models.json; every ${VAR} it references must be listed in .sandcastle/.env"),
    );
  }

  // ---- .env ----
  let agentToken: string | undefined;
  const envPath = join(cwd, ENV_FILE);
  // .env 不存在时 vars 当空对象：下面的「通知」一节也读它（变量不存在就当没配 webhook）。
  // An absent .env leaves vars empty: the Notify section below reads it too (a missing variable means no webhook).
  const vars = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  if (!existsSync(envPath)) {
    add(".env", "fail", t(`没有 ${ENV_FILE}`, `No ${ENV_FILE}`), t(`cp ${ENV_FILE}.example ${ENV_FILE}，填 token`, `cp ${ENV_FILE}.example ${ENV_FILE} and fill in the tokens`));
  } else {
    const has = (k: string) => k in vars && Boolean(vars[k] || env[k]);
    const missing: string[] = [];
    // 有阶段用 Claude 自家的档案（没设 ANTHROPIC_BASE_URL）才要 Claude 凭据
    // Claude credentials are only needed when some phase uses a Claude profile (no ANTHROPIC_BASE_URL)
    if ((!models || models.used.some((p) => !p.thirdParty)) && !CLAUDE_KEYS.some(has)) missing.push(CLAUDE_KEYS.join(t(" 或 ", " or ")));
    if (forge && !has(forge.tokenEnv)) missing.push(forge.tokenEnv);
    const ignored = run("git", ["-C", cwd, "check-ignore", "-q", ENV_FILE]).ok;
    if (!ignored) add(
        ".env",
        "fail",
        t(`${ENV_FILE} 没被 git 忽略，token 会被提交`, `${ENV_FILE} isn't ignored by git; tokens would be committed`),
        t("在 .sandcastle/.gitignore 里加一行 .env", "Add a line .env to .sandcastle/.gitignore"),
      );
    else if (missing.length)
      add(
        ".env",
        "fail",
        t(
          `缺 ${missing.join("、")}（文件里要列出这个键；值可以空着、取宿主机的同名环境变量）`,
          `Missing ${missing.join(", ")} (the key must be listed in the file; the value may be empty to use the host's environment variable of the same name)`,
        ),
        t("Claude 订阅的 token 用 claude setup-token 生成", "Generate a Claude subscription token with claude setup-token"),
      );
    else add(".env", "ok", t("token 齐全，已被 git 忽略", "tokens present, ignored by git"));
    agentToken = forge ? vars[forge.tokenEnv] || env[forge.tokenEnv] : undefined;
  }

  // ---- 通知 ---- / Notify
  // 可选功能：连不上 / 发不出去只 warn，不挡运行。URL 是凭据，绝不能进 detail / fix（错误消息里带出来时先抹掉）。
  // Optional: an unreachable webhook or a failed send only warns and doesn't block the run. The URL is a credential and must never reach detail / fix (scrub it from error messages).
  if (project && opts.notifyFetch) {
    const doFetch = opts.notifyFetch;
    const name = t("通知", "Notify");
    // 不用 readNotifyUrl：它读全局 process.env，会忽略 diagnose 收到的 env（测试会被宿主机变量污染）。
    // Not readNotifyUrl: it reads the global process.env, ignoring the env diagnose received (host variables would pollute tests).
    const url = vars[project.notify.env] || env[project.notify.env] || undefined;
    const scrub = (text: string) => (url ? text.replaceAll(url, "…") : text);
    if (!url) add(name, "ok", t("未配置，不发通知", "not configured, no notifications"));
    else if (!opts.notifyTest || opts.fix) {
      // 只做连通检查：收到任何 HTTP 响应（哪怕 405）都算连得上；网络错误 / 超时是 warn。
      // Reachability only: any HTTP response (even 405) counts as reachable; a network error or timeout warns.
      try {
        await doFetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        add(name, "ok", t("连得上", "reachable"));
      } catch (e) {
        add(name, "warn", scrub(errText(e)));
      }
    } else {
      // --notify-test（不带 --fix）用 #132 的 notifier 发一条 test 消息；notifier 从不 reject、不返回状态码，
      // 所以包一层 fetcher 记下响应或错误，发完自己判 2xx。
      // --notify-test (without --fix) sends a test message via #132's notifier; the notifier never rejects and returns
      // no status, so wrap the fetcher to record the response or the error and judge 2xx ourselves afterwards.
      const outcome: { status?: number; error?: unknown } = {};
      const fetcher: typeof fetch = async (input, init) => {
        try {
          const res = await doFetch(input, init);
          outcome.status = res.status;
          return res;
        } catch (e) {
          outcome.error = e;
          throw e;
        }
      };
      await createNotifier({ url, language: project.language, fetcher, warn: () => {} })({ event: "test", reason: messages(project.language).notifyTest });
      if (outcome.status !== undefined && outcome.status >= 200 && outcome.status < 300)
        add(name, "ok", t(`测试消息发到了（HTTP ${outcome.status}）`, `test message delivered (HTTP ${outcome.status})`));
      else if (outcome.status !== undefined)
        add(name, "warn", t(`测试消息没发出去（HTTP ${outcome.status}）`, `test message wasn't delivered (HTTP ${outcome.status})`));
      else add(name, "warn", scrub(errText(outcome.error)));
    }
  }

  // ---- 平台与标签 ---- / Forge and labels
  if (forge && project) {
    let reachable = false;
    try {
      add(t(`平台（${forge.name}）`, `Forge (${forge.name})`), "ok", forge.checkAccess());
      reachable = true;
    } catch (e) {
      add(t(`平台（${forge.name}）`, `Forge (${forge.name})`), "fail", errText(e));
    }
    if (reachable && agentToken) {
      try {
        add(`${forge.tokenEnv}`, "ok", forge.checkAgentToken(agentToken));
      } catch (e) {
        add(`${forge.tokenEnv}`, "fail", errText(e), t(`重新生成 token，填进 ${ENV_FILE}`, `Generate a new token and put it in ${ENV_FILE}`));
      }
    }
    if (reachable) {
      try {
        const existing = new Set(forge.listLabels());
        const missing = (Object.keys(project.labels) as (keyof Labels)[]).filter((k) => !existing.has(project.labels[k]));
        const names = (keys: (keyof Labels)[]) => keys.map((k) => project.labels[k]).join(t("、", ", "));
        const required = missing.filter((k) => !AUTO_LABELS.includes(k));
        const auto = names(missing.filter((k) => AUTO_LABELS.includes(k)));
        const later = missing.length > required.length ? t(`；${auto} 用到时自动建`, `; ${auto} are created when first needed`) : "";
        const L = t("标签", "Labels");
        if (!missing.length) add(L, "ok", t(`${Object.keys(project.labels).length} 个都在`, `all ${Object.keys(project.labels).length} present`));
        else if (opts.fix) {
          for (const k of missing) {
            const [color, zh, en] = LABEL_META[k];
            forge.ensureLabel(project.labels[k], color, project.language === "en" ? en : zh);
          }
          add(L, "ok", t(`补建了 ${names(missing)}`, `created ${names(missing)}`));
        } else if (required.length) {
          add(
            L,
            "fail",
            t(`缺 ${names(required)}：给票打标签会失败${later}`, `Missing ${names(required)}: labelling tickets will fail${later}`),
            t("sandpipe doctor --fix 补建", "sandpipe doctor --fix creates them"),
          );
        } else add(L, "ok", t(`都在${later}`, `present${later}`));
      } catch (e) {
        add(t("标签", "Labels"), "fail", errText(e));
      }
    }

    // ---- Blocked by ---- / Blocked by
    // 只警告：open 的 Sandcastle 票在 ## Blocked by 里引用了本仓库不存在的票，调度会把它打成 stuck，接入时就提示。单个 blocker 查询出错（不是 missing）记成 open，即跳过它。名字是票里的节名，中英相同。
    // Warn only: an open Sandcastle ticket whose ## Blocked by references a ticket that doesn't exist in this repo gets marked stuck by the scheduler, so flag it at onboarding. A blocker whose lookup errors (other than missing) counts as open, i.e. is skipped. The name is the ticket's section name, the same in both languages.
    if (reachable) {
      const name = "Blocked by";
      try {
        const issues = forge.listOpenIssues([project.labels.picked]);
        const states = new Map<number, IssueState>();
        const stateOf = (m: number) => {
          if (!states.has(m)) {
            try {
              states.set(m, forge.issueState(String(m)));
            } catch {
              states.set(m, "open");
            }
          }
          return states.get(m);
        };
        const bad = issues.flatMap((i) => blockersOf(i.body).filter((m) => stateOf(m) === "missing").map((m) => `#${i.number} → #${m}`));
        if (!issues.length) add(name, "ok", t(`没有带 ${project.labels.picked} 标签的 open 票`, `No open tickets labelled ${project.labels.picked}`));
        else if (!bad.length) add(name, "ok", t(`查了 ${issues.length} 张票，引用都存在`, `checked ${issues.length} ticket(s), all references exist`));
        else
          add(
            name,
            "warn",
            t(`引用了不存在的票：${bad.join("、")}`, `References to tickets that don't exist: ${bad.join(", ")}`),
            t("改正票里的 ## Blocked by，或删掉这一行", "Fix the ticket's ## Blocked by, or remove the line"),
          );
      } catch (e) {
        add(name, "warn", errText(e));
      }
    }

    // ---- main 兜底测试 ---- / Main fallback test
    // 只警告：开着的 main-broken 票表示 main 上的兜底完整测试失败，期间其他票做完只留 PR、不自动合并（ADR 0007）；修复票由流水线排最前，不妨碍启动。
    // Warn only: an open main-broken ticket means the fallback full test run on main failed; while one is open, other tickets only get PRs and aren't merged automatically (ADR 0007). The pipeline schedules the fix ticket first, so this doesn't block startup.
    if (reachable) {
      const name = t("main 兜底测试", "Main fallback test");
      try {
        const broken = forge.listOpenIssues([project.labels.mainBroken]);
        if (broken.length) {
          const nums = broken.map((i) => `#${i.number}`).join(t("、", ", "));
          add(
            name,
            "warn",
            t(`开着的 main-broken 票：${nums}`, `Open main-broken ticket(s): ${nums}`),
            t("先修好这些票；期间其他票做完只开 PR、不自动合并", "Fix these tickets first; until then other tickets only get PRs and aren't merged automatically"),
          );
        } else add(name, "ok", t("没有开着的 main-broken 票", "No open main-broken tickets"));
      } catch (e) {
        add(name, "warn", errText(e));
      }
    }

    const ref = `refs/heads/${project.baseBranch}`;
    const remote = run("git", ["-C", cwd, "ls-remote", "--exit-code", project.remote, ref]);
    if (remote.ok) add(t("远端分支", "Remote branch"), "ok", `${project.remote}/${project.baseBranch}`);
    else
      add(
        t("远端分支", "Remote branch"),
        "fail",
        t(`${project.remote} 上没有 ${project.baseBranch}：`, `${project.baseBranch} doesn't exist on ${project.remote}: `) + firstLine(remote.out),
        t("检查配置里的 remote / baseBranch", "Check remote / baseBranch in the config"),
      );
  }

  // ---- 沙箱镜像 ---- / Sandbox image
  if (project?.customSandbox) {
    add(t("沙箱镜像", "Sandbox image"), "ok", t("配置里自定义了 sandbox，不查 podman", "the config sets its own sandbox; podman not checked"));
  } else if (project) {
    const image = defaultImageName(cwd);
    const containerfile = findContainerfile(cwd, dir);
    // 手动命令与 --fix 跑的同一条（带内容哈希 label，供后续判断镜像是否过期），路径换成相对仓库根的写法。
    // The manual command is the same one --fix runs (with the content hash label, to later tell whether the image is stale), paths made relative to the repo root.
    const buildCommand = containerfile
      ? ["podman", ...buildImageArgs(image, containerfile).map((a) => (isAbsolute(a) ? rel(a) : a))].join(" ")
      : t("先跑 onboard 生成 Containerfile", "Run onboard first to generate the Containerfile");
    const info = run("podman", ["info", "--format", "{{.Host.Arch}}"]);
    const S = t("沙箱镜像", "Sandbox image");
    // --fix 时按当前 Containerfile 建镜像（缺失时）或重建（过期时，和补建标签一样），构建输出原样进终端；失败不吞，detail 给 stderr 前几行。没带 --fix（或没有 Containerfile）时返回 undefined，由调用方报自己的说法。
    // With --fix, build the image from the current Containerfile (when missing) or rebuild it (when stale, like creating missing labels), the build output going to the terminal as is; a failure isn't swallowed, the detail carries the first few stderr lines. Without --fix (or with no Containerfile) it returns undefined and the caller reports its own message.
    const fixBuild = (okText: string) => {
      const built = opts.fix && containerfile ? build(buildImageArgs(image, containerfile)) : undefined;
      if (built?.ok) add(S, "ok", okText);
      else if (built)
        add(
          S,
          "fail",
          t("构建失败：", "build failed: ") + built.out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5).join(t("；", "; ")),
          buildCommand,
        );
      return built;
    };
    if (!info.ok) add(S, "fail", t("podman 用不了：", "podman isn't usable: ") + firstLine(info.out), t("装 podman；macOS 上 podman machine start", "Install podman; on macOS, podman machine start"));
    else if (!run("podman", ["image", "exists", image]).ok) {
      if (!fixBuild(t(`建好了镜像 ${image}`, `built the image ${image}`))) add(S, "fail", t(`没有镜像 ${image}`, `No image ${image}`), buildCommand);
    } else if (containerfile && imageLabel(image, run) !== containerfileHash(containerfile)) {
      // 镜像在，但 label 记的哈希和当前 Containerfile 对不上（或没 label，老镜像）：过期了；--fix 重建，否则 warn 提示。
      // The image exists but its label's hash doesn't match the current Containerfile (or there's no label, an old image): stale; --fix rebuilds it, otherwise a warn with the hint.
      if (!fixBuild(t(`重建了镜像 ${image}`, `rebuilt the image ${image}`)))
        add(S, "warn", t("Containerfile 改过，镜像过期", "The Containerfile changed; the image is stale"), t("sandpipe doctor --fix 重建", "sandpipe doctor --fix rebuilds it"));
    } else add(S, "ok", t(`${image}（改了 Containerfile 要重建：${buildCommand}）`, `${image} (rebuild after changing the Containerfile: ${buildCommand})`));
  }

  // ---- 门槛依赖的服务 ---- / Gate services
  // 每个声明的服务一行；地址是宿主机上的（sandpipe run 启动时也这样连）。 / One line per declared service; the address is the host's (sandpipe run connects the same way at startup).
  const probe = opts.probe ?? probeTcp;
  for (const s of project?.gate.services ?? []) {
    const addr = `${s.host}:${s.port}`;
    const error = await probe(s.host, s.port);
    const name = t(`门槛服务 ${s.name}`, `Gate service ${s.name}`);
    if (error === null) add(name, "ok", addr);
    else
      add(
        name,
        "fail",
        t(`${addr} 连不上：${error}`, `${addr} is unreachable: ${error}`),
        t("先把服务起来（sandpipe run 启动时也会检查）；地址不对就改配置里的 gate.services", "Start the service first (sandpipe run checks it at startup too); if the address is wrong, fix gate.services in the config"),
      );
  }

  // ---- 磁盘 ---- / Disk
  // 没给 statfs 就整节跳过（同 notifyFetch 的做法）：已有的 doctor 用例不碰真实磁盘，CI 上的剩余空间不确定。
  // The whole section is skipped without a statfs (like notifyFetch): existing doctor cases don't touch the real disk, and free space on CI isn't deterministic.
  if (opts.statfs) {
    const statfs = opts.statfs;
    const minFreeGb = project?.preflight.minFreeGb ?? DEFAULT_MIN_FREE_GB;
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    const diskRow = (name: string, path: string, unmeasurableFix?: string) => {
      const r = diskProblems([path], minFreeGb * 1024 ** 3, statfs)[0]!;
      if (r.status === "enough") add(name, "ok", t(`剩余 ${gb(r.freeBytes)} GB`, `${gb(r.freeBytes)} GB free`));
      else if (r.status === "low")
        add(
          name,
          "fail",
          t(`剩余 ${gb(r.freeBytes)} GB，少于阈值 ${minFreeGb} GB`, `${gb(r.freeBytes)} GB free, below the ${minFreeGb} GB threshold`),
          t("腾出空间：podman image prune、podman system prune、git worktree prune", "Free up space: podman image prune, podman system prune, git worktree prune"),
        );
      else add(name, "warn", t(`量不到：${r.error}`, `couldn't measure: ${r.error}`), unmeasurableFix);
    };
    diskRow(t("磁盘（工作目录）", "Disk (working dir)"), cwd);
    // 自定义了 sandbox 就没有 podman 的容器存储可量（同上面「沙箱镜像」一节的判断）
    // A custom sandbox means there's no podman container storage to measure (same judgement as the Sandbox image section above)
    if (!project?.customSandbox) {
      const name = t("磁盘（容器存储）", "Disk (container storage)");
      const store = containerStorePath(run);
      if (store === null) add(name, "warn", t("取不到容器存储路径（podman info 失败）", "couldn't get the container storage path (podman info failed)"));
      else
        diskRow(
          name,
          store,
          t("macOS 的 podman machine 下 GraphRoot 在虚拟机里，宿主机上量不到，可以忽略", "under macOS's podman machine the GraphRoot is inside the VM, so the host can't measure it; safe to ignore"),
        );
    }
  }

  // ---- 上下文预算 hook ---- / Context budget hook
  const settingsPath = join(cwd, ".claude/settings.json");
  const registered = existsSync(settingsPath) && readFileSync(settingsPath, "utf8").includes(HOOK_FILE);
  const present = existsSync(join(cwd, ".claude/hooks", HOOK_FILE));
  if (registered && present) add(t("上下文 hook", "Context hook"), "ok", `.claude/hooks/${HOOK_FILE}`);
  else
    add(
      t("上下文 hook", "Context hook"),
      "warn",
      t(
        `${present ? "" : "没有 hook 文件；"}${registered ? "" : "settings.json 里没登记；"}会话到预算时不会提醒收尾`,
        `${present ? "" : "no hook file; "}${registered ? "" : "not registered in settings.json; "}sessions won't be told to wrap up at the budget`,
      ),
      t("跑 onboard 补上（不覆盖已有文件）", "Run onboard to add it (existing files aren't overwritten)"),
    );

  // ---- .gitignore ----
  const ignorePath = join(cwd, ".gitignore");
  if (mergeGitignore(existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "") === undefined)
    add(".gitignore", "ok", t("流水线的工作目录都已忽略", "the pipeline's working directories are ignored"));
  else
    add(
      ".gitignore",
      "warn",
      t(
        "缺 .browser-check/ 等工作目录：implementer 的 git add -A 会把截图和验收说明提交进去",
        "Missing .browser-check/ and other working directories: the implementer's git add -A would commit screenshots and acceptance notes",
      ),
      t("跑 onboard 补上", "Run onboard to add them"),
    );

  // ---- 编辑器类型：.sandcastle/tsconfig.json 指向这份工具的声明文件，且不提交 ----
  // Editor types: .sandcastle/tsconfig.json points at this tool's declarations and isn't committed
  const read = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8") : "");
  const typesIssues = [
    read(".sandcastle/tsconfig.json") !== typesTsconfig() && t("tsconfig.json 缺失或指向别的版本", "tsconfig.json is missing or points at another version"),
    mergeSandcastleIgnore(read(".sandcastle/.gitignore")) !== undefined && t(".sandcastle/.gitignore 缺条目", ".sandcastle/.gitignore is missing entries"),
  ].filter(Boolean);
  const E = t("编辑器类型", "Editor types");
  if (!typesIssues.length) add(E, "ok", t(".sandcastle/tsconfig.json 指向当前版本的声明文件", ".sandcastle/tsconfig.json points at the current version's declarations"));
  else add(E, "warn", typesIssues.join(t("；", "; ")) + t('：编辑器里 import "sandpipe" 没有类型', ': import "sandpipe" has no types in the editor'), "sandpipe update");

  // ---- .claude/ 里本工具的文件是否是当前版本 ---- / Whether this tool's files in .claude/ are the current version
  const stale = Object.entries(CLAUDE_FILES)
    .filter(([file, src]) => {
      const path = join(cwd, file);
      return !existsSync(path) || readFileSync(path, "utf8") !== toolFile(src);
    })
    .map(([file]) => file);
  const C = t("Claude 文件", "Claude files");
  if (!stale.length) add(C, "ok", t("hook、子代理、skills 都是当前版本", "hook, subagent and skills are current"));
  else add(C, "warn", t("和当前版本不一致或缺失：", "Outdated or missing: ") + stale.join(t("、", ", ")), "sandpipe update");
  // 全局 skill 盖过项目里的同名 skill：装过的话它也得是当前版本
  // The global skill shadows the project's copy: if installed, it must be current too
  // 按 env.HOME 找（测试传的 env 没有 HOME，就不看本机的 ~/.claude）
  // Located via env.HOME (tests pass an env without HOME, so the machine's ~/.claude is not read)
  const claudeDir = env.HOME ? join(env.HOME, ".claude") : undefined;
  const staleGlobal = claudeDir && hasGlobalSkill(claudeDir) ? staleGlobalSkillFiles(claudeDir) : [];
  if (staleGlobal.length) add(C, "warn", t("全局 skill 不是当前版本（会盖过项目里的）：", "Global skill is outdated (it shadows the project's copy): ") + staleGlobal.join(t("、", ", ")), "sandpipe update");

  // ---- 沙箱里的 worktree 从远端基础分支建：hook、.gitignore 要已经推上去才生效 ----
  // The sandbox worktree is created from the remote base branch: the hook and .gitignore only apply once pushed
  if (project) {
    const base = `${project.remote}/${project.baseBranch}`;
    const needed = [".claude/settings.json", `.claude/hooks/${HOOK_FILE}`, ".gitignore"].filter((f) => existsSync(join(cwd, f)));
    const unpushed = needed.filter((f) => {
      const r = run("git", ["-C", cwd, "show", `${base}:${f}`]);
      return !r.ok || r.out.trim() !== readFileSync(join(cwd, f), "utf8").trim();
    });
    const P = t("已推送", "Pushed");
    if (!unpushed.length) add(P, "ok", t(`沙箱用到的 .claude/、.gitignore 和 ${base} 一致`, `.claude/ and .gitignore used by the sandbox match ${base}`));
    else
      add(
        P,
        "warn",
        t(
          `${unpushed.join("、")} 和 ${base} 不一致（按本地的远端分支比较）：沙箱从 ${base} 建分支，上下文 hook 和忽略规则在沙箱里不生效`,
          `${unpushed.join(", ")} differ from ${base} (compared with the local remote-tracking branch): the sandbox branches from ${base}, so the context hook and ignore rules won't apply there`,
        ),
        t("提交并推送 .claude/、.gitignore（.sandcastle/ 里除 .env、logs 外也建议提交）", "Commit and push .claude/ and .gitignore (committing .sandcastle/ apart from .env and logs is recommended too)"),
      );
  }

  // ---- 版本 ---- / Version
  if (opts.latest) {
    const latest = await opts.latest();
    const V = t("版本", "Version");
    if (!latest) add(V, "warn", t(`${VERSION}；查不到最新版本（网络或还没发版）`, `${VERSION}; couldn't look up the latest version (network, or not released yet)`));
    else if (newer(latest, VERSION)) add(V, "warn", t(`${VERSION}，最新是 ${latest}`, `${VERSION}, latest is ${latest}`), t("sandpipe upgrade，然后 sandpipe update", "sandpipe upgrade, then sandpipe update"));
    else add(V, "ok", t(`${VERSION} 是最新`, `${VERSION} is the latest`));
  }

  return checks;
}

/** models.ts 按 cwd 读 .sandcastle/models.json 与 .env。 / models.ts reads .sandcastle/models.json and .env relative to cwd. */
function withCwd<T>(cwd: string, fn: () => T): T {
  const before = process.cwd();
  if (resolve(before) === resolve(cwd)) return fn();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

const MARK: Record<Level, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  return checks
    .flatMap((c) => [`${MARK[c.level]} ${c.name}${t("：", ": ")}${c.detail}`, ...(c.level !== "ok" && c.fix ? [`    → ${c.fix}`] : [])])
    .join("\n");
}

export async function doctor(argv: string[]) {
  const checks = await diagnose({ fix: argv.includes("--fix"), latest: () => latestVersion(), notifyFetch: fetch, notifyTest: argv.includes("--notify-test"), statfs: statfsSync });
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  console.log(
    failed
      ? t(`\n${failed} 项不通过${warned ? `，${warned} 项警告` : ""}。`, `\n${failed} failed${warned ? `, ${warned} warning(s)` : ""}.`)
      : t(`\n可以跑了${warned ? `（${warned} 项警告）` : ""}。`, `\nReady to run${warned ? ` (${warned} warning(s))` : ""}.`),
  );
  if (failed) process.exitCode = 1;
}
