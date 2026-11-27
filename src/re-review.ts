// 合并前的复审（#70）：门槛失败后 fix 会话改了代码（有新提交）且门槛重跑通过时，起一次 re-review 会话只看 fix 新加的提交，
// 结论不是 merge 就留 PR。这里只放纯函数，起会话和留 PR 在 main.ts（它加载时就跑主循环，没法单测）。
// Re-review before merging (#70): when the fix session after a failed gate changed code (new commits) and the gate rerun passed, a re-review session looks only at the fix's new commits,
// and anything other than merge leaves the PR open. Only pure functions here; starting the session and leaving the PR live in main.ts (it runs the main loop on load, so it can't be unit-tested).

import type { Messages } from "./i18n.ts";

/** agent 输出里 `<tag>…</tag>` 的内容（去掉首尾空白），没有时 undefined。 / The trimmed content of `<tag>…</tag>` in agent output, or undefined. */
export const tagged = (stdout: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(stdout)?.[1]?.trim();

/**
 * fix 前后的 HEAD 都取到了、且不同（fix 有新提交）才复审。取不到（空串）时不复审：没法确定 diff 的起点。
 * Re-review only when both HEADs (before / after the fix) were read and differ (the fix committed). An empty one means no re-review: the diff's start is unknown.
 */
export function needsReReview(before: string, after: string): boolean {
  return before !== "" && after !== "" && before !== after;
}

/** 复审看的 diff：fix 前 HEAD 之后的提交和改动。 / The diff the re-review looks at: commits and changes after the pre-fix HEAD. */
export function fixDiffCmd(before: string): string {
  return `git log --oneline ${before}..HEAD && git diff ${before}..HEAD`;
}

export type ReReview = { pass: boolean; summary: string };

/**
 * 只有 `<verdict>merge</verdict>` 算通过；没输出结论按不通过（fail-closed），摘要换成「复审没有输出结论」。
 * Only `<verdict>merge</verdict>` passes; no verdict counts as a fail (fail-closed) and the summary becomes "the re-review gave no verdict".
 */
export function reReviewVerdict(stdout: string, m: Messages): ReReview {
  const verdict = tagged(stdout, "verdict");
  if (verdict === undefined) return { pass: false, summary: m.reReviewNoVerdict };
  return { pass: verdict === "merge", summary: tagged(stdout, "review-summary") || m.noReviewSummary };
}
