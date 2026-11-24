// Sandcastle：prep → plan → implement + review → 门槛 → 合并（不能合并的留 PR）
//
// 调度（不分轮）：最多 MAX_PARALLEL 个空位。有空位时做一次「整理 → prep → plan」，把空位补满；每张票
// 独立跑 build → land，做完马上让出空位并触发下一次调度。有空位但开不了工时每 POLL_INTERVAL_MS 轮询一次
// （人合并了 PR、blocker 关了、去掉了 stuck，都能在下一次轮询开工）；没票在做、也开不出新票算一次空转，
// 连续 MAX_ITERATIONS 次空转就结束。宿主机上的 git / 标签操作（调度与落地）串行，build 在沙箱里并行。
//
// 每次调度与每张票：
//   Phase 0 (Prep):  人工给 issue 打上 `Sandcastle` 标签即为「选中」。还没有
//                    `sandcastle:prepped` 的选中票逐张（串行）跑 prep-ticket（`## Blocked by` 里
//                    还有 open 票的脚本直接跳过，不开会话）：
//                    够小且指引新鲜 → 打 prepped；太大 → 拆成子票（子票继承
//                    `Sandcastle`，父票去掉）；要人拍板 → 打 sandcastle:stuck（能代拍板的按 .sandcastle/DECISIONS.md 自己定）。
//   Phase 1 (Plan):  脚本自己算（不用 agent）：只看 `Sandcastle` + `sandcastle:prepped`、且没有
//                    pr-open / stuck 的票，排除仍有未关闭 blocker 的票；剩下的按编号从小到大，
//                    和已选的票或等人审（pr-open）的票改同一个文件（指引的 Change 行）就跳过。
//   Phase 2 (Build): 每张票一个沙箱，从 origin/main 建分支：implementer（每次迭代
//                    都是全新的 Claude 会话）→ reviewer（给出 merge / revise / pr 结论；revise
//                    时把修改意见交给新的 implementer 会话改完再审，最多 REVISE_MAX 次）→
//                    门槛（脚本自己跑 typecheck + 完整测试，失败时让 implementer 修一次）。
//                    最多 MAX_PARALLEL 张并行，每个沙箱用独立的测试库与前缀。
//   Phase 3 (Land):  在宿主机上 push、开 PR（`Closes #n`）。reviewer 说 merge 且门槛通过
//                    → `gh pr merge --rebase`，issue 自动关闭；否则打 sandcastle:pr-open 等人审。
//                    合并不了（先合并的票造成冲突，或项目配置的一致性检查没过，如迁移链分叉）时，rebase 到
//                    最新的 origin/main（冲突与迁移交给 agent，rebase-prompt.md），重跑门槛后再合并一次。
//   每次调度开头：等人审的 PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，
//                    或别人点的 Request changes）→ 去掉 issue 的 sandcastle:pr-open，这张票这次
//                    重新进入 plan，implementer 先读 PR 上的意见。
//   外部 PR：别人开的、`Closes` 了 Sandcastle 票的 PR（分支不是 `sandcastle/` 开头），打回后在它的分支上
//                    接着改：只做普通 push，不 rebase、不合并、不删分支，结果评论在 PR 上留给人合并。
//
// 每个阶段用哪个模型（Claude 订阅或别家的 Anthropic 兼容接口）、撞限额时换哪个：.sandcastle/models.json（models.ts）。
// 标签状态机见 docs/sandcastle.md。
//
// 随项目变的部分（托管平台、测试隔离、门槛、合并前检查、自动开票的文案）都在目标项目的
// .sandcastle/sandcastle.config.ts（profile.ts 的 ProjectProfile）；托管平台的操作都走 Forge（forge.ts）。
//
// Usage（在目标项目根目录）: npx tsx <本仓库>/src/main.ts
//        SANDCASTLE_ONLY=328,329 npx tsx <本仓库>/src/main.ts   只处理这几张票（试跑、单独补跑）

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import {
  AllProfilesLimited, CLAUDE_LIMIT_PATTERN, agentFor, limitResetAt, recordUsage, reloadModels, runWithProfile, sessionPeak, usageTable,
  type AgentRun, type Phase, type UsageRecord,
} from "./models.ts";
import { blockersOf, changedFiles, type FlakySighting, flakyTickets, flakyTriage, splitChildren } from "./guide.ts";
import { acceptanceSection, checkAcceptanceNotes, replaceSection, restSections } from "./pr-body.ts";
import type { ForgeIssue, ForgePr } from "./forge.ts";
import { loadProject } from "./profile.ts";
import { attempt, envPrefix, gitRemote, gitRemoteOrThrow, REMOTE_TRANSIENT, sh, shellQuote, trySh } from "./shell.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const project = await loadProject();
const forge = project.forge;

