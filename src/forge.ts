// Forge：代码托管平台（GitHub、GitLab……）上 Sandcastle 用到的全部操作——issue、标签、PR / MR、评论、合并。
//
// 编排脚本（main.ts）只通过这个接口和平台打交道，不直接调 gh / glab。每个方法出错时抛错
// （错误对象带 stderr，和 execFileSync 一样），要「失败只警告」的调用方自己用 shell.ts 的 attempt 包。
// issue 与 PR 的编号一律是字符串（不带 #）；平台自己的写法（GitLab 的 MR 是 `!n`）由实现处理。
//
// 新加一个平台：实现这个接口，放进 forges/，在 forges/index.ts 里登记；契约测试见 test/forge-github.test.ts。

export type ForgeIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** ISO 时间。prep 靠它判断「issue 自上次 prep 以来有没有变」。 */
  updatedAt: string;
};

/** 一个 PR / MR 在 Sandcastle 里需要知道的东西。 */
export type ForgePr = {
  id: string;
  open: boolean;
  /** 源分支名 */
  branch: string;
  /** 从 fork 开过来的（Sandcastle 不接手） */
  fromFork: boolean;
  /** 审查：changesRequested 是平台上的「Request changes」（GitLab 没有时恒为 false，只认 /sandcastle 评论） */
  reviews: { changesRequested: boolean; body: string; at: string }[];
  comments: { body: string; at: string }[];
  /** 分支上最新提交的时间（ISO），没有提交时为空串 */
  lastCommitAt: string;
};

export type MergeMethod = "rebase" | "squash" | "merge";

export interface Forge {
  /** 平台名，打日志用 */
  readonly name: string;

  // ---- issue ----
  /** 带全部 labels 的 open issue。必须用实时接口，不能用有延迟的搜索索引（刚打上的标签要立刻查得到）。 */
  listOpenIssues(labels: string[]): ForgeIssue[];
  /** 带 label 的已关闭 issue 的编号。 */
  listClosedIssueNumbers(label: string): number[];
  /** 正文含 `## Split into`、且不带 withoutLabel 的 open issue（拆过的父票）。 */
  listSplitParents(withoutLabel: string): { number: number; body: string }[];
  issueState(id: string): "open" | "closed";
  issueUpdatedAt(id: string): string;
  /** 全部评论正文，按时间先后。 */
  issueComments(id: string): string[];
  createIssue(issue: { title: string; body: string; labels: string[] }): string;
  editIssueBody(id: string, body: string): void;
  commentIssue(id: string, body: string): void;
  closeIssue(id: string, comment: string): void;
  addLabel(id: string, label: string): void;
  removeLabel(id: string, label: string): void;
  /** 建标签；已存在时抛错（调用方忽略）。 */
  ensureLabel(name: string, color: string, description: string): void;

  // ---- PR / MR ----
  /** 正文里关闭 issue 的写法，比如 `Closes #12`。 */
  closingRef(issueId: string): string;
  /** 用「关闭这张 issue」关联起来的 PR 编号（含已关闭的）。 */
  linkedPrIds(issueId: string): string[];
  /** 按编号或分支名查 PR；查不到返回 null。 */
  viewPr(ref: string): ForgePr | null;
  /** 某个分支上指定状态的 PR 编号，没有时 undefined。 */
  findPr(branch: string, state: "open" | "merged"): string | undefined;
  createPr(pr: { base: string; head: string; title: string; body: string; attachments: string[] }): string;
  prBody(id: string): string;
  editPrBody(id: string, body: string): void;
  /** attachments 是本地图片路径；平台不支持附件时实现可以上传后把链接拼进正文。 */
  commentPr(id: string, body: string, attachments?: string[]): void;
  mergePr(id: string, method: MergeMethod): void;

  // ---- 给 agent 的提示词用 ----
  /** agent 在沙箱里看 issue 的命令，比如 `gh issue view 12`。 */
  viewIssueCommand(issueId: string): string;
  /**
   * 注入提示词 {{FORGE}} 的一段 Markdown：agent 在沙箱里操作这个平台的命令清单（看票和评论、评论、改正文、
   * 标签、开票、搜票、看 PR 与行内意见）。提示词模板只说「做什么」，具体命令都在这里。
   */
  agentGuide(): string;
}
