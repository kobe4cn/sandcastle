// 脚本自己写到托管平台上的文字（PR 正文、评论、自动开的票）：按项目配置的 language 选中文或英文。
// agent 写的文字由提示词里的「输出语言」规则管（project-doc.ts 的 languageVars）。终端输出不在这里，见 term.ts。
// 新增一条：zh 和 en 都要加（en 的类型是 Messages，少了编译不过）。
// Text the script writes to the forge (PR bodies, comments, auto-opened tickets): Chinese or English per the project's language.
// What the agent writes is governed by the "output language" rule in the prompts (languageVars in project-doc.ts). Terminal output isn't here; see term.ts.
// To add an entry, add it to both zh and en (en is typed as Messages, so a missing one won't compile).

import type { NotifyEvent } from "./notify.ts";
import type { ProtectedHit } from "./protected-paths.ts";

export type Language = "zh" | "en";

/**
 * 受保护路径命中逐行「- `文件` — `规则`」，每行可带后缀（reasonProtected 与 protectedAllowed 共用）。
 * Protected-path hits as "- `file` — `rule`" lines, each with an optional suffix (shared by reasonProtected and protectedAllowed).
 */
const hitLines = (hits: ProtectedHit[], suffix = "") => hits.map((h) => `- \`${h.file}\` — \`${h.rule}\`${suffix}`).join("\n");

/**
 * 通知事件在消息里的说法，中英各一份（notifyText 用）。
 * How each notify event is worded in messages, one set per language (used by notifyText).
 */
const zhEventNames: Record<NotifyEvent, string> = {
  stuck: "票卡住了",
  leftForHuman: "留了 PR 给人",
  mainBroken: "main 坏了",
  limited: "撞上用量限额",
  crashed: "运行中断了",
  test: "测试消息",
};
const enEventNames: Record<NotifyEvent, string> = {
  stuck: "ticket stuck",
  leftForHuman: "PR left for a human",
  mainBroken: "main is broken",
  limited: "usage limit hit",
  crashed: "the run crashed",
  test: "test message",
};

/**
 * 拼通知的一行 text：票号（有链接时跟在后面）、事件说法、原因，用「 — 」隔开。
 * Assembles the one-line text: ticket number (link appended when present), the event's wording, the reason, joined by " — ".
 */
const notifyLine = (event: string, issue: string | undefined, url: string | undefined, reason: string, label: string): string => {
  const parts: string[] = [];
  if (issue && url) parts.push(`#${issue} ${url}`);
  else if (issue) parts.push(`#${issue}`);
  else if (url) parts.push(url);
  parts.push(event, reason);
  return `${label}${parts.join(" — ")}`;
};

