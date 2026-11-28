// 一次运行的生命周期：同一仓库只许一个 sandpipe 在跑（锁文件）、启动前查 podman、清理孤儿容器、中断时的提示、报错只取一行、临时错误等一会儿整步重跑。
// 纯函数和带注入的函数放在这里，main.ts 加载时就跑主循环、不能直接测。
// Lifecycle of one run: only one sandpipe per repository (lock file), a podman check before starting, orphan container cleanup, the interrupt notice, one-line errors, transient errors rerun after a wait.
// Pure and injectable functions live here; main.ts runs the main loop on load and can't be tested directly.

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { REMOTE_TRANSIENT, trySh, type TryResult } from "./shell.ts";
import { t } from "./term.ts";

// ---------------------------------------------------------------------------
// 运行锁 / Run lock
// ---------------------------------------------------------------------------

/** 锁文件，在 .sandcastle/logs/ 下（已被 .sandcastle/.gitignore 忽略）。 / The lock file, under .sandcastle/logs/ (ignored by .sandcastle/.gitignore). */
export const RUN_LOCK_FILE = ".sandcastle/logs/run.lock";

/** pid 对应的进程还活着没有：kill(pid, 0) 不发信号只做检查；EPERM 说明进程在、只是不归我们管。 / Whether the pid is alive: kill(pid, 0) only checks; EPERM means it exists but isn't ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type RunLock = { ok: true; release: () => void; stale?: number } | { ok: false; pid: number };

/**
 * 拿运行锁：锁文件不存在就建（O_EXCL，写入 pid）；存在时看里面的 pid，进程还活着就拿不到，已经死了（上次被 SIGKILL）就接管。
 * release 只删内容仍是自己 pid 的锁文件。
 * Take the run lock: create the file (O_EXCL, containing the pid) if missing; if it exists, check its pid: still alive means we can't take it, dead (last run was SIGKILLed) means we take over.
 * release only deletes the file while it still holds our pid.
 */
export function acquireRunLock(path: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): RunLock {
  mkdirSync(dirname(path), { recursive: true });
  let stale: number | undefined;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
        } catch {
          // 已经没了 / already gone
        }
      };
      return stale === undefined ? { ok: true, release } : { ok: true, release, stale };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(held) && held > 0 && held !== pid && alive(held)) return { ok: false, pid: held };
    stale = Number.isInteger(held) ? held : undefined;
    try {
      unlinkSync(path);
    } catch {
      // 别的进程刚删掉 / another process just deleted it
    }
  }
  // 两次都抢输了：当作有别的进程在跑。 / Lost the race twice: treat it as another process running.
  const held = existsSync(path) ? Number.parseInt(readFileSync(path, "utf8").trim(), 10) : 0;
  return { ok: false, pid: held };
}

// ---------------------------------------------------------------------------
// podman：可用性与孤儿容器 / podman: availability and orphan containers
// ---------------------------------------------------------------------------

/** 可注入的命令执行器（默认 trySh）。 / An injectable command runner (trySh by default). */
export type Run = (cmd: string, args: string[], timeout?: number) => TryResult;

/**
 * podman 能不能用（macOS 上 podman machine 没起时 `podman info` 失败）。能用返回 null，否则返回一行原因。
 * Whether podman is usable (`podman info` fails on macOS when the podman machine isn't running). Returns null when usable, otherwise a one-line reason.
 */
export function podmanProblem(run: Run = trySh): string | null {
  const r = run("podman", ["info", "--format", "{{.Host.Arch}}"], 60_000);
  if (r.ok) return null;
  const line = r.out.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.replace(/^Error:\s*/i, "").slice(0, 300);
}

/**
 * podman 自身连不上时的报错（在 exec 结果的 stderr 里；门槛命令的 `2>&1` 在容器内，管不到 podman 自己的错误）。
 * podman's own connection errors (in the exec result's stderr; the gate command's `2>&1` runs inside the container and doesn't catch podman's own errors).
 */
export const PODMAN_CONNECTION = /Cannot connect to Podman|ssh: handshake failed|connection reset by peer|podman rm failed/i;

/** 门槛基础设施故障的报错前缀（main.ts 的 TRANSIENT 认它）。 / Prefix of gate infrastructure errors (matched by TRANSIENT in main.ts). */
export const GATE_INFRA_PREFIX = "gate infra:";

/**
 * 门槛进程被基础设施杀掉（podman 断连等）：不是门槛失败，抛给 retryTransient 整步重跑。
 * The gate process was killed by infrastructure (podman disconnected, etc.): not a gate failure; thrown to retryTransient to rerun the whole step.
 */
export class GateInfraError extends Error {
  constructor(reason: string) {
    super(`${GATE_INFRA_PREFIX} ${reason}`);
    this.name = "GateInfraError";
  }
}