// agent 多久没输出算卡死：库默认 600 秒，太短（门槛失败后的 fix 会话要在后台重跑慢测试，等通知期间没有输出）。
const AGENT_IDLE_TIMEOUT_S = project.agentIdleTimeoutS;
const POLL_INTERVAL_MS = project.pollIntervalMs; // 有空位时隔多久重新调度一次（整理 → prep → plan），看有没有新开得了工的票
const MAX_ITERATIONS = project.maxIdlePolls; // 连续空转（没有票在做、也开不出新票）多少次就结束运行
const MAX_PARALLEL = project.maxParallel; // 同时实现的票数：受测试依赖的服务与机器负载限制；门槛另外排队、同一时间只跑一个（runGate）
const IMPLEMENT_MAX_ITERATIONS = project.implementMaxSessions; // 一张票最多开几次全新会话；超过说明票太大，交给人
/** 第一次没做完时脚本留在 issue 上的标记；prep 看到它就按「实现没做完」重新准备，再没做完才打 stuck。 */
const REPREP_MARK = "<!-- sandcastle:reprep -->";
/** implementer 的两个完成信号：做完了；遇到必须由人拍板的设计决定（.sandcastle/DECISIONS.md），票直接交给人，不再开新会话。 */
const COMPLETE = "<promise>COMPLETE</promise>";
const NEEDS_DECISION = "<promise>NEEDS_DECISION</promise>";
/** agent 代拍板时 issue 评论的第一行（.sandcastle/DECISIONS.md）；落地时脚本据此打 sandcastle:decided 并把评论贴到 PR 上。 */
const DECIDED_MARK = "<!-- sandcastle:decided -->";
const REVISE_MAX = project.reviseMax; // reviewer 给 revise 时最多打回几次；之后仍不行就留 PR 给人
const CONTEXT_BUDGET = project.contextBudget; // 单个会话的上下文预算
const REMOTE = project.remote;
const BASE_BRANCH = project.baseBranch;
// 从远端 main 建分支：已合并的代码在远端，不动宿主机本地 main 的工作区。
const BASE_REF = `${REMOTE}/${BASE_BRANCH}`;
// 只处理这几张票（逗号分隔）；不设则处理全部带 Sandcastle 标签的票。拆出来的子票不在名单里，要另外加。
const ONLY = new Set((process.env.SANDCASTLE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const allowed = (id: string | number) => ONLY.size === 0 || ONLY.has(String(id).replace(/^#/, ""));

const LABEL = project.labels;
const APPEND_ONLY: ReadonlySet<string> = new Set(project.appendOnlyFiles);

/** 调度顺序：main 坏了的修复票排最前，其余按编号从小到大（早建的票通常是后面票的 blocker）。 */
const byUrgency = (a: { number: number; labels: string[] }, b: { number: number; labels: string[] }) => {
  const urgent = (i: typeof a) => (i.labels.includes(LABEL.mainBroken) ? 0 : 1);
  return urgent(a) - urgent(b) || a.number - b.number;
};

// 同一会话超过预算前自动压缩；预算本身靠 prep 把票切小来保证。
const claudeEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CONTEXT_BUDGET) };

/**
 * 跑一次 agent 会话：阶段用哪个档案（模型、厂商）由 .sandcastle/models.json 决定，撞限额换下一个（models.ts）。
 * 用量追加到 .sandcastle/logs/usage.jsonl，也放进 usage（落地时写进 PR）。
 */
async function runAgent<T extends AgentRun>(
  phase: Phase,
  issue: string,
  name: string,
  env: Record<string, string>,
  usage: UsageRecord[],
  fn: (agent: sandcastle.AgentProvider) => Promise<T>,
): Promise<T> {
  const { run, profile } = await runWithProfile(phase, name, (p) => fn(agentFor(p, { ...claudeEnv, ...env }, phase)));
  usage.push(recordUsage(issue, phase, run, name, profile));
  return run;
}

// ---------------------------------------------------------------------------
// 每张票的测试环境：项目配置的 isolation（独立的测试库、前缀……），关沙箱后回收。
// ---------------------------------------------------------------------------

const testEnv = (runId: string) => project.isolation.env(runId);
async function dropTestResources(runId: string) {
  try {
    await project.isolation.cleanup?.(runId);
  } catch (e) {
    console.warn(`  ⚠ #${runId} 测试资源回收出错：${String(e).slice(0, 500)}`);
  }
}

// 浏览器验收的产物：implementer 写在 worktree 的 .browser-check/（.gitignore 忽略），
// 关沙箱前拷到宿主机，开 PR 时把截图用 `gh --attach` 附上、RESULT.md 写进正文。
const BROWSER_DIR = ".browser-check";
const SHOTS_ROOT = join(tmpdir(), "sandcastle-browser-check");

function collectBrowserCheck(worktreePath: string, issueId: string) {
  const from = join(worktreePath, BROWSER_DIR);
  if (!existsSync(from)) return undefined;
  const to = join(SHOTS_ROOT, `issue-${issueId}`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const resultFile = join(to, "RESULT.md");
  return {
    result: existsSync(resultFile) ? readFileSync(resultFile, "utf8").trim() : undefined,
    shots: readdirSync(to).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => join(to, f)),
  };
}

/** 验收说明（implementer 写在 worktree 的 `.pr-notes/验收说明.md`，不提交）：必须在关沙箱前读——
 *  close 在 worktree 没有未提交改动时会删掉 worktree，被 gitignore 的文件不算改动。 */
function readAcceptanceNotes(worktreePath: string): string | undefined {
  const file = join(worktreePath, ".pr-notes", "验收说明.md");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

// 合并门槛：脚本自己跑，不信 agent 的口头结论。脚本内容与输出约定见项目配置的 gate（profile.ts 的 GateConfig）。
// 输出里有一行 GATE_TIER: full|selected，脚本据此计数、写进 PR；重跑才通过时有 GATE_FLAKY。
const GATE_RERUN_MAX = project.gate.rerunMax;
type GateTier = "selected" | "full";
const gateTier = (stdout: string): GateTier => (stdout.includes("GATE_TIER: selected") ? "selected" : "full");
const gateTierName = (tier: GateTier) => (tier === "selected" ? "按依赖选" : "完整");
const GATE_SCRIPT = project.gate.script({ baseRef: BASE_REF });

// 门槛同一时间只跑一个（不分档位）：并行跑时 CPU 与测试依赖的服务都被挤满，反而比先后跑更慢、更容易超时。
// 门槛独占时可以给更多资源（项目配置 gate.env，比如更多 worker）。
let gateQueue: Promise<unknown> = Promise.resolve();
type ExecResult = { stdout: string; exitCode: number };
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

/** 跑一次门槛：所有门槛排同一个队；用时（和排队时间）打进日志，并追加在输出末尾一行 GATE_TIME（进 PR 的 Gate 一节）。 */
async function runGate<R extends ExecResult>(
  exec: (command: string) => Promise<R>,
  issueId: string,
  env: Record<string, string>,
): Promise<R> {
  const queued = Date.now();
  const go = async () => {
    const waited = Date.now() - queued;
    if (waited > 5_000) console.log(`  ⏳ #${issueId} 排队 ${minutes(waited)} 分钟后开始跑门槛`);
    const started = Date.now();
    const r = await exec(`${envPrefix({ ...env, ...project.gate.env })} sh -c ${shellQuote(GATE_SCRIPT)}`);
    const took = `${gateTierName(gateTier(r.stdout))}门槛用时 ${minutes(Date.now() - started)} 分钟${waited > 5_000 ? `（之前排队 ${minutes(waited)} 分钟）` : ""}`;
    console.log(`  ⏱ #${issueId} ${took}，${r.exitCode === 0 ? "通过" : "失败"}`);
    return { ...r, stdout: `${r.stdout}\nGATE_TIME: ${took}` };
  };
  const run = gateQueue.then(go);
  gateQueue = run.catch(() => {});
  return run;
}

// 沙箱建好后装依赖（项目配置 install）：拷进来的 node_modules 等是宿主机的，可能缺容器平台的原生包。
const hooks = {
  sandbox: { onSandboxReady: [{ command: project.install.onSandboxReady }] },
};
const copyToWorktree = project.install.copyToWorktree;

// createSandbox 里的 sandbox.run 不使用 agent provider 的 env，只有容器启动时 podman({env}) 的 env
// 才进得了 agent 的 shell，所以测试库连接与上下文预算都在这里注入。
const sandboxFor = (env: Record<string, string>) => project.sandbox({ ...claudeEnv, ...env });

// ---------------------------------------------------------------------------
// Host helpers
// ---------------------------------------------------------------------------

// sh / trySh / gitRemote 在 shell.ts。

// 沙箱和落地里的临时错误（2026-11-07 机器睡眠醒来后：复制 node_modules 到工作区超过 60 秒、
// GitHub API 读超时）不直接打 stuck：等一会儿整步重跑。build 在原分支上重跑，implementer 会接着已有提交做；
// land 开头会查 issue 是否已关、PR 是否已开，重跑最多多出一条评论。
const TRANSIENT = new RegExp(`${REMOTE_TRANSIENT.source}|CopyToWorktreeTimeoutError|timed out`, "i");
const TRANSIENT_RETRY_WAITS_MS = [60_000, 300_000, 900_000];

async function retryTransient<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = String((e as { stderr?: unknown }).stderr || e);
      const wait = TRANSIENT_RETRY_WAITS_MS[attempt];
      if (wait === undefined || !TRANSIENT.test(message)) throw e;
      console.warn(`  ⚠ ${what} 撞上临时错误（${message.split("\n")[0].slice(0, 160)}），${wait / 1000} 秒后重跑（第 ${attempt + 1}/${TRANSIENT_RETRY_WAITS_MS.length} 次）`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * prep 与 plan 不建分支，podman 是挂载型沙箱，默认挂的是宿主机工作区（本地 HEAD），
 * 不是 origin/main。本地 main 落后时，prep 的 Explore 读到旧代码：指引的 file:line 对不上，
 * 刚合并的 blocker 也看不到。所以每次调度 fetch 后把本地 main 快进到 origin/main。
 * 只在当前分支是 main 时做；--ff-only 遇到本地领先或分叉、或会覆盖未提交改动时 git 自己拒绝，
 * 这时只打警告，不动工作区。
 */
function syncHostBase() {
  const branch = trySh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== BASE_BRANCH) {
    console.warn(`  ⚠ 宿主机当前在 ${branch}，不是 ${BASE_BRANCH}：prep / plan 读到的是这个分支的代码，可能不是 ${BASE_REF}`);
    return;
  }
  const merged = trySh("git", ["merge", "--ff-only", "--quiet", BASE_REF]);
  if (!merged.ok) {
    console.warn(`  ⚠ 本地 ${BASE_BRANCH} 没能快进到 ${BASE_REF}，prep / plan 可能读到旧代码：${merged.out.slice(0, 300)}`);
  }
}

/** 带全部 `include` 标签、不带任何 `exclude` 标签的 open 票（排除的标签在本地过滤）。 */
type ListedIssue = ForgeIssue;
const listIssues = (include: string[], exclude: string[] = []): ListedIssue[] =>
  forge.listOpenIssues(include).filter((issue) => !issue.labels.some((label) => exclude.includes(label)));

// ---------------------------------------------------------------------------
// Plan：确定性计算，不交给 agent（planner agent 曾把「同文件只留编号小的」比反）
// ---------------------------------------------------------------------------

/** 票的 open 状态，每次调度开头清空（blocker 可能在两次调度之间被合并）。 */
const openStates = new Map<number, boolean>();
function isOpen(n: number): boolean {
  if (!openStates.has(n)) {
    const r = attempt(() => forge.issueState(String(n)));
    openStates.set(n, !r.ok || r.value === "open"); // 查不到时当作 open，宁可少做
  }
  return openStates.get(n)!;
}

/** `## Blocked by` 里还没关的票。 */
const openBlockers = (body: string) => blockersOf(body).filter(isOpen);

/**
 * 拆过的父票：prep 拆票时去掉父票的 Sandcastle，正文加 `## Split into`，之后没人管它，
 * 被它 block 的票就一直排不上（2026-11-04 #381 的子票 #389、#390 都合并了，#382 仍在等 #381）。
 * 每次调度开头查不带 Sandcastle、有 `## Split into` 的 open 票，子票全关了就勾上清单、关掉父票。
 * 「上下文不够」那种父票保留 Sandcastle、由自己的 PR 关，不在这里处理。平台出错只打警告。
 */
function closeFinishedParents() {
  const parents = attempt(() => forge.listSplitParents(LABEL.picked));
  if (!parents.ok) {
    console.warn(`  ⚠ 查拆过的父票失败：${parents.out.slice(0, 200)}`);
    return;
  }
  for (const parent of parents.value) {
    const children = splitChildren(parent.body);
    if (children.length === 0 || children.some(isOpen)) continue;
    const body = parent.body.replace(/^(\s*[-*]\s*)\[ \](?=\s*#\d+)/gm, "$1[x]");
    const list = children.map((n) => `#${n}`).join("、");
    if (body !== parent.body) attempt(() => forge.editIssueBody(String(parent.number), body));
    const closed = attempt(() => forge.closeIssue(String(parent.number), `子票 ${list} 都已关闭，Sandcastle 关闭父票。`));
    if (closed.ok) {
      openStates.set(parent.number, false);
      console.log(`  ✓ 父票 #${parent.number} 的子票 ${list} 都已关闭，已关闭父票`);
    } else {
      console.warn(`  ⚠ 关闭父票 #${parent.number} 失败：${closed.out.slice(0, 200)}`);
    }
  }
}

/**
 * 已关闭票的残留：人在 GitHub 上手动合并 Sandcastle 的 PR、或在运行中途合并 / 关掉正在做的票时，
 * land 不会走到删分支那一步（2026-11-08 #450：PR #456 由人合并），远端分支、本地 worktree 与分支、
 * sandcastle:* 状态标签都留着。每次调度开头清一次：
 * - 已关闭票上的 prepped / pr-open / stuck 去掉（decided 等人事后确认、flaky 是分类，不动）；
 * - `sandcastle/issue-<n>` 只在票已关闭、且这个分支有已合并的 PR 时删：远端分支、本地 worktree、本地分支。
 *   worktree 有未提交改动时 git 拒绝删除，留着并警告。没合并就关掉的票（不做了）分支留着，里面的提交可能还有人要看。
 * 出错只打警告。
 */
async function cleanupClosedIssues() {
  for (const label of [LABEL.prepped, LABEL.prOpen, LABEL.stuck]) {
    const closed = attempt(() => forge.listClosedIssueNumbers(label));
    if (!closed.ok) {
      console.warn(`  ⚠ 查带 ${label} 的已关闭票失败：${closed.out.slice(0, 200)}`);
      continue;
    }
    const cleared: string[] = [];
    for (const n of closed.value.map(String)) {
      const edited = attempt(() => forge.removeLabel(n, label));
      if (edited.ok) cleared.push(`#${n}`);
      else console.warn(`  ⚠ 去掉 #${n} 的 ${label} 失败：${edited.out.slice(0, 200)}`);
    }
    if (cleared.length > 0) console.log(`  🧹 已关闭的票去掉 ${label}：${cleared.join("、")}`);
  }

  const branchOf = /^sandcastle\/issue-(\d+)$/;
  const remote = await gitRemote(["ls-remote", "--heads", REMOTE, "sandcastle/issue-*"]);
  if (!remote.ok) console.warn(`  ⚠ 列远端的 sandcastle 分支失败：${remote.out.slice(0, 200)}`);
  const remoteBranches = remote.ok
    ? remote.out.split("\n").map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? "").filter((b) => branchOf.test(b))
    : [];
  const local = trySh("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/sandcastle/"]);
  const localBranches = local.ok ? local.out.split("\n").filter((b) => branchOf.test(b)) : [];
  // git worktree list --porcelain：每个 worktree 一段，`worktree <path>` 后面跟 `branch refs/heads/<name>`
  const worktrees = new Map<string, string>();
  let path = "";
  for (const line of trySh("git", ["worktree", "list", "--porcelain"]).out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) worktrees.set(line.slice("branch refs/heads/".length), path);
  }

  for (const branch of new Set([...remoteBranches, ...localBranches])) {
    const id = branch.match(branchOf)![1]!;
    if (!issueClosed(id)) continue;
    const pr = attempt(() => forge.findPr(branch, "merged"));
    if (!pr.ok || !pr.value) continue;
    const removed: string[] = [];
    if (remoteBranches.includes(branch)) {
      const deleted = await gitRemote(["push", REMOTE, "--delete", branch]);
      if (deleted.ok) removed.push("远端分支");
      else console.warn(`  ⚠ 删除远端分支 ${branch} 失败：${deleted.out.slice(0, 200)}`);
    }
    const worktree = worktrees.get(branch);
    if (worktree) {
      const gone = trySh("git", ["worktree", "remove", worktree]);
      if (!gone.ok) {
        console.warn(`  ⚠ #${id} 的 worktree ${worktree} 没删（有未提交改动？）：${gone.out.slice(0, 200)}`);
        continue;
      }
      removed.push("worktree");
    }
    if (localBranches.includes(branch) && trySh("git", ["branch", "-D", branch]).ok) removed.push("本地分支");
    if (removed.length > 0) console.log(`  🧹 #${id} 已关闭、PR #${pr.value} 已合并，删除${removed.join("、")}`);
  }
}

/**
 * 能在 main 上开工、且可以并行的票，按编号从小到大。
 * blocker 没关（包括已开 PR 未合并）的跳过；和已选的票、或等人审（pr-open）的票改同一个文件的跳过，
 * 所以冲突时总是编号小的先做，等人审的 PR 合入或关闭前不会有第二个 PR 改同一个文件。
 * 被 blocker 挡住的票不占文件，不会连带挡住编号大的票。
 * running 是正在 build / 落地的票：不再选，它们改的文件和等人审的票一样先占上；最多补满 slots 张。
 */
function plan(running: ReadonlySet<string>, slots: number, quiet = false): Issue[] {
  const log = quiet ? () => {} : console.log;
  const warn = quiet ? () => {} : console.warn;
  const candidates = listIssues([LABEL.picked, LABEL.prepped], [LABEL.prOpen, LABEL.stuck]);
  // 等人审的 PR 还没合进 main：它们改的文件先占上，免得新票在旧 main 上改同一个文件，两个 PR 互相冲突。
  const waiting = listIssues([LABEL.picked, LABEL.prOpen]);
  const taken = new Map<string, number>();
  const awaitingReview = new Set<number>();
  for (const w of waiting.sort((a, b) => a.number - b.number)) {
    awaitingReview.add(w.number);
    for (const f of changedFiles(w.body, APPEND_ONLY).files) if (!taken.has(f)) taken.set(f, w.number);
  }
  for (const r of candidates.filter((c) => running.has(String(c.number)))) {
    for (const f of changedFiles(r.body, APPEND_ONLY).files) if (!taken.has(f)) taken.set(f, r.number);
  }
  const picked: Issue[] = [];
  for (const issue of candidates.filter((c) => allowed(c.number) && !running.has(String(c.number))).sort(byUrgency)) {
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      log(`  跳过 #${issue.number}：blocker ${open.map((n) => `#${n}`).join("、")} 还没关`);
      continue;
    }
    const { files, fallback } = changedFiles(issue.body, APPEND_ONLY);
    if (fallback) warn(`  ⚠ #${issue.number} 的指引里没认出 Change 行，按指引引用的文件处理：${files.join("、")}`);
    else if (files.length === 0) warn(`  ⚠ #${issue.number} 的指引里没认出要改的文件，按不改已有文件处理`);
    const clash = files.find((f) => taken.has(f));
    if (clash) {
      const owner = taken.get(clash)!;
      const why = awaitingReview.has(owner)
        ? `等人审的 #${owner}（PR 合入或关闭后再做）`
        : running.has(String(owner)) ? `正在做的 #${owner}` : `#${owner}`;
      log(`  跳过 #${issue.number}：和${why}都改 ${clash}`);
      continue;
    }
    if (picked.length >= slots) break;
    for (const f of files) taken.set(f, issue.number);
    // 已有外部 PR（`Closes` 了这张票）时在它的分支上接着改；否则照旧用自己的分支。
    const pr = prFor(issue.number);
    const branch = pr && !pr.branch.startsWith("sandcastle/") ? pr.branch : ownBranch(issue.number);
    picked.push({ id: String(issue.number), title: issue.title, branch });
  }
  return picked;
}

/** implement 的几次会话合在一起（每次会话单独挑档案，分开跑）。 */
type Sessions = { iterations: sandcastle.IterationResult[]; stdout: string; completionSignal?: string };
const peakContext = (...runs: ({ readonly iterations: readonly sandcastle.IterationResult[] } | undefined)[]) =>
  Math.max(
    0,
    // 每次会话取会话文件里单条消息的最大上下文；只看结束时的大小会漏掉中途压缩前的峰值。
    ...runs.flatMap((run) => (run?.iterations ?? []).map(sessionPeak)),
  );

const tagged = (stdout: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(stdout)?.[1]?.trim();

type Issue = { id: string; title: string; branch: string };

const ownBranch = (issueId: string | number) => `sandcastle/issue-${issueId}`;
/**
 * 外部 PR：别人（其他 agent、人）开的、`Closes` 了这张票的 PR，分支不是 `sandcastle/` 开头。
 * Sandcastle 在它的分支上接着改，但只做普通 push：不 force、不 rebase、不合并、不删分支，合并留给人。
 */
const isExternal = (issue: Issue) => !issue.branch.startsWith("sandcastle/");

/** 推分支：自己的分支照旧 force-with-lease（rebase 过）；外部分支只做普通 push，被拒就报错。 */
function pushBranch(issue: Issue) {
  return gitRemote(isExternal(issue)
    ? ["push", REMOTE, `${issue.branch}:${issue.branch}`]
    : ["push", "--force-with-lease", "-u", REMOTE, issue.branch]);
}

/**
 * 这张票的 open PR：先按 issue 关联（PR 正文的关闭写法），同时有自己的分支时用自己的；
 * 关联里只有一个本仓库的外部 PR 时用它；有多个外部 PR 时不猜，返回 null 并打日志。
 * 关联查不到（接口出错、没有关联）时退回按分支名 `sandcastle/issue-n` 查。
 */
function prFor(issueId: string | number): ForgePr | null {
  const view = (ref: string): ForgePr | null => {
    const pr = forge.viewPr(ref);
    return pr?.open ? pr : null;
  };
  const linked = attempt(() => forge.linkedPrIds(String(issueId)));
  const prs = linked.ok
    ? linked.value.map(view).filter((pr): pr is ForgePr => pr !== null && !pr.fromFork)
    : [];
  const own = prs.find((pr) => pr.branch === ownBranch(issueId));
  if (own) return own;
  const external = prs.filter((pr) => !pr.branch.startsWith("sandcastle/"));
  if (external.length > 1) {
    console.warn(`  ⚠ #${issueId} 关联了多个外部 PR（${external.map((pr) => `#${pr.id}`).join("、")}），不知道在哪个上改，跳过`);
    return null;
  }
  return external[0] ?? view(ownBranch(issueId));
}

/**
 * 外部 PR 的分支：开沙箱前同步到宿主机本地（沙箱从本地分支建 worktree，本地没有就会从 main 新建，丢掉对方的提交）。
 * 本地没有就从远端建；本地落后就快进；本地领先（上次没推上去）就保留；两边分叉就报错，交给人。
 */
async function syncExternalBranch(issue: Issue) {
  await gitRemoteOrThrow(["fetch", REMOTE, issue.branch]);
  const remote = `${REMOTE}/${issue.branch}`;
  if (!trySh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issue.branch}`]).ok) {
    sh("git", ["branch", issue.branch, remote]);
  } else if (trySh("git", ["merge-base", "--is-ancestor", issue.branch, remote]).ok) {
    sh("git", ["branch", "-f", issue.branch, remote]);
  } else if (!trySh("git", ["merge-base", "--is-ancestor", remote, issue.branch]).ok) {
    throw new Error(`本地分支 ${issue.branch} 和 ${remote} 分叉了（PR 作者在 Sandcastle 处理期间推过提交？），请人合并后再跑。`);
  }
}

/** PR 正文的两大块：验收说明（最前面的一节，准备段落 + `.pr-notes/验收说明.md`）与其余各节（restSections 的结果）。 */
type PrNotes = { acceptance: string; rest: string };

async function pushAndOpenPr(issue: Issue, notes: PrNotes, shots: string[]): Promise<string> {
  const pushed = await pushBranch(issue);
  if (!pushed.ok) throw new Error(`push ${issue.branch} 失败：${pushed.out.slice(0, 500)}`);
  const existing = forge.findPr(issue.branch, "open");
  if (existing) {
    // 已有 PR：自己的分支只替换正文里的「验收说明」一节，其余（上次的 Review / Gate 记录）逐字保留；
    // 外部 PR 不动别人写的正文，验收说明贴在评论里。
    if (isExternal(issue)) {
      forge.commentPr(existing, `Sandcastle 更新了这个分支。\n\n## 验收说明\n\n${notes.acceptance}\n\n${notes.rest}`, shots);
    } else {
      const body = forge.prBody(existing);
      forge.editPrBody(existing, replaceSection(body, "验收说明", `## 验收说明\n\n${notes.acceptance}`));
      forge.commentPr(existing, `Sandcastle 更新了这个分支（验收说明已更新）。\n\n${notes.rest}`, shots);
    }
    return existing;
  }
  // 外部 PR 不在这里新开：它被关了就说明人不要了。
  if (isExternal(issue)) throw new Error(`分支 ${issue.branch} 上已经没有 open 的 PR，外部 PR 不由 Sandcastle 重开。`);
  const commits = sh("git", ["log", `${BASE_REF}..${issue.branch}`, "--format=- %B"]);
  const body = `${forge.closingRef(issue.id)}\n\n## 验收说明\n\n${notes.acceptance}\n\n${notes.rest}\n\n## Commits\n\n${commits}`;
  return forge.createPr({ base: BASE_BRANCH, head: issue.branch, title: `${issue.title} (#${issue.id})`, body, attachments: shots });
}

function leaveForHuman(issue: Issue, pr: string, reason: string) {
  forge.addLabel(issue.id, LABEL.prOpen);
  forge.commentPr(pr, `没有自动合并：${reason}`);
}

/** agent 代拍板过的票：打 sandcastle:decided，把那些评论贴到 PR 上，人事后确认。平台出错只警告，不影响落地。 */
function reportDecisions(issueId: string, pr: string) {
  const r = attempt(() => forge.issueComments(issueId));
  if (!r.ok) return console.warn(`  ⚠ 读 #${issueId} 的代拍板评论失败：${r.out.slice(0, 200)}`);
  const decisions = r.value.filter((body) => body.startsWith(DECIDED_MARK)).map((body) => body.slice(DECIDED_MARK.length).trim());
  if (!decisions.length) return;
  const label = attempt(() => forge.addLabel(issueId, LABEL.decided));
  const comment = attempt(() => forge.commentPr(pr, `## 代拍板\n\nagent 按 \`.sandcastle/DECISIONS.md\` 自己定了 ${decisions.length} 个设计决定，请事后确认（不同意就在 issue 上回复，确认后去掉 #${issueId} 的 \`${LABEL.decided}\`）：\n\n${decisions.map((d, n) => `<details><summary>第 ${n + 1} 个</summary>\n\n${d}\n\n</details>`).join("\n\n")}`));
  for (const x of [label, comment]) if (!x.ok) console.warn(`  ⚠ #${issueId} 代拍板标记失败：${x.out.slice(0, 200)}`);
  console.log(`  📝 #${issueId} 有 ${decisions.length} 个代拍板，打 ${LABEL.decided}`);
}

function markStuck(issueId: string, reason: string) {
  forge.addLabel(issueId, LABEL.stuck);
  forge.commentIssue(issueId, `Sandcastle 停下了：${reason}`);
}

/** PR 上以这个开头的评论或 review 正文表示「打回 Sandcastle」（作者不能对自己的 PR 点 Request changes）。 */
const REVISE_COMMAND = "/sandcastle";

/**
 * 等人审的票：PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，或别人点的
 * Request changes）→ 去掉 issue 的 pr-open，让它回到 plan。比较时间是为了不重复回流：
 * Sandcastle 改完推上新提交后，同一条意见不再算数。
 */
function reopenRequestedRevisions() {
  for (const { number: issueId } of listIssues([LABEL.prOpen], [LABEL.stuck])) {
    if (!allowed(issueId)) continue;
    const pr = prFor(issueId);
    if (!pr) continue;
    const lastCommit = pr.lastCommitAt;
    const signals = [
      ...pr.reviews.filter((r) => r.changesRequested || r.body.trim().startsWith(REVISE_COMMAND)).map((r) => r.at),
      ...pr.comments.filter((c) => c.body.trim().startsWith(REVISE_COMMAND)).map((c) => c.at),
    ];
    if (!signals.some((at) => at > lastCommit)) continue;
    forge.removeLabel(String(issueId), LABEL.prOpen);
    forge.commentPr(pr.id, "收到打回，这张票重新进入 Sandcastle：implementer 会先处理这个 PR 上的意见。");
    console.log(`  ↺ #${issueId} 收到打回（PR #${pr.id}），重新排队`);
  }
}

/**
 * 门槛里重跑才通过的测试文件：按报错签名去重开票（带 Sandcastle，下次调度自动 prep + 修）。
 * 同签名（同根因落在不同文件）只开一张；已有同签名、或标题 `偶发失败：<文件>` 相同的老票，
 * 就在那张票上追加一次出现记录，不重复开票。只是超时 / 连不上、且同一文件 7 天内第一次出现的，
 * 只记进 FLAKY_FILE、不开票（规则见 guide.ts 的 flakyTriage）。返回票号与只记录的文件，写进 PR 评论。
 */
const FLAKY_FILE = ".sandcastle/logs/flaky.json";
function reportFlaky(issue: Issue, pr: string, gateOutput: string): { tickets: string[]; deferred: string[] } {
  // 单元测试和后面一段各可能重跑通过一次（两个 GATE_FLAKY）：每段重跑前列出的文件都要算上
  const parts = gateOutput.split("GATE_FLAKY");
  const before = parts.slice(0, -1).join("\n");
  const after = parts.slice(1).join("\n");
  const files = [...new Set(before.match(new RegExp(`^${project.gate.testFile.source}$`, "gm")) ?? [])];
  if (files.length === 0) return { tickets: [], deferred: [] };
  attempt(() => forge.ensureLabel(LABEL.flaky, "fbca04", "偶发失败的测试（Sandcastle 门槛自动开票）"));
  const open = forge.listOpenIssues([LABEL.flaky]);
  const seen = `#${issue.id} 的门槛（PR #${pr}）`;
  const summary = `\`\`\`\n${after.trim().slice(0, 3000)}\n\`\`\``;
  // 当时的环境：判断是不是负载 / 并发问题时先看这个
  const others = [...running.values()].filter((i) => i.id !== issue.id).map((i) => `#${i.id}`);
  const load = loadavg().map((n) => n.toFixed(1)).join(" / ");
  const env = `开票时：同时在做的票 ${others.length ? others.join("、") : "无"}；宿主机 1 / 5 / 15 分钟负载 ${load}（${cpus().length} 核）。`;
  // 分组、签名标记、标题与已有票的匹配见 guide.ts 的 flakyTickets；开不开票见 flakyTriage；正文见项目配置 texts.flakyIssueBody。
  let history: FlakySighting[] = [];
  try {
    history = JSON.parse(readFileSync(FLAKY_FILE, "utf8")) as FlakySighting[];
  } catch {}
  const triage = flakyTriage(flakyTickets(files, after, open, project.gate.testFile), history, issue.id, new Date());
  writeFileSync(FLAKY_FILE, `${JSON.stringify(triage.history, null, 1)}\n`);
  const deferred = triage.deferred.flatMap((g) => g.files);
  if (deferred.length) console.log(`  ⚠ #${issue.id} 门槛偶发超时 / 连接失败，7 天内第一次，只记录不开票：${deferred.join("、")}`);
  // 同一文件 7 天内之前的出现（超时类第二次出现才开票，票里列出前几次，方便判断是不是同一个环境时段）
  const prior = (groupFiles: string[]) => {
    const seenAt = history.filter((h) => groupFiles.includes(h.file)).map((h) => `${h.at.slice(0, 16)}Z #${h.issue} 的门槛（\`${h.file}\`）`);
    return seenAt.length ? `7 天内之前的出现：${seenAt.join("；")}。` : "";
  };
  const tickets = triage.ticket.map(({ files: groupFiles, marker, title, existing }) => {
    const list = groupFiles.map((f) => `\`${f}\``).join("、");
    if (existing !== undefined) {
      const again = marker
        ? `又出现一次：${seen}，这次失败的文件：${list}。`
        : `又出现一次：${seen}。`;
      forge.commentIssue(String(existing), `${again}${env}第一次的失败：\n\n${summary}`);
      return `#${existing}`;
    }
    const body = project.texts.flakyIssueBody({ files: groupFiles, seen, env, prior: prior(groupFiles), summary });
    const id = forge.createIssue({
      title, body: marker ? `${body}\n${marker}` : body, labels: [LABEL.flaky, LABEL.picked, LABEL.readyForAgent],
    });
    return `#${id}`;
  });
  return { tickets, deferred };
}

// ---------------------------------------------------------------------------
// Build one issue inside its own sandbox
// ---------------------------------------------------------------------------

async function build(issue: Issue) {
  if (isExternal(issue)) await syncExternalBranch(issue);
  const env = testEnv(issue.id);
  const sandbox = await sandcastle.createSandbox({
    branch: issue.branch,
    baseBranch: BASE_REF,
    sandbox: sandboxFor(env),
    hooks,
    copyToWorktree,
  });
  const usage: UsageRecord[] = [];
  const run = (phase: Phase, name: string, fn: (agent: sandcastle.AgentProvider) => Promise<sandcastle.SandboxRunResult>) =>
    runAgent(phase, issue.id, name, env, usage, fn);
  try {
    // 每次会话单独挑档案：撞了限额，下一次会话就换下一个档案接着做（交接靠 issue 上的进度评论）。
    // 档案名经环境变量 SANDCASTLE_PROFILE 给 implementer，不走 promptArgs：运行中的旧进程也会读到新提示词，多出的占位符会让它报错。
    const implement: Sessions = { iterations: [], stdout: "" };
    for (let session = 1; session <= IMPLEMENT_MAX_ITERATIONS && implement.completionSignal === undefined; session++) {
      const r = await run("implement", `implement-${issue.id}-${session}`, (agent) => sandbox.run({
        name: `implement-${issue.id}-${session}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        completionSignal: [COMPLETE, NEEDS_DECISION],
        agent,
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: { TASK_ID: issue.id, ISSUE_TITLE: issue.title, BRANCH: issue.branch },
      }));
      implement.iterations.push(...r.iterations);
      implement.stdout += r.stdout;
      implement.completionSignal = r.completionSignal;
    }
    // 看分支上的提交，不看这次会话的：重新准备后父票只剩已完成的部分，收尾时可能不再提交。
    const ahead = Number((await sandbox.exec(`git rev-list --count ${BASE_REF}..HEAD`)).stdout.trim()) || 0;
    if (implement.completionSignal !== COMPLETE || ahead === 0) {
      return { done: false as const, implement, usage };
    }

    const runReview = (round: number) =>
      run("review", `review-${issue.id}-${round}`, (agent) => sandbox.run({
        name: `review-${issue.id}-${round}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        promptFile: "./.sandcastle/review-prompt.md",
        promptArgs: { TASK_ID: issue.id, BRANCH: issue.branch, ROUND: round, REVISE_MAX },
      }));
    // reviewer 给 revise：修改意见交给新的 implementer 会话，改完再审一次。
    const reviews = [await runReview(0)];
    const revisions: { items: string; run: sandcastle.SandboxRunResult }[] = [];
    while (revisions.length < REVISE_MAX && tagged(reviews.at(-1)!.stdout, "verdict") === "revise") {
      const items = tagged(reviews.at(-1)!.stdout, "revise") ?? "（reviewer 没有列出修改意见）";
      const name = `revise-${issue.id}-${revisions.length + 1}`;
      const revise = await run("revise", name, (agent) => sandbox.run({
        name,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        prompt: project.texts.revisePrompt({
          issueId: issue.id, branch: issue.branch, title: issue.title, viewIssue: forge.viewIssueCommand(issue.id), items,
        }),
      }));
      revisions.push({ items, run: revise });
      reviews.push(await runReview(revisions.length));
    }
    const review = reviews.at(-1)!;

    const gate = () => runGate((c) => sandbox.exec(c), issue.id, env);
    let gateResult = await gate();
    let fix: sandcastle.SandboxRunResult | undefined;
    if (gateResult.exitCode !== 0) {
      // 给 implementer 一次修的机会（新会话），再跑一次门槛。
      fix = await run("fix", `fix-${issue.id}`, (agent) => sandbox.run({
        name: `fix-${issue.id}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        prompt: project.texts.fixPrompt({
          issueId: issue.id, branch: issue.branch, title: issue.title, viewIssue: forge.viewIssueCommand(issue.id),
          gateOutput: gateResult.stdout.slice(-4000), rerunMax: GATE_RERUN_MAX,
        }),
      }));
      gateResult = await gate();
    }

    return {
      done: true as const,
      implement,
      runs: [...reviews, ...revisions.map((r) => r.run), fix],
      revisions: revisions.map((r) => r.items),
      verdict: tagged(review.stdout, "verdict"),
      summary: tagged(review.stdout, "review-summary") ?? "（reviewer 没有给出摘要）",
      gate: { ok: gateResult.exitCode === 0, output: gateResult.stdout.slice(-3000), tier: gateTier(gateResult.stdout) },
      browser: collectBrowserCheck(sandbox.worktreePath, issue.id),
      notes: readAcceptanceNotes(sandbox.worktreePath),
      usage,
    };
  } finally {
    await sandbox.close();
    await dropTestResources(issue.id);
  }
}

// ---------------------------------------------------------------------------
// Rebase + retry merge（合并失败时）
// ---------------------------------------------------------------------------

const REBASE_STATE = "test -d \"$(git rev-parse --git-path rebase-merge)\" || test -d \"$(git rev-parse --git-path rebase-apply)\"";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 合并前的额外一致性检查（项目配置 integrity，比如数据库迁移链没分叉）：rebase 没有文本冲突也可能坏。
// 没配置时恒为通过。
const integrityOk = (head: string) => (project.integrity ? project.integrity.command(head, BASE_REF) : "true");
const INTEGRITY_OK = integrityOk("HEAD");
const integrityBroken = () => project.integrity?.broken(BASE_REF) ?? "一致性检查没通过";
const integrityName = project.integrity?.name ?? "一致性检查";

/**
 * 把分支 rebase 到最新的 origin/main：没冲突直接 rebase；有冲突开一次 agent 会话按
 * rebase-prompt.md 解决。merge 为 true 时重跑门槛，通过才 force-push 再合并；
 * 为 false 时只跑 typecheck 就 force-push 更新 PR（留给人审的 PR 不和 main 冲突，测试由人合并前决定是否补跑）。
 * 任何一步不成都返回原因，由调用方留 PR。
 */
type HostGap = { release: () => void; reacquire: () => Promise<void> };

/**
 * 调用方持有宿主机锁（withHost）。开沙箱、rebase、跑门槛这段放开锁（和 build 一样只动本票的分支与 worktree；
 * 这张票还在 running 里，它改的文件不会被新票占用；票没关，清理不会删它的 worktree），push 与合并前再拿回锁。
 * 放开期间别的票可能先合进 main：这里的合并会失败，按原有路径留 PR。
 */
async function rebaseAndMerge(issue: Issue, pr: string, host: HostGap, merge = true): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isExternal(issue)) return { ok: false, reason: `外部 PR 的分支 ${issue.branch} 不由 Sandcastle rebase 或合并。` };
  const env = testEnv(issue.id);
  host.release();
  let opened: Awaited<ReturnType<typeof sandcastle.createSandbox>> | undefined;
  try {
    await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
    const sandbox = await sandcastle.createSandbox({ branch: issue.branch, baseBranch: BASE_REF, sandbox: sandboxFor(env), hooks, copyToWorktree });
    opened = sandbox;
    const behind = await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`);
    if (behind.exitCode === 0) {
      return { ok: false, reason: `分支已经包含最新的 ${BASE_REF}，失败不是冲突造成的，需要人看。` };
    }

    // merge-tree 有冲突时退出码 1、冲突文件列在 stdout 第一行（树 id）之后；`; true` 让 trySh 拿到 stdout
    const probe = trySh("sh", ["-c", `git merge-tree --write-tree --name-only ${BASE_REF} ${issue.branch}; true`]);
    const conflictFiles = probe.ok ? probe.out.split("\n\n")[0]!.split("\n").slice(1).filter(Boolean) : [];
    const rebase = await sandbox.exec(`git rebase ${BASE_REF}`);
    const conflicted = rebase.exitCode !== 0;
    const chainBroken = !conflicted && (await sandbox.exec(INTEGRITY_OK)).exitCode !== 0;
    if (conflicted || chainBroken) {
      // 用量只进 usage.jsonl：这时 PR 已经开了。
      await runAgent("rebase", issue.id, `rebase-${issue.id}`, env, [], (agent) => sandbox.run({
        name: `rebase-${issue.id}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        promptFile: "./.sandcastle/rebase-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          BRANCH: issue.branch,
          BASE: BASE_REF,
          SITUATION: conflicted
            ? `\`git rebase ${BASE_REF}\` 停在冲突上（rebase 进行中）。`
            : `rebase 没有冲突，但${integrityBroken()}，需要重新生成。`,
        },
      }));
      if ((await sandbox.exec(REBASE_STATE)).exitCode === 0) {
        await sandbox.exec("git rebase --abort");
        return { ok: false, reason: "agent 没能解决 rebase 冲突（原因见 issue 评论）。" };
      }
      if ((await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`)).exitCode !== 0) {
        return { ok: false, reason: `处理后分支仍不在 ${BASE_REF} 之上。` };
      }
      if ((await sandbox.exec(INTEGRITY_OK)).exitCode !== 0) {
        return { ok: false, reason: `处理后仍然${integrityBroken()}。` };
      }
    }

    // 留给人审的 PR（merge 为 false）只跑 typecheck、不重跑测试：人合并前看 PR 评论里的冲突文件，
    // 需要时再补跑门槛。省掉一遍完整测试，也不占完整门槛的队列。
    if (!merge) {
      const tc = await sandbox.exec(`${project.gate.typecheck} > /tmp/rebase-typecheck.log 2>&1 || { tail -40 /tmp/rebase-typecheck.log; exit 1; }`);
      if (tc.exitCode !== 0) {
        return { ok: false, reason: `rebase 后 typecheck 失败：\n\n\`\`\`\n${tc.stdout.slice(-2000)}\n\`\`\`` };
      }
      await host.reacquire();
      await gitRemoteOrThrow(["push", "--force-with-lease", REMOTE, issue.branch]);
      const files = conflictFiles.length ? conflictFiles.map((f) => `\`${f}\``).join("、") : `（没有文本冲突，${integrityName}分叉）`;
      const how = conflicted || chainBroken ? "冲突由 agent 处理" : "rebase 没有冲突";
      console.log(`  ↻ #${issue.id} rebase 后 typecheck 通过，不重跑测试，留给人审`);
      forge.commentPr(pr, `Sandcastle 把分支 rebase 到最新的 ${BASE_REF}（原来和它冲突，${how}；冲突文件：${files}）。rebase 后只跑了 typecheck（通过），**没有重跑测试**：PR 正文 Gate 里的测试结果是 rebase 之前的，合并前请判断是否要补跑。`);
      return { ok: true };
    }

    // rebase 后的门槛和开工时同一套选测试规则（分支相对新 main 的改动），不再因冲突强制完整测试（2026-11-24）。
    const gate = await runGate((c) => sandbox.exec(c), issue.id, env);
    if (gate.exitCode !== 0) {
      return { ok: false, reason: `rebase 后门槛失败：\n\n\`\`\`\n${gate.stdout.slice(-2000)}\n\`\`\`` };
    }

    await host.reacquire();
    await gitRemoteOrThrow(["push", "--force-with-lease", REMOTE, issue.branch]);
    // 平台重新计算可合并状态要一点时间。
    let last = "";
    for (let tries = 0; tries < 3; tries++) {
      await sleep(10_000);
      const merged = attempt(() => forge.mergePr(pr, project.mergeMethod));
      if (merged.ok) {
        forge.commentPr(pr, `Sandcastle 把分支 rebase 到最新的 ${BASE_REF}，门槛重跑通过后合并。`);
        return { ok: true };
      }
      last = merged.out;
    }
    return { ok: false, reason: `rebase 并通过门槛后仍合并失败：${last.slice(0, 300)}` };
  } finally {
    if (opened) {
      await opened.close();
      await dropTestResources(issue.id);
    }
    await host.reacquire();
  }
}

// ---------------------------------------------------------------------------
// 用量限额：等到重置后接着跑，不当成票的失败
// ---------------------------------------------------------------------------

// 撞限额的识别、重置时间的解析和换档案在 models.ts；这里处理「这个阶段的档案都在等」：等到最早恢复的那个再从头跑。
const LIMIT_RESUME_SLACK_MS = 2 * 60_000; // 重置时间之后再多等一会儿
const LIMIT_FALLBACK_WAIT_MS = 30 * 60_000; // 认不出重置时间时每次等这么久再试

/** 分步睡：笔记本合盖时计时器会停，醒来按墙上时间判断。 */
async function sleepUntil(at: number) {
  while (Date.now() < at) await sleep(Math.min(60_000, at - Date.now()));
}

/**
 * 跑 fn，撞上用量限额就等到重置后重跑；其他错误照抛。
 * fn 要能从头重跑：prep 本来就幂等；build 重跑时在原分支上接着做（implementer 先看已有提交）。
 * onLimit 在等之前调用，比如把分支推到远端。
 */
async function untilAfterLimit<T>(what: string, fn: () => Promise<T>, onLimit?: () => void | Promise<void>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const limit = limitWait(e);
      if (!limit) throw e;
      await onLimit?.();
      console.log(`  ⏸ ${what} 撞上用量限额，${limit.why}等到 ${new Date(limit.until).toLocaleString()} 再接着跑`);
      await sleepUntil(limit.until);
    }
  }
}

/** 错误是用量限额时，该等到什么时候（含余量）；不是限额返回 null。 */
function limitWait(e: unknown): { until: number; why: string } | null {
  // AllProfilesLimited 的 until 已经含了余量。
  if (e instanceof AllProfilesLimited) return { until: e.until, why: "" };
  const message = String(e);
  if (!CLAUDE_LIMIT_PATTERN.test(message)) return null;
  const resetAt = limitResetAt(message);
  return resetAt === null
    ? { until: Date.now() + LIMIT_FALLBACK_WAIT_MS, why: `认不出重置时间（${message.slice(0, 200)}），` }
    : { until: resetAt + LIMIT_RESUME_SLACK_MS, why: "" };
}

/** 分支上已有提交时推到远端，免得只留在宿主机上。 */
async function pushIfAhead(issue: Issue) {
  const ahead = trySh("git", ["rev-list", "--count", `${BASE_REF}..${issue.branch}`]);
  if (ahead.ok && Number(ahead.out) > 0) await pushBranch(issue);
}

/** issue 已关闭（人在运行中途合并了 PR、或手动关了票）。查不到时当作没关。 */
function issueClosed(id: string) {
  const r = attempt(() => forge.issueState(id));
  return r.ok && r.value === "closed";
}

/** Phase 3：一张票的落地。在宿主机上做，用宿主机的 git / 平台凭据，沙箱没有写仓库的权限。 */
/**
 * 要留给人审的分支如果和最新的 origin/main 有文本冲突（或项目配置的一致性检查没过），走 rebaseAndMerge 但不合并。
 * 返回附在 leaveForHuman 说明后面的一句话；不需要 rebase 时为空串。
 */
async function rebaseIfConflicting(issue: Issue, pr: string, host: HostGap): Promise<string> {
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
  const chainOk = trySh("sh", ["-c", integrityOk(issue.branch)]).ok;
  if (clean && chainOk) return "";
  console.log(`  ↻ #${issue.id} 和最新的 ${BASE_REF} 冲突，rebase 后再留给人审`);
  const r = await untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr, host, false));
  return r.ok
    ? `\n\n分支和最新的 ${BASE_REF} 冲突，已 rebase，只重跑了 typecheck（通过），没有重跑测试。`
    : `\n\n⚠️ 分支和最新的 ${BASE_REF} 冲突，自动 rebase 没成：${r.reason}`;
}

async function land(issue: Issue, outcome: PromiseSettledResult<Awaited<ReturnType<typeof build>>>, host: HostGap) {
  // 运行期间人已经合并了这张票的 PR 或关了票：不再 push、开 PR、打标签，本地分支留着备查。
  if (issueClosed(issue.id)) {
    console.log(`  ⏭ #${issue.id} 已被关闭（运行期间有人合并了 PR 或关了票），跳过落地`);
    return;
  }
  if (outcome.status === "rejected") {
    console.error(`  ✗ #${issue.id} 失败：${outcome.reason}`);
    markStuck(issue.id, `沙箱出错：${String(outcome.reason).slice(0, 500)}`);
    return;
  }
  const result = outcome.value;
  const peak = result.done
    ? peakContext(result.implement, ...result.runs)
    : peakContext(result.implement);
  const budgetNote = `上下文峰值约 ${Math.round(peak / 1000)}k / ${CONTEXT_BUDGET / 1000}k，implement 用了 ${result.implement.iterations.length} 次会话。`;
  if (!result.done) {
    // implementer 判断必须由人拍板：推上已有的提交，直接交给人，不退回 prep。
    if (result.implement.completionSignal === NEEDS_DECISION) {
      const pushed = (await pushBranch(issue)).ok;
      attempt(() => forge.addLabel(issue.id, LABEL.readyForHuman));
      markStuck(issue.id, `implementer 遇到必须由人拍板的设计决定（见上面 implementer 的评论）。${budgetNote}${pushed ? `已有的提交推到了分支 \`${issue.branch}\`。` : "提交没能推上去，留在宿主机的本地分支上。"}拍板后在票上回复，去掉 ${LABEL.stuck} 即可接着跑。`);
      console.log(`  ✋ #${issue.id} 要人拍板，打 ${LABEL.stuck}`);
      return;
    }
    const comments = forge.issueComments(issue.id).join("\n");
    if (comments.includes(REPREP_MARK)) {
      markStuck(
        issue.id,
        `重新准备过一次，${IMPLEMENT_MAX_ITERATIONS} 次会话内仍没有完成（见上面 implementer 的评论）。${budgetNote} 请人看一下票怎么拆。`,
      );
      return;
    }
    // 外部 PR 不退回 prep（prep 会按 sandcastle/issue-n 拆票）：推上已有的提交，交给人。
    if (isExternal(issue)) {
      const pushed = (await pushBranch(issue)).ok;
      markStuck(issue.id, `在外部 PR 的分支 \`${issue.branch}\` 上 ${IMPLEMENT_MAX_ITERATIONS} 次会话内没有改完（见上面 implementer 的评论）。${budgetNote}${pushed ? "已有的提交推到了这个分支。" : "提交没能推上去，留在宿主机的本地分支上。"}`);
      return;
    }
    // 第一次没做完：分支推上去免得部分提交只留在宿主机，提交列表写进评论给 prep 看，退回 prep 重新准备。
    const pushed = (await pushBranch(issue)).ok;
    const log = trySh("git", ["log", "--format=- %h %s", `${BASE_REF}..${issue.branch}`]);
    const commits = log.ok && log.out ? `\n\n分支 \`${issue.branch}\` 上已有的提交：\n\n${log.out}` : "\n\n分支上还没有提交。";
    forge.removeLabel(issue.id, LABEL.prepped);
    forge.commentIssue(
      issue.id,
      `${REPREP_MARK}\n${IMPLEMENT_MAX_ITERATIONS} 次会话内没有完成。${budgetNote} 下次调度时 prep 会按上面 implementer 的进度评论重新准备：指引不对就重写，票太大就把没完成的验收标准拆成子票。再没做完就打 ${LABEL.stuck}。${commits}${pushed ? "" : "\n\n（分支没能推到远端，下一轮会在本地的同名分支上接着做。）"}`,
    );
    console.log(`  ↺ #${issue.id} 没做完，退回 prep 重新准备`);
    return;
  }

  const overBudget = peak > CONTEXT_BUDGET ? "\n\n⚠️ 超过上下文预算，考虑把同类票切得更小。" : "";
  const flaky = result.gate.output.includes("GATE_FLAKY");
  const tierName = result.gate.tier === "selected" ? project.gate.selectedDescription : "完整测试";
  // 先 push 开 PR 才有 PR 号；开票放在后面，票号用评论补到 PR 上。
  const gateNote = !result.gate.ok
    ? `❌ 门槛失败：\n\n\`\`\`\n${result.gate.output}\n\`\`\``
    : flaky
      ? `typecheck 通过；⚠️ ${tierName}有偶发失败，失败的文件单独重跑通过（沙箱内）。已自动开票修（见 PR 评论）。\n\n\`\`\`\n${result.gate.output}\n\`\`\``
      : `typecheck 与${tierName}通过（沙箱内）。\n\n\`\`\`\n${result.gate.output.slice(-500)}\n\`\`\``;
  const browserSection = result.browser
    ? `${result.browser.result ?? "（implementer 没有写 RESULT.md）"}\n\n截图 ${result.browser.shots.length} 张，附在下面。`
    : undefined;
  const revisionNote = result.revisions.length
    ? `\n\n**reviewer 打回过 ${result.revisions.length} 次**（implementer 已按意见修改）：\n\n${result.revisions
        .map((items, n) => `<details><summary>第 ${n + 1} 次的意见</summary>\n\n${items}\n\n</details>`)
        .join("\n\n")}`
    : "";
  const notesProblems = checkAcceptanceNotes(result.notes);
  const pr = await pushAndOpenPr(
    issue,
    {
      acceptance: acceptanceSection(issue.branch, result.notes, { pageChanged: result.browser !== undefined, pagePrep: project.acceptancePrep }),
      rest: restSections({
        review: `${result.summary}${revisionNote}`,
        browser: browserSection,
        gate: gateNote,
        budget: `${budgetNote}${overBudget}`,
        usage: usageTable(result.usage),
      }),
    },
    result.browser?.shots ?? [],
  );
  reportDecisions(issue.id, pr);
  if (flaky && result.gate.ok) {
    const { tickets, deferred } = reportFlaky(issue, pr, result.gate.output);
    const notes = [
      ...(tickets.length ? [`门槛里的偶发失败已开票：${tickets.join("、")}`] : []),
      ...(deferred.length ? [`门槛里重跑才通过、报错只是超时或连接失败，7 天内第一次出现，只记进 .sandcastle/logs/flaky.json、不开票：${deferred.map((f) => `\`${f}\``).join("、")}`] : []),
    ];
    if (notes.length) forge.commentPr(pr, notes.join("\n\n"));
  }

  // 外部 PR 一律留给人合并：不 rebase、不合并，只报告 review 与门槛结果。
  if (isExternal(issue)) {
    await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
    const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
    leaveForHuman(
      issue,
      pr,
      `这是外部 PR，Sandcastle 只负责修改，合并由人决定。reviewer 结论：${result.verdict}；门槛${result.gate.ok ? "通过" : "没通过"}（见上面的评论）。` +
        (clean ? "" : `\n\n⚠️ 分支和最新的 ${BASE_REF} 有冲突，需要先把 ${BASE_BRANCH} 合进来。`),
    );
    console.log(`  ◐ #${issue.id} 外部 PR #${pr}，留给人合并`);
    return;
  }
  // 验收说明缺失或格式不对：正文里已经有警告，下面每条留给人的路径都把它附进原因（外部 PR 本来就不自动合并，不走这里）。
  const notesNote = notesProblems.length
    ? `\n\n验收说明缺失或格式不对：${notesProblems.join("；")}（见 PR 正文的「验收说明」一节）。`
    : "";
  if (result.verdict !== "merge") {
    // 开工后 main 上合进了改同一处的票：先 rebase 好再交给人，免得人审的是一个合不进去的 PR。
    const rebaseNote = result.gate.ok ? await rebaseIfConflicting(issue, pr, host) : "";
    leaveForHuman(
      issue,
      pr,
      (result.verdict === "revise"
        ? `reviewer 打回 ${REVISE_MAX} 次后仍有要改的问题（见最新的 Review）。`
        : "reviewer 认为需要人审（见 PR 正文的 Review）。") +
        rebaseNote +
        notesNote,
    );
    console.log(`  ◐ #${issue.id} 留 PR #${pr} 等人审`);
    return;
  }
  if (!result.gate.ok) {
    leaveForHuman(issue, pr, `typecheck 或完整测试没通过（见 PR 正文的 Gate）。${notesNote}`);
    console.log(`  ◐ #${issue.id} 门槛失败，留 PR #${pr}`);
    return;
  }
  // reviewer 给了 merge、门槛也过了，但验收说明不合格：照样不自动合并。
  if (notesProblems.length > 0) {
    leaveForHuman(issue, pr, notesNote.trimStart());
    console.log(`  ◐ #${issue.id} 验收说明${result.notes === undefined ? "缺失" : "格式不对"}，留 PR #${pr}`);
    return;
  }
  // 先合并的票可能让这张冲突：rebase 到最新的 origin/main（冲突交给 agent）、重跑门槛，再合并一次。
  // 一致性检查要先在宿主机上查：没有文本冲突时平台会照样合并，坏掉的状态就进了 main。
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const chainOk = trySh("sh", ["-c", integrityOk(issue.branch)]).ok;
  const merged = chainOk
    ? attempt(() => forge.mergePr(pr, project.mergeMethod))
    : { ok: false as const, out: `${integrityBroken()}。` };
  if (!merged.ok) {
    console.log(`  ↻ #${issue.id} 没能直接合并，rebase 到最新的 ${BASE_REF} 后重试`);
    const retry = await untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr, host));
    if (!retry.ok) {
      leaveForHuman(issue, pr, `合并失败：${merged.out.slice(0, 300)}\n\nrebase 后重试也没成：${retry.reason}`);
      console.log(`  ◐ #${issue.id} 合并失败，留 PR #${pr}`);
      return;
    }
  }
  await gitRemote(["push", REMOTE, "--delete", issue.branch]);
  trySh("git", ["branch", "-D", issue.branch]);
  console.log(`  ✓ #${issue.id} 已合并（PR #${pr}）`);
  noteMerged(result.gate.tier);
}

