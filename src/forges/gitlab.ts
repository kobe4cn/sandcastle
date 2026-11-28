// GitLab：用宿主机上已登录的 glab CLI；REST 调用一律走 `glab api`，路径里的 `:id` 是 glab 的项目占位符
// （按当前目录的 remote 解析项目，自建实例的 host 也由 remote 推出）。这一张（#171）只实现登录检查、
// 标签、issue 与评论、repoPermission、closingRef；MR / 审查 / 附件 / agentGuide 留给后面的子票，先抛 not implemented。
// test/forge-gitlab.test.ts 锁住了每个方法的 argv。
// GitLab: uses the glab CLI logged in on the host; every REST call goes through `glab api`, where `:id` in the path is glab's
// project placeholder (resolved from the current directory's remote, which also gives the self-hosted host). This ticket (#171)
// covers only the login check, labels, issues with comments, repoPermission and closingRef; MRs / reviews / attachments /
// agentGuide are left to later sub-tickets and throw not implemented for now.
// test/forge-gitlab.test.ts pins every method's argv.

import type { Forge, ForgeIssue } from "../forge.ts";
import { sh } from "../shell.ts";
import { t } from "../term.ts";
import type { Author } from "../trust.ts";

/**
 * 跑一次 glab，返回 trim 过的 stdout；失败抛错。env 给了就整个替换环境变量。测试里换成记录 argv 的假实现。
 * Run glab once and return trimmed stdout; throws on failure. A given env replaces the environment entirely. Tests swap in a fake that records argv.
 */
export type GlabRunner = (args: string[], env?: NodeJS.ProcessEnv) => string;

/** GitLab issue 在 REST 里的形状，只取用到的字段（正文字段叫 description，编号叫 iid）。 / A GitLab issue as REST returns it, only the fields used (the body is description, the number is iid). */
type GlabIssue = {
  iid: number;
  title: string;
  description: string | null;
  labels?: string[];
  updated_at: string;
  state: string;
  web_url?: string;
  author?: { username?: string } | null;
};

/**
 * 作者恒为 bot: false：#1 决定 3A——bot 用户按 access level 照常判断，而 createTrust 对 bot 直接放行，
 * 标了 bot 反而绕过权限检查。删号留下的空用户名按 ghost 处理（查权限 404 → 不可信）。
 * Authors are always bot: false: per #1 decision 3A, bots are judged by access level like anyone else, and createTrust
 * trusts bots outright — flagging them would skip the permission check. An empty username from a deleted account maps to ghost (permission lookup 404s → untrusted).
 */
const toAuthor = (username: string | null | undefined): Author => ({ login: username || "ghost", bot: false });

const toIssue = (i: GlabIssue): ForgeIssue => ({
  number: i.iid,
  title: i.title,
  body: i.description ?? "",
  labels: i.labels ?? [],
  updatedAt: new Date(i.updated_at).toISOString(),
  author: toAuthor(i.author?.username),
});

/**
 * access level → 权限：50 Owner→admin，40 Maintainer / 30 Developer→write（#1 决定 3A：项目成员 ≥30 算可信作者），
 * 20 / 10 / 5 →read。Maintainer 归 write 而不是 maintain：trust.ts 的 TRUSTED_PERMISSIONS 只认 admin / write。
 * access level → permission: 50 Owner→admin, 40 Maintainer / 30 Developer→write (#1 decision 3A: project members ≥30 count
 * as trusted authors), 20 / 10 / 5 →read. Maintainer maps to write, not maintain: trust.ts's TRUSTED_PERMISSIONS only knows admin / write.
 */
const permissionOf = (level: number): string => {
  if (level >= 50) return "admin";
  if (level >= 30) return "write";
  return "read";
};

/** 错误的第一行非空文本（stderr 优先），拼进给用户看的说明。 / The error's first non-empty line (stderr first), folded into user-facing messages. */
const errorLine = (e: unknown) => String((e as { stderr?: unknown }).stderr || (e as Error).message).split("\n").find(Boolean) ?? "";