/** 门槛环境类错误的报错前缀（main.ts 的 TRANSIENT 认它）。 / Prefix of gate environment errors (matched by TRANSIENT in main.ts). */
export const GATE_ENV_PREFIX = "gate env:";

/**
 * 门槛依赖的服务连不上（数据库 ECONNREFUSED、DNS 失败、容器运行时断开）：不是代码的错，不进 fix 会话，抛给 retryTransient 定时重跑。
 * A service the gate depends on is unreachable (database ECONNREFUSED, DNS failure, container runtime down): not the code's fault; no fix session, thrown to retryTransient to rerun later.
 */
export class GateEnvError extends Error {
  constructor(line: string) {
    super(`${GATE_ENV_PREFIX} ${line}`);
    this.name = "GateEnvError";
  }
}

/** 默认的环境类错误规则。 / Default environment-error rule. */
const GATE_ENV_DEFAULT = /ECONNREFUSED|getaddrinfo (ENOTFOUND|EAI_AGAIN)|Cannot connect to the Docker daemon|Cannot connect to Podman/;

/**
 * 门槛输出里第一条环境类错误的那一行（截到 200 个字符），没有返回 null。extra 是项目配置的 gate.envErrorPattern，追加在默认规则之后。
 * 退出码 0 直接返回 null。测试本身断言 ECONNREFUSED 又真失败时会误判，靠重试用完后转 stuck 兜底。
 * The first environment-error line in the gate output (truncated to 200 characters), or null. extra is the project's gate.envErrorPattern, added on top of the default rule.
 * Exit code 0 returns null. A test that asserts on ECONNREFUSED and really fails is misjudged; falling back to stuck once retries run out covers that.
 */
export function gateEnvError(exitCode: number, output: string, extra?: RegExp): string | null {
  if (exitCode === 0) return null;
  // 去掉 g / y：带状态的正则逐行 test 会受 lastIndex 影响。 / Drop g / y: a stateful regex tested line by line is thrown off by lastIndex.
  const custom = extra && new RegExp(extra.source, extra.flags.replace(/[gy]/g, ""));
  const line = output.split("\n").map((l) => l.trim()).find((l) => GATE_ENV_DEFAULT.test(l) || custom?.test(l) === true);
  return line === undefined ? null : line.slice(0, 200);
}

/**
 * 报错是 GateEnvError 时取出匹配的那一行，否则 null。
 * The matched line when the error is a GateEnvError, otherwise null.
 */
export function gateEnvReason(e: unknown): string | null {
  const text = String((e as { message?: unknown } | undefined)?.message ?? e);
  const i = text.indexOf(GATE_ENV_PREFIX);
  return i === -1 ? null : text.slice(i + GATE_ENV_PREFIX.length).split("\n")[0].trim();
}

/** 会话中途认证失效的报错前缀（main.ts 的 TRANSIENT 不认它，#62 之三）。 / Prefix of mid-session authentication failures (not matched by TRANSIENT in main.ts, #62 part 3). */
export const AGENT_AUTH_PREFIX = "agent auth:";

/**
 * 会话中途认证失效（401、token 过期、要 /login）：凭据的问题，不是代码的错——不换档案、不记限额、不算票失败，抛给 untilAuthRecovered 等凭据更换后重跑。
 * A mid-session authentication failure (401, expired token, /login required): the credentials' problem, not the code's — no profile switch, no limit record, not a ticket failure; thrown to untilAuthRecovered to wait for new credentials and rerun.
 */
export class AgentAuthError extends Error {
  constructor(line: string) {
    super(`${AGENT_AUTH_PREFIX} ${line}`);
    this.name = "AgentAuthError";
  }
}

/**
 * 报错是 AgentAuthError 时取出匹配的那一行（截到 200 个字符），否则 null。
 * 照 gateEnvReason 用 indexOf、不靠 instanceof：错误可能被 Effect 包成 (FiberFailure)。
 * The matched line when the error is an AgentAuthError (truncated to 200 characters), otherwise null.
 * Like gateEnvReason it uses indexOf, not instanceof: the error may be wrapped by Effect as (FiberFailure).
 */
export function agentAuthReason(e: unknown): string | null {
  const text = String((e as { message?: unknown } | undefined)?.message ?? e);
  const i = text.indexOf(AGENT_AUTH_PREFIX);
  return i === -1 ? null : text.slice(i + AGENT_AUTH_PREFIX.length).split("\n")[0].trim().slice(0, 200);
}

/**
 * 认证失效算不算恢复了：凭据指纹变了（.sandcastle/.env 换过），或者等满 maxWaitMs（默认 30 分钟）兜底重跑。
 * Whether an auth failure has recovered: the credentials fingerprint changed (.sandcastle/.env was swapped), or maxWaitMs has elapsed (30 minutes by default) as a fallback rerun.
 */
