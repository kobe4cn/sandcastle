// merge-flow：合并收尾的编排（等检查、分支保护、rebase 补救、空位与锁的时序），依赖全部用假的。
import { beforeEach, describe, expect, it } from "vitest";
import type { PrCheck } from "../src/forge.ts";
import { messages } from "../src/i18n.ts";
import type { ChecksWait } from "../src/merge-checks.ts";
import { type MergeFlowDeps, mainBrokenBlocker, mergeAfterPush, mergeWhenReady, resetMergeFlowWarnings, waitChecksOffSlot } from "../src/merge-flow.ts";
import { setTermLanguage } from "../src/term.ts";

const M = messages("zh");
const BASE = "origin/main";
const PROTECTED = "GraphQL: Base branch policy prohibits the merge";
/** 检查前发现 PR 和 main 冲突时留给人的冲突说明。 */
const PR_CONFLICT = `PR #42 和 ${BASE} 有冲突`;
const CONFLICT = "Pull request is not mergeable: the merge commit cannot be cleanly created";

const ci: PrCheck = { name: "ci", state: "fail", link: "https://ci/1" };
const lint: PrCheck = { name: "lint", state: "pending" };

/** gh 报错的样子：attempt 取 stderr 作为 out。 */
const ghError = (stderr: string) => Object.assign(new Error("gh failed"), { stderr });

type Opts = {
  checks?: "none" | "required" | "all";
  noPrChecks?: boolean;
  wait?: ChecksWait | Error;
  merges?: (true | string)[];
  /** 合并前查 main-broken 票的假实现（main.ts 里是 forge.listOpenIssues），不给就不配 mainBrokenHold。 */
  hold?: MergeFlowDeps["mainBrokenHold"];
};

/** 假依赖：所有调用按顺序记进 events。mergePr 按 merges 队列回放：true 成功，字符串当作 gh 报错抛出。 */
function fakeDeps(o: Opts = {}) {
  const events: string[] = [];
  const merges = [...(o.merges ?? [true])];
  const left: string[] = [];
  const comments: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const ciWaiting = new Set<string>();
  const forge: MergeFlowDeps["forge"] = {
    mergePr(pr, method) {
      events.push(`mergePr ${pr} ${method}`);
      const r = merges.length > 1 ? merges.shift()! : merges[0];
      if (r !== true) throw ghError(r);
    },
    commentPr(pr, body) {
      events.push(`commentPr ${pr}`);
      comments.push(body);
    },
  };
  if (!o.noPrChecks) forge.prChecks = () => [];
  const d: MergeFlowDeps = {
    forge,
    mergeMethod: "squash",
    mergeRequires: { checks: o.checks ?? "all", timeoutMinutes: 30 },
    M,
    baseRef: BASE,
    host: {
      release: () => void events.push("release"),
      reacquire: async () => void events.push("reacquire"),
    },
    ciWaiting: {
      add: (id: string) => (events.push(`ciWaiting.add ${id}`), ciWaiting.add(id)),
      delete: (id: string) => (events.push(`ciWaiting.delete ${id}`), ciWaiting.delete(id)),
    } as Set<string>,
    signalSlotFreed: () => void events.push("signalSlotFreed"),
    leaveForHuman: (reason) => {
      events.push("leaveForHuman");
      left.push(reason);
    },
    waitForChecks: async () => {
      events.push("wait");
      if (o.wait instanceof Error) throw o.wait;
      return o.wait ?? { ok: true };
    },
    sleep: async (ms) => void events.push(`sleep ${ms}`),
    log: (m) => void logs.push(m),
    warn: (m) => void warns.push(m),
  };
  if (o.hold) d.mainBrokenHold = o.hold;
  return { d, events, left, comments, logs, warns };
}

beforeEach(() => {
  setTermLanguage("zh", {});
  resetMergeFlowWarnings();
});

const ok = { ok: true } as const;
/** waitChecksOffSlot 的事件顺序。 */
const order = ["ciWaiting.add 7", "signalSlotFreed", "release", "wait", "ciWaiting.delete 7", "reacquire"];
const failList = "- ci（https://ci/1）";
const timeoutList = "- lint";

