// 合并收尾的编排：等 PR 上的检查（等的时候不占空位、放开宿主机锁）→ 合并 → 分支保护 / rebase 补救 → 留 PR。
// 依赖全部从参数注入，由 main.ts 组装；本模块不 import main.ts（它加载时就跑主循环），测试注入假依赖。
// Orchestration of the merge finish: wait for the PR's checks (off the slot, with the host lock released) → merge → branch protection / rebase recovery → leave the PR.
// All dependencies are injected as parameters and assembled by main.ts; this module never imports main.ts (it runs the main loop on load), and tests inject fakes.

import { setTimeout as delay } from "node:timers/promises";
import type { Forge, MergeMethod, PrCheck } from "./forge.ts";
import type { Messages } from "./i18n.ts";
import { type ChecksWait, isBranchProtectionError, waitForChecks } from "./merge-checks.ts";
import type { Project } from "./profile.ts";
import { attempt } from "./shell.ts";
import { t } from "./term.ts";

/**
 * 合并收尾要的依赖。waitForChecks / sleep / log / warn 不给就用真的，测试里注入假的。
 * Dependencies of the merge finish. waitForChecks / sleep / log / warn default to the real ones; tests inject fakes.
 */
export type MergeFlowDeps = {
  forge: Pick<Forge, "prChecks" | "mergePr" | "commentPr">;
  mergeMethod: MergeMethod;
  mergeRequires: Project["mergeRequires"];
  M: Pick<Messages, "reasonChecksFailed" | "reasonChecksTimeout" | "reasonBranchProtection" | "reasonMergeFailed" | "rebaseMergeFailed" | "rebasedMerged">;
  baseRef: string;
  host: { release(): void; reacquire(): Promise<void> };
  ciWaiting: Set<string>;
  signalSlotFreed(): void;
  leaveForHuman(reason: string): void;
  waitForChecks?: typeof waitForChecks;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
};

/** rebase 补救的结果。 / The result of rebase recovery. */
export type MergeResult = { ok: true } | { ok: false; reason: string };

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
function checksReason(r: Extract<ChecksWait, { ok: false }>, d: MergeFlowDeps): string {
  const list = checksList(r.checks);
  return r.why === "fail" ? d.M.reasonChecksFailed(list) : d.M.reasonChecksTimeout(list, d.mergeRequires.timeoutMinutes);
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
 */
export async function mergeWhenReady(
  args: { issueId: string; pr: string; chainOk: boolean; brokenOut: string; rebase: () => Promise<MergeResult> },
  d: MergeFlowDeps,
): Promise<"merged" | "left"> {
  const { issueId, pr, chainOk } = args;
  const log = logOf(d);
  // 合并条件是门槛加 forge 检查：一致性检查过了才等检查，没过的走下面的 rebase 补救（里面会重新等）。
  // Merging requires the gate plus forge checks: only wait for checks when the integrity check passed; otherwise rebase recovery below waits again.
  if (chainOk) {
    if (d.mergeRequires.checks !== "none" && !d.forge.prChecks && !warnedNoChecks) {
      warnedNoChecks = true;
      warnOf(d)(t(`  ⚠ forge 不支持查 PR 上的检查，按没有检查合并（mergeRequires.checks: "${d.mergeRequires.checks}"）`, `  ⚠ The forge can't list PR checks; merging as if there were none (mergeRequires.checks: "${d.mergeRequires.checks}")`));
    }
    const checks = await waitChecksOffSlot(issueId, pr, d);
    if (!checks.ok) {
      d.leaveForHuman(checksReason(checks, d));
      log(
        checks.why === "fail"
          ? t(`  ◐ #${issueId} PR 上的检查没通过，留 PR #${pr}`, `  ◐ #${issueId} checks on the PR failed; PR #${pr} left open`)
          : t(`  ◐ #${issueId} PR 上的检查超时没跑完，留 PR #${pr}`, `  ◐ #${issueId} checks on the PR still running at the deadline; PR #${pr} left open`),
      );
      return "left";
    }
  }
  const merged = chainOk
    ? attempt(() => d.forge.mergePr(pr, d.mergeMethod))
    : { ok: false as const, out: args.brokenOut };
  if (!merged.ok) {
    // 分支保护（审批、必需检查、合并队列）挡住时 rebase 也解决不了，直接留 PR。
    // When branch protection (reviews, required checks, merge queue) blocks the merge a rebase won't help; leave the PR open.
    if (isBranchProtectionError(merged.out)) {
      d.leaveForHuman(d.M.reasonBranchProtection(merged.out.slice(0, 300)));
      log(t(`  ◐ #${issueId} 被分支保护挡住，留 PR #${pr}`, `  ◐ #${issueId} blocked by branch protection; PR #${pr} left open`));
      return "left";
    }
    log(t(`  ↻ #${issueId} 没能直接合并，rebase 到最新的 ${d.baseRef} 后重试`, `  ↻ #${issueId} couldn't merge directly; rebasing onto the latest ${d.baseRef} and retrying`));
    const retry = await args.rebase();
    if (!retry.ok) {
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
  if (!checks.ok) return { ok: false, reason: checksReason(checks, d) };
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
