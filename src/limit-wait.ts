// 用量限额：等到重置后接着跑，不当成票的失败。从 main.ts 搬出来，好单测「醒来重读 models.json」（main.ts 有顶层副作用，测试不 import 它）。
// Usage limits: wait for the reset and continue, not counted as a ticket failure. Moved out of main.ts so "reread models.json on waking" can be unit-tested (main.ts has top-level side effects and tests don't import it).
//
// 撞限额的识别、重置时间的解析和换档案在 models.ts；这里处理「这个阶段的档案都在等」：等到最早恢复的那个再从头跑。
// Detecting limits, parsing reset times and switching profiles live in models.ts; this handles "every profile for this phase is waiting": wait for the earliest one, then rerun from the start.
import { AllProfilesLimited, CLAUDE_LIMIT_PATTERN, limitResetAt, reloadModels } from "./models.ts";
import { t } from "./term.ts";

export const LIMIT_RESUME_SLACK_MS = 2 * 60_000; // 重置时间之后再多等一会儿 / wait a little longer after the reset time
export const LIMIT_FALLBACK_WAIT_MS = 30 * 60_000; // 认不出重置时间时每次等这么久再试 / how long to wait between tries when the reset time can't be read

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 分步睡：笔记本合盖时计时器会停，醒来按墙上时间判断。 / Sleep in steps: timers stop while a laptop lid is closed, so after waking judge by wall-clock time. */
export async function sleepUntil(at: number) {
  while (Date.now() < at) await sleep(Math.min(60_000, at - Date.now()));
}

/**
 * 跑 fn，撞上用量限额就等到重置后重跑；其他错误照抛。
 * fn 要能从头重跑：prep 本来就幂等；build 重跑时在原分支上接着做（implementer 先看已有提交）。
 * onLimit 在等之前调用，比如把分支推到远端。
 * 醒来后先重读 models.json 再重跑（#43）：等待期间补上的新档案马上能用。配置是模块级的，所有票共用。
 * deps 给测试注入假的 sleepUntil / reload。deps.comment 在抛 AllProfilesLimited 进入等待时调（#48），同一次调用里只调一次；
 * 普通限额报错不调（没有档案列表）。comment 自己兜住错误（main.ts 用 attempt 只警告）。
 * Run fn; on a usage limit wait for the reset and rerun it; other errors are rethrown.
 * fn must be rerunnable from the start: prep is idempotent anyway; build continues on the same branch when rerun (the implementer looks at existing commits first).
 * onLimit is called before waiting, e.g. to push the branch to the remote.
 * After waking, models.json is reread before rerunning (#43): profiles added while waiting are usable right away. The config is module-level and shared by all tickets.
 * deps lets tests inject a fake sleepUntil / reload. deps.comment is called when an AllProfilesLimited starts a wait (#48), at most once per call;
 * plain limit errors don't call it (no profile list). comment handles its own errors (main.ts wraps it in attempt and only warns).
 */
export async function untilAfterLimit<T>(
  what: string,
  fn: () => Promise<T>,
  onLimit?: () => void | Promise<void>,
  deps: { sleepUntil?: (at: number) => Promise<void>; reload?: () => void; comment?: (limited: AllProfilesLimited) => void } = {},
): Promise<T> {
  const { sleepUntil: sleepFor = sleepUntil, reload = reloadModels, comment } = deps;
  // 醒来再撞、认不出重置时间每 30 分钟重来都算同一次等待，只评论一次。 / Hitting it again on waking, or retrying every 30 minutes, is the same wait: comment once.
  let commented = false;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const limit = limitWait(e);
      if (!limit) throw e;
      await onLimit?.();
      if (e instanceof AllProfilesLimited && comment && !commented) {
        commented = true;
        comment(e);
      }
      const until = new Date(limit.until).toLocaleString();
      console.log(t(`  ⏸ ${what} 撞上用量限额，${limit.why}等到 ${until} 再接着跑`, `  ⏸ ${what} hit the usage limit; ${limit.why}resuming at ${until}`));
      await sleepFor(limit.until);
      reload();
    }
  }
}

/** 错误是用量限额时，该等到什么时候（含余量）；不是限额返回 null。 / When the error is a usage limit, when to resume (with slack); null when it isn't a limit. */
export function limitWait(e: unknown): { until: number; why: string } | null {
  // AllProfilesLimited 的 until 已经含了余量。 / AllProfilesLimited's until already includes the slack.
  if (e instanceof AllProfilesLimited) return { until: e.until, why: "" };
  const message = String(e);
  if (!CLAUDE_LIMIT_PATTERN.test(message)) return null;
  const resetAt = limitResetAt(message);
  return resetAt === null
    ? { until: Date.now() + LIMIT_FALLBACK_WAIT_MS, why: t(`认不出重置时间（${message.slice(0, 200)}），`, `couldn't read the reset time (${message.slice(0, 200)}); `) }
    : { until: resetAt + LIMIT_RESUME_SLACK_MS, why: "" };
}