describe("mainBrokenBlocker", () => {
  const issue = (number: number, body: string) => ({ number, body });

  it("没有开着的 main-broken 票 → 不挡", () => {
    expect(mainBrokenBlocker([], "7")).toBeUndefined();
  });

  it("有开着的 main-broken 票 → 挡，返回第一张的票号", () => {
    expect(mainBrokenBlocker([issue(31, "")], "7")).toBe(31);
    expect(mainBrokenBlocker([issue(31, ""), issue(35, "")], "7")).toBe(31);
  });

  it("本票就是 main-broken 票 → 不挡", () => {
    expect(mainBrokenBlocker([issue(31, "")], "31")).toBeUndefined();
  });

  it("本票在某张 main-broken 票的 Split into 列表项里 → 不挡", () => {
    expect(mainBrokenBlocker([issue(31, "## Split into\n\n- [ ] #32\n- #33")], "33")).toBeUndefined();
  });

  it("两张 main-broken 票互不挡（免得死锁），别的票被第一张挡", () => {
    const open = [issue(31, ""), issue(35, "## Split into\n\n- #36")];
    expect(mainBrokenBlocker(open, "31")).toBeUndefined();
    expect(mainBrokenBlocker(open, "35")).toBeUndefined();
    expect(mainBrokenBlocker(open, "36")).toBeUndefined();
    expect(mainBrokenBlocker(open, "7")).toBe(31);
  });

  it("Split into 列表项之外的票号不算子票，照挡", () => {
    expect(mainBrokenBlocker([issue(31, "## Split into\n\n- #32\n\n说明：另见 #40")], "40")).toBe(31);
  });
});

