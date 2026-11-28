// main-broken 修好后的恢复（#86，ADR 0007「恢复」）：带 waiting-main 的票里哪些这一轮可以回到合并流程。
// After main is fixed (#86, ADR 0007 "Resume"): which waiting-main tickets can go back to the merge flow this pass.
import { mainBrokenBlocker } from "./merge-flow.ts";
import type { ForgeIssue } from "./forge.ts";
import type { Labels } from "./profile.ts";

/**
 * waiting-main 候选里没有被开着的 main-broken 票挡住的票号（挡住判定复用 mainBrokenBlocker，含其子票豁免）。
 * 列票出错时调用方这一轮不恢复（fail-closed），这里只做纯筛选。
 * The numbers of the waiting-main candidates not held by an open main-broken ticket (the hold logic reuses
 * mainBrokenBlocker, including its child exemption). On a listing error the caller skips resuming for the pass
 * (fail-closed); this only does the pure filtering.
 */
export function resumableWaitingMain(
  candidates: Pick<ForgeIssue, "number" | "body">[],
  openMainBroken: Pick<ForgeIssue, "number" | "body">[],
): number[] {
  return candidates.filter((c) => mainBrokenBlocker(openMainBroken, String(c.number)) === undefined).map((c) => c.number);
}

/**
 * 票离开 pr-open（打回）或 merging（没有开着的 PR，交回调度）时要去掉的标签：那个状态标签加 waiting-main。
 * waiting-main 只能表示「其他关卡都过了、只被 main-broken 挡住」；票一旦离开这个状态就必须去掉，
 * 否则之后因别的原因（reviewer 给 pr、受保护路径、浏览器验收没过）留下的 PR 会被 resumeWaitingMain 自动合并。
 * Labels to remove when a ticket leaves pr-open (sent back) or merging (no open PR; handed back to scheduling): that state label plus waiting-main.
 * waiting-main may only mean "every other gate passed; held only by main-broken". Once the ticket leaves that state it must come off,
 * or a PR later left for another reason (reviewer said pr, protected paths, failed browser check) would be auto-merged by resumeWaitingMain.
 */
export function labelsToRemoveOnLeave(labels: Pick<Labels, "prOpen" | "merging" | "waitingMain">, from: "prOpen" | "merging"): string[] {
  return [labels[from], labels.waitingMain];
}

/**
 * 恢复时打完 merging 之后要不要去 pr-open：打 merging 失败就不去，保留 pr-open，下一轮再试。
 * 否则票只剩 picked + prepped + waiting-main，plan 会重新实现它；重新实现后若因别的原因留 PR，
 * 票又同时带 waiting-main 和 pr-open，下一轮会被 resumeWaitingMain 自动合并（fail-open）。
 * Whether to remove pr-open on resume once merging was added: if adding merging failed, keep pr-open and retry next pass.
 * Otherwise the ticket is left with picked + prepped + waiting-main and plan reimplements it; a PR then left for another
 * reason would carry waiting-main and pr-open again and be auto-merged by resumeWaitingMain next pass (fail-open).
 */
export function shouldRemovePrOpenOnResume(mergingLabelled: boolean): boolean {
  return mergingLabelled;
}
