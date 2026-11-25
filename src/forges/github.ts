// GitHub：用宿主机上已登录的 gh CLI（2.99+，PR 评论的 --attach 要用）。
// 参数与 duckdb_crm 原来 main.ts 里的调用逐字一致；test/forge-github.test.ts 锁住了每个方法的 argv。
// GitHub: uses the gh CLI logged in on the host (2.99+, needed for --attach on PR comments).
// Arguments match the original calls word for word; test/forge-github.test.ts pins every method's argv.

import { basename } from "node:path";
import type { Forge, ForgePr, ForgeIssue, MergeMethod } from "../forge.ts";
import { sh } from "../shell.ts";
import { t } from "../term.ts";

/**
 * 跑一次 gh，返回 trim 过的 stdout；失败抛错。env 给了就整个替换环境变量。测试里换成记录 argv 的假实现。
 * Run gh once and return trimmed stdout; throws on failure. A given env replaces the environment entirely. Tests swap in a fake that records argv.
 */
export type GhRunner = (args: string[], env?: NodeJS.ProcessEnv) => string;

type GhPr = {
  number: number;
  state: string;
  headRefName: string;
  isCrossRepository: boolean;
  reviews: { state: string; body: string; submittedAt: string }[];
  comments: { body: string; createdAt: string }[];
  commits: { committedDate: string }[];
};
const PR_FIELDS = "number,state,headRefName,isCrossRepository,reviews,comments,commits";

const toPr = (pr: GhPr): ForgePr => ({
  id: String(pr.number),
  open: pr.state === "OPEN",
  branch: pr.headRefName,
  fromFork: pr.isCrossRepository,
  reviews: pr.reviews.map((r) => ({ changesRequested: r.state === "CHANGES_REQUESTED", body: r.body, at: r.submittedAt })),
  comments: pr.comments.map((c) => ({ body: c.body, at: c.createdAt })),
  lastCommitAt: pr.commits.map((c) => c.committedDate).sort().at(-1) ?? "",
});

/**
 * 截图附件：gh 2.99+ 的 --attach 上传图片，没在正文里引用的附在末尾
 * Screenshot attachments: gh 2.99+ --attach uploads images; ones not referenced in the body are appended at the end
 */
const attachArgs = (files: string[]) => files.flatMap((file) => ["--attach", `${file}#${basename(file)}`]);

const GITHUB_AGENT_GUIDE = `平台是 GitHub，用已登录的 \`gh\`。issue 和 PR 都用编号（不带 #）；正文里引用别的票写 \`#<n>\`。

- 看票与全部评论：\`gh issue view <n> --comments\`；只看状态：\`gh issue view <n> --json state -q .state\`
- 评论 / 改正文：正文先写进临时文件，\`gh issue comment <n> --body-file <file>\` / \`gh issue edit <n> --body-file <file>\`
- 加 / 去标签：\`gh issue edit <n> --add-label "<label>"\` / \`gh issue edit <n> --remove-label "<label>"\`
- 开新票：\`gh issue create --title "<标题>" --body-file <file> --label "<label>"\`（多个标签写多个 --label），输出的 URL 末尾是编号
- 搜票：\`gh issue list --state open --search "<文本>" --json number,title,body\`；带标签的已关闭票：\`gh issue list --label "<label>" --state closed --search "<文本>"\`
- 分支上的 PR 与评论：\`gh pr view <分支> --comments\`（没有 PR 时报 no pull requests found）
- PR 的行内审查意见：\`gh api "repos/{owner}/{repo}/pulls/$(gh pr view <分支> --json number -q .number)/comments" --jq '.[] | "\\(.path):\\(.line) \\(.body)"'\``;

const lines = (out: string) => out.split("\n").filter(Boolean);

