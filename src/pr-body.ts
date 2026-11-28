// .sandcastle/pr-body.ts —— 拼 Sandcastle PR 正文、检查验收说明格式的纯函数（不 import main.ts、不跑命令），
// 测试在 test/sandcastle-pr-body.test.ts。验收说明是 implementer 写在 worktree `.pr-notes/验收说明.md`（不提交）、
// 给验收 PR 的人看的：做了什么、在宿主机上怎么一步步验证、最终效果。脚本（main.ts 的 land）把固定准备段落
// 拼在它前面，放进 PR 正文最前面的 `## 验收说明` 一节；缺失或格式不对时正文写警告、不自动合并。
// 文字按项目语言（i18n.ts）：参数 m 默认中文。
// .sandcastle/pr-body.ts: pure functions that build the Sandcastle PR body and check the acceptance notes format (no main.ts import, no commands);
// tests in test/sandcastle-pr-body.test.ts. Acceptance notes are written by the implementer to `.pr-notes/验收说明.md` in the worktree (not committed),
// for whoever verifies the PR: what changed, how to verify it step by step on the host, and the result. The script (land in main.ts) prepends fixed setup steps
// and puts it in the `## 验收说明` section at the top of the PR body; when missing or badly formatted the body shows a warning and the PR isn't auto-merged.
// Text follows the project's language (i18n.ts): parameter m defaults to Chinese.

import { basename } from "node:path";
import type { BrowserCheck } from "./browser-gate.ts";
import { messages, type Messages } from "./i18n.ts";

/**
 * `## 标题` 二级标题行的标题（`###` 小标题、`##x` 这种不是标题的都不认）；不是二级标题行时 undefined。
 * Title of a `## title` level-2 heading line (`###` subheadings and things like `##x` don't count); undefined for any other line.
 */