const zh = {
  list: (items: string[]) => items.join("、"),
  sep: "；",

  // —— PR 正文：验收说明 —— / PR body: acceptance notes
  notesTitle: "验收说明",
  /**
   * 验收说明必须有的三个小标题（implementer 按提示词写，pr-body.ts 检查）。
   * The three headings acceptance notes must have (the implementer writes them per the prompt; pr-body.ts checks them).
   */
  noteHeadings: ["### 做了什么", "### 怎么验证", "### 最终效果"] as readonly [string, string, string],
  /** implementer 进度评论第一行的前缀（后面跟档案名）。 / Prefix of the first line of the implementer's progress comment (followed by the profile name). */
  profileLine: "模型档案：",
  notesMissingFile: "文件不存在",
  notesMissingHeading: (h: string) => `缺 \`${h}\` 小标题`,
  notesNoSteps: "「怎么验证」下面没有编号步骤",
  notesHasH2: "文件里出现了 `## ` 二级标题（只能写 `###` 小标题，二级标题会让替换这一节时切错）",
  notesNotWritten: "⚠️ implementer 没有写验收说明",
  notesBadFormat: (problems: string) => `⚠️ 验收说明格式不对：${problems}`,
  prepPage: (branch: string) => `### 准备\n\n\`git checkout ${branch}\`。本票改了页面，需要起 dev server（项目没配准备步骤）`,
  prepNoPage: (branch: string) => `### 准备\n\n\`git checkout ${branch}\`（本票没改页面，不用起 dev server）`,

  // —— PR 正文：其余各节 —— / PR body: other sections
  usageNone: "（没有记录到用量）",
  usageHeader: "| 会话 | 档案 | 次数 | 输入 | 缓存写 | 缓存读 | 输出 | 上下文峰值 |",
  usageProfile: (profile: string, model: string) => `${profile}（${model}）`,
  usageLimited: "撞限额，换下一个档案",
  budgetNote: (peakK: number, budgetK: number, sessions: number) =>
    `上下文峰值约 ${peakK}k / ${budgetK}k，implement 用了 ${sessions} 次会话。`,
  overBudget: "\n\n⚠️ 超过上下文预算，考虑把同类票切得更小。",
  tierFull: "完整测试",
  gateFailed: (out: string) => `❌ 门槛失败：\n\n\`\`\`\n${out}\n\`\`\``,
  gateFlaky: (tier: string, out: string) =>
    `typecheck 通过；⚠️ ${tier}有偶发失败，失败的文件单独重跑通过（沙箱内）。已自动开票修（见 PR 评论）。\n\n\`\`\`\n${out}\n\`\`\``,
  gatePassed: (tier: string, out: string) => `typecheck 与${tier}通过（沙箱内）。\n\n\`\`\`\n${out}\n\`\`\``,
  browserNoResult: "（implementer 没有写 RESULT.md）",
  browserShots: (n: number) => `截图 ${n} 张，附在下面。`,
  // —— Browser check 一节的两个小标题（pr-body.ts 的 browserSection，#83） —— / The two sub-headings of the Browser check section (browserSection in pr-body.ts, #83)
  browserReviewerVerdict: "评审结论",
  browserSelfCheck: "implement 自评（RESULT.md）",
  browserNoReviewerVerdict: "评审没有给出逐条结论",
  revisions: (n: number) => `\n\n**reviewer 打回过 ${n} 次**（implementer 已按意见修改）：\n\n`,
  revisionN: (n: number) => `第 ${n} 次的意见`,
  noReviewSummary: "（reviewer 没有给出摘要）",

  // —— PR 评论 —— / PR comments
  prUpdated: "Sandcastle 更新了这个分支。",
  prUpdatedNotes: "Sandcastle 更新了这个分支（验收说明已更新）。",
  notMerged: (reason: string) => `没有自动合并：${reason}`,
  decisions: (n: number, issueId: string, label: string) =>
    `## 代拍板\n\nagent 按「必须停下 / 可以代拍板」的规则自己定了 ${n} 个设计决定，请事后确认（不同意就在 issue 上回复，确认后去掉 #${issueId} 的 \`${label}\`）：`,
  decisionN: (n: number) => `第 ${n} 个`,
  reopened: "收到打回，这张票重新进入 Sandcastle：implementer 会先处理这个 PR 上的意见。",
  flakyTicketsOpened: (tickets: string) => `门槛里的偶发失败已开票：${tickets}`,
  flakyDeferred: (files: string) =>
    `门槛里重跑才通过、报错只是超时或连接失败，7 天内第一次出现，只记进 .sandcastle/logs/flaky.json、不开票：${files}`,
  rebasedTypecheckOnly: (base: string, how: string, files: string) =>
    `Sandcastle 把分支 rebase 到最新的 ${base}（原来和它冲突，${how}；冲突文件：${files}）。rebase 后只跑了 typecheck（通过），**没有重跑测试**：PR 正文 Gate 里的测试结果是 rebase 之前的，合并前请判断是否要补跑。`,
  rebaseHowAgent: "冲突由 agent 处理",
  rebaseHowClean: "rebase 没有冲突",
  parentClosed: (children: string) => `子票 ${children} 都已关闭，Sandcastle 关闭父票。`,
  rebaseNoTextConflict: (integrity: string) => `（没有文本冲突，${integrity}分叉）`,
  rebasedMerged: (base: string) => `Sandcastle 把分支 rebase 到最新的 ${base}，门槛重跑通过后合并。`,

  // —— 留给人的原因（接在 notMerged 后面） —— / Reasons for leaving a PR to a human (appended after notMerged)
  reasonExternal: (verdict: string | undefined, gateOk: boolean) =>
    `这是外部 PR，Sandcastle 只负责修改，合并由人决定。reviewer 结论：${verdict}；门槛${gateOk ? "通过" : "没通过"}（见上面的评论）。`,
  reasonExternalConflict: (base: string, branch: string) => `\n\n⚠️ 分支和最新的 ${base} 有冲突，需要先把 ${branch} 合进来。`,
  reasonNotes: (problems: string) => `\n\n验收说明缺失或格式不对：${problems}（见 PR 正文的「验收说明」一节）。`,
  reasonReviseMax: (n: number) => `reviewer 打回 ${n} 次后仍有要改的问题（见最新的 Review）。`,
  reasonReviewerPr: "reviewer 认为需要人审（见 PR 正文的 Review）。",
  reasonGate: "typecheck 或完整测试没通过（见 PR 正文的 Gate）。",
  /**
   * 门槛失败后 fix（或 rebase 解冲突）改了代码，之后的复审没通过（re-review.ts）。
   * The re-review after a fix (or rebase conflict resolution) changed code didn't pass (re-review.ts).
   */
  reasonReReview: (kind: "fix" | "rebase", summary: string) =>
    `${kind === "fix" ? "fix 之后的复审没通过" : "rebase 解冲突之后的复审没通过"}：\n\n${summary}`,
  reReviewNoVerdict: "（复审没有输出结论，按不通过处理）",
  /** 复审前后 HEAD 不同或取不到：复审会话提交了改动，按不通过处理（#72）。 / HEAD differs or is unreadable before / after the re-review: the session committed changes, treated as not passing (#72). */
  reReviewCommitted: (before: string, after: string) =>
    `复审会话提交了改动（复审前 HEAD ${before || "取不到"}，复审后 ${after || "取不到"}）。复审只评不改，这些提交没经过门槛和评审，请人工检查或回退`,
  /** fix 前或 fix 后的 HEAD 取不到，没复审，留 PR（#73）。 / The HEAD before or after the fix was unreadable; not re-reviewed, PR left open (#73). */
  reasonHeadUnknown: "取不到 fix 前后的 HEAD，没法确定 fix 改了什么，未复审",
  /** rebase 前的分支范围取不到，复审没法对比，按不通过处理（#71）。 / The pre-rebase branch range is unreadable, so the re-review can't compare; treated as not passing (#71). */
  reReviewNoRange: "（取不到 rebase 前的分支范围，复审没法对比，按不通过处理）",
  /** 票的 diff 改到了 protectedPaths 命中的文件（protected-paths.ts），逐条列出。 / The ticket's diff touches files matched by protectedPaths (protected-paths.ts), listed one by one. */
  reasonProtected: (hits: ProtectedHit[]) =>
    `改到了受保护路径（protectedPaths），需要人看过再合并：\n\n${hitLines(hits)}`,
  /** 票的实现指引允许改的受保护路径，PR 正文 Protected paths 一节逐条列出（#76）。 / Protected paths the ticket's implementation guide allows, listed in the PR body's Protected paths section (#76). */
  protectedAllowed: (hits: ProtectedHit[]) => hitLines(hits, "（ticket allowed）"),
  /** 票的放行项一个命中都没覆盖，附在留 PR 的原因后（#76）。 / The ticket's allowed entries that cover no hit, appended to the leave-for-human reason (#76). */
  protectedAllowedUnmatched: (entries: string[]) =>
    `\n\n票的实现指引里这些 \`- **Protected**\` 放行项没匹配上任何命中的文件：${entries.map((e) => `\`${e}\``).join("、")}。路径要相对仓库根，目录以 \`/\` 结尾，文件要与 diff 里的完全相同。`,
  /** rebase 解冲突后新改到了票放行的受保护路径，PR 补一条评论（#76）。 / Conflict resolution in the rebase touched new ticket-allowed protected paths; a PR comment reports them (#76). */
  protectedAllowedAfterRebase: (section: string) => `rebase 解冲突后新改到了票放行的受保护路径：\n\n## Protected paths\n\n${section}`,
  /** 配了 protectedPaths 但取不到 diff，按命中处理（fail-closed）。 / protectedPaths is configured but the diff is unavailable; treated as a hit (fail-closed). */
  reasonProtectedUnknown: "取不到这张票的 diff，无法判断是否改了受保护路径（protectedPaths），需要人看过再合并。",
  reasonAutoMergeOff: "项目配置 autoMerge: false（试跑期），reviewer 和门槛都通过，等人合并。",
  /** 有开着的 main-broken 票，其他票留 PR（ADR 0007）。 / An open main-broken ticket holds other tickets' PRs open (ADR 0007). */
  reasonMainBroken: (n: number) => `main 上的兜底完整测试失败，等 #${n} 修好后再合并。`,
  /** 列不出开着的 main-broken 票时按有票处理（fail-closed，ADR 0007）。 / When open main-broken tickets can't be listed, one is assumed (fail-closed, ADR 0007). */
  reasonMainBrokenUnknown: (err: string) => `查不到开着的 main-broken 票（${err}），为安全起见不自动合并。`,
  reasonBrowser: (problems: string) => `改了页面，浏览器验收不满足自动合并的条件：${problems}（见 PR 正文的 Browser check 一节）。`,
  reasonNoBrowserConfig:
    "改了页面、本项目没配浏览器验收，不能自动合并。补法：重跑 onboard 让它写「浏览器验收」一节，或者在 `.sandcastle/PROJECT.md` 里手动加 `## 浏览器验收`（怎么准备数据、在后台起 dev server、登录、查日志），再按需配 `browser.pagePaths`；改完重启 Sandcastle。",
  // —— 浏览器验收缺什么（browser-gate.ts，接在 reasonBrowser 里） —— / What the browser check is missing (browser-gate.ts, inside reasonBrowser)
  browserNotDone: "改了页面但没做浏览器验收（worktree 里没有 `.browser-check/`）",
  browserNoShots: "没有截图",
  browserNoResultFile: "没有 RESULT.md",
  browserFailedItems: (lines: string[]) => `RESULT.md 有没通过的项（❌ / ⚠）：${lines.map((l) => `「${l}」`).join("、")}`,
  browserMissingShots: (names: string) => `RESULT.md 引用的截图不存在：${names}`,
  browserTagNotDone: (tag: string) => `review 的 browser-check 是 \`${tag}\`，不是 done`,
  browserNoTag: "review 没有给出 browser-check（要求是 done）",
  browserNoVerdict: "review 给了 browser-check done，但没有逐条的 browser-verdict",
  browserVerdictFailed: (lines: string[]) => `评审自己看截图有没通过的步骤：${lines.map((l) => `「${l}」`).join("、")}`,
  browserStale: (files: string) => `验收之后 revise / fix 改了页面，截图已过期：${files}`,
  browserStaleUnknown: "取不到浏览器验收时的提交或之后的 diff，无法判断截图是否过期",
  /** rebase 解冲突改到了页面，不 push、留 PR（#58）。 / Resolving rebase conflicts touched pages; not pushed, PR left open (#58). */
  reasonBrowserStaleAfterRebase: (files: string | undefined) =>
    files ? `rebase 解冲突改了页面，截图已过期，需要人重新验收：${files}` : "rebase 解冲突后取不到 diff，无法判断是否改了页面，按截图已过期处理，需要人重新验收。",
  // —— 票里缺 Browser check 的提示（pr-body.ts 的 browserSection、land 的 PR 评论） —— / Notice for a ticket without a Browser check (browserSection in pr-body.ts, the PR comment in land)
  browserNoTicketCheck:
    "⚠️ 改了页面，但票里没有 Browser check，建议补 prep 规则：prep 写实现指引时，改页面的票要加 `- **Browser check**` 一项（以什么角色打开哪个页面、做什么、应该看到什么）。",
  reasonMergeFailed: (out: string, retry: string) => `合并失败：${out}\n\nrebase 后重试也没成：${retry}`,
  reasonBranchProtection: (out: string) =>
    `门槛已通过，但仓库的分支保护不让 Sandcastle 合并（要求审批、必需检查或合并队列等）。请人合并，或调整分支保护 / 配置里的 \`mergeRequires\`。gh 的报错：${out}`,
  reasonChecksFailed: (list: string) =>
    `门槛已通过，但 PR 上的检查没通过，没有合并。合并条件是门槛加 forge 检查都通过；CI 本身不可靠时，可以在配置里设 \`mergeRequires: { checks: "none" }\` 只看门槛。没通过的检查：\n\n${list}`,
  reasonChecksTimeout: (list: string, minutes: number) =>
    `门槛已通过，但等了 ${minutes} 分钟 PR 上的检查还没跑完，没有合并。合并条件是门槛加 forge 检查都通过；CI 本身不可靠时，可以在配置里设 \`mergeRequires: { checks: "none" }\` 只看门槛。还在跑的检查：\n\n${list}`,
  rebasedForHuman: (base: string) => `\n\n分支和最新的 ${base} 冲突，已 rebase，只重跑了 typecheck（通过），没有重跑测试。`,
  rebaseForHumanFailed: (base: string, reason: string) => `\n\n⚠️ 分支和最新的 ${base} 冲突，自动 rebase 没成：${reason}`,

  // —— rebase 失败的原因 —— / Reasons a rebase failed
  rebaseExternal: (branch: string) => `外部 PR 的分支 ${branch} 不由 Sandcastle rebase 或合并。`,
  rebaseNotBehind: (base: string) => `分支已经包含最新的 ${base}，失败不是冲突造成的，需要人看。`,
  rebaseAgentFailed: "agent 没能解决 rebase 冲突（原因见 issue 评论）。",
  rebaseStillBehind: (base: string) => `处理后分支仍不在 ${base} 之上。`,
  rebaseStillBroken: (broken: string) => `处理后仍然${broken}。`,
  rebaseTypecheckFailed: (out: string) => `rebase 后 typecheck 失败：\n\n\`\`\`\n${out}\n\`\`\``,
  rebaseGateFailed: (out: string) => `rebase 后门槛失败：\n\n\`\`\`\n${out}\n\`\`\``,
  rebaseMergeFailed: (out: string) => `rebase 并通过门槛后仍合并失败：${out}`,
  integrityName: "一致性检查",
  integrityBroken: "一致性检查没通过",

  // —— issue 评论：停下 / 退回 —— / Issue comments: stop / send back
  stuck: (reason: string) => `Sandcastle 停下了：${reason}`,
  missingBlocker: (blockers: string, stuckLabel: string) =>
    `\`## Blocked by\` 里的 ${blockers} 在本仓库查不到（票号写错，或者是从别的仓库复制来的）。改正 Blocked by 或者删掉这一行，然后去掉 ${stuckLabel} 就能继续。`,
  untrustedAuthor: (login: string, triage: string, trusted: string) =>
    `这张票的作者 @${login} 对本仓库没有写权限，Sandcastle 不会 prep 或实现它。有写权限的人看过、确认可以交给 Sandcastle 后，打上 \`${trusted}\`、去掉 \`${triage}\` 就会照常调度。`,
  needsTriageLabelDesc: "票的作者没有写权限，等有写权限的人确认",
  trustedLabelDesc: "有写权限的人确认过这张票可以交给 Sandcastle",
  sandboxError: (err: string) => `沙箱出错：${err}`,
  podmanDown: (err: string) => `podman 连不上（重试多次仍失败）：${err}`,
  gateEnvDown: (line: string, stuckLabel: string) => `门槛依赖的服务连不上（\`${line}\`），重试用完仍未恢复。先把服务起来，再去掉 ${stuckLabel}。`,
  agentIdleTimeout: (seconds: number, stuckLabel: string) =>
    `agent 连续 ${seconds} 秒没有输出，按卡住处理（AgentIdleTimeoutError）。如果测试或构建本来就要跑这么久，在 \`.sandcastle/sandcastle.config.ts\` 里调大 \`agentIdleTimeoutS\`（现在是 ${seconds}），然后去掉 ${stuckLabel} 再运行。`,
  pushedTo: (branch: string) => `已有的提交推到了分支 \`${branch}\`。`,
  pushedHere: "已有的提交推到了这个分支。",
  notPushed: "提交没能推上去，留在宿主机的本地分支上。",
  needsDecision: (budget: string, pushed: string, stuckLabel: string) =>
    `implementer 遇到必须由人拍板的设计决定（见上面 implementer 的评论）。${budget}${pushed}拍板后在票上回复，去掉 ${stuckLabel} 即可接着跑。`,
  reprepFailed: (max: number, budget: string) =>
    `重新准备过一次，${max} 次会话内仍没有完成（见上面 implementer 的评论）。${budget} 请人看一下票怎么拆。`,
  externalIncomplete: (branch: string, max: number, budget: string, pushed: string) =>
    `在外部 PR 的分支 \`${branch}\` 上 ${max} 次会话内没有改完（见上面 implementer 的评论）。${budget}${pushed}`,
  reprep: (max: number, budget: string, stuckLabel: string) =>
    `${max} 次会话内没有完成。${budget} 下次调度时 prep 会按上面 implementer 的进度评论重新准备：指引不对就重写，票太大就把没完成的验收标准拆成子票。再没做完就打 ${stuckLabel}。`,
  reprepCommits: (branch: string, log: string) => `\n\n分支 \`${branch}\` 上已有的提交：\n\n${log}`,
  reprepNoCommits: "\n\n分支上还没有提交。",
  reprepNotPushed: "\n\n（分支没能推到远端，下一轮会在本地的同名分支上接着做。）",
  landError: (branch: string, reason: string, stuckLabel: string) =>
    `Sandcastle 停下了：落地（push / 开 PR / 合并）出错，本地分支 \`${branch}\` 保留。\n\n\`\`\`\n${reason}\n\`\`\`\n\n处理后去掉 ${stuckLabel} 再运行。`,
  limitedWaiting: (phase: string, profiles: readonly string[], until: string, mark: string) =>
    `⏸ 阶段 ${phase} 的档案（${profiles.map((p) => `\`${p}\``).join("、")}）都撞上了用量限额，预计 ${until}（运行 Sandcastle 那台机器的本地时间）恢复后接着跑，不用处理。\n\n${mark}`,

  // —— 偶发失败与 main 兜底 —— / Flaky failures and the fallback run on main
  flakyLabelDesc: "偶发失败的测试（Sandcastle 门槛自动开票）",
  mergingLabelDesc: "Sandcastle 已开 PR、门槛已过，在等检查 / 合并（中断重启后接着等，不重新实现）",
  waitingMainLabelDesc: "被 main-broken 挡住留 PR 的票；main 修好后自动 rebase 重跑门槛再合并（脚本自动建标签）",
  reviewedLabelDesc: "Sandcastle 评审已通过、正在跑门槛（中断重启后分支没变就直接跑门槛，不重新实现）",
  reviewedNote: (sha: string) =>
    `✅ 评审已通过（分支 HEAD \`${sha.slice(0, 12)}\`），接下来跑门槛。进程中断重启后分支没变就直接跑门槛，不重新实现和评审。`,
  flakySeen: (issueId: string, pr: string) => `#${issueId} 的门槛（PR #${pr}）`,
  flakyEnv: (others: string[], load: string, cores: number) =>
    `开票时：同时在做的票 ${others.length ? others.join("、") : "无"}；宿主机 1 / 5 / 15 分钟负载 ${load}（${cores} 核）。`,
  flakyPriorItem: (at: string, issue: string, file: string) => `${at}Z #${issue} 的门槛（\`${file}\`）`,
  flakyPrior: (items: string[]) => `7 天内之前的出现：${items.join("；")}。`,
  flakyAgain: (seen: string, files?: string) => (files ? `又出现一次：${seen}，这次失败的文件：${files}。` : `又出现一次：${seen}。`),
  flakyFirstFailure: "第一次的失败：",
  flakyTitle: (file: string, n: number) => `偶发失败：${file}${n > 1 ? ` 等 ${n} 个文件` : ""}`,
  mainBrokenLabelDesc: "main 上的兜底完整测试失败（Sandcastle 自动开票，调度时排最前）",
  mainFixedRebase: "main 兜底测试已修好，rebase 到最新 main 后重跑门槛再合并",
  mainBrokenAgain: (short: string, summary: string) => `main（${short}）上的兜底完整测试又失败了：\n\n${summary}`,
  mainBrokenTitle: (short: string) => `main 上的兜底完整测试失败（${short}）`,
  mainBrokenNoHistory: "（之前没有通过记录，下面是最近 20 个提交）",

  // —— 默认的自动开票正文（项目配置 texts 可以整份替换） ——
  // Default bodies for auto-opened tickets (the project config's texts can replace them wholesale)
  flakyIssueBody: (list: string, seen: string, env: string, prior: string, summary: string) =>
    [
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
    ].join("\n"),
  mainBrokenIssueBody: (sha: string, summary: string, commits: string) =>
    [
      `Sandcastle 在 main 的 \`${sha}\` 上跑兜底完整测试（\`GATE_FULL=1\`），没通过。`,
      "按依赖选测试的票只跑一部分测试；这里失败说明要么依赖图漏选了，要么两张各自通过的票合在一起才出问题。",
      "", "## 失败摘要", "", summary, "",
      "## 上次兜底通过以来进 main 的提交", "", "```", commits, "```", "",
      "## Acceptance criteria", "",
      "- [ ] 失败的测试文件在 main 上单跑通过；原因（哪个提交引入、为什么）写进提交信息",
      "- [ ] 不放宽全局超时，不删除或改弱断言",
      "- [ ] 是不是依赖图漏选导致的，在 issue 评论里写明结论",
    ].join("\n"),

  // —— 主动通知（webhook，notify.ts） —— / Proactive notifications (webhook, notify.ts)
  /**
   * webhook 消息的 text：一行给人看，Slack incoming webhook 直接认（飞书、企业微信、钉钉的群机器人要各自的格式，不兼容）。
   * The webhook message's text: one human-readable line, accepted as-is by a Slack incoming webhook (Lark, WeCom and DingTalk bots need their own formats and are not compatible).
   */
  notifyText: (event: NotifyEvent, issue: string | undefined, url: string | undefined, reason: string) =>
    notifyLine(zhEventNames[event], issue, url, reason, "Sandcastle："),
  /** 通知 limited 事件的原因：全部档案撞限额进入等待（#133）。 / The limited event's reason: every profile hit its limit and the run waits (#133). */
  notifyLimited: (phase: string, profiles: readonly string[], until: string) =>
    `阶段 ${phase} 的档案（${profiles.join("、")}）都撞上了用量限额，预计 ${until}（本地时间）恢复后接着跑。`,
  /** 通知 limited 事件的原因：prep 撞限额，只写恢复时间（#133）。 / The limited event's reason: prep hit its limit, the reset time only (#133). */
  notifyPrepLimited: (until: string) => `prep 撞上了用量限额，预计 ${until}（本地时间）恢复后接着跑。`,
  /** 通知 stuck 事件的原因：prep 会话在沙箱里打的 stuck（#133）。 / The stuck event's reason: a stuck label the prep session added in the sandbox (#133). */
  notifyPrepStuck: "prep 要人拍板或缺信息，见票上的评论。",
  /** 通知 test 事件的原因：doctor --notify-test 发的测试消息（#134）。 / The test event's reason: the test message sent by doctor --notify-test (#134). */
  notifyTest: "这是 sandpipe doctor --notify-test 发的测试消息。",

  // —— 给 agent 的输出语言规则（渲染进每个提示词开头，以及内联的 revise / fix 提示词） ——
  // Output language rule for the agent (rendered at the top of every prompt, and in the inline revise / fix prompts)
  outputLanguage:
    "输出语言：写到 issue、PR、评论里的一切文字（票的标题和正文、进度评论、验收说明、review 摘要）都用中文。提交信息的语言按 PROJECT.md「提交」一节。",
};

