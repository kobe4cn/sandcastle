// 合并收尾的编排：等 PR 上的检查（等的时候不占空位、放开宿主机锁）→ main-broken 检查 → 合并 → 分支保护 / rebase 补救 → 留 PR。
// 依赖全部从参数注入，由 main.ts 组装；本模块不 import main.ts（它加载时就跑主循环），测试注入假依赖。
// Orchestration of the merge finish: wait for the PR's checks (off the slot, with the host lock released) → the main-broken check → merge → branch protection / rebase recovery → leave the PR.
// All dependencies are injected as parameters and assembled by main.ts; this module never imports main.ts (it runs the main loop on load), and tests inject fakes.

import { setTimeout as delay } from "node:timers/promises";
import type { Forge, ForgeIssue, MergeMethod, PrCheck } from "./forge.ts";
import type { Messages } from "./i18n.ts";
import { splitChildren } from "./guide.ts";
import { type ChecksWait, isBranchProtectionError, waitForChecks } from "./merge-checks.ts";
import type { Project } from "./profile.ts";
import { attempt } from "./shell.ts";
import { t } from "./term.ts";

/**
 * 合并收尾要的依赖。waitForChecks / sleep / log / warn 不给就用真的，测试里注入假的。
 * Dependencies of the merge finish. waitForChecks / sleep / log / warn default to the real ones; tests inject fakes.
 */
export type MergeFlowDeps = {
  forge: Pick<Forge, "prChecks" | "prMergeable" | "mergePr" | "commentPr">;
  mergeMethod: MergeMethod;
  mergeRequires: Project["mergeRequires"];
  M: Pick<Messages, "reasonChecksFailed" | "reasonChecksTimeout" | "reasonBranchProtection" | "reasonMergeFailed" | "rebaseMergeFailed" | "rebasedMerged" | "reasonMainBroken" | "reasonMainBrokenUnknown">;
  baseRef: string;
  host: { release(): void; reacquire(): Promise<void> };
  ciWaiting: Set<string>;
  signalSlotFreed(): void;
  leaveForHuman(reason: string): void;
  /**
   * 给票打上 / 去掉「在等检查 / 合并」的标记（main.ts 里是 sandcastle:merging 标签）。进程在等的时候被杀掉，标签留着，
   * 重启后按它直接回到等检查 / 合并，不重新实现。出错只警告，由实现方兜住。
   * Put / remove the "waiting for checks / merging" mark on the ticket (the sandcastle:merging label in main.ts). If the process is killed while waiting the label stays,
   * and a restart goes straight back to waiting / merging instead of reimplementing. Errors only warn; the implementation handles them.
   */
  markMerging?(on: boolean): void;
  /**
   * 合并前查一次开着的 main-broken 票（ADR 0007）：有挡住本票的票时返回它的票号，没有时返回 undefined。
   * 列票出错时返回 error，由调用方按有票处理（fail-closed 留 PR）。main.ts 里是 forge.listOpenIssues。
   * Look up the open main-broken tickets once before merging (ADR 0007): returns the number of the one holding this ticket, or undefined when there's none.
   * A listing error returns error and the caller treats it as a hold (fail-closed, PR left open). In main.ts this is forge.listOpenIssues.
   */
  mainBrokenHold?(): { blocker: number } | { error: string } | undefined;
  waitForChecks?: typeof waitForChecks;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
};

/**
 * rebase 补救的结果。held 表示是被 main-broken 票挡下的（ADR 0007），带合并流程要打的那行终端输出，
 * 调用方照打、不写成合并失败。
 * The result of rebase recovery. held marks being held by a main-broken ticket (ADR 0007) and carries the terminal
 * line to print; the caller logs it instead of reporting a merge failure.
 */
export type MergeResult = { ok: true } | { ok: false; reason: string; held?: { line: string } };

/**
 * 开着的 main-broken 票会不会挡住这张票：挡时返回挡它的票号，不挡时返回 undefined。
 * main-broken 票本身、它们 `## Split into` 列出的子票都不挡（两张 main-broken 票互不挡，免得修复票互相死锁）；
 * 其他的票被第一张开着的 main-broken 票挡住（ADR 0007）。子票只认列表项，和 `blockersOf` 同一口径。
 * Whether an open main-broken ticket holds this ticket: the holding ticket's number when it does, undefined when not.
 * The main-broken tickets themselves and the children listed in their `## Split into` are never held (two main-broken
 * tickets never hold each other, so fix tickets can't deadlock); every other ticket is held by the first open one
 * (ADR 0007). Children are list items only, the same rule as `blockersOf`.
 */
