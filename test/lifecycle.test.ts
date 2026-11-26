// 运行的生命周期：运行锁、podman 检查、孤儿容器只删本仓库的、报错只取一行、Ctrl-C 提示、收尾兜底退出。
// Run lifecycle: run lock, podman check, orphan cleanup limited to this repo, one-line errors, the Ctrl-C notice, the exit fallback.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import {
  acquireRunLock, errorLine, interruptNotice, isAgentIdleTimeout, orphanContainers, parseContainers, podmanProblem, removeOrphanContainers,
} from "../src/lifecycle.ts";
import type { TryResult } from "../src/shell.ts";
import { setTermLanguage } from "../src/term.ts";

const dir = mkdtempSync(join(tmpdir(), "sandpipe-lifecycle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => setTermLanguage("zh", {}));

describe("acquireRunLock", () => {
  it("没有锁时拿到，写入 pid；release 删掉", () => {
    const path = join(dir, "a", "run.lock");
    const lock = acquireRunLock(path, 111, () => true);
    expect(lock.ok).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("111");
    if (lock.ok) lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("锁里的 pid 还活着：拿不到，返回对方 pid", () => {
    const path = join(dir, "b.lock");
    writeFileSync(path, "222\n");
    const lock = acquireRunLock(path, 111, (pid) => pid === 222);
    expect(lock).toEqual({ ok: false, pid: 222 });
    expect(readFileSync(path, "utf8").trim()).toBe("222");
  });

  it("锁里的 pid 已经死了（上次被 SIGKILL）：接管", () => {
    const path = join(dir, "c.lock");
    writeFileSync(path, "333\n");
    const lock = acquireRunLock(path, 111, () => false);
    expect(lock.ok).toBe(true);
    if (lock.ok) expect(lock.stale).toBe(333);
    expect(readFileSync(path, "utf8").trim()).toBe("111");
  });

  it("release 不删别人的锁", () => {
    const path = join(dir, "d.lock");
    const lock = acquireRunLock(path, 111, () => false);
    writeFileSync(path, "444\n");
    if (lock.ok) lock.release();
    expect(readFileSync(path, "utf8").trim()).toBe("444");
  });
});

describe("孤儿容器", () => {
  const ROOT = "/Users/me/dev/app";
  const out = [
    `/sandcastle-1|running|${ROOT}/.sandcastle/worktrees/sandcastle-issue-3,${ROOT}/.git,`,
    `sandcastle-2|exited|${ROOT}/.sandcastle/worktrees/sandcastle-issue-4,${ROOT}/.git,`,
    `sandcastle-3|running|${ROOT},`,
    `sandcastle-4|running|/Users/me/dev/app-trial/.sandcastle/worktrees/sandcastle-issue-21,/Users/me/dev/app-trial/.git,`,
    `sandcastle-5|exited|/Users/me/dev/other/.git,`,
    `postgres|exited|${ROOT}/data,`,
    `sandcastle-6|created|${ROOT}/.git,`,
  ].join("\n");

  it("启动时删本仓库全部 sandcastle 容器；别的仓库（含同名前缀的 app-trial）和非 sandcastle 容器不碰", () => {
    expect(orphanContainers(parseContainers(out), [ROOT], false)).toEqual(["sandcastle-1", "sandcastle-2", "sandcastle-3", "sandcastle-6"]);
  });

  it("运行中只删本仓库已退出的（刚建还没跑起来的 created 不算）", () => {
    expect(orphanContainers(parseContainers(out), [ROOT], true)).toEqual(["sandcastle-2"]);
  });

  it("removeOrphanContainers：ps → inspect → 逐个 rm，返回删掉的", () => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]): TryResult => {
      calls.push(`${cmd} ${args[0]}`);
      if (args[0] === "ps") return { ok: true, out: "id1\nid2" };
      if (args[0] === "inspect") return { ok: true, out };
      return { ok: args[2] !== "sandcastle-3", out: "" };
    };
    expect(removeOrphanContainers(ROOT, false, run)).toEqual(["sandcastle-1", "sandcastle-2", "sandcastle-6"]);
    expect(calls.filter((c) => c === "podman rm")).toHaveLength(4);
  });

  it("podman 列不出容器时什么都不做", () => {
    expect(removeOrphanContainers(ROOT, false, () => ({ ok: false, out: "Cannot connect to Podman" }))).toEqual([]);
  });
});

describe("podmanProblem", () => {
  it("podman info 通过时返回 null", () => {
    expect(podmanProblem(() => ({ ok: true, out: "arm64" }))).toBeNull();
  });
  it("不通过时返回第一行原因", () => {
    const r = podmanProblem(() => ({ ok: false, out: "\nError: Cannot connect to Podman. Please verify your connection\nmore" }));
    expect(r).toBe("Cannot connect to Podman. Please verify your connection");
  });
});

describe("报错只取一行", () => {
  const fiber = {
    toString: () =>
      "(FiberFailure) AgentIdleTimeoutError: Agent idle for 20 seconds — no output received. Consider increasing the idle timeout with --idle-timeout.\n    at <anonymous> (/x/node_modules/@ai-hero/sandcastle/src/Orchestrator.ts:111:15)",
  };

  it("去掉 FiberFailure 前缀和堆栈", () => {
    expect(errorLine(fiber)).toBe("AgentIdleTimeoutError: Agent idle for 20 seconds — no output received. Consider increasing the idle timeout with --idle-timeout.");
    expect(errorLine(new Error("boom"))).toBe("Error: boom");
    expect(errorLine(Object.assign(new Error("x"), { stderr: "gh: not found\nusage" }))).toBe("gh: not found");
  });

  it("认出 agent 空闲超时；评论建议调 agentIdleTimeoutS，不提 --idle-timeout", () => {
    expect(isAgentIdleTimeout(fiber)).toBe(true);
    expect(isAgentIdleTimeout(new Error("boom"))).toBe(false);
    for (const lang of ["zh", "en"] as const) {
      const text = messages(lang).agentIdleTimeout(1200, "sandcastle:stuck");
      expect(text).toContain("agentIdleTimeoutS");
      expect(text).toContain("1200");
      expect(text).not.toContain("--idle-timeout");
    }
  });
});

describe("interruptNotice", () => {
  it("列出做到一半和在等检查的票，说明不用手动清理", () => {
    const zh = interruptNotice(["47"], ["43"]);
    expect(zh).toContain("#47");
    expect(zh).toContain("#43");
    expect(zh).toContain("不用手动清理");
    setTermLanguage("en", {});
    expect(interruptNotice([], [])).toContain("no ticket was in progress");
  });
});

// 起子进程：真的发 SIGINT、真的留一个漏掉的定时器。 / Child processes: a real SIGINT, a real leaked timer.
const LIFECYCLE = pathToFileURL(fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url))).href;
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const runScript = (name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, `import { exitWhenDone, onInterrupt } from ${JSON.stringify(LIFECYCLE)};\n${body}\n`);
  return spawnSync(process.execPath, ["--import", TSX, file], {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SANDPIPE_LANG: "en" },
  });
};

