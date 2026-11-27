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
//                    `Sandcastle`，父票去掉）；要人拍板 → 打 sandcastle:stuck（能代拍板的按提示词的「设计决定」自己定）。
//   Phase 1 (Plan):  脚本自己算（不用 agent）：只看 `Sandcastle` + `sandcastle:prepped`、且没有
//                    pr-open / stuck 的票，排除仍有未关闭 blocker 的票；剩下的按编号从小到大，
//                    和已选的票或等人审（pr-open）的票改同一个文件（指引的 Change 行）就跳过。
//   Phase 2 (Build): 每张票一个沙箱，从 origin/main 建分支：implementer（每次迭代
//                    都是全新的 Claude 会话）→ reviewer（给出 merge / revise / pr 结论；revise
//                    时把修改意见交给新的 implementer 会话改完再审，最多 REVISE_MAX 次）→
//                    门槛（脚本自己跑 typecheck + 完整测试，失败时让 implementer 修一次）。
//                    最多 MAX_PARALLEL 张并行，每个沙箱用独立的测试库与前缀。
//   Phase 3 (Land):  在宿主机上 push、开 PR（`Closes #n`）。reviewer 说 merge 且门槛通过
//                    → `gh pr merge --rebase`，issue 自动关闭；否则（或配置 autoMerge: false）打 sandcastle:pr-open 等人审。
//                    合并不了（先合并的票造成冲突，或项目配置的一致性检查没过，如迁移链分叉）时，rebase 到
//                    最新的 origin/main（冲突与迁移交给 agent，prompts/rebase.md），重跑门槛后再合并一次。
//   每次调度开头：等人审的 PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，
//                    或别人点的 Request changes）→ 去掉 issue 的 sandcastle:pr-open，这张票这次
//                    重新进入 plan，implementer 先读 PR 上的意见。
//   外部 PR：别人开的、`Closes` 了 Sandcastle 票的 PR（分支不是 `sandcastle/` 开头），打回后在它的分支上
//                    接着改：只做普通 push，不 rebase、不合并、不删分支，结果评论在 PR 上留给人合并。
//
// 每个阶段用哪个模型（Claude 订阅或别家的 Anthropic 兼容接口）、撞限额时换哪个：.sandcastle/models.json（models.ts）。
// 标签状态机见 docs/config.md 的「标签」；完整的设计说明见 docs/internal/sandcastle.md。
//
// 随项目变的部分（托管平台、测试隔离、门槛、合并前检查、自动开票的文案）都在目标项目的
// .sandcastle/sandcastle.config.ts（profile.ts 的 ProjectProfile）；托管平台的操作都走 Forge（forge.ts）。
//
// Usage（在目标项目根目录）: npx tsx <本仓库>/src/main.ts
//        SANDCASTLE_ONLY=328,329 npx tsx <本仓库>/src/main.ts   只处理这几张票（试跑、单独补跑）
//        SANDCASTLE_BASELINE=1 …（即 sandpipe baseline）   对 origin/main 跑一次完整门槛就退出
//
// Sandcastle: prep → plan → implement + review → gate → merge (PRs that can't merge are left open)
// Scheduling (no rounds): at most MAX_PARALLEL slots. When a slot is free, run one "tidy → prep → plan" pass to fill the slots; each ticket
// runs build → land on its own and frees its slot as soon as it's done, triggering the next pass. With free slots but nothing startable, poll every POLL_INTERVAL_MS
// (a merged PR, a closed blocker or a removed stuck label can start work at the next poll); a pass with nothing running and nothing startable is an idle poll,
// and MAX_ITERATIONS idle polls in a row end the run. git / label operations on the host (scheduling and landing) are serialized; builds run in parallel in sandboxes.
// Each pass and each ticket:
//   Phase 0 (Prep):  a human adding the `Sandcastle` label "picks" an issue. Picked tickets without
//                    `sandcastle:prepped` run prep-ticket one at a time (tickets whose `## Blocked by` still has
//                    open tickets are skipped without a session):
//                    small enough with a fresh guide → prepped; too big → split into children (children inherit
//                    `Sandcastle`, the parent loses it); needs a human decision → sandcastle:stuck (decisions the agent may make follow the prompt's "design decisions").
//   Phase 1 (Plan):  computed by the script (no agent): only tickets with `Sandcastle` + `sandcastle:prepped` and without
//                    pr-open / stuck, minus those with open blockers; the rest in ascending number order,
//                    skipping any that change a file (guide Change lines) also changed by an already-picked or pr-open ticket.
//   Phase 2 (Build): one sandbox per ticket, branched from origin/main: implementer (each iteration
//                    is a fresh Claude session) → reviewer (verdict merge / revise / pr; on revise
//                    the requested changes go to a new implementer session and are reviewed again, at most REVISE_MAX times) →
//                    gate (the script runs typecheck + the full suite itself; on failure the implementer gets one fix).
//                    At most MAX_PARALLEL in parallel, each sandbox with its own test databases and prefixes.
//   Phase 3 (Land):  on the host, push and open a PR (`Closes #n`). Reviewer says merge and the gate passes
//                    → `gh pr merge --rebase`, closing the issue; otherwise (or with autoMerge: false) label sandcastle:pr-open for review.
//                    When it can't merge (a conflict from an earlier merge, or the project's integrity check fails, e.g. a forked migration chain), rebase onto
//                    the latest origin/main (conflicts and migrations go to the agent, prompts/rebase.md), rerun the gate and merge again.
//   Start of each pass: a send-back signal on a PR under review newer than the branch's latest commit (a comment or review starting with `/sandcastle`,
//                    or someone else's Request changes) → remove the issue's sandcastle:pr-open; the ticket
//                    re-enters plan and the implementer reads the PR feedback first.
//   External PRs: PRs opened by others that `Closes` a Sandcastle ticket (branch not starting with `sandcastle/`) are continued on their branch after a send-back:
//                    plain pushes only, no rebase, no merge, no branch deletion; results are commented on the PR for a human to merge.
// Which model each phase uses (Claude subscription or another vendor's Anthropic-compatible API) and which to switch to on limits: .sandcastle/models.json (models.ts).
// Label state machine: "Labels" in docs/config.md; the full design notes are in docs/internal/sandcastle.md.
// Project-specific parts (forge, test isolation, gate, pre-merge checks, auto-ticket texts) live in the target project's
// .sandcastle/sandcastle.config.ts (ProjectProfile in profile.ts); all forge operations go through Forge (forge.ts).
// Usage (in the target project's root): npx tsx <this repo>/src/main.ts
//        SANDCASTLE_ONLY=328,329 npx tsx <this repo>/src/main.ts   only these tickets (trial runs, reruns)
//        SANDCASTLE_BASELINE=1 … (i.e. sandpipe baseline)   run the full gate once against origin/main and exit

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import type { SandboxExecOptions } from "@ai-hero/sandcastle";
import {
  CLAUDE_CREDENTIALS_CLEARED, agentFor, readUsage, recordUsage, reloadModels, runWithProfile, sessionPeak, usageTable,
  type AgentRun, type AllProfilesLimited, type Phase, type UsageRecord,
} from "./models.ts";
import { limitWait, sleepUntil, untilAfterLimit } from "./limit-wait.ts";
import { blockersOf, changedFiles, type FlakySighting, flakyTickets, flakyTriage, idleSummary, splitChildren } from "./guide.ts";
import { acceptanceSection, browserSection, checkAcceptanceNotes, pageChangedByReview, replaceSection, restSections } from "./pr-body.ts";
import type { ForgeIssue, ForgePr, IssueState } from "./forge.ts";
import { type MergeFlowDeps, mergeAfterPush, mergeWhenReady } from "./merge-flow.ts";
import { loadProject } from "./profile.ts";
import {
  acquireRunLock, errorLine, exitWhenDone, GATE_ENV_PREFIX, GateEnvError, gateEnvError, gateEnvReason, GATE_INFRA_PREFIX, GateInfraError, imageExists, isAgentIdleTimeout, isGateInfraFailure, logErrorDetail, missingImage, onInterrupt,
  podmanProblem, removeOrphanContainers, RUN_LOCK_FILE, runLockPath, waitForPodman,
} from "./lifecycle.ts";
import { messages } from "./i18n.ts";
import { parseReviewed, type ReviewedState, resumeDecision, reviewedComment } from "./resume-state.ts";
import { fixDiffCmd, needsReReview, type ReReview, rebaseDiffCmd, rebaseNeedsReReview, reReviewVerdict, tagged } from "./re-review.ts";
import { duration, flakyTicketsLine, gateDoneLine, gateEnv, gateEnvLine, gateInfraLine, startGateProgress } from "./gate-progress.ts";
import { createGateQueue, type GatePriority } from "./gate-queue.ts";
import { setTermLanguage, t, termLanguage } from "./term.ts";
import { loadProjectDoc, projectDocPath, projectDocWatcher, renderPrompts } from "./project-doc.ts";
import { type BrowserCheck, browserSetupWarning, browserVerdict, pageFiles, ticketHasBrowserCheck } from "./browser-gate.ts";
import { detectProject } from "./detect.ts";
import { probeTcp, servicesProblem } from "./preflight.ts";
import { manual } from "./onboard.ts";
import { attempt, envPrefix, gitRemote, gitRemoteOrThrow, REMOTE_TRANSIENT, sh, shellQuote, trySh } from "./shell.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const project = await loadProject();
/** 写到平台上的文字（PR、评论、自动开的票）按项目语言。 / Text written to the forge (PRs, comments, auto-opened tickets) follows the project's language. */
const M = messages(project.language);
// 终端输出也跟项目语言（设了 SANDPIPE_LANG 时以它为准） / Terminal output follows the project's language too (SANDPIPE_LANG wins when set)
setTermLanguage(project.language);
const forge = project.forge;

// agent 多久没输出算卡死：库默认 600 秒，太短（门槛失败后的 fix 会话要在后台重跑慢测试，等通知期间没有输出）。
// How long without agent output counts as stuck: the library default of 600 seconds is too short (fix sessions after a failed gate rerun slow tests in the background with no output while waiting).
const AGENT_IDLE_TIMEOUT_S = project.agentIdleTimeoutS;
const POLL_INTERVAL_MS = project.pollIntervalMs; // 有空位时隔多久重新调度一次（整理 → prep → plan），看有没有新开得了工的票 / how often to reschedule when a slot is free (tidy → prep → plan), looking for newly startable tickets
const MAX_ITERATIONS = project.maxIdlePolls; // 连续空转（没有票在做、也开不出新票）多少次就结束运行 / how many idle polls in a row (nothing running, nothing startable) end the run
const MAX_PARALLEL = project.maxParallel; // 同时实现的票数：受测试依赖的服务与机器负载限制；门槛另外排队、同一时间只跑一个（runGate） / tickets implemented at once: limited by test services and machine load; gates queue separately, one at a time (runGate)
const IMPLEMENT_MAX_ITERATIONS = project.implementMaxSessions; // 一张票最多开几次全新会话；超过说明票太大，交给人 / maximum fresh sessions per ticket; beyond that the ticket is too big and goes to a human
/**
 * 第一次没做完时脚本留在 issue 上的标记；prep 看到它就按「实现没做完」重新准备，再没做完才打 stuck。
 * Marker the script leaves on the issue when the first attempt didn't finish; prep re-prepares it as "implementation unfinished", and only another failure means stuck.
 */
const REPREP_MARK = "<!-- sandcastle:reprep -->";
/**
 * implementer 的两个完成信号：做完了；遇到必须由人拍板的设计决定（提示词的「设计决定」），票直接交给人，不再开新会话。
 * The implementer's two completion signals: done; or hit a design decision a human must make (the prompt's "design decisions"), handing the ticket to a human without more sessions.
 */
const COMPLETE = "<promise>COMPLETE</promise>";
const NEEDS_DECISION = "<promise>NEEDS_DECISION</promise>";
/**
 * agent 代拍板时 issue 评论的第一行（提示词的「设计决定」）；落地时脚本据此打 sandcastle:decided 并把评论贴到 PR 上。
 * First line of the issue comment when the agent decides on a human's behalf (the prompt's "design decisions"); on landing the script labels sandcastle:decided and copies the comments to the PR.
 */
const DECIDED_MARK = "<!-- sandcastle:decided -->";
/**
 * 全部档案撞限额进入等待时票上评论的标记（#48）；最后一条评论已经是它就不再发（重启后不重复）。
 * Marker on the issue comment posted when every profile hit its limit and the ticket starts waiting (#48); not posted again while it's the last comment (no repeats after a restart).
 */
