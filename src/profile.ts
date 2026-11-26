// ProjectProfile：编排脚本里随项目变的部分——托管平台、沙箱里怎么装依赖、每张票的测试环境怎么隔离、
// 合并门槛跑什么、合并前还要查什么、自动开的票怎么写。
//
// 项目在配置目录（默认 `.sandcastle/`，见 configDir）的 `sandcastle.config.ts` 里 `export default defineProject({...})`，main.ts 启动时加载
// （loadProject）。必填的只有 install / isolation / gate 三项，其余有默认值。
// 门槛脚本与 main.ts 之间的输出约定见 GateConfig。
// ProjectProfile: the project-specific part of the pipeline: the forge, how the sandbox installs dependencies, how each ticket's test environment is isolated,
// what the merge gate runs, what else to check before merging, and how auto-opened tickets are written.
// A project calls `export default defineProject({...})` in `sandcastle.config.ts` in its config directory (default `.sandcastle/`, see configDir), loaded by main.ts at startup
// (loadProject). Only install / isolation / gate are required; everything else has defaults.
// The output conventions between the gate script and main.ts are in GateConfig.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Forge, MergeMethod } from "./forge.ts";
import { githubForge } from "./forges/github.ts";
import { messages, type Language, type Messages } from "./i18n.ts";
import { t } from "./term.ts";

export const CONFIG_FILE = "sandcastle.config.ts";

/**
 * 项目配置目录：sandcastle.config.ts、PROJECT.md、可选的 prompts/ 放在这里。默认是目标项目的 `.sandcastle/`；
 * 设了 SANDCASTLE_PROJECT_DIR 就用它（相对路径按 cwd 解析），这样不往目标仓库里放文件也能跑（试用、外置配置）。
 * models.json、.env、logs/ 仍在目标项目的 `.sandcastle/`，不随它走。
 * Project config directory: sandcastle.config.ts, PROJECT.md and optional prompts/ live here. Defaults to the target project's `.sandcastle/`;
 * SANDCASTLE_PROJECT_DIR overrides it (relative to cwd), so it can run without putting files in the target repo (trials, external config).
 * models.json, .env and logs/ stay in the target project's `.sandcastle/` regardless.
 */
export function configDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return env.SANDCASTLE_PROJECT_DIR ? resolve(cwd, env.SANDCASTLE_PROJECT_DIR) : join(cwd, ".sandcastle");
}

/**
 * 合并门槛。script 在沙箱的 worktree 里用 `sh -c` 跑，退出码 0 算通过。输出约定（main.ts 解析）：
 * - 一行 `GATE_TIER: selected …` 表示只跑了选出来的测试，否则算完整测试；
 * - 失败的测试文件单独重跑后通过时输出 `GATE_FLAKY`，它前面列出的、匹配 testFile 的行是重跑过的文件，
 *   后面是第一次的失败摘要（摘要里 ` FAIL  <文件>` 行后面跟报错，用来给偶发失败去重开票）；
 * - 环境变量 GATE_FULL=1 时必须跑完整测试（main 上的兜底检查用）。
 * 门槛环境默认设 NO_COLOR=1、FORCE_COLOR=0（env 可以覆盖）；输出按纯文本逐行解析，ANSI 转义码会被去掉。
 * Merge gate. script runs with `sh -c` in the sandbox worktree; exit code 0 means pass. Output conventions (parsed by main.ts):
 * - a line `GATE_TIER: selected …` means only selected tests ran; otherwise it counts as the full suite;
 * - when failing test files pass on a solo rerun, print `GATE_FLAKY`; the lines before it that match testFile are the rerun files,
 *   and after it comes the first failure summary (` FAIL  <file>` lines followed by the error, used to dedupe flaky tickets);
 * - with environment variable GATE_FULL=1 the full suite must run (used by the fallback check on main).
 * The gate environment defaults to NO_COLOR=1 and FORCE_COLOR=0 (env can override them); output is parsed line by line as plain text, with ANSI escape codes stripped.
 */