export function authRecovered(down: { fingerprint: string; since: number }, fingerprint: string, now: number, maxWaitMs = 30 * 60_000): boolean {
  return fingerprint !== down.fingerprint || now - down.since >= maxWaitMs;
}

/** 凭据一直没换时，同一张票因认证失效最多撞几次（含第一次，#142 打回后定的）。 / How many auth-failure hits one ticket gets with the credentials never replaced (the first included; decided after #142's review). */
export const AUTH_MAX_HITS = 3;
/** 同一张票连续撞上认证失效的计数。 / Consecutive auth-failure hits for one ticket. */
export type AuthHits = { count: number; fingerprint: string };

/**
 * 又撞上一次认证失效后的计数：撞上时的凭据指纹和上一次相同就加 1，不同（凭据换过了）就从 1 重新数。build 的 untilAuthRecovered 和 prep 的 catch 共用。
 * The count after another auth-failure hit: add 1 when the credentials fingerprint at the hit matches the previous one, restart from 1 when it differs (the credentials were replaced). Shared by build's untilAuthRecovered and prep's catch.
 */
export function nextAuthHits(prev: AuthHits | undefined, fingerprint: string): AuthHits {
  return prev?.fingerprint === fingerprint ? { count: prev.count + 1, fingerprint } : { count: 1, fingerprint };
}

/** 计数到没到上限：到了就不再等，按普通失败处理。 / Whether the count reached the cap: if so, stop waiting and treat it as an ordinary failure. */
export function authHitCapped(hits: AuthHits, max = AUTH_MAX_HITS): boolean {
  return hits.count >= max;
}

/**
 * 跑 fn，撞上会话中途的认证失效就等到凭据换过（或满 30 分钟兜底）再重跑；其他错误照抛。
 * fn 要能从头重跑：build 重跑时在原分支上接着做。onDown 在等之前调用（打印原因、置主循环的暂停标志），fn 成功后调 onUp。
 * 凭据一直没换时最多撞 maxAuthHits 次（默认 3 次，含第一次，#142 打回后定的）：到上限不再等，调 onCap 后把错误抛出去，
 * 由调用方按普通失败处理（打 stuck）——不然误判的认证失效会让同一张票每 30 分钟无限重跑、整条运行卡死。凭据换过后计数重新数。
 * deps 给测试注入假的 fingerprint / sleep / now。
 * Run fn; on a mid-session auth failure wait until the credentials are replaced (or the 30-minute fallback) and rerun; other errors are rethrown.
 * fn must be rerunnable from the start: a rerun of build continues on the same branch. onDown is called before waiting (print the reason, set the main loop's pause flag); onUp after fn succeeds.
 * With the credentials never replaced, it hits at most maxAuthHits times (3 by default, the first included; decided after #142's review): at the cap it stops waiting,
 * calls onCap and rethrows the error for the caller to treat as an ordinary failure (marked stuck) — otherwise a misdetected auth failure would rerun the same
 * ticket every 30 minutes forever and hang the whole run. The count restarts whenever the credentials change.
 * deps lets tests inject a fake fingerprint / sleep / now.
 */
export async function untilAuthRecovered<T>(
  what: string,
  fn: () => Promise<T>,
  deps: {
    fingerprint: () => string;
    onDown: (reason: string) => void;
    onUp: () => void;
    onCap?: () => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    pollMs?: number;
    maxWaitMs?: number;
    maxAuthHits?: number;
  },
): Promise<T> {
  const { fingerprint, onDown, onUp, onCap, sleep: sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, pollMs = 60_000, maxWaitMs, maxAuthHits = AUTH_MAX_HITS } = deps;
  // 同一场失效的连续次数：撞上时的指纹和上一次不同（凭据换过了）就重新数。 / Consecutive hits of one outage: restart the count when the fingerprint at the hit differs from the previous one (the credentials changed).
  let hits: AuthHits | undefined;
  for (;;) {
    try {
      const out = await fn();
      onUp();
      return out;
    } catch (e) {
      const reason = agentAuthReason(e);
      if (reason === null) throw e;
      // down 记在 catch 里面：放外面 TS 对 fingerprint() 的收窄过不了。 / down is recorded inside the catch: outside it, TS can't narrow fingerprint() through.
      const fp = fingerprint();
      hits = nextAuthHits(hits, fp);
      if (authHitCapped(hits, maxAuthHits)) {
        onCap?.();
        throw e;
      }
      onDown(reason);
      const down = { fingerprint: fp, since: now() };
      while (!authRecovered(down, fingerprint(), now(), maxWaitMs)) await sleepFor(pollMs);
      const how = fingerprint() !== down.fingerprint
        ? t("凭据已换过", "the credentials were replaced")
        : t("等满 30 分钟", "the 30-minute fallback elapsed");
      console.log(t(`  ↻ ${what}：${how}，在原分支上重跑`, `  ↻ ${what}: ${how}; rerunning on the same branch`));
    }
  }
}