const LIMITED_MARK = "<!-- sandcastle:limited -->";
const REVISE_MAX = project.reviseMax; // reviewer 给 revise 时最多打回几次；之后仍不行就留 PR 给人 / maximum send-backs when the reviewer says revise; after that the PR is left for a human
const CONTEXT_BUDGET = project.contextBudget; // 单个会话的上下文预算 / context budget per session
const REMOTE = project.remote;
const BASE_BRANCH = project.baseBranch;
// 从远端 main 建分支：已合并的代码在远端，不动宿主机本地 main 的工作区。
// Branch from the remote main: merged code is on the remote, and the host's local main worktree isn't touched.
const BASE_REF = `${REMOTE}/${BASE_BRANCH}`;
// 只处理这几张票（逗号分隔）；不设则处理全部带 Sandcastle 标签的票。拆出来的子票不在名单里，要另外加。
// Only these tickets (comma separated); when unset, all tickets labelled Sandcastle. Split-off children aren't in the list and must be added separately.
const ONLY = new Set((process.env.SANDCASTLE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const allowed = (id: string | number) => ONLY.size === 0 || ONLY.has(String(id).replace(/^#/, ""));

const LABEL = project.labels;
// 提示词：通用模板 + .sandcastle/PROJECT.md 的章节 + 平台命令，启动时渲染一次（改了 PROJECT.md 要重启才生效，主循环每轮检查、变了警告一次，#52）
// Prompts: generic templates + .sandcastle/PROJECT.md sections + forge commands, rendered once at startup (restart after changing PROJECT.md; the main loop checks every pass and warns once per change, #52)
const DOC = loadProjectDoc();
const projectDocChanged = projectDocWatcher(() => readFileSync(projectDocPath(), "utf8"));
const PROMPTS = renderPrompts({ doc: DOC, forgeGuide: forge.agentGuide(), labels: LABEL, language: project.language });
const APPEND_ONLY: ReadonlySet<string> = new Set(project.appendOnlyFiles);

/**
 * 调度顺序：main 坏了的修复票排最前，其余按编号从小到大（早建的票通常是后面票的 blocker）。
 * Scheduling order: main-broken fix tickets first, the rest by ascending number (older tickets usually block later ones).
 */
const byUrgency = (a: { number: number; labels: string[] }, b: { number: number; labels: string[] }) => {
  const urgent = (i: typeof a) => (i.labels.includes(LABEL.mainBroken) ? 0 : 1);
  return urgent(a) - urgent(b) || a.number - b.number;
};

// 同一会话超过预算前自动压缩；预算本身靠 prep 把票切小来保证。
// A session compacts automatically before exceeding the budget; the budget itself is upheld by prep cutting tickets small.
const claudeEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CONTEXT_BUDGET) };

/**
 * 跑一次 agent 会话：阶段用哪个档案（模型、厂商）由 .sandcastle/models.json 决定，撞限额换下一个（models.ts）。
 * 用量追加到 .sandcastle/logs/usage.jsonl，也放进 usage（撞限额换档案的那次也记一条 limited）；build 收集的会进 PR 的用量表，prep 的落地时从 usage.jsonl 读回，rebase 的不进表（rebase 之后的复审没通过时，它的用量表附在留 PR 的评论里，#71）。
 * Run one agent session: which profile (model, vendor) a phase uses comes from .sandcastle/models.json, switching to the next on limits (models.ts).
 * Usage is appended to .sandcastle/logs/usage.jsonl and also pushed onto usage (a session that hit a limit and switched profiles gets a limited record too); build's collected records go into the PR's usage table, prep's are read back from usage.jsonl on landing, rebase's stay out of the table (when the re-review after a rebase fails, its usage table is attached to the comment leaving the PR, #71).
 */
async function runAgent<T extends AgentRun>(
  phase: Phase,
  issue: string,
  name: string,
  env: Record<string, string>,
  usage: UsageRecord[],
  fn: (agent: sandcastle.AgentProvider) => Promise<T>,
): Promise<T> {
  const { run, profile } = await runWithProfile(
    phase,
    name,
    (p) => fn(agentFor(p, { ...claudeEnv, ...env }, phase)),
    (p, r) => usage.push(recordUsage(issue, phase, r, name, p, true)),
  );
  usage.push(recordUsage(issue, phase, run, name, profile));
  return run;
}

// ---------------------------------------------------------------------------
// 每张票的测试环境：项目配置的 isolation（独立的测试库、前缀……），关沙箱后回收。
// Each ticket's test environment: the project's isolation (separate test databases, prefixes…), reclaimed after the sandbox closes.
// ---------------------------------------------------------------------------

const testEnv = (runId: string) => project.isolation.env(runId);
async function dropTestResources(runId: string) {
  try {
    await project.isolation.cleanup?.(runId);
  } catch (e) {
    console.warn(t(`  ⚠ #${runId} 测试资源回收出错：`, `  ⚠ #${runId} test resource cleanup failed: `) + String(e).slice(0, 500));
  }
}

// 浏览器验收的产物：implementer 写在 worktree 的 .browser-check/（.gitignore 忽略），
// 关沙箱前拷到宿主机，开 PR 时把截图用 `gh --attach` 附上、RESULT.md 写进正文。
// Browser check output: the implementer writes it to .browser-check/ in the worktree (ignored by .gitignore);
// it's copied to the host before the sandbox closes, and when opening the PR screenshots are attached with `gh --attach` and RESULT.md goes into the body.
const BROWSER_DIR = ".browser-check";
const SHOTS_ROOT = join(tmpdir(), "sandcastle-browser-check");

function collectBrowserCheck(worktreePath: string, issueId: string): BrowserCheck | undefined {
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
// Merge gate: the script runs it itself rather than trusting the agent's word. Script and output conventions: the project's gate (GateConfig in profile.ts).
// The output has a line GATE_TIER: full|selected, which the script counts and writes into the PR; GATE_FLAKY appears when a rerun was needed to pass.
const GATE_RERUN_MAX = project.gate.rerunMax;
type GateTier = "selected" | "full";
const gateTier = (stdout: string): GateTier => (stdout.includes("GATE_TIER: selected") ? "selected" : "full");
const gateTierName = (tier: GateTier) => (tier === "selected" ? t("按依赖选", "dependency-selected") : t("完整", "full"));
const GATE_SCRIPT = project.gate.script({ baseRef: BASE_REF });

// 门槛同一时间只跑一个（不分档位）：并行跑时 CPU 与测试依赖的服务都被挤满，反而比先后跑更慢、更容易超时。
// 门槛独占时可以给更多资源（项目配置 gate.env，比如更多 worker）。
// Only one gate runs at a time (regardless of tier): in parallel, CPU and the test services saturate, making them slower and more timeout-prone than running in sequence.
// With the gate to itself it can be given more resources (project config gate.env, e.g. more workers).
// 票优先，兜底让位：有票在等门槛时 main 兜底完整测试不开跑（已开跑的不中断），同档内先来先得（src/gate-queue.ts）。
// Tickets first, the fallback yields: the main fallback full run doesn't start while a ticket waits for the gate (one already running is not interrupted); first come first served within a tier (src/gate-queue.ts).
const gateQueue = createGateQueue({
  onYield: (n) =>
    console.log(
      t(`  ⏳ main 兜底完整测试让位：${n} 张票在等门槛，先跑票的`, `  ⏳ The fallback full run on main yields: ${n} ticket(s) waiting for the gate run first`),
    ),
});
type ExecResult = { stdout: string; stderr?: string; exitCode: number };

const GATE_LOG_DIR = ".sandcastle/logs";
/** 报错的完整内容（含堆栈）：终端和 issue 评论只写一行，全文追加到这里。 / Full errors (with stacks): the terminal and issue comments get one line, the full text is appended here. */
const ERROR_LOG = ".sandcastle/logs/errors.log";

/**
 * 跑一次门槛：所有门槛排同一个队，票（prio "ticket"）优先于 main 兜底（"fallback"）；用时（和排队时间）打进日志，并追加在输出末尾一行 GATE_TIME（进 PR 的 Gate 一节）。
 * 运行中输出实时写进 .sandcastle/logs/gate-*.log，定时打印心跳（gate-progress.ts 的 HEARTBEAT_MS）。
 * Run the gate once: all gates share one queue, tickets (prio "ticket") ahead of the main fallback ("fallback"); the time taken (and time queued) is logged and appended as a GATE_TIME line at the end of the output (goes into the PR's Gate section).
 * While running, output is written live to .sandcastle/logs/gate-*.log and a heartbeat is printed periodically (HEARTBEAT_MS in gate-progress.ts).
 */
async function runGate<R extends ExecResult>(
  exec: (command: string, opts?: SandboxExecOptions) => Promise<R>,
  issueId: string,
  env: Record<string, string>,
  prio: GatePriority = "ticket",
): Promise<R> {
  const queued = Date.now();
  const go = async () => {
    const waited = Date.now() - queued;
    if (waited > 5_000) console.log(t(`  ⏳ #${issueId} 排队 ${duration(waited)}后开始跑门槛`, `  ⏳ #${issueId} starting the gate after queueing ${duration(waited)}`));
    const started = Date.now();
    // stderr 并进 stdout：命令找不到、typecheck 报错这类原因多半写在 stderr，不并进来 baseline 和 PR 里只看到「失败」。
    // Merge stderr into stdout: causes like a missing command or typecheck errors usually go to stderr; without this, baseline and the PR only show "failed".
    const progress = startGateProgress({ issueId, logDir: GATE_LOG_DIR });
    let r: R;
    try {
      r = await exec(`${envPrefix(gateEnv(env, project.gate.env))} sh -c ${shellQuote(GATE_SCRIPT)} 2>&1`, { onLine: progress.onLine });
    } finally {
      progress.stop();
    }
    // 传了 onLine 后沙箱返回的 stdout 可能只剩末尾一段（podman 只留 64KB），开头的 GATE_TIER 会丢：换成自己累积的完整输出。
    // With onLine passed, the sandbox's stdout may be only a tail (podman keeps 64KB), losing GATE_TIER at the top: use the full output accumulated here instead.
    // provider 没回调 onLine 时（第三方 provider 可能没实现）退回它返回的 stdout。
    // If the provider never called onLine (a third-party provider may not implement it), fall back to the stdout it returned.
    // 兜底的 stdout 也去掉 ANSI 转义码，和 output() 一样是纯文本。 / Strip ANSI escape codes from the fallback stdout too, so it is plain text like output().
    // 门槛进程是被基础设施杀掉的（podman 断连、退出码 125 / 255、podman 断时的 137）：报「没跑成」，抛给 retryTransient 整步重跑，不打「失败」、不进 fix 会话。
    // podman 的连接错误在 r.stderr 里（门槛命令的 2>&1 在容器内）。排队的票断连时 exec 立刻失败，同样走这里。
    // If infrastructure killed the gate (podman disconnected, exit code 125 / 255, 137 while podman is down): report "didn't run" and throw to retryTransient to rerun the whole step; no "failed", no fix session.
    // podman's connection errors are in r.stderr (the gate command's 2>&1 runs inside the container). A queued ticket whose exec fails at once during a disconnect lands here too.
    const infra = isGateInfraFailure(r.exitCode, r.stderr ?? "");
    if (infra !== null) {
      console.warn(gateInfraLine(issueId, infra));
      throw new GateInfraError(infra);
    }
    const stdout = progress.output() || stripVTControlCharacters(r.stdout);
    // 门槛依赖的服务连不上（数据库 ECONNREFUSED、DNS 失败等，#54）：同样报「没跑成」，抛给 retryTransient，不进 fix 会话。
    // A service the gate depends on is unreachable (database ECONNREFUSED, DNS failure, etc., #54): likewise "didn't run", thrown to retryTransient, no fix session.
    const envLine = gateEnvError(r.exitCode, stdout, project.gate.envErrorPattern);
    if (envLine !== null) {
      console.warn(gateEnvLine(issueId, envLine));
      throw new GateEnvError(envLine);
    }
    const tier = gateTierName(gateTier(stdout));
    const took = duration(Date.now() - started);
    const before = waited > 5_000 ? t(`（之前排队 ${duration(waited)}）`, ` (queued ${duration(waited)} before)`) : "";
    const line = t(`${tier}门槛用时 ${took}${before}`, `${tier} gate took ${took}${before}`);
    console.log(gateDoneLine(issueId, line, r.exitCode === 0, stdout.includes("GATE_FLAKY")));
    return { ...r, stdout: `${stdout}\nGATE_TIME: ${line}` };
  };
  return gateQueue.run(go, prio);
}

// 沙箱建好后装依赖（项目配置 install）：拷进来的 node_modules 等是宿主机的，可能缺容器平台的原生包。
// Install dependencies once the sandbox is ready (project config install): copied node_modules etc. come from the host and may lack the container platform's native packages.
const hooks = {
  sandbox: { onSandboxReady: [{ command: project.install.onSandboxReady }] },
};
const copyToWorktree = project.install.copyToWorktree;

// createSandbox 里的 sandbox.run 不使用 agent provider 的 env，只有容器启动时 podman({env}) 的 env
// 才进得了 agent 的 shell，所以测试库连接与上下文预算都在这里注入。
// Claude 凭据在这里清空（覆盖 sandcastle 从 .sandcastle/.env 读到的值）：容器级 env 对同一个容器里的所有会话都可见，
// 别家档案的会话不能有；Claude 档案的会话由 agentFor 从 stdin 按会话送进去（models.ts）。
// Claude credentials are cleared here (overriding what sandcastle reads from .sandcastle/.env): the container-level env is visible to every session
// in that container and other vendors' sessions must not have them; agentFor hands them to Claude profiles' sessions over stdin, per session (models.ts).
const sandboxFor = (env: Record<string, string>) => project.sandbox({ ...claudeEnv, ...env, ...CLAUDE_CREDENTIALS_CLEARED });

// ---------------------------------------------------------------------------
// Host helpers
// ---------------------------------------------------------------------------

// sh / trySh / gitRemote 在 shell.ts。 / sh / trySh / gitRemote are in shell.ts.

// 沙箱和落地里的临时错误（2026-11-07 机器睡眠醒来后：复制 node_modules 到工作区超过 60 秒、
// GitHub API 读超时）不直接打 stuck：等一会儿整步重跑。build 在原分支上重跑，implementer 会接着已有提交做；
// land 开头会查 issue 是否已关、PR 是否已开，重跑最多多出一条评论。
// Transient errors in sandboxes and landing (on 2026-11-07, after the machine woke from sleep: copying node_modules into the worktree took over 60 seconds,
// GitHub API read timeouts) don't mark the ticket stuck right away: wait, then rerun the whole step. build reruns on the same branch, and the implementer continues from existing commits;
// land first checks whether the issue is closed or a PR already exists, so a rerun adds at most one extra comment.
// podman 连接短暂断开（2026-11-26：ssh: handshake failed … connection reset by peer）也算：门槛没跑成、podman create 报镜像不在（其实只是连不上）、podman rm 失败。
// A brief podman disconnect counts too (2026-11-26: ssh: handshake failed … connection reset by peer): the gate didn't run, podman create reporting a missing image (really just unreachable), podman rm failing.
const PODMAN_TRANSIENT = new RegExp(
  [GATE_INFRA_PREFIX, "Cannot connect to Podman", "ssh: handshake failed", "Image '.*' not found locally", "podman rm failed"].join("|"),
  "i",
);
// 门槛依赖的服务连不上（GATE_ENV_PREFIX，#54）也定时重跑，但不进 PODMAN_TRANSIENT（不用等 podman）。
// A service the gate depends on being unreachable (GATE_ENV_PREFIX, #54) is rerun later too, but isn't in PODMAN_TRANSIENT (no waiting for podman).
const TRANSIENT = new RegExp(`${REMOTE_TRANSIENT.source}|CopyToWorktreeTimeoutError|timed out|${PODMAN_TRANSIENT.source}|${GATE_ENV_PREFIX}`, "i");
const TRANSIENT_RETRY_WAITS_MS = [60_000, 300_000, 900_000];

async function retryTransient<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = String((e as { stderr?: unknown }).stderr || e);
      const wait = TRANSIENT_RETRY_WAITS_MS[attempt];
      if (wait === undefined || !TRANSIENT.test(message)) throw e;
      const first = message.split("\n")[0].slice(0, 160);
      const n = `${attempt + 1}/${TRANSIENT_RETRY_WAITS_MS.length}`;
      if (!PODMAN_TRANSIENT.test(message)) {
        console.warn(t(`  ⚠ ${what} 撞上临时错误（${first}），${wait / 1000} 秒后重跑（第 ${n} 次）`, `  ⚠ ${what} hit a transient error (${first}); rerunning in ${wait / 1000}s (attempt ${n})`));
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      // podman 类错误：等 podman 连上（最多等这次的间隔）再重跑；「镜像不在本地」在连上后复查，真缺镜像就按原路径报错。
      // podman errors: wait until podman is reachable (at most this attempt's interval), then rerun; "image not found locally" is rechecked once connected, and a truly missing image fails as before.
      console.warn(t(`  ⚠ ${what} 撞上 podman 连接问题（${first}），等 podman 连上（最多 ${wait / 1000} 秒）后重跑（第 ${n} 次）`, `  ⚠ ${what} hit a podman connection problem (${first}); rerunning once podman is reachable (up to ${wait / 1000}s, attempt ${n})`));
      const up = await waitForPodman(trySh, undefined, wait);
      const image = missingImage(message);
      if (up && image !== null && !imageExists(image)) throw e;
    }
  }
}

/**
 * 关沙箱：podman 断连时 `podman rm` 会失败，只打一行警告，不让它盖掉门槛结果、也不跳过后面的清理；残留的容器交给每次调度的孤儿清理。
 * Close a sandbox: `podman rm` fails while podman is disconnected; only print a warning so it neither masks the gate result nor skips the cleanup after it; leftover containers are left to the orphan cleanup on every pass.
 */
async function closeQuietly(issueId: string, close: () => Promise<unknown>) {
  try {
    await close();
  } catch (e) {
    console.warn(t(`  ⚠ #${issueId} 关沙箱失败（${errorLine(e)}），残留容器下次调度清理`, `  ⚠ #${issueId} closing the sandbox failed (${errorLine(e)}); leftover containers are cleaned up on the next pass`));
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
    console.warn(
      t(
        `  ⚠ 宿主机当前在 ${branch}，不是 ${BASE_BRANCH}：prep / plan 读到的是这个分支的代码，可能不是 ${BASE_REF}`,
        `  ⚠ The host is on ${branch}, not ${BASE_BRANCH}: prep / plan read this branch's code, which may not be ${BASE_REF}`,
      ),
    );
    return;
  }
  const merged = trySh("git", ["merge", "--ff-only", "--quiet", BASE_REF]);
  if (!merged.ok) {
    console.warn(
      t(`  ⚠ 本地 ${BASE_BRANCH} 没能快进到 ${BASE_REF}，prep / plan 可能读到旧代码：`, `  ⚠ Local ${BASE_BRANCH} couldn't fast-forward to ${BASE_REF}; prep / plan may read old code: `) +
        merged.out.slice(0, 300),
    );
  }
}

/**
 * 带全部 `include` 标签、不带任何 `exclude` 标签的 open 票（排除的标签在本地过滤）。
 * Open tickets with every `include` label and none of the `exclude` labels (exclusions are filtered locally).
 */
type ListedIssue = ForgeIssue;
const listIssues = (include: string[], exclude: string[] = []): ListedIssue[] =>
  forge.listOpenIssues(include).filter((issue) => !issue.labels.some((label) => exclude.includes(label)));

// ---------------------------------------------------------------------------
// Plan：确定性计算，不交给 agent（planner agent 曾把「同文件只留编号小的」比反）
// Plan: deterministic, not left to an agent (a planner agent once inverted "keep the lower number when files clash")
// ---------------------------------------------------------------------------

/**
 * 票的状态，每次调度开头清空（blocker 可能在两次调度之间被合并）。
 * State of tickets, cleared at the start of every pass (blockers may be merged between passes).
 */
const issueStates = new Map<number, IssueState>();
function issueState(n: number): IssueState {
  if (!issueStates.has(n)) {
    const r = attempt(() => forge.issueState(String(n)));
    issueStates.set(n, r.ok ? r.value : "open"); // 查询出错时当作 open，宁可少做 / treat as open when the lookup fails, preferring to do less
  }
  return issueStates.get(n)!;
}
const isOpen = (n: number) => issueState(n) === "open";

/**
 * 最后一次调度里被还开着的 blocker 挡住的票（票号 → blocker 票号），每次调度开头清空。一张票都没开工就空转退出时用来说明原因。
 * Tickets blocked by still-open blockers in the last pass (ticket → blocker numbers), cleared at the start of every pass. Used to explain an idle exit when no ticket was ever started.
 */
const waitingOn = new Map<number, number[]>();

/** `## Blocked by` 里还没关的票。 / Tickets in `## Blocked by` that are still open. */
const openBlockers = (body: string) => blockersOf(body).filter(isOpen);

/** `## Blocked by` 里平台确认不存在的票。 / Tickets in `## Blocked by` that the forge confirms don't exist. */
const missingBlockers = (body: string) => blockersOf(body).filter((n) => issueState(n) === "missing");

/**
 * blocker 不存在的票：打印原因，打 stuck 并留言；人改好 Blocked by、去掉 stuck 后照常调度。
 * Tickets whose blocker doesn't exist: log why, label stuck and comment; once a human fixes Blocked by and removes stuck, scheduling resumes.
 */
function stuckOnMissing(issue: { number: number }, missing: number[]) {
  const refs = missing.map((n) => `#${n}`);
  console.log(
    t(
      `  跳过 #${issue.number}：blocker ${refs.join("、")} 不存在或无权访问`,
      `  Skipping #${issue.number}: blocker ${refs.join(", ")} doesn't exist or isn't accessible`,
    ),
  );
  const r = attempt(() => markStuck(String(issue.number), M.missingBlocker(M.list(refs), LABEL.stuck)));
  if (!r.ok) console.warn(t(`  ⚠ #${issue.number} 打 ${LABEL.stuck} 失败：`, `  ⚠ Labelling #${issue.number} ${LABEL.stuck} failed: `) + r.out.slice(0, 200));
}

/**
 * 拆过的父票：prep 拆票时去掉父票的 Sandcastle，正文加 `## Split into`，之后没人管它，
 * 被它 block 的票就一直排不上（2026-11-04 #381 的子票 #389、#390 都合并了，#382 仍在等 #381）。
 * 每次调度开头查不带 Sandcastle、有 `## Split into` 的 open 票，子票全关了就勾上清单、关掉父票。
 * 「上下文不够」那种父票保留 Sandcastle、由自己的 PR 关，不在这里处理。平台出错只打警告。
 * Split parents: when prep splits a ticket it removes Sandcastle from the parent and adds `## Split into` to its body; nobody tends it afterwards,
 * so tickets it blocks never get scheduled (2026-11-04: #381's children #389 and #390 were both merged, yet #382 still waited on #381).
 * At the start of every pass, find open tickets without Sandcastle that have `## Split into`; when all children are closed, tick the list and close the parent.
 * Parents split for "not enough context" keep Sandcastle and are closed by their own PR, so they aren't handled here. Forge errors only warn.
 */
function closeFinishedParents() {
  const parents = attempt(() => forge.listSplitParents(LABEL.picked));
  if (!parents.ok) {
    console.warn(t("  ⚠ 查拆过的父票失败：", "  ⚠ Listing split parent tickets failed: ") + parents.out.slice(0, 200));
    return;
  }
  for (const parent of parents.value) {
    const children = splitChildren(parent.body);
    if (children.length === 0 || children.some(isOpen)) continue;
    const body = parent.body.replace(/^(\s*[-*]\s*)\[ \](?=\s*#\d+)/gm, "$1[x]");
    const refs = children.map((n) => `#${n}`);
    if (body !== parent.body) attempt(() => forge.editIssueBody(String(parent.number), body));
    const closed = attempt(() => forge.closeIssue(String(parent.number), M.parentClosed(M.list(refs))));
    const list = refs.join(t("、", ", "));
    if (closed.ok) {
      issueStates.set(parent.number, "closed");
      console.log(t(`  ✓ 父票 #${parent.number} 的子票 ${list} 都已关闭，已关闭父票`, `  ✓ Children ${list} of #${parent.number} are all closed; closed the parent`));
    } else {
      console.warn(t(`  ⚠ 关闭父票 #${parent.number} 失败：`, `  ⚠ Closing parent #${parent.number} failed: `) + closed.out.slice(0, 200));
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
  for (const label of [LABEL.prepped, LABEL.prOpen, LABEL.merging, LABEL.reviewed, LABEL.stuck]) {
    const closed = attempt(() => forge.listClosedIssueNumbers(label));
    if (!closed.ok) {
      console.warn(t(`  ⚠ 查带 ${label} 的已关闭票失败：`, `  ⚠ Listing closed tickets labelled ${label} failed: `) + closed.out.slice(0, 200));
      continue;
    }
    const cleared: string[] = [];
    for (const n of closed.value.map(String)) {
      const edited = attempt(() => forge.removeLabel(n, label));
      if (edited.ok) cleared.push(`#${n}`);
      else console.warn(t(`  ⚠ 去掉 #${n} 的 ${label} 失败：`, `  ⚠ Removing ${label} from #${n} failed: `) + edited.out.slice(0, 200));
    }
    if (cleared.length > 0) console.log(t(`  🧹 已关闭的票去掉 ${label}：${cleared.join("、")}`, `  🧹 Removed ${label} from closed tickets: ${cleared.join(", ")}`));
  }

  const branchOf = /^sandcastle\/issue-(\d+)$/;
  const remote = await gitRemote(["ls-remote", "--heads", REMOTE, "sandcastle/issue-*"]);
  if (!remote.ok) console.warn(t("  ⚠ 列远端的 sandcastle 分支失败：", "  ⚠ Listing remote sandcastle branches failed: ") + remote.out.slice(0, 200));
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
      if (deleted.ok) removed.push(t("远端分支", "remote branch"));
      else console.warn(t(`  ⚠ 删除远端分支 ${branch} 失败：`, `  ⚠ Deleting remote branch ${branch} failed: `) + deleted.out.slice(0, 200));
    }
    const worktree = worktrees.get(branch);
    if (worktree) {
      const gone = trySh("git", ["worktree", "remove", worktree]);
      if (!gone.ok) {
        console.warn(t(`  ⚠ #${id} 的 worktree ${worktree} 没删（有未提交改动？）：`, `  ⚠ Didn't remove #${id}'s worktree ${worktree} (uncommitted changes?): `) + gone.out.slice(0, 200));
        continue;
      }
      removed.push("worktree");
    }
    if (localBranches.includes(branch) && trySh("git", ["branch", "-D", branch]).ok) removed.push(t("本地分支", "local branch"));
    if (removed.length > 0)
      console.log(t(`  🧹 #${id} 已关闭、PR #${pr.value} 已合并，删除${removed.join("、")}`, `  🧹 #${id} closed and PR #${pr.value} merged; deleted ${removed.join(", ")}`));
  }
}

/**
 * 能在 main 上开工、且可以并行的票，按编号从小到大。
 * blocker 没关（包括已开 PR 未合并）的跳过；和已选的票、或等人审（pr-open）的票改同一个文件的跳过，
 * 所以冲突时总是编号小的先做，等人审的 PR 合入或关闭前不会有第二个 PR 改同一个文件。
 * 被 blocker 挡住的票不占文件，不会连带挡住编号大的票。
 * running 是正在 build / 落地的票：不再选，它们改的文件和等人审的票一样先占上；最多补满 slots 张。
 * Tickets that can start on main and run in parallel, in ascending number order.
 * Skip tickets with open blockers (including PRs opened but not merged), and tickets changing a file also changed by a picked ticket or one under review (pr-open),
 * so on a clash the lower number always goes first, and no second PR touches the same file until the one under review is merged or closed.
 * Tickets held by blockers don't claim files, so they don't also hold back higher-numbered tickets.
 * running holds tickets being built / landed: they aren't picked again, and their files are claimed like those of tickets under review; fill up to slots tickets.
 */
function plan(running: ReadonlySet<string>, slots: number, quiet = false): Issue[] {
  const log = quiet ? () => {} : console.log;
  const warn = quiet ? () => {} : console.warn;
  const candidates = listIssues([LABEL.picked, LABEL.prepped], [LABEL.prOpen, LABEL.stuck]);
  // 等人审的 PR 还没合进 main：它们改的文件先占上，免得新票在旧 main 上改同一个文件，两个 PR 互相冲突。
  // PRs under review aren't in main yet: claim their files first, so a new ticket doesn't change the same file on an old main and make the two PRs conflict.
  const waiting = listIssues([LABEL.picked, LABEL.prOpen]);
  const taken = new Map<string, number>();
  const awaitingReview = new Set<number>();
  for (const w of waiting.sort((a, b) => a.number - b.number)) {
    awaitingReview.add(w.number);
    for (const f of changedFiles(w.body, APPEND_ONLY).files) if (!taken.has(f)) taken.set(f, w.number);
  }
  // 带 merging 的票（上次运行在等检查 / 合并时被中断，由 resumeMerging 接着做）和正在做的票一样占着文件、不重新开工。
  // Tickets labelled merging (interrupted last run while waiting for checks / merging; resumeMerging picks them up) claim files like running ones and aren't started again.
  const merging = (c: ListedIssue) => c.labels.includes(LABEL.merging);
  for (const r of candidates.filter((c) => running.has(String(c.number)) || merging(c))) {
    for (const f of changedFiles(r.body, APPEND_ONLY).files) if (!taken.has(f)) taken.set(f, r.number);
  }
  const picked: Issue[] = [];
  for (const issue of candidates.filter((c) => allowed(c.number) && !running.has(String(c.number)) && !merging(c)).sort(byUrgency)) {
    const missing = missingBlockers(issue.body);
    if (missing.length > 0) {
      if (!quiet) stuckOnMissing(issue, missing); // quiet 时只跳过，不打 stuck / when quiet, only skip, don't label stuck
      continue;
    }
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      waitingOn.set(issue.number, open);
      const blockers = open.map((n) => `#${n}`);
      log(t(`  跳过 #${issue.number}：blocker ${blockers.join("、")} 还没关`, `  Skipping #${issue.number}: blocker ${blockers.join(", ")} still open`));
      continue;
    }
    const { files, fallback } = changedFiles(issue.body, APPEND_ONLY);
    if (fallback)
      warn(
        t(
          `  ⚠ #${issue.number} 的指引里没认出 Change 行，按指引引用的文件处理：${files.join("、")}`,
          `  ⚠ No Change lines recognized in #${issue.number}'s guide; using the files it references: ${files.join(", ")}`,
        ),
      );
    else if (files.length === 0)
      warn(t(`  ⚠ #${issue.number} 的指引里没认出要改的文件，按不改已有文件处理`, `  ⚠ No files to change recognized in #${issue.number}'s guide; assuming it changes no existing files`));
    const clash = files.find((f) => taken.has(f));
    if (clash) {
      const owner = taken.get(clash)!;
      const why = awaitingReview.has(owner)
        ? t(`等人审的 #${owner}（PR 合入或关闭后再做）`, `#${owner}, which is waiting for review (will run after that PR is merged or closed)`)
        : running.has(String(owner)) ? t(`正在做的 #${owner}`, `#${owner}, which is in progress`) : `#${owner}`;
      log(t(`  跳过 #${issue.number}：和${why} 都改 ${clash}`, `  Skipping #${issue.number}: it and ${why} both change ${clash}`));
      continue;
    }
    if (picked.length >= slots) break;
    for (const f of files) taken.set(f, issue.number);
    // 已有外部 PR（`Closes` 了这张票）时在它的分支上接着改；否则照旧用自己的分支。
    // When an external PR (that `Closes` this ticket) exists, continue on its branch; otherwise use our own branch as usual.
    const pr = prFor(issue.number);
    const branch = pr && !pr.branch.startsWith("sandcastle/") ? pr.branch : ownBranch(issue.number);
    picked.push({
      id: String(issue.number), title: issue.title, branch, browserCheck: ticketHasBrowserCheck(issue.body), reviewed: issue.labels.includes(LABEL.reviewed),
    });
  }
  return picked;
}

/** implement 的几次会话合在一起（每次会话单独挑档案，分开跑）。 / implement's sessions combined (each session picks its own profile and runs separately). */
type Sessions = { iterations: sandcastle.IterationResult[]; stdout: string; completionSignal?: string };
const peakContext = (...runs: ({ readonly iterations: readonly sandcastle.IterationResult[] } | undefined)[]) =>
  Math.max(
    0,
    // 每次会话取会话文件里单条消息的最大上下文；只看结束时的大小会漏掉中途压缩前的峰值。
    // Each session takes the largest single-message context in its session file; looking only at the final size misses the peak before a mid-session compaction.
    ...runs.flatMap((run) => (run?.iterations ?? []).map(sessionPeak)),
  );

/**
 * browserCheck：票正文有没有 `- **Browser check**`（plan 时设；resume 构造的不带，那条路不走 land）。
 * reviewed：票带 sandcastle:reviewed（#49，plan 时设）；build 打 / 去这个标签时同步改它，retryTransient 重跑 build 时看得到。
 * browserCheck: whether the ticket body has `- **Browser check**` (set by plan; the ones built on resume lack it, and that path doesn't go through land).
 * reviewed: the ticket is labelled sandcastle:reviewed (#49, set by plan); build updates it when adding / removing the label so a retryTransient rerun of build sees it.
 */
type Issue = { id: string; title: string; branch: string; browserCheck?: boolean; reviewed?: boolean };

const ownBranch = (issueId: string | number) => `sandcastle/issue-${issueId}`;
/**
 * 外部 PR：别人（其他 agent、人）开的、`Closes` 了这张票的 PR，分支不是 `sandcastle/` 开头。
 * Sandcastle 在它的分支上接着改，但只做普通 push：不 force、不 rebase、不合并、不删分支，合并留给人。
 * External PR: a PR opened by someone else (another agent, a person) that `Closes` this ticket, with a branch not starting with `sandcastle/`.
 * Sandcastle continues on its branch but only with plain pushes: no force, no rebase, no merge, no branch deletion; merging is left to a human.
 */
const isExternal = (issue: Issue) => !issue.branch.startsWith("sandcastle/");

/**
 * 推分支：自己的分支照旧 force-with-lease（rebase 过）；外部分支只做普通 push，被拒就报错。
 * Push the branch: our own branches use force-with-lease as before (they were rebased); external branches get plain pushes and error when rejected.
 */
function pushBranch(issue: Issue) {
  return gitRemote(isExternal(issue)
    ? ["push", REMOTE, `${issue.branch}:${issue.branch}`]
    : ["push", "--force-with-lease", "-u", REMOTE, issue.branch]);
}

/**
 * 这张票的 open PR：先按 issue 关联（PR 正文的关闭写法），同时有自己的分支时用自己的；
 * 关联里只有一个本仓库的外部 PR 时用它；有多个外部 PR 时不猜，返回 null 并打日志。
 * 关联查不到（接口出错、没有关联）时退回按分支名 `sandcastle/issue-n` 查。
 * This ticket's open PR: first by issue link (the closing keyword in the PR body), preferring our own branch when both exist;
 * if the links contain exactly one external PR from this repo, use it; with several external PRs, don't guess: return null and log.
 * If the link lookup fails (API error, no links), fall back to the branch name `sandcastle/issue-n`.
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
    const prs = external.map((pr) => `#${pr.id}`);
    console.warn(
      t(`  ⚠ #${issueId} 关联了多个外部 PR（${prs.join("、")}），不知道在哪个上改，跳过`, `  ⚠ #${issueId} is linked to several external PRs (${prs.join(", ")}); can't tell which one to work on, skipping`),
    );
    return null;
  }
  return external[0] ?? view(ownBranch(issueId));
}

/**
 * 外部 PR 的分支：开沙箱前同步到宿主机本地（沙箱从本地分支建 worktree，本地没有就会从 main 新建，丢掉对方的提交）。
 * 本地没有就从远端建；本地落后就快进；本地领先（上次没推上去）就保留；两边分叉就报错，交给人。
 * An external PR's branch: sync it to the host before opening the sandbox (the sandbox creates its worktree from the local branch; without one it branches from main and loses their commits).
 * Create it from the remote if missing; fast-forward if behind; keep it if ahead (last push didn't land); error out if diverged, leaving it to a human.
 */
async function syncExternalBranch(issue: Issue) {
  await gitRemoteOrThrow(["fetch", REMOTE, issue.branch]);
  const remote = `${REMOTE}/${issue.branch}`;
  if (!trySh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issue.branch}`]).ok) {
    sh("git", ["branch", issue.branch, remote]);
  } else if (trySh("git", ["merge-base", "--is-ancestor", issue.branch, remote]).ok) {
    sh("git", ["branch", "-f", issue.branch, remote]);
  } else if (!trySh("git", ["merge-base", "--is-ancestor", remote, issue.branch]).ok) {
    throw new Error(
      t(
        `本地分支 ${issue.branch} 和 ${remote} 分叉了（PR 作者在 Sandcastle 处理期间推过提交？），请人合并后再跑。`,
        `Local branch ${issue.branch} has diverged from ${remote} (did the PR author push while Sandcastle was working?); have someone merge them, then rerun.`,
      ),
    );
  }
}

/**
 * PR 正文的两大块：验收说明（最前面的一节，准备段落 + `.pr-notes/验收说明.md`）与其余各节（restSections 的结果）。
 * The two parts of the PR body: acceptance notes (the first section: setup steps + `.pr-notes/验收说明.md`) and the remaining sections (from restSections).
 */
type PrNotes = { acceptance: string; rest: string };

async function pushAndOpenPr(issue: Issue, notes: PrNotes, shots: string[]): Promise<string> {
  const pushed = await pushBranch(issue);
  if (!pushed.ok) throw new Error(`push ${issue.branch} ${t("失败：", "failed: ")}${pushed.out.slice(0, 500)}`);
  const existing = forge.findPr(issue.branch, "open");
  if (existing) {
    // 已有 PR：自己的分支只替换正文里的「验收说明」一节，其余（上次的 Review / Gate 记录）逐字保留；
    // 外部 PR 不动别人写的正文，验收说明贴在评论里。
    // Existing PR: for our own branch, replace only the acceptance notes section, keeping the rest (earlier Review / Gate records) verbatim;
    // for an external PR, don't touch the author's body; post the acceptance notes as a comment.
    if (isExternal(issue)) {
      forge.commentPr(existing, `${M.prUpdated}\n\n## ${M.notesTitle}\n\n${notes.acceptance}\n\n${notes.rest}`, shots);
    } else {
      const body = forge.prBody(existing);
      forge.editPrBody(existing, replaceSection(body, M.notesTitle, `## ${M.notesTitle}\n\n${notes.acceptance}`));
      forge.commentPr(existing, `${M.prUpdatedNotes}\n\n${notes.rest}`, shots);
    }
    return existing;
  }
  // 外部 PR 不在这里新开：它被关了就说明人不要了。 / External PRs aren't reopened here: if it was closed, a human didn't want it.
  if (isExternal(issue))
    throw new Error(t(`分支 ${issue.branch} 上已经没有 open 的 PR，外部 PR 不由 Sandcastle 重开。`, `Branch ${issue.branch} no longer has an open PR; Sandcastle doesn't reopen external PRs.`));
  const commits = sh("git", ["log", `${BASE_REF}..${issue.branch}`, "--format=- %B"]);
  const body = `${forge.closingRef(issue.id)}\n\n## ${M.notesTitle}\n\n${notes.acceptance}\n\n${notes.rest}\n\n## Commits\n\n${commits}`;
  return forge.createPr({ base: BASE_BRANCH, head: issue.branch, title: `${issue.title} (#${issue.id})`, body, attachments: shots });
}