const headingOf = (line: string): string | undefined => (/^##(\s|$)/.test(line) ? line.replace(/^##\s*/, "") : undefined);


/**
 * 验收说明的问题列表（空数组 = 合格）：文件没写、缺三个小标题之一、「怎么验证」下没有编号步骤、
 * 文件里出现 `## ` 二级标题。main.ts 的 land 有问题时留 PR 不自动合并，reviewer 另有一道独立检查。
 */
export const checkAcceptanceNotes = (md: string | undefined, m: Messages = messages()): string[] => {
  // 必须有的三个小标题见 m.noteHeadings；`## ` 二级标题不能出现（replaceSection 按它切节，会被切错）。
  // The three required headings are m.noteHeadings; `## ` level-2 headings are not allowed (replaceSection splits sections on them and would cut wrongly).
  const NOTE_HEADINGS = m.noteHeadings;
  if (md === undefined) return [m.notesMissingFile];
  const lines = md.split("\n");
  const problems: string[] = [];
  for (const heading of NOTE_HEADINGS) {
    if (!lines.some((line) => line.trim().startsWith(heading))) problems.push(m.notesMissingHeading(heading));
  }
  const verifyAt = lines.findIndex((line) => line.trim().startsWith(NOTE_HEADINGS[1]));
  if (verifyAt >= 0) {
    const steps: string[] = [];
    for (const line of lines.slice(verifyAt + 1)) {
      if (line.trim().startsWith("###")) break; // 到下一个小标题为止 / up to the next subheading
      steps.push(line);
    }
    if (!steps.some((line) => /^\s*\d+\./.test(line))) problems.push(m.notesNoSteps);
  }
  if (lines.some((line) => headingOf(line) !== undefined)) {
    problems.push(m.notesHasH2);
  }
  return problems;
};

/**
 * 二级标题行降成 `###`：格式不对的原文照样进正文，但不能有 `## ` 行留在这一节里，否则重做时 replaceSection 在它那儿切断、旧尾巴永远留着。
 * Demote level-2 heading lines to `###`: badly formatted text still goes into the body, but no `## ` line may stay in this section, or a redo's replaceSection cuts there and the old tail stays forever.
 */
const demoteHeadings = (md: string): string =>
  md
    .split("\n")
    .map((line) => (headingOf(line) === undefined ? line : `#${line}`))
    .join("\n");

/**
 * PR 正文 `## 验收说明` 一节的内容（标题由 main.ts 的 pushAndOpenPr 加）：固定准备段落 + 文件内容，
 * 让验收的人能在宿主机上照做。不合格时给警告（文件不存在）或「格式不对」+ 问题列表 + 原文（二级标题降成 `###`），照样进正文让人看见。
 * pageChanged：有 `.browser-check/`，或 review 标了 `<browser-check>` 为 done / missing（改了页面）的票给项目配置的准备步骤（acceptancePrep），
 * 项目没配时写明要起 dev server；其余只要 checkout，不用起 dev server。
 * Content of the PR body's `## 验收说明` section (the heading is added by pushAndOpenPr in main.ts): fixed setup steps + the file's content,
 * so the verifier can follow along on the host. When invalid: a warning (file missing) or "bad format" + problem list + the original (level-2 headings demoted to `###`), still in the body for people to see.
 * pageChanged: tickets with `.browser-check/`, or whose review tagged `<browser-check>` as done / missing (page changes), get the project's setup steps (acceptancePrep),
 * or a note to start the dev server when the project has none; the rest only need a checkout, no dev server.
 */
export const acceptanceSection = (branch: string, md: string | undefined, opts: { pageChanged: boolean; pagePrep?: (branch: string) => string; m?: Messages }): string => {
  const m = opts.m ?? messages();
  const problems = checkAcceptanceNotes(md, m);
  if (problems.length > 0) {
    return md === undefined ? m.notesNotWritten : `${m.notesBadFormat(problems.join(m.sep))}\n\n${demoteHeadings(md)}`;
  }
  const prep = opts.pageChanged && opts.pagePrep ? opts.pagePrep(branch) : opts.pageChanged ? m.prepPage(branch) : m.prepNoPage(branch);
  return `${prep}\n\n${md}`;
};

/**
 * review 的 `<browser-check>` 标签是否说明改了页面：done（已做）或 missing（需要但没做）算，none、缺标签或其他值都不算。
 * Whether the review's `<browser-check>` tag says pages changed: done or missing count; none, a missing tag or any other value do not.
 */
export const pageChangedByReview = (tag: string | undefined): boolean => {
  const value = tag?.trim();
  return value === "done" || value === "missing";
};

/**
 * 一节折进 `<details>`：PR 正文默认收起，验收的人需要时展开。
 * Fold a section into `<details>`: collapsed by default in the PR body, the verifier expands it when needed.
 */
const details = (title: string, content: string) => `<details><summary>${title}</summary>\n\n${content}\n\n</details>`;

/**
 * Browser check 一节的内容。有 `.browser-check/` 时先放评审自己看截图给的逐条结论（reviewerVerdict，review 的 `<browser-verdict>`；没给就写明），
 * 再放 implement 自评：RESULT.md 与截图说明（#83），说明后面逐张接截图引用 `![文件名](路径)`（#113）——路径与传给 `gh --attach` 的完全相同，
 * gh 会把引用改写成上传后的地址，截图就显示在这一节里而不是被追加到正文末尾；再走一轮时引用随整段替换（replaceGenerated），不堆积。
 * 改了页面但票里没有 Browser check 时（noTicketCheck）在最前面加提示，没有 `.browser-check/` 也给。两样都没有时 undefined，不放这一节。
 * Content of the Browser check section. With `.browser-check/`: first the reviewer's own per-step verdict from the screenshots (reviewerVerdict,
 * the review's `<browser-verdict>`; says so when missing), then the implementer's self-check: RESULT.md and the screenshot note (#83),
 * followed by one screenshot reference per shot, `![filename](path)` (#113) — the path is exactly what's passed to `gh --attach`,
 * which rewrites the reference to the uploaded asset so the screenshots show up in this section instead of being appended to the end of the body;
 * on a redo the references go with the wholesale replace (replaceGenerated) and don't pile up.
 * When pages changed but the ticket has no Browser check (noTicketCheck), a notice goes first, even without `.browser-check/`.
 * undefined when there's neither, so the section is omitted.
 */
export const browserSection = (
  b: BrowserCheck | undefined,
  noTicketCheck: boolean,
  m: Messages = messages(),
  reviewerVerdict?: string,
): string | undefined => {
  const parts = [
    noTicketCheck ? m.browserNoTicketCheck : undefined,
    b
      ? `### ${m.browserReviewerVerdict}\n\n${reviewerVerdict ?? m.browserNoReviewerVerdict}\n\n` +
        `### ${m.browserSelfCheck}\n\n${b.result ?? m.browserNoResult}\n\n${m.browserShots(b.shots.length)}` +
        b.shots.map((p) => `\n\n![${basename(p)}](${p})`).join("")
      : undefined,
  ].filter((x): x is string => x !== undefined);
  return parts.length ? parts.join("\n\n") : undefined;
};

/** Gate / Budget / Usage 的内容（不含 `## 标题` 行）。 / Content of Gate / Budget / Usage (without the `## title` line). */
export type RestSections = {
  /** Review 一节：reviewer 摘要 + 打回记录。 / Review section: reviewer summary + revision history. */
  review: string;
  /**
   * Browser check 一节（browserSection：评审结论、implement 自评即 RESULT.md 与截图说明，或票缺 Browser check 的提示）；都没有时 undefined，不放这一节。
   * Browser check section (browserSection: the reviewer's verdict, the implementer's self-check i.e. RESULT.md and screenshot notes, or the missing-ticket-Browser-check notice); undefined when neither, so the section is omitted.
   */
  browser?: string;
  /**
   * Protected paths 一节（protected-paths.ts 的 allowedSection：票允许改的受保护路径）；没有时 undefined，不放这一节。
   * Protected paths section (allowedSection in protected-paths.ts: protected paths the ticket allows); undefined when none, so the section is omitted.
   */
  protected?: string;
  gate: string;
  budget: string;
  /** Usage 一节的表格（models.ts 的 usageTable）。 / Table for the Usage section (usageTable in models.ts). */
  usage: string;
};

/**
 * PR 正文除「验收说明」外的其余各节：Review → Browser check → Protected paths 在外面，Gate / Budget / Usage 折进 details。
 * PR body sections other than acceptance notes: Review → Browser check → Protected paths stay outside, Gate / Budget / Usage fold into details.
 */
export const restSections = (s: RestSections): string =>
  [
    `## Review\n\n${s.review}`,
    s.browser === undefined ? undefined : `## Browser check\n\n${s.browser}`,
    s.protected === undefined ? undefined : `## Protected paths\n\n${s.protected}`,
    details("Gate", s.gate),
    details("Budget", s.budget),
    details("Usage", s.usage),
  ]
    .filter((x): x is string => x !== undefined)
    .join("\n\n");

/**
 * 把正文里 `## <title>` 一节（标题行到下一个二级标题前，含节与下一节之间的空行）整节换成 content，
 * 其余逐字不变；正文里没有这一节时插在第一行（`Closes #n`）后面，空一行隔开。
 * 按行比对标题（不是拼正则），title 里的正则元字符不用转义。
 * Replace the whole `## <title>` section in the body (from its heading to before the next level-2 heading, including blank lines in between) with content,
 * leaving everything else verbatim; when the body has no such section, insert it after the first line (`Closes #n`) with a blank line.
 * Titles are compared line by line (no regex built), so regex metacharacters in title need no escaping.
 */
export const replaceSection = (body: string, title: string, content: string): string => {
  const lines = body.split("\n");
  const section = content.replace(/\s+$/, "").split("\n"); // 收尾空行不进正文，与下一节之间统一空一行 / trailing blank lines are dropped; exactly one blank line before the next section
  const start = lines.findIndex((line) => (headingOf(line) ?? "").startsWith(title));
  if (start === -1) {
    const after = lines.slice(1);
    return [...lines.slice(0, 1), "", ...section, ...(after.length > 0 && after[0]!.trim() !== "" ? [""] : []), ...after].join("\n");
  }
  const stop = lines.findIndex((line, i) => i > start && headingOf(line) !== undefined);
  const end = stop === -1 ? lines.length : stop;
  return [...lines.slice(0, start), ...section, ...(end < lines.length ? [""] : []), ...lines.slice(end)].join("\n");
};

/**
 * 取正文里 `## <title>` 一节（标题行到下一个二级标题行之前，含标题行）；正文里没有这一节时 undefined。
 * 供落地时读回核对：读回的正文和本轮的 rest 各取一次 Review 一节比对，两边切到同一个边界即一致
 * （评审摘要里可能有 `## ` 二级标题，两边都在它那儿截断，不影响比较）。
 * The `## <title>` section of the body (from the heading to before the next level-2 heading, heading included); undefined when absent.
 * For the read-back check at landing: take the Review section once from the read-back body and once from this round's rest and compare —
 * both cut at the same boundary, so they match (a review summary may contain `## ` headings; both sides truncate there, which doesn't affect the comparison).
 */
export const sectionOf = (body: string, title: string): string | undefined => {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => (headingOf(line) ?? "").startsWith(title));
  if (start === -1) return undefined;
  const stop = lines.findIndex((line, i) => i > start && headingOf(line) !== undefined);
  return lines.slice(start, stop === -1 ? lines.length : stop).join("\n");
};

