// 门槛进度：门槛输出逐行实时写进 .sandcastle/logs/gate-<票号>-<时间戳>.log，并定时打印心跳（已用时间）。
// 终端不逐行打印门槛输出（run 有多个沙箱并行，会混在一起），只打印日志路径和心跳。
// 完整输出在这里自己累积：沙箱传了 onLine 后返回的 stdout 可能只剩末尾一段，档位、flaky 要看完整输出。
//
// Gate progress: gate output is appended line by line to .sandcastle/logs/gate-<issue>-<timestamp>.log, and a heartbeat (elapsed time) is printed periodically.
// The terminal doesn't echo gate output line by line (run has several sandboxes in parallel; it would interleave), only the log path and the heartbeat.
// The full output is accumulated here: once onLine is passed, the sandbox's returned stdout may be only a tail, and tier / flaky detection needs all of it.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { t } from "./term.ts";

/** 心跳间隔：5 分钟。 / Heartbeat interval: 5 minutes. */
export const HEARTBEAT_MS = 5 * 60_000;

/**
 * 用时文案：不到一分钟显示秒（小项目的门槛只跑几秒，显示「0.0 分钟」看不出用时），否则分钟。
 * Duration text: seconds under a minute (small projects' gates take seconds, and "0.0 min" says nothing), minutes otherwise.
 */
export const duration = (ms: number) =>
  ms < 60_000 ? t(`${Math.round(ms / 1000)} 秒`, `${Math.round(ms / 1000)}s`) : t(`${(ms / 60_000).toFixed(1)} 分钟`, `${(ms / 60_000).toFixed(1)} min`);

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export interface GateProgress {
  /** 日志文件路径。 / Path of the log file. */
  path: string;
  /** 传给 exec 的 onLine：追加一行到日志文件并留在内存里。 / onLine for exec: appends a line to the log file and keeps it in memory. */
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
    onLine(line) {
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