export function mainBrokenBlocker(open: Pick<ForgeIssue, "number" | "body">[], issueId: string): number | undefined {
  const exempt = new Set(open.flatMap((i) => [i.number, ...splitChildren(i.body)]));
  return exempt.has(Number(issueId)) ? undefined : open[0]?.number;
}

/** main-broken 检查要留给人的原因和要打的终端行。 / The reason to leave for a human and the terminal line, from the main-broken check. */
type Hold = { reason: string; line: string };

/**
 * 查一次 main-broken hold（ADR 0007）：查到（有票挡住或列票出错）返回原因加终端行，没配 mainBrokenHold 或没票时返回 undefined。
 * 列票出错也返回 hold：fail-closed，评论写明查不到（和 protectedHits、needsReReview 一致）。
 * Look up the main-broken hold once (ADR 0007): a hit (a holding ticket or a listing error) returns the reason plus the
 * terminal line; undefined when mainBrokenHold isn't wired or no ticket is open. A listing error is also a hold:
 * fail-closed, with the comment saying why it couldn't be listed (like protectedHits and needsReReview).
 */
function holdOf(issueId: string, pr: string, d: MergeFlowDeps): Hold | undefined {
  const hold = d.mainBrokenHold?.();
  if (!hold) return undefined;
  if ("blocker" in hold) {
    return {
      reason: d.M.reasonMainBroken(hold.blocker),
      line: t(`  ◐ #${issueId} main 兜底测试失败，等 #${hold.blocker} 修好，留 PR #${pr}`, `  ◐ #${issueId} the fallback full test on main failed; waiting for #${hold.blocker} to be fixed; PR #${pr} left open`),
    };
  }
  return {
    reason: d.M.reasonMainBrokenUnknown(hold.error.slice(0, 200)),
    line: t(`  ◐ #${issueId} 查不到开着的 main-broken 票，留 PR #${pr}`, `  ◐ #${issueId} can't list the open main-broken tickets; PR #${pr} left open`),
  };
}

let warnedNoChecks = false; // forge 不支持查检查的警告只打一次 / warn only once that the forge can't list checks

/** 复位「只警告一次」的状态，供测试用。 / Reset the warn-once state, for tests. */
export function resetMergeFlowWarnings() {
  warnedNoChecks = false;
}

const logOf = (d: MergeFlowDeps) => d.log ?? ((msg: string) => console.log(msg));
const warnOf = (d: MergeFlowDeps) => d.warn ?? ((msg: string) => console.warn(msg));

/**
 * 把检查列成 `- 名字（链接）` 多行，给 PR 评论用。
 * List checks as `- name (link)` lines for a PR comment.
 */
function checksList(checks: PrCheck[]): string {
  return checks.map((c) => (c.link ? t(`- ${c.name}（${c.link}）`, `- ${c.name} (${c.link})`) : `- ${c.name}`)).join("\n");
}

/**
 * 检查没通过或超时时留给人的原因。
 * The reason left for a human when checks failed or timed out.
 */
function checksReason(r: Extract<ChecksWait, { why: "fail" | "timeout" }>, d: MergeFlowDeps): string {
  const list = checksList(r.checks);
  return r.why === "fail" ? d.M.reasonChecksFailed(list) : d.M.reasonChecksTimeout(list, d.mergeRequires.timeoutMinutes);
}

/**
 * PR 和目标分支冲突时的说明，留给人的原因里用。
 * The note for a PR that conflicts with its base, used in the reason left for a human.
 */
function conflictNote(pr: string, d: MergeFlowDeps): string {
  return t(`PR #${pr} 和 ${d.baseRef} 有冲突`, `PR #${pr} conflicts with ${d.baseRef}`);
}

/**
 * 等 PR 上的 forge 检查：等的时候票留在 running 里但不算空位，并放开宿主机锁；等完先移出 ciWaiting 再重新拿锁。
 * Wait for the forge checks on a PR: meanwhile the ticket stays in running but doesn't count as a slot, and the host lock is released; afterwards leave ciWaiting first, then take the lock again.
 */