describe("mergeWhenReady", () => {
  it.each<{
    name: string;
    opts: Opts;
    chainOk?: boolean;
    rebase?: { ok: true } | { ok: false; reason: string };
    result: "merged" | "left";
    merged: boolean;
    rebased: boolean;
    reason?: string;
  }>([
    { name: "检查通过 → 合并", opts: {}, result: "merged", merged: true, rebased: false },
    { name: "检查失败 → 留 PR，原因含检查名和链接", opts: { wait: { ok: false, why: "fail", checks: [ci] } }, result: "left", merged: false, rebased: false, reason: M.reasonChecksFailed(failList) },
    { name: "检查超时 → 留 PR", opts: { wait: { ok: false, why: "timeout", checks: [lint] } }, result: "left", merged: false, rebased: false, reason: M.reasonChecksTimeout(timeoutList, 30) },
    { name: "checks: none → 直接合并", opts: { checks: "none", wait: { ok: false, why: "fail", checks: [ci] } }, result: "merged", merged: true, rebased: false },
    { name: "forge 没有 prChecks → 直接合并", opts: { noPrChecks: true, wait: { ok: false, why: "fail", checks: [ci] } }, result: "merged", merged: true, rebased: false },
    { name: "PR 上没有检查 → 直接合并", opts: { wait: ok }, result: "merged", merged: true, rebased: false },
    { name: "分支保护 → 留 PR，不 rebase", opts: { merges: [PROTECTED] }, result: "left", merged: true, rebased: false, reason: M.reasonBranchProtection(PROTECTED) },
    { name: "其他合并失败 → rebase 成功算合并", opts: { merges: [CONFLICT] }, rebase: ok, result: "merged", merged: true, rebased: true },
    { name: "其他合并失败 → rebase 失败留 PR", opts: { merges: [CONFLICT] }, rebase: { ok: false, reason: "门槛没过" }, result: "left", merged: true, rebased: true, reason: M.reasonMergeFailed(CONFLICT, "门槛没过") },
    { name: "一致性检查没过 → 不等检查，rebase 成功算合并", opts: {}, chainOk: false, rebase: ok, result: "merged", merged: false, rebased: true },
    { name: "一致性检查没过 → rebase 失败留 PR", opts: {}, chainOk: false, rebase: { ok: false, reason: "还是坏的" }, result: "left", merged: false, rebased: true, reason: M.reasonMergeFailed("迁移链断了。", "还是坏的") },
    { name: "PR 和 main 冲突 → 不试合并，rebase 成功算合并", opts: { wait: { ok: false, why: "conflict" } }, rebase: ok, result: "merged", merged: false, rebased: true },
    { name: "PR 和 main 冲突 → rebase 失败留 PR", opts: { wait: { ok: false, why: "conflict" } }, rebase: { ok: false, reason: "还是冲突" }, result: "left", merged: false, rebased: true, reason: M.reasonMergeFailed(PR_CONFLICT, "还是冲突") },
  ])("$name", async ({ opts, chainOk = true, rebase, result, merged, rebased, reason }) => {
    const f = fakeDeps(opts);
    let rebaseCalls = 0;
    const r = await mergeWhenReady(
      {
        issueId: "7",
        pr: "42",
        chainOk,
        brokenOut: "迁移链断了。",
        rebase: async () => {
          rebaseCalls++;
          return rebase ?? { ok: false, reason: "不该调" };
        },
      },
      f.d,
    );
    expect(r).toBe(result);
    expect(f.events.includes("mergePr 42 squash")).toBe(merged);
    expect(rebaseCalls).toBe(rebased ? 1 : 0);
    expect(f.left).toEqual(reason === undefined ? [] : [reason]);
    if (!chainOk) expect(f.events).not.toContain("wait");
  });

  it("PR 和 main 冲突时终端写「有冲突，先 rebase」，不写没有 CI、也不写没能直接合并", async () => {
    const f = fakeDeps({ wait: { ok: false, why: "conflict" } });
    await mergeWhenReady({ issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => ok }, f.d);
    expect(f.logs).toEqual(["  ⧗ #7 等 PR #42 上的检查（最多 30 分钟，不占空位）", `  ↻ #7 的 PR #42 和 ${BASE} 有冲突，先 rebase`]);
    expect(f.left).toEqual([]);
  });

  it("forge 没有 prChecks 时只警告一次（跨两次调用）", async () => {
    const args = { issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => ok };
    const a = fakeDeps({ noPrChecks: true });
    await mergeWhenReady(args, a.d);
    const b = fakeDeps({ noPrChecks: true });
    await mergeWhenReady(args, b.d);
    expect(a.warns).toEqual([`  ⚠ forge 不支持查 PR 上的检查，按没有检查合并（mergeRequires.checks: "all"）`]);
    expect(b.warns).toEqual([]);
  });

  it("整个过程票上带 merging 标记：等检查前打上，合并后去掉（中断时标记留着，重启后接着等，不重新实现）", async () => {
    const f = fakeDeps();
    f.d.markMerging = (on) => void f.events.push(`markMerging ${on}`);
    await mergeWhenReady({ issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => ok }, f.d);
    expect(f.events[0]).toBe("markMerging true");
    expect(f.events.indexOf("markMerging true")).toBeLessThan(f.events.indexOf("wait"));
    expect(f.events.at(-1)).toBe("markMerging false");
  });

  it("出错时也去掉 merging 标记", async () => {
    const f = fakeDeps({ wait: new Error("gh 挂了") });
    f.d.markMerging = (on) => void f.events.push(`markMerging ${on}`);
    await expect(mergeWhenReady({ issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => ok }, f.d)).rejects.toThrow("gh 挂了");
    expect(f.events.filter((e) => e.startsWith("markMerging"))).toEqual(["markMerging true", "markMerging false"]);
  });

  it("checks: none 时不警告", async () => {
    const f = fakeDeps({ noPrChecks: true, checks: "none" });
    await mergeWhenReady({ issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => ok }, f.d);
    expect(f.warns).toEqual([]);
  });

  it("main-broken 票开着时不合并：留 PR、评论含「等 #n 修好」、终端打那行", async () => {
    const f = fakeDeps({ hold: () => ({ blocker: 31 }) });
    const r = await mergeWhenReady(
      { issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => { throw new Error("不该走 rebase"); } },
      f.d,
    );
    expect(r).toBe("left");
    expect(f.events).not.toContain("mergePr 42 squash");
    expect(f.left).toEqual([M.reasonMainBroken(31)]);
    expect(f.left[0]).toContain("等 #31 修好");
    expect(f.logs).toContain("  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42");
  });

  it("查不到 main-broken 票时 fail-closed：留 PR、评论写明查不到、终端打那行", async () => {
    const f = fakeDeps({ hold: () => ({ error: "gh: 500" }) });
    const r = await mergeWhenReady(
      { issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => { throw new Error("不该走 rebase"); } },
      f.d,
    );
    expect(r).toBe("left");
    expect(f.events).not.toContain("mergePr 42 squash");
    expect(f.left).toEqual([M.reasonMainBrokenUnknown("gh: 500")]);
    expect(f.logs).toContain("  ◐ #7 查不到开着的 main-broken 票，留 PR #42");
  });

  it("等检查期间才开出 main-broken 票：rebase 补救回来也被挡，打带 #n 的那行、不写「合并失败」", async () => {
    let calls = 0;
    const f = fakeDeps({ merges: [CONFLICT], hold: () => (calls++ === 0 ? undefined : { blocker: 31 }) });
    const r = await mergeWhenReady(
      {
        issueId: "7",
        pr: "42",
        chainOk: true,
        brokenOut: "",
        // rebaseAndMerge 尾段（mergeAfterPush）查到 blocker 后带 held 返回的样子
        rebase: async () => ({ ok: false as const, reason: M.reasonMainBroken(31), held: { line: "  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42" } }),
      },
      f.d,
    );
    expect(r).toBe("left");
    expect(f.events).toContain("mergePr 42 squash");
    expect(f.left).toEqual([M.reasonMainBroken(31)]);
    expect(f.logs).toContain("  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42");
    expect(f.logs.some((l) => l.includes("合并失败"))).toBe(false);
  });

  it("main 修好后的恢复强制 rebase：rebase 后又遇到新开的 main-broken 票，照旧留 PR 等下一轮恢复（waiting-main 保留）", async () => {
    const f = fakeDeps();
    f.d.markMerging = (on) => void f.events.push(`markMerging ${on}`);
    const r = await mergeWhenReady(
      {
        issueId: "7",
        pr: "42",
        // resumeMerging 的 afterMainFix：分支不等检查，强制 rebase 重跑门槛（src/main.ts 的 forceRebase）
        chainOk: false,
        brokenOut: M.mainFixedRebase,
        // rebaseAndMerge 尾段（mergeAfterPush）查到新开的 blocker 后带 held 返回的样子（markWaitingMain 已在那边重新记上）
        rebase: async () => ({ ok: false as const, reason: M.reasonMainBroken(31), held: { line: "  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42" } }),
      },
      f.d,
    );
    expect(r).toBe("left");
    expect(f.events).not.toContain("mergePr 42 squash");
    expect(f.left).toEqual([M.reasonMainBroken(31)]);
    expect(f.events.filter((e) => e.startsWith("markMerging"))).toEqual(["markMerging true", "markMerging false"]);
    expect(f.logs).toContain("  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42");
    expect(f.logs.some((l) => l.includes("合并失败"))).toBe(false);
  });
});

