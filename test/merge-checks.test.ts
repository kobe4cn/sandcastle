// merge-checks：检查结果的归类与 waitForChecks 的轮询（假时钟，不真等）。
import { describe, expect, it } from "vitest";
import type { PrCheck } from "../src/forge.ts";
import { checksVerdict, isBranchProtectionError, waitForChecks } from "../src/merge-checks.ts";

const pass = (name: string): PrCheck => ({ name, state: "pass" });
const fail = (name: string): PrCheck => ({ name, state: "fail" });
const pending = (name: string): PrCheck => ({ name, state: "pending" });

type Mergeable = "conflicting" | "clean" | "unknown";

/** 给假 forge 加 prMergeable：按顺序回放，回放完后重复最后一个；Error 会被抛出。调用单独记在 mergeableCalls。 */
function withMergeable<F extends object>(forge: F, ...rounds: (Mergeable | Error)[]) {
  const mergeableCalls: string[] = [];
  return Object.assign(forge, {
    mergeableCalls,
    prMergeable(id: string) {
      mergeableCalls.push(id);
      const r = rounds.length > 1 ? rounds.shift()! : rounds[0];
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

/** 可推进的假时钟：sleep 直接把时间往前推。 */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

/** 按顺序回放结果的假 forge；回放完后重复最后一个。Error 会被抛出。 */
function fakeForge(...rounds: (PrCheck[] | Error)[]) {
  const calls: [string, boolean][] = [];
  return {
    calls,
    prChecks(id: string, requiredOnly: boolean) {
      calls.push([id, requiredOnly]);
      const r = rounds.length > 1 ? rounds.shift()! : rounds[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const all = { checks: "all" as const, timeoutMinutes: 30 };

describe("checksVerdict", () => {
  it("有失败就是 fail，否则有 pending 就是 pending，否则 pass（空数组也是）", () => {
    expect(checksVerdict([pass("a"), pending("b"), fail("c")])).toEqual({ kind: "fail", failed: [fail("c")] });
    expect(checksVerdict([pass("a"), pending("b")])).toEqual({ kind: "pending", pending: [pending("b")] });
    expect(checksVerdict([pass("a")])).toEqual({ kind: "pass" });
    expect(checksVerdict([])).toEqual({ kind: "pass" });
  });
});

describe("waitForChecks", () => {
  it("轮询到全部通过", async () => {
    const c = clock();
    const forge = fakeForge([pending("ci")], [pending("ci")], [pass("ci")]);
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true });
    expect(forge.calls).toEqual([["13", false], ["13", false], ["13", false]]);
    expect(c.slept).toEqual([30_000, 30_000]);
  });

  it("有失败立刻返回失败并列出失败的检查", async () => {
    const c = clock();
    const forge = fakeForge([pending("a"), fail("b"), pass("c")]);
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: false, why: "fail", checks: [fail("b")] });
    expect(c.slept).toEqual([]);
  });

  it("一直有 pending 到超时：返回 timeout 并列出还在跑的", async () => {
    const c = clock();
    const forge = fakeForge([pass("a"), pending("b")]);
    expect(await waitForChecks(forge, "13", { checks: "all", timeoutMinutes: 2 }, c)).toEqual({ ok: false, why: "timeout", checks: [pending("b")] });
    expect(c.now()).toBe(2 * 60_000);
  });

  it("空列表宽限期内继续等，宽限期过了仍为空当作没有 CI", async () => {
    const c = clock();
    const forge = fakeForge([]);
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true, noChecks: true });
    expect(c.now()).toBe(60_000);
    expect(forge.calls).toHaveLength(3);
  });

  it("空列表且 PR 有冲突：连续两轮都冲突才返回 conflict（刚 push 完平台可能还是旧状态），不等满宽限期", async () => {
    const c = clock();
    const forge = withMergeable(fakeForge([]), "conflicting");
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: false, why: "conflict" });
    expect(c.slept).toEqual([30_000]);
    expect(forge.mergeableCalls).toEqual(["13", "13"]);
  });

  it("空列表、可合并状态先 unknown 后 conflicting：连续两轮冲突后返回 conflict", async () => {
    const c = clock();
    const forge = withMergeable(fakeForge([]), "unknown", "conflicting");
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: false, why: "conflict" });
    expect(c.slept).toEqual([30_000, 30_000]);
    expect(forge.mergeableCalls).toHaveLength(3);
  });

  it("先冲突后不冲突（旧状态）：不算冲突，宽限期后照旧当作没有 CI", async () => {
    const c = clock();
    const forge = withMergeable(fakeForge([]), "conflicting", "clean");
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true, noChecks: true });
    expect(c.now()).toBe(60_000);
  });

  it("宽限期到时刚第一次看到冲突：多等一轮确认，不当作没有 CI", async () => {
    const c = clock();
    const forge = withMergeable(fakeForge([]), "unknown", "unknown", "conflicting");
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: false, why: "conflict" });
    expect(c.now()).toBe(90_000);
  });

  it("冲突待确认时到了总超时：照旧当作没有 CI（合并失败后再走 rebase）", async () => {
    const c = clock();
    const forge = withMergeable(fakeForge([]), "unknown", "unknown", "conflicting");
    expect(await waitForChecks(forge, "13", { checks: "all", timeoutMinutes: 1 }, c)).toEqual({ ok: true, noChecks: true });
  });

  it("空列表且 PR 没冲突（或查可合并状态抛错）：宽限期后照旧当作没有 CI", async () => {
    for (const m of ["clean", new Error("network")] as const) {
      const c = clock();
      const forge = withMergeable(fakeForge([]), m);
      expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true, noChecks: true });
      expect(c.now()).toBe(60_000);
      expect(forge.calls).toHaveLength(3);
    }
  });

  it("有检查的轮次不查可合并状态", async () => {
    const forge = withMergeable(fakeForge([pending("ci")], [pass("ci")]), "conflicting");
    expect(await waitForChecks(forge, "13", all, clock())).toEqual({ ok: true });
    expect(forge.mergeableCalls).toEqual([]);
  });

  it("宽限期内检查登记上了就照常等", async () => {
    const c = clock();
    const forge = fakeForge([], [fail("ci")]);
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: false, why: "fail", checks: [fail("ci")] });
  });

  it("prChecks 抛错当作这一轮还在跑", async () => {
    const c = clock();
    const forge = fakeForge(new Error("network"), [pass("ci")]);
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true });
    expect(forge.calls).toHaveLength(2);
  });

  it("checks 为 required 时只查必需的检查", async () => {
    const forge = fakeForge([pass("ci")]);
    await waitForChecks(forge, "7", { checks: "required", timeoutMinutes: 30 }, clock());
    expect(forge.calls).toEqual([["7", true]]);
  });

  it("checks 为 none 或 forge 没有 prChecks 时不调用、直接通过", async () => {
    const forge = fakeForge([fail("ci")]);
    expect(await waitForChecks(forge, "13", { checks: "none", timeoutMinutes: 30 }, clock())).toEqual({ ok: true });
    expect(forge.calls).toEqual([]);
    expect(await waitForChecks({}, "13", all, clock())).toEqual({ ok: true });
  });
});

describe("isBranchProtectionError", () => {
  it.each([
    ["X Pull request #12 is not mergeable: the base branch policy prohibits the merge.", true],
    ["GraphQL: Required status check \"ci\" is expected. (mergePullRequest)", true],
    ["At least 1 approving review is required by reviewers with write access.", true],
    ["Review is required before merging", true],
    ["remote: error: GH006: Protected branch update failed for refs/heads/main.", true],
    ["BASE BRANCH POLICY PROHIBITS THE MERGE", true],
    ["Pull request is not mergeable: the merge commit cannot be cleanly created", false],
    ["Could not resolve host: github.com", false],
    ["", false],
  ])("%j → %s", (out, expected) => {
    expect(isBranchProtectionError(out)).toBe(expected);
  });
});