// ---------------------------------------------------------------------------
// main 上定期的兜底完整测试（2026-11-24）
// ---------------------------------------------------------------------------
// 按依赖选测试的票每合并 MAIN_CHECK_EVERY 张，对当时的 origin/main 跑一次完整测试（和票的门槛排同一个队）。
// 兜住依赖图漏选，和「两张票各自通过、合在一起才坏」。失败就开一张带 LABEL.mainBroken 的修复票（调度时排最前），
// 自动合并照常、不暂停。状态存在 MAIN_CHECK_FILE：重启后接着计数，失败票里列出上次通过以来进 main 的提交。
const MAIN_CHECK_EVERY = project.mainCheckEvery;
const MAIN_CHECK_FILE = ".sandcastle/logs/main-check.json";
const MAIN_CHECK_ID = "main"; // 测试资源后缀 _imain，和票的 _i<n> 不撞
type MainCheckState = { lastPass: string | null; selectedSince: number };
const readMainCheck = (): MainCheckState => {
  try {
    return JSON.parse(readFileSync(MAIN_CHECK_FILE, "utf8")) as MainCheckState;
  } catch {
    return { lastPass: null, selectedSince: 0 };
  }
};
const writeMainCheck = (s: MainCheckState) => writeFileSync(MAIN_CHECK_FILE, `${JSON.stringify(s)}\n`);
let mainCheckRunning = false;