function leaveForHuman(issue: Issue, pr: string, reason: string) {
  forge.addLabel(issue.id, LABEL.prOpen);
  forge.commentPr(pr, M.notMerged(reason));
}

/**
 * agent 代拍板过的票：打 sandcastle:decided，把那些评论贴到 PR 上，人事后确认。平台出错只警告，不影响落地。
 * Tickets where the agent made decisions: label sandcastle:decided and copy those comments to the PR for a human to confirm later. Forge errors only warn and don't block landing.
 */
function reportDecisions(issueId: string, pr: string) {
  const r = attempt(() => forge.issueComments(issueId));
  if (!r.ok) return console.warn(t(`  ⚠ 读 #${issueId} 的代拍板评论失败：`, `  ⚠ Reading #${issueId}'s decision comments failed: `) + r.out.slice(0, 200));
  const decisions = r.value.filter((body) => body.startsWith(DECIDED_MARK)).map((body) => body.slice(DECIDED_MARK.length).trim());
  if (!decisions.length) return;
  const label = attempt(() => forge.addLabel(issueId, LABEL.decided));
  const comment = attempt(() => forge.commentPr(pr, `${M.decisions(decisions.length, issueId, LABEL.decided)}\n\n${decisions.map((d, n) => `<details><summary>${M.decisionN(n + 1)}</summary>\n\n${d}\n\n</details>`).join("\n\n")}`));
  for (const x of [label, comment]) if (!x.ok) console.warn(t(`  ⚠ #${issueId} 代拍板标记失败：`, `  ⚠ Marking #${issueId}'s decisions failed: `) + x.out.slice(0, 200));
  console.log(t(`  📝 #${issueId} 有 ${decisions.length} 个代拍板，打 ${LABEL.decided}`, `  📝 #${issueId} has ${decisions.length} agent decision(s); labelled ${LABEL.decided}`));
}

