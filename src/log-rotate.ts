// 日志轮转：清 `.sandcastle/logs/`，一直运行（守护进程）时不再无限增长（#65 之二）。
// 只按 mtime 判断新旧：会话日志的名字固定（如 implement-12-1），重启后续写同一个文件，名字里没有可靠的时间；正在写的文件 mtime 是新的，不会被删。
// usage.jsonl 不在清理范围：readUsage 每次整份读回（续做的预算、prep 的用量都靠它），轮转会丢数据。
//
// Log rotation: pruning `.sandcastle/logs/` so an always-on (daemonized) run no longer grows it without bound (#65 part 2).
// Age is judged by mtime alone: session log names are fixed (e.g. implement-12-1) and a resumed run appends to the same file, so the name carries no reliable time; a file being written has a fresh mtime and is never removed.
// usage.jsonl is out of scope: readUsage reads it back in full each time (resumed budgets and prep usage depend on it), and rotating it would lose data.

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** 过期线：`.log`（含 `errors.log.1`）最后修改超过这么多天就删。 / Expiry: a `.log` (or `errors.log.1`) last modified more than this many days ago is removed. */
export const LOG_MAX_AGE_DAYS = 14;

/** errors.log 的轮转门槛：超过这个字节数改名为 errors.log.1（覆盖旧备份）。 / Rotation threshold for errors.log: past this many bytes it is renamed to errors.log.1 (overwriting the old backup). */
export const ERROR_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** errors.log 的名字和轮转后的备份名。 / errors.log's name and the backup name after rotation. */
const ERROR_LOG_NAME = "errors.log";
const ERROR_LOG_BACKUP = "errors.log.1";

/** pruneLogs 用到的文件操作，注入以便测试。 / The file operations pruneLogs uses, injected for testing. */
export interface PruneFs {
  readdirSync(path: string): string[];
  statSync(path: string): { isFile(): boolean; mtimeMs: number; size: number };
  rmSync(path: string): void;
  renameSync(from: string, to: string): void;
}

const nodeFs: PruneFs = { readdirSync, statSync, rmSync, renameSync };

/**
 * 清一次日志目录，只看 dir 下一层的普通文件，分两步：
 * 1. 删最后修改超过 LOG_MAX_AGE_DAYS 天的 `*.log`（agent 会话日志、门槛日志、errors.log）和过期的 `errors.log.1`；
 * 2. 之后 `errors.log` 超过 ERROR_LOG_MAX_BYTES 时改名为 `errors.log.1`，覆盖旧备份（logErrorDetail 是追加写，改名后下次写入自动新建空文件）。
 * `usage.jsonl`、`*.json`、`run.lock`、`onboard.md`、目录和其他文件不碰。目录不存在返回空结果，其余错误照常抛给调用方。
 * Prune the logs directory once, looking only at regular files directly under dir, in two steps:
 * 1. remove `*.log` files (agent session logs, gate logs, errors.log) and `errors.log.1` last modified more than LOG_MAX_AGE_DAYS days ago;
 * 2. then rename `errors.log` to `errors.log.1` when it exceeds ERROR_LOG_MAX_BYTES, overwriting the old backup (logErrorDetail appends, so the next write recreates an empty file on its own).
 * `usage.jsonl`, `*.json`, `run.lock`, `onboard.md`, directories and anything else are untouched. A missing directory returns an empty result; any other error propagates to the caller.
 */
export function pruneLogs(dir: string, now: number = Date.now(), fs: PruneFs = nodeFs): { removed: string[]; rotated: string[] } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    // 目录不存在就是没有要清的；别的错误（没权限等）抛给调用方决定。
    // A missing directory simply means nothing to prune; other errors (no permission, etc.) propagate for the caller to decide.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], rotated: [] };
    throw e;
  }
  const cutoff = now - LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of names) {
    if (name !== ERROR_LOG_BACKUP && !name.endsWith(".log")) continue;
    let st: { isFile(): boolean; mtimeMs: number };
    try {
      st = fs.statSync(join(dir, name));
    } catch {
      // 列目录之后文件没了（并行的会话刚轮转掉等）：跳过它。
      // The file vanished after the listing (a parallel session just rotated it): skip it.
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= cutoff) continue;
    fs.rmSync(join(dir, name));
    removed.push(name);
  }
  const rotated: string[] = [];
  const errorLog = join(dir, ERROR_LOG_NAME);
  let st: { isFile(): boolean; size: number };
  try {
    st = fs.statSync(errorLog);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed, rotated };
    throw e;
  }
  if (st.isFile() && st.size > ERROR_LOG_MAX_BYTES) {
    fs.renameSync(errorLog, join(dir, ERROR_LOG_BACKUP));
    rotated.push(ERROR_LOG_NAME);
  }
  return { removed, rotated };
}