describe("waitChecksOffSlot", () => {
  it("按顺序让出空位、放锁、等、移出 ciWaiting、拿回锁", async () => {
    const f = fakeDeps({ wait: { ok: false, why: "fail", checks: [ci] } });
    expect(await waitChecksOffSlot("7", "42", f.d)).toEqual({ ok: false, why: "fail", checks: [ci] });
    expect(f.events).toEqual(order);
    expect(f.logs).toEqual(["  ⧗ #7 等 PR #42 上的检查（最多 30 分钟，不占空位）"]);
  });

  it("没有检查（宽限期后按没有 CI）时多打一行说明只按门槛合并", async () => {
    const f = fakeDeps({ wait: { ok: true, noChecks: true } });
    expect(await waitChecksOffSlot("7", "42", f.d)).toEqual({ ok: true, noChecks: true });
    expect(f.logs).toEqual(["  ⧗ #7 等 PR #42 上的检查（最多 30 分钟，不占空位）", "  · #7 的 PR #42 上没有检查（没有 CI），只按门槛合并"]);
  });

  it("检查通过时不打没有检查的说明", async () => {
    const f = fakeDeps({ wait: { ok: true } });
    await waitChecksOffSlot("7", "42", f.d);
    expect(f.logs).toHaveLength(1);
  });

  it("等的过程抛错时也会 delete 和 reacquire", async () => {
    const f = fakeDeps({ wait: new Error("boom") });
    await expect(waitChecksOffSlot("7", "42", f.d)).rejects.toThrow("boom");
    expect(f.events).toEqual(order);
  });

  it.each<Opts>([{ checks: "none" }, { noPrChecks: true }])("%o 时什么都不做", async (opts) => {
    const f = fakeDeps(opts);
    expect(await waitChecksOffSlot("7", "42", f.d)).toEqual({ ok: true });
    expect(f.events).toEqual([]);
    expect(f.logs).toEqual([]);
  });
});