export type Messages = typeof zh;

const en: Messages = {
  list: (items) => items.join(", "),
  sep: "; ",

  notesTitle: "Acceptance notes",
  noteHeadings: ["### What changed", "### How to verify", "### Result"],
  profileLine: "Model profile: ",
  notesMissingFile: "file not found",
  notesMissingHeading: (h) => `missing the \`${h}\` heading`,
  notesNoSteps: "no numbered steps under “How to verify”",
  notesHasH2: "the file contains a `## ` heading (use `###` only; a `## ` heading breaks replacing this section)",
  notesNotWritten: "⚠️ The implementer did not write acceptance notes",
  notesBadFormat: (problems) => `⚠️ Acceptance notes are malformed: ${problems}`,
  prepPage: (branch) => `### Setup\n\n\`git checkout ${branch}\`. This ticket changes pages, so start the dev server (the project has no setup steps configured)`,
  prepNoPage: (branch) => `### Setup\n\n\`git checkout ${branch}\` (no page changes, no dev server needed)`,

  usageNone: "(no usage recorded)",
  usageHeader: "| Session | Profile | Runs | Input | Cache write | Cache read | Output | Peak context |",
  usageProfile: (profile, model) => `${profile} (${model})`,
  usageLimited: "hit usage limit, switched to next profile",
  budgetNote: (peakK, budgetK, sessions) => `Peak context about ${peakK}k / ${budgetK}k; implement used ${sessions} session(s).`,
  overBudget: "\n\n⚠️ Over the context budget; consider splitting similar tickets smaller.",
  tierFull: "full tests",
  gateFailed: (out) => `❌ Gate failed:\n\n\`\`\`\n${out}\n\`\`\``,
  gateFlaky: (tier, out) =>
    `Typecheck passed; ⚠️ ${tier} had flaky failures that passed when the failing files were rerun (in the sandbox). Tickets were opened to fix them (see PR comments).\n\n\`\`\`\n${out}\n\`\`\``,
  gatePassed: (tier, out) => `Typecheck and ${tier} passed (in the sandbox).\n\n\`\`\`\n${out}\n\`\`\``,
  browserNoResult: "(the implementer did not write RESULT.md)",
  browserShots: (n) => `${n} screenshot(s) attached below.`,
  browserReviewerVerdict: "Reviewer's verdict",
  browserSelfCheck: "Implementer's self-check (RESULT.md)",
  browserNoReviewerVerdict: "The reviewer gave no per-step verdict",
  revisions: (n) => `\n\n**The reviewer sent it back ${n} time(s)** (the implementer addressed the feedback):\n\n`,
  revisionN: (n) => `Feedback round ${n}`,
  noReviewSummary: "(the reviewer gave no summary)",

  prUpdated: "Sandcastle updated this branch.",
  prUpdatedNotes: "Sandcastle updated this branch (acceptance notes updated).",
  notMerged: (reason) => `Not merged automatically: ${reason}`,
  decisions: (n, issueId, label) =>
    `## Decisions made by the agent\n\nThe agent made ${n} design decision(s) itself under the “must stop / may decide” rules. Please confirm them (reply on the issue if you disagree; once confirmed, remove \`${label}\` from #${issueId}):`,
  decisionN: (n) => `Decision ${n}`,
  reopened: "Changes requested; this ticket is back in Sandcastle. The implementer will address the feedback on this PR first.",
  flakyTicketsOpened: (tickets) => `Opened tickets for flaky failures in the gate: ${tickets}`,
  flakyDeferred: (files) =>
    `Passed only on rerun with a timeout or connection error, first time in 7 days; recorded in .sandcastle/logs/flaky.json without a ticket: ${files}`,
  rebasedTypecheckOnly: (base, how, files) =>
    `Sandcastle rebased this branch onto the latest ${base} (it conflicted; ${how}; conflicting files: ${files}). After the rebase only typecheck was run (passed); **tests were not rerun**: the test results in the Gate section predate the rebase, so decide whether to rerun them before merging.`,
  rebaseHowAgent: "the agent resolved the conflicts",
  rebaseHowClean: "the rebase had no conflicts",
  parentClosed: (children: string) => `Child tickets ${children} are all closed; Sandcastle closed this parent ticket.`,
  rebaseNoTextConflict: (integrity) => `(no textual conflicts; ${integrity} diverged)`,
  rebasedMerged: (base) => `Sandcastle rebased this branch onto the latest ${base} and merged it after the gate passed again.`,

  reasonExternal: (verdict, gateOk) =>
    `This is an external PR: Sandcastle only makes changes, a human decides whether to merge. Reviewer verdict: ${verdict}; gate ${gateOk ? "passed" : "failed"} (see the comments above).`,
  reasonExternalConflict: (base, branch) => `\n\n⚠️ The branch conflicts with the latest ${base}; merge ${branch} into it first.`,
  reasonNotes: (problems) => `\n\nAcceptance notes are missing or malformed: ${problems} (see the “Acceptance notes” section of the PR description).`,
  reasonReviseMax: (n) => `The reviewer still found issues after sending it back ${n} time(s) (see the latest Review).`,
  reasonReviewerPr: "The reviewer thinks a human should review this (see the Review section of the PR description).",
  reasonGate: "Typecheck or the full test run failed (see the Gate section of the PR description).",
  reasonReReview: (kind, summary) =>
    `The ${kind === "fix" ? "re-review after the fix" : "re-review after resolving rebase conflicts"} did not pass:\n\n${summary}`,
  reReviewNoVerdict: "(the re-review gave no verdict; treated as not passing)",
  reReviewCommitted: (before, after) =>
    `The re-review session committed changes (HEAD before the re-review ${before || "unknown"}, after ${after || "unknown"}). The re-review only reviews and must not edit; these commits passed neither the gate nor review, so please check or revert them`,
  reasonHeadUnknown: "couldn't read HEAD before/after the fix, so what the fix changed is unknown; not re-reviewed",
  reReviewNoRange: "(the branch range before the rebase could not be read, so the re-review can't compare; treated as not passing)",
  reasonProtected: (hits) =>
    `Protected paths (protectedPaths) were changed; a human needs to look before merging:\n\n${hitLines(hits)}`,
  protectedAllowed: (hits) => hitLines(hits, " (ticket allowed)"),
  protectedAllowedUnmatched: (entries) =>
    `\n\nThese \`- **Protected**\` entries in the ticket's implementation guide matched no hit: ${entries.map((e) => `\`${e}\``).join(", ")}. Paths are relative to the repo root, directories end with \`/\`, and files must equal the path in the diff exactly.`,
  protectedAllowedAfterRebase: (section) => `Resolving the rebase conflicts touched more protected paths the ticket allows:\n\n## Protected paths\n\n${section}`,
  reasonProtectedUnknown: "Couldn't read this ticket's diff, so whether it changes protected paths (protectedPaths) is unknown; a human needs to look before merging.",
  reasonAutoMergeOff: "The project config has autoMerge: false (trial period). Reviewer and gate both passed; waiting for a human to merge.",
  reasonMainBroken: (n) => `The fallback full test run on main failed; waiting for #${n} to be fixed before merging.`,
  reasonMainBrokenUnknown: (err) => `Couldn't list the open main-broken tickets (${err}); not auto-merging to be safe.`,
  reasonBrowser: (problems) => `Pages changed and the browser check doesn't meet the auto-merge conditions: ${problems} (see the Browser check section of the PR description).`,
  reasonNoBrowserConfig:
    "Pages changed but this project has no browser check configured, so it can't auto-merge. To fix: rerun onboard so it writes the “Browser check” section, or add `## Browser check` to `.sandcastle/PROJECT.md` yourself (how to prepare data, start the dev server in the background, log in, check the logs), and set `browser.pagePaths` if needed; restart Sandcastle afterwards.",
  browserNotDone: "pages changed but no browser check was done (no `.browser-check/` in the worktree)",
  browserNoShots: "no screenshots",
  browserNoResultFile: "no RESULT.md",
  browserFailedItems: (lines) => `RESULT.md has failing items (❌ / ⚠): ${lines.map((l) => `“${l}”`).join(", ")}`,
  browserMissingShots: (names) => `screenshots referenced in RESULT.md don't exist: ${names}`,
  browserTagNotDone: (tag) => `the review's browser-check is \`${tag}\`, not done`,
  browserNoTag: "the review gave no browser-check (done is required)",
  browserNoVerdict: "the review said browser-check done but gave no per-step browser-verdict",
  browserVerdictFailed: (lines) => `the reviewer's own look at the screenshots found failing steps: ${lines.map((l) => `“${l}”`).join(", ")}`,
  browserStale: (files) => `pages changed by revise / fix after the browser check, so the screenshots are out of date: ${files}`,
  browserStaleUnknown: "couldn't read the commit at the browser check or the diff since, so can't tell whether the screenshots are out of date",
  reasonBrowserStaleAfterRebase: (files) =>
    files
      ? `Resolving the rebase conflicts changed pages, so the screenshots are out of date; a human needs to recheck: ${files}`
      : "Resolving the rebase conflicts: couldn't read the diff, so whether pages changed is unknown; treating the screenshots as out of date, a human needs to recheck.",
  browserNoTicketCheck:
    "⚠️ Pages changed, but the ticket has no Browser check; consider adding a prep rule: when prep writes the implementation guide, tickets that change pages should get a `- **Browser check**` item (which role opens which page, what to do, what should be seen).",
  reasonMergeFailed: (out, retry) => `Merge failed: ${out}\n\nRetrying after a rebase also failed: ${retry}`,
  reasonBranchProtection: (out) =>
    `The gate passed, but the repository's branch protection won't let Sandcastle merge (required reviews, required checks, merge queue, etc.). Please merge it yourself, or adjust the branch protection / \`mergeRequires\` in the config. gh's error: ${out}`,
  reasonChecksFailed: (list) =>
    `The gate passed, but checks on the PR failed, so it was not merged. Merging requires both the gate and the forge checks to pass; if the CI itself is unreliable, set \`mergeRequires: { checks: "none" }\` in the config to rely on the gate alone. Failed checks:\n\n${list}`,
  reasonChecksTimeout: (list, minutes) =>
    `The gate passed, but checks on the PR were still running after ${minutes} minute${minutes === 1 ? "" : "s"}, so it was not merged. Merging requires both the gate and the forge checks to pass; if the CI itself is unreliable, set \`mergeRequires: { checks: "none" }\` in the config to rely on the gate alone. Checks still running:\n\n${list}`,
  rebasedForHuman: (base) => `\n\nThe branch conflicted with the latest ${base} and was rebased; only typecheck was rerun (passed), tests were not.`,
  rebaseForHumanFailed: (base, reason) => `\n\n⚠️ The branch conflicts with the latest ${base} and the automatic rebase failed: ${reason}`,

  rebaseExternal: (branch) => `Sandcastle does not rebase or merge the external PR branch ${branch}.`,
  rebaseNotBehind: (base) => `The branch already contains the latest ${base}; the failure is not caused by a conflict and needs a human.`,
  rebaseAgentFailed: "The agent could not resolve the rebase conflicts (see the issue comments).",
  rebaseStillBehind: (base) => `After resolving, the branch is still not on top of ${base}.`,
  rebaseStillBroken: (broken) => `After resolving, still: ${broken}.`,
  rebaseTypecheckFailed: (out) => `Typecheck failed after the rebase:\n\n\`\`\`\n${out}\n\`\`\``,
  rebaseGateFailed: (out) => `The gate failed after the rebase:\n\n\`\`\`\n${out}\n\`\`\``,
  rebaseMergeFailed: (out) => `Merge still failed after rebasing and passing the gate: ${out}`,
  integrityName: "the integrity check",
  integrityBroken: "the integrity check failed",

  stuck: (reason) => `Sandcastle stopped: ${reason}`,
  missingBlocker: (blockers, stuckLabel) =>
    `${blockers} in \`## Blocked by\` can't be found in this repository (a mistyped number, or copied from another repository). Fix Blocked by or delete that line, then remove ${stuckLabel} to continue.`,
  untrustedAuthor: (login, triage, trusted) =>
    `This ticket's author @${login} doesn't have write access to this repository, so Sandcastle won't prep or implement it. Once someone with write access has reviewed it and confirmed it can go to Sandcastle, add \`${trusted}\` and remove \`${triage}\`, and it will be scheduled as usual.`,
  needsTriageLabelDesc: "Ticket author lacks write access; waiting for a maintainer",
  trustedLabelDesc: "A maintainer confirmed this ticket can go to Sandcastle",
  sandboxError: (err) => `sandbox error: ${err}`,
  podmanDown: (err) => `podman unreachable (still failing after several retries): ${err}`,
  gateEnvDown: (line, stuckLabel) => `A service the gate depends on is unreachable (\`${line}\`) and still wasn't back after the retries. Bring the service up, then remove ${stuckLabel}.`,
  agentIdleTimeout: (seconds, stuckLabel) =>
    `The agent produced no output for ${seconds} seconds and was treated as stuck (AgentIdleTimeoutError). If tests or builds legitimately take this long, raise \`agentIdleTimeoutS\` in \`.sandcastle/sandcastle.config.ts\` (currently ${seconds}), then remove ${stuckLabel} and run again.`,
  pushedTo: (branch) => `Existing commits were pushed to \`${branch}\`. `,
  pushedHere: "Existing commits were pushed to this branch.",
  notPushed: "The commits could not be pushed and remain on the local branch on the host. ",
  needsDecision: (budget, pushed, stuckLabel) =>
    `The implementer hit a design decision that a human must make (see the implementer's comment above). ${budget} ${pushed}Reply on the ticket with the decision and remove ${stuckLabel} to continue.`,
  reprepFailed: (max, budget) =>
    `Already re-prepped once and still not done within ${max} session(s) (see the implementer's comments above). ${budget} Please check how to split this ticket.`,
  externalIncomplete: (branch, max, budget, pushed) =>
    `Not finished on the external PR branch \`${branch}\` within ${max} session(s) (see the implementer's comments above). ${budget} ${pushed}`,
  reprep: (max, budget, stuckLabel) =>
    `Not done within ${max} session(s). ${budget} At the next schedule prep will re-prepare from the implementer's progress comments above: rewrite the guide if it is wrong, or split the unfinished acceptance criteria into sub-tickets if the ticket is too big. If it still is not done, it gets ${stuckLabel}.`,
  reprepCommits: (branch, log) => `\n\nCommits already on \`${branch}\`:\n\n${log}`,
  reprepNoCommits: "\n\nNo commits on the branch yet.",
  reprepNotPushed: "\n\n(The branch could not be pushed; the next round continues on the local branch of the same name.)",
  landError: (branch, reason, stuckLabel) =>
    `Sandcastle stopped: landing (push / open PR / merge) failed; the local branch \`${branch}\` is kept.\n\n\`\`\`\n${reason}\n\`\`\`\n\nFix it, then remove ${stuckLabel} and run again.`,
  limitedWaiting: (phase, profiles, until, mark) =>
    `⏸ Every profile for phase ${phase} (${profiles.map((p) => `\`${p}\``).join(", ")}) hit its usage limit; resuming around ${until} (local time on the machine running Sandcastle). Nothing to do.\n\n${mark}`,

  flakyLabelDesc: "Flaky tests (opened automatically by the Sandcastle gate)",
  mergingLabelDesc: "Gate passed, PR open; Sandcastle is waiting for checks / merging (resumes after a restart)",
  waitingMainLabelDesc: "Held as a PR by main-broken; auto-rebased and re-gated once main is fixed (created by the pipeline)",
  reviewedLabelDesc: "Review passed; Sandcastle is running the gate (a restart goes straight to the gate)",
  reviewedNote: (sha) =>
    `✅ Review passed (branch HEAD \`${sha.slice(0, 12)}\`); the gate runs next. After an interrupt and restart, if the branch is unchanged, it goes straight to the gate without reimplementing or re-reviewing.`,
  flakySeen: (issueId, pr) => `the gate of #${issueId} (PR #${pr})`,
  flakyEnv: (others, load, cores) =>
    `When opened: tickets in progress ${others.length ? others.join(", ") : "none"}; host load (1 / 5 / 15 min) ${load} (${cores} cores).`,
  flakyPriorItem: (at, issue, file) => `${at}Z gate of #${issue} (\`${file}\`)`,
  flakyPrior: (items) => `Earlier sightings in the last 7 days: ${items.join("; ")}.`,
  flakyAgain: (seen, files) => (files ? `Seen again: ${seen}; failing files this time: ${files}.` : `Seen again: ${seen}.`),
  flakyFirstFailure: "First failure:",
  flakyTitle: (file, n) => `Flaky test: ${file}${n > 1 ? ` and ${n - 1} more file(s)` : ""}`,
  mainBrokenLabelDesc: "Full test run on main failed (opened automatically by Sandcastle, scheduled first)",
  mainFixedRebase: "The fallback full test on main is fixed; rebasing onto the latest main and rerunning the gate before merging",
  mainBrokenAgain: (short, summary) => `The full test run on main (${short}) failed again:\n\n${summary}`,
  mainBrokenTitle: (short) => `Full test run failed on main (${short})`,
  mainBrokenNoHistory: "(no earlier passing run; the last 20 commits follow)",

  flakyIssueBody: (list, seen, env, prior, summary) =>
    [
      `${list} failed in the tests of ${seen} and passed when rerun alone.`,
      "", env, ...(prior ? ["", prior] : []),
      "", "## First failure", "", summary, "",
      "## How to fix", "",
      "First get a command that makes it fail reliably, then change the code. If you cannot reproduce it, infer the cause from the summary and the code, and explain the reasoning in the commit message.",
      "",
      "## Acceptance criteria", "",
      "- [ ] The cause is written in the commit message (the reproduction command, or the reasoning)",
      `- [ ] After the fix the reproduction command passes and ${list} pass alone; if another commit already fixed the root cause, only verify, don't change code`,
      "- [ ] Don't raise global timeouts, don't delete or weaken assertions",
    ].join("\n"),
  mainBrokenIssueBody: (sha, summary, commits) =>
    [
      `Sandcastle ran the full test suite (\`GATE_FULL=1\`) on main at \`${sha}\` and it failed.`,
      "Tickets that select tests by dependency only run part of the suite; a failure here means either the dependency graph missed something, or two tickets that passed on their own break together.",
      "", "## Failure summary", "", summary, "",
      "## Commits merged into main since the last passing full run", "", "```", commits, "```", "",
      "## Acceptance criteria", "",
      "- [ ] The failing test files pass alone on main; the cause (which commit, and why) is in the commit message",
      "- [ ] Don't raise global timeouts, don't delete or weaken assertions",
      "- [ ] State in an issue comment whether the dependency graph missed it",
    ].join("\n"),

  // —— 主动通知（webhook，notify.ts） —— / Proactive notifications (webhook, notify.ts)
  /**
   * webhook 消息的 text：一行给人看，Slack incoming webhook 直接认（飞书、企业微信、钉钉的群机器人要各自的格式，不兼容）。
   * The webhook message's text: one human-readable line, accepted as-is by a Slack incoming webhook (Lark, WeCom and DingTalk bots need their own formats and are not compatible).
   */
  notifyText: (event, issue, url, reason) => notifyLine(enEventNames[event], issue, url, reason, "Sandcastle: "),
  notifyLimited: (phase, profiles, until) =>
    `every profile for phase ${phase} (${profiles.join(", ")}) hit its usage limit; the run resumes around ${until} (local time).`,
  notifyPrepLimited: (until) => `prep hit its usage limit; it resumes around ${until} (local time).`,
  notifyPrepStuck: "prep needs a human decision or more information; see the comments on the ticket.",
  notifyTest: "this is a test message from sandpipe doctor --notify-test.",

  outputLanguage:
    "Output language: write everything that goes onto the issue tracker or a PR in English: ticket titles and bodies, progress comments, acceptance notes, the review summary (translate the fixed labels in the output templates below, but keep `<tags>`, HTML comments, `## Implementation guide`, `## Blocked by`, `## Acceptance criteria` and the other `##` section names exactly as written). Commit messages follow the “提交” section of PROJECT.md. The instructions below are in Chinese; read them, but answer in English.",
};

export const messages = (lang: Language = "zh"): Messages => (lang === "en" ? en : zh);