export function githubForge(gh: GhRunner = (args, env) => sh("gh", args, undefined, env)): Forge {
  return {
    name: "github",
    tokenEnv: "GH_TOKEN",

    checkAccess() {
      try {
        gh(["auth", "status", "--active"]);
      } catch (e) {
        throw new Error(t("gh 没登录（先 gh auth login）：", "gh isn't logged in (run gh auth login first): ") + (e as Error).message.split("\n")[0]);
      }
      const repo = gh(["repo", "view", "--json", "nameWithOwner,viewerPermission", "-q", '.nameWithOwner + " " + .viewerPermission']);
      const [name, permission] = repo.split(" ");
      if (!["ADMIN", "MAINTAIN", "WRITE"].includes(permission ?? "")) {
        throw new Error(
          t(
            `对 ${name} 只有 ${permission} 权限：流水线要推分支、改标签、合并 PR，至少要 WRITE`,
            `Only ${permission} permission on ${name}: the pipeline pushes branches, edits labels and merges PRs, so it needs at least WRITE`,
          ),
        );
      }
      return t(`gh 已登录，仓库 ${name}（${permission}）`, `gh logged in, repository ${name} (${permission})`);
    },
    checkAgentToken(token) {
      // 沙箱里的 agent 只用这个 token：读写 issue、读 PR 与评论。只读探一下，不留痕迹。
      // 去掉宿主机的 GITHUB_TOKEN，免得 gh 用了它而不是要验证的这个。
      // The agent in the sandbox uses only this token: read/write issues, read PRs and comments. Probe read-only, leaving no trace.
      // Drop the host's GITHUB_TOKEN so gh doesn't use it instead of the token being checked.
      const { GITHUB_TOKEN: _, ...rest } = process.env;
      const env = { ...rest, GH_TOKEN: token };
      const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
      const probe = (what: string, path: string) => {
        try {
          gh(["api", `repos/${repo}/${path}?per_page=1`, "--silent"], env);
        } catch (e) {
          const msg = String((e as { stderr?: unknown }).stderr || (e as Error).message).split("\n").find(Boolean) ?? "";
          throw new Error(
            t(
              `GH_TOKEN 读不了 ${repo} 的 ${what}（${msg.trim()}）：fine-grained token 要给这个仓库 Issues 读写、Pull requests 只读`,
              `GH_TOKEN can't read ${repo}'s ${what} (${msg.trim()}): the fine-grained token needs Issues read/write and Pull requests read on this repository`,
            ),
          );
        }
      };
      probe("issue", "issues");
      probe("PR", "pulls");
      return t(`GH_TOKEN 能读 ${repo} 的 issue 和 PR（写权限要等实际改标签时才知道）`, `GH_TOKEN can read ${repo}'s issues and PRs (write access is only known when labels are actually edited)`);
    },
    listLabels: () => lines(gh(["label", "list", "--limit", "1000", "--json", "name", "-q", ".[].name"])),

    listOpenIssues(labels) {
      // 用 `--label`（issues 列表接口，实时）而不是 `--search`（搜索索引）：索引有延迟，刚打上的标签要过一阵
      // 才查得到。2026-11-05 #393 刚打上 prepped，plan 用 --search 没查到，脚本以为没票可做就退出了。
      // Use `--label` (the issues list API, real time) rather than `--search` (the search index): the index lags, so a freshly added label
      // takes a while to show up. On 2026-11-05 #393 had just been labelled prepped, plan's --search missed it, and the script exited thinking there was nothing to do.
      const raw = JSON.parse(
        gh([
          "issue", "list", "--state", "open", "--limit", "200",
          ...labels.flatMap((label) => ["--label", label]), "--json", "number,title,body,labels,updatedAt",
        ]),
      ) as (Omit<ForgeIssue, "labels"> & { labels: { name: string }[] })[];
      return raw.map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));
    },
    listClosedIssueNumbers(label) {
      return lines(gh(["issue", "list", "--state", "closed", "--label", label, "--limit", "100", "--json", "number", "--jq", ".[].number"])).map(Number);
    },
    listSplitParents(withoutLabel) {
      return JSON.parse(
        gh(["issue", "list", "--state", "open", "--limit", "100", "--search", `"Split into" in:body -label:"${withoutLabel}"`, "--json", "number,body"]),
      ) as { number: number; body: string }[];
    },
    issueState(id) {
      return gh(["issue", "view", id, "--json", "state", "--jq", ".state"]) === "CLOSED" ? "closed" : "open";
    },
    issueUpdatedAt(id) {
      return gh(["issue", "view", id, "--json", "updatedAt", "--jq", ".updatedAt"]);
    },
    issueComments(id) {
      return lines(gh(["issue", "view", id, "--json", "comments", "--jq", ".comments[].body | @json"])).map((l) => JSON.parse(l) as string);
    },
    createIssue({ title, body, labels }) {
      const url = gh(["issue", "create", "--title", title, "--body", body, ...labels.flatMap((l) => ["--label", l])]);
      return url.split("/").pop()!;
    },
    editIssueBody(id, body) {
      gh(["issue", "edit", id, "--body", body]);
    },
    commentIssue(id, body) {
      gh(["issue", "comment", id, "--body", body]);
    },
    closeIssue(id, comment) {
      gh(["issue", "close", id, "--comment", comment]);
    },
    addLabel(id, label) {
      gh(["issue", "edit", id, "--add-label", label]);
    },
    removeLabel(id, label) {
      gh(["issue", "edit", id, "--remove-label", label]);
    },
    ensureLabel(name, color, description) {
      gh(["label", "create", name, "--color", color, "--description", description]);
    },

    closingRef: (issueId) => `Closes #${issueId}`,
    linkedPrIds(issueId) {
      return lines(gh(["issue", "view", issueId, "--json", "closedByPullRequestsReferences", "--jq", ".closedByPullRequestsReferences[].number"]));
    },
    viewPr(ref) {
      try {
        return toPr(JSON.parse(gh(["pr", "view", ref, "--json", PR_FIELDS])) as GhPr);
      } catch {
        return null;
      }
    },
    findPr(branch, state) {
      const out = gh(["pr", "list", "--head", branch, "--state", state, "--json", "number", "--jq", ".[0].number"]);
      return out && out !== "null" ? out : undefined;
    },
    createPr({ base, head, title, body, attachments }) {
      const url = gh(["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body, ...attachArgs(attachments)]);
      return url.split("/").pop()!;
    },
    prBody(id) {
      return gh(["pr", "view", id, "--json", "body", "--jq", ".body"]);
    },
    editPrBody(id, body) {
      gh(["pr", "edit", id, "--body", body]);
    },
    commentPr(id, body, attachments = []) {
      gh(["pr", "comment", id, "--body", body, ...attachArgs(attachments)]);
    },
    mergePr(id, method: MergeMethod) {
      gh(["pr", "merge", id, `--${method}`]);
    },

    viewIssueCommand: (issueId) => `gh issue view ${issueId}`,
    agentGuide: () => GITHUB_AGENT_GUIDE,
  };
}