export interface GateConfig {
  /** 门槛脚本；baseRef 是 `origin/main` 这样的远端基线。 / Gate script; baseRef is the remote base such as `origin/main`. */
  script(ctx: { baseRef: string }): string;
  /** 只给门槛加的环境变量（比如门槛独占资源时开更多 worker）。 / Environment variables only for the gate (e.g. more workers when the gate has resources to itself). */
  env?: Record<string, string>;
  /** 测试文件路径的正则（不带 ^$），用来从门槛输出里认出失败 / 重跑的文件。 / Regex for test file paths (no ^$), used to find failed / rerun files in the gate output. */
  testFile: RegExp;
  /**
   * 失败文件不超过这么多个时门槛脚本会单独重跑一次（写进 fix 提示词）。默认 3。
   * The gate script reruns failing files once when there are at most this many (stated in the fix prompt). Default 3.
   */
  rerunMax?: number;
  /** 留给人审的 PR rebase 后只跑这个（不跑测试）。 / The only thing run after rebasing a PR left for review (no tests). */
  typecheck: string;
  /**
   * PR 正文里「按依赖选」档位的说明，比如「按依赖选的测试（……）」。
   * Description of the "dependency-selected" tier in the PR body, e.g. "dependency-selected tests (…)".
   */
  selectedDescription?: string;
}

/**
 * 合并前的额外一致性检查（比如数据库迁移链没分叉）：rebase 没有文本冲突也可能坏。
 * Extra consistency check before merging (e.g. the database migration chain didn't fork): a rebase without text conflicts can still break it.
 */
export interface IntegrityCheck {
  /** 在 PR 评论里的名字，比如「迁移链」。 / Name used in PR comments, e.g. "migration chain". */
  name: string;
  /** shell 命令，退出码 0 表示 head 在 baseRef 之上是好的。 / Shell command; exit code 0 means head is good on top of baseRef. */
  command(head: string, baseRef: string): string;
  /**
   * 坏了时的一句话（不带句号），比如「本票的 drizzle 迁移没有接在 origin/main 最新的迁移后面」。
   * One sentence when broken (no period), e.g. "this ticket's drizzle migrations don't follow the latest migration on origin/main".
   */
  broken(baseRef: string): string;
}

export type FlakyIssueContext = {
  files: string[];
  /** 例如 `#12 的门槛（PR #34）` / e.g. the gate of #12 (PR #34) */
  seen: string;
  /** 开票时的环境（同时在做的票、负载） / Environment when the ticket was opened (tickets in progress, load) */
  env: string;
  /** 7 天内之前的出现，没有时为空串 / Earlier occurrences within 7 days; empty string when none */
  prior: string;
  /** 第一次失败的摘要（已包在 ``` 里） / Summary of the first failure (already wrapped in ```) */
  summary: string;
};

export type MainBrokenContext = { sha: string; summary: string; commits: string };

export type PromptContext = { issueId: string; branch: string; title: string; viewIssue: string };

export interface ProjectProfile {
  /** 托管平台，默认 GitHub（宿主机的 gh）。 / The forge; GitHub by default (the host's gh). */
  forge?: Forge;
  remote?: string;
  baseBranch?: string;
  mergeMethod?: MergeMethod;
  /**
   * reviewer 给 merge、门槛也过了时是否自动合并。默认 true；关掉时照样跑完全程，只是留 PR 等人合并
   * （新项目试跑期用，见 docs/onboarding-checklist.md）。
   * Whether to merge automatically when the reviewer says merge and the gate passes. Default true; when off, everything still runs but the PR is left for a human to merge
   * (for a new project's trial period, see docs/onboarding-checklist.md).
   */
  autoMerge?: boolean;
  /**
   * 合并条件是门槛 + forge 检查。checks："all" 等 PR 上所有检查（默认），"required" 只等分支保护要求的，
   * "none" 只看门槛（CI 不可靠或门槛已覆盖 CI 时用）；PR 上没有检查时不阻塞。timeoutMinutes 是最多等多久，默认 30。
   * Merging requires the gate plus forge checks. checks: "all" waits for every check on the PR (default), "required" only for those required by branch protection,
   * "none" looks at the gate only (for unreliable CI or when the gate already covers CI); a PR without checks isn't blocked. timeoutMinutes is how long to wait at most, default 30.
   */
  mergeRequires?: { checks?: "none" | "required" | "all"; timeoutMinutes?: number };
  /**
   * issue、PR、评论用什么语言写（agent 写的和脚本写的都算），以及终端输出的语言："zh" 或 "en"。默认 "zh"。
   * 提交信息的语言另由 PROJECT.md「提交」一节决定；SANDPIPE_LANG 可单独指定终端语言。
   * Language for issues, PRs and comments (both what the agent and the script write) and for terminal output: "zh" or "en". Default "zh".
   * Commit message language is set separately by PROJECT.md's commit section; SANDPIPE_LANG overrides the terminal language.
   */
  language?: Language;

