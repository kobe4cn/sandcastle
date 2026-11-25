// 门槛进度：心跳（假时钟）、日志文件与完整输出（临时目录）。
// Gate progress: heartbeat (fake timers), log file and full output (temp directory).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duration, startGateProgress } from "../src/gate-progress.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "gate-progress-"));

describe("startGateProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("开头打印日志路径，文件名带票号和时间戳", () => {
    const logs: string[] = [];
    const p = startGateProgress({ issueId: "42", logDir: tmp(), now: () => new Date(2026, 0, 2, 3, 4, 5).getTime(), log: (s) => logs.push(s) });
    p.stop();
    expect(p.path).toMatch(/gate-42-20260102-030405\.log$/);
    expect(logs).toEqual([`  📄 #42 门槛输出实时写进 ${p.path}`]);
  });

  it("同一秒再开一次另开新文件", () => {
    const dir = tmp();
    const now = () => new Date(2026, 0, 2, 3, 4, 5).getTime();
    const a = startGateProgress({ issueId: "7", logDir: dir, now, log: () => {} });
    a.onLine("x");
    const b = startGateProgress({ issueId: "7", logDir: dir, now, log: () => {} });
    a.stop();
    b.stop();
    expect(b.path).not.toBe(a.path);
  });

  it("每 5 分钟打印心跳，stop 后不再打印", () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    let clock = 0;
    const p = startGateProgress({ issueId: "9", logDir: tmp(), now: () => clock, log: (s) => logs.push(s) });
    logs.length = 0;
    clock = 5 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
    expect(logs).toEqual([`  ⏳ #9 门槛已跑 5.0 分钟，输出见 ${p.path}`]);
    clock = 10 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
    expect(logs).toHaveLength(2);
    p.stop();
    vi.advanceTimersByTime(30 * 60_000);
    expect(logs).toHaveLength(2);
  });

  it("文件内容和 output() 都是完整输出（超过 64KB 也不截断）", () => {
    const p = startGateProgress({ issueId: "1", logDir: tmp(), log: () => {} });
    const lines = ["GATE_TIER: selected", ...Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(60)}`), "GATE_FLAKY: a.test.ts"];
    for (const l of lines) p.onLine(l);
    p.stop();
    const full = lines.join("\n");
    expect(full.length).toBeGreaterThan(64 * 1024);
    expect(p.output()).toBe(full);
    expect(readFileSync(p.path, "utf8")).toBe(`${full}\n`);
  });
});

describe("startGateProgress 写日志失败", () => {
  it("日志文件写不进去时不抛错，output() 仍完整，只警告一次", () => {
    const dir = tmp();
    const logs: string[] = [];
    const p = startGateProgress({ issueId: "3", logDir: dir, log: (s) => logs.push(s) });
    rmSync(dir, { recursive: true, force: true });
    p.onLine("a");
    p.onLine("b");
    p.stop();
    expect(p.output()).toBe("a\nb");
    expect(logs.filter((l) => l.includes("写不进"))).toHaveLength(1);
  });
});

describe("duration", () => {
  it("不到一分钟显示秒，否则分钟", () => {
    expect(duration(12_000)).toBe("12 秒");
    expect(duration(90_000)).toBe("1.5 分钟");
  });
});
