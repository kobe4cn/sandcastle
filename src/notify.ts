// 主动通知（可选）：配了 notify 时，票 stuck、留 PR 给人等事件向 webhook POST 一条 JSON（text 给人看，
// Slack incoming webhook 直接认，飞书等群机器人要各自的格式、不兼容；event / issue / url / reason 给自建接收端）。
// webhook URL 是凭据：只从 .sandcastle/.env（值为空时取宿主机同名环境变量）读，不进日志、警告、评论；
// 发送失败（抛错、5xx、429）等 5 秒重试一次，仍失败才打一行警告（抛错时写明错误类型），从不 reject——通知不影响主流程。
// Proactive notifications (optional): with notify configured, events like a stuck ticket or a PR left for a human POST one JSON
// message to a webhook (text is for humans, accepted as-is by a Slack incoming webhook; Lark-style bots need their own formats;
// event / issue / url / reason are for self-built receivers).
// The webhook URL is a credential: read only from .sandcastle/.env (falling back to the same-named host environment variable
// when empty there); it never goes into logs, warnings or comments. A failed send (a throw, 5xx or 429) waits 5 s and
// retries once; only when the retry also fails does it warn one line (naming the error kind when fetch throws) — and it
// never rejects, so notifications don't affect the main flow.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { parseEnv } from "node:util";
import { messages, type Language } from "./i18n.ts";
import { t } from "./term.ts";

/** 通知事件；test 给 doctor 的 --notify-test（发一条测试消息）。 / Notify events; test is for doctor's --notify-test (sends a test message). */
export type NotifyEvent = "stuck" | "leftForHuman" | "mainBroken" | "limited" | "crashed" | "test";

/** 发出的一条通知。 / One notification being sent. */
export interface Notification {
  event: NotifyEvent;
  /** 票号；不属于某张票的事件可省。 / Ticket number; optional for events not tied to a ticket. */
  issue?: string;
  /** 票的链接（forge 实现了 issueUrl 时才有）。 / Ticket link (only when the forge implements issueUrl). */
  url?: string;
  /** 一句原因。 / One-line reason. */
  reason: string;
}

/** 发送器；url 为空时是空操作。 / The sender; a no-op when no URL is configured. */
export type Notifier = (e: Notification) => Promise<void>;

/**
 * 通知 webhook 的 URL：.sandcastle/.env 里 envKey 的值，文件里为空时取宿主机同名环境变量；文件不存在返回 undefined。
 * The notification webhook URL: envKey's value in .sandcastle/.env, falling back to the same-named host environment variable
 * when empty there; undefined when the file doesn't exist.
 */
export function readNotifyUrl(envKey: string, cwd = process.cwd()): string | undefined {
  const path = join(cwd, ".sandcastle", ".env");
  if (!existsSync(path)) return undefined;
  const vars = parseEnv(readFileSync(path, "utf8"));
  return vars[envKey] || process.env[envKey] || undefined;
}

/**
 * 认 fetch 抛错的错误类型，写进发送失败的警告：超时（AbortSignal.timeout 的 reason，name 为 TimeoutError，手动 abort 是 AbortError）、
 * cause 上的 code（ECONNRESET、ENOTFOUND、ERR_INVALID_URL…；cause 是 AggregateError 且自己没带 code 时取 errors[0].code），
 * 都取不到退回错误文本——先抹掉 URL 再截到 200 字，凭据不进任何输出。
 * Identifies the kind of a fetch failure for the send-failed warning: timeout (AbortSignal.timeout's reason, named TimeoutError;
 * a manual abort is AbortError), the code on cause (ECONNRESET, ENOTFOUND, ERR_INVALID_URL…; an AggregateError cause without
 * its own code falls back to errors[0].code), or the error message as a last resort — URL scrubbed first and truncated
 * to 200 chars, so the credential never reaches any output.
 */
function failKind(e: unknown, url: string): string {
  // 抹 URL 的写法照 doctor.ts（局部闭包，不为此 import doctor / preflight）。 / URL scrubbing copied from doctor.ts (a local closure; not worth importing doctor / preflight for).
  const scrub = (text: string) => (url ? text.replaceAll(url, "…") : text);
  const prop = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined);
  const name = prop(e, "name");
  if (name === "TimeoutError" || name === "AbortError") return name;
  const cause = prop(e, "cause");
  const causeCode = prop(cause, "code");
  if (typeof causeCode === "string") return causeCode;
  if (cause instanceof AggregateError) {
    const nested = prop(cause.errors[0], "code");
    if (typeof nested === "string") return nested;
  }
  const message = e instanceof Error ? e.message : String(e);
  return scrub(message).slice(0, 200);
}

/**
 * 建发送器：POST 一条 JSON，超时 10 秒；抛错、5xx、429 时等 5 秒重试一次（`retry: false` 关掉——crashed 通知不重试，
 * 总等待仍封顶 10 秒），重试也失败（或 4xx 不重试）只 warn 一行且不带 URL、按最后一次的结果选文案，从不 reject。
 * 写法照 version.ts 的 latestVersion（fetcher / sleep 注入，测试不连网、不真睡）。
 * Builds the sender: POSTs one JSON message with a 10-second timeout; a throw, 5xx or 429 waits 5 s and retries once
 * (`retry: false` turns that off — the crashed notification doesn't retry, so its total wait still caps at 10 s); when the
 * retry also fails (or a 4xx isn't retried) it only warns one line without the URL, worded by the last attempt's result,
 * and never rejects. Follows latestVersion in version.ts (injected fetcher / sleep; tests stay offline and don't sleep).
 */
export function createNotifier(opts: {
  url?: string;
  language: Language;
  fetcher?: typeof fetch;
  warn?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  retry?: boolean;
}): Notifier {
  const warn = opts.warn ?? (() => {});
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => sleepFor(ms));
  const retry = opts.retry ?? true;
  const M = messages(opts.language);
  if (!opts.url) return async () => {};
  const url = opts.url;
  return async (e) => {
    const payload: Record<string, string> = { text: M.notifyText(e.event, e.issue, e.url, e.reason), event: e.event, reason: e.reason };
    if (e.issue) payload.issue = e.issue;
    if (e.url) payload.url = e.url;
    // 单次发送：成功、非 2xx（带状态码）、抛错（带错误）。 / One attempt: ok, non-2xx (with the status), or a throw (with the error).
    const attempt = async (): Promise<{ ok: boolean; status?: number; error?: unknown }> => {
      try {
        const res = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        return { ok: false, status: res.status };
      } catch (e) {
        return { ok: false, error: e };
      }
    };
    let last = await attempt();
    // 抛错、5xx、429 才重试（4xx 不重试）；重试也新建 signal，不占第一次的 10 秒额度。 / Only a throw, 5xx or 429
    // retries (a 4xx doesn't); the retry builds its own signal instead of sharing the first attempt's 10-second budget.
    const retryable = !last.ok && (last.error !== undefined || last.status === 429 || (last.status ?? 0) >= 500);
    if (retryable && retry) {
      await sleep(5_000);
      last = await attempt();
    }
    if (last.ok) return;
    if (last.status !== undefined)
      warn(t(`  ⚠ 通知发送失败（HTTP ${last.status}），不影响运行`, `  ⚠ Notify webhook failed (HTTP ${last.status}); the run continues`));
    else warn(t(`  ⚠ 通知发送失败（${failKind(last.error, url)}），不影响运行`, `  ⚠ Notify webhook failed (${failKind(last.error, url)}); the run continues`));
  };
}