function markStuck(issueId: string, reason: string) {
  forge.addLabel(issueId, LABEL.stuck);
  forge.commentIssue(issueId, M.stuck(reason));
}

/** PR 上以这个开头的评论或 review 正文表示「打回 Sandcastle」（作者不能对自己的 PR 点 Request changes）。 */
const REVISE_COMMAND = "/sandcastle";

/**
 * 等人审的票：PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，或别人点的
 * Request changes）→ 去掉 issue 的 pr-open，让它回到 plan。比较时间是为了不重复回流：
 * Sandcastle 改完推上新提交后，同一条意见不再算数。
 * Tickets under review: a send-back signal on the PR newer than the branch's latest commit (a comment or review starting with `/sandcastle`, or someone else's
 * Request changes) → remove the issue's pr-open so it returns to plan. Comparing times avoids repeated send-backs:
 * once Sandcastle pushes new commits, the same feedback no longer counts.
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
    forge.commentPr(pr.id, M.reopened);
    console.log(t(`  ↺ #${issueId} 收到打回（PR #${pr.id}），重新排队`, `  ↺ #${issueId} was sent back (PR #${pr.id}); requeued`));
  }
}

/**
 * 门槛里重跑才通过的测试文件：按报错签名去重开票（带 Sandcastle，下次调度自动 prep + 修）。
 * 同签名（同根因落在不同文件）只开一张；已有同签名、或标题 `偶发失败：<文件>` 相同的老票，
 * 就在那张票上追加一次出现记录，不重复开票。只是超时 / 连不上、且同一文件 7 天内第一次出现的，
 * 只记进 FLAKY_FILE、不开票（规则见 guide.ts 的 flakyTriage）。返回票号与只记录的文件，写进 PR 评论。
 * Test files that passed only on a gate rerun: open tickets deduped by error signature (with Sandcastle, so the next pass preps and fixes them).
 * One ticket per signature (one root cause across files); when an old ticket has the same signature or the title `偶发失败：<file>`,
 * append an occurrence to it instead of opening another. Plain timeouts / connection failures seen for the first time in 7 days for that file
 * are only recorded in FLAKY_FILE, without a ticket (rules in flakyTriage in guide.ts). Returns ticket numbers and recorded-only files for the PR comment.
 */
const FLAKY_FILE = ".sandcastle/logs/flaky.json";
function reportFlaky(issue: Issue, pr: string, gateOutput: string): { tickets: string[]; deferred: string[] } {
  // 单元测试和后面一段各可能重跑通过一次（两个 GATE_FLAKY）：每段重跑前列出的文件都要算上
  // The unit tests and the later stage may each pass on a rerun (two GATE_FLAKY): count the files listed before each rerun
  const parts = gateOutput.split("GATE_FLAKY");
  const before = parts.slice(0, -1).join("\n");
  const after = parts.slice(1).join("\n");
  const files = [...new Set(before.match(new RegExp(`^${project.gate.testFile.source}$`, "gm")) ?? [])];
  if (files.length === 0) return { tickets: [], deferred: [] };
  attempt(() => forge.ensureLabel(LABEL.flaky, "fbca04", M.flakyLabelDesc));
  const open = forge.listOpenIssues([LABEL.flaky]);
  const seen = M.flakySeen(issue.id, pr);
  const summary = `\`\`\`\n${after.trim().slice(0, 3000)}\n\`\`\``;
  // 当时的环境：判断是不是负载 / 并发问题时先看这个
  // The environment at the time: check this first when judging whether it's a load / concurrency problem
  const others = [...running.values()].filter((i) => i.id !== issue.id).map((i) => `#${i.id}`);
  const load = loadavg().map((n) => n.toFixed(1)).join(" / ");
  const env = M.flakyEnv(others, load, cpus().length);
  // 分组、签名标记、标题与已有票的匹配见 guide.ts 的 flakyTickets；开不开票见 flakyTriage；正文见项目配置 texts.flakyIssueBody。
  // Grouping, signature markers, titles and matching existing tickets: flakyTickets in guide.ts; whether to open: flakyTriage; body: the project's texts.flakyIssueBody.
  let history: FlakySighting[] = [];
  try {
    history = JSON.parse(readFileSync(FLAKY_FILE, "utf8")) as FlakySighting[];
  } catch {}
  const triage = flakyTriage(flakyTickets(files, after, open, project.gate.testFile, M), history, issue.id, new Date());
  writeFileSync(FLAKY_FILE, `${JSON.stringify(triage.history, null, 1)}\n`);
  const deferred = triage.deferred.flatMap((g) => g.files);
  if (deferred.length)
    console.log(
      t(
        `  ⚠ #${issue.id} 门槛偶发超时 / 连接失败，7 天内第一次，只记录不开票：${deferred.join("、")}`,
        `  ⚠ #${issue.id} gate had a flaky timeout / connection failure, the first in 7 days; recorded without a ticket: ${deferred.join(", ")}`,
      ),
    );
  // 同一文件 7 天内之前的出现（超时类第二次出现才开票，票里列出前几次，方便判断是不是同一个环境时段）
  // Earlier occurrences of the same file within 7 days (timeouts open a ticket on the second occurrence, and the ticket lists the earlier ones to judge whether it's the same environmental window)
  const prior = (groupFiles: string[]) => {
    const seenAt = history.filter((h) => groupFiles.includes(h.file)).map((h) => M.flakyPriorItem(h.at.slice(0, 16), h.issue, h.file));
    return seenAt.length ? M.flakyPrior(seenAt) : "";
  };
  const tickets = triage.ticket.map(({ files: groupFiles, marker, title, existing }) => {
    const list = M.list(groupFiles.map((f) => `\`${f}\``));
    if (existing !== undefined) {
      const again = M.flakyAgain(seen, marker ? list : undefined);
      forge.commentIssue(String(existing), `${again}${env}${M.flakyFirstFailure}\n\n${summary}`);
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
// 在独立沙箱里构建一张票
// ---------------------------------------------------------------------------

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;
type RunAgent = (phase: Phase, name: string, fn: (agent: sandcastle.AgentProvider) => Promise<sandcastle.SandboxRunResult>) => Promise<sandcastle.SandboxRunResult>;
/**
 * 评审的结果，门槛和 PR 正文要用。恢复时（#49）runs 为空，其余来自票上的标记评论。
 * The review's results, used by the gate and the PR body. On resume (#49) runs is empty and the rest comes from the marker comment on the ticket.
 */
type Reviewed = {
  runs: sandcastle.SandboxRunResult[];
  revisions: string[];
  verdict: string | undefined;
  summary: string;
  browserTag: string | undefined;
};

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
  const run: RunAgent = (phase, name, fn) => runAgent(phase, issue.id, name, env, usage, fn);
  try {
    // 上次评审已通过、分支 HEAD 没变（#49）：跳过 implement / review，直接跑门槛。HEAD 变了就清掉状态正常重做。
    // The last review passed and the branch HEAD is unchanged (#49): skip implement / review and go straight to the gate. If HEAD moved, clear the state and redo normally.
    const resumed = issue.reviewed ? await resumeReviewed(issue, sandbox) : undefined;
    if (resumed) {
      // 用量和预算从用量日志里补：这次进程里没有 implement / review 的会话结果。
      // Usage and budget come from the usage log: this process has no implement / review session results.
      const prior = readUsage(issue.id).filter((r) => r.phase === "implement" || r.phase === "review" || r.phase === "revise");
      usage.push(...prior);
      const implement: Sessions = { iterations: [], stdout: "", completionSignal: COMPLETE };
      const budget = {
        peak: Math.max(0, ...prior.map((r) => r.peak)),
        sessions: prior.filter((r) => r.phase === "implement" && !r.limited).length,
      };
      return { ...(await gateAndCollect(issue, sandbox, run, env, implement, resumed, usage)), budget };
    }
    const r = await implementAndReview(issue, sandbox, run);
    if (!r.done) return { done: false as const, implement: r.implement, usage };
    // 跑门槛之前落盘：门槛撞上临时错误、retryTransient 重跑 build 时也从门槛接着跑。
    // Persist before the gate: when the gate hits a transient error and retryTransient reruns build, it also continues from the gate.
    if (r.reviewed.verdict === "merge") {
      const head = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
      if (head) markReviewed(issue, { sha: head, summary: r.reviewed.summary, revisions: r.reviewed.revisions, browserTag: r.reviewed.browserTag });
    }
    return { ...(await gateAndCollect(issue, sandbox, run, env, r.implement, r.reviewed, usage)), budget: undefined };
  } finally {
    await closeQuietly(issue.id, () => sandbox.close());
    await dropTestResources(issue.id);
  }
}

/**
 * 沙箱 worktree 的 HEAD；取不到时返回空串。 / The sandbox worktree's HEAD; an empty string when it can't be read.
 */
const sandboxHead = async (sandbox: Sandbox) =>
  (await sandbox.exec("git rev-parse HEAD").catch(() => undefined))?.stdout.trim() ?? "";

/**
 * 票带 reviewed 时读票上的标记评论，和 worktree 的 HEAD 比：一致返回评审结果；不一致或读不出来就清掉状态，返回 undefined 正常重做。
 * When the ticket is labelled reviewed, read its marker comment and compare with the worktree HEAD: return the review results when they match; otherwise clear the state and return undefined to redo normally.
 */
async function resumeReviewed(issue: Issue, sandbox: Sandbox): Promise<Reviewed | undefined> {
  // 读评论或取 HEAD 失败时不清状态，这次照常重做：一次网络抖动不该让下次重启也没法恢复。
  // If reading comments or HEAD fails, keep the state and just redo this time: one network blip shouldn't stop the next restart from resuming too.
  const comments = attempt(() => forge.issueComments(issue.id));
  const head = await sandboxHead(sandbox);
  if (!comments.ok || !head) return undefined;
  const state = parseReviewed(comments.value);
  if (resumeDecision(state, head) === "resume" && state) {
    console.log(t(`  ↻ 接着上次：#${issue.id} 评审已过，直接跑门槛`, `  ↻ Resuming: #${issue.id} already passed review; going straight to the gate`));
    return { runs: [], revisions: state.revisions, verdict: "merge", summary: state.summary, browserTag: state.browserTag };
  }
  clearReviewed(issue);
  return undefined;
}

/**
 * implement（多次会话，撞限额换档案）+ review / revise。没做完（没发 COMPLETE 或分支上没有提交）时 done 为 false。
 * implement (several sessions, switching profiles on limits) + review / revise. done is false when unfinished (no COMPLETE or no commits on the branch).
 */
async function implementAndReview(issue: Issue, sandbox: Sandbox, run: RunAgent) {
  // 每次会话单独挑档案：撞了限额，下一次会话就换下一个档案接着做（交接靠 issue 上的进度评论）。
  // 档案名经环境变量 SANDCASTLE_PROFILE 给 implementer，不走 promptArgs：运行中的旧进程也会读到新提示词，多出的占位符会让它报错。
  // Each session picks its own profile: after a limit, the next session continues with the next profile (handover via progress comments on the issue).
  // The profile name reaches the implementer via the SANDCASTLE_PROFILE env var, not promptArgs: an old running process would also read the new prompts, and an extra placeholder makes it error.
  const implement: Sessions = { iterations: [], stdout: "" };
  for (let session = 1; session <= IMPLEMENT_MAX_ITERATIONS && implement.completionSignal === undefined; session++) {
    const r = await run("implement", `implement-${issue.id}-${session}`, (agent) => sandbox.run({
      name: `implement-${issue.id}-${session}`,
      maxIterations: 1,
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
      completionSignal: [COMPLETE, NEEDS_DECISION],
      agent,
      promptFile: PROMPTS.implement,
      promptArgs: { TASK_ID: issue.id, ISSUE_TITLE: issue.title, BRANCH: issue.branch },
    }));
    implement.iterations.push(...r.iterations);
    implement.stdout += r.stdout;
    implement.completionSignal = r.completionSignal;
  }
  // 看分支上的提交，不看这次会话的：重新准备后父票只剩已完成的部分，收尾时可能不再提交。
  // Look at the branch's commits, not this session's: after re-prep the parent may only have finished parts left, and wrapping up may not commit anything.
  const ahead = Number((await sandbox.exec(`git rev-list --count ${BASE_REF}..HEAD`)).stdout.trim()) || 0;
  if (implement.completionSignal !== COMPLETE || ahead === 0) {
    return { done: false as const, implement };
  }

  const runReview = (round: number) =>
    run("review", `review-${issue.id}-${round}`, (agent) => sandbox.run({
      name: `review-${issue.id}-${round}`,
      maxIterations: 1,
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
      agent,
      promptFile: PROMPTS.review,
      promptArgs: { TASK_ID: issue.id, BRANCH: issue.branch, BASE: BASE_REF, ROUND: round, REVISE_MAX },
    }));
  // reviewer 给 revise：修改意见交给新的 implementer 会话，改完再审一次。
  // Reviewer says revise: the requested changes go to a new implementer session, then review again.
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
  const reviewed: Reviewed = {
    runs: [...reviews, ...revisions.map((r) => r.run)],
    revisions: revisions.map((r) => r.items),
    verdict: tagged(review.stdout, "verdict"),
    summary: tagged(review.stdout, "review-summary") ?? M.noReviewSummary,
    browserTag: tagged(review.stdout, "browser-check"),
  };
  return { done: true as const, implement, reviewed };
}

/**
 * 起一次复审会话（fix / rebase 之后，#70、#71）：run 名 `re-review-<id>-<kind>`，提示词 prompts/re-review.md，返回会话和解析出的结论。
 * Start one re-review session (after fix / rebase, #70, #71): run name `re-review-<id>-<kind>`, prompt prompts/re-review.md; returns the session and the parsed verdict.
 */
async function reReviewSession(issue: Issue, sandbox: Sandbox, run: RunAgent, kind: "fix" | "rebase", diffCmd: string) {
  const name = `re-review-${issue.id}-${kind}`;
  const reRun = await run("re-review", name, (agent) => sandbox.run({
    name,
    maxIterations: 1,
    idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
    agent,
    promptFile: PROMPTS["re-review"],
    promptArgs: { TASK_ID: issue.id, BRANCH: issue.branch, KIND: kind, DIFF_CMD: diffCmd },
  }));
  return { run: reRun, verdict: reReviewVerdict(reRun.stdout, M) };
}

/**
 * 门槛（失败时给一次 fix 机会再跑）、改了哪些文件、浏览器验收和验收说明，拼成 land 要的结果。门槛不管 verdict 都跑。
 * fix 有新提交且门槛重跑通过时，再起一次 re-review 会话只看 fix 的提交（#70），结论进 reReview，不通过由 land 留 PR。
 * The gate (with one fix chance and a rerun on failure), changed files, browser check and acceptance notes, assembled into the result land needs. The gate runs whatever the verdict.
 * When the fix committed and the gate rerun passed, a re-review session looks only at the fix's commits (#70); the verdict goes into reReview, and land leaves the PR open if it fails.
 */
async function gateAndCollect(
  issue: Issue, sandbox: Sandbox, run: RunAgent, env: Record<string, string>, implement: Sessions, reviewed: Reviewed, usage: UsageRecord[],
) {
  const gate = () => runGate((c, o) => sandbox.exec(c, o), issue.id, env);
  let gateResult = await gate();
  let fix: sandcastle.SandboxRunResult | undefined;
  let reReview: ReReview | undefined;
  let reReviewRun: sandcastle.SandboxRunResult | undefined;
  if (gateResult.exitCode !== 0) {
    // fix 前的 HEAD：fix 有没有新提交、复审看哪段 diff，都以它为起点。取不到就是空串，不复审。
    // The pre-fix HEAD: the start point for whether the fix committed and which diff the re-review sees. Empty when unreadable, which skips the re-review.
    const before = await sandboxHead(sandbox);
    // 给 implementer 一次修的机会（新会话），再跑一次门槛。 / Give the implementer one chance to fix (new session), then run the gate again.
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
    const after = await sandboxHead(sandbox);
    // reviewer 本来就没给 merge 时 land 反正留 PR，不白跑复审。 / When the reviewer didn't say merge, land leaves the PR anyway; skip the re-review.
    if (gateResult.exitCode === 0 && reviewed.verdict === "merge" && needsReReview(before, after)) {
      ({ run: reReviewRun, verdict: reReview } = await reReviewSession(issue, sandbox, run, "fix", fixDiffCmd(before)));
    }
  }
  // 改了哪些文件（判断改没改页面用）：在 review / 修改 / 修门槛之后取，算上所有提交。取不到就当空的，退回原有判断，不挡合并。
  // Which files changed (to judge page changes): taken after review / revisions / gate fixes so every commit counts. If it fails, treat it as empty and fall back to the existing judgement without blocking the merge.
  const diff = await sandbox.exec(`git diff --name-only ${BASE_REF}...HEAD`).catch(() => undefined);
  const changed = diff?.exitCode === 0 ? diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];

  return {
    done: true as const,
    implement,
    runs: [...reviewed.runs, fix, reReviewRun],
    revisions: reviewed.revisions,
    verdict: reviewed.verdict,
    summary: reviewed.summary,
    gate: { ok: gateResult.exitCode === 0, output: gateResult.stdout.slice(-3000), tier: gateTier(gateResult.stdout) },
    reReview,
    browser: collectBrowserCheck(sandbox.worktreePath, issue.id),
    browserTag: reviewed.browserTag,
    notes: readAcceptanceNotes(sandbox.worktreePath),
    changed,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Rebase + retry merge（合并失败时）
// Rebase and retry the merge (when merging fails)
// ---------------------------------------------------------------------------

const REBASE_STATE = "test -d \"$(git rev-parse --git-path rebase-merge)\" || test -d \"$(git rev-parse --git-path rebase-apply)\"";

// 合并前的额外一致性检查（项目配置 integrity，比如数据库迁移链没分叉）：rebase 没有文本冲突也可能坏。
// 没配置时恒为通过。
// Extra consistency check before merging (project config integrity, e.g. the database migration chain didn't fork): a rebase without text conflicts can still break it.
// Always passes when not configured.
const integrityOk = (head: string) => (project.integrity ? project.integrity.command(head, BASE_REF) : "true");
const INTEGRITY_OK = integrityOk("HEAD");
const integrityBroken = () => project.integrity?.broken(BASE_REF) ?? M.integrityBroken;
const integrityName = project.integrity?.name ?? M.integrityName;

/**
 * 把分支 rebase 到最新的 origin/main：没冲突直接 rebase；有冲突开一次 agent 会话按
 * prompts/rebase.md 解决。merge 为 true 时重跑门槛，通过才 force-push 再合并；
 * 为 false 时只跑 typecheck 就 force-push 更新 PR（留给人审的 PR 不和 main 冲突，测试由人合并前决定是否补跑）。
 * merge 为 true 且 agent 解过冲突时，门槛通过后、push 前还要复审通过（#71，只看 rebase 前后的 range-diff）。
 * 任何一步不成都返回原因，由调用方留 PR。
 */
type HostGap = { release: () => void; reacquire: () => Promise<void> };

/**
 * 调用方持有宿主机锁（withHost）。开沙箱、rebase、跑门槛这段放开锁（和 build 一样只动本票的分支与 worktree；
 * 这张票还在 running 里，它改的文件不会被新票占用；票没关，清理不会删它的 worktree），push 与合并前再拿回锁。
 * 放开期间别的票可能先合进 main：这里的合并会失败，按原有路径留 PR。
 * The caller holds the host lock (withHost). Opening the sandbox, rebasing and running the gate happen with the lock released (like build, touching only this ticket's branch and worktree;
 * the ticket is still in running, so its files can't be claimed by new tickets; the ticket isn't closed, so cleanup won't remove its worktree); the lock is retaken before push and merge.
 * Meanwhile other tickets may merge into main first: then this merge fails and the PR is left open as usual.
 */
async function rebaseAndMerge(issue: Issue, pr: string, host: HostGap, merge = true): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isExternal(issue)) return { ok: false, reason: M.rebaseExternal(issue.branch) };
  const env = testEnv(issue.id);
  host.release();
  let opened: Awaited<ReturnType<typeof sandcastle.createSandbox>> | undefined;
  try {
    await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
    const sandbox = await sandcastle.createSandbox({ branch: issue.branch, baseBranch: BASE_REF, sandbox: sandboxFor(env), hooks, copyToWorktree });
    opened = sandbox;
    const behind = await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`);
    if (behind.exitCode === 0) {
      return { ok: false, reason: M.rebaseNotBehind(BASE_REF) };
    }

    // merge-tree 有冲突时退出码 1、冲突文件列在 stdout 第一行（树 id）之后；`; true` 让 trySh 拿到 stdout
    // merge-tree exits 1 on conflicts and lists the conflicting files after the first stdout line (the tree id); `; true` lets trySh capture stdout
    const probe = trySh("sh", ["-c", `git merge-tree --write-tree --name-only ${BASE_REF} ${issue.branch}; true`]);
    const conflictFiles = probe.ok ? probe.out.split("\n\n")[0]!.split("\n").slice(1).filter(Boolean) : [];
    // rebase 前的分支提交范围（旧 base..旧 HEAD）：agent 解冲突后复审用 range-diff 对比（#71）。
    // The branch's commit range before the rebase (old base..old HEAD): the re-review after agent conflict resolution compares against it with range-diff (#71).
    const oldHead = await sandboxHead(sandbox);
    const mergeBase = await sandbox.exec(`git merge-base ${BASE_REF} HEAD`).catch(() => undefined);
    const oldBase = mergeBase?.exitCode === 0 ? mergeBase.stdout.trim() : "";
    const rebase = await sandbox.exec(`git rebase ${BASE_REF}`);
    const conflicted = rebase.exitCode !== 0;
    const chainBroken = !conflicted && (await sandbox.exec(INTEGRITY_OK)).exitCode !== 0;
    if (conflicted || chainBroken) {
      // 用量只进 usage.jsonl：这时 PR 已经开了。 / Usage only goes to usage.jsonl: the PR is already open at this point.
      await runAgent("rebase", issue.id, `rebase-${issue.id}`, env, [], (agent) => sandbox.run({
        name: `rebase-${issue.id}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        promptFile: PROMPTS.rebase,
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
        return { ok: false, reason: M.rebaseAgentFailed };
      }
      if ((await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`)).exitCode !== 0) {
        return { ok: false, reason: M.rebaseStillBehind(BASE_REF) };
      }
      if ((await sandbox.exec(INTEGRITY_OK)).exitCode !== 0) {
        return { ok: false, reason: M.rebaseStillBroken(integrityBroken()) };
      }
    }

    // 留给人审的 PR（merge 为 false）只跑 typecheck、不重跑测试：人合并前看 PR 评论里的冲突文件，
    // 需要时再补跑门槛。省掉一遍完整测试，也不占完整门槛的队列。
    // PRs left for review (merge is false) only run typecheck, not tests: before merging, a human checks the conflicting files in the PR comment
    // and reruns the gate if needed. Saves a full test run and doesn't take a slot in the full gate queue.
    if (!merge) {
      const tc = await sandbox.exec(`${project.gate.typecheck} > /tmp/rebase-typecheck.log 2>&1 || { tail -40 /tmp/rebase-typecheck.log; exit 1; }`);
      if (tc.exitCode !== 0) {
        return { ok: false, reason: M.rebaseTypecheckFailed(tc.stdout.slice(-2000)) };
      }
      await host.reacquire();
      await gitRemoteOrThrow(["push", "--force-with-lease", REMOTE, issue.branch]);
      const files = conflictFiles.length ? M.list(conflictFiles.map((f) => `\`${f}\``)) : M.rebaseNoTextConflict(integrityName);
      const how = conflicted || chainBroken ? M.rebaseHowAgent : M.rebaseHowClean;
      console.log(t(`  ↻ #${issue.id} rebase 后 typecheck 通过，不重跑测试，留给人审`, `  ↻ #${issue.id} typecheck passed after the rebase; tests not rerun, left for review`));
      forge.commentPr(pr, M.rebasedTypecheckOnly(BASE_REF, how, files));
      return { ok: true };
    }

    // rebase 后的门槛和开工时同一套选测试规则（分支相对新 main 的改动），不再因冲突强制完整测试（2026-11-24）。
    // The gate after a rebase uses the same test selection as at the start (the branch's changes against the new main), no longer forcing the full suite because of conflicts (2026-11-24).
    const gate = await runGate((c, o) => sandbox.exec(c, o), issue.id, env);
    if (gate.exitCode !== 0) {
      return { ok: false, reason: M.rebaseGateFailed(gate.stdout.slice(-2000)) };
    }

    // agent 解过冲突（或重做了完整性链）且门槛通过：push 前复审一次，只看 rebase 带来的变化（#71）。
    // 这时宿主机锁还放开着，复审只在沙箱里跑；不通过就不 push，远端分支保持原样，由调用方留 PR。
    // The agent resolved conflicts (or rebuilt the integrity chain) and the gate passed: re-review once before pushing, looking only at what the rebase changed (#71).
    // The host lock is still released here, so the re-review stays in the sandbox; on failure nothing is pushed, the remote branch stays as it was, and the caller leaves the PR open.
    if (rebaseNeedsReReview({ conflicted, chainBroken, merge })) {
      const usage: UsageRecord[] = [];
      // 取不到 rebase 前的范围时 range-diff 没法对比：按不通过处理（fail-closed），不白起会话。
      // Without the pre-rebase range the range-diff can't compare: treat it as not passing (fail-closed) without starting a session.
      const verdict = oldBase && oldHead
        ? (await reReviewSession(issue, sandbox, (phase, name, fn) => runAgent(phase, issue.id, name, env, usage, fn), "rebase", rebaseDiffCmd(oldBase, oldHead, BASE_REF))).verdict
        : { pass: false, summary: M.reReviewNoRange };
      if (!verdict.pass) {
        console.log(t(`  ◐ #${issue.id} rebase 解冲突之后的复审没通过，不 push`, `  ◐ #${issue.id} re-review after resolving rebase conflicts failed; not pushing`));
        const table = usage.length ? `\n\n${usageTable(usage, M)}` : "";
        return { ok: false, reason: `${M.reasonReReview("rebase", verdict.summary)}${table}` };
      }
    }

    await host.reacquire();
    await gitRemoteOrThrow(["push", "--force-with-lease", REMOTE, issue.branch]);
    // 等检查前先关沙箱、清测试库：等的时候空位已让出，新开的票不该和这张票的资源同时占着。
    // Close the sandbox and drop test resources before waiting for checks: the slot is freed meanwhile, so a newly started ticket shouldn't overlap this ticket's resources.
    if (opened) {
      await closeQuietly(issue.id, () => opened!.close());
      await dropTestResources(issue.id);
      opened = undefined;
    }
    // 等检查、再重试合并（merge-flow.ts）。 / Wait for checks, then retry the merge (merge-flow.ts).
    return await mergeAfterPush(issue.id, pr, mergeDeps(issue, pr, host));
  } finally {
    if (opened) {
      await closeQuietly(issue.id, () => opened!.close());
      await dropTestResources(issue.id);
    }
    await host.reacquire();
  }
}