/**
 * 门槛结束后判断是不是基础设施故障，是就返回一行原因，否则 null。
 * 退出码 125 / 255（podman 自己出错）、stderr 命中连接类错误、或此刻 `podman info` 不通，都算；退出码 137 只有 podman 不通时才算（podman 正常时多半是 OOM，按门槛失败处理）。
 * 退出码 0 直接返回 null，不去查 podman（podmanProblem 是同步调用）。
 * After a gate ends, decide whether it was an infrastructure failure: a one-line reason if so, otherwise null.
 * Exit code 125 / 255 (podman's own errors), stderr matching a connection error, or `podman info` failing right now all count; 137 counts only when podman is unreachable (with podman fine it's most likely OOM, a real gate failure).
 * Exit code 0 returns null without probing podman (podmanProblem is synchronous).
 */
export function isGateInfraFailure(exitCode: number, stderr: string, run: Run = trySh): string | null {
  if (exitCode === 0) return null;
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => PODMAN_CONNECTION.test(l));
  if (line) return line.replace(/^Error:\s*/i, "").slice(0, 300);
  const problem = podmanProblem(run);
  if (problem !== null) return problem || t("podman 连不上", "podman unreachable");
  if (exitCode === 125 || exitCode === 255) return t(`podman 退出码 ${exitCode}`, `podman exit code ${exitCode}`);
  return null;
}

/**
 * 等 podman 连上：每次探测之间异步 sleep（podmanProblem 是同步调用，连续探测会卡住事件循环、停掉别的票心跳）。
 * 连上返回 true；等满 budgetMs 还连不上返回 false。
 * Wait for podman to come back: an async sleep between probes (podmanProblem is synchronous; probing back to back would block the event loop and stall other tickets' heartbeats).
 * Returns true once connected; false if still unreachable after budgetMs.
 */
export async function waitForPodman(
  run: Run = trySh,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  budgetMs = 60_000,
  intervalMs = 15_000,
): Promise<boolean> {
  for (let waited = 0; ; waited += intervalMs) {
    if (podmanProblem(run) === null) return true;
    if (waited >= budgetMs) return false;
    await sleep(intervalMs);
  }
}

/** 库的「镜像不在本地」报错里的镜像名；不是这个报错返回 null。 / The image name in the library's "image not found locally" error; null for other errors. */
export function missingImage(message: string): string | null {
  return /Image '([^']+)' not found locally/.exec(message)?.[1] ?? null;
}

/** 镜像在不在本地（`podman image exists`）。 / Whether the image exists locally (`podman image exists`). */
export function imageExists(tag: string, run: Run = trySh): boolean {
  return run("podman", ["image", "exists", tag], 60_000).ok;
}

// ---------------------------------------------------------------------------
// 临时错误重跑 / Transient-error rerun
// ---------------------------------------------------------------------------

// 沙箱和落地里的临时错误（2026-11-07 机器睡眠醒来后：复制 node_modules 到工作区超过 60 秒、
// GitHub API 读超时）不直接打 stuck：等一会儿整步重跑。build 在原分支上重跑，implementer 会接着已有提交做；
// land 开头会查 issue 是否已关、PR 是否已开，重跑最多多出一条评论。
// Transient errors in sandboxes and landing (on 2026-11-07, after the machine woke from sleep: copying node_modules into the worktree took over 60 seconds,
// GitHub API read timeouts) don't mark the ticket stuck right away: wait, then rerun the whole step. build reruns on the same branch, and the implementer continues from existing commits;
// land first checks whether the issue is closed or a PR already exists, so a rerun adds at most one extra comment.
// podman 连接短暂断开（2026-11-26：ssh: handshake failed … connection reset by peer）也算：门槛没跑成、podman create 报镜像不在（其实只是连不上）、podman rm 失败。
// A brief podman disconnect counts too (2026-11-26: ssh: handshake failed … connection reset by peer): the gate didn't run, podman create reporting a missing image (really just unreachable), podman rm failing.
export const PODMAN_TRANSIENT = new RegExp(
  [GATE_INFRA_PREFIX, "Cannot connect to Podman", "ssh: handshake failed", "Image '.*' not found locally", "podman rm failed"].join("|"),
  "i",
);
// 门槛依赖的服务连不上（GATE_ENV_PREFIX，#54）也定时重跑，但不进 PODMAN_TRANSIENT（不用等 podman）。
// A service the gate depends on being unreachable (GATE_ENV_PREFIX, #54) is rerun later too, but isn't in PODMAN_TRANSIENT (no waiting for podman).
// 沙箱初始化时 git 读配置也偶发失败（2026-11-28，maxParallel: 2 下两次，#117 / #171）：宿主机写 .git/config（锁文件、改名）时
// 容器通过挂载读到中间状态，报 fatal: unknown error occurred while reading the configuration files（退出码 128）。也是临时错误，只进 TRANSIENT：
// 进 PODMAN_TRANSIENT 会走「等 podman 连上」那条分支，把 stuck 文案也误写成 podman 断连。
// git reading its config during sandbox setup also fails occasionally (2026-11-28, twice under maxParallel: 2, #117 / #171): the container reads
// .git/config mid-write by the host (lock file, rename) through the mount, reporting "fatal: unknown error occurred while reading the configuration files" (exit 128).
// Also transient, and only in TRANSIENT: putting it in PODMAN_TRANSIENT would take the "wait for podman" branch and mislabel the stuck message as a podman disconnect.
export const TRANSIENT = new RegExp(`${REMOTE_TRANSIENT.source}|CopyToWorktreeTimeoutError|timed out|${PODMAN_TRANSIENT.source}|${GATE_ENV_PREFIX}|unknown error occurred while reading the configuration files`, "i");
export const TRANSIENT_RETRY_WAITS_MS = [60_000, 300_000, 900_000];

