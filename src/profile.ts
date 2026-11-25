// ProjectProfile：编排脚本里随项目变的部分——托管平台、沙箱里怎么装依赖、每张票的测试环境怎么隔离、
// 合并门槛跑什么、合并前还要查什么、自动开的票怎么写。
//
// 项目在配置目录（默认 `.sandcastle/`，见 configDir）的 `sandcastle.config.ts` 里 `export default defineProject({...})`，main.ts 启动时加载
// （loadProject）。必填的只有 install / isolation / gate 三项，其余有默认值。
// 门槛脚本与 main.ts 之间的输出约定见 GateConfig。

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Forge, MergeMethod } from "./forge.ts";
import { githubForge } from "./forges/github.ts";

export const CONFIG_FILE = "sandcastle.config.ts";

/**
 * 项目配置目录：sandcastle.config.ts、PROJECT.md、可选的 prompts/ 放在这里。默认是目标项目的 `.sandcastle/`；
 * 设了 SANDCASTLE_PROJECT_DIR 就用它（相对路径按 cwd 解析），这样不往目标仓库里放文件也能跑（试用、外置配置）。
 * models.json、.env、logs/ 仍在目标项目的 `.sandcastle/`，不随它走。
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
 */
export interface GateConfig {
  /** 门槛脚本；baseRef 是 `origin/main` 这样的远端基线。 */
  script(ctx: { baseRef: string }): string;
  /** 只给门槛加的环境变量（比如门槛独占资源时开更多 worker）。 */
  env?: Record<string, string>;
  /** 测试文件路径的正则（不带 ^$），用来从门槛输出里认出失败 / 重跑的文件。 */
  testFile: RegExp;
  /** 失败文件不超过这么多个时门槛脚本会单独重跑一次（写进 fix 提示词）。默认 3。 */
  rerunMax?: number;
  /** 留给人审的 PR rebase 后只跑这个（不跑测试）。 */
  typecheck: string;
  /** PR 正文里「按依赖选」档位的说明，比如「按依赖选的测试（……）」。 */
  selectedDescription?: string;
}

/** 合并前的额外一致性检查（比如数据库迁移链没分叉）：rebase 没有文本冲突也可能坏。 */
export interface IntegrityCheck {
  /** 在 PR 评论里的名字，比如「迁移链」。 */
  name: string;
  /** shell 命令，退出码 0 表示 head 在 baseRef 之上是好的。 */
  command(head: string, baseRef: string): string;
  /** 坏了时的一句话（不带句号），比如「本票的 drizzle 迁移没有接在 origin/main 最新的迁移后面」。 */
  broken(baseRef: string): string;
}

export type FlakyIssueContext = {
  files: string[];
  /** `#12 的门槛（PR #34）` */
  seen: string;
  /** 开票时的环境（同时在做的票、负载） */
  env: string;
  /** 7 天内之前的出现，没有时为空串 */
  prior: string;
  /** 第一次失败的摘要（已包在 ``` 里） */
  summary: string;
};

export type MainBrokenContext = { sha: string; summary: string; commits: string };

export type PromptContext = { issueId: string; branch: string; title: string; viewIssue: string };

export interface ProjectProfile {
  /** 托管平台，默认 GitHub（宿主机的 gh）。 */
  forge?: Forge;
  remote?: string;
  baseBranch?: string;
  mergeMethod?: MergeMethod;
  /**
   * reviewer 给 merge、门槛也过了时是否自动合并。默认 true；关掉时照样跑完全程，只是留 PR 等人合并
   * （新项目试跑期用，见 docs/onboarding-checklist.md）。
   */
  autoMerge?: boolean;

  /** 同时实现的票数，受测试依赖的服务（数据库连接数等）与机器负载限制。默认 2。 */
  maxParallel?: number;
  /** agent 多久没输出算卡死（秒）。默认 40 分钟。 */
  agentIdleTimeoutS?: number;
  /** 有空位时隔多久重新调度一次。默认 10 分钟。 */
  pollIntervalMs?: number;
  /** 连续多少次空转就结束运行。默认 12。 */
  maxIdlePolls?: number;
  /** 一张票最多开几次全新的 implement 会话。默认 3。 */
  implementMaxSessions?: number;
  /** reviewer 最多打回几次。默认 2。 */
  reviseMax?: number;
  /** 单个会话的上下文预算（token）。默认 150k。 */
  contextBudget?: number;
  /** 按依赖选测试的票每合并几张，对 main 跑一次完整测试兜底。默认 4。 */
  mainCheckEvery?: number;