export async function waitChecksOffSlot(issueId: string, pr: string, d: MergeFlowDeps): Promise<ChecksWait> {
  if (d.mergeRequires.checks === "none" || !d.forge.prChecks) return { ok: true };
  d.ciWaiting.add(issueId);
  d.signalSlotFreed();
  d.host.release();
  logOf(d)(t(`  ⧗ #${issueId} 等 PR #${pr} 上的检查（最多 ${d.mergeRequires.timeoutMinutes} 分钟，不占空位）`, `  ⧗ #${issueId} waiting for checks on PR #${pr} (up to ${d.mergeRequires.timeoutMinutes} minute${d.mergeRequires.timeoutMinutes === 1 ? "" : "s"}, not holding a slot)`));
  try {
    const r = await (d.waitForChecks ?? waitForChecks)(d.forge, pr, d.mergeRequires);
    if (r.ok && r.noChecks)
      logOf(d)(t(`  · #${issueId} 的 PR #${pr} 上没有检查（没有 CI），只按门槛合并`, `  · No checks on PR #${pr} for #${issueId} (no CI); merging on the gate alone`));
    return r;
  } finally {
    d.ciWaiting.delete(issueId);
    await d.host.reacquire();
  }
}

/**
 * land 的自动合并收尾：一致性检查过了先等检查再合并；合并失败时分支保护直接留 PR，其他情况走 rebase 补救。
 * 返回 "merged"（直接合并或 rebase 后合并）或 "left"（已留 PR 给人）。
 * The auto-merge finish of land: when the integrity check passed, wait for checks then merge; on merge failure, branch protection leaves the PR at once, anything else goes to rebase recovery.
 * Returns "merged" (merged directly or after a rebase) or "left" (PR left for a human).
 * 整个过程票上带着 markMerging 的标记，结束（含出错）时去掉。 / The ticket carries the markMerging mark throughout; it's removed at the end (including on errors).
 */
export async function mergeWhenReady(
  args: { issueId: string; pr: string; chainOk: boolean; brokenOut: string; rebase: () => Promise<MergeResult> },
  d: MergeFlowDeps,
): Promise<"merged" | "left"> {
  d.markMerging?.(true);
  try {
    return await mergeWhenReadyMarked(args, d);
  } finally {
    d.markMerging?.(false);
  }
}

/** mergeWhenReady 的主体，调用期间票上带着 markMerging 的标记。 / The body of mergeWhenReady, run while the ticket carries the markMerging mark. */
async function mergeWhenReadyMarked(
  args: { issueId: string; pr: string; chainOk: boolean; brokenOut: string; rebase: () => Promise<MergeResult> },
  d: MergeFlowDeps,
): Promise<"merged" | "left"> {
  const { issueId, pr, chainOk } = args;
  const log = logOf(d);
  let conflict = false;
  // 合并条件是门槛加 forge 检查：一致性检查过了才等检查，没过的走下面的 rebase 补救（里面会重新等）。
  // Merging requires the gate plus forge checks: only wait for checks when the integrity check passed; otherwise rebase recovery below waits again.
  if (chainOk) {
    if (d.mergeRequires.checks !== "none" && !d.forge.prChecks && !warnedNoChecks) {
      warnedNoChecks = true;
      warnOf(d)(t(`  ⚠ forge 不支持查 PR 上的检查，按没有检查合并（mergeRequires.checks: "${d.mergeRequires.checks}"）`, `  ⚠ The forge can't list PR checks; merging as if there were none (mergeRequires.checks: "${d.mergeRequires.checks}")`));
    }
    const checks = await waitChecksOffSlot(issueId, pr, d);
    // 有冲突的 PR 平台不跑 CI：不试合并，直接走下面的 rebase 补救。
    // The host runs no CI on a conflicting PR: skip the merge attempt and go straight to rebase recovery below.
    if (!checks.ok && checks.why === "conflict") {
      log(t(`  ↻ #${issueId} 的 ${conflictNote(pr, d)}，先 rebase`, `  ↻ #${issueId}: ${conflictNote(pr, d)}; rebasing first`));
      conflict = true;
    } else if (!checks.ok) {
      d.leaveForHuman(checksReason(checks, d));
      log(
        checks.why === "fail"
          ? t(`  ◐ #${issueId} PR 上的检查没通过，留 PR #${pr}`, `  ◐ #${issueId} checks on the PR failed; PR #${pr} left open`)
          : t(`  ◐ #${issueId} PR 上的检查超时没跑完，留 PR #${pr}`, `  ◐ #${issueId} checks on the PR still running at the deadline; PR #${pr} left open`),
      );
      return "left";
    }
  }
  // 等完检查、真正合并前查一次 main-broken（ADR 0007）：等检查期间才开出的票也能挡住。冲突 / 没过一致性检查的走
  // 下面的 rebase 补救，那里（mergeAfterPush）会在重试合并前再查一次。
  // The main-broken lookup (ADR 0007) runs after the wait and right before the merge, so a ticket opened during the
  // wait also holds. Conflicts / failed integrity checks go to rebase recovery below, which checks again (in
  // mergeAfterPush) before retrying the merge.
  if (chainOk && !conflict) {
    const hold = holdOf(issueId, pr, d);
    if (hold) {
      d.leaveForHuman(hold.reason);
      log(hold.line);
      return "left";
    }
  }
  let merged: ReturnType<typeof attempt<void>>;
  if (conflict) merged = { ok: false, out: conflictNote(pr, d) };
  else if (chainOk) merged = attempt(() => d.forge.mergePr(pr, d.mergeMethod));
  else merged = { ok: false, out: args.brokenOut };
  if (!merged.ok) {
    // 分支保护（审批、必需检查、合并队列）挡住时 rebase 也解决不了，直接留 PR。
    // When branch protection (reviews, required checks, merge queue) blocks the merge a rebase won't help; leave the PR open.
    if (isBranchProtectionError(merged.out)) {
      d.leaveForHuman(d.M.reasonBranchProtection(merged.out.slice(0, 300)));
      log(t(`  ◐ #${issueId} 被分支保护挡住，留 PR #${pr}`, `  ◐ #${issueId} blocked by branch protection; PR #${pr} left open`));
      return "left";
    }
    if (!conflict) log(t(`  ↻ #${issueId} 没能直接合并，rebase 到最新的 ${d.baseRef} 后重试`, `  ↻ #${issueId} couldn't merge directly; rebasing onto the latest ${d.baseRef} and retrying`));
    const retry = await args.rebase();
    if (!retry.ok) {
      // rebase 补救里被 main-broken 挡下（ADR 0007）：照打带票号的那行，不写成「合并失败」。
      // Held by a main-broken ticket inside rebase recovery (ADR 0007): log the line with the ticket number instead of reporting a merge failure.
      if (retry.held) {
        d.leaveForHuman(retry.reason);
        log(retry.held.line);
        return "left";
      }
      d.leaveForHuman(d.M.reasonMergeFailed(merged.out.slice(0, 300), retry.reason));
      log(t(`  ◐ #${issueId} 合并失败，留 PR #${pr}`, `  ◐ #${issueId} merge failed; PR #${pr} left open`));
      return "left";
    }
  }
  return "merged";
}