/**
 * 把正文里由工具生成的各节整段换成本轮的 rest（restSections 的输出，以 `## Review` 开头）：
 * 从 `## Review` 标题行起、到 `## Commits` 标题行之前（没有 Commits 就到末尾），前后各留一个空行。
 * PR 再走一轮时上一轮的结论不在正文里保留（只留在更新评论里）：上一轮有、这一轮没有的节（如 Browser check）随整段消失，
 * 不能对每节单独 replaceSection——Gate / Budget / Usage 的 `<details>` 挂在最后一个 `##` 节下会被重复或误删，缺失的节会被插到 Closes 后面。
 * `## Commits` 及之后（含本票之前开的 PR 里 gh --attach 追加在末尾的截图行）逐字保留；正文里没有 `## Review` 时插在 `## Commits` 之前
 * （没有 Commits 就追加到末尾），不走 replaceSection 的「插在 Closes 后面」。评审摘要里可能有 `## ` 二级标题，
 * 所以只认 `## Commits` 这一个终点、不靠中间的二级标题。
 * Wholesale-replace the tool-generated sections in the body with this round's rest (restSections output, starting with `## Review`):
 * from the `## Review` heading to before the `## Commits` heading (to the end when there's no Commits), a blank line on each side.
 * On a redo the previous round's conclusions don't stay in the body (they live on in the update comments): sections present last round
 * but not this one (e.g. Browser check) vanish with the whole span — per-section replaceSection won't do: the Gate / Budget / Usage
 * `<details>` hang off the last `##` section and would be duplicated or dropped, and missing sections would be inserted after Closes.
 * `## Commits` and everything after (including screenshot lines gh --attach appended at the end of PRs opened before this ticket) stays verbatim;
 * with no `## Review` in the body, insert before `## Commits` (append at the end when there's no Commits) instead of replaceSection's
 * "insert after Closes". A review summary may contain `## ` headings, so `## Commits` is the only end marker, not any intermediate heading.
 */
