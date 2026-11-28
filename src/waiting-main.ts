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

/**
 * afterMainFix 恢复（resumeMerging）这一轮的结果，waiting-main 按它决定去不去（#119）：
 * merged 合并了；left 因别的原因留了 PR（受保护路径、复审、浏览器验收、检查失败等，pr-open 已先落上）；
 * autoMergeOff 因 autoMerge 关着留了 PR——三种都离开了「其他关卡都过了、只被 main-broken 挡住」的状态，要去掉。
 * held 是 rebase 后又被新开的 main-broken 票挡住（markWaitingMain 重新打过标签），保留给下一轮恢复（#86 行为不变）。
 * The outcome of an afterMainFix resume (resumeMerging); waiting-main is decided by it (#119):
 * merged (merged), left (PR left for another reason — protected paths, re-review, browser check, failed checks; pr-open
 * is already on), and autoMergeOff (PR left because autoMerge is off) all mean the ticket has left "every other gate
 * passed; held only by main-broken", so the label comes off. held means a new main-broken ticket appeared after the
 * rebase (markWaitingMain re-added the label) and it stays for the next resume (unchanged #86 behaviour).
 */
export type ResumeOutcome = "merged" | "left" | "held" | "autoMergeOff";

/**
 * afterMainFix 恢复结束时去不去 waiting-main：只有又被 main-broken 挡住（held）时保留，其余都去掉——
 * 残留的话之后的 resumeWaitingMain 会误恢复（ADR 0007「恢复」）。
 * Whether waiting-main comes off at the end of an afterMainFix resume: only a fresh main-broken hold (held) keeps it;
 * every other outcome removes it — a lingering label would let a later resumeWaitingMain resume the ticket by mistake (ADR 0007 "Resume").
 */
export function removeWaitingMainAfterResume(outcome: ResumeOutcome): boolean {
  return outcome !== "held";
}

/**
 * 这一轮的恢复是不是 afterMainFix：票上还带 waiting-main 就是。恢复改为留到结果出来再去标签后（#119），
 * 去标签前被中断的票下一轮仍带 waiting-main，仍走 afterMainFix 的强制 rebase + 重跑门槛，不退化成普通的中断恢复。
 * Whether this pass's resume is an afterMainFix one: the ticket still carries waiting-main. Now that the label comes
 * off only after the outcome (#119), a resume interrupted before that still carries waiting-main next pass and still
 * takes the afterMainFix forced rebase + gate rerun, not a plain interrupt resume.
 */
export function isAfterMainFix(labels: string[], waitingMain: string): boolean {
  return labels.includes(waitingMain);
}
