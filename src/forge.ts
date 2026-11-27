// Forge：代码托管平台（GitHub、GitLab……）上 Sandcastle 用到的全部操作——issue、标签、PR / MR、评论、合并。
//
// 编排脚本（main.ts）只通过这个接口和平台打交道，不直接调 gh / glab。每个方法出错时抛错
// （错误对象带 stderr，和 execFileSync 一样），要「失败只警告」的调用方自己用 shell.ts 的 attempt 包。
// issue 与 PR 的编号一律是字符串（不带 #）；平台自己的写法（GitLab 的 MR 是 `!n`）由实现处理。
//
// 新加一个平台：实现这个接口，放进 forges/，在 forges/index.ts 里登记；契约测试见 test/forge-github.test.ts。
// Forge: every operation Sandcastle needs on a code host (GitHub, GitLab…): issues, labels, PRs / MRs, comments, merging.
// The pipeline (main.ts) talks to the host only through this interface and never calls gh / glab directly. Every method throws on error
// (the error carries stderr, like execFileSync); callers that want "warn on failure" wrap it with attempt from shell.ts.
// Issue and PR numbers are always strings (no #); host-specific notation (GitLab's MR is `!n`) is handled by the implementation.
// To add a host: implement this interface, put it in forges/, register it in forges/index.ts; the contract tests are in test/forge-github.test.ts.

import type { Author } from "./trust.ts";

export type ForgeIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** ISO 时间。prep 靠它判断「issue 自上次 prep 以来有没有变」。 / ISO time. prep uses it to tell whether the issue changed since the last prep. */
  updatedAt: string;
  /** 开票的人；bot 是机器人账号（GitHub App 等）。 / Who opened the ticket; bot marks a bot account (GitHub App etc.). */
  author: Author;
};

/** 一条评论：正文与作者。 / One comment: body and author. */
export type ForgeComment = { body: string; author: Author };

/** 一个 PR / MR 在 Sandcastle 里需要知道的东西。 / What Sandcastle needs to know about a PR / MR. */
export type ForgePr = {
  id: string;
  open: boolean;
  /** 源分支名 / Source branch name */
  branch: string;
  /** 从 fork 开过来的（Sandcastle 不接手） / Opened from a fork (Sandcastle won't take it over) */
  fromFork: boolean;
  /**
   * 审查：changesRequested 是平台上的「Request changes」（GitLab 没有时恒为 false，只认 /sandcastle 评论）
   * Review: changesRequested is the host's "Request changes" (always false on GitLab, which only honours /sandcastle comments)
   */
  reviews: { changesRequested: boolean; body: string; at: string; author: Author }[];
  /**
   * 评论与审查都带作者：编排器只认可信作者的 `/sandcastle` 和 Request changes（#80）。
   * Comments and reviews carry their author: the pipeline honours `/sandcastle` and Request changes only from trusted authors (#80).
   */
  comments: (ForgeComment & { at: string })[];
  /** 分支上最新提交的时间（ISO），没有提交时为空串 / Time of the branch's latest commit (ISO); empty when there are no commits */
  lastCommitAt: string;
};

export type MergeMethod = "rebase" | "squash" | "merge";

/**
 * PR 上的一项检查（CI、状态检查）；state 已归一成通过 / 失败 / 还在跑。
 * One check on a PR (CI, status check); state is normalized to pass / fail / still running.
 */
export type PrCheck = { name: string; state: "pass" | "fail" | "pending"; link?: string };

/** 票的状态。 / A ticket's state. */
export type IssueState = "open" | "closed" | "missing";

export interface Forge {
  /** 平台名，打日志用 / Host name, for logs */
  readonly name: string;
  /**
   * 沙箱里 agent 操作平台要的 token 变量名（写在 .sandcastle/.env 里），比如 GH_TOKEN。
   * Name of the token variable the sandboxed agent uses for the host (in .sandcastle/.env), e.g. GH_TOKEN.
   */
  readonly tokenEnv: string;

  // ---- doctor ----
  /**
   * 宿主机的 CLI 已登录、能访问当前仓库；返回一行说明（账号、仓库），不行就抛错，错误里写怎么修。
   * The host CLI is logged in and can access the current repo; returns a one-line summary (account, repo), otherwise throws with how to fix it.
   */
  checkAccess(): string;
  /** 沙箱里 agent 用的 token 能访问当前仓库的 issue 和 PR；返回一行说明，不行就抛错，错误里写缺什么权限。 */
  checkAgentToken(token: string): string;
  /** 仓库里已有的全部标签名。 / All label names in the repo. */
  listLabels(): string[];

