// 评审通过的状态落盘（#49）：评论往返、取最后一条、坏评论、恢复判定。
// Persisting the passed review (#49): comment round trip, last one wins, broken comments, the resume decision.
import { describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import { parseReviewed, REVIEWED_MARK_PREFIX, resumeDecision, reviewedComment } from "../src/resume-state.ts";

const zh = messages("zh");
const en = messages("en");
const data = { summary: "看过了，<b>没问题</b>\n第二行 --> 也没事", revisions: ["改一下 A", "再改 B"], browserTag: "changed" };

describe("resume-state", () => {
  it.each([zh, en])("reviewedComment → parseReviewed 往返一致，首行是带 sha 的标记", (m) => {
    const body = reviewedComment("abc123", data, m);
    expect(body.split("\n")[0]).toBe(`${REVIEWED_MARK_PREFIX}abc123 -->`);
    expect(parseReviewed([body])).toEqual({ sha: "abc123", ...data });
  });

  it("browserTag 没有时往返也是 undefined", () => {
    const body = reviewedComment("abc", { summary: "s", revisions: [], browserTag: undefined }, zh);
    expect(parseReviewed([body])).toEqual({ sha: "abc", summary: "s", revisions: [], browserTag: undefined });
  });

  it("有多条评论时取最后一条带标记的", () => {
    const first = reviewedComment("old", { ...data, summary: "旧" }, zh);
    const second = reviewedComment("new", { ...data, summary: "新" }, zh);
    expect(parseReviewed([first, "别的评论", second, "之后的普通评论"])).toMatchObject({ sha: "new", summary: "新" });
  });

  it("没有标记评论、或最后一条解析失败时返回 null", () => {
    expect(parseReviewed([])).toBeNull();
    expect(parseReviewed(["普通评论"])).toBeNull();
    const good = reviewedComment("abc", data, zh);
    expect(parseReviewed([good, `${REVIEWED_MARK_PREFIX}def -->\n没有 JSON`])).toBeNull();
    expect(parseReviewed([`${REVIEWED_MARK_PREFIX}def -->\n<!-- sandcastle:reviewed-data {坏的 -->`])).toBeNull();
    expect(parseReviewed([`${REVIEWED_MARK_PREFIX}def -->\n<!-- sandcastle:reviewed-data {"summary":1} -->`])).toBeNull();
  });

  it("resumeDecision：sha 一致 resume，不一致 stale，没有状态 none", () => {
    const state = parseReviewed([reviewedComment("abc", data, zh)]);
    expect(resumeDecision(state, "abc")).toBe("resume");
    expect(resumeDecision(state, "def")).toBe("stale");
    expect(resumeDecision(null, "abc")).toBe("none");
  });
});
