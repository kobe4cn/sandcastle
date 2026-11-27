// 评审通过的状态落盘（#49）：review 给出 merge 后、跑门槛前在票上留一条带 sha 的标记评论（另打 sandcastle:reviewed 标签），
// 进程中断重启后分支 HEAD 还是这个 sha，就跳过 implement / review 直接跑门槛。这里只放纯函数，读写票在 main.ts。
// Persisting a passed review (#49): after review says merge and before the gate, leave a marker comment with the sha on the ticket (plus the sandcastle:reviewed label);
// after an interrupt and restart, if the branch HEAD is still that sha, skip implement / review and go straight to the gate. Only pure functions here; main.ts reads and writes the ticket.
import type { Messages } from "./i18n.ts";

export const REVIEWED_MARK_PREFIX = "<!-- sandcastle:reviewed@";
const DATA_PREFIX = "<!-- sandcastle:reviewed-data ";

/** 恢复时 PR 正文要用的评审结果。 / Review results the PR body needs on resume. */
export type ReviewedData = { summary: string; revisions: string[]; browserTag: string | undefined };
export type ReviewedState = ReviewedData & { sha: string };

/**
 * 标记评论：首行 `<!-- sandcastle:reviewed@<sha> -->`，中间给人看的说明，最后一段 HTML 注释里的 JSON 存评审结果。
 * JSON 里的 `<` `>` 转成 `\u003c` / `\u003e`，免得 summary 里的 `-->` 提前结束注释。
 * The marker comment: first line `<!-- sandcastle:reviewed@<sha> -->`, a note for humans in the middle, and the review results as JSON in a trailing HTML comment.
 * `<` and `>` in the JSON become `\u003c` / `\u003e` so a `-->` in the summary can't end the comment early.
 */
export function reviewedComment(sha: string, data: ReviewedData, m: Messages): string {
  const json = JSON.stringify({ summary: data.summary, revisions: data.revisions, browserTag: data.browserTag ?? null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `${REVIEWED_MARK_PREFIX}${sha} -->\n${m.reviewedNote(sha)}\n\n${DATA_PREFIX}${json} -->`;
}

/**
 * 取最后一条带标记的评论解析出来；没有、或最后一条解析不了时返回 null（宁可重做，不拿坏数据恢复）。
 * Parse the last comment carrying the marker; null when there's none or the last one can't be parsed (better to redo than resume from bad data).
 */
export function parseReviewed(comments: readonly string[]): ReviewedState | null {
  const body = comments.findLast((c) => c.startsWith(REVIEWED_MARK_PREFIX));
  if (body === undefined) return null;
  const sha = /^<!-- sandcastle:reviewed@(\S+) -->/.exec(body)?.[1];
  const at = body.lastIndexOf(DATA_PREFIX);
  const end = body.lastIndexOf(" -->");
  if (!sha || at < 0 || end < at) return null;
  try {
    const d = JSON.parse(body.slice(at + DATA_PREFIX.length, end));
    if (typeof d?.summary !== "string") return null;
    if (!Array.isArray(d.revisions) || !d.revisions.every((r: unknown) => typeof r === "string")) return null;
    if (d.browserTag !== null && typeof d.browserTag !== "string") return null;
    return { sha, summary: d.summary, revisions: d.revisions, browserTag: d.browserTag ?? undefined };
  } catch {
    return null;
  }
}

/**
 * resume：HEAD 还是评审过的 sha，直接跑门槛；stale：HEAD 变了，清掉状态、正常重做；none：没有状态。
 * resume: HEAD is still the reviewed sha, go straight to the gate; stale: HEAD moved, clear the state and redo normally; none: no state.
 */
export function resumeDecision(state: ReviewedState | null, headSha: string): "resume" | "stale" | "none" {
  if (!state) return "none";
  return state.sha === headSha ? "resume" : "stale";
}