// ---------------------------------------------------------------------------
// 用量限额：等到重置后接着跑，不当成票的失败
// Usage limits: wait for the reset and continue, not counted as a ticket failure
// ---------------------------------------------------------------------------

// 等限额、醒来重读 models.json 再重跑在 limit-wait.ts。 / Waiting on limits, rereading models.json on waking and rerunning live in limit-wait.ts.

/** 分支上已有提交时推到远端，免得只留在宿主机上。 / Push to the remote when the branch has commits, so they aren't only on the host. */
async function pushIfAhead(issue: Issue) {
  const ahead = trySh("git", ["rev-list", "--count", `${BASE_REF}..${issue.branch}`]);
  if (ahead.ok && Number(ahead.out) > 0) await pushBranch(issue);
}

/**
 * issue 已关闭（人在运行中途合并了 PR、或手动关了票）。查不到时当作没关。
 * The issue is closed (a human merged the PR or closed the ticket mid-run). Treated as open when the lookup fails.
 */
function issueClosed(id: string) {
  const r = attempt(() => forge.issueState(id));
  return r.ok && r.value === "closed";
}

/**
 * 给 untilAfterLimit 的 deps.comment：全部档案撞限额时在票上评论一次。已关的票不发；最后一条评论已经带 LIMITED_MARK 不发；失败只警告。
 * deps.comment for untilAfterLimit: comment once on the ticket when every profile hit its limit. Not on closed tickets, not when the last comment already has LIMITED_MARK; failures only warn.
 */
function limitedComment(issueId: string) {
  return (limited: AllProfilesLimited) => {
    const r = attempt(() => {
      if (issueClosed(issueId)) return;
      if (forge.issueComments(issueId).at(-1)?.includes(LIMITED_MARK)) return;
      forge.commentIssue(issueId, M.limitedWaiting(limited.phase, limited.profiles, new Date(limited.until).toLocaleString(), LIMITED_MARK));
    });
    if (!r.ok) console.warn(t(`  ⚠ #${issueId} 限额等待的评论没发出去：${r.out}`, `  ⚠ #${issueId}: couldn't post the limit-wait comment: ${r.out}`));
  };
}

/**
 * Phase 3：一张票的落地。在宿主机上做，用宿主机的 git / 平台凭据，沙箱没有写仓库的权限。
 * Phase 3: landing one ticket. Done on the host with the host's git / forge credentials; the sandbox has no write access to the repo.
 */
/**
 * 要留给人审的分支如果和最新的 origin/main 有文本冲突（或项目配置的一致性检查没过），走 rebaseAndMerge 但不合并。
 * 返回附在 leaveForHuman 说明后面的一句话；不需要 rebase 时为空串。
 * If a branch to be left for review has text conflicts with the latest origin/main (or fails the project's integrity check), go through rebaseAndMerge without merging.
 * Returns a sentence appended to leaveForHuman's note; an empty string when no rebase was needed.
 */
async function rebaseIfConflicting(issue: Issue, pr: string, host: HostGap): Promise<string> {
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
  const chainOk = trySh("sh", ["-c", integrityOk(issue.branch)]).ok;
  if (clean && chainOk) return "";
  console.log(t(`  ↻ #${issue.id} 和最新的 ${BASE_REF} 冲突，rebase 后再留给人审`, `  ↻ #${issue.id} conflicts with the latest ${BASE_REF}; rebasing before leaving it for review`));
  const r = await untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr, host, false), undefined, { comment: limitedComment(issue.id) });
  return r.ok
    ? M.rebasedForHuman(BASE_REF)
    : M.rebaseForHumanFailed(BASE_REF, r.reason);
}

/**
 * 给 merge-flow.ts 组装依赖：模块级的 forge、配置、文案、空位与锁都从这里传进去。
 * Assemble the dependencies for merge-flow.ts: the module-level forge, config, messages, slots and lock are passed in here.
 */
const mergeDeps = (issue: Issue, pr: string, host: HostGap): MergeFlowDeps => ({
  forge,
  mergeMethod: project.mergeMethod,
  mergeRequires: project.mergeRequires,
  M,
  baseRef: BASE_REF,
  host,
  ciWaiting,
  signalSlotFreed,
  leaveForHuman: (reason) => leaveForHuman(issue, pr, reason),
  markMerging: (on) => markMerging(issue.id, on),
});

let mergingLabelEnsured = false;
/**
 * 打 / 去 sandcastle:merging：第一次用时先建标签（老项目没有，和 flaky、main-broken 一样由脚本自己建）。出错只警告。
 * Add / remove sandcastle:merging: create the label on first use (older projects lack it; like flaky and main-broken the script creates it). Errors only warn.
 */
function markMerging(issueId: string, on: boolean) {
  if (on && !mergingLabelEnsured) {
    mergingLabelEnsured = true;
    attempt(() => forge.ensureLabel(LABEL.merging, "bfdadc", M.mergingLabelDesc));
  }
  const r = attempt(() => (on ? forge.addLabel(issueId, LABEL.merging) : forge.removeLabel(issueId, LABEL.merging)));
  if (!r.ok && !issueClosed(issueId))
    console.warn(
      on
        ? t(`  ⚠ 给 #${issueId} 打 ${LABEL.merging} 失败（中断后重启会重新实现）：`, `  ⚠ Labelling #${issueId} ${LABEL.merging} failed (a restart after an interrupt would reimplement it): `) + r.out.slice(0, 200)
        : t(`  ⚠ 去掉 #${issueId} 的 ${LABEL.merging} 失败：`, `  ⚠ Removing ${LABEL.merging} from #${issueId} failed: `) + r.out.slice(0, 200),
    );
}

let reviewedLabelEnsured = false;
/**
 * 记评审已过（#49）：先发带 sha 的标记评论（恢复要用），再打 sandcastle:reviewed；第一次用时先建标签。出错只警告。
 * Record a passed review (#49): post the marker comment with the sha first (needed to resume), then add sandcastle:reviewed; the label is created on first use. Errors only warn.
 */
function markReviewed(issue: Issue, state: ReviewedState) {
  if (!reviewedLabelEnsured) {
    reviewedLabelEnsured = true;
    attempt(() => forge.ensureLabel(LABEL.reviewed, "c2e0c6", M.reviewedLabelDesc));
  }
  const r = attempt(() => {
    forge.commentIssue(issue.id, reviewedComment(state.sha, state, M));
    forge.addLabel(issue.id, LABEL.reviewed);
  });
  if (r.ok) issue.reviewed = true;
  else if (!issueClosed(issue.id))
    console.warn(t(`  ⚠ 给 #${issue.id} 记评审已过失败（中断后重启会重新实现）：`, `  ⚠ Recording the passed review on #${issue.id} failed (a restart after an interrupt would reimplement it): `) + r.out.slice(0, 200));
}