  /**
   * 同时实现的票数，受测试依赖的服务（数据库连接数等）与机器负载限制。默认 2。
   * Tickets implemented at once, limited by the services the tests use (database connections etc.) and machine load. Default 2.
   */
  maxParallel?: number;
  /** agent 多久没输出算卡死（秒）。默认 40 分钟。 / Seconds without agent output before it counts as stuck. Default 40 minutes. */
  agentIdleTimeoutS?: number;
  /** 有空位时隔多久重新调度一次。默认 10 分钟。 / How often to reschedule when a slot is free. Default 10 minutes. */
  pollIntervalMs?: number;
  /** 连续多少次空转就结束运行。默认 12。 / Idle polls in a row before the run ends. Default 12. */
  maxIdlePolls?: number;
  /** 一张票最多开几次全新的 implement 会话。默认 3。 / Maximum fresh implement sessions per ticket. Default 3. */
  implementMaxSessions?: number;
  /** reviewer 最多打回几次。默认 2。 / Maximum times the reviewer sends a ticket back. Default 2. */
  reviseMax?: number;
  /** 单个会话的上下文预算（token）。默认 150k。 / Context budget per session (tokens). Default 150k. */
  contextBudget?: number;
  /**
   * 按依赖选测试的票每合并几张，对 main 跑一次完整测试兜底。默认 4。
   * After every this many merged dependency-selected tickets, run the full suite on main as a fallback. Default 4.
   */
  mainCheckEvery?: number;

  /** 标签名。默认见 DEFAULT_LABELS。 / Label names. Defaults in DEFAULT_LABELS. */
  labels?: Partial<Labels>;

  /** 沙箱；默认 podman，env 是要进容器的环境变量。 / Sandbox; podman by default, env holds the variables passed into the container. */
  sandbox?: (env: Record<string, string>) => SandboxProvider;
  install: {
    /** 沙箱建好后跑的命令（装依赖）。 / Command run once the sandbox is ready (installs dependencies). */
    onSandboxReady: string;
    /** 从宿主机拷进 worktree 的路径（省掉从头安装）。 / Paths copied from the host into the worktree (saves a full install). */
    copyToWorktree?: string[];
  };

  /**
   * 每张票（runId 是票号，main 上的兜底检查是 "main"）的测试环境隔离。
   * Test environment isolation per ticket (runId is the ticket number; the fallback check on main uses "main").
   */
  isolation: {
    /** 进沙箱的环境变量：独立的测试库、前缀等。 / Environment variables passed into the sandbox: a separate test database, prefixes, etc. */
    env(runId: string): Record<string, string>;
    /** 关沙箱后回收这张票的测试资源。失败只打日志，不抛错。 / Reclaim this ticket's test resources after the sandbox closes. Failures are only logged, never thrown. */
    cleanup?(runId: string): Promise<void>;
    /**
     * config 从宿主机读的 env 文件（相对项目根，比如 .env、.env.test），doctor 检查它们存在；不写就由 doctor 扫 config 源码里的 .env 字面量猜。
     * Env files the config reads on the host (relative to the project root, e.g. .env, .env.test); doctor checks they exist. When absent, doctor guesses by scanning the config source for .env literals.
     */
    hostEnvFiles?: string[];
  };

  gate: GateConfig;
  integrity?: IntegrityCheck;