/** 票合并后记一笔；按依赖选测试的票攒够 MAIN_CHECK_EVERY 张就在后台开跑兜底（不等它，不占宿主机锁）。 */
function noteMerged(tier: GateTier) {
  const s = readMainCheck();
  if (tier === "selected") s.selectedSince++;
  writeMainCheck(s);
  if (s.selectedSince < MAIN_CHECK_EVERY || mainCheckRunning) return;
  mainCheckRunning = true;
  void runMainFullCheck()
    .catch((e) => console.warn(`  ⚠ main 兜底完整测试没跑成：${e instanceof Error ? e.message : e}（下一张票合并后再试）`))
    .finally(() => (mainCheckRunning = false));
}

async function runMainFullCheck() {
  const sha = sh("git", ["rev-parse", BASE_REF]);
  const short = sha.slice(0, 8);
  const counted = readMainCheck().selectedSince;
  // 本地分支先指到这个提交：createSandbox 从本地分支建 worktree（本地没有才从 main 新建，那时的 main 可能又变了）。
  const branch = `sandcastle/main-check-${short}`;
  sh("git", ["branch", "-f", branch, sha]);
  console.log(`  🛡 main 兜底完整测试排队：${short}（上次通过以来合并了 ${counted} 张按依赖选测试的票）`);
  const env = testEnv(MAIN_CHECK_ID);
  let gate: ExecResult;
  const sandbox = await sandcastle.createSandbox({ branch, baseBranch: BASE_REF, sandbox: sandboxFor(env), hooks, copyToWorktree });
  try {
    gate = await runGate((c) => sandbox.exec(c), MAIN_CHECK_ID, { ...env, GATE_FULL: "1" });
  } finally {
    await sandbox.close();
    await dropTestResources(MAIN_CHECK_ID);
    // 跑完就扔：worktree 里测试留下的文件不要（close 没删掉时强删），再删本地分支
    trySh("git", ["worktree", "remove", "--force", sandbox.worktreePath]);
    trySh("git", ["branch", "-D", branch]);
  }
  // 跑的期间又合并进来的票留给下一次兜底。
  const now = readMainCheck();
  const rest = Math.max(0, now.selectedSince - counted);
  if (gate.exitCode === 0) {
    writeMainCheck({ lastPass: sha, selectedSince: rest });
    console.log(`  🛡 main 兜底完整测试通过：${short}${gate.stdout.includes("GATE_FLAKY") ? "（有偶发失败，重跑通过）" : ""}`);
    return;
  }
  writeMainCheck({ lastPass: now.lastPass, selectedSince: rest });
  const commits = now.lastPass
    ? trySh("git", ["log", "--oneline", `${now.lastPass}..${sha}`]).out
    : `（之前没有通过记录，下面是最近 20 个提交）\n${trySh("git", ["log", "--oneline", "-n", "20", sha]).out}`;
  const summary = `\`\`\`\n${gate.stdout.slice(-3000)}\n\`\`\``;
  const open = forge.listOpenIssues([LABEL.mainBroken]);
  if (open[0]) {
    forge.commentIssue(String(open[0].number), `main（${short}）上的兜底完整测试又失败了：\n\n${summary}`);
    console.log(`  🛡 main 兜底完整测试失败：${short}，已记在 #${open[0].number}`);
    return;
  }
  attempt(() => forge.ensureLabel(LABEL.mainBroken, "d73a4a", "main 上的兜底完整测试失败（Sandcastle 自动开票，调度时排最前）"));
  const id = forge.createIssue({
    title: `main 上的兜底完整测试失败（${short}）`,
    body: project.texts.mainBrokenIssueBody({ sha, summary, commits }),
    labels: [LABEL.mainBroken, LABEL.picked, LABEL.readyForAgent],
  });
  console.log(`  🛡 main 兜底完整测试失败：${short}，已开票 #${id}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * 宿主机上的 git 与平台标签操作串行做：调度（整理、prep、plan）和落地不交错，
 * 免得落地合并的同时清理删掉它的 worktree，或 prep 挂着的工作区被快进。build 在沙箱里跑，不占锁。
 */
let hostTail: Promise<void> = Promise.resolve();
/** 排队拿锁（先来先得），返回释放函数。 */
function acquireHost(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ready = hostTail;
  hostTail = ready.then(() => held);
  return ready.then(() => release);
}
/**
 * 持锁跑 fn。fn 拿到的 HostGap 能中途放开锁、之后再排队拿回：落地里的 rebase 补救要在沙箱里跑门槛（完整测试
 * 半小时以上，还可能排队），期间放开锁让调度照常开新票（2026-11-24 #1165 的 rebase 让空位白等了约 40 分钟）。
 */
async function withHost<T>(fn: (gap: HostGap) => Promise<T>): Promise<T> {
  let release: (() => void) | null = await acquireHost();
  const gap: HostGap = {
    release: () => {
      release?.();
      release = null;
    },
    reacquire: async () => {
      if (!release) release = await acquireHost();
    },
  };
  try {
    return await fn(gap);
  } finally {
    gap.release();
  }
}

/** 有票做完、让出空位时叫醒主循环；主循环没在等时记下来，下次等的时候立刻返回。 */
let notify: (() => void) | null = null;
let slotFreed = false;
function signalSlotFreed() {
  if (notify) notify();
  else slotFreed = true;
}
async function waitForSlotOrPoll(ms: number) {
  if (slotFreed) {
    slotFreed = false;
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      notify = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    notify = done;
  });
  slotFreed = false;
}

/** 正在 build 或落地的票。一张票从开工到落地完一直占着空位：落地里的 rebase 补救也要跑门槛（跑门槛时放开宿主机锁，调度照常开另一个空位）。 */
const running = new Map<string, Issue>();

/** 一张票独立跑完 build → 落地，做完就让出空位，不等同批的其他票。 */
function start(issue: Issue) {
  running.set(issue.id, issue);
  void (async () => {
    // 撞上限额的票等重置后在原分支上重跑，不打 stuck。
    const [outcome] = await Promise.allSettled([
      untilAfterLimit(`#${issue.id}`, () => retryTransient(`#${issue.id}`, () => build(issue)), () => pushIfAhead(issue)),
    ]);
    // 落地在宿主机上做：用宿主机的 git / 平台凭据，沙箱没有写仓库的权限。
    // 每张票单独兜底：一张票落地出错（网络、人在运行中途合并或删了分支等）不让整个运行崩掉。
    await withHost(async (host) => {
      try {
        await retryTransient(`落地 #${issue.id}`, () => land(issue, outcome!, host));
      } catch (e) {
        const reason = String((e as { stderr?: unknown }).stderr || e).trim().slice(0, 500);
        console.error(`  ✗ #${issue.id} 落地出错：${reason}`);
        // 打 stuck 不让下次再做；本地分支保留，人看过后去掉 stuck 即可接着跑。
        if (!issueClosed(issue.id)) attempt(() => forge.addLabel(issue.id, LABEL.stuck));
        if (!issueClosed(issue.id)) attempt(() => forge.commentIssue(issue.id, `Sandcastle 停下了：落地（push / 开 PR / 合并）出错，本地分支 \`${issue.branch}\` 保留。\n\n\`\`\`\n${reason}\n\`\`\`\n\n处理后去掉 ${LABEL.stuck} 再运行。`));
      }
    });
  })()
    .catch((e) => console.error(`  ✗ #${issue.id} 出错：${String(e).slice(0, 500)}`))
    .finally(() => {
      running.delete(issue.id);
      console.log(`  ⇢ #${issue.id} 让出空位（还有 ${running.size} 张在做）`);
      signalSlotFreed();
    });
}

