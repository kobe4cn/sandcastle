// 门槛进度：心跳（假时钟）、日志文件与完整输出（临时目录）。
// Gate progress: heartbeat (fake timers), log file and full output (temp directory).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duration, flakyTicketsLine, gateDoneLine, gateEnv, gateInfraLine, startGateProgress } from "../src/gate-progress.ts";
import { setTermLanguage } from "../src/term.ts";

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

  it("带 ANSI 转义码的行：文件内容和 output() 都是纯文本，文字保留", () => {
    const p = startGateProgress({ issueId: "2", logDir: tmp(), log: () => {} });
    p.onLine("\x1b[33m FAIL \x1b[39m src/a.test.ts");
    p.onLine("\x1b[2m✓\x1b[22m src/b.test.ts");
    p.stop();
    const plain = " FAIL  src/a.test.ts\n✓ src/b.test.ts";
    expect(p.output()).toBe(plain);
    expect(p.output()).not.toContain("\x1b");
    expect(readFileSync(p.path, "utf8")).toBe(`${plain}\n`);
  });
});

describe("gateEnv", () => {
  it("没给覆盖时有默认值 NO_COLOR=1、FORCE_COLOR=0", () => {
    expect(gateEnv({ A: "x" })).toEqual({ NO_COLOR: "1", FORCE_COLOR: "0", A: "x" });
  });

  it("env 里的 NO_COLOR 覆盖默认值", () => {
    expect(gateEnv({ NO_COLOR: "" })).toEqual({ NO_COLOR: "", FORCE_COLOR: "0" });
  });

  it("overrides 里的 FORCE_COLOR 同时覆盖默认值和 env", () => {
    expect(gateEnv({ FORCE_COLOR: "2" }, { FORCE_COLOR: "1" })).toEqual({ NO_COLOR: "1", FORCE_COLOR: "1" });
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

describe("gateDoneLine / flakyTicketsLine", () => {
  it("门槛通过且有偶发失败时带标记，和 main 兜底的写法一致", () => {
    expect(gateDoneLine("7", "按依赖选门槛用时 3 秒", true, true)).toBe("  ⏱ #7 按依赖选门槛用时 3 秒，通过（有偶发失败，重跑通过）");
    expect(gateDoneLine("7", "按依赖选门槛用时 3 秒", true, false)).toBe("  ⏱ #7 按依赖选门槛用时 3 秒，通过");
    expect(gateDoneLine("7", "按依赖选门槛用时 3 秒", false, true)).toBe("  ⏱ #7 按依赖选门槛用时 3 秒，失败");
  });

  it("记入的票号另打一行；没有票时不打", () => {
    expect(flakyTicketsLine("7", ["#12", "#13"])).toBe("  ⚠ #7 门槛偶发失败已记入 #12、#13");
    expect(flakyTicketsLine("7", [])).toBeUndefined();
  });

  it("门槛没跑成（基础设施故障）：不说失败", () => {
    expect(gateInfraLine("7", "Cannot connect to Podman")).toBe("  ⚠ #7 门槛没跑成（Cannot connect to Podman），不算失败，稍后重试");
  });

  it("英文", () => {
    try {
      setTermLanguage("en", {});
      expect(gateDoneLine("7", "gate took 3s", true, true)).toBe("  ⏱ #7 gate took 3s, passed (flaky failures passed on rerun)");
      expect(gateDoneLine("7", "gate took 3s", true, false)).toBe("  ⏱ #7 gate took 3s, passed");
      expect(gateDoneLine("7", "gate took 3s", false, true)).toBe("  ⏱ #7 gate took 3s, failed");
      expect(flakyTicketsLine("7", ["#12", "#13"])).toBe("  ⚠ #7 gate flaky failures recorded in #12, #13");
      expect(flakyTicketsLine("7", [])).toBeUndefined();
      expect(gateInfraLine("7", "Cannot connect to Podman")).toBe("  ⚠ #7 gate didn't run (Cannot connect to Podman); not a failure, will retry");
    } finally {
      setTermLanguage("zh", {});
    }
  });
});
