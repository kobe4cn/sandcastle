// 日志轮转：过期 .log 删除、errors.log 按大小轮转（临时目录、注入 now）。
// Log rotation: expired .log removal and size-based errors.log rotation (temp directory, injected now).
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ERROR_LOG_MAX_BYTES, LOG_MAX_AGE_DAYS, pruneLogs } from "../src/log-rotate.ts";

const DAY = 24 * 60 * 60 * 1000;
// 文件的旧 mtime 和注入的 now：now 比 OLD 晚（上限 + 1）天，OLD 上的文件都算过期。
// The files' old mtime and the injected now: now is (the cap + 1) days after OLD, so a file stamped OLD counts as expired.
const OLD = new Date(2026, 0, 1).getTime();
const NOW = OLD + (LOG_MAX_AGE_DAYS + 1) * DAY;

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "log-rotate-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
/** 建一个文件并把 mtime（和 atime）调到 at（utimesSync 的数字参数按秒算，要传 Date）。 / Create a file and set its mtime (and atime) to at (utimesSync takes numbers as seconds, so pass a Date). */
const file = (dir: string, name: string, at: number, content = "x") => {
  const path = join(dir, name);
  writeFileSync(path, content);
  utimesSync(path, new Date(at), new Date(at));
  return path;
};

describe("pruneLogs", () => {
  it("删掉超过 14 天的会话日志、门槛日志和过期的 errors.log.1", () => {
    const dir = tmp();
    const old1 = file(dir, "feature-12-1.log", OLD);
    const old2 = file(dir, "gate-12-20260102-030405.log", OLD);
    const old3 = file(dir, "errors.log.1", OLD);
    const r = pruneLogs(dir, NOW);
    expect(r.removed.sort()).toEqual(["errors.log.1", "feature-12-1.log", "gate-12-20260102-030405.log"]);
    expect(r.rotated).toEqual([]);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(old3)).toBe(false);
  });

  it("14 天内（含正好 14 天）的 .log 保留", () => {
    const dir = tmp();
    const fresh = file(dir, "implement-13-1.log", NOW);
    const edge = file(dir, "gate-13-20260115-000000.log", NOW - LOG_MAX_AGE_DAYS * DAY);
    const r = pruneLogs(dir, NOW);
    expect(r).toEqual({ removed: [], rotated: [] });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(edge)).toBe(true);
  });

  it("errors.log 超过 10 MB 轮转为 errors.log.1，覆盖旧备份；之后目录里只剩备份", () => {
    const dir = tmp();
    file(dir, "errors.log.1", OLD, "old backup");
    file(dir, "errors.log", NOW, "y".repeat(ERROR_LOG_MAX_BYTES + 1));
    const r = pruneLogs(dir, NOW);
    expect(r.rotated).toEqual(["errors.log"]);
    expect(existsSync(join(dir, "errors.log"))).toBe(false);
    expect(existsSync(join(dir, "errors.log.1"))).toBe(true);
    expect(statSync(join(dir, "errors.log.1")).size).toBe(ERROR_LOG_MAX_BYTES + 1);
  });

  it("errors.log 正好 10 MB（未超过）不轮转", () => {
    const dir = tmp();
    file(dir, "errors.log", NOW, "y".repeat(ERROR_LOG_MAX_BYTES));
    const r = pruneLogs(dir, NOW);
    expect(r).toEqual({ removed: [], rotated: [] });
    expect(existsSync(join(dir, "errors.log"))).toBe(true);
  });

  it("usage.jsonl、*.json、run.lock、onboard.md 无论多旧都保留，子目录不进", () => {
    const dir = tmp();
    const usage = file(dir, "usage.jsonl", OLD);
    const flaky = file(dir, "flaky.json", OLD);
    const lock = file(dir, "run.lock", OLD);
    const onboard = file(dir, "onboard.md", OLD);
    const sub = join(dir, "old.log");
    mkdirSync(sub);
    utimesSync(sub, new Date(OLD), new Date(OLD));
    const r = pruneLogs(dir, NOW);
    expect(r).toEqual({ removed: [], rotated: [] });
    expect(existsSync(usage)).toBe(true);
    expect(existsSync(flaky)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(onboard)).toBe(true);
    expect(existsSync(sub)).toBe(true);
  });

  it("目录不存在时不抛错，返回空结果", () => {
    expect(pruneLogs(join(tmp(), "nope"), NOW)).toEqual({ removed: [], rotated: [] });
  });
});