  /**
   * 每次调度开头在宿主机上跑的维护（清日志等）。失败只打日志，不抛错。
   * Maintenance run on the host at the start of every pass (cleaning logs etc.). Failures are only logged, never thrown.
   */
  beforeSchedule?(): void;

  /**
   * 只追加的索引文件：几张票同时追加不算「改同一个文件」，可以并行。
   * Append-only index files: several tickets appending don't count as "changing the same file", so they can run in parallel.
   */
  appendOnlyFiles?: string[];

  /**
   * 改了页面的票，PR「验收说明」最前面的准备步骤（Markdown，含 ### 标题）。
   * For tickets that change pages, setup steps at the top of the PR's acceptance notes (Markdown, with ### headings).
   */
  acceptancePrep?(branch: string): string;

  /**
   * 浏览器验收。pagePaths：页面文件路径（相对仓库根）的正则，票改到匹配的文件就算「改了页面」；不写时为空，即不按路径判断。
   * 项目从纯后端加了前端时补上（见 docs/config.zh-CN.md「浏览器验收」）。
   * Browser checks. pagePaths: regexes for page file paths (relative to the repo root); a ticket touching a matching file counts as "changing pages". Empty when absent, i.e. no path-based judgement.
   * Add it when a backend-only project gains a frontend (see docs/config.md, "Browser check").
   */
  browser?: { pagePaths?: RegExp[] };

  /**
   * 自动开的票（偶发失败、main 坏了）与内联提示词的正文。不给时用通用版。
   * Bodies of auto-opened tickets (flaky, main broken) and inline prompts. Generic versions when not given.
   */
  texts?: {
    flakyIssueBody?(ctx: FlakyIssueContext): string;
    mainBrokenIssueBody?(ctx: MainBrokenContext): string;
    /**
     * reviewer 打回后给 implementer 的提示词，items 是修改意见。
     * Prompt for the implementer after the reviewer sends it back; items are the requested changes.
     */
    revisePrompt?(ctx: PromptContext & { items: string }): string;
    /** 门槛失败后给 implementer 的提示词，gateOutput 是摘要。 / Prompt for the implementer after the gate fails; gateOutput is the summary. */
    fixPrompt?(ctx: PromptContext & { gateOutput: string; rerunMax: number }): string;
  };
}

export type Labels = {
  picked: string;
  prepped: string;
  prOpen: string;
  merging: string;
  stuck: string;
  decided: string;
  flaky: string;
  mainBroken: string;
  readyForAgent: string;
  readyForHuman: string;
};

export const DEFAULT_LABELS: Labels = {
  picked: "Sandcastle", // 人工选中
  prepped: "sandcastle:prepped", // prep 已确认可实现
  prOpen: "sandcastle:pr-open", // 已开 PR，等人审
  merging: "sandcastle:merging", // 已开 PR、门槛已过，在等检查 / 合并；中断重启后接着等，不重新实现（脚本自动建标签）
  stuck: "sandcastle:stuck", // 需要人介入（见 issue 评论）
  decided: "sandcastle:decided", // agent 代拍板过设计决定，等人事后确认（人看过后去掉）
  flaky: "flaky", // 门槛里重跑才通过的测试文件，脚本自动开票
  mainBroken: "sandcastle:main-broken", // main 上的兜底完整测试失败，脚本自动开票；调度和 prep 时排最前
  readyForAgent: "ready-for-agent",
  readyForHuman: "ready-for-human",
};

/** 项目配置文件里用：只做类型检查，原样返回。 / For project config files: type checking only, returns its argument unchanged. */
export const defineProject = (profile: ProjectProfile): ProjectProfile => profile;

/** 填好默认值的配置，main.ts 只用这个。 / Config with defaults filled in; main.ts uses only this. */
export type Project = Required<
  Pick<
    ProjectProfile,
    | "forge" | "remote" | "baseBranch" | "mergeMethod" | "autoMerge" | "language" | "maxParallel" | "agentIdleTimeoutS" | "pollIntervalMs"
    | "maxIdlePolls" | "implementMaxSessions" | "reviseMax" | "contextBudget" | "mainCheckEvery" | "sandbox"
    | "install" | "isolation" | "appendOnlyFiles"
  >