/**
 * rebase 补救 force-push 之后的尾段：等检查通过，再最多重试 3 次合并（每次前等 10 秒）。
 * The tail of rebase recovery after the force-push: wait for checks to pass, then try merging up to 3 times (waiting 10 seconds before each).
 */
export async function mergeAfterPush(issueId: string, pr: string, d: MergeFlowDeps): Promise<MergeResult> {
  const sleep = d.sleep ?? ((ms: number) => delay(ms));
  // force-push 后 PR 上的检查重新跑：等它们通过再合并（等的时候放开宿主机锁、不占空位）。
  // After the force-push the PR's checks rerun: wait for them to pass before merging (releasing the host lock and the slot meanwhile).
  const checks = await waitChecksOffSlot(issueId, pr, d);
  if (!checks.ok) return { ok: false, reason: checks.why === "conflict" ? d.M.rebaseMergeFailed(conflictNote(pr, d)) : checksReason(checks, d) };
  // force-push 后、重试合并前再查一次 main-broken（ADR 0007）：等检查期间才开出的票也挡得住，不调 mergePr。
  // The main-broken lookup (ADR 0007) runs again after the force-push and before the merge retries: a ticket opened
  // during the wait holds too, and mergePr is never called.
  const hold = holdOf(issueId, pr, d);
  if (hold) return { ok: false, reason: hold.reason, held: { line: hold.line } };
  // 平台重新计算可合并状态要一点时间。 / The forge needs a moment to recompute mergeability.
  let last = "";
  for (let tries = 0; tries < 3; tries++) {
    await sleep(10_000);
    const merged = attempt(() => d.forge.mergePr(pr, d.mergeMethod));
    if (merged.ok) {
      d.forge.commentPr(pr, d.M.rebasedMerged(d.baseRef));
      return { ok: true };
    }
    // 分支保护挡住的再重试也没用，直接交给人。 / Retrying won't get past branch protection; hand it to a human.
    if (isBranchProtectionError(merged.out)) return { ok: false, reason: d.M.reasonBranchProtection(merged.out.slice(0, 300)) };
    last = merged.out;
  }
  return { ok: false, reason: d.M.rebaseMergeFailed(last.slice(0, 300)) };
}