/**
 * 本次运行里 prep 过、但没打上 prepped 也没拆的票，记下 prep 结束时 issue 的 updatedAt。
 * 轮询比原来按轮跑频繁得多，issue 没变就不再开 prep 会话；有人评论、改正文或改标签后再试。
 */
const prepTried = new Map<number, string>();

type ScheduleResult = { started: number; split: boolean; prepLimitedUntil?: number };

/** 一次调度：整理 → prep → plan，把空位补满。在 withHost 里跑。 */
async function schedule(): Promise<ScheduleResult> {
  reloadModels(); // 每次调度读一次 .sandcastle/models.json：改了配置不用重启，下次生效
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]); // 刚合并进远端 main 的代码
  openStates.clear();
  syncHostBase();
  reopenRequestedRevisions();
  closeFinishedParents();
  await cleanupClosedIssues();
  try {
    project.beforeSchedule();
  } catch (e) {
    console.warn(`  ⚠ 调度前的维护出错：${String(e).slice(0, 300)}`);
  }

  // Prep —— 串行，因为拆票会改别的票的 Blocked by。
  // 每次重新查询，所以上次拆出来的子票（继承了 Sandcastle 标签）这里会被看到。
  // 有 open blocker 的票脚本直接跳过，不开会话（prep agent 遇到这种票也只会什么都不改就结束）；
  // 跳过的票仍留在 toPrep 里，下面判断「这次拆出了新子票」时不会把它当成新票。
  // 撞上用量限额不在这里等（会占着宿主机锁，做完的票落不了地）：停止这次 prep，交给主循环决定等多久。
  // 按编号从小到大：和 plan 的顺序一致，早建的票（通常是后面票的 blocker）先 prep、先开工。
  const toPrep = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
    .filter((issue) => allowed(issue.number))
    .sort(byUrgency);
  let prepLimitedUntil: number | undefined;
  const slots = MAX_PARALLEL - running.size;
  for (const issue of toPrep) {
    // 已有够填满空位的可开工票就先开工，剩下的票等下次调度（有票做完或轮询）再 prep。
    // 否则一下子建了二十多张票时，要把它们逐张 prep 完（每张几分钟）才开工，空位空等一两个小时（2026-11-23）。
    if (slots > 0 && plan(new Set(running.keys()), slots, true).length >= slots) {
      console.log(`  已有 ${slots} 张可开工的票，先开工；其余票下次调度再 prep`);
      break;
    }
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      console.log(`  跳过 prep #${issue.number}：blocker ${open.map((n) => `#${n}`).join("、")} 还没关`);
      continue;
    }
    if (prepTried.get(issue.number) === issue.updatedAt) continue;
    console.log(`Prep #${issue.number}: ${issue.title}`);
    try {
      await runAgent("prep", String(issue.number), `prep-${issue.number}`, {}, [], (agent) => sandcastle.run({
        sandbox: project.sandbox({}),
        name: `prep-${issue.number}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        promptFile: "./.sandcastle/prep-prompt.md",
        promptArgs: {
          TASK_ID: issue.number, LABEL_PICKED: LABEL.picked, LABEL_PREPPED: LABEL.prepped, LABEL_STUCK: LABEL.stuck,
          REPREP_MARK,
        },
      }));
    } catch (e) {
      const limit = limitWait(e);
      if (limit) {
        console.log(`  ⏸ prep #${issue.number} 撞上用量限额，${limit.why}${new Date(limit.until).toLocaleString()} 前不再 prep`);
        prepLimitedUntil = limit.until;
        break;
      }
      console.error(`  ✗ prep #${issue.number} 出错：${String(e).slice(0, 500)}`);
    }
    const after = attempt(() => forge.issueUpdatedAt(String(issue.number)));
    if (after.ok) prepTried.set(issue.number, after.value);
  }

  // Plan
  const issues = plan(new Set(running.keys()), MAX_PARALLEL - running.size);
  if (issues.length === 0) {
    // 这次 prep 拆出的子票还没 prep 过（下次才看到），这时不能当作没活可做。
    // 只认这次新出现的票：留在 toPrep 里的票（如等 blocker）下次仍不会有新票。
    const prepped = new Set(toPrep.map((issue) => issue.number));
    const split = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
      .filter((issue) => allowed(issue.number) && !prepped.has(issue.number));
    if (split.length > 0) console.log(`拆出了子票 ${split.map((issue) => `#${issue.number}`).join("、")}，马上 prep。`);
    return { started: 0, split: split.length > 0 && prepLimitedUntil === undefined, prepLimitedUntil };
  }
  for (const issue of issues) {
    console.log(`  开工 #${issue.id}: ${issue.title} → ${issue.branch}`);
    start(issue);
  }
  return { started: issues.length, split: false, prepLimitedUntil };
}

// 有空位就调度一次；然后等「有票做完」或「过了 POLL_INTERVAL_MS」，先到哪个算哪个。
// 等人审的 PR 合入、blocker 关闭、人去掉 stuck 之后，下一次轮询就能开工，不用等正在做的票做完。
// 没有票在做、也开不出新票时算一次空转；连续 MAX_ITERATIONS 次空转就结束运行。
let idlePolls = 0;
for (let pass = 1; ; pass++) {
  if (running.size < MAX_PARALLEL) {
    console.log(`\n=== 调度 ${pass}（${new Date().toLocaleString()}，${running.size}/${MAX_PARALLEL} 个空位已占）===\n`);
    const r = await withHost(schedule);
    if (r.split) continue;
    if (running.size > 0 || r.started > 0) {
      idlePolls = 0;
    } else if (r.prepLimitedUntil !== undefined) {
      // 没票在做、prep 在等限额：等到重置再来，不算空转。
      console.log(`没有票在做，等 prep 的用量限额到 ${new Date(r.prepLimitedUntil).toLocaleString()} 重置`);
      await sleepUntil(r.prepLimitedUntil);
      continue;
    } else {
      idlePolls++;
      if (idlePolls >= MAX_ITERATIONS) {
        console.log(`没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），连续空转 ${idlePolls} 次，结束运行。`);
        break;
      }
      console.log(`没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），${POLL_INTERVAL_MS / 60_000} 分钟后再查（空转 ${idlePolls}/${MAX_ITERATIONS}）。`);
    }
  }
  await waitForSlotOrPoll(POLL_INTERVAL_MS);
}

// 最后合并的票在上次 fetch 之后才进远端，收尾再同步一次。
await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
syncHostBase();
console.log(`\nAll done. 本地 main 已快进到 ${BASE_REF}（不在 main 上时除外，见上面的警告）；带 ${LABEL.prOpen} 的票在 ${forge.name} 上等你审。`);