  /** 标签名。默认见 DEFAULT_LABELS。 */
  labels?: Partial<Labels>;

  /** 沙箱；默认 podman，env 是要进容器的环境变量。 */
  sandbox?: (env: Record<string, string>) => SandboxProvider;
  install: {
    /** 沙箱建好后跑的命令（装依赖）。 */
    onSandboxReady: string;
    /** 从宿主机拷进 worktree 的路径（省掉从头安装）。 */
    copyToWorktree?: string[];
  };

  /** 每张票（runId 是票号，main 上的兜底检查是 "main"）的测试环境隔离。 */
  isolation: {
    /** 进沙箱的环境变量：独立的测试库、前缀等。 */
    env(runId: string): Record<string, string>;
    /** 关沙箱后回收这张票的测试资源。失败只打日志，不抛错。 */
    cleanup?(runId: string): Promise<void>;
  };

  gate: GateConfig;
  integrity?: IntegrityCheck;

  /** 每次调度开头在宿主机上跑的维护（清日志等）。失败只打日志，不抛错。 */
  beforeSchedule?(): void;

  /** 只追加的索引文件：几张票同时追加不算「改同一个文件」，可以并行。 */
  appendOnlyFiles?: string[];

  /** 改了页面的票，PR「验收说明」最前面的准备步骤（Markdown，含 ### 标题）。 */
  acceptancePrep?(branch: string): string;

  /** 自动开的票（偶发失败、main 坏了）与内联提示词的正文。不给时用通用版。 */
  texts?: {
    flakyIssueBody?(ctx: FlakyIssueContext): string;
    mainBrokenIssueBody?(ctx: MainBrokenContext): string;
    /** reviewer 打回后给 implementer 的提示词，items 是修改意见。 */
    revisePrompt?(ctx: PromptContext & { items: string }): string;
    /** 门槛失败后给 implementer 的提示词，gateOutput 是摘要。 */
    fixPrompt?(ctx: PromptContext & { gateOutput: string; rerunMax: number }): string;
  };
}

export type Labels = {
  picked: string;
  prepped: string;
  prOpen: string;
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
  stuck: "sandcastle:stuck", // 需要人介入（见 issue 评论）
  decided: "sandcastle:decided", // agent 代拍板过设计决定，等人事后确认（人看过后去掉）
  flaky: "flaky", // 门槛里重跑才通过的测试文件，脚本自动开票
  mainBroken: "sandcastle:main-broken", // main 上的兜底完整测试失败，脚本自动开票；调度和 prep 时排最前
  readyForAgent: "ready-for-agent",
  readyForHuman: "ready-for-human",
};

/** 项目配置文件里用：只做类型检查，原样返回。 */
export const defineProject = (profile: ProjectProfile): ProjectProfile => profile;

/** 填好默认值的配置，main.ts 只用这个。 */
export type Project = Required<
  Pick<
    ProjectProfile,
    | "forge" | "remote" | "baseBranch" | "mergeMethod" | "autoMerge" | "maxParallel" | "agentIdleTimeoutS" | "pollIntervalMs"
    | "maxIdlePolls" | "implementMaxSessions" | "reviseMax" | "contextBudget" | "mainCheckEvery" | "sandbox"
    | "install" | "isolation" | "appendOnlyFiles"
  >
> & {
  labels: Labels;
  gate: GateConfig & { rerunMax: number; selectedDescription: string };
  integrity?: IntegrityCheck;
  /** 配置里自己给了 sandbox（不是默认的 podman）：doctor 不查 podman 镜像。 */
  customSandbox: boolean;
  beforeSchedule(): void;
  acceptancePrep?(branch: string): string;
  texts: Required<NonNullable<ProjectProfile["texts"]>>;
};