/**
 * 去掉 sandcastle:reviewed（#49）。出错只警告：标签留着时，人打回后分支没变会跳过 implement，要手动去掉。
 * Remove sandcastle:reviewed (#49). Errors only warn: if the label stays, a send-back with an unchanged branch would skip implement, so it must be removed by hand.
 */
function clearReviewed(issue: Issue) {
  const r = attempt(() => forge.removeLabel(issue.id, LABEL.reviewed));
  if (r.ok) issue.reviewed = false;
  else if (!issueClosed(issue.id))
    console.warn(
      t(
        `  ⚠ 去掉 #${issue.id} 的 ${LABEL.reviewed} 失败（请手动去掉，否则打回后分支没变会跳过实现）：`,
        `  ⚠ Removing ${LABEL.reviewed} from #${issue.id} failed (remove it by hand, or a send-back with an unchanged branch would skip implementing): `,
      ) + r.out.slice(0, 200),
    );
}

async function land(issue: Issue, outcome: PromiseSettledResult<Awaited<ReturnType<typeof build>>>, host: HostGap) {
  // 不论成败先清掉 reviewed（#49）：门槛失败留 PR 后人可能用 /sandcastle 打回，票重新进 build 时 sha 没变，不清会错误地跳过 implement。
  // Clear reviewed first whatever the outcome (#49): after a failed gate leaves a PR, a human may send it back with /sandcastle; the ticket re-enters build with the same sha and would wrongly skip implement.
  if (issue.reviewed) clearReviewed(issue);
  // 运行期间人已经合并了这张票的 PR 或关了票：不再 push、开 PR、打标签，本地分支留着备查。
  // A human already merged this ticket's PR or closed it during the run: no push, PR or labels; the local branch is kept for reference.
  if (issueClosed(issue.id)) {
    console.log(t(`  ⏭ #${issue.id} 已被关闭（运行期间有人合并了 PR 或关了票），跳过落地`, `  ⏭ #${issue.id} was closed (someone merged the PR or closed it during the run); skipping landing`));
    return;
  }
  if (outcome.status === "rejected") {
    // 终端和评论只要一行，堆栈写进本地日志（评论里的 node_modules 堆栈对人没用）。
    // One line for the terminal and the comment; the stack goes to a local log (a node_modules stack in a comment helps nobody).
    logErrorDetail(ERROR_LOG, `#${issue.id}`, outcome.reason, appendFileSync);
    const why = isAgentIdleTimeout(outcome.reason)
      ? t(`agent ${AGENT_IDLE_TIMEOUT_S} 秒没有输出（空闲超时；测试或构建确实要这么久就调大 agentIdleTimeoutS）`, `agent produced no output for ${AGENT_IDLE_TIMEOUT_S}s (idle timeout; raise agentIdleTimeoutS if tests or builds really take this long)`)
      : errorLine(outcome.reason);
    console.error(`  ✗ #${issue.id} ${t("失败：", "failed: ")}${why}${t(`（详情见 ${ERROR_LOG}）`, ` (details in ${ERROR_LOG})`)}`);
    // 门槛依赖的服务连不上（#54）：写明匹配到的那一行，不写成通用的沙箱错误。
    // A service the gate depends on is unreachable (#54): state the matched line rather than a generic sandbox error.
    const envDown = gateEnvReason(outcome.reason);
    markStuck(
      issue.id,
      isAgentIdleTimeout(outcome.reason)
        ? M.agentIdleTimeout(AGENT_IDLE_TIMEOUT_S, LABEL.stuck)
        : envDown !== null
          ? M.gateEnvDown(envDown, LABEL.stuck)
          : PODMAN_TRANSIENT.test(String(outcome.reason))
            ? M.podmanDown(errorLine(outcome.reason))
            : M.sandboxError(errorLine(outcome.reason)),
    );
    return;
  }
  const result = outcome.value;
  // 从评审已过的状态恢复时（#49），峰值和会话数取用量日志里 implement / review / revise 的记录。
  // When resuming from a passed review (#49), the peak and session count come from the implement / review / revise records in the usage log.
  const peak = result.done
    ? Math.max(result.budget?.peak ?? 0, peakContext(result.implement, ...result.runs))
    : peakContext(result.implement);
  const sessions = (result.done ? result.budget?.sessions : undefined) ?? result.implement.iterations.length;
  const budgetNote = M.budgetNote(Math.round(peak / 1000), CONTEXT_BUDGET / 1000, sessions);
  if (!result.done) {
    // implementer 判断必须由人拍板：推上已有的提交，直接交给人，不退回 prep。
    // The implementer judged that a human must decide: push the existing commits and hand it straight to a human, not back to prep.
    if (result.implement.completionSignal === NEEDS_DECISION) {
      const pushed = (await pushBranch(issue)).ok;
      attempt(() => forge.addLabel(issue.id, LABEL.readyForHuman));
      markStuck(issue.id, M.needsDecision(budgetNote, pushed ? M.pushedTo(issue.branch) : M.notPushed, LABEL.stuck));
      console.log(t(`  ✋ #${issue.id} 要人拍板，打 ${LABEL.stuck}`, `  ✋ #${issue.id} needs a human decision; labelled ${LABEL.stuck}`));
      return;
    }
    const comments = forge.issueComments(issue.id).join("\n");
    if (comments.includes(REPREP_MARK)) {
      markStuck(
        issue.id,
        M.reprepFailed(IMPLEMENT_MAX_ITERATIONS, budgetNote),
      );
      return;
    }
    // 外部 PR 不退回 prep（prep 会按 sandcastle/issue-n 拆票）：推上已有的提交，交给人。
    // External PRs don't go back to prep (prep would split along sandcastle/issue-n): push the existing commits and hand it to a human.
    if (isExternal(issue)) {
      const pushed = (await pushBranch(issue)).ok;
      markStuck(issue.id, M.externalIncomplete(issue.branch, IMPLEMENT_MAX_ITERATIONS, budgetNote, pushed ? M.pushedHere : M.notPushed));
      return;
    }
    // 第一次没做完：分支推上去免得部分提交只留在宿主机，提交列表写进评论给 prep 看，退回 prep 重新准备。
    // First attempt unfinished: push the branch so partial commits aren't only on the host, list the commits in a comment for prep, and send it back to prep.
    const pushed = (await pushBranch(issue)).ok;
    const log = trySh("git", ["log", "--format=- %h %s", `${BASE_REF}..${issue.branch}`]);
    const commits = log.ok && log.out ? M.reprepCommits(issue.branch, log.out) : M.reprepNoCommits;
    forge.removeLabel(issue.id, LABEL.prepped);
    forge.commentIssue(
      issue.id,
      `${REPREP_MARK}\n${M.reprep(IMPLEMENT_MAX_ITERATIONS, budgetNote, LABEL.stuck)}${commits}${pushed ? "" : M.reprepNotPushed}`,
    );
    console.log(t(`  ↺ #${issue.id} 没做完，退回 prep 重新准备`, `  ↺ #${issue.id} isn't finished; back to prep`));
    return;
  }

  const overBudget = peak > CONTEXT_BUDGET ? M.overBudget : "";
  const flaky = result.gate.output.includes("GATE_FLAKY");
  const tierName = result.gate.tier === "selected" ? project.gate.selectedDescription : M.tierFull;
  // 先 push 开 PR 才有 PR 号；开票放在后面，票号用评论补到 PR 上。
  // Push and open the PR first to get its number; tickets are opened afterwards and their numbers added to the PR in a comment.
  const gateNote = !result.gate.ok
    ? M.gateFailed(result.gate.output)
    : flaky
      ? M.gateFlaky(tierName, result.gate.output)
      : M.gatePassed(tierName, result.gate.output.slice(-500));
  const revisionNote = result.revisions.length
    ? `${M.revisions(result.revisions.length)}${result.revisions
        .map((items, n) => `<details><summary>${M.revisionN(n + 1)}</summary>\n\n${items}\n\n</details>`)
        .join("\n\n")}`
    : "";
  const notesProblems = checkAcceptanceNotes(result.notes, M);
  // 改了页面：diff 命中 browser.pagePaths，或有 .browser-check/，或 review 说改了。 / Pages changed: the diff hits browser.pagePaths, or there's a .browser-check/, or the review says so.
  const pageChanged =
    pageFiles(result.changed, project.browser.pagePaths).length > 0 || result.browser !== undefined || pageChangedByReview(result.browserTag);
  // 改了页面但票里没有 Browser check：PR 正文的 Browser check 一节写提示（没有 .browser-check/ 也写），另发一条评论。
  // Pages changed but the ticket has no Browser check: the PR body's Browser check section carries a notice (even without .browser-check/), plus a separate comment.
  const noTicketCheck = pageChanged && issue.browserCheck === false;
  const pr = await pushAndOpenPr(
    issue,
    {
      acceptance: acceptanceSection(issue.branch, result.notes, { pageChanged, pagePrep: project.acceptancePrep, m: M }),
      rest: restSections({
        review: `${result.summary}${revisionNote}`,
        browser: browserSection(result.browser, noTicketCheck, M),
        gate: gateNote,
        budget: `${budgetNote}${overBudget}`,
        usage: usageTable([...readUsage(issue.id, "prep"), ...result.usage], M),
      }),
    },
    result.browser?.shots ?? [],
  );
  reportDecisions(issue.id, pr);
  if (noTicketCheck) attempt(() => forge.commentPr(pr, M.browserNoTicketCheck));
  if (flaky && result.gate.ok) {
    // 开 flaky 票 / 评论老票时 gh 出错不让整个落地失败（票会被打成 stuck）：打一行提示，跳过 PR 评论，继续合并。
    // A gh error while filing / commenting on flaky tickets must not fail the whole landing (the ticket would go stuck): print a line, skip the PR comment, keep merging.
    const reported = attempt(() => reportFlaky(issue, pr, result.gate.output));
    if (!reported.ok) {
      const first = reported.out.trim().split("\n")[0] ?? "";
      console.log(t(`  ⚠ #${issue.id} 门槛有偶发失败，开 flaky 票失败：${first}`, `  ⚠ #${issue.id} gate had flaky failures; filing the flaky ticket failed: ${first}`));
    } else {
      const { tickets, deferred } = reported.value;
      const ticketsLine = flakyTicketsLine(issue.id, tickets);
      if (ticketsLine) console.log(ticketsLine);
      const notes = [
        ...(tickets.length ? [M.flakyTicketsOpened(M.list(tickets))] : []),
        ...(deferred.length ? [M.flakyDeferred(M.list(deferred.map((f) => `\`${f}\``)))] : []),
      ];
      if (notes.length) forge.commentPr(pr, notes.join("\n\n"));
    }
  }

  // 外部 PR 一律留给人合并：不 rebase、不合并，只报告 review 与门槛结果。
  // External PRs are always left for a human to merge: no rebase, no merge, only the review and gate results are reported.
  if (isExternal(issue)) {
    await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
    const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
    leaveForHuman(
      issue,
      pr,
      M.reasonExternal(result.verdict, result.gate.ok) + (clean ? "" : M.reasonExternalConflict(BASE_REF, BASE_BRANCH)),
    );
    console.log(t(`  ◐ #${issue.id} 外部 PR #${pr}，留给人合并`, `  ◐ #${issue.id} external PR #${pr}, left for a human to merge`));
    return;
  }
  // 验收说明缺失或格式不对：正文里已经有警告，下面每条留给人的路径都把它附进原因（外部 PR 本来就不自动合并，不走这里）。
  // Acceptance notes missing or badly formatted: the body already has a warning, and every leave-for-human path below adds it to the reason (external PRs never auto-merge, so they don't come here).
  const notesNote = notesProblems.length
    ? M.reasonNotes(notesProblems.join(M.sep))
    : "";
  // 改了页面的票，浏览器验收是自动合并的硬条件（src/browser-gate.ts）；不满足时同样附进每条留给人的原因。
  // For tickets that change pages, the browser check is a hard condition for auto-merge (src/browser-gate.ts); when unmet it's likewise added to every leave-for-human reason.
  const { block: browserBlock } = browserVerdict(
    { pages: pageChanged, hasBrowser: DOC.hasBrowser, browser: result.browser, tag: result.browserTag },
    M,
  );
  const browserNote = browserBlock ? `\n\n${browserBlock}` : "";
  // 终端也逐条写缺什么（和 PR 评论同一段原因）。 / The terminal also lists what's missing (the same reason as the PR comment).
  const logBrowserBlock = () => browserBlock && console.log(`    ${browserBlock}`);
  if (result.verdict !== "merge") {
    // 开工后 main 上合进了改同一处的票：先 rebase 好再交给人，免得人审的是一个合不进去的 PR。
    // A ticket changing the same spot merged into main after this one started: rebase first, so the human doesn't review a PR that can't merge.
    const rebaseNote = result.gate.ok ? await rebaseIfConflicting(issue, pr, host) : "";
    leaveForHuman(
      issue,
      pr,
      (result.verdict === "revise"
        ? M.reasonReviseMax(REVISE_MAX)
        : M.reasonReviewerPr) +
        rebaseNote +
        notesNote +
        browserNote,
    );
    console.log(t(`  ◐ #${issue.id} 留 PR #${pr} 等人审`, `  ◐ #${issue.id} PR #${pr} left for review`));
    logBrowserBlock();
    return;
  }
  if (!result.gate.ok) {
    leaveForHuman(issue, pr, `${M.reasonGate}${notesNote}${browserNote}`);
    console.log(t(`  ◐ #${issue.id} 门槛失败，留 PR #${pr}`, `  ◐ #${issue.id} gate failed; PR #${pr} left open`));
    logBrowserBlock();
    return;
  }
  // fix 改了代码、门槛重跑过了，但 fix 之后的复审没通过（#70）：不自动合并。
  // The fix changed code and the gate rerun passed, but the re-review after the fix didn't pass (#70): no auto-merge.
  if (result.reReview && !result.reReview.pass) {
    leaveForHuman(issue, pr, `${M.reasonReReview("fix", result.reReview.summary)}${notesNote}${browserNote}`);
    console.log(t(`  ◐ #${issue.id} fix 之后的复审没通过，留 PR #${pr}`, `  ◐ #${issue.id} re-review after the fix failed; PR #${pr} left open`));
    logBrowserBlock();
    return;
  }
  // reviewer 给了 merge、门槛也过了，但验收说明不合格：照样不自动合并。
  // The reviewer said merge and the gate passed, but the acceptance notes are invalid: still no auto-merge.
  if (notesProblems.length > 0) {
    leaveForHuman(issue, pr, `${notesNote}${browserNote}`.trimStart());
    console.log(
      result.notes === undefined
        ? t(`  ◐ #${issue.id} 验收说明缺失，留 PR #${pr}`, `  ◐ #${issue.id} acceptance notes missing; PR #${pr} left open`)
        : t(`  ◐ #${issue.id} 验收说明格式不对，留 PR #${pr}`, `  ◐ #${issue.id} acceptance notes badly formatted; PR #${pr} left open`),
    );
    logBrowserBlock();
    return;
  }
  // reviewer 给了 merge、门槛和验收说明都过了，但改了页面而浏览器验收不满足：不自动合并。
  // The reviewer said merge and the gate and acceptance notes passed, but pages changed and the browser check falls short: no auto-merge.
  if (browserBlock) {
    leaveForHuman(issue, pr, browserBlock);
    console.log(
      DOC.hasBrowser
        ? t(`  ◐ #${issue.id} 改了页面，浏览器验收不满足，留 PR #${pr}`, `  ◐ #${issue.id} changed pages and the browser check falls short; PR #${pr} left open`)
        : t(`  ◐ #${issue.id} 改了页面、本项目没配浏览器验收，留 PR #${pr}`, `  ◐ #${issue.id} changed pages but this project has no browser check configured; PR #${pr} left open`),
    );
    logBrowserBlock();
    return;
  }
  // 试跑期（autoMerge: false）：全程都过了也只留 PR，人看过再合并。
  // Trial period (autoMerge: false): even when everything passes, leave the PR for a human to check and merge.
  if (!project.autoMerge) {
    const rebaseNote = await rebaseIfConflicting(issue, pr, host);
    leaveForHuman(issue, pr, `${M.reasonAutoMergeOff}${rebaseNote}`);
    console.log(t(`  ◐ #${issue.id} 全部通过，autoMerge 关着，留 PR #${pr} 等人合并`, `  ◐ #${issue.id} passed everything; autoMerge is off, PR #${pr} left for a human to merge`));
    return;
  }
  await finishMerge(issue, pr, host, result.gate.tier);
}

/**
 * 自动合并收尾（land 的最后一步，也是 resumeMerging 接着做的那一步）：等检查 → 合并 → 删分支。整个过程票上带 sandcastle:merging。
 * The auto-merge finish (the last step of land, and the step resumeMerging continues): wait for checks → merge → delete the branch. The ticket carries sandcastle:merging throughout.
 */
