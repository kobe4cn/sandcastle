// GitHub：用宿主机上已登录的 gh CLI（2.99+，PR 评论的 --attach 要用）。
// 参数与 duckdb_crm 原来 main.ts 里的调用逐字一致；test/forge-github.test.ts 锁住了每个方法的 argv。

import { basename } from "node:path";
import type { Forge, ForgePr, ForgeIssue, MergeMethod } from "../forge.ts";
import { sh } from "../shell.ts";

/** 跑一次 gh，返回 trim 过的 stdout；失败抛错。测试里换成记录 argv 的假实现。 */
export type GhRunner = (args: string[]) => string;

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

/** 截图附件：gh 2.99+ 的 --attach 上传图片，没在正文里引用的附在末尾 */
const attachArgs = (files: string[]) => files.flatMap((file) => ["--attach", `${file}#${basename(file)}`]);

const lines = (out: string) => out.split("\n").filter(Boolean);

export function githubForge(gh: GhRunner = (args) => sh("gh", args)): Forge {
  return {
    name: "github",

    listOpenIssues(labels) {
      // 用 `--label`（issues 列表接口，实时）而不是 `--search`（搜索索引）：索引有延迟，刚打上的标签要过一阵
      // 才查得到。2026-11-05 #393 刚打上 prepped，plan 用 --search 没查到，脚本以为没票可做就退出了。
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
  };
}
