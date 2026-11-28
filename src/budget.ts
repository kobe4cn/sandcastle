// 花费上限（#61 之一，#151）：单票累计 token 的口径和超限的报错。
// 口径是 #61 决定评论定的：只按 token（别家档案的记录没有 costUSD，按金额算等于不计费）；
// 四项相加（输入、缓存写、缓存读、输出——缓存读往往比其他几项大一个数量级，上限要按这个口径设）；
// 算这张票在 usage.jsonl 里的全部记录（各阶段、各次运行、limited 的都算），重启后照样有效。
// Spend caps (#61 part 1, #151): how one ticket's cumulative tokens are counted, and the over-cap error.
// The counting follows #61's decision comment: tokens only (other vendors' records carry no costUSD, so a money cap would bill nothing);
// four fields summed (input, cache write, cache read, output — cache reads are often an order of magnitude larger, so set the cap with this in mind);
// every record of this ticket in usage.jsonl counts (all phases, all runs, limited ones included), so it survives restarts.

import type { UsageRecord } from "./models.ts";

/**
 * 一条记录折算成 token：有 `models`（含子代理的各模型合计）就取它，没有（老记录、或没拿到 result 行）退回主行的四项之和。
 * How many tokens one record is: with `models` (per-model totals, subagents included) take that; without it (older records, or no result line seen) fall back to the main line's four fields.
 */
export function recordTokens(r: UsageRecord): number {
  const models = r.models ?? [];
  // models 为空数组和没写一样：主行是主会话 JSONL 的口径，看不出子代理用的模型，有合计就不用主行。 / An empty models array is the same as absent: the main line reflects the main session's JSONL, which can't see subagent models, so the totals replace it.
  if (models.length > 0) {
    return models.reduce((sum, m) => sum + m.input + m.cacheCreation + m.cacheRead + m.output, 0);
  }
  return r.input + r.cacheCreation + r.cacheRead + r.output;
}

/**
 * 这张票已经用掉的 token：各条记录折算后相加。 / Tokens this ticket has already spent: its records' token counts summed.
 */
export function ticketSpend(records: readonly UsageRecord[]): number {
  return records.reduce((sum, r) => sum + recordTokens(r), 0);
}

/**
 * 单票花费超限：会话开之前抛出（#151），implement / review 等走落地的失败分支、prep 走自己的 catch，都打 stuck。
 * 只在本进程里创建和捕获（不跨沙箱），`instanceof` 认得出来；不是临时错误，retryTransient 不重试。
 * The per-ticket spend cap was exceeded: thrown before a session starts (#151); implement / review etc. take the landing's failure branch and prep its own catch, both marking the ticket stuck.
 * Only created and caught inside this process (never crosses the sandbox), so `instanceof` works; not a transient error, retryTransient doesn't retry it.
 */
export class BudgetExceeded extends Error {
  /** 已经用掉的 token（ticketSpend 的口径）。 / Tokens already spent (as counted by ticketSpend). */
  readonly used: number;
  /** 配置的上限。 / The configured cap. */
  readonly limit: number;
  constructor(used: number, limit: number) {
    // 报错文本只进终端和本地日志，写原始数字即可；票上的评论走 i18n 的 ticketBudget（k 式格式）。注意不要写成会撞上 TRANSIENT / CLAUDE_LIMIT_PATTERN 的词（不能被当成临时错误或用量限额重试）。
    // This text only reaches the terminal and a local log, so raw numbers; the ticket comment goes through i18n's ticketBudget (k-style). Worded to avoid TRANSIENT / CLAUDE_LIMIT_PATTERN matches (it must not be retried as a transient error or a usage limit).
    super(`ticket budget: used ${used} / cap ${limit}`);
    this.name = "BudgetExceeded";
    this.used = used;
    this.limit = limit;
  }
}
