// 运行的生命周期：运行锁、podman 检查、孤儿容器只删本仓库的、报错只取一行、Ctrl-C 提示、收尾兜底退出、镜像是否按当前 Containerfile 建（过期判断）。
// Run lifecycle: run lock, podman check, orphan cleanup limited to this repo, one-line errors, the Ctrl-C notice, the exit fallback.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../src/i18n.ts";
import {
  acquireRunLock, AGENT_AUTH_PREFIX, AgentAuthError, agentAuthReason, AUTH_MAX_HITS, authHitCapped, authRecovered, buildImageArgs, nextAuthHits, containerfileHash, errorLine, findContainerfile, GATE_ENV_PREFIX, GateEnvError, gateEnvError, gateEnvReason, GateInfraError, idleProgress, idleStop, IMAGE_LABEL, imageExists, interruptNotice, isAgentIdleTimeout, isGateInfraFailure, imageLabel, imageStaleWarning, missingImage, orphanContainers,
  parseContainers, podmanProblem, removeOrphanContainers, retryTransient, untilAuthRecovered, waitForPodman,
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

describe("临时错误重跑（#176）", () => {
  it("沙箱初始化时 git 读配置失败（fatal: unknown error occurred …，退出码 128）：等 60 秒整步重跑，打 ⚠ 不打 stuck", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const sleeps: number[] = [];
    const out = await retryTransient(
      "#176",
      async () => {
        if (++calls === 1) throw new Error('Command failed (exit 128): git config --global user.name "x"\nfatal: unknown error occurred while reading the configuration files');
        return "done";
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(out).toBe("done");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60_000]);
    // 匹配的是 String(e) 整段文本；⚠ 行只显示第一行。 / What's matched is the whole String(e) text; the ⚠ line only shows the first line.
    expect(warn.mock.calls.flat().join("\n")).toContain("撞上临时错误");
    expect(warn.mock.calls.flat().join("\n")).toContain("Command failed (exit 128): git config --global user.name");
    warn.mockRestore();
  });

  it("其他退出码 128 的 git 错误（not a git repository）不算临时错误：原样抛出，不等待", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const e = new Error("Command failed (exit 128): git rev-parse --abbrev-ref HEAD\nfatal: not a git repository (or any of the parent directories): .git");
    await expect(
      retryTransient(
        "#176",
        async () => {
          calls++;
          throw e;
        },
        { sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBe(e);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("会话认证失效（#62 之三）", () => {
  it("AgentAuthError 的消息带固定前缀；agentAuthReason 取出那一行，包了一层 (FiberFailure) 的也认，别的报错返回 null", () => {
    const e = new AgentAuthError("invalid API key · Please run /login");
    expect(e.message).toBe(`${AGENT_AUTH_PREFIX} invalid API key · Please run /login`);
    expect(e.name).toBe("AgentAuthError");
    expect(AGENT_AUTH_PREFIX).toBe("agent auth:");
    expect(agentAuthReason(e)).toBe("invalid API key · Please run /login");
    // Effect 会把错误包成 (FiberFailure)：前缀在整段文本里，indexOf 认得到，不能靠 instanceof。
    // Effect wraps errors as (FiberFailure): the prefix sits inside the whole text, so indexOf finds it; instanceof can't be relied on.
    expect(agentAuthReason(new Error("(FiberFailure) Error: agent auth: OAuth token has expired\n    at x"))).toBe("OAuth token has expired");
    expect(agentAuthReason(new GateEnvError("connect ECONNREFUSED 127.0.0.1:5432"))).toBeNull();
    expect(agentAuthReason(new Error("boom"))).toBeNull();
    expect(agentAuthReason(undefined)).toBeNull();
  });

  it("太长的原因截到 200 个字符", () => {
    expect(agentAuthReason(new AgentAuthError("x".repeat(300)))?.length).toBe(200);
  });

  it("authRecovered：指纹变了就算恢复；没变要等满 maxWaitMs（默认 30 分钟）", () => {
    const down = { fingerprint: "aaa", since: 1_000 };
    expect(authRecovered(down, "bbb", 1_000)).toBe(true);
    expect(authRecovered(down, "aaa", 1_000 + 30 * 60_000)).toBe(true);
    expect(authRecovered(down, "aaa", 1_000 + 30 * 60_000 - 1)).toBe(false);
    expect(authRecovered(down, "aaa", 1_000 + 60_000, 60_000)).toBe(true);
    expect(authRecovered(down, "aaa", 1_000 + 60_000 - 1, 60_000)).toBe(false);
  });

  it("untilAuthRecovered：凭据换过就重跑成功，并调 onUp", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let fp = "aaa";
    let calls = 0;
    const downs: string[] = [];
    let ups = 0;
    const sleeps: number[] = [];
    const out = await untilAuthRecovered(
      "#7",
      async () => {
        if (++calls === 1) throw new AgentAuthError("OAuth token has expired");
        return 42;
      },
      {
        fingerprint: () => fp,
        onDown: (reason) => downs.push(reason),
        onUp: () => ups++,
        sleep: async (ms) => {
          sleeps.push(ms);
          fp = "bbb"; // 睡的这一会儿里有人换了凭据 / the credentials get swapped while it sleeps
        },
        now: () => 1_000,
      },
    );
    expect(out).toBe(42);
    expect(calls).toBe(2);
    expect(downs).toEqual(["OAuth token has expired"]);
    expect(ups).toBe(1);
    expect(sleeps).toEqual([60_000]);
    expect(log.mock.calls.flat().join("\n")).toContain("凭据已换过");
    log.mockRestore();
  });

  it("untilAuthRecovered：指纹不变，等满 maxWaitMs 才重跑", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let now = 1_000_000;
    let calls = 0;
    const sleeps: number[] = [];
    const out = await untilAuthRecovered(
      "#7",
      async () => {
        if (++calls === 1) throw new AgentAuthError("invalid API key");
        return "done";
      },
      {
        fingerprint: () => "same",
        onDown: () => {},
        onUp: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        now: () => now,
        maxWaitMs: 180_000,
      },
    );
    expect(out).toBe("done");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(log.mock.calls.flat().join("\n")).toContain("等满 30 分钟");
    log.mockRestore();
  });

  it("untilAuthRecovered：其他错误照抛，不调 onDown", async () => {
    let downs = 0;
    await expect(
      untilAuthRecovered(
        "#7",
        async () => {
          throw new Error("container exited 137");
        },
        { fingerprint: () => "x", onDown: () => downs++, onUp: () => {} },
      ),
    ).rejects.toThrow("container exited 137");
    expect(downs).toBe(0);
  });

  // 上限（#142 打回后定的）：误判的认证失效每 30 分钟重跑一次会让整条运行卡死，
  // 凭据一直没换时同一张票最多撞 3 次（含第一次），到上限按普通失败抛出去（打 stuck）。
  // The cap (decided after #142's review): a misdetected auth failure rerunning every 30 minutes would hang the
  // whole run, so with the credentials never replaced a ticket hits at most 3 times (the first included); at the
  // cap the error is rethrown as an ordinary failure (marked stuck).
  it("untilAuthRecovered：指纹一直不变，撞满 3 次（含第一次）后不再等：调 onCap、把错误抛出去", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let now = 1_000_000;
    let calls = 0;
    const downs: string[] = [];
    let caps = 0;
    const sleeps: number[] = [];
    const err = await untilAuthRecovered(
      "#7",
      async () => {
        calls++;
        throw new AgentAuthError("invalid API key");
      },
      {
        fingerprint: () => "same",
        onDown: (reason) => downs.push(reason),
        onUp: () => {
          throw new Error("onUp must not be called");
        },
        onCap: () => caps++,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        now: () => now,
        maxWaitMs: 60_000,
      },
    ).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect((err as Error).name).toBe("AgentAuthError");
    expect(downs).toEqual(["invalid API key", "invalid API key"]);
    expect(caps).toBe(1);
    // 头两次各等一个 maxWaitMs，第三次不再等 / the first two hits each wait one maxWaitMs, the third doesn't wait
    expect(sleeps).toEqual([60_000, 60_000]);
    log.mockRestore();
  });

  it("untilAuthRecovered：凭据换过后计数重新数，同样的次数不会到上限", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let fp = "aaa";
    let now = 0;
    let calls = 0;
    const downs: string[] = [];
    let caps = 0;
    const out = await untilAuthRecovered(
      "#7",
      async () => {
        calls++;
        if (calls <= 3) throw new AgentAuthError("OAuth token has expired");
        return "ok";
      },
      {
        fingerprint: () => fp,
        onDown: (reason) => downs.push(reason),
        onUp: () => {},
        onCap: () => caps++,
        sleep: async (ms) => {
          now += ms;
          if (calls === 1) fp = "bbb"; // 每次等待里都有人换凭据 / the credentials get swapped during each wait
          else if (calls === 2) fp = "ccc";
        },
        now: () => now,
        maxWaitMs: 60_000,
      },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(4);
    expect(downs.length).toBe(3);
    expect(caps).toBe(0);
    log.mockRestore();
  });

  it("nextAuthHits：指纹不变连续撞 3 次到上限（build 和 prep 共用）", () => {
    expect(AUTH_MAX_HITS).toBe(3);
    const h1 = nextAuthHits(undefined, "fp-a");
    expect(h1).toEqual({ count: 1, fingerprint: "fp-a" });
    expect(authHitCapped(h1)).toBe(false);
    const h2 = nextAuthHits(h1, "fp-a");
    expect(h2.count).toBe(2);
    expect(authHitCapped(h2)).toBe(false);
    const h3 = nextAuthHits(h2, "fp-a");
    expect(h3.count).toBe(3);
    expect(authHitCapped(h3)).toBe(true);
  });

  it("nextAuthHits：指纹变了计数从 1 重新数", () => {
    const h2 = nextAuthHits(nextAuthHits(undefined, "fp-a"), "fp-a");
    const h = nextAuthHits(h2, "fp-b");
    expect(h).toEqual({ count: 1, fingerprint: "fp-b" });
    expect(authHitCapped(nextAuthHits(h, "fp-b"))).toBe(false);
    expect(authHitCapped(h2, 2)).toBe(true);
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

describe("镜像构建参数", () => {
  it("containerfileHash 是文件字节的 sha256 十六进制；内容变了哈希也变", () => {
    const file = join(dir, "Containerfile");
    writeFileSync(file, "abc");
    // sha256("abc")
    expect(containerfileHash(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    writeFileSync(file, "abd");
    expect(containerfileHash(file)).not.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("buildImageArgs：-t 镜像、--label 带内容哈希、-f Containerfile、上下文目录是它所在目录", () => {
    const file = join(dir, "app", ".sandcastle", "Containerfile");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "FROM node:22\n");
    expect(buildImageArgs("sandcastle:app", file)).toEqual([
      "build",
      "-t",
      "sandcastle:app",
      "--label",
      `${IMAGE_LABEL}=${containerfileHash(file)}`,
      "-f",
      file,
      dirname(file),
    ]);
    expect(IMAGE_LABEL).toBe("sandpipe.containerfile");
  });
});

describe("镜像过期判断", () => {
  /** 建一个 Containerfile 并返回它和内容哈希。 */
  const containerfile = (name: string, content = "FROM node:22\n") => {
    const file = join(dir, "stale", name, ".sandcastle", "Containerfile");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return { file, hash: containerfileHash(file) };
  };
  /** image exists 成功、image inspect 返回 label 的假 run。 */
  const withLabel = (label: string) => (_cmd: string, args: string[]) => ({
    ok: true,
    out: args[1] === "inspect" ? label : "",
  });

  it("imageLabel 用 podman image inspect 读 label；失败、空串、<no value> 返回 undefined", () => {
    const calls: string[][] = [];
    const inspect = (_cmd: string, args: string[]) => (calls.push(args), { ok: true, out: "  abc\n" });
    expect(imageLabel("sandcastle:app", inspect)).toBe("abc");
    expect(calls[0]).toEqual(["image", "inspect", "--format", `{{index .Labels "${IMAGE_LABEL}"}}`, "sandcastle:app"]);
    expect(imageLabel("sandcastle:app", () => ({ ok: false, out: "Error" }))).toBeUndefined();
    expect(imageLabel("sandcastle:app", () => ({ ok: true, out: "   " }))).toBeUndefined();
    // label 没打上时 Go 模板对缺 key 的 index 输出 <no value>
    expect(imageLabel("sandcastle:app", withLabel("<no value>"))).toBeUndefined();
  });

  it("imageStaleWarning：label 与当前 Containerfile 的哈希一致时 null", () => {
    const { file, hash } = containerfile("match");
    expect(imageStaleWarning("sandcastle:app", file, withLabel(hash))).toBeNull();
  });

  it("imageStaleWarning：label 对不上或缺失时报过期并提示 doctor --fix", () => {
    const { file } = containerfile("changed", "FROM node:22\nRUN x\n");
    const stale = imageStaleWarning("sandcastle:app", file, withLabel("0".repeat(64)));
    expect(stale).toContain("Containerfile 改过");
    expect(stale).toContain("sandcastle:app");
    expect(stale).toContain("sandpipe doctor --fix");
    expect(imageStaleWarning("sandcastle:app", file, withLabel(""))).toContain("镜像 sandcastle:app 过期");
  });

  it("imageStaleWarning：镜像不存在或没有 Containerfile 时 null", () => {
    const { file } = containerfile("absent");
    expect(imageStaleWarning("sandcastle:app", file, () => ({ ok: false, out: "" }))).toBeNull();
    expect(imageStaleWarning("sandcastle:app", undefined, withLabel("whatever"))).toBeNull();
  });

  it("imageStaleWarning（英文）：报过期并提示 doctor --fix", () => {
    setTermLanguage("en", {});
    const { file } = containerfile("en");
    const stale = imageStaleWarning("sandcastle:app", file, withLabel(""));
    expect(stale).toContain("The Containerfile changed");
    expect(stale).toContain("sandpipe doctor --fix");
  });

  it("findContainerfile：配置目录下的优先，其次项目的 .sandcastle/；都没有时 undefined", () => {
    const cwd = join(dir, "stale", "find");
    mkdirSync(join(cwd, ".sandcastle"), { recursive: true });
    expect(findContainerfile(cwd, join(cwd, ".sandcastle"))).toBeUndefined();
    writeFileSync(join(cwd, ".sandcastle/Containerfile"), "FROM node:22\n");
    expect(findContainerfile(cwd, join(cwd, ".sandcastle"))).toBe(join(cwd, ".sandcastle/Containerfile"));
    // 两个都有时配置目录（SANDCASTLE_PROJECT_DIR）里的赢
    const external = join(dir, "stale", "find-config");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "Containerfile"), "FROM node:22\n");
    expect(findContainerfile(cwd, external)).toBe(join(external, "Containerfile"));
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

describe("空转停止与进度（一直运行模式，#154）", () => {
  it("idleStop：有限上限到数就停，Infinity 永不停", () => {
    expect(idleStop(12, 12)).toBe(true);
    expect(idleStop(11, 12)).toBe(false);
    expect(idleStop(1000, Infinity)).toBe(false);
  });

  it("idleProgress：有限上限带分母，Infinity 只给次数", () => {
    expect(idleProgress(3, 12)).toBe("空转 3/12");
    expect(idleProgress(3, Infinity)).toBe("空转 3 次");
  });

  it("英文文案：finite keeps the denominator, Infinity only the count", () => {
    setTermLanguage("en", {});
    expect(idleProgress(3, 12)).toBe("idle 3/12");
    expect(idleProgress(3, Infinity)).toBe("idle 3");
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

  it("SIGTERM：走 Ctrl-C 同一路径打提示，退出码 143", () => {
    const r = runScript(
      "term.ts",
      `onInterrupt(() => ({ inProgress: ["47"], waitingChecks: [] }));\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.kill(process.pid, "SIGTERM"), 50);`,
    );
    expect(r.status).toBe(143);
    expect(r.stderr).toContain("Interrupted. in progress: #47");
    expect(r.stderr).toContain("no manual cleanup needed");
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
