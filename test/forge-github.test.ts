// GitHub Forge 的契约：每个方法发给 gh 的 argv 与 duckdb_crm 原 main.ts 里的调用逐字一致，
// 返回值按 forge.ts 的约定归一化。新加别的平台时照这个文件写它的契约测试。
import { describe, expect, it } from "vitest";
import { githubForge } from "../src/forges/github.ts";

/** 记录 argv、按顺序回放输出的假 gh。 */
function fakeGh(...outputs: string[]) {
  const calls: string[][] = [];
  const forge = githubForge((args) => {
    calls.push(args);
    return outputs.shift() ?? "";
  });
  return { forge, calls };
}

describe("githubForge 发给 gh 的参数", () => {
  it("listOpenIssues 用 --label（实时接口），标签名摊平成字符串", () => {
    const { forge, calls } = fakeGh(JSON.stringify([{ number: 7, title: "t", body: "b", labels: [{ name: "Sandcastle" }], updatedAt: "u" }]));
    expect(forge.listOpenIssues(["Sandcastle", "sandcastle:prepped"])).toEqual([
      { number: 7, title: "t", body: "b", labels: ["Sandcastle"], updatedAt: "u" },
    ]);
    expect(calls[0]).toEqual([
      "issue", "list", "--state", "open", "--limit", "200",
      "--label", "Sandcastle", "--label", "sandcastle:prepped", "--json", "number,title,body,labels,updatedAt",
    ]);
  });

  it("listClosedIssueNumbers / listSplitParents", () => {
    const { forge, calls } = fakeGh("3\n5\n", "[]");
    expect(forge.listClosedIssueNumbers("sandcastle:stuck")).toEqual([3, 5]);
    forge.listSplitParents("Sandcastle");
    expect(calls).toEqual([
      ["issue", "list", "--state", "closed", "--label", "sandcastle:stuck", "--limit", "100", "--json", "number", "--jq", ".[].number"],
      ["issue", "list", "--state", "open", "--limit", "100", "--search", `"Split into" in:body -label:"Sandcastle"`, "--json", "number,body"],
    ]);
  });

  it("issueState 归一成 open / closed", () => {
    const { forge, calls } = fakeGh("CLOSED", "OPEN");
    expect(forge.issueState("9")).toBe("closed");
    expect(forge.issueState("9")).toBe("open");
    expect(calls[0]).toEqual(["issue", "view", "9", "--json", "state", "--jq", ".state"]);
  });

  it("issueComments 每条评论一行 JSON，多行评论不被拆开", () => {
    const { forge, calls } = fakeGh(`${JSON.stringify("第一行\n第二行")}\n${JSON.stringify("b")}`);
    expect(forge.issueComments("4")).toEqual(["第一行\n第二行", "b"]);
    expect(calls[0]).toEqual(["issue", "view", "4", "--json", "comments", "--jq", ".comments[].body | @json"]);
  });

  it("issue 的增改与标签", () => {
    const { forge, calls } = fakeGh("https://github.com/o/r/issues/88");
    expect(forge.createIssue({ title: "T", body: "B", labels: ["flaky", "Sandcastle", "ready-for-agent"] })).toBe("88");
    forge.editIssueBody("1", "B2");
    forge.commentIssue("1", "C");
    forge.closeIssue("1", "done");
    forge.addLabel("1", "sandcastle:stuck");
    forge.removeLabel("1", "sandcastle:prepped");
    forge.ensureLabel("flaky", "fbca04", "D");
    expect(calls).toEqual([
      ["issue", "create", "--title", "T", "--body", "B", "--label", "flaky", "--label", "Sandcastle", "--label", "ready-for-agent"],
      ["issue", "edit", "1", "--body", "B2"],
      ["issue", "comment", "1", "--body", "C"],
      ["issue", "close", "1", "--comment", "done"],
      ["issue", "edit", "1", "--add-label", "sandcastle:stuck"],
      ["issue", "edit", "1", "--remove-label", "sandcastle:prepped"],
      ["label", "create", "flaky", "--color", "fbca04", "--description", "D"],
    ]);
  });

  it("PR：查找、新建（带截图附件）、正文、评论、合并", () => {
    const { forge, calls } = fakeGh("12", "", "https://github.com/o/r/pull/13", "BODY");
    expect(forge.findPr("sandcastle/issue-1", "open")).toBe("12");
    expect(forge.findPr("sandcastle/issue-1", "merged")).toBeUndefined();
    expect(forge.createPr({ base: "main", head: "sandcastle/issue-1", title: "T (#1)", body: "B", attachments: ["/tmp/x/a.png"] })).toBe("13");
    expect(forge.prBody("13")).toBe("BODY");
    forge.editPrBody("13", "B2");
    forge.commentPr("13", "C", ["/tmp/x/b.png"]);
    forge.commentPr("13", "C2");
    forge.mergePr("13", "rebase");
    expect(calls).toEqual([
      ["pr", "list", "--head", "sandcastle/issue-1", "--state", "open", "--json", "number", "--jq", ".[0].number"],
      ["pr", "list", "--head", "sandcastle/issue-1", "--state", "merged", "--json", "number", "--jq", ".[0].number"],
      ["pr", "create", "--base", "main", "--head", "sandcastle/issue-1", "--title", "T (#1)", "--body", "B", "--attach", "/tmp/x/a.png#a.png"],
      ["pr", "view", "13", "--json", "body", "--jq", ".body"],
      ["pr", "edit", "13", "--body", "B2"],
      ["pr", "comment", "13", "--body", "C", "--attach", "/tmp/x/b.png#b.png"],
      ["pr", "comment", "13", "--body", "C2"],
      ["pr", "merge", "13", "--rebase"],
    ]);
    expect(forge.closingRef("1")).toBe("Closes #1");
    expect(forge.viewIssueCommand("1")).toBe("gh issue view 1");
  });

  it("viewPr 归一化审查信号与最新提交时间；gh 出错时返回 null", () => {
    const { forge, calls } = fakeGh(
      JSON.stringify({
        number: 5, state: "OPEN", headRefName: "feat/x", isCrossRepository: false,
        reviews: [{ state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-01-02" }, { state: "COMMENTED", body: "/sandcastle 改一下", submittedAt: "2026-01-03" }],
        comments: [{ body: "hi", createdAt: "2026-01-01" }],
        commits: [{ committedDate: "2026-01-02T10:00:00Z" }, { committedDate: "2026-01-01T00:00:00Z" }],
      }),
    );
    expect(forge.viewPr("5")).toEqual({
      id: "5", open: true, branch: "feat/x", fromFork: false,
      reviews: [{ changesRequested: true, body: "", at: "2026-01-02" }, { changesRequested: false, body: "/sandcastle 改一下", at: "2026-01-03" }],
      comments: [{ body: "hi", at: "2026-01-01" }],
      lastCommitAt: "2026-01-02T10:00:00Z",
    });
    expect(calls[0]).toEqual(["pr", "view", "5", "--json", "number,state,headRefName,isCrossRepository,reviews,comments,commits"]);

    const failing = githubForge(() => {
      throw new Error("no pull requests found");
    });
    expect(failing.viewPr("sandcastle/issue-9")).toBeNull();
  });

  it("linkedPrIds 走 closedByPullRequestsReferences", () => {
    const { forge, calls } = fakeGh("5\n6");
    expect(forge.linkedPrIds("3")).toEqual(["5", "6"]);
    expect(calls[0]).toEqual(["issue", "view", "3", "--json", "closedByPullRequestsReferences", "--jq", ".closedByPullRequestsReferences[].number"]);
  });
});