/**
 * 跑 fn，撞上 TRANSIENT 认得的临时错误就按 TRANSIENT_RETRY_WAITS_MS 等一会儿整步重跑，用完重试次数把错误抛出去；
 * podman 类错误（PODMAN_TRANSIENT）改成等 podman 连上再重跑。认证失效不重试（agentAuthReason）。
 * deps 给测试注入假的 sleep。
 * Run fn; on a transient error TRANSIENT recognises, wait per TRANSIENT_RETRY_WAITS_MS and rerun the whole step, rethrowing once the attempts run out;
 * podman errors (PODMAN_TRANSIENT) instead wait for podman to come back before rerunning. Auth failures aren't retried (agentAuthReason).
 * deps lets tests inject a fake sleep.
 */
export async function retryTransient<T>(what: string, fn: () => Promise<T>, deps: { sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = String((e as { stderr?: unknown }).stderr || e);
      // 认证失效不按临时错误重跑（重试也是同样的 401，白等约 21 分钟）：直接抛给 untilAuthRecovered 等凭据更换（#62 之三）。
      // An auth failure isn't retried as transient (each retry would just 401 again, wasting ~21 minutes): thrown straight out to untilAuthRecovered to wait for new credentials (#62 part 3).
      if (agentAuthReason(e) !== null) throw e;
      const wait = TRANSIENT_RETRY_WAITS_MS[attempt];
      if (wait === undefined || !TRANSIENT.test(message)) throw e;
      const first = message.split("\n")[0].slice(0, 160);
      const n = `${attempt + 1}/${TRANSIENT_RETRY_WAITS_MS.length}`;
      if (!PODMAN_TRANSIENT.test(message)) {
        console.warn(t(`  ⚠ ${what} 撞上临时错误（${first}），${wait / 1000} 秒后重跑（第 ${n} 次）`, `  ⚠ ${what} hit a transient error (${first}); rerunning in ${wait / 1000}s (attempt ${n})`));
        await sleep(wait);
        continue;
      }
      // podman 类错误：等 podman 连上（最多等这次的间隔）再重跑；「镜像不在本地」在连上后复查，真缺镜像就按原路径报错。
      // podman errors: wait until podman is reachable (at most this attempt's interval), then rerun; "image not found locally" is rechecked once connected, and a truly missing image fails as before.
      console.warn(t(`  ⚠ ${what} 撞上 podman 连接问题（${first}），等 podman 连上（最多 ${wait / 1000} 秒）后重跑（第 ${n} 次）`, `  ⚠ ${what} hit a podman connection problem (${first}); rerunning once podman is reachable (up to ${wait / 1000}s, attempt ${n})`));
      const up = await waitForPodman(trySh, undefined, wait);
      const image = missingImage(message);
      if (up && image !== null && !imageExists(image)) throw e;
    }
  }
}

/**
 * 镜像上记录 Containerfile 内容哈希的 label（doctor --fix 建镜像时打上，供后续票判断镜像是否过期，见 #89）。
 * The label on the image recording the Containerfile's content hash (set when doctor --fix builds it, so later tickets can tell whether the image is stale, see #89).
 */
export const IMAGE_LABEL = "sandpipe.containerfile";

/** Containerfile 文件字节的 sha256（十六进制）。 / The sha256 (hex) of the Containerfile's bytes. */
export function containerfileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 按镜像名和 Containerfile 组出 podman build 的参数（打上内容哈希 label）。 / podman build args for the image and Containerfile (labelled with the content hash). */
export function buildImageArgs(image: string, containerfile: string): string[] {
  return ["build", "-t", image, "--label", `${IMAGE_LABEL}=${containerfileHash(containerfile)}`, "-f", containerfile, dirname(containerfile)];
}

