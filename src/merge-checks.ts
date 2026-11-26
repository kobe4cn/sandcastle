// 合并前等 forge 检查（CI、状态检查）：land 在门槛通过后、合并 PR 前调用 waitForChecks。
// 检查结果归成通过 / 还在跑 / 失败；有失败立刻返回，一直有还在跑的到超时为止。时钟可注入，测试不用真等。
// Wait for forge checks (CI, status checks) before merging: land calls waitForChecks after the gate passes and before merging the PR.
// Results are reduced to pass / pending / fail; any failure returns at once, pending checks are polled until the timeout. The clock is injectable so tests don't really wait.

import { setTimeout as delay } from "node:timers/promises";
import type { Forge, PrCheck } from "./forge.ts";
import type { Project } from "./profile.ts";

/** 一组检查的结论。 / The verdict on a set of checks. */
export type ChecksVerdict = { kind: "pass" } | { kind: "pending"; pending: PrCheck[] } | { kind: "fail"; failed: PrCheck[] };

/**
 * 有失败就是 fail（不等其余跑完），否则有还在跑的就是 pending，否则 pass（空数组也算 pass）。
 * Any failure means fail (without waiting for the rest), otherwise any pending means pending, otherwise pass (an empty array passes too).
 */
export function checksVerdict(checks: PrCheck[]): ChecksVerdict {
  const failed = checks.filter((c) => c.state === "fail");
  if (failed.length) return { kind: "fail", failed };
  const pending = checks.filter((c) => c.state === "pending");
  if (pending.length) return { kind: "pending", pending };
  return { kind: "pass" };
}

/** waitForChecks 的结果；超时用 why 区分，不抛错。 / waitForChecks's result; a timeout is told apart by why, never thrown. */
export type ChecksWait = { ok: true; noChecks?: true } | { ok: false; why: "fail"; checks: PrCheck[] } | { ok: false; why: "timeout"; checks: PrCheck[] };

/** waitForChecks 的可选参数（测试注入时钟）。 / Optional parameters for waitForChecks (tests inject the clock). */
export type ChecksWaitOptions = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 轮询间隔，默认 30 秒。 / Poll interval, default 30 seconds. */
  pollMs?: number;
  /**
   * 空列表的宽限期，默认 60 秒：刚 push 完平台可能还没登记检查，过了宽限期仍为空才当作没有 CI。
   * Grace period for an empty list, default 60 seconds: right after a push the host may not have registered checks yet; only still empty after it means no CI.
   */
  emptyGraceMs?: number;
};

/**
 * 轮询 PR 上的检查直到全部通过、有失败或超时。checks 为 "none" 或 forge 没有 prChecks 时直接通过；prChecks 抛错当作这一轮还在跑。
 * Poll the PR's checks until all pass, one fails, or the timeout hits. Passes at once when checks is "none" or the forge has no prChecks; a prChecks error counts as pending for that round.
 */
export async function waitForChecks(
  forge: Pick<Forge, "prChecks">,
  pr: string,
  req: Project["mergeRequires"],
  opts: ChecksWaitOptions = {},
): Promise<ChecksWait> {
  if (req.checks === "none" || !forge.prChecks) return { ok: true };
  const sleep = opts.sleep ?? ((ms: number) => delay(ms).then(() => {}));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 30_000;
  const emptyGraceMs = opts.emptyGraceMs ?? 60_000;
  const start = now();
  const deadline = start + req.timeoutMinutes * 60_000;
  let pending: PrCheck[] = [];
  for (;;) {
    let checks: PrCheck[] | undefined;
    try {
      checks = forge.prChecks(pr, req.checks === "required");
    } catch {
      // 网络抖动：当作这一轮还在跑 / Network hiccup: treat this round as pending
      checks = undefined;
    }
    const expired = now() >= deadline;
    if (checks) {
      if (checks.length === 0) {
        // 宽限期过了（或已到超时）仍为空：当作没有 CI / Still empty after the grace period (or at the timeout): treat as no CI
        if (now() - start >= emptyGraceMs || expired) return { ok: true, noChecks: true };
      } else {
        const v = checksVerdict(checks);
        if (v.kind === "pass") return { ok: true };
        if (v.kind === "fail") return { ok: false, why: "fail", checks: v.failed };
        pending = v.pending;
      }
    }
    if (expired) return { ok: false, why: "timeout", checks: pending };
    await sleep(pollMs);
  }
}

/** gh 合并时被分支保护挡住的报错特征（不区分大小写）。 / Signatures of gh merge errors caused by branch protection (case-insensitive). */
const BRANCH_PROTECTION_RE = /base branch policy prohibits the merge|required status check|review is required|approving review|protected branch/i;

/**
 * 合并失败的输出是不是分支保护挡住的（要求审批、必需检查、合并队列等）；只看报错文本，不查保护规则（那要 admin 权限）。
 * Whether a failed merge's output means branch protection blocked it (required reviews, required checks, merge queue, ...); judged from the error text only, without reading the rules (that needs admin rights).
 */
export function isBranchProtectionError(out: string): boolean {
  return BRANCH_PROTECTION_RE.test(out);
}