/** 本票没做的 MR / 提示词方法，留给后面的子票。 / MR / prompt methods not in this ticket; left to later sub-tickets. */
const todo = (name: string): never => {
  throw new Error(`gitlabForge.${name}: not implemented`);
};

export function gitlabForge(glab: GlabRunner = (args, env) => sh("glab", args, undefined, env)): Forge {
  // issueUrl 用每张票自己的 web_url，按票缓存（Map 区分「没探过」和「探过、结果是 undefined」）；失败也缓存、
  // 不重试、不抛错——发通知是顺带的事，issueUrl 绝不能抛错打断调用它的编排流程（#135）。
  // issueUrl uses each ticket's own web_url, cached per issue (the Map tells "not probed" from "probed, undefined"); failures
  // cache too, with no retry and no throw — notifying is incidental, and issueUrl must never throw into the pipeline (#135).
  const urls = new Map<string, string | undefined>();
  const getIssue = (id: string): GlabIssue => JSON.parse(glab(["api", `projects/:id/issues/${id}`])) as GlabIssue;
  return {
    name: "gitlab",
    tokenEnv: "GITLAB_TOKEN",

    checkAccess() {
      // GITLAB_TOKEN 环境变量优先于钥匙串里的凭据：值不对时 auth status 看着是登录的、api 调用却全挂，报错里点明它。
      // The GITLAB_TOKEN environment variable beats the keychain credentials: when it's wrong, auth status looks fine while every api call fails, so errors spell it out.
      const tokenHint = process.env.GITLAB_TOKEN
        ? t(
            "；GITLAB_TOKEN 环境变量会盖过钥匙串里的 glab 凭据，先确认它是对的或 unset",
            "; the GITLAB_TOKEN environment variable overrides glab's keychain credentials: make sure it is correct or unset it",
          )
        : "";
      const fail = (zh: string, en: string): never => {
        throw new Error(t(zh, en) + tokenHint);
      };
      try {
        glab(["auth", "status"]);
      } catch (e) {
        const line = errorLine(e);
        fail(
          `glab 没登录（先 glab auth login）：${line}`,
          `glab isn't logged in (run glab auth login first): ${line}`,
        );
      }
      let project: {
        path_with_namespace?: string;
        permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
      };
      try {
        project = JSON.parse(glab(["api", "projects/:id"]));
      } catch (e) {
        throw new Error(t(`读不了当前项目（${errorLine(e)}）`, `can't read the current project (${errorLine(e)})`) + tokenHint);
      }
      const path = project.path_with_namespace ?? "";
      // 项目成员和所属 group 的成员取大的：group 里给的 Reporter / Developer 也算数 / Project and group membership
      // count at the higher level: Reporter / Developer granted through the group counts too
      const level = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0);
      if (level < 30) {
        fail(
          `对 ${path} 只有 access level ${level}：流水线要推分支、改标签、合并 MR，至少要 Developer（30）`,
          `Only access level ${level} on ${path}: the pipeline pushes branches, edits labels and merges MRs, so it needs at least Developer (30)`,
        );
      }
      return t(`glab 已登录，仓库 ${path}（access level ${level}）`, `glab logged in, repository ${path} (access level ${level})`);
    },
    checkAgentToken(token) {
      // 沙箱里的 agent 只用这个 token：读写 issue、读 MR 与评论。只读探一下，不留痕迹。
      // 去掉宿主机的 GITLAB_TOKEN，免得 glab 用了它而不是要验证的这个。
      // The agent in the sandbox uses only this token: read/write issues, read MRs and comments. Probe read-only, leaving no trace.
      // Drop the host's GITLAB_TOKEN so glab doesn't use it instead of the token being checked.
      const { GITLAB_TOKEN: _, ...rest } = process.env;
      const env = { ...rest, GITLAB_TOKEN: token };
      const path = (JSON.parse(glab(["api", "projects/:id"])) as { path_with_namespace?: string }).path_with_namespace ?? "";
      const probe = (what: string, apiPath: string) => {
        try {
          glab(["api", apiPath], env);
        } catch (e) {
          throw new Error(
            t(
              `GITLAB_TOKEN 读不了 ${path} 的 ${what}（${errorLine(e)}）：token 要有 api scope，且对这个项目至少是 Developer（30）`,
              `GITLAB_TOKEN can't read ${path}'s ${what} (${errorLine(e)}): the token needs the api scope and at least Developer (30) access to the project`,
            ),
          );
        }
      };
      probe("issue", "projects/:id/issues?per_page=1");
      probe("MR", "projects/:id/merge_requests?per_page=1");
      return t(
        `GITLAB_TOKEN 能读 ${path} 的 issue 和 MR（写权限要等实际改标签时才知道）`,
        `GITLAB_TOKEN can read ${path}'s issues and MRs (write access is only known when labels are actually edited)`,
      );
    },
    listLabels: () => (JSON.parse(glab(["api", "projects/:id/labels?per_page=100", "--paginate"])) as { name: string }[]).map((l) => l.name),

    listOpenIssues(labels) {
      // 实时列表接口而不是搜索索引：索引有延迟，刚打上的标签要过一阵才查得到（github 版 #393 的教训）。
      // 查询参数里的标签逐个编码后逗号拼接（服务器按逗号拆开再解码）；一个都不带时整段省略——
      // GitLab 的空 `labels=` 是「无标签的票」，不是「全部」。
      // The live list endpoint rather than the search index: the index lags, so a freshly added label takes a while to
      // show up (the lesson of #393 in the GitHub forge). Labels in the query string are each encoded, then joined with
      // commas (the server splits on commas, then decodes); with none, the whole segment is omitted — GitLab's empty
      // `labels=` means "issues without labels", not "all".
      const query = labels.length ? `&labels=${labels.map(encodeURIComponent).join(",")}` : "";
      return (JSON.parse(glab(["api", `projects/:id/issues?state=opened${query}&per_page=100`, "--paginate"])) as GlabIssue[]).map(toIssue);
    },
    repoPermission(login) {
      // 两步：先按用户名在实例上拿 id（users 是实例级接口，不带 :id），再查 members/all——含继承自 group 的成员。
      // 用户不存在时抛带 HTTP 404 的错，trust.ts 的 isNotFound 认得出、按 none 处理；members 的 404（不是成员）
      // 原样抛出，glab 的错误文本里本来就有 404。
      // Two steps: resolve the login to an id on the instance (users is instance-level, no :id), then read members/all —
      // including members inherited from groups. A missing user throws an error carrying HTTP 404, which trust.ts's
      // isNotFound recognizes as none; a members 404 (not a member) is rethrown as-is, since glab's error text already carries the 404.
      const users = JSON.parse(glab(["api", `users?username=${encodeURIComponent(login)}`])) as { id: number }[];
      if (users.length === 0) {
        throw new Error(t(`GitLab 用户 ${login} 不存在：HTTP 404`, `GitLab user ${login} not found: HTTP 404`));
      }
      const member = JSON.parse(glab(["api", `projects/:id/members/all/${users[0].id}`])) as { access_level: number };
      return permissionOf(member.access_level);
    },
    listClosedIssueNumbers(label) {
      return (JSON.parse(glab(["api", `projects/:id/issues?state=closed&labels=${encodeURIComponent(label)}&per_page=100`, "--paginate"])) as GlabIssue[]).map((i) => i.iid);
    },
    listSplitParents(withoutLabel) {
      // 搜索是模糊的：API 只用来收窄（正文提到 Split into、没带这个标签），`## Split into` 这一节回来本地确认。
      // The search is fuzzy: the API only narrows (body mentions Split into, label absent), and the `## Split into` section is confirmed locally.
      const raw = JSON.parse(
        glab([
          "api",
          `projects/:id/issues?state=opened&search=${encodeURIComponent("Split into")}&in=description&not[labels]=${encodeURIComponent(withoutLabel)}&per_page=100`,
          "--paginate",
        ]),
      ) as GlabIssue[];
      return raw
        .filter((i) => (i.description ?? "").includes("## Split into"))
        .map((i) => ({ number: i.iid, body: i.description ?? "" }));
    },
    issueState(id) {
      let state: string;
      try {
        state = getIssue(id).state;
      } catch (e) {
        // 只有 glab 明确报 404 才算 missing；网络、权限等错误照旧抛出 / Only glab's explicit 404 counts as missing; network, permission and other errors still throw
        const msg = String((e as { stderr?: unknown }).stderr || (e as Error).message);
        if (/404|Not Found/i.test(msg)) return "missing";
        throw e;
      }
      return state === "closed" ? "closed" : "open";
    },
    issueUpdatedAt(id) {
      return new Date(getIssue(id).updated_at).toISOString();
    },
    issueUrl(id) {
      if (!urls.has(id)) {
        try {
          urls.set(id, getIssue(id).web_url || undefined);
        } catch {
          urls.set(id, undefined);
        }
      }
      return urls.get(id);
    },
    issueComments(id) {
      // system note（改标题、打标签这些流水账）不是人写的评论，去掉；sort=asc 按创建时间升序。
      // System notes (title edits, label changes) aren't human comments and are dropped; sort=asc is oldest first.
      const notes = JSON.parse(glab(["api", `projects/:id/issues/${id}/notes?sort=asc&per_page=100`, "--paginate"])) as {
        body: string | null;
        system?: boolean;
        author?: { username?: string } | null;
      }[];
      return notes.filter((n) => !n.system).map((n) => ({ body: n.body ?? "", author: toAuthor(n.author?.username) }));
    },
    createIssue({ title, body, labels }) {
      // -f 是表单字段、不进 URL：标签名原样传（查询参数那边的编码不适用于这里），返回 JSON 里的 iid 而不是解析链接。
      // -f is a form field, not part of a URL: label names go in verbatim (the query-string encoding doesn't apply here);
      // the iid comes from the JSON rather than parsing a link.
      const created = JSON.parse(
        glab([
          "api", "--method", "POST", "projects/:id/issues",
          "-f", `title=${title}`, "-f", `description=${body}`,
          ...(labels.length ? ["-f", `labels=${labels.join(",")}`] : []),
        ]),
      ) as { iid: number };
      return String(created.iid);
    },
    editIssueBody(id, body) {
      glab(["api", "--method", "PUT", `projects/:id/issues/${id}`, "-f", `description=${body}`]);
    },
    commentIssue(id, body) {
      glab(["api", "--method", "POST", `projects/:id/issues/${id}/notes`, "-f", `body=${body}`]);
    },
    closeIssue(id, comment) {
      // 先评论再关（同 github 版）：关票的说明不能丢 / Comment first, then close (as the GitHub forge does): the closing note must not be lost
      glab(["api", "--method", "POST", `projects/:id/issues/${id}/notes`, "-f", `body=${comment}`]);
      glab(["api", "--method", "PUT", `projects/:id/issues/${id}`, "-f", "state_event=close"]);
    },
    addLabel(id, label) {
      glab(["api", "--method", "PUT", `projects/:id/issues/${id}`, "-f", `add_labels=${label}`]);
    },
    removeLabel(id, label) {
      glab(["api", "--method", "PUT", `projects/:id/issues/${id}`, "-f", `remove_labels=${label}`]);
    },
    ensureLabel(name, color, description) {
      // 颜色补 #（doctor 的 LABEL_META 存的是不带 # 的十六进制）；已存在时 GitLab 回 409，原样抛错给调用方忽略。
      // The colour gets a leading # (doctor's LABEL_META stores bare hex); GitLab answers 409 when it exists, rethrown for callers to ignore.
      glab(["api", "--method", "POST", "projects/:id/labels", "-f", `name=${name}`, "-f", `color=#${color}`, "-f", `description=${description}`]);
    },

    closingRef: (issueId) => `Closes #${issueId}`,
    linkedPrIds: () => todo("linkedPrIds"),
    viewPr: () => todo("viewPr"),
    findPr: () => todo("findPr"),
    createPr: () => todo("createPr"),
    prBody: () => todo("prBody"),
    editPrBody: () => todo("editPrBody"),
    commentPr: () => todo("commentPr"),
    mergePr: () => todo("mergePr"),
    viewIssueCommand: () => todo("viewIssueCommand"),
    agentGuide: () => todo("agentGuide"),
  };
}
