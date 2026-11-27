// fix / rebase 之后的复审（#70、#71）：要不要复审、diff 命令、复审结论解析。
// Re-review after fix / rebase (#70, #71): whether to re-review, the diff command, parsing the re-review verdict.
// 复审会话提交了改动或取不到 HEAD 时按不通过（#72）。 / A re-review session that committed, or an unreadable HEAD, fails (#72).
import { describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import { fixDiffCmd, needsReReview, rebaseDiffCmd, rebaseNeedsReReview, reReviewVerdict, reReviewWithHeads } from "../src/re-review.ts";

const zh = messages("zh");
const en = messages("en");

describe("re-review", () => {
  it.each([
    ["", "b", "unknown"],
    ["a", "", "unknown"],
    ["", "", "unknown"],
    ["a", "a", "skip"],
    ["a", "b", "review"],
  ] as const)("needsReReview(%j, %j) → %s（任一 HEAD 取不到时 unknown，不静默跳过，#73）", (before, after, want) => {
    expect(needsReReview(before, after)).toBe(want);
  });

  it("fixDiffCmd：只看 fix 前 HEAD 之后的提交", () => {
    expect(fixDiffCmd("abc123")).toBe("git log --oneline abc123..HEAD && git diff abc123..HEAD");
  });

  it("rebaseDiffCmd：range-diff 对比 rebase 前后的分支提交", () => {
    expect(rebaseDiffCmd("base0", "head0", "origin/main")).toBe("git range-diff base0..head0 origin/main..HEAD");
  });

  it("rebaseNeedsReReview：要合并且起了解冲突 agent（冲突或完整性链断）才复审", () => {
    expect(rebaseNeedsReReview({ conflicted: true, chainBroken: false, merge: true })).toBe(true);
    expect(rebaseNeedsReReview({ conflicted: false, chainBroken: true, merge: true })).toBe(true);
    // 干净 rebase 没起 agent，不复审。 / A clean rebase started no agent: no re-review.
    expect(rebaseNeedsReReview({ conflicted: false, chainBroken: false, merge: true })).toBe(false);
    // merge=false 只 typecheck、留给人审，不复审。 / merge=false only typechecks and leaves it for review: no re-review.
    expect(rebaseNeedsReReview({ conflicted: true, chainBroken: false, merge: false })).toBe(false);
    expect(rebaseNeedsReReview({ conflicted: false, chainBroken: true, merge: false })).toBe(false);
  });

  it("reReviewVerdict：merge 通过，摘要取 review-summary", () => {
    const out = "看过了\n<verdict>merge</verdict>\n<review-summary>\n没问题\n</review-summary>";
    expect(reReviewVerdict(out, zh)).toEqual({ pass: true, summary: "没问题" });
  });

  it("reReviewVerdict：pr 不通过，摘要照取", () => {
    const out = "<verdict> pr </verdict><review-summary>删了一条测试</review-summary>";
    expect(reReviewVerdict(out, zh)).toEqual({ pass: false, summary: "删了一条测试" });
  });

  it.each([zh, en])("reReviewVerdict：没输出结论按不通过（fail-closed），摘要用固定文案", (m) => {
    expect(reReviewVerdict("会话中途断了", m)).toEqual({ pass: false, summary: m.reReviewNoVerdict });
    // 有摘要但没结论：仍不通过，摘要说明没结论。 / A summary but no verdict: still fails, the summary says there's no verdict.
    expect(reReviewVerdict("<review-summary>还行</review-summary>", m)).toEqual({ pass: false, summary: m.reReviewNoVerdict });
  });

  it("reReviewVerdict：有结论没摘要时用固定的缺摘要文案", () => {
    expect(reReviewVerdict("<verdict>merge</verdict>", zh)).toEqual({ pass: true, summary: zh.noReviewSummary });
  });

  it("reReviewVerdict：结论不认识（比如 revise）也不通过", () => {
    expect(reReviewVerdict("<verdict>revise</verdict><review-summary>x</review-summary>", zh).pass).toBe(false);
  });

  it.each([
    [zh, "fix 之后的复审没通过", "rebase 解冲突之后的复审没通过"],
    [en, "re-review after the fix did not pass", "re-review after resolving rebase conflicts did not pass"],
  ])("reasonReReview：写明是哪一步之后的复审没过，附摘要", (m, fix, rebase) => {
    expect(m.reasonReReview("fix", "删了测试")).toContain(fix);
    expect(m.reasonReReview("fix", "删了测试")).toContain("删了测试");
    expect(m.reasonReReview("rebase", "s")).toContain(rebase);
  });
  const passed = { pass: true, summary: "没问题" };
  const failed = { pass: false, summary: "删了测试" };
  it.each([
    ["HEAD 相同 + 通过 → 通过", passed, "aaa", "aaa", passed],
    ["HEAD 相同 + 不通过 → 原样", failed, "aaa", "aaa", failed],
    ["HEAD 不同 + merge → 不通过", passed, "aaa", "bbb", { pass: false, summary: zh.reReviewCommitted("aaa", "bbb") }],
    ["HEAD 不同 + 不通过 → 不通过，说明提交了改动", failed, "aaa", "bbb", { pass: false, summary: zh.reReviewCommitted("aaa", "bbb") }],
    ["复审后取不到 HEAD → 不通过", passed, "aaa", "", { pass: false, summary: zh.reReviewCommitted("aaa", "") }],
    ["复审前取不到 HEAD → 不通过", passed, "", "aaa", { pass: false, summary: zh.reReviewCommitted("", "aaa") }],
    ["前后都取不到 HEAD → 不通过", passed, "", "", { pass: false, summary: zh.reReviewCommitted("", "") }],
  ] as const)("reReviewWithHeads：%s（#72）", (_, verdict, before, after, want) => {
    expect(reReviewWithHeads(verdict, before, after, zh)).toEqual(want);
  });

  it.each([
    [zh, "复审会话提交了改动", "取不到"],
    [en, "re-review session committed changes", "unknown"],
  ])("reReviewCommitted：写明复审会话提交了改动，附复审前后 HEAD，取不到时写明", (m, text, unknown) => {
    expect(m.reReviewCommitted("aaa111", "bbb222")).toContain(text);
    expect(m.reReviewCommitted("aaa111", "bbb222")).toContain("aaa111");
    expect(m.reReviewCommitted("aaa111", "bbb222")).toContain("bbb222");
    expect(m.reReviewCommitted("aaa111", "")).toContain(unknown);
  });
});
