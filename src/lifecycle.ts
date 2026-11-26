// 一次运行的生命周期：同一仓库只许一个 sandpipe 在跑（锁文件）、启动前查 podman、清理孤儿容器、中断时的提示、报错只取一行。
// 纯函数和带注入的函数放在这里，main.ts 加载时就跑主循环、不能直接测。
// Lifecycle of one run: only one sandpipe per repository (lock file), a podman check before starting, orphan container cleanup, the interrupt notice, one-line errors.
// Pure and injectable functions live here; main.ts runs the main loop on load and can't be tested directly.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { trySh, type TryResult } from "./shell.ts";
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

type Run = (cmd: string, args: string[], timeout?: number) => TryResult;

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
 * Ctrl-C 时打 interruptNotice、退出码 130。库在有沙箱时也装了 SIGINT 处理（跑完清理后 process.exit(1)），它装得比这里晚、排在后面；
 * 提示放在 exit 事件里用同步写，保证打在库的「Worktree preserved」之后、不被提前退出吞掉，退出码也在这里改回 130。没有沙箱时库不装处理，就由这里退出。
 * On Ctrl-C print interruptNotice and exit with 130. With sandboxes open the library installs its own SIGINT handler too (cleanup then process.exit(1)), registered later so it runs after this one;
 * the notice is written synchronously in the exit event so it lands after the library's "Worktree preserved" and isn't lost to the early exit, and the exit code is set back to 130 there. Without sandboxes the library installs nothing, so this exits.
 */
export function onInterrupt(state: () => { inProgress: string[]; waitingChecks: string[] }) {
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) return;
    interrupted = true;
    setImmediate(() => process.exit(130));
  });
  process.on("exit", () => {
    if (!interrupted) return;
    process.exitCode = 130;
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