export function resolveProject(p: ProjectProfile): Project {
  return {
    forge: p.forge ?? githubForge(),
    remote: p.remote ?? "origin",
    baseBranch: p.baseBranch ?? "main",
    mergeMethod: p.mergeMethod ?? "rebase",
    autoMerge: p.autoMerge ?? true,
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
    gate: { rerunMax: 3, selectedDescription: "按依赖选的测试", ...p.gate },
    integrity: p.integrity,
    beforeSchedule: p.beforeSchedule ?? (() => {}),
    appendOnlyFiles: p.appendOnlyFiles ?? [],
    acceptancePrep: p.acceptancePrep,
    texts: { ...DEFAULT_TEXTS, ...p.texts },
  };
}

/** 本工具的公开接口（index）所在：开发时是 src/index.ts，打包后是 dist/index.js（和本模块同目录）。 */
const INDEX_URL = new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url).href;
let resolverRegistered = false;

/**
 * 配置里 `import … from "sandcastle-pipeline"` 一律指向正在运行的这份工具：
 * 全局安装时项目目录下解析不到这个包，也不该让 Python、Go 项目为它装 node_modules。
 */
function registerSelfResolver() {
  if (resolverRegistered) return;
  resolverRegistered = true;
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "sandcastle-pipeline" ? { url: INDEX_URL, shortCircuit: true } : next(specifier, context),
  });
}

/** 读配置目录（见 configDir）里的 sandcastle.config.ts。 */
export async function loadProject(dir = configDir()): Promise<Project> {
  registerSelfResolver();
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file))
    throw new Error(`找不到 ${file}：在项目根目录运行、用 SANDCASTLE_PROJECT_DIR 指定配置目录，或先写好项目配置（见 templates/.sandcastle/sandcastle.config.ts）。`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: ProjectProfile };
  if (!mod.default) throw new Error(`${file} 没有 default export（应为 export default defineProject({...})）。`);
  return resolveProject(mod.default);
}

// ---------------------------------------------------------------------------
// 通用文案：项目没给 texts 时用
// ---------------------------------------------------------------------------

const CROSS_ISSUE_RULE = (id: string) =>
  `除了本票（issue #${id}）和本次会话里自己新开的 issue，不要改其他 issue 的标签或正文（评论除外）；本次会话之前开出的票（包括本票早先会话开的）也不能改。`;

export const DEFAULT_TEXTS: Project["texts"] = {
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
  flakyIssueBody: ({ files, seen, env, prior, summary }) => {
    const list = files.map((f) => `\`${f}\``).join("、");
    return [
      `${list} 在 ${seen}的测试里失败，单独重跑通过。`,
      "", env, ...(prior ? ["", prior] : []),
      "", "## 第一次的失败", "", summary, "",
      "## 怎么修", "",
      "先有一条能让它稳定变红的命令，再改。复现不了就照摘要从代码推断原因，并在提交信息里写明推断依据。",
      "",
      "## Acceptance criteria", "",
      "- [ ] 失败原因写进提交信息（复现命令，或推断的依据）",
      `- [ ] 修复后复现命令变绿、${list} 单跑通过；根因已被别的提交修掉时只核实、不改代码`,
      "- [ ] 不放宽全局超时，不删除或改弱断言",
    ].join("\n");
  },
  mainBrokenIssueBody: ({ sha, summary, commits }) =>
    [
      `Sandcastle 在 main 的 \`${sha}\` 上跑兜底完整测试（\`GATE_FULL=1\`），没通过。`,
      "按依赖选测试的票只跑一部分测试；这里失败说明要么依赖图漏选了，要么两张各自通过的票合在一起才出问题。",
      "", "## 失败摘要", "", summary, "",
      "## 上次兜底通过以来进 main 的提交", "", "```", commits.slice(0, 4000), "```", "",
      "## Acceptance criteria", "",
      "- [ ] 失败的测试文件在 main 上单跑通过；原因（哪个提交引入、为什么）写进提交信息",
      "- [ ] 不放宽全局超时，不删除或改弱断言",
      "- [ ] 是不是依赖图漏选导致的，在 issue 评论里写明结论",
    ].join("\n"),
};
