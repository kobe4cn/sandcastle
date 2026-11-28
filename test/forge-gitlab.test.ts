// GitLab Forge 的契约：每个方法发给 glab 的 argv（REST 走 glab api，:id 是 glab 的项目占位符），
// 返回值按 forge.ts 的约定归一化（iid→number、updated_at 转 UTC ISO、作者恒为 bot: false）。
// 照 test/forge-github.test.ts 写，不调真的 glab。
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitlabForge } from "../src/forges/gitlab.ts";
import { createTrust } from "../src/trust.ts";
import { setTermLanguage } from "../src/term.ts";

afterEach(() => {
  setTermLanguage("zh", {});
  vi.unstubAllEnvs();
});

/** 记录 argv（和可选的 env）、按顺序回放输出的假 glab。 / A fake glab recording argv (and optional env), replaying outputs in order. */
function fakeGlab(...outputs: string[]) {
  const calls: string[][] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const forge = gitlabForge((args, env) => {
    calls.push(args);
    envs.push(env);
    return outputs.shift() ?? "";
  });
  return { forge, calls, envs };
}

/** 抛错的假 glab（带 stderr，像 execFileSync 一样）。 / A failing fake glab with stderr, like execFileSync. */
const failingGlab = (stderr: string) =>
  gitlabForge(() => {
    throw Object.assign(new Error("glab"), { stderr });
  });

