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
  acquireRunLock, errorLine, GATE_ENV_PREFIX, GateEnvError, gateEnvError, gateEnvReason, GateInfraError, imageExists, interruptNotice, isAgentIdleTimeout, isGateInfraFailure, missingImage, orphanContainers,
  parseContainers, podmanProblem, removeOrphanContainers, waitForPodman,
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

  it("断连时 ps 失败返回 [] 不抛；恢复后下一次调用删掉已退出的", () => {
    let up = false;
    const run = (_cmd: string, args: string[]): TryResult => {
      if (!up) return { ok: false, out: "Error: ssh: handshake failed: read tcp: connection reset by peer" };
      if (args[0] === "ps") return { ok: true, out: "id1\nid2" };
      if (args[0] === "inspect") return { ok: true, out };
      return { ok: true, out: "" };
    };
    expect(removeOrphanContainers(ROOT, true, run)).toEqual([]);
    up = true;
    expect(removeOrphanContainers(ROOT, true, run)).toEqual(["sandcastle-2"]);
  });
});

describe("门槛环境类错误", () => {
  it("取含 ECONNREFUSED 的那一行", () => {
    const out = "RUN  v3\n FAIL  test/db.test.ts\nError: connect ECONNREFUSED 127.0.0.1:5432\n  at TCPConnectWrap\n";
    expect(gateEnvError(1, out)).toBe("Error: connect ECONNREFUSED 127.0.0.1:5432");
  });
  it("DNS 失败：getaddrinfo EAI_AGAIN / ENOTFOUND", () => {
    expect(gateEnvError(1, "x\n  getaddrinfo EAI_AGAIN db\n")).toBe("getaddrinfo EAI_AGAIN db");
    expect(gateEnvError(1, "getaddrinfo ENOTFOUND redis")).toBe("getaddrinfo ENOTFOUND redis");
  });
  it("容器运行时连不上", () => {
    expect(gateEnvError(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock")).toContain("Docker daemon");
  });
  it("自定义 extra 正则追加规则", () => {
    const out = "ok\nMongoServerSelectionError: server selection timed out\n";
    expect(gateEnvError(1, out)).toBeNull();
    expect(gateEnvError(1, out, /MongoServerSelectionError/)).toBe("MongoServerSelectionError: server selection timed out");
  });
  it("No test files found 不算", () => {
    expect(gateEnvError(1, "No test files found, exiting with code 1")).toBeNull();
  });
  it("普通断言失败不算", () => {
    expect(gateEnvError(1, " FAIL  test/a.test.ts > adds\nAssertionError: expected 2 to be 3\n")).toBeNull();
  });
  it("退出码 0 不算", () => {
    expect(gateEnvError(0, "connect ECONNREFUSED 127.0.0.1:5432")).toBeNull();
  });
  it("自定义正则带 g 标志也每行都认", () => {
    expect(gateEnvError(1, "a Mongo down\nb Mongo down", /Mongo/g)).toBe("a Mongo down");
  });
  it("太长的行截到 200 个字符", () => {
    expect(gateEnvError(1, `connect ECONNREFUSED ${"x".repeat(500)}`)?.length).toBe(200);
  });
  it("GateEnvError 的消息带固定前缀", () => {
    const e = new GateEnvError("connect ECONNREFUSED 127.0.0.1:5432");
    expect(e.message).toBe(`${GATE_ENV_PREFIX} connect ECONNREFUSED 127.0.0.1:5432`);
    expect(GATE_ENV_PREFIX).toBe("gate env:");
  });
  it("gateEnvReason 从报错里取出匹配的那一行，别的报错返回 null", () => {
    expect(gateEnvReason(new GateEnvError("getaddrinfo EAI_AGAIN db"))).toBe("getaddrinfo EAI_AGAIN db");
    expect(gateEnvReason(new GateInfraError("Cannot connect to Podman"))).toBeNull();
    expect(gateEnvReason(new Error("boom"))).toBeNull();
  });
});

describe("门槛基础设施故障", () => {
  const podmanUp = (): TryResult => ({ ok: true, out: "arm64" });
  const podmanDown = (): TryResult => ({ ok: false, out: "Error: Cannot connect to Podman. Please verify your connection" });

  it("退出码 0 不算，也不去查 podman", () => {
    let called = false;
    expect(isGateInfraFailure(0, "", () => ((called = true), podmanDown()))).toBeNull();
    expect(called).toBe(false);
  });
  it("退出码 125 / 255 算基础设施故障", () => {
    expect(isGateInfraFailure(125, "", podmanUp)).toContain("125");
    expect(isGateInfraFailure(255, "", podmanUp)).toContain("255");
  });
  it("137 且 podman 连不上：基础设施故障，原因是 podman 的报错", () => {
    expect(isGateInfraFailure(137, "", podmanDown)).toBe("Cannot connect to Podman. Please verify your connection");
  });
  it("137 但 podman 正常：当作门槛真失败（多半 OOM）", () => {
    expect(isGateInfraFailure(137, "", podmanUp)).toBeNull();
  });
  it("普通失败（退出码 1、podman 正常）不算", () => {
    expect(isGateInfraFailure(1, "FAIL test/a.test.ts", podmanUp)).toBeNull();
  });
  it("stderr 命中连接类错误：取那一行", () => {
    const stderr = "\nError: ssh: handshake failed: read tcp 127.0.0.1:1->127.0.0.1:2: read: connection reset by peer\n";
    expect(isGateInfraFailure(1, stderr, podmanUp)).toBe("ssh: handshake failed: read tcp 127.0.0.1:1->127.0.0.1:2: read: connection reset by peer");
  });
  it("GateInfraError 的消息带固定前缀", () => {
    const e = new GateInfraError("Cannot connect to Podman");
    expect(e.message).toBe("gate infra: Cannot connect to Podman");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("waitForPodman", () => {
  it("第 2 次探测连上：返回 true，中间让出一次", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const run = (): TryResult => (++n >= 2 ? { ok: true, out: "arm64" } : { ok: false, out: "Cannot connect to Podman" });
    expect(await waitForPodman(run, async (ms) => void sleeps.push(ms), 60_000, 15_000)).toBe(true);
    expect(n).toBe(2);
    expect(sleeps).toEqual([15_000]);
  });
  it("等满预算还连不上：返回 false", async () => {
    const sleeps: number[] = [];
    expect(await waitForPodman(() => ({ ok: false, out: "down" }), async (ms) => void sleeps.push(ms), 30_000, 15_000)).toBe(false);
    expect(sleeps).toEqual([15_000, 15_000]);
  });
});

describe("镜像不存在的报错", () => {
  it("取出镜像名；别的报错返回 null", () => {
    expect(missingImage("Error: Image 'sandcastle:app' not found locally. Build it first with 'podman build -t sandcastle:app .'")).toBe("sandcastle:app");
    expect(missingImage("podman rm failed: x")).toBeNull();
  });
  it("imageExists 用 podman image exists 复查", () => {
    const calls: string[][] = [];
    expect(imageExists("sandcastle:app", (_c, args) => (calls.push(args), { ok: true, out: "" }))).toBe(true);
    expect(calls[0]).toEqual(["image", "exists", "sandcastle:app"]);
    expect(imageExists("sandcastle:app", () => ({ ok: false, out: "" }))).toBe(false);
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
