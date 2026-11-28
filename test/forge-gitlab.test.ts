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
      JSON.stringify([
        { iid: 7, title: "t", description: "b", labels: ["Sandcastle", "sandcastle:stuck"], updated_at: "2026-11-27T10:00:00+08:00", author: { username: "alice" } },
        { iid: 8, title: "t", description: null, labels: [], updated_at: "2026-11-28T00:00:00Z", author: null },
      ]),
    );
    expect(forge.listOpenIssues(["Sandcastle", "sandcastle:prepped"])).toEqual([
      { number: 7, title: "t", body: "b", labels: ["Sandcastle", "sandcastle:stuck"], updatedAt: "2026-11-27T02:00:00.000Z", author: { login: "alice", bot: false } },
      { number: 8, title: "t", body: "", labels: [], updatedAt: "2026-11-28T00:00:00.000Z", author: { login: "ghost", bot: false } },
    ]);
    // 逗号分隔符原样保留（编码了服务器就当成一个标签名）；标签名里的 : 编码成 %3A，服务器解码回来
    expect(calls).toEqual([["api", "projects/:id/issues?state=opened&labels=Sandcastle,sandcastle%3Aprepped&per_page=100", "--paginate"]]);
  });

  it("listOpenIssues 没有标签时整段省掉 labels（GitLab 的空 labels= 是「无标签的票」）", () => {
    const { forge, calls } = fakeGlab("[]");
    expect(forge.listOpenIssues([])).toEqual([]);
    expect(calls).toEqual([["api", "projects/:id/issues?state=opened&per_page=100", "--paginate"]]);
  });

  it("listClosedIssueNumbers / listSplitParents（搜索是模糊的，回来本地确认正文含 ## Split into）", () => {
    const { forge, calls } = fakeGlab(
      JSON.stringify([{ iid: 3 }, { iid: 5 }]),
      JSON.stringify([
        { iid: 1, description: "x\n\n## Split into\n\n- #2" },
        { iid: 2, description: "只有 Split into 字样、不是那个小节" },
      ]),
    );
    expect(forge.listClosedIssueNumbers("sandcastle:stuck")).toEqual([3, 5]);
    expect(forge.listSplitParents("Sandcastle")).toEqual([{ number: 1, body: "x\n\n## Split into\n\n- #2" }]);
    expect(calls).toEqual([
      ["api", "projects/:id/issues?state=closed&labels=sandcastle%3Astuck&per_page=100", "--paginate"],
      ["api", "projects/:id/issues?state=opened&search=Split%20into&in=description&not[labels]=Sandcastle&per_page=100", "--paginate"],
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
      JSON.stringify([
        { body: "普通评论", system: false, author: { username: "alice" } },
        { body: "changed the description", system: true, author: { username: "alice" } },
        { body: null, system: false, author: null },
      ]),
    );
    expect(forge.issueComments("4")).toEqual([
      { body: "普通评论", author: { login: "alice", bot: false } },
      { body: "", author: { login: "ghost", bot: false } },
    ]);
    expect(calls).toEqual([["api", "projects/:id/issues/4/notes?sort=asc&per_page=100", "--paginate"]]);
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
      JSON.stringify([{ name: "a" }, { name: "b" }]),
    );
    expect(forge.checkAccess()).toBe("glab 已登录，仓库 acme/shop（access level 40）");
    expect(forge.listLabels()).toEqual(["a", "b"]);
    expect(calls).toEqual([
      ["auth", "status"],
      ["api", "projects/:id"],
      ["api", "projects/:id/labels?per_page=100", "--paginate"],
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

  it("MR / 提示词相关的方法还没实现：抛 not implemented，可选的 prChecks / prMergeable 不存在", () => {
    const { forge } = fakeGlab();
    const calls: [string, () => unknown][] = [
      ["linkedPrIds", () => forge.linkedPrIds("3")],
      ["viewPr", () => forge.viewPr("5")],
      ["findPr", () => forge.findPr("sandcastle/issue-1", "open")],
      ["createPr", () => forge.createPr({ base: "main", head: "b", title: "t", body: "b", attachments: [] })],
      ["prBody", () => forge.prBody("1")],
      ["editPrBody", () => forge.editPrBody("1", "b")],
      ["commentPr", () => forge.commentPr("1", "b")],
      ["mergePr", () => forge.mergePr("1", "rebase")],
      ["viewIssueCommand", () => forge.viewIssueCommand("1")],
      ["agentGuide", () => forge.agentGuide()],
    ];
    for (const [name, fn] of calls) expect(fn).toThrow(`gitlabForge.${name}: not implemented`);
    expect(forge.prChecks).toBeUndefined();
    expect(forge.prMergeable).toBeUndefined();
  });
});