  // ---- issue ----
  /** 带全部 labels 的 open issue。必须用实时接口，不能用有延迟的搜索索引（刚打上的标签要立刻查得到）。 */
  listOpenIssues(labels: string[]): ForgeIssue[];
  /**
   * 某个登录名在当前仓库的权限：admin / write / read / none（maintain 映射成 write，triage 映射成 read）。用户不存在等 404 时抛错。
   * A login's permission on the current repo: admin / write / read / none (maintain maps to write, triage to read). Throws on 404 (e.g. no such user).
   */
  repoPermission(login: string): string;
  /** 带 label 的已关闭 issue 的编号。 / Numbers of closed issues with the label. */
  listClosedIssueNumbers(label: string): number[];
  /** 正文含 `## Split into`、且不带 withoutLabel 的 open issue（拆过的父票）。 */
  listSplitParents(withoutLabel: string): { number: number; body: string }[];
  /**
   * 票的状态；`missing` 表示平台确认这个编号不存在，其他查询错误照旧抛出。
   * The ticket's state; `missing` means the forge confirmed this number doesn't exist; other lookup errors still throw.
   */
  issueState(id: string): IssueState;
  issueUpdatedAt(id: string): string;
  /**
   * 全部评论（正文与作者），按时间先后。调用方按作者过滤，只认可信作者写的标记（#80）。
   * All comments (body and author), oldest first. Callers filter by author and honour markers only from trusted authors (#80).
   */
  issueComments(id: string): ForgeComment[];
  createIssue(issue: { title: string; body: string; labels: string[] }): string;
  editIssueBody(id: string, body: string): void;
  commentIssue(id: string, body: string): void;
  closeIssue(id: string, comment: string): void;
  addLabel(id: string, label: string): void;
  removeLabel(id: string, label: string): void;
  /** 建标签；已存在时抛错（调用方忽略）。 / Create a label; throws when it exists (callers ignore that). */
  ensureLabel(name: string, color: string, description: string): void;

  // ---- PR / MR ----
  /** 正文里关闭 issue 的写法，比如 `Closes #12`。 / How a body closes an issue, e.g. `Closes #12`. */
  closingRef(issueId: string): string;
  /** 用「关闭这张 issue」关联起来的 PR 编号（含已关闭的）。 / PR numbers linked by "closes this issue" (including closed ones). */
  linkedPrIds(issueId: string): string[];
  /** 按编号或分支名查 PR；查不到返回 null。 / Look up a PR by number or branch; null when not found. */
  viewPr(ref: string): ForgePr | null;
  /** 某个分支上指定状态的 PR 编号，没有时 undefined。 / Number of the PR in the given state on a branch; undefined when none. */
  findPr(branch: string, state: "open" | "merged"): string | undefined;
  createPr(pr: { base: string; head: string; title: string; body: string; attachments: string[] }): string;
  prBody(id: string): string;
  editPrBody(id: string, body: string): void;
  /**
   * attachments 是本地图片路径；平台不支持附件时实现可以上传后把链接拼进正文。
   * attachments are local image paths; hosts without attachments may upload them and put the links in the body.
   */
  commentPr(id: string, body: string, attachments?: string[]): void;
  mergePr(id: string, method: MergeMethod): void;
  /**
   * PR 上的检查；requiredOnly 时只要分支保护要求的。返回空数组 = PR 上没有检查。可选：不实现这个方法的 forge 按没有检查处理。
   * Checks on a PR; with requiredOnly, only those required by branch protection. An empty array means the PR has no checks. Optional: a forge without this method is treated as having no checks.
   */
  prChecks?(id: string, requiredOnly: boolean): PrCheck[];
  /**
   * PR 能否干净地合进目标分支：有冲突为 "conflicting"，平台还没算出来为 "unknown"，其余为 "clean"。出错就抛。
   * 可选：不实现这个方法的 forge 不做冲突判断，PR 上没有检查时照旧按宽限期等。
   * Whether the PR merges cleanly into its base: "conflicting" when it conflicts, "unknown" while the host is still computing, otherwise "clean". Throws on error.
   * Optional: a forge without this method skips the conflict check, and a PR without checks waits out the grace period as before.
   */
  prMergeable?(id: string): "conflicting" | "clean" | "unknown";

  // ---- 给 agent 的提示词用 ---- / For the agent's prompts
  /** agent 在沙箱里看 issue 的命令，比如 `gh issue view 12`。 / Command the agent uses in the sandbox to view an issue, e.g. `gh issue view 12`. */
  viewIssueCommand(issueId: string): string;
  /**
   * 注入提示词 {{FORGE}} 的一段 Markdown：agent 在沙箱里操作这个平台的命令清单（看票和评论、评论、改正文、
   * 标签、开票、搜票、看 PR 与行内意见）。提示词模板只说「做什么」，具体命令都在这里。
   * Markdown injected as {{FORGE}} in prompts: the commands the agent uses on this host in the sandbox (view tickets and comments, comment, edit bodies,
   * labels, open and search tickets, view PRs and inline comments). Prompt templates only say what to do; the concrete commands live here.
   */
  agentGuide(): string;
}
