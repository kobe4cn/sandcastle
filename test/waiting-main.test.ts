import { describe, expect, it } from "vitest";
import { isAfterMainFix, labelsToRemoveOnLeave, removeWaitingMainAfterResume, resumableWaitingMain, shouldRemovePrOpenOnResume } from "../src/waiting-main.ts";
import { DEFAULT_LABELS } from "../src/profile.ts";

/** main-broken 修好后的恢复（#86）：waiting-main 候选里哪些票这一轮可以回到合并流程。 */
describe("resumableWaitingMain", () => {
  const issue = (number: number, body = "") => ({ number, body });

  it("没有开着的 main-broken 票 → 全部可恢复", () => {
    expect(resumableWaitingMain([issue(7), issue(8)], [])).toEqual([7, 8]);
  });

  it("别的 main-broken 票还开着 → 不可恢复", () => {
    expect(resumableWaitingMain([issue(7), issue(8)], [issue(31, "")])).toEqual([]);
  });

  it("本票是开着的 main-broken 票 ## Split into 的子票 → 可恢复，别的票照旧被挡", () => {
    expect(resumableWaitingMain([issue(7), issue(33)], [issue(31, "## Split into\n\n- [ ] #32\n- #33")])).toEqual([33]);
  });
});

/** 票离开 pr-open / merging（打回、没 PR 交回调度）时一并去掉 waiting-main，免得别的原因留下的 PR 被自动恢复合并。 */
describe("labelsToRemoveOnLeave", () => {
  it("打回（离开 pr-open）→ 去掉 pr-open 和 waiting-main", () => {
    expect(labelsToRemoveOnLeave(DEFAULT_LABELS, "prOpen")).toEqual(["sandcastle:pr-open", "sandcastle:waiting-main"]);
  });

  it("没有开着的 PR 交回调度（离开 merging）→ 去掉 merging 和 waiting-main", () => {
    expect(labelsToRemoveOnLeave(DEFAULT_LABELS, "merging")).toEqual(["sandcastle:merging", "sandcastle:waiting-main"]);
  });
});

/** 恢复时先打 merging 再去 pr-open：打 merging 失败就不去 pr-open，免得票只剩 picked 被 plan 重新实现。 */
describe("shouldRemovePrOpenOnResume", () => {
  it("打 merging 成功 → 去 pr-open", () => {
    expect(shouldRemovePrOpenOnResume(true)).toBe(true);
  });

  it("打 merging 失败 → 不去 pr-open，下一轮再试", () => {
    expect(shouldRemovePrOpenOnResume(false)).toBe(false);
  });
});

/** afterMainFix 恢复留到结果出来再去 waiting-main（#119）：只有又被 main-broken 挡住保留，其余都去掉。 */
describe("removeWaitingMainAfterResume", () => {
  it("合并了、或因别的原因留 PR（受保护路径、复审、检查失败等）→ 去掉 waiting-main", () => {
    expect(removeWaitingMainAfterResume("merged")).toBe(true);
    expect(removeWaitingMainAfterResume("left")).toBe(true);
  });

  it("autoMerge 关着留 PR → 去掉 waiting-main", () => {
    expect(removeWaitingMainAfterResume("autoMergeOff")).toBe(true);
  });

  it("rebase 后又被新开的 main-broken 票挡住 → 保留 waiting-main（#86 行为不变）", () => {
    expect(removeWaitingMainAfterResume("held")).toBe(false);
  });

  it("恢复中途抛错（mergeWhenReady 的 finally 已去掉 merging）→ 去掉 waiting-main，残留会被人重新实现后的 resumeWaitingMain 误自动合并", () => {
    expect(removeWaitingMainAfterResume("threw")).toBe(true);
  });
});

/** 去标签前中断的票下一轮仍带 waiting-main、仍是 afterMainFix（#119），不退化成普通的中断恢复。 */
describe("isAfterMainFix", () => {
  it("去标签前中断（还带 merging + waiting-main）→ 下一轮仍是 afterMainFix，走强制 rebase", () => {
    expect(isAfterMainFix([DEFAULT_LABELS.picked, DEFAULT_LABELS.merging, DEFAULT_LABELS.waitingMain], DEFAULT_LABELS.waitingMain)).toBe(true);
  });

  it("只带 merging（普通的中断恢复）→ 不是 afterMainFix", () => {
    expect(isAfterMainFix([DEFAULT_LABELS.picked, DEFAULT_LABELS.merging], DEFAULT_LABELS.waitingMain)).toBe(false);
  });

  it("waiting-main 用项目配置的标签名判断，别的同名前缀不算", () => {
    expect(isAfterMainFix([DEFAULT_LABELS.picked, "sandcastle:waiting-main-old"], DEFAULT_LABELS.waitingMain)).toBe(false);
  });
});
