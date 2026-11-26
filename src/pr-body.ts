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

/** Gate / Budget / Usage 的内容（不含 `## 标题` 行）。 / Content of Gate / Budget / Usage (without the `## title` line). */
export type RestSections = {
  /** Review 一节：reviewer 摘要 + 打回记录。 / Review section: reviewer summary + revision history. */
  review: string;
  /**
   * Browser check 一节（RESULT.md 与截图说明）；没做浏览器验收时 undefined，不放这一节。
   * Browser check section (RESULT.md and screenshot notes); undefined when no browser check was done, so the section is omitted.
   */
  browser?: string;
  gate: string;
  budget: string;
  /** Usage 一节的表格（models.ts 的 usageTable）。 / Table for the Usage section (usageTable in models.ts). */
  usage: string;
};

/**
 * PR 正文除「验收说明」外的其余各节：Review → Browser check 在外面，Gate / Budget / Usage 折进 details。
 * PR body sections other than acceptance notes: Review → Browser check stay outside, Gate / Budget / Usage fold into details.
 */
export const restSections = (s: RestSections): string =>
  [
    `## Review\n\n${s.review}`,
    s.browser === undefined ? undefined : `## Browser check\n\n${s.browser}`,
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