/**
 * 找项目的 Containerfile：配置目录（SANDCASTLE_PROJECT_DIR）里的优先，其次目标项目 `.sandcastle/` 里 onboard 装的那份；都没有返回 undefined。
 * Find the project's Containerfile: the config directory's (SANDCASTLE_PROJECT_DIR) first, then the one onboard installed under the target project's `.sandcastle/`; undefined when neither exists.
 */
export function findContainerfile(cwd: string, dir: string): string | undefined {
  return [join(dir, "Containerfile"), join(cwd, ".sandcastle/Containerfile")].find(existsSync);
}

/**
 * 镜像上记录的 Containerfile 哈希 label（`podman image inspect` 读 `IMAGE_LABEL`）：命令失败、trim 后为空或是 `<no value>`（label 没打上时 Go 模板对缺 key 的 index 输出这个）返回 undefined。
 * 老镜像没打过 label，也返回 undefined，调用方按过期处理。
 * The Containerfile hash label recorded on the image (`podman image inspect` for `IMAGE_LABEL`): undefined when the command fails, trims to empty, or is `<no value>` (what Go's template prints for index on a missing key).
 * Images built before the label existed also return undefined; callers treat them as stale.
 */
export function imageLabel(tag: string, run: Run = trySh): string | undefined {
  const r = run("podman", ["image", "inspect", "--format", `{{index .Labels "${IMAGE_LABEL}"}}`, tag], 60_000);
  if (!r.ok) return undefined;
  const label = r.out.trim();
  return label === "" || label === "<no value>" ? undefined : label;
}

/**
 * 镜像不是按当前 Containerfile 建的（label 记的哈希对不上，含没 label）时返回一行警告文案，是的话返回 null。
 * 没有 Containerfile 或镜像不在本地时也返回 null——缺失有别的报法（doctor 的「没有镜像」），这里只在能判断过期时报。
 * A one-line warning when the image wasn't built from the current Containerfile (the label's hash doesn't match, including no label at all), null when it was.
 * No Containerfile or no local image also returns null—an absent image is reported elsewhere (doctor's "No image"); this only reports staleness it can establish.
 */
export function imageStaleWarning(image: string, containerfile: string | undefined, run: Run = trySh): string | null {
  if (containerfile === undefined || !imageExists(image, run)) return null;
  if (imageLabel(image, run) === containerfileHash(containerfile)) return null;
  return t(
    `Containerfile 改过，镜像 ${image} 过期，运行 sandpipe doctor --fix 重建`,
    `The Containerfile changed; the image ${image} is stale. Run sandpipe doctor --fix to rebuild it`,
  );
}

/**
 * 这个仓库的路径前缀：仓库根（prep 挂的是工作区本身）和它下面的一切（`.git`、`.sandcastle/worktrees/…`）。
 * 同时认原路径和 realpath（macOS 上 /tmp → /private/tmp 之类）。
 * Path prefixes of this repository: the repo root (prep mounts the workspace itself) and everything under it (`.git`, `.sandcastle/worktrees/…`).
 * Both the given path and its realpath count (e.g. /tmp → /private/tmp on macOS).
 */
export function repoRoots(root: string): string[] {
  const roots = new Set([root.replace(/\/+$/, "")]);
  try {
    roots.add(realpathSync(root).replace(/\/+$/, ""));
  } catch {
    // 读不到就只用原路径 / unreadable: keep the given path only
  }
  return [...roots];
}

/** 挂载来源是不是这个仓库（仓库根本身或它下面的路径；`/a/b` 不算 `/a/b-other` 的）。 / Whether a mount source belongs to this repo (the root itself or a path under it; `/a/b-other` isn't under `/a/b`). */
export const mountInRepo = (source: string, roots: string[]) => roots.some((r) => source === r || source.startsWith(`${r}/`));

export type ContainerInfo = { name: string; status: string; sources: string[] };

/**
 * 解析 `podman inspect --format '{{.Name}}|{{.State.Status}}|{{range .Mounts}}{{.Source}},{{end}}'` 的输出，每个容器一行。
 * Parse the output of `podman inspect --format '{{.Name}}|{{.State.Status}}|{{range .Mounts}}{{.Source}},{{end}}'`, one container per line.
 */
export function parseContainers(out: string): ContainerInfo[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = "", status = "", mounts = ""] = l.split("|");
      return { name: name.replace(/^\//, ""), status: status.toLowerCase(), sources: mounts.split(",").filter(Boolean) };
    });
}

/**
 * 属于这个仓库的 sandcastle 容器里该删的：`stoppedOnly` 时只要已退出的（exited / dead，运行中途 podman 挂掉留下的；刚建、还没跑起来的 created 不算），否则全部。
 * 别的仓库的容器（挂载来源不在本仓库下）一个都不碰。
 * Which of this repository's sandcastle containers to remove: with `stoppedOnly`, only exited / dead ones (left when podman died mid-run; just-created ones not yet started don't count); otherwise all of them.
 * Containers of other repositories (mount sources outside this repo) are never touched.
 */