describe("子进程", () => {
  it("Ctrl-C：打一行提示，退出码 130", () => {
    const r = runScript(
      "int.ts",
      `onInterrupt(() => ({ inProgress: ["47"], waitingChecks: [] }));\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.kill(process.pid, "SIGINT"), 50);`,
    );
    expect(r.status).toBe(130);
    expect(r.stderr).toContain("Interrupted. in progress: #47");
    expect(r.stderr).toContain("no manual cleanup needed");
  }, 30_000);

  it("Ctrl-C 时库也装了 SIGINT 处理（清理后 process.exit(1)）：提示打在库的输出之后，退出码仍是 130", () => {
    const r = runScript(
      "int-lib.ts",
      `onInterrupt(() => ({ inProgress: [], waitingChecks: ["43"] }));\nprocess.on("SIGINT", () => { console.error("Worktree preserved at /x"); process.exit(1); });\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.kill(process.pid, "SIGINT"), 50);`,
    );
    expect(r.status).toBe(130);
    expect(r.stderr.indexOf("Worktree preserved")).toBeLessThan(r.stderr.indexOf("waiting for PR checks: #43"));
  }, 30_000);

  it("收尾兜底：有漏掉的定时器时按 exitCode 退出（库的空闲提醒 fiber 漏掉后进程不退，e2e L6）", () => {
    const started = Date.now();
    const r = runScript("leak.ts", `setInterval(() => {}, 60_000);\nprocess.exitCode = 3;\nexitWhenDone(200);`);
    expect(r.status).toBe(3);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("收尾兜底：没有挂着的东西时照常自己退出", () => {
    const started = Date.now();
    const r = runScript("clean.ts", `console.log("done");\nexitWhenDone(10_000);`);
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(r.stdout).toContain("done");
  }, 30_000);
});
