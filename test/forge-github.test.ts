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
  it("listOpenIssues 用 --label（实时接口），标签名摊平成字符串，作者归一成 login / bot", () => {
    const { forge, calls } = fakeGh(
      JSON.stringify([
        { number: 7, title: "t", body: "b", labels: [{ name: "Sandcastle" }], updatedAt: "u", author: { id: "x", is_bot: false, login: "alice", name: "A" } },
        { number: 8, title: "t", body: "b", labels: [], updatedAt: "u", author: { login: "app/sandcastle", is_bot: true } },
        { number: 9, title: "t", body: "b", labels: [], updatedAt: "u", author: null },
      ]),
    );
    expect(forge.listOpenIssues(["Sandcastle", "sandcastle:prepped"])).toEqual([
      { number: 7, title: "t", body: "b", labels: ["Sandcastle"], updatedAt: "u", author: { login: "alice", bot: false } },
      { number: 8, title: "t", body: "b", labels: [], updatedAt: "u", author: { login: "app/sandcastle", bot: true } },
      { number: 9, title: "t", body: "b", labels: [], updatedAt: "u", author: { login: "ghost", bot: false } },
    ]);
    expect(calls[0]).toEqual([
      "issue", "list", "--state", "open", "--limit", "200",
      "--label", "Sandcastle", "--label", "sandcastle:prepped", "--json", "number,title,body,labels,updatedAt,author",
    ]);
  });

  it("repoPermission 查协作者权限接口", () => {
    const { forge, calls } = fakeGh("write");
    expect(forge.repoPermission("alice")).toBe("write");
    expect(calls).toEqual([["api", "repos/{owner}/{repo}/collaborators/alice/permission", "--jq", ".permission"]]);
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

  it("issueState 在 gh 报编号不存在时返回 missing，其他错误照旧抛出", () => {
    const failing = (stderr: string) =>
      githubForge(() => {
        throw Object.assign(new Error("gh"), { stderr });
      });
    expect(failing("GraphQL: Could not resolve to an issue or pull request with the number of 99. (repository.issue)").issueState("99")).toBe("missing");
    expect(() => failing("error connecting to api.github.com").issueState("99")).toThrow();
  });

  it("prChecks 发 gh pr checks --json，bucket 归一成 pass / fail / pending", () => {
    const rows = [
      { name: "a", bucket: "pass", link: "https://x/a" },
      { name: "b", bucket: "skipping", link: "" },
      { name: "c", bucket: "fail", link: "https://x/c" },
      { name: "d", bucket: "cancel" },
      { name: "e", bucket: "pending", link: "https://x/e" },
    ];
    const { forge, calls } = fakeGh(JSON.stringify(rows), "[]");
    expect(forge.prChecks!("13", false)).toEqual([
      { name: "a", state: "pass", link: "https://x/a" },
      { name: "b", state: "pass" },
      { name: "c", state: "fail", link: "https://x/c" },
      { name: "d", state: "fail" },
      { name: "e", state: "pending", link: "https://x/e" },
    ]);
    expect(forge.prChecks!("13", true)).toEqual([]);
    expect(calls).toEqual([
      ["pr", "checks", "13", "--json", "name,bucket,link"],
      ["pr", "checks", "13", "--json", "name,bucket,link", "--required"],
    ]);
  });

  it("prChecks：没有检查返回 []，退出码 8 带 stdout 照常解析，其他错误照旧抛出", () => {
    const failing = (stdout: string, stderr: string) =>
      githubForge(() => {
        throw Object.assign(new Error("gh"), { stdout, stderr });
      });
    expect(failing("", "no checks reported on the 'b' branch").prChecks!("13", false)).toEqual([]);
    expect(failing(JSON.stringify([{ name: "ci", bucket: "pending", link: "l" }]), "").prChecks!("13", false)).toEqual([
      { name: "ci", state: "pending", link: "l" },
    ]);
    expect(() => failing("", "error connecting to api.github.com").prChecks!("13", false)).toThrow();
  });

  it.each([
    [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "conflicting"],
    [{ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }, "conflicting"],
    [{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "unknown"],
    [{ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }, "clean"],
  ])("prMergeable 发 gh pr view --json mergeable,mergeStateStatus：%j → %s", (row, expected) => {
    const { forge, calls } = fakeGh(JSON.stringify(row));
    expect(forge.prMergeable!("13")).toBe(expected);
    expect(calls).toEqual([["pr", "view", "13", "--json", "mergeable,mergeStateStatus"]]);
  });

  it("prMergeable：gh 报错照旧抛出", () => {
    const forge = githubForge(() => {
      throw new Error("error connecting to api.github.com");
    });
    expect(() => forge.prMergeable!("13")).toThrow();
  });

  it("issueComments 走 REST 分页，每条评论一行 JSON，多行评论不被拆开，带作者（bot 按 user.type）", () => {
    const row = (body: string, login: string | null, bot: boolean) => JSON.stringify({ body, login, bot });
    // --paginate 配 --jq 时每页单独输出，拼起来就是逐行 / With --paginate and --jq each page prints separately; concatenated it's one per line
    const { forge, calls } = fakeGh(
      [row("第一行\n第二行", "alice", false), row("b", "github-actions[bot]", true), row("c", null, false)].join("\n"),
    );
    expect(forge.issueComments("4")).toEqual([
      { body: "第一行\n第二行", author: { login: "alice", bot: false } },
      { body: "b", author: { login: "github-actions[bot]", bot: true } },
      { body: "c", author: { login: "ghost", bot: false } },
    ]);
    expect(calls[0]).toEqual([
      "api", "repos/{owner}/{repo}/issues/4/comments", "--paginate",
      "--jq", ".[] | {body, login: .user.login, bot: (.user.type == \"Bot\")} | @json",
    ]);
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
        reviews: [
          { state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-01-02", author: { login: "alice" } },
          { state: "COMMENTED", body: "/sandcastle 改一下", submittedAt: "2026-01-03", author: { login: "app/sandcastle" } },
        ],
        comments: [
          { body: "hi", createdAt: "2026-01-01", author: { login: "dependabot[bot]" } },
          { body: "gone", createdAt: "2026-01-01", author: null },
        ],
        commits: [{ committedDate: "2026-01-02T10:00:00Z" }, { committedDate: "2026-01-01T00:00:00Z" }],
      }),
    );
    expect(forge.viewPr("5")).toEqual({
      id: "5", open: true, branch: "feat/x", fromFork: false,
      reviews: [
        { changesRequested: true, body: "", at: "2026-01-02", author: { login: "alice", bot: false } },
        { changesRequested: false, body: "/sandcastle 改一下", at: "2026-01-03", author: { login: "app/sandcastle", bot: true } },
      ],
      comments: [
        { body: "hi", at: "2026-01-01", author: { login: "dependabot[bot]", bot: true } },
        { body: "gone", at: "2026-01-01", author: { login: "ghost", bot: false } },
      ],
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

  it("agentGuide 读评论只看可信作者：不再用 --comments，每条 gh api 读评论的命令都按 author_association / Bot 过滤（#81）", () => {
    const guide = fakeGh().forge.agentGuide();
    expect(guide).not.toContain("--comments");
    const apiCmds = (guide.match(/`gh api [^`]+`/g) ?? []).filter((c) => /\/(comments|reviews)"/.test(c));
    // 票的评论、PR 的评论、review、行内意见
    expect(apiCmds).toHaveLength(4);
    for (const cmd of apiCmds) {
      expect(cmd).toContain('select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR" or .user.type == "Bot")');
      expect(cmd).toContain("--paginate");
    }
    expect(guide).toContain("gh issue view <n>`");
  });

  it("doctor 用的 checkAccess / listLabels：没登录、权限不够都抛错并说明", () => {
    const ok = fakeGh("", "acme/shop WRITE", "a\nb\n");
    expect(ok.forge.checkAccess()).toBe("gh 已登录，仓库 acme/shop（WRITE）");
    expect(ok.forge.listLabels()).toEqual(["a", "b"]);
    expect(ok.calls).toEqual([
      ["auth", "status", "--active"],
      ["repo", "view", "--json", "nameWithOwner,viewerPermission", "-q", '.nameWithOwner + " " + .viewerPermission'],
      ["label", "list", "--limit", "1000", "--json", "name", "-q", ".[].name"],
    ]);
    expect(ok.forge.tokenEnv).toBe("GH_TOKEN");

    const loggedOut = githubForge(() => {
      throw new Error("You are not logged into any GitHub hosts");
    });
    expect(() => loggedOut.checkAccess()).toThrow(/gh 没登录.*gh auth login/);
    expect(() => fakeGh("", "acme/shop READ").forge.checkAccess()).toThrow("至少要 WRITE");
  });
});
