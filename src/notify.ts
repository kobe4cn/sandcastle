// 主动通知（可选）：配了 notify 时，票 stuck、留 PR 给人等事件向 webhook POST 一条 JSON（text 给人看，
// 兼容只认 text 的接收端如 Slack / 飞书；event / issue / url / reason 给自建接收端）。
// webhook URL 是凭据：只从 .sandcastle/.env（值为空时取宿主机同名环境变量）读，不进日志、警告、评论；
// 发送失败只打一行警告，从不 reject——通知不影响主流程。
// Proactive notifications (optional): with notify configured, events like a stuck ticket or a PR left for a human POST one JSON
// message to a webhook (text is for humans, compatible with receivers that only read text, e.g. Slack / Lark;
// event / issue / url / reason are for self-built receivers).
// The webhook URL is a credential: read only from .sandcastle/.env (falling back to the same-named host environment variable
// when empty there); it never goes into logs, warnings or comments. A failed send only warns one line and never rejects —
// notifications don't affect the main flow.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 * 建发送器：POST 一条 JSON，超时 10 秒；任何错误（网络、非 2xx）只 warn 一行且不带 URL，从不 reject。
 * 写法照 version.ts 的 latestVersion（fetcher 注入，测试不连网）。
 * Builds the sender: POSTs one JSON message with a 10-second timeout; any error (network, non-2xx) only warns
 * one line without the URL and never rejects. Follows latestVersion in version.ts (injected fetcher, tests stay offline).
 */
export function createNotifier(opts: { url?: string; language: Language; fetcher?: typeof fetch; warn?: (line: string) => void }): Notifier {
  const warn = opts.warn ?? (() => {});
  const fetcher = opts.fetcher ?? fetch;
  const M = messages(opts.language);
  if (!opts.url) return async () => {};
  const url = opts.url;
  return async (e) => {
    const payload: Record<string, string> = { text: M.notifyText(e.event, e.issue, e.url, e.reason), event: e.event, reason: e.reason };
    if (e.issue) payload.issue = e.issue;
    if (e.url) payload.url = e.url;
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) warn(t(`  ⚠ 通知发送失败（HTTP ${res.status}），不影响运行`, `  ⚠ Notify webhook failed (HTTP ${res.status}); the run continues`));
    } catch {
      warn(t("  ⚠ 通知发送失败，不影响运行", "  ⚠ Notify webhook failed; the run continues"));
    }
  };
}