async function finishMerge(issue: Issue, pr: string, host: HostGap, tier: GateTier) {
  // 先合并的票可能让这张冲突：rebase 到最新的 origin/main（冲突交给 agent）、重跑门槛，再合并一次。
  // 一致性检查要先在宿主机上查：没有文本冲突时平台会照样合并，坏掉的状态就进了 main。
  // An earlier merge may make this one conflict: rebase onto the latest origin/main (conflicts go to the agent), rerun the gate, and merge again.
  // The integrity check must run on the host first: without a text conflict the forge would merge anyway, putting the broken state into main.
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const chainOk = trySh("sh", ["-c", integrityOk(issue.branch)]).ok;
  // 等检查 → 合并 → 分支保护 / rebase 补救 → 留 PR（merge-flow.ts）。
  // Wait for checks → merge → branch protection / rebase recovery → leave the PR (merge-flow.ts).
  const r = await mergeWhenReady(
    { issueId: issue.id, pr, chainOk, brokenOut: `${integrityBroken()}。`, rebase: () => untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr, host), undefined, { comment: limitedComment(issue.id) }) },
    mergeDeps(issue, pr, host),
  );
  if (r === "left") return;
  await gitRemote(["push", REMOTE, "--delete", issue.branch]);
  trySh("git", ["branch", "-D", issue.branch]);
  console.log(t(`  ✓ #${issue.id} 已合并（PR #${pr}）`, `  ✓ #${issue.id} merged (PR #${pr})`));
  noteMerged(tier);
}

/**
 * 上次运行在等检查 / 合并时被中断的票（带 sandcastle:merging）：PR 已开、门槛已过，不重新实现，直接回到 finishMerge。
 * 找不到这张票自己分支上开着的 PR（人关了 PR、删了分支）就去掉标签，交回 plan 照常调度。
 * 门槛档位已经查不到了，按「按依赖选」记（多算一次，兜底完整测试只会提前、不会漏）。
 * Tickets interrupted last run while waiting for checks / merging (labelled sandcastle:merging): the PR is open and the gate passed, so don't reimplement; go straight back to finishMerge.
 * If there's no open PR on the ticket's own branch (a human closed the PR or deleted the branch), remove the label and hand it back to plan.
 * The gate tier is no longer known, so it's counted as dependency-selected (one extra count only brings the fallback full run forward, never skips it).
 */
async function resumeMerging(issue: Issue, host: HostGap) {
  const pr = prFor(issue.id);
  if (!pr || pr.branch !== issue.branch) {
    attempt(() => forge.removeLabel(issue.id, LABEL.merging));
    console.log(t(`  ↺ #${issue.id} 带 ${LABEL.merging} 但没有开着的 PR，交回调度`, `  ↺ #${issue.id} is labelled ${LABEL.merging} but has no open PR; handing it back to scheduling`));
    return;
  }
  // 本地分支被删了（或在别的机器上中断的）就从远端取回：rebase 补救和一致性检查都看本地分支。
  // If the local branch is gone (or the run was interrupted on another machine), fetch it from the remote: rebase recovery and the integrity check read the local branch.
  if (!trySh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issue.branch}`]).ok) {
    await gitRemoteOrThrow(["fetch", REMOTE, `${issue.branch}:${issue.branch}`]);
  }
  console.log(t(`  ↻ #${issue.id} 上次运行在等 PR #${pr.id} 的检查 / 合并时中断，接着等，不重新实现`, `  ↻ #${issue.id} was interrupted while waiting for checks / merging PR #${pr.id}; resuming that without reimplementing`));
  if (!project.autoMerge) {
    leaveForHuman(issue, pr.id, M.reasonAutoMergeOff);
    attempt(() => forge.removeLabel(issue.id, LABEL.merging));
    console.log(t(`  ◐ #${issue.id} autoMerge 关着，留 PR #${pr.id} 等人合并`, `  ◐ #${issue.id} autoMerge is off; PR #${pr.id} left for a human to merge`));
    return;
  }
  await finishMerge(issue, pr.id, host, "selected");
}

// ---------------------------------------------------------------------------
// main 上定期的兜底完整测试（2026-11-24）
// ---------------------------------------------------------------------------
// 按依赖选测试的票每合并 MAIN_CHECK_EVERY 张，对当时的 origin/main 跑一次完整测试（排在票的门槛后面，有票在等就让位；已开跑的不中断）。
// 兜住依赖图漏选，和「两张票各自通过、合在一起才坏」。失败就开一张带 LABEL.mainBroken 的修复票（调度时排最前），
// 自动合并照常、不暂停。状态存在 MAIN_CHECK_FILE：重启后接着计数，失败票里列出上次通过以来进 main 的提交。
// Periodic fallback full run on main (2026-11-24)
// After every MAIN_CHECK_EVERY merged dependency-selected tickets, run the full suite on the origin/main of the moment (queued behind tickets' gates, yielding while a ticket waits; a run already started is not interrupted).
// Catches what the dependency graph misses, and "two tickets that pass alone but break together". On failure open a fix ticket labelled LABEL.mainBroken (scheduled first);
// auto-merge carries on without pausing. State lives in MAIN_CHECK_FILE: counting resumes after a restart, and the failure ticket lists commits merged into main since the last pass.
const MAIN_CHECK_EVERY = project.mainCheckEvery;
const MAIN_CHECK_FILE = ".sandcastle/logs/main-check.json";
const MAIN_CHECK_ID = "main"; // 测试资源后缀 _imain，和票的 _i<n> 不撞 / test resource suffix _imain, distinct from tickets' _i<n>
type MainCheckState = { lastPass: string | null; selectedSince: number };
const readMainCheck = (): MainCheckState => {
  try {
    return JSON.parse(readFileSync(MAIN_CHECK_FILE, "utf8")) as MainCheckState;
  } catch {
    return { lastPass: null, selectedSince: 0 };
  }
};
const writeMainCheck = (s: MainCheckState) => {
  mkdirSync(dirname(MAIN_CHECK_FILE), { recursive: true });
  writeFileSync(MAIN_CHECK_FILE, `${JSON.stringify(s)}\n`);
};
let mainCheckRunning = false;

/**
 * 票合并后记一笔；按依赖选测试的票攒够 MAIN_CHECK_EVERY 张就在后台开跑兜底（不等它，不占宿主机锁）。
 * Record a merged ticket; once MAIN_CHECK_EVERY dependency-selected tickets accumulate, start the fallback in the background (not awaited, no host lock).
 */
function noteMerged(tier: GateTier) {
  const s = readMainCheck();
  if (tier === "selected") s.selectedSince++;
  writeMainCheck(s);
  if (s.selectedSince < MAIN_CHECK_EVERY || mainCheckRunning) return;
  mainCheckRunning = true;
  void runMainFullCheck()
    .catch((e) =>
      console.warn(
        t(
          `  ⚠ main 兜底完整测试没跑成：${e instanceof Error ? e.message : e}（下一张票合并后再试）`,
          `  ⚠ The fallback full run on main didn't run: ${e instanceof Error ? e.message : e} (will retry after the next merge)`,
        ),
      ),
    )
    .finally(() => (mainCheckRunning = false));
}

/**
 * 在沙箱里对 sha 跑一次完整门槛（GATE_FULL=1），跑完扔掉 worktree、分支和测试资源。
 * Run the full gate once on sha in a sandbox (GATE_FULL=1), then discard the worktree, branch and test resources.
 */
async function fullGateAt(sha: string): Promise<ExecResult> {
  // 本地分支先指到这个提交：createSandbox 从本地分支建 worktree（本地没有才从 main 新建，那时的 main 可能又变了）。
  // Point a local branch at this commit first: createSandbox builds the worktree from the local branch (only without one does it branch from main, which may have moved on).
  const branch = `sandcastle/main-check-${sha.slice(0, 8)}`;
  sh("git", ["branch", "-f", branch, sha]);
  const env = testEnv(MAIN_CHECK_ID);
  const sandbox = await sandcastle.createSandbox({ branch, baseBranch: BASE_REF, sandbox: sandboxFor(env), hooks, copyToWorktree });
  try {
    return await runGate((c, o) => sandbox.exec(c, o), MAIN_CHECK_ID, { ...env, GATE_FULL: "1" }, "fallback");
  } finally {
    await closeQuietly(MAIN_CHECK_ID, () => sandbox.close());
    await dropTestResources(MAIN_CHECK_ID);
    // 跑完就扔：worktree 里测试留下的文件不要（close 没删掉时强删），再删本地分支
    // Discard when done: files the tests left in the worktree aren't needed (force-remove if close didn't), then delete the local branch
    trySh("git", ["worktree", "remove", "--force", sandbox.worktreePath]);
    trySh("git", ["branch", "-D", branch]);
  }
}

/**
 * 接入新项目时的门槛基线（sandpipe baseline）：对 origin/main 跑一次完整门槛，只报告、不开票。
 * 通过时记为兜底完整测试的起点；失败说明门槛本身或 main 有问题，先修好再让 Sandcastle 做票。
 * Gate baseline when onboarding a project (sandpipe baseline): run the full gate once on origin/main, report only, no tickets.
 * A pass becomes the starting point for fallback full runs; a failure means the gate itself or main is broken; fix it before letting Sandcastle work tickets.
 */
async function runBaseline(): Promise<boolean> {
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const sha = sh("git", ["rev-parse", BASE_REF]);
  console.log(t(`门槛基线：在沙箱里对 ${BASE_REF}（${sha.slice(0, 8)}）跑一次完整门槛……`, `Gate baseline: running the full gate once against ${BASE_REF} (${sha.slice(0, 8)}) in a sandbox…`));
  const gate = await fullGateAt(sha);
  const flaky = gate.stdout.includes("GATE_FLAKY");
  console.log(`\n${gate.stdout.slice(-3000)}\n`);
  if (gate.exitCode !== 0) {
    console.log(
      t(
        "✗ 门槛基线没过：先修好 main 或 gate.script（见上面的输出），再让 Sandcastle 做票。",
        "✗ Gate baseline failed: fix main or gate.script first (see the output above) before letting Sandcastle work tickets.",
      ),
    );
    return false;
  }
  writeMainCheck({ lastPass: sha, selectedSince: 0 });
  console.log(
    flaky
      ? t(
          "✓ 门槛基线通过，但有偶发失败（重跑才过）：把 GATE_FLAKY 那几个文件记下来，先修或在门槛里排除。",
          "✓ Gate baseline passed, but with flaky failures (passed on rerun): note the files listed by GATE_FLAKY and fix them first or exclude them from the gate.",
        )
      : t("✓ 门槛基线通过。", "✓ Gate baseline passed."),
  );
  return true;
}