export function orphanContainers(containers: ContainerInfo[], roots: string[], stoppedOnly: boolean): string[] {
  return containers
    .filter((c) => c.name.startsWith("sandcastle-") && c.sources.some((s) => mountInRepo(s, roots)))
    .filter((c) => !stoppedOnly || c.status === "exited" || c.status === "dead")
    .map((c) => c.name);
}

/**
 * 删掉本仓库的孤儿 sandcastle 容器，返回删掉的名字；查不到（podman 不可用等）时返回空数组，不报错。
 * 库没给容器打 label，只能按名字前缀 `sandcastle-` 和挂载来源认。调用方要持有运行锁：锁保证本仓库没有别的 sandpipe 在跑，
 * 启动时（这个进程还没建沙箱）本仓库的容器就全是孤儿；运行中只删没在跑的，在跑的可能是这个进程正在用的沙箱。
 * Remove this repository's orphan sandcastle containers and return their names; returns [] when they can't be listed (podman unavailable, etc.).
 * The library doesn't label its containers, so they're identified by the `sandcastle-` name prefix and their mount sources. The caller must hold the run lock: it guarantees no other
 * sandpipe runs in this repo, so at startup (before this process has created any sandbox) all of this repo's containers are orphans; mid-run only stopped ones are removed, since running ones may be this process's live sandboxes.
 */
export function removeOrphanContainers(root: string, stoppedOnly: boolean, run: Run = trySh): string[] {
  const ids = run("podman", ["ps", "-aq", "--filter", "name=^sandcastle-"], 60_000);
  if (!ids.ok || !ids.out.trim()) return [];
  const inspected = run(
    "podman",
    ["inspect", "--format", "{{.Name}}|{{.State.Status}}|{{range .Mounts}}{{.Source}},{{end}}", ...ids.out.split(/\s+/).filter(Boolean)],
    60_000,
  );
  if (!inspected.ok) return [];
  const names = orphanContainers(parseContainers(inspected.out), repoRoots(root), stoppedOnly);
  return names.filter((name) => run("podman", ["rm", "-f", name], 60_000).ok);
}

// ---------------------------------------------------------------------------
// 报错与中断提示 / Errors and the interrupt notice
// ---------------------------------------------------------------------------

/**
 * 报错只取第一行（去掉 Effect 的 `(FiberFailure) ` 前缀）：写进 issue 评论和终端，堆栈另写本地日志。
 * Only the first line of an error (dropping Effect's `(FiberFailure) ` prefix): for issue comments and the terminal; the stack goes to a local log.
 */
export function errorLine(e: unknown): string {
  const text = String((e as { stderr?: unknown } | undefined)?.stderr || e);
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.replace(/^\(FiberFailure\)\s*/, "").slice(0, 500);
}

/** 是不是 agent 空闲超时（库的 AgentIdleTimeoutError）。 / Whether this is the agent idle timeout (the library's AgentIdleTimeoutError). */
export const isAgentIdleTimeout = (e: unknown) => /AgentIdleTimeoutError/.test(String(e)) || (e as { _tag?: unknown })?._tag === "AgentIdleTimeoutError";

/** 完整报错（含堆栈）追加到本地日志；写不进时忽略。 / Append the full error (with stack) to a local log; ignore failures to write. */
export function logErrorDetail(file: string, what: string, e: unknown, appendFile: (path: string, text: string) => void) {
  const detail = e instanceof Error && e.stack ? `${String(e)}\n${e.stack}` : String(e);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFile(file, `\n--- ${new Date().toISOString()} ${what} ---\n${detail}\n`);
  } catch {
    // 日志写不进不影响运行 / a failed log write doesn't affect the run
  }
}

/**
 * Ctrl-C 退出时的一行提示：哪些票做到一半、worktree 和分支保留、重启会接着做；库打印的「To clean up: git worktree remove」不用照做。
 * The notice printed on Ctrl-C: which tickets were in progress, that worktrees and branches are kept and a restart continues them; the library's "To clean up: git worktree remove" needn't be followed.
 */
export function interruptNotice(inProgress: string[], waitingChecks: string[]): string {
  if (inProgress.length === 0 && waitingChecks.length === 0)
    return t("\n⏹ 已中断，没有做到一半的票。", "\n⏹ Interrupted; no ticket was in progress.");
  const refs = (ids: string[]) => ids.map((id) => `#${id}`).join(t("、", ", "));
  const parts: string[] = [];
  if (inProgress.length) parts.push(t(`做到一半的票：${refs(inProgress)}`, `in progress: ${refs(inProgress)}`));
  if (waitingChecks.length) parts.push(t(`在等 PR 检查的票：${refs(waitingChecks)}`, `waiting for PR checks: ${refs(waitingChecks)}`));
  return t(
    `\n⏹ 已中断。${parts.join("；")}。worktree 和分支都保留，重新运行 sandpipe 会接着做，不用手动清理（上面库打印的「To clean up: git worktree remove …」不用照做）。`,
    `\n⏹ Interrupted. ${parts.join("; ")}. Worktrees and branches are kept and rerunning sandpipe continues them; no manual cleanup needed (ignore the library's "To clean up: git worktree remove …" above).`,
  );
}

