// main-broken 修好后的恢复（#86，ADR 0007「恢复」）：带 waiting-main 的票里哪些这一轮可以回到合并流程。
// After main is fixed (#86, ADR 0007 "Resume"): which waiting-main tickets can go back to the merge flow this pass.
import { mainBrokenBlocker } from "./merge-flow.ts";
import type { ForgeIssue } from "./forge.ts";

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