> & {
  labels: Labels;
  mergeRequires: { checks: "none" | "required" | "all"; timeoutMinutes: number };
  gate: GateConfig & { rerunMax: number; selectedDescription: string };
  integrity?: IntegrityCheck;
  /**
   * 配置里自己给了 sandbox（不是默认的 podman）：doctor 不查 podman 镜像。
   * The config provides its own sandbox (not the default podman): doctor doesn't check the podman image.
   */
  customSandbox: boolean;
  beforeSchedule(): void;
  acceptancePrep?(branch: string): string;
  browser: { pagePaths: RegExp[] };
  texts: Required<NonNullable<ProjectProfile["texts"]>>;
};

export function resolveProject(p: ProjectProfile): Project {
  return {
    forge: p.forge ?? githubForge(),
    remote: p.remote ?? "origin",
    baseBranch: p.baseBranch ?? "main",
    mergeMethod: p.mergeMethod ?? "rebase",
    autoMerge: p.autoMerge ?? true,
    mergeRequires: { checks: "all", timeoutMinutes: 30, ...p.mergeRequires },
    language: p.language ?? "zh",
    maxParallel: p.maxParallel ?? 2,
    agentIdleTimeoutS: p.agentIdleTimeoutS ?? 40 * 60,
    pollIntervalMs: p.pollIntervalMs ?? 10 * 60_000,
    maxIdlePolls: p.maxIdlePolls ?? 12,
    implementMaxSessions: p.implementMaxSessions ?? 3,
    reviseMax: p.reviseMax ?? 2,
    contextBudget: p.contextBudget ?? 150_000,
    mainCheckEvery: p.mainCheckEvery ?? 4,
    labels: { ...DEFAULT_LABELS, ...p.labels },
    sandbox: p.sandbox ?? ((env) => podman({ env })),
    customSandbox: p.sandbox !== undefined,
    install: { copyToWorktree: [], ...p.install },
    isolation: p.isolation,
    // 写进 PR 正文，按项目语言 / Goes into the PR body, so it follows the project's language
    gate: { rerunMax: 3, selectedDescription: p.language === "en" ? "dependency-selected tests" : "按依赖选的测试", ...p.gate },
    integrity: p.integrity,
    beforeSchedule: p.beforeSchedule ?? (() => {}),
    appendOnlyFiles: p.appendOnlyFiles ?? [],
    acceptancePrep: p.acceptancePrep,
    browser: { pagePaths: p.browser?.pagePaths ?? [] },
    texts: { ...defaultTexts(p.language), ...p.texts },
  };
}

/**
 * 本工具的公开接口（index）所在：开发时是 src/index.ts，打包后是 dist/index.js（和本模块同目录）。
 * Where this tool's public API (index) lives: src/index.ts in development, dist/index.js once bundled (next to this module).
 */
const INDEX_URL = new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url).href;
let resolverRegistered = false;

/**
 * 配置里 `import … from "sandpipe"` 一律指向正在运行的这份工具：
 * 全局安装时项目目录下解析不到这个包，也不该让 Python、Go 项目为它装 node_modules。
 * `import … from "sandpipe"` in configs always resolves to the tool that is running:
 * with a global install the package can't be resolved from the project, and Python or Go projects shouldn't need node_modules for it.
 */
function registerSelfResolver() {
  if (resolverRegistered) return;
  resolverRegistered = true;
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "sandpipe" ? { url: INDEX_URL, shortCircuit: true } : next(specifier, context),
  });
}