/** 本仓库运行锁的绝对路径。 / Absolute path of this repository's run lock. */
export const runLockPath = (root: string) => join(root, RUN_LOCK_FILE);

/**
 * 连续空转多少次后结束运行：`maxIdlePolls` 配 `Infinity`（一直运行模式，守护进程下用）时永不结束，其余（含默认 12）到数就停。
 * After how many idle polls in a row the run ends: with `maxIdlePolls: Infinity` (run-forever mode, for daemons) it never ends; otherwise (default 12 included) it stops at the cap.
 */
export function idleStop(idlePolls: number, max: number): boolean {
  return Number.isFinite(max) && idlePolls >= max;
}

/**
 * 空转进度的括号文案：有限上限带分母（「空转 3/12」）；一直运行模式没有分母，只给次数（「空转 3 次」），不打「/Infinity」。
 * The idle-progress parenthesis: a finite cap keeps the denominator ("idle 3/12"); run-forever mode has none and gives just the count ("idle 3"), never printing "/Infinity".
 */
export function idleProgress(idlePolls: number, max: number): string {
  return Number.isFinite(max)
    ? t(`空转 ${idlePolls}/${max}`, `idle ${idlePolls}/${max}`)
    : t(`空转 ${idlePolls} 次`, `idle ${idlePolls}`);
}

/**
 * Ctrl-C（退出码 130）或 SIGTERM（143，systemd / launchd 停服务时发）时打 interruptNotice，两个信号走同一路径。
 * 库在有沙箱时也装了 SIGINT 处理（跑完清理后 process.exit(1)），它装得比这里晚、排在后面；
 * 提示放在 exit 事件里用同步写，保证打在库的「Worktree preserved」之后、不被提前退出吞掉，退出码也在这里改回 130 / 143。没有沙箱时库不装处理，就由这里退出。
 * On Ctrl-C (exit code 130) or SIGTERM (143, sent when systemd / launchd stops the service) print interruptNotice; both signals take the same path.
 * With sandboxes open the library installs its own SIGINT handler too (cleanup then process.exit(1)), registered later so it runs after this one;
 * the notice is written synchronously in the exit event so it lands after the library's "Worktree preserved" and isn't lost to the early exit, and the exit code is set back to 130 / 143 there. Without sandboxes the library installs nothing, so this exits.
 */
export function onInterrupt(state: () => { inProgress: string[]; waitingChecks: string[] }) {
  let exitCode: number | undefined;
  const onSignal = (code: number) => () => {
    if (exitCode !== undefined) return;
    exitCode = code;
    setImmediate(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  process.on("exit", () => {
    if (exitCode === undefined) return;
    process.exitCode = exitCode;
    const s = state();
    try {
      writeSync(2, `${interruptNotice(s.inProgress, s.waitingChecks)}\n`);
    } catch {
      // stderr 关了 / stderr is closed
    }
  });
}

/**
 * 运行结束后兜底退出：事件循环里没有别的东西时进程照常自己退出（定时器 unref 了，不拖着进程）；还有东西挂着时 graceMs 后按 process.exitCode 退出。
 * 原因是 @ai-hero/sandcastle 0.12 的 invokeAgent：agent 空闲超时（AgentIdleTimeoutError）后，被放弃的 `podman exec` 还会送来输出行，
 * onLine 里的 resetTimer 又起一个没人中断的「Agent idle for N minutes」提醒 fiber（while(true) 每分钟 sleep 一次），事件循环永远不空，
 * 进程打完「全部完成」后一直挂着（e2e L6）。问题在依赖里，这边改不了，只能在收尾时显式退出。
 * Exit fallback after the run: when nothing else is in the event loop the process exits on its own as usual (the timer is unref'd and doesn't hold it); if something is still pending, exit with process.exitCode after graceMs.
 * The cause is invokeAgent in @ai-hero/sandcastle 0.12: after an agent idle timeout (AgentIdleTimeoutError) the abandoned `podman exec` still delivers lines,
 * and resetTimer in onLine starts another "Agent idle for N minutes" warning fiber nobody interrupts (while(true), sleeping a minute each round), so the event loop never empties
 * and the process hangs after printing "All done" (e2e L6). The bug is in the dependency and can't be fixed here, so exit explicitly at the end.
 */
export function exitWhenDone(graceMs = 2000) {
  setTimeout(() => process.exit(), graceMs).unref();
}
