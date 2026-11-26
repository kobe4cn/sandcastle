// merge-checks：检查结果的归类与 waitForChecks 的轮询（假时钟，不真等）。
import { describe, expect, it } from "vitest";
import type { PrCheck } from "../src/forge.ts";
import { checksVerdict, waitForChecks } from "../src/merge-checks.ts";

const pass = (name: string): PrCheck => ({ name, state: "pass" });
const fail = (name: string): PrCheck => ({ name, state: "fail" });
const pending = (name: string): PrCheck => ({ name, state: "pending" });

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
    expect(await waitForChecks(forge, "13", all, c)).toEqual({ ok: true });
    expect(c.now()).toBe(60_000);
    expect(forge.calls).toHaveLength(3);
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