export const replaceGenerated = (body: string, rest: string): string => {
  const lines = body.split("\n");
  const section = rest.replace(/\s+$/, "").split("\n"); // 收尾空行不进正文，与下一节之间统一空一行 / trailing blank lines are dropped; exactly one blank line before the next section
  const start = lines.findIndex((line) => (headingOf(line) ?? "").startsWith("Review"));
  const commits = lines.findIndex((line) => (headingOf(line) ?? "").startsWith("Commits"));
  if (start === -1) {
    const at = commits === -1 ? lines.length : commits; // 插入点：Commits 之前，没有就到末尾 / insertion point: before Commits, or the end when absent
    const before = at > 0 && lines[at - 1]!.trim() !== "" ? [""] : []; // 前面留一个空行（前面已是空行就不重复）/ one blank line before (skip when the line above is already blank)
    const after = at < lines.length ? [""] : [];
    return [...lines.slice(0, at), ...before, ...section, ...after, ...lines.slice(at)].join("\n");
  }
  // Review 一节在 Commits 之后时按没有终点处理（不会出现在真实正文里，只求不切错）。 / When Review sits after Commits (never in real bodies), treat it as having no end marker.
  const end = commits > start ? commits : lines.length;
  return [...lines.slice(0, start), ...section, ...(end < lines.length ? [""] : []), ...lines.slice(end)].join("\n");
};
