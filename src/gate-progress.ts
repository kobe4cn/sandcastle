// 门槛进度：门槛输出逐行实时写进 .sandcastle/logs/gate-<票号>-<时间戳>.log，并定时打印心跳（已用时间）。
// 终端不逐行打印门槛输出（run 有多个沙箱并行，会混在一起），只打印日志路径和心跳。
// 完整输出在这里自己累积：沙箱传了 onLine 后返回的 stdout 可能只剩末尾一段，档位、flaky 要看完整输出。
//
// Gate progress: gate output is appended line by line to .sandcastle/logs/gate-<issue>-<timestamp>.log, and a heartbeat (elapsed time) is printed periodically.
// The terminal doesn't echo gate output line by line (run has several sandboxes in parallel; it would interleave), only the log path and the heartbeat.
// The full output is accumulated here: once onLine is passed, the sandbox's returned stdout may be only a tail, and tier / flaky detection needs all of it.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { t } from "./term.ts";

/**
 * 门槛的环境变量：默认值 NO_COLOR=1、FORCE_COLOR=0 在最前，项目的 env（isolation.env）和 overrides（gate.env）依次覆盖。
 * Gate environment variables: defaults NO_COLOR=1, FORCE_COLOR=0 come first, then the project's env (isolation.env) and overrides (gate.env) override them in turn.
 */
export function gateEnv(env: Record<string, string>, overrides?: Record<string, string>): Record<string, string> {
  return { NO_COLOR: "1", FORCE_COLOR: "0", ...env, ...overrides };
}

/** 心跳间隔：5 分钟。 / Heartbeat interval: 5 minutes. */
export const HEARTBEAT_MS = 5 * 60_000;

/**
 * 用时文案：不到一分钟显示秒（小项目的门槛只跑几秒，显示「0.0 分钟」看不出用时），否则分钟。
 * Duration text: seconds under a minute (small projects' gates take seconds, and "0.0 min" says nothing), minutes otherwise.
 */
export const duration = (ms: number) =>
  ms < 60_000 ? t(`${Math.round(ms / 1000)} 秒`, `${Math.round(ms / 1000)}s`) : t(`${(ms / 60_000).toFixed(1)} 分钟`, `${(ms / 60_000).toFixed(1)} min`);

/**
 * 门槛结束时的 ⏱ 行：通过且输出含 GATE_FLAKY 时带「有偶发失败」标记（和 main 兜底检查的写法一致），失败时不带。
 * The ⏱ line when a gate ends: when it passed and the output has GATE_FLAKY, it carries the "flaky failures" marker (same wording as the main fallback check); not on failure.
 */
export function gateDoneLine(issueId: string, line: string, passed: boolean, flaky: boolean): string {
  const result = passed ? t("，通过", ", passed") : t("，失败", ", failed");
  const mark = passed && flaky ? t("（有偶发失败，重跑通过）", " (flaky failures passed on rerun)") : "";
  return `  ⏱ #${issueId} ${line}${result}${mark}`;
}

/**
 * 门槛被基础设施杀掉（podman 断连等）时的一行：说「没跑成」，不说「失败」，也不计入票的失败。
 * The line when infrastructure killed the gate (podman disconnected, etc.): says "didn't run", not "failed", and doesn't count against the ticket.
 */
export function gateInfraLine(issueId: string, reason: string): string {
  return t(`  ⚠ #${issueId} 门槛没跑成（${reason}），不算失败，稍后重试`, `  ⚠ #${issueId} gate didn't run (${reason}); not a failure, will retry`);
}

/**
 * 票落地时门槛偶发失败记入了哪些 flaky 票（可能是复用的老票，所以说「记入」）；没有票时返回 undefined，不打。
 * Which flaky tickets the gate's flaky failures were recorded in when the ticket lands (may be reused existing tickets, hence "recorded in"); undefined when there are none, so nothing is printed.
 */
export function flakyTicketsLine(issueId: string, tickets: string[]): string | undefined {
  if (tickets.length === 0) return undefined;
  return t(`  ⚠ #${issueId} 门槛偶发失败已记入 ${tickets.join("、")}`, `  ⚠ #${issueId} gate flaky failures recorded in ${tickets.join(", ")}`);
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export interface GateProgress {
  /** 日志文件路径。 / Path of the log file. */
  path: string;
  /** 传给 exec 的 onLine：去掉 ANSI 转义码后追加一行到日志文件并留在内存里。 / onLine for exec: strips ANSI escape codes, then appends the line to the log file and keeps it in memory. */
  onLine(line: string): void;
  /** 到目前为止的完整输出。 / The full output so far. */
  output(): string;
  /** 停掉心跳；门槛结束或抛错后都要调用。 / Stop the heartbeat; call when the gate ends or throws. */
  stop(): void;
}

/**
 * 开始记录一次门槛：建日志文件（同一秒重名时加 -2、-3 后缀），打印路径，启动心跳（unref，不让进程挂着）。
 * Start recording one gate run: create the log file (suffix -2, -3 on a same-second name clash), print its path, start the heartbeat (unref'd so it never keeps the process alive).
 */
export function startGateProgress(opts: {
  issueId: string;
  logDir: string;
  intervalMs?: number;
  now?: () => number;
  log?: (s: string) => void;
}): GateProgress {
  const { issueId, logDir, intervalMs = HEARTBEAT_MS, now = Date.now, log = console.log } = opts;
  mkdirSync(logDir, { recursive: true });
  const started = now();
  const base = `gate-${issueId}-${stamp(started)}`;
  let path = join(logDir, `${base}.log`);
  for (let i = 2; existsSync(path); i++) path = join(logDir, `${base}-${i}.log`);
  // 先建空文件，占住文件名，也让用户马上能 tail -f。
  // Create the empty file first to claim the name and let the user tail -f right away.
  appendFileSync(path, "");
  log(t(`  📄 #${issueId} 门槛输出实时写进 ${path}`, `  📄 #${issueId} gate output is written live to ${path}`));

  const lines: string[] = [];
  const timer = setInterval(() => {
    const took = duration(now() - started);
    log(t(`  ⏳ #${issueId} 门槛已跑 ${took}，输出见 ${path}`, `  ⏳ #${issueId} gate running for ${took}, output in ${path}`));
  }, intervalMs);
  timer.unref();

  let writeFailed = false;
  return {
    path,
    onLine(raw) {
      // 去掉 ANSI 转义码，日志文件和 output() 都是纯文本。 / Strip ANSI escape codes so the log file and output() are plain text.
      const line = stripVTControlCharacters(raw);
      lines.push(line);
      if (writeFailed) return;
      // 写日志失败（磁盘满、目录被删）不能打断门槛：警告一次，之后不再写，完整输出仍留在内存里。
      // A failed log write (disk full, directory removed) must not break the gate: warn once, stop writing, keep the full output in memory.
      try {
        appendFileSync(path, `${line}\n`);
      } catch (e) {
        writeFailed = true;
        log(t(`  ⚠ #${issueId} 门槛日志写不进 ${path}（${(e as Error).message}），之后不再写，门槛照跑`, `  ⚠ #${issueId} could not write the gate log ${path} (${(e as Error).message}); no longer writing it, the gate keeps running`));
      }
    },
    output: () => lines.join("\n"),
    stop: () => clearInterval(timer),
  };
}