describe("mergeAfterPush", () => {
  it("检查没过直接返回失败，不合并", async () => {
    const f = fakeDeps({ wait: { ok: false, why: "timeout", checks: [lint] } });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({ ok: false, reason: M.reasonChecksTimeout(timeoutList, 30) });
    expect(f.events.filter((e) => e.startsWith("mergePr") || e.startsWith("sleep"))).toEqual([]);
  });

  it("rebase 后 PR 又和 main 冲突：返回 rebaseMergeFailed，不试合并", async () => {
    const f = fakeDeps({ wait: { ok: false, why: "conflict" } });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({ ok: false, reason: M.rebaseMergeFailed(PR_CONFLICT) });
    expect(f.events.filter((e) => e.startsWith("mergePr") || e.startsWith("sleep"))).toEqual([]);
  });

  it("中途成功即评论 rebasedMerged 并返回成功", async () => {
    const f = fakeDeps({ merges: [CONFLICT, true] });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({ ok: true });
    expect(f.events.slice(order.length)).toEqual(["sleep 10000", "mergePr 42 squash", "sleep 10000", "mergePr 42 squash", "commentPr 42"]);
    expect(f.comments).toEqual([M.rebasedMerged(BASE)]);
  });

  it("3 次都失败返回 rebaseMergeFailed（最后一次的报错）", async () => {
    const f = fakeDeps({ merges: ["e1", "e2", "e3"] });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({ ok: false, reason: M.rebaseMergeFailed("e3") });
    expect(f.events.slice(order.length)).toEqual(["sleep 10000", "mergePr 42 squash", "sleep 10000", "mergePr 42 squash", "sleep 10000", "mergePr 42 squash"]);
    expect(f.comments).toEqual([]);
  });

  it("分支保护报错立刻返回，不再重试", async () => {
    const f = fakeDeps({ merges: [PROTECTED, true] });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({ ok: false, reason: M.reasonBranchProtection(PROTECTED) });
    expect(f.events.filter((e) => e.startsWith("mergePr"))).toHaveLength(1);
    expect(f.comments).toEqual([]);
  });

  it("检查通过后有 main-broken blocker → 不调 mergePr，返回失败并带 held（终端那行）", async () => {
    const f = fakeDeps({ hold: () => ({ blocker: 31 }) });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({
      ok: false,
      reason: M.reasonMainBroken(31),
      held: { line: "  ◐ #7 main 兜底测试失败，等 #31 修好，留 PR #42" },
    });
    expect(f.events.filter((e) => e.startsWith("mergePr") || e.startsWith("sleep"))).toEqual([]);
  });

  it("查不到 main-broken 票时 fail-closed，返回失败并带 held", async () => {
    const f = fakeDeps({ hold: () => ({ error: "gh: 500" }) });
    expect(await mergeAfterPush("7", "42", f.d)).toEqual({
      ok: false,
      reason: M.reasonMainBrokenUnknown("gh: 500"),
      held: { line: "  ◐ #7 查不到开着的 main-broken 票，留 PR #42" },
    });
    expect(f.events.filter((e) => e.startsWith("mergePr") || e.startsWith("sleep"))).toEqual([]);
  });
});

describe("英文文案", () => {
  it("main-broken 挡合并：PR 评论的原因和终端那行都是英文", async () => {
    setTermLanguage("en", {});
    const en = messages("en");
    const f = fakeDeps({ hold: () => ({ blocker: 31 }) });
    f.d.M = en;
    const r = await mergeWhenReady({ issueId: "7", pr: "42", chainOk: true, brokenOut: "", rebase: async () => { throw new Error("不该走 rebase"); } }, f.d);
    expect(r).toBe("left");
    expect(f.left).toEqual([en.reasonMainBroken(31)]);
    expect(f.logs).toEqual([`  ⧗ #7 waiting for checks on PR #42 (up to 30 minutes, not holding a slot)`, "  ◐ #7 the fallback full test on main failed; waiting for #31 to be fixed; PR #42 left open"]);
    expect(en.reasonMainBrokenUnknown("x")).not.toMatch(/[一-鿿]/);
  });
});
