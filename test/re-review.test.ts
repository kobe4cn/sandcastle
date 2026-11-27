// fix 之后的复审（#70）：要不要复审、diff 命令、复审结论解析。
// Re-review after fix (#70): whether to re-review, the diff command, parsing the re-review verdict.
import { describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import { fixDiffCmd, needsReReview, reReviewVerdict } from "../src/re-review.ts";

const zh = messages("zh");
const en = messages("en");

describe("re-review", () => {
  it("needsReReview：前后 HEAD 都非空且不同才复审", () => {
    expect(needsReReview("abc", "def")).toBe(true);
    expect(needsReReview("abc", "abc")).toBe(false);
    expect(needsReReview("", "def")).toBe(false);
    expect(needsReReview("abc", "")).toBe(false);
    expect(needsReReview("", "")).toBe(false);
  });

  it("fixDiffCmd：只看 fix 前 HEAD 之后的提交", () => {
    expect(fixDiffCmd("abc123")).toBe("git log --oneline abc123..HEAD && git diff abc123..HEAD");
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
});