/** 读配置目录（见 configDir）里的 sandcastle.config.ts。 / Read sandcastle.config.ts from the config directory (see configDir). */
export async function loadProject(dir = configDir()): Promise<Project> {
  registerSelfResolver();
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file))
    throw new Error(
      t(
        `找不到 ${file}：在项目根目录运行、用 SANDCASTLE_PROJECT_DIR 指定配置目录，或先跑 sandpipe onboard 生成项目配置（字段见 docs/config.zh-CN.md）。`,
        `${file} not found: run in the project root, point SANDCASTLE_PROJECT_DIR at the config directory, or run sandpipe onboard to generate a project config (fields in docs/config.md).`,
      ),
    );
  const mod = (await import(pathToFileURL(file).href)) as { default?: ProjectProfile };
  if (!mod.default) throw new Error(t(`${file} 没有 default export（应为 export default defineProject({...})）。`, `${file} has no default export (expected export default defineProject({...})).`));
  return resolveProject(mod.default);
}

// ---------------------------------------------------------------------------
// 通用文案：项目没给 texts 时用
// Generic texts, used when the project gives no texts
// ---------------------------------------------------------------------------

const CROSS_ISSUE_RULE = (id: string) =>
  `除了本票（issue #${id}）和本次会话里自己新开的 issue，不要改其他 issue 的标签或正文（评论除外）；本次会话之前开出的票（包括本票早先会话开的）也不能改。`;

/**
 * 按语言的默认文案：自动开的票（偶发失败、main 坏了）用 i18n.ts 的正文；内联提示词是中文，英文项目在开头加输出语言规则。
 * Default texts per language: auto-opened tickets (flaky, main broken) use the bodies in i18n.ts; inline prompts are Chinese, and English projects get the output-language rule up front.
 */
export function defaultTexts(lang: Language = "zh"): Project["texts"] {
  const m: Messages = messages(lang);
  const withLanguage = (text: string) => (lang === "zh" ? text : `${m.outputLanguage}\n\n${text}`);
  return {
    revisePrompt: (ctx) => withLanguage(ZH_PROMPTS.revisePrompt(ctx)),
    fixPrompt: (ctx) => withLanguage(ZH_PROMPTS.fixPrompt(ctx)),
    flakyIssueBody: ({ files, seen, env, prior, summary }) =>
      m.flakyIssueBody(m.list(files.map((f) => `\`${f}\``)), seen, env, prior, summary),
    mainBrokenIssueBody: ({ sha, summary, commits }) => m.mainBrokenIssueBody(sha, summary, commits.slice(0, 4000)),
  };
}

const ZH_PROMPTS: Pick<Project["texts"], "revisePrompt" | "fixPrompt"> = {
  revisePrompt: ({ issueId, branch, title, viewIssue, items }) =>
    [
      `分支 ${branch}（issue #${issueId}：${title}）的 review 打回了，修改意见如下。`,
      "", items, "",
      `先 \`${viewIssue}\` 看验收标准，再逐条处理上面的意见。从意见给的 file:line 出发，grep -n 定位，不要广泛探索。`,
      "改行为的意见先写或改测试（跑红再跑绿）。只跑改到的测试文件和类型检查，不要跑完整测试。",
      `每条意见处理完提交一次，提交信息末尾 (#${issueId})。`,
      "某条意见你判断不该改（与票冲突、要人拍板），不要改，在输出里写明哪条、为什么。",
      CROSS_ISSUE_RULE(issueId),
      "最后输出 <promise>COMPLETE</promise>。",
    ].join("\n"),
  fixPrompt: ({ issueId, branch, gateOutput, rerunMax }) =>
    [
      `分支 ${branch}（issue #${issueId}）在合并门槛上失败，摘要如下；完整日志在 /tmp/gate-*.log（用 grep 看，不要整读）。测试失败的文件不超过 ${rerunMax} 个时已经单独重跑过一次，仍失败才到你这里。`,
      "```", gateOutput, "```",
      `只修这些失败：单独跑失败的文件确认变绿，提交信息末尾 (#${issueId})。`,
      "如果失败与本票改动无关（偶发、环境问题）或不能确定怎么修，不要改代码，在输出里说明原因。",
      CROSS_ISSUE_RULE(issueId),
      "最后输出 <promise>COMPLETE</promise>。",
    ].join("\n"),
};

/** 中文的默认文案（兼容旧的导出）。 / Chinese default texts (export kept for compatibility). */
export const DEFAULT_TEXTS: Project["texts"] = defaultTexts("zh");