async function runMainFullCheck() {
  const sha = sh("git", ["rev-parse", BASE_REF]);
  const short = sha.slice(0, 8);
  const counted = readMainCheck().selectedSince;
  console.log(
    t(
      `  🛡 main 兜底完整测试排队：${short}（上次通过以来合并了 ${counted} 张按依赖选测试的票）`,
      `  🛡 Fallback full run on main queued: ${short} (${counted} dependency-selected tickets merged since the last pass)`,
    ),
  );
  const gate = await fullGateAt(sha);
  // 跑的期间又合并进来的票留给下一次兜底。 / Tickets merged while this runs are left for the next fallback run.
  const now = readMainCheck();
  const rest = Math.max(0, now.selectedSince - counted);
  if (gate.exitCode === 0) {
    writeMainCheck({ lastPass: sha, selectedSince: rest });
    const flaky = gate.stdout.includes("GATE_FLAKY");
    console.log(t(`  🛡 main 兜底完整测试通过：${short}${flaky ? "（有偶发失败，重跑通过）" : ""}`, `  🛡 Fallback full run on main passed: ${short}${flaky ? " (flaky failures passed on rerun)" : ""}`));
    return;
  }
  writeMainCheck({ lastPass: now.lastPass, selectedSince: rest });
  const commits = now.lastPass
    ? trySh("git", ["log", "--oneline", `${now.lastPass}..${sha}`]).out
    : `${M.mainBrokenNoHistory}\n${trySh("git", ["log", "--oneline", "-n", "20", sha]).out}`;
  const summary = `\`\`\`\n${gate.stdout.slice(-3000)}\n\`\`\``;
  const open = forge.listOpenIssues([LABEL.mainBroken]);
  if (open[0]) {
    forge.commentIssue(String(open[0].number), M.mainBrokenAgain(short, summary));
    console.log(t(`  🛡 main 兜底完整测试失败：${short}，已记在 #${open[0].number}`, `  🛡 Fallback full run on main failed: ${short}, recorded on #${open[0].number}`));
    return;
  }
  attempt(() => forge.ensureLabel(LABEL.mainBroken, "d73a4a", M.mainBrokenLabelDesc));
  const id = forge.createIssue({
    title: M.mainBrokenTitle(short),
    body: project.texts.mainBrokenIssueBody({ sha, summary, commits }),
    labels: [LABEL.mainBroken, LABEL.picked, LABEL.readyForAgent],
  });
  console.log(t(`  🛡 main 兜底完整测试失败：${short}，已开票 #${id}`, `  🛡 Fallback full run on main failed: ${short}, opened #${id}`));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * 宿主机上的 git 与平台标签操作串行做：调度（整理、prep、plan）和落地不交错，
 * 免得落地合并的同时清理删掉它的 worktree，或 prep 挂着的工作区被快进。build 在沙箱里跑，不占锁。
 * git and forge label operations on the host are serialized: scheduling (tidy, prep, plan) and landing don't interleave,
 * so cleanup can't delete a worktree while it's being landed and merged, and prep's mounted workspace isn't fast-forwarded under it. build runs in the sandbox without the lock.
 */
let hostTail: Promise<void> = Promise.resolve();
/** 排队拿锁（先来先得），返回释放函数。 / Queue for the lock (first come, first served); returns the release function. */
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
 * Run fn holding the lock. The HostGap fn receives can release the lock midway and queue for it again later: rebase recovery during landing runs the gate in a sandbox (the full suite
 * takes half an hour or more, maybe queued), and releasing the lock meanwhile lets scheduling start new tickets as usual (on 2026-11-24 #1165's rebase left a slot idle for about 40 minutes).
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

/**
 * 有票做完、让出空位时叫醒主循环；主循环没在等时记下来，下次等的时候立刻返回。
 * Wake the main loop when a ticket finishes and frees its slot; if the loop isn't waiting, remember it so the next wait returns immediately.
 */
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

/**
 * 正在 build 或落地的票。一张票从开工到落地完一直占着空位：落地里的 rebase 补救也要跑门槛（跑门槛时放开宿主机锁，调度照常开另一个空位）。
 * Tickets being built or landed. A ticket holds its slot from start to the end of landing: rebase recovery during landing also runs the gate (with the host lock released, so scheduling can fill another slot).
 */
const running = new Map<string, Issue>();

/**
 * 在等 forge 检查的票：仍在 running 里（不被重新开工、文件照样占着），但不算空位。
 * Tickets waiting for forge checks: still in running (not started again, their files still claimed), but not counted as slots.
 */
const ciWaiting = new Set<string>();
/** 占着空位的票数。 / Number of tickets holding a slot. */
const busy = () => running.size - ciWaiting.size;

/**
 * 一张票独立跑完 build → 落地，做完就让出空位，不等同批的其他票。
 * One ticket runs build → land on its own and frees its slot when done, without waiting for others in the same batch.
 */
function start(issue: Issue, resume = false) {
  running.set(issue.id, issue);
  void (async () => {
    // 撞上限额的票等重置后在原分支上重跑，不打 stuck。接着等合并的票（resume）不 build。
    // Tickets that hit a usage limit rerun on the same branch after the reset, without being marked stuck. Tickets resuming a merge (resume) skip build.
    const [outcome] = resume
      ? [undefined]
      : await Promise.allSettled([
          untilAfterLimit(`#${issue.id}`, () => retryTransient(`#${issue.id}`, () => build(issue)), () => pushIfAhead(issue), { comment: limitedComment(issue.id) }),
        ]);
    // 落地在宿主机上做：用宿主机的 git / 平台凭据，沙箱没有写仓库的权限。
    // 每张票单独兜底：一张票落地出错（网络、人在运行中途合并或删了分支等）不让整个运行崩掉。
    // Landing happens on the host with the host's git / forge credentials; the sandbox has no write access to the repo.
    // Each ticket is guarded separately: one ticket's landing error (network, a human merging or deleting the branch mid-run, etc.) doesn't crash the whole run.
    await withHost(async (host) => {
      try {
        await retryTransient(t(`落地 #${issue.id}`, `landing #${issue.id}`), () => (outcome ? land(issue, outcome, host) : resumeMerging(issue, host)));
      } catch (e) {
        logErrorDetail(ERROR_LOG, t(`#${issue.id} 落地`, `#${issue.id} landing`), e, appendFileSync);
        const reason = errorLine(e);
        console.error(t(`  ✗ #${issue.id} 落地出错：`, `  ✗ #${issue.id} landing failed: `) + reason);
        // 打 stuck 不让下次再做；本地分支保留，人看过后去掉 stuck 即可接着跑。
        // Marking stuck keeps it from being retried; the local branch is kept, and removing stuck after a human looks lets it continue.
        if (!issueClosed(issue.id)) attempt(() => forge.addLabel(issue.id, LABEL.stuck));
        // rebase 后的门槛撞上依赖服务连不上（#54）：同样写明匹配到的那一行。 / The gate after a rebase hit an unreachable service (#54): name the matched line here too.
        const envDown = gateEnvReason(e);
        const body = envDown !== null ? M.gateEnvDown(envDown, LABEL.stuck) : M.landError(issue.branch, reason, LABEL.stuck);
        if (!issueClosed(issue.id)) attempt(() => forge.commentIssue(issue.id, body));
      }
    });
  })()
    .catch((e) => {
      logErrorDetail(ERROR_LOG, `#${issue.id}`, e, appendFileSync);
      console.error(t(`  ✗ #${issue.id} 出错：`, `  ✗ #${issue.id} error: `) + errorLine(e));
    })
    .finally(() => {
      running.delete(issue.id);
      console.log(t(`  ⇢ #${issue.id} 让出空位（还有 ${running.size} 张在做）`, `  ⇢ #${issue.id} freed its slot (${running.size} still running)`));
      signalSlotFreed();
    });
}

/**
 * 本次运行里 prep 过、但没打上 prepped 也没拆的票，记下 prep 结束时 issue 的 updatedAt。
 * 轮询比原来按轮跑频繁得多，issue 没变就不再开 prep 会话；有人评论、改正文或改标签后再试。
 */
const prepTried = new Map<number, string>();

type ScheduleResult = { started: number; split: boolean; prepLimitedUntil?: number };

/** 一次调度：整理 → prep → plan，把空位补满。在 withHost 里跑。 / One pass: tidy → prep → plan, filling the slots. Runs inside withHost. */
async function schedule(): Promise<ScheduleResult> {
  // 运行中途 podman 挂掉又恢复后，留下的 Exited 容器库不会再删：每次调度清一次本仓库已退出的容器（在跑的可能是正在用的沙箱，不碰）。
  // After podman dies mid-run and comes back, the library won't remove the Exited containers it left: clear this repo's exited containers every pass (running ones may be live sandboxes and are left alone).
  if (!project.customSandbox) reportOrphans(removeOrphanContainers(process.cwd(), true));
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]); // 刚合并进远端 main 的代码 / code just merged into the remote main
  issueStates.clear();
  waitingOn.clear();
  syncHostBase();
  reopenRequestedRevisions();
  closeFinishedParents();
  await cleanupClosedIssues();
  try {
    project.beforeSchedule();
  } catch (e) {
    console.warn(t("  ⚠ 调度前的维护出错：", "  ⚠ Pre-scheduling maintenance failed: ") + String(e).slice(0, 300));
  }

  // Prep —— 串行，因为拆票会改别的票的 Blocked by。
  // 每次重新查询，所以上次拆出来的子票（继承了 Sandcastle 标签）这里会被看到。
  // 有 open blocker 的票脚本直接跳过，不开会话（prep agent 遇到这种票也只会什么都不改就结束）；
  // 跳过的票仍留在 toPrep 里，下面判断「这次拆出了新子票」时不会把它当成新票。
  // 撞上用量限额不在这里等（会占着宿主机锁，做完的票落不了地）：停止这次 prep，交给主循环决定等多久。
  // 按编号从小到大：和 plan 的顺序一致，早建的票（通常是后面票的 blocker）先 prep、先开工。
  // Prep is serial, because splitting tickets changes other tickets' Blocked by.
  // Re-queried every pass, so children split off last time (which inherit the Sandcastle label) show up here.
  // Tickets with open blockers are skipped without a session (a prep agent would end without changing anything anyway);
  // skipped tickets stay in toPrep, so the "new children were split off" check below doesn't count them as new.
  // Usage limits aren't waited out here (that would hold the host lock and block finished tickets from landing): stop this prep and let the main loop decide how long to wait.
  // Ascending number order, matching plan: older tickets (usually blockers of later ones) are prepped and started first.
  const toPrep = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
    .filter((issue) => allowed(issue.number))
    .sort(byUrgency);
  let prepLimitedUntil: number | undefined;
  const slots = MAX_PARALLEL - busy();
  for (const issue of toPrep) {
    // 已有够填满空位的可开工票就先开工，剩下的票等下次调度（有票做完或轮询）再 prep。
    // 否则一下子建了二十多张票时，要把它们逐张 prep 完（每张几分钟）才开工，空位空等一两个小时（2026-11-23）。
    // When there are already enough startable tickets to fill the slots, start them first and prep the rest next pass (when a ticket finishes or on the poll).
    // Otherwise, after twenty-odd tickets are created at once, every one would have to be prepped (minutes each) before any work starts, leaving slots idle for an hour or two (2026-11-23).
    if (slots > 0 && plan(new Set(running.keys()), slots, true).length >= slots) {
      console.log(t(`  已有 ${slots} 张可开工的票，先开工；其余票下次调度再 prep`, `  ${slots} ticket(s) ready to start, starting them first; the rest are prepped next pass`));
      break;
    }
    const missing = missingBlockers(issue.body);
    if (missing.length > 0) {
      stuckOnMissing(issue, missing);
      continue;
    }
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      waitingOn.set(issue.number, open);
      const blockers = open.map((n) => `#${n}`);
      console.log(t(`  跳过 prep #${issue.number}：blocker ${blockers.join("、")} 还没关`, `  Skipping prep #${issue.number}: blocker ${blockers.join(", ")} still open`));
      continue;
    }
    if (prepTried.get(issue.number) === issue.updatedAt) continue;
    console.log(`Prep #${issue.number}: ${issue.title}`);
    try {
      // 丢弃的数组：prep 用量落地时从 usage.jsonl 读回（可能是上一次进程跑的）。 / Discarded array: prep usage is read back from usage.jsonl on landing (it may have run in an earlier process).
      await runAgent("prep", String(issue.number), `prep-${issue.number}`, {}, [], (agent) => sandcastle.run({
        // 凭据清空的原因同 sandboxFor。 / Credentials cleared for the same reason as in sandboxFor.
        sandbox: project.sandbox({ ...CLAUDE_CREDENTIALS_CLEARED }),
        name: `prep-${issue.number}`,
        maxIterations: 1,
        idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_S,
        agent,
        promptFile: PROMPTS.prep,
        promptArgs: { TASK_ID: issue.number, REPREP_MARK, BASE: BASE_REF },
      }));
    } catch (e) {
      const limit = limitWait(e);
      if (limit) {
        const until = new Date(limit.until).toLocaleString();
        console.log(t(`  ⏸ prep #${issue.number} 撞上用量限额，${limit.why}${until} 前不再 prep`, `  ⏸ prep #${issue.number} hit the usage limit; ${limit.why}no more prep until ${until}`));
        prepLimitedUntil = limit.until;
        break;
      }
      logErrorDetail(ERROR_LOG, `prep #${issue.number}`, e, appendFileSync);
      console.error(t(`  ✗ prep #${issue.number} 出错：`, `  ✗ prep #${issue.number} error: `) + errorLine(e) + t(`（详情见 ${ERROR_LOG}）`, ` (details in ${ERROR_LOG})`));
    }
    const after = attempt(() => forge.issueUpdatedAt(String(issue.number)));
    if (after.ok) prepTried.set(issue.number, after.value);
  }

  // 上次运行在等检查 / 合并时中断的票：接着等，不重新实现（见 resumeMerging）。
  // Tickets interrupted last run while waiting for checks / merging: resume that, without reimplementing (see resumeMerging).
  for (const issue of listIssues([LABEL.picked, LABEL.merging], [LABEL.prOpen, LABEL.stuck]).sort(byUrgency)) {
    if (!allowed(issue.number) || running.has(String(issue.number))) continue;
    start({ id: String(issue.number), title: issue.title, branch: ownBranch(issue.number) }, true);
  }

  // Plan
  const issues = plan(new Set(running.keys()), MAX_PARALLEL - busy());
  if (issues.length === 0) {
    // 这次 prep 拆出的子票还没 prep 过（下次才看到），这时不能当作没活可做。
    // 只认这次新出现的票：留在 toPrep 里的票（如等 blocker）下次仍不会有新票。
    // Children split off by this prep haven't been prepped yet (they're seen next pass), so this can't count as having nothing to do.
    // Only tickets that newly appeared count: tickets left in toPrep (e.g. waiting on blockers) won't yield new ones next time either.
    const prepped = new Set(toPrep.map((issue) => issue.number));
    const split = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
      .filter((issue) => allowed(issue.number) && !prepped.has(issue.number));
    const children = split.map((issue) => `#${issue.number}`);
    if (split.length > 0) console.log(t(`拆出了子票 ${children.join("、")}，马上 prep。`, `Split off ${children.join(", ")}; prepping them now.`));
    return { started: 0, split: split.length > 0 && prepLimitedUntil === undefined, prepLimitedUntil };
  }
  for (const issue of issues) {
    console.log(`  ${t("开工", "Starting")} #${issue.id}: ${issue.title} → ${issue.branch}`);
    start(issue);
  }
  return { started: issues.length, split: false, prepLimitedUntil };
}

// 有空位就调度一次；然后等「有票做完」或「过了 POLL_INTERVAL_MS」，先到哪个算哪个。
// 等人审的 PR 合入、blocker 关闭、人去掉 stuck 之后，下一次轮询就能开工，不用等正在做的票做完。
// 没有票在做、也开不出新票时算一次空转；连续 MAX_ITERATIONS 次空转就结束运行。
// Schedule once when a slot is free; then wait for "a ticket finished" or "POLL_INTERVAL_MS passed", whichever comes first.
// Once a PR under review is merged, a blocker closes or a human removes stuck, the next poll can start work without waiting for running tickets.
// Nothing running and nothing startable counts as an idle poll; MAX_ITERATIONS idle polls in a row end the run.
// ---------------------------------------------------------------------------
// 开跑前：运行锁 → podman 检查 → 清孤儿容器；Ctrl-C 的提示（baseline 也一样，它也建沙箱）
// Before starting: run lock → podman check → orphan container cleanup; the Ctrl-C notice (baseline too, since it also creates sandboxes)
// ---------------------------------------------------------------------------
// 同一仓库同时只跑一个 sandpipe：两个进程会抢同一张票、同一个 worktree，清孤儿容器也会删掉对方正在用的。
// 锁文件里是 pid；上次被 SIGKILL 留下的锁，pid 已经不在了，直接接管。
// Only one sandpipe per repository at a time: two processes would fight over the same tickets and worktrees, and orphan cleanup would remove the other's live containers.
// The lock file holds the pid; a lock left by a SIGKILLed run has a dead pid and is taken over.
const runLock = acquireRunLock(runLockPath(process.cwd()));
if (!runLock.ok)
  throw new Error(
    t(
      `这个仓库里已经有一个 sandpipe 在跑（pid ${runLock.pid}）。等它结束或停掉它再运行；确认没有在跑的话删掉 ${RUN_LOCK_FILE}`,
      `Another sandpipe is already running in this repository (pid ${runLock.pid}). Wait for it to finish or stop it; if you're sure none is running, delete ${RUN_LOCK_FILE}`,
    ),
  );
process.on("exit", runLock.release);
onInterrupt(() => ({
  inProgress: [...running.keys()].filter((id) => !ciWaiting.has(id)),
  waitingChecks: [...ciWaiting],
}));
// 默认的 podman 沙箱：先确认 podman 能用（macOS 上 podman machine 没起时，之前会在 prep 里报一长串堆栈、最后提示「没有可开工的票」），
// 再删掉本仓库上次运行留下的容器（主进程被 SIGKILL、运行中途 podman 挂掉时库来不及删）。持有运行锁，这时本仓库的容器全是孤儿；别的仓库的不碰。
// With the default podman sandbox: first make sure podman works (on macOS with the podman machine stopped, prep used to print a long stack and end with "no tickets can start"),
// then remove this repository's containers left by the last run (the library can't remove them when the main process is SIGKILLed or podman dies mid-run). We hold the run lock, so all of this repo's containers are orphans now; other repositories' are never touched.
if (!project.customSandbox) {
  const problem = podmanProblem();
  if (problem)
    throw new Error(
      t(
        `podman 用不了：${problem}。macOS 上先运行 podman machine start，然后重试（sandpipe doctor 可以检查）`,
        `podman isn't usable: ${problem}. On macOS run podman machine start first, then retry (sandpipe doctor can check)`,
      ),
    );
  reportOrphans(removeOrphanContainers(process.cwd(), false));
}
// 门槛依赖的服务（gate.services）：启动时逐个连一次，连不上直接退出，不等第一张票跑到门槛才发现（#55）。
// Services the gate depends on (gate.services): connect to each once at startup and exit if any is unreachable, instead of finding out when the first ticket reaches the gate (#55).
{
  const problem = await servicesProblem(project.gate.services ?? [], probeTcp);
  if (problem) throw new Error(problem);
}
// 项目有页面（探测到网页界面或配了 browser.pagePaths）却没配浏览器验收：启动就警告，不等改页面的票留 PR 才发现。
// The project has pages (a detected web UI or browser.pagePaths set) but no browser check configured: warn at startup rather than when a page-changing ticket's PR is left open.
if ((project.browser.pagePaths.length > 0 || detectProject(process.cwd()).webUi) && !DOC.hasBrowser)
  console.warn(`⚠ ${browserSetupWarning(manual("config", termLanguage()))}`);
/** 打一行删掉了哪些孤儿容器。 / Print one line naming the orphan containers removed. */
function reportOrphans(removed: string[]) {
  if (removed.length === 0) return;
  console.log(
    t(
      `  🧹 删掉了本仓库上次运行留下的 ${removed.length} 个沙箱容器：${removed.join("、")}`,
      `  🧹 Removed ${removed.length} sandbox container(s) left by an earlier run of this repository: ${removed.join(", ")}`,
    ),
  );
}

if (process.env.SANDCASTLE_BASELINE === "1") {
  process.exitCode = (await runBaseline()) ? 0 : 1;
} else {
let idlePolls = 0;
let everStarted = false; // 这次运行开工过票没有 / whether this run ever started a ticket
for (let pass = 1; ; pass++) {
  // 每轮读一次 .sandcastle/models.json，不管有没有空位：改了配置不用重启，下一轮生效（#43：空位全满时也要读）。
  // Read .sandcastle/models.json every pass whether or not a slot is free: config changes apply next pass without a restart (#43: read even when every slot is taken).
  reloadModels();
  // 路径按实际读的写（设了 SANDCASTLE_PROJECT_DIR 时不是 .sandcastle/），相对当前目录。 / Show the path actually read (not .sandcastle/ when SANDCASTLE_PROJECT_DIR is set), relative to cwd.
  if (projectDocChanged()) {
    const file = relative(process.cwd(), projectDocPath());
    console.warn(t(`  ⚠ ${file} 已变更，需重启 sandpipe 才生效`, `  ⚠ ${file} changed; restart sandpipe for it to take effect`));
  }
  if (busy() < MAX_PARALLEL) {
    const now = new Date().toLocaleString();
    console.log(t(`\n=== 调度 ${pass}（${now}，${busy()}/${MAX_PARALLEL} 个空位已占）===\n`, `\n=== Pass ${pass} (${now}, ${busy()}/${MAX_PARALLEL} slots taken) ===\n`));
    const r = await withHost(schedule);
    if (r.split) continue;
    if (running.size > 0 || r.started > 0) {
      idlePolls = 0;
      everStarted = true;
    } else if (r.prepLimitedUntil !== undefined) {
      // 没票在做、prep 在等限额：等到重置再来，不算空转。 / Nothing running and prep is waiting on a limit: wait for the reset, not counted as idle.
      const until = new Date(r.prepLimitedUntil).toLocaleString();
      console.log(t(`没有票在做，等 prep 的用量限额到 ${until} 重置`, `Nothing running; waiting for prep's usage limit to reset at ${until}`));
      await sleepUntil(r.prepLimitedUntil);
      continue;
    } else {
      idlePolls++;
      if (idlePolls >= MAX_ITERATIONS) {
        console.log(
          t(
            `没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），连续空转 ${idlePolls} 次，结束运行。`,
            `No tickets can start (all waiting on blockers, PR reviews, or a human); ${idlePolls} idle polls in a row, stopping.`,
          ),
        );
        break;
      }
      const mins = POLL_INTERVAL_MS / 60_000;
      console.log(
        t(
          `没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），${mins} 分钟后再查（空转 ${idlePolls}/${MAX_ITERATIONS}）。`,
          `No tickets can start (all waiting on blockers, PR reviews, or a human); checking again in ${mins} min (idle ${idlePolls}/${MAX_ITERATIONS}).`,
        ),
      );
    }
  }
  await waitForSlotOrPoll(POLL_INTERVAL_MS);
}

// 最后合并的票在上次 fetch 之后才进远端，收尾再同步一次。
// The last merged tickets reached the remote after the previous fetch, so sync once more at the end.
await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
syncHostBase();
// 还有没有带 pr-open 的 open 票；查不到时当作有，照旧提醒去审。 / Whether any open ticket still has pr-open; if the query fails assume yes and keep the review reminder.
function prOpenLeft(): boolean {
  const r = attempt(() => listIssues([LABEL.prOpen]));
  return !r.ok || r.value.length > 0;
}
// 一张票都没开工时不说「全部完成」，改为说明空转原因。 / When no ticket was ever started, explain the idle exit instead of "All done".
console.log(
  everStarted
    ? t(
        `\n全部完成。本地 main 已快进到 ${BASE_REF}（不在 main 上时除外，见上面的警告）` +
          (prOpenLeft() ? `；带 ${LABEL.prOpen} 的票在 ${forge.name} 上等你审。` : "。"),
        `\nAll done. Local main is fast-forwarded to ${BASE_REF} (unless the host isn't on main, see the warnings above)` +
          (prOpenLeft() ? `; tickets labelled ${LABEL.prOpen} are waiting for your review on ${forge.name}.` : "."),
      )
    : `\n${idleSummary(waitingOn, LABEL)}`,
);
}

// 运行结束：事件循环空了就照常退出；依赖里漏掉的定时器还挂着时，过一会儿按退出码强制退出（原因见 lifecycle.ts 的 exitWhenDone）。
// Run finished: exit normally once the event loop is empty; if a timer leaked by the dependency is still pending, force the exit with the exit code shortly after (see exitWhenDone in lifecycle.ts).
exitWhenDone();