describe("gitlabForge 发给 glab 的参数", () => {
  it("listOpenIssues 走实时列表接口：iid→number、正文取 description、updated_at 转 UTC ISO、作者恒为 bot: false", () => {
    const { forge, calls } = fakeGlab(
      [
        JSON.stringify({ iid: 7, title: "t", description: "b", labels: ["Sandcastle", "sandcastle:stuck"], updated_at: "2026-11-27T10:00:00+08:00", author: { username: "alice" } }),
        JSON.stringify({ iid: 8, title: "t", description: null, labels: [], updated_at: "2026-11-28T00:00:00Z", author: null }),
      ].join("\n"),
    );
    expect(forge.listOpenIssues(["Sandcastle", "sandcastle:prepped"])).toEqual([
      { number: 7, title: "t", body: "b", labels: ["Sandcastle", "sandcastle:stuck"], updatedAt: "2026-11-27T02:00:00.000Z", author: { login: "alice", bot: false } },
      { number: 8, title: "t", body: "", labels: [], updatedAt: "2026-11-28T00:00:00.000Z", author: { login: "ghost", bot: false } },
    ]);
    // 逗号分隔符原样保留（编码了服务器就当成一个标签名）；标签名里的 : 编码成 %3A，服务器解码回来
    expect(calls).toEqual([["api", "projects/:id/issues?state=opened&labels=Sandcastle,sandcastle%3Aprepped&per_page=100", "--paginate", "--output", "ndjson"]]);
  });

  it("listOpenIssues 没有标签时整段省掉 labels（GitLab 的空 labels= 是「无标签的票」）", () => {
    const { forge, calls } = fakeGlab();
    expect(forge.listOpenIssues([])).toEqual([]);
    expect(calls).toEqual([["api", "projects/:id/issues?state=opened&per_page=100", "--paginate", "--output", "ndjson"]]);
  });

  it("分页列表带 --output ndjson：两页的对象各占一行、跨页有空行也全部收下（glab 的 --paginate 实际把几页 JSON 首尾相接，整个 parse 会炸）", () => {
    const page = (iid: number) => JSON.stringify({ iid, title: `t${iid}`, description: `b${iid}`, labels: [], updated_at: "2026-11-28T00:00:00Z", author: { username: `u${iid}` } });
    const { forge, calls } = fakeGlab([page(1), page(2), "", page(3)].join("\n"));
    expect(forge.listOpenIssues([]).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(calls).toEqual([["api", "projects/:id/issues?state=opened&per_page=100", "--paginate", "--output", "ndjson"]]);
  });

  it("listClosedIssueNumbers / listSplitParents（搜索是模糊的，回来本地确认正文含 ## Split into）", () => {
    const { forge, calls } = fakeGlab(
      [JSON.stringify({ iid: 3 }), JSON.stringify({ iid: 5 })].join("\n"),
      [
        JSON.stringify({ iid: 1, description: "x\n\n## Split into\n\n- #2" }),
        JSON.stringify({ iid: 2, description: "只有 Split into 字样、不是那个小节" }),
      ].join("\n"),
    );
    expect(forge.listClosedIssueNumbers("sandcastle:stuck")).toEqual([3, 5]);
    expect(forge.listSplitParents("Sandcastle")).toEqual([{ number: 1, body: "x\n\n## Split into\n\n- #2" }]);
    expect(calls).toEqual([
      ["api", "projects/:id/issues?state=closed&labels=sandcastle%3Astuck&per_page=100", "--paginate", "--output", "ndjson"],
      ["api", "projects/:id/issues?state=opened&search=Split%20into&in=description&not[labels]=Sandcastle&per_page=100", "--paginate", "--output", "ndjson"],
    ]);
  });

  it("issueState / issueUpdatedAt 各查一次票：state 归一成 open / closed，updated_at 转 UTC ISO", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify({ iid: 9, state: "closed", updated_at: "2026-11-27T10:00:00+08:00" }),
      JSON.stringify({ iid: 9, state: "opened", updated_at: "2026-11-28T00:00:00Z" }),
    );
    expect(forge.issueState("9")).toBe("closed");
    expect(forge.issueUpdatedAt("9")).toBe("2026-11-28T00:00:00.000Z");
    expect(calls).toEqual([
      ["api", "projects/:id/issues/9"],
      ["api", "projects/:id/issues/9"],
    ]);
  });

  it("issueState 在 glab 报 404 时返回 missing，其他错误照旧抛出", () => {
    expect(failingGlab('HTTP 404: {"message":"404 Issue Not Found"}').issueState("99")).toBe("missing");
    expect(() => failingGlab("error connecting to gitlab.example.com").issueState("99")).toThrow();
  });

  it("issueUrl 直接用票的 web_url（不自己拼链接），同一张票只查一次", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify({ iid: 7, state: "opened", updated_at: "u", web_url: "https://gitlab.example.com/acme/shop/-/issues/7" }),
      JSON.stringify({ iid: 8, state: "opened", updated_at: "u", web_url: "https://gitlab.example.com/acme/shop/-/issues/8" }),
    );
    expect(forge.issueUrl!("7")).toBe("https://gitlab.example.com/acme/shop/-/issues/7");
    expect(forge.issueUrl!("7")).toBe("https://gitlab.example.com/acme/shop/-/issues/7");
    expect(forge.issueUrl!("8")).toBe("https://gitlab.example.com/acme/shop/-/issues/8");
    expect(calls).toEqual([
      ["api", "projects/:id/issues/7"],
      ["api", "projects/:id/issues/8"],
    ]);
  });

  it("issueUrl 查不到时返回 undefined 不抛错，失败也缓存、不再重试；没有 web_url 同样 undefined", () => {
    let calls = 0;
    const forge = gitlabForge(() => {
      calls += 1;
      throw new Error("error connecting to gitlab.example.com");
    });
    expect(forge.issueUrl!("7")).toBeUndefined();
    expect(forge.issueUrl!("7")).toBeUndefined();
    expect(calls).toBe(1);
    const { forge: noUrl } = fakeGlab(JSON.stringify({ iid: 8, state: "opened", updated_at: "u" }));
    expect(noUrl.issueUrl!("8")).toBeUndefined();
  });

  it("issueComments 读 notes 并去掉 system note，作者一律 bot: false", () => {
    const { forge, calls } = fakeGlab(
      [
        JSON.stringify({ body: "普通评论", system: false, author: { username: "alice" } }),
        JSON.stringify({ body: "changed the description", system: true, author: { username: "alice" } }),
        JSON.stringify({ body: null, system: false, author: null }),
      ].join("\n"),
    );
    expect(forge.issueComments("4")).toEqual([
      { body: "普通评论", author: { login: "alice", bot: false } },
      { body: "", author: { login: "ghost", bot: false } },
    ]);
    expect(calls).toEqual([["api", "projects/:id/issues/4/notes?sort=asc&per_page=100", "--paginate", "--output", "ndjson"]]);
  });

  it("issue 的增改与标签：createIssue 返回 iid、标签增删和改正文走 PUT、closeIssue 先评论再关", () => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 88 }), "", "", "", "", "", "");
    expect(forge.createIssue({ title: "T", body: "B", labels: ["flaky", "Sandcastle"] })).toBe("88");
    forge.editIssueBody("1", "B2");
    forge.commentIssue("1", "C");
    forge.closeIssue("1", "done");
    forge.addLabel("1", "sandcastle:stuck");
    forge.removeLabel("1", "sandcastle:prepped");
    expect(calls).toEqual([
      ["api", "--method", "POST", "projects/:id/issues", "-f", "title=T", "-f", "description=B", "-f", "labels=flaky,Sandcastle"],
      ["api", "--method", "PUT", "projects/:id/issues/1", "-f", "description=B2"],
      ["api", "--method", "POST", "projects/:id/issues/1/notes", "-f", "body=C"],
      ["api", "--method", "POST", "projects/:id/issues/1/notes", "-f", "body=done"],
      ["api", "--method", "PUT", "projects/:id/issues/1", "-f", "state_event=close"],
      ["api", "--method", "PUT", "projects/:id/issues/1", "-f", "add_labels=sandcastle:stuck"],
      ["api", "--method", "PUT", "projects/:id/issues/1", "-f", "remove_labels=sandcastle:prepped"],
    ]);
    expect(forge.closingRef("12")).toBe("Closes #12");
  });

  it("createIssue 没有标签时省掉 labels 字段；ensureLabel 的颜色补 #，已存在（409）原样抛错", () => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 89 }), "{}");
    expect(forge.createIssue({ title: "T", body: "B", labels: [] })).toBe("89");
    forge.ensureLabel("flaky", "fbca04", "D");
    expect(calls).toEqual([
      ["api", "--method", "POST", "projects/:id/issues", "-f", "title=T", "-f", "description=B"],
      ["api", "--method", "POST", "projects/:id/labels", "-f", "name=flaky", "-f", "color=#fbca04", "-f", "description=D"],
    ]);
    // 已存在的 409 原样抛出（stderr 里带 409，由调用方忽略），不换成别的错误
    let caught: unknown;
    try {
      failingGlab('HTTP 409 Conflict: {"message":"Label already exists"}').ensureLabel("flaky", "fbca04", "D");
    } catch (e) {
      caught = e;
    }
    expect(String((caught as { stderr?: unknown }).stderr)).toMatch(/409/);
  });

  it.each([
    [50, "admin"],
    [40, "write"],
    [30, "write"],
    [20, "read"],
    [10, "read"],
    [5, "read"],
  ])("repoPermission：access level %i → %s（先按用户名拿 id，再查 members/all）", (level, expected) => {
    const { forge, calls } = fakeGlab(JSON.stringify([{ id: 42 }]), JSON.stringify({ access_level: level }));
    expect(forge.repoPermission("alice")).toBe(expected);
    expect(calls).toEqual([
      ["api", "users?username=alice"],
      ["api", "projects/:id/members/all/42"],
    ]);
  });

  it("repoPermission：用户不存在时抛带 HTTP 404 的错（createTrust 认成 none），不是成员（members 404）原样抛出", () => {
    const { forge } = fakeGlab("[]", "[]");
    expect(() => forge.repoPermission("nobody")).toThrow(/HTTP 404/);
    expect(createTrust({ permission: forge.repoPermission, trustedAuthors: [] })({ login: "nobody", bot: false })).toBe(false);

    const notMember = gitlabForge((args) => {
      if (args.includes("users?username=alice")) return JSON.stringify([{ id: 42 }]);
      throw Object.assign(new Error("glab"), { stderr: 'HTTP 404: {"message":"404 Not found"}' });
    });
    let member404: unknown;
    try {
      notMember.repoPermission("alice");
    } catch (e) {
      member404 = e;
    }
    expect(String((member404 as { stderr?: unknown }).stderr)).toMatch(/404/);
    expect(createTrust({ permission: notMember.repoPermission, trustedAuthors: [] })({ login: "alice", bot: false })).toBe(false);
  });

  it("doctor 用的 checkAccess / listLabels：成功文案带仓库和 access level", () => {
    const { forge, calls } = fakeGlab(
      "",
      JSON.stringify({ path_with_namespace: "acme/shop", permissions: { project_access: { access_level: 40 }, group_access: null } }),
      [JSON.stringify({ name: "a" }), JSON.stringify({ name: "b" })].join("\n"),
    );
    expect(forge.checkAccess()).toBe("glab 已登录，仓库 acme/shop（access level 40）");
    expect(forge.listLabels()).toEqual(["a", "b"]);
    expect(calls).toEqual([
      ["auth", "status"],
      ["api", "projects/:id"],
      ["api", "projects/:id/labels?per_page=100", "--paginate", "--output", "ndjson"],
    ]);
    expect(forge.name).toBe("gitlab");
    expect(forge.tokenEnv).toBe("GITLAB_TOKEN");
  });

  it("checkAccess：没登录时抛错并说明", () => {
    const forge = gitlabForge(() => {
      throw new Error("not logged into any host");
    });
    expect(() => forge.checkAccess()).toThrow(/glab 没登录.*glab auth login/);
  });

  it("checkAccess：project 与 group 权限取大的，不到 Developer（30）抛错并说明", () => {
    const groupLifts = fakeGlab("", JSON.stringify({ path_with_namespace: "acme/shop", permissions: { project_access: { access_level: 20 }, group_access: { access_level: 30 } } }));
    expect(groupLifts.forge.checkAccess()).toBe("glab 已登录，仓库 acme/shop（access level 30）");
    const tooLow = fakeGlab("", JSON.stringify({ path_with_namespace: "acme/shop", permissions: { project_access: { access_level: 20 }, group_access: null } }));
    expect(() => tooLow.forge.checkAccess()).toThrow(/至少要 Developer/);
  });

  it("checkAccess：GITLAB_TOKEN 环境变量存在时报错里写明它会盖过钥匙串里的凭据", () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-wrong");
    const loggedOut = gitlabForge(() => {
      throw new Error("not logged into any host");
    });
    expect(() => loggedOut.checkAccess()).toThrow(/GITLAB_TOKEN 环境变量会盖过.*unset/);
    const tooLow = fakeGlab("", JSON.stringify({ path_with_namespace: "acme/shop", permissions: { project_access: { access_level: 10 } } }));
    expect(() => tooLow.forge.checkAccess()).toThrow(/GITLAB_TOKEN/);
  });

  it("checkAgentToken：用给的 token 覆盖宿主机的 GITLAB_TOKEN，只读探 issue 和 MR", () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-host");
    const { forge, calls, envs } = fakeGlab(
      JSON.stringify({ path_with_namespace: "acme/shop" }),
      "",
      "",
    );
    expect(forge.checkAgentToken("glpat-agent")).toBe("GITLAB_TOKEN 能读 acme/shop 的 issue 和 MR（写权限要等实际改标签时才知道）");
    expect(calls).toEqual([
      ["api", "projects/:id"],
      ["api", "projects/:id/issues?per_page=1"],
      ["api", "projects/:id/merge_requests?per_page=1"],
    ]);
    expect(envs[0]).toBeUndefined();
    expect(envs[1]).toMatchObject({ GITLAB_TOKEN: "glpat-agent" });
    expect(envs[2]).toMatchObject({ GITLAB_TOKEN: "glpat-agent" });
  });

  it("checkAgentToken：token 读不了时抛错，说明要 api scope 和 Developer 权限", () => {
    const forge = gitlabForge((args, env) => {
      if (env) throw Object.assign(new Error("glab"), { stderr: "HTTP 401: invalid token" });
      return JSON.stringify({ path_with_namespace: "acme/shop" });
    });
    expect(() => forge.checkAgentToken("bad")).toThrow(/api scope/);
    expect(() => forge.checkAgentToken("bad")).toThrow(/Developer/);
  });

  it("英文文案：checkAccess 的成功与失败说明、checkAgentToken 的失败说明", () => {
    setTermLanguage("en", {});
    const { forge } = fakeGlab("", JSON.stringify({ path_with_namespace: "acme/shop", permissions: { project_access: { access_level: 30 } } }));
    expect(forge.checkAccess()).toMatch(/glab logged in, repository acme\/shop/);
    const loggedOut = gitlabForge(() => {
      throw new Error("not logged into any host");
    });
    expect(() => loggedOut.checkAccess()).toThrow(/glab isn't logged in.*glab auth login/);
    const badToken = gitlabForge((args, env) => {
      if (env) throw Object.assign(new Error("glab"), { stderr: "HTTP 401" });
      return JSON.stringify({ path_with_namespace: "acme/shop" });
    });
    expect(() => badToken.checkAgentToken("bad")).toThrow(/api scope/);
  });

  it("linkedPrIds 走 issue 的 closed_by，关联的 MR 编号取 iid", () => {
    const { forge, calls } = fakeGlab([JSON.stringify({ iid: 31 }), JSON.stringify({ iid: 32 })].join("\n"));
    expect(forge.linkedPrIds("17")).toEqual(["31", "32"]);
    expect(calls).toEqual([["api", "projects/:id/issues/17/closed_by", "--paginate", "--output", "ndjson"]]);
  });

  it("MR 的增改：createPr 返回 iid、正文读写、评论、合并（squash 开、merge / rebase 关，具体方式由项目设置决定）", () => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 33 }), JSON.stringify({ iid: 33, description: "PR 正文" }), "", "", "", "", "");
    expect(forge.createPr({ base: "main", head: "sandcastle/issue-17", title: "T (#17)", body: "B", attachments: [] })).toBe("33");
    expect(forge.prBody("33")).toBe("PR 正文");
    forge.editPrBody("33", "B2");
    forge.commentPr("33", "C");
    forge.mergePr("33", "rebase");
    forge.mergePr("33", "squash");
    forge.mergePr("33", "merge");
    expect(calls).toEqual([
      ["api", "--method", "POST", "projects/:id/merge_requests", "-f", "source_branch=sandcastle/issue-17", "-f", "target_branch=main", "-f", "title=T (#17)", "-f", "description=B"],
      ["api", "projects/:id/merge_requests/33"],
      ["api", "--method", "PUT", "projects/:id/merge_requests/33", "-f", "description=B2"],
      ["api", "--method", "POST", "projects/:id/merge_requests/33/notes", "-f", "body=C"],
      ["api", "--method", "PUT", "projects/:id/merge_requests/33/merge", "-f", "squash=false"],
      ["api", "--method", "PUT", "projects/:id/merge_requests/33/merge", "-f", "squash=true"],
      ["api", "--method", "PUT", "projects/:id/merge_requests/33/merge", "-f", "squash=false"],
    ]);
  });

  it("prBody 读到 null 的 description 当空串", () => {
    const { forge } = fakeGlab(JSON.stringify({ iid: 9, description: null }));
    expect(forge.prBody("9")).toBe("");
  });

  it("带附件的 createPr / editPrBody / commentPr 抛 not implemented（附件是下一张子票），空附件照常走", () => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 9 }), "", "");
    forge.createPr({ base: "main", head: "b", title: "t", body: "b", attachments: [] });
    forge.editPrBody("9", "x");
    forge.commentPr("9", "x");
    expect(() => forge.createPr({ base: "main", head: "b", title: "t", body: "b", attachments: ["/tmp/a.png"] })).toThrow(
      "gitlabForge: attachments not implemented",
    );
    expect(() => forge.editPrBody("9", "x", ["/tmp/a.png"])).toThrow("gitlabForge: attachments not implemented");
    expect(() => forge.commentPr("9", "x", ["/tmp/a.png"])).toThrow("gitlabForge: attachments not implemented");
    expect(calls).toEqual([
      ["api", "--method", "POST", "projects/:id/merge_requests", "-f", "source_branch=b", "-f", "target_branch=main", "-f", "title=t", "-f", "description=b"],
      ["api", "--method", "PUT", "projects/:id/merge_requests/9", "-f", "description=x"],
      ["api", "--method", "POST", "projects/:id/merge_requests/9/notes", "-f", "body=x"],
    ]);
  });

  it("findPr 按分支和状态查 MR 编号（分支名编码、open→opened），没有时 undefined", () => {
    const { forge, calls } = fakeGlab(JSON.stringify([{ iid: 21 }]), "[]");
    expect(forge.findPr("sandcastle/issue-1", "open")).toBe("21");
    expect(forge.findPr("sandcastle/issue-1", "merged")).toBeUndefined();
    expect(calls).toEqual([
      ["api", "projects/:id/merge_requests?source_branch=sandcastle%2Fissue-1&state=opened&per_page=1"],
      ["api", "projects/:id/merge_requests?source_branch=sandcastle%2Fissue-1&state=merged&per_page=1"],
    ]);
  });

  it("viewPr 按编号读 MR 并归一化：reviews 恒空（GitLab 没有 Request changes）、comments 去掉 system note、lastCommitAt 取最大的 committed_date", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify({
        iid: 5, state: "opened", source_branch: "sandcastle/issue-5", source_project_id: 3, target_project_id: 3,
        description: "d", created_at: "2026-11-01T00:00:00Z",
      }),
      [
        JSON.stringify({ body: "普通评论", system: false, created_at: "2026-11-02T00:00:00Z", author: { username: "alice" } }),
        JSON.stringify({ body: "approved this merge request", system: true, created_at: "2026-11-02T00:01:00Z", author: { username: "alice" } }),
        JSON.stringify({ body: null, system: false, created_at: "2026-11-02T00:02:00Z", author: null }),
      ].join("\n"),
      [JSON.stringify({ committed_date: "2026-11-01T10:00:00Z" }), JSON.stringify({ committed_date: "2026-11-03T10:00:00+08:00" })].join("\n"),
    );
    expect(forge.viewPr("5")).toEqual({
      id: "5", open: true, branch: "sandcastle/issue-5", fromFork: false,
      reviews: [],
      comments: [
        { body: "普通评论", at: "2026-11-02T00:00:00.000Z", author: { login: "alice", bot: false } },
        { body: "", at: "2026-11-02T00:02:00.000Z", author: { login: "ghost", bot: false } },
      ],
      lastCommitAt: "2026-11-03T02:00:00.000Z",
    });
    expect(calls).toEqual([
      ["api", "projects/:id/merge_requests/5"],
      ["api", "projects/:id/merge_requests/5/notes?sort=asc&per_page=100", "--paginate", "--output", "ndjson"],
      ["api", "projects/:id/merge_requests/5/commits", "--paginate", "--output", "ndjson"],
    ]);
  });

  it("viewPr 按分支名查（分支名带斜杠要编码，state=all 里挑最新的），跨项目的 MR 算 fromFork；查不到或出错返回 null", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify([{ iid: 7, state: "merged", source_branch: "sandcastle/issue-7", source_project_id: 11, target_project_id: 3, created_at: "u" }]),
      "",
      "",
    );
    const pr = forge.viewPr("sandcastle/issue-7")!;
    expect(pr.id).toBe("7");
    expect(pr.open).toBe(false);
    expect(pr.fromFork).toBe(true);
    expect(pr.lastCommitAt).toBe("");
    expect(calls[0]).toEqual(["api", "projects/:id/merge_requests?source_branch=sandcastle%2Fissue-7&state=all&order_by=created_at&sort=desc&per_page=1"]);
    expect(fakeGlab("[]", "", "").forge.viewPr("sandcastle/issue-8")).toBeNull();
    expect(failingGlab("HTTP 404").viewPr("sandcastle/issue-9")).toBeNull();
  });

  it("prChecks 取 MR 头提交 pipeline（head_pipeline）的 job 并归一状态：success / skipped→pass，failed / canceled→fail，manual 看 allow_failure，其余 pending；requiredOnly 去掉 allow_failure 的", () => {
    const jobs = [
      { name: "build", status: "success", web_url: "https://x/build", allow_failure: false },
      { name: "lint", status: "skipped", allow_failure: false },
      { name: "test", status: "failed", web_url: "https://x/test", allow_failure: false },
      { name: "audit", status: "canceled", allow_failure: true },
      { name: "deploy", status: "manual", allow_failure: true },
      { name: "gate", status: "manual", allow_failure: false },
      { name: "wait", status: "waiting_for_resource", allow_failure: false },
      { name: "run", status: "running", allow_failure: false },
    ];
    const mr = JSON.stringify({ iid: 12, state: "opened", source_branch: "b", sha: "abc", head_pipeline: { id: 77, sha: "abc" } });
    const { forge, calls } = fakeGlab(
      mr,
      jobs.map((j) => JSON.stringify(j)).join("\n"),
      mr,
      [JSON.stringify(jobs[0]), JSON.stringify(jobs[4])].join("\n"),
    );
    expect(forge.prChecks!("12", false)).toEqual([
      { name: "build", state: "pass", link: "https://x/build" },
      { name: "lint", state: "pass" },
      { name: "test", state: "fail", link: "https://x/test" },
      { name: "audit", state: "fail" },
      { name: "deploy", state: "pass" },
      { name: "gate", state: "pending" },
      { name: "wait", state: "pending" },
      { name: "run", state: "pending" },
    ]);
    expect(forge.prChecks!("12", true)).toEqual([{ name: "build", state: "pass", link: "https://x/build" }]);
    expect(calls).toEqual([
      ["api", "projects/:id/merge_requests/12"],
      ["api", "projects/:id/pipelines/77/jobs", "--paginate", "--output", "ndjson"],
      ["api", "projects/:id/merge_requests/12"],
      ["api", "projects/:id/pipelines/77/jobs", "--paginate", "--output", "ndjson"],
    ]);
  });

  it("prChecks：MR 还没有 pipeline 时返回空数组（没有检查），不用再查 job", () => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 12, state: "opened", source_branch: "b", sha: "abc", head_pipeline: null }));
    expect(forge.prChecks!("12", false)).toEqual([]);
    expect(calls).toEqual([["api", "projects/:id/merge_requests/12"]]);
  });

  it("prChecks：MR 头提交（新 push）的 pipeline 还没建出来、head_pipeline 还是旧提交的时返回一个 pending 占位检查（项目有 CI、只是还没跑完，fail-closed），不去查旧 pipeline 的 job", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify({ iid: 12, state: "opened", source_branch: "b", sha: "new", head_pipeline: { id: 77, sha: "old" } }),
      JSON.stringify({ name: "build", status: "success", allow_failure: false }),
    );
    expect(forge.prChecks!("12", false)).toEqual([{ name: "pipeline", state: "pending" }]);
    expect(calls).toEqual([["api", "projects/:id/merge_requests/12"]]);
  });

  it("prChecks：MR 缺 sha 但有 head_pipeline 时也返回 pending 占位检查", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify({ iid: 12, state: "opened", source_branch: "b", head_pipeline: { id: 77, sha: "old" } }),
    );
    expect(forge.prChecks!("12", false)).toEqual([{ name: "pipeline", state: "pending" }]);
    expect(calls).toEqual([["api", "projects/:id/merge_requests/12"]]);
  });

  it.each([
    ["conflicting", { has_conflicts: true, detailed_merge_status: "ci_still_running" }],
    ["conflicting", { has_conflicts: false, detailed_merge_status: "conflict" }],
    ["unknown", { has_conflicts: false, detailed_merge_status: "unchecked" }],
    ["unknown", { has_conflicts: false, detailed_merge_status: "checking" }],
    ["unknown", { has_conflicts: false, detailed_merge_status: "preparing" }],
    ["unknown", { has_conflicts: false, detailed_merge_status: "approvals_syncing" }],
    ["clean", { has_conflicts: false, detailed_merge_status: "mergeable" }],
    ["clean", { has_conflicts: false, detailed_merge_status: undefined }],
  ])("prMergeable 按 has_conflicts / detailed_merge_status 归一：%s", (expected, fields) => {
    const { forge, calls } = fakeGlab(JSON.stringify({ iid: 9, state: "opened", ...fields }));
    expect(forge.prMergeable!("9")).toBe(expected);
    expect(calls).toEqual([["api", "projects/:id/merge_requests/9"]]);
  });

  it("prMergeable 查询出错照旧抛出（调用方按不冲突处理）", () => {
    let caught: unknown;
    try {
      failingGlab("HTTP 500: boom").prMergeable!("9");
    } catch (e) {
      caught = e;
    }
    expect(String((caught as { stderr?: unknown }).stderr)).toMatch(/HTTP 500/);
  });

  it("打回的时间比较：committed_date 带 +08:00 偏移也归一成 UTC ISO，晚于最新提交的 /sandcastle 评论仍满足 at > lastCommitAt（按字符串比较，#1 原验收第 2 条）", () => {
    const mr = { iid: 5, state: "opened", source_branch: "sandcastle/issue-5", source_project_id: 3, target_project_id: 3, created_at: "u" };
    const { forge } = fakeGlab(
      JSON.stringify(mr),
      // 提交是 2026-11-27T10:00:00+08:00 = 02:00Z；两条 /sandcastle 评论分别在 01:00Z（早于提交）和 03:00Z（晚于提交）
      [
        JSON.stringify({ body: "/sandcastle 旧的打回", system: false, created_at: "2026-11-27T01:00:00Z", author: { username: "alice" } }),
        JSON.stringify({ body: "/sandcastle 新的打回", system: false, created_at: "2026-11-27T03:00:00Z", author: { username: "alice" } }),
      ].join("\n"),
      JSON.stringify({ committed_date: "2026-11-27T10:00:00+08:00" }),
    );
    const pr = forge.viewPr("5")!;
    expect(pr.lastCommitAt).toBe("2026-11-27T02:00:00.000Z");
    // reopenRequestedRevisions（main.ts）的筛法：/sandcastle 开头且 at > lastCommitAt，按字符串比较
    // The reopenRequestedRevisions (main.ts) filter: starts with /sandcastle and at > lastCommitAt, compared as strings
    const fresh = pr.comments.filter((c) => c.body.trim().startsWith("/sandcastle")).filter((c) => c.at > pr.lastCommitAt);
    expect(fresh.map((c) => c.body)).toEqual(["/sandcastle 新的打回"]);
  });

  it("拆票链路（closeFinishedParents 用的顺序）：listSplitParents → createIssue → editIssueBody 一串调用走通", () => {
    const { forge, calls } = fakeGlab(
      [JSON.stringify({ iid: 100, description: "父票\n\n## Split into\n\n- #2" })].join("\n"),
      JSON.stringify({ iid: 201 }),
      "",
    );
    const parents = forge.listSplitParents("Sandcastle");
    expect(parents).toEqual([{ number: 100, body: "父票\n\n## Split into\n\n- #2" }]);
    const created = forge.createIssue({ title: "子票", body: "B", labels: ["Sandcastle", "ready-for-agent"] });
    expect(created).toBe("201");
    forge.editIssueBody(String(parents[0].number), `${parents[0].body}\n- #${created}`);
    expect(calls).toEqual([
      ["api", "projects/:id/issues?state=opened&search=Split%20into&in=description&not[labels]=Sandcastle&per_page=100", "--paginate", "--output", "ndjson"],
      ["api", "--method", "POST", "projects/:id/issues", "-f", "title=子票", "-f", "description=B", "-f", "labels=Sandcastle,ready-for-agent"],
      ["api", "--method", "PUT", "projects/:id/issues/100", "-f", "description=父票\n\n## Split into\n\n- #2\n- #201"],
    ]);
  });

  it("提示词相关的方法还没实现：抛 not implemented", () => {
    const { forge } = fakeGlab();
    expect(() => forge.viewIssueCommand("1")).toThrow("gitlabForge.viewIssueCommand: not implemented");
    expect(() => forge.agentGuide()).toThrow("gitlabForge.agentGuide: not implemented");
  });
});
