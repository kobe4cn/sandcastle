// 启动预检：门槛依赖的服务（gate.services）在宿主机上能不能连上、磁盘剩余空间够不够。sandpipe run 启动时和 doctor 都用。
// Startup preflight: whether the services the gate depends on (gate.services) are reachable from the host, and whether there's enough free disk space. Used at sandpipe run startup and by doctor.
// run 每轮调度前的预检也在这里（preflightProblems）：平台登录、Claude 凭据、磁盘。
// The per-pass preflight of run (preflightProblems) lives here too: forge login, Claude credentials, disk.

import { statfsSync } from "node:fs";
import { connect } from "node:net";
import type { GateService } from "./profile.ts";
import type { Run } from "./lifecycle.ts";
import { trySh } from "./shell.ts";
import { t } from "./term.ts";

/** 探测一个地址：连得上返回 null，连不上返回错误文本。 / Probe one address: null when reachable, the error text otherwise. */
export type Probe = (host: string, port: number) => Promise<string | null>;

/**
 * 连一次 host:port（timeoutMs 内），连上就断开、返回 null；连不上返回错误文本（超时写明毫秒数）。
 * localhost 会同时试 ::1 和 127.0.0.1，都失败时 Node 抛 message 为空的 AggregateError，这时用错误码（比如 ECONNREFUSED）。
 * Connect to host:port once (within timeoutMs): on success disconnect and return null; otherwise return the error text (a timeout names the milliseconds).
 * localhost tries both ::1 and 127.0.0.1; when both fail Node throws an AggregateError with an empty message, so the error code (e.g. ECONNREFUSED) is used instead.
 */
export function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<string | null> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (result: string | null) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(timeoutMs, () => finish(`timed out after ${timeoutMs}ms`));
    socket.once("connect", () => finish(null));
    socket.once("error", (e: NodeJS.ErrnoException) => finish(e.message || e.code || String(e)));
  });
}

export type ServiceFailure = { name: string; addr: string; error: string };

/**
 * 逐个探测，返回连不上的服务（按声明顺序）。
 * Probe each in turn and return the unreachable ones (in declaration order).
 */
export async function checkServices(list: readonly GateService[], probe: Probe): Promise<ServiceFailure[]> {
  const failed: ServiceFailure[] = [];
  for (const s of list) {
    const error = await probe(s.host, s.port);
    if (error !== null) failed.push({ name: s.name, addr: `${s.host}:${s.port}`, error });
  }
  return failed;
}

/**
 * sandpipe run 启动时的检查：有连不上的服务就返回报错文字（列出每一个的名字、host:port 和错误，提示先起服务），都连上或没声明返回 null。
 * The check at sandpipe run startup: when any service is unreachable, return the error text (each one's name, host:port and error, plus a hint to start them); null when all connect or none are declared.
 */
export async function servicesProblem(list: readonly GateService[], probe: Probe): Promise<string | null> {
  const down = await checkServices(list, probe);
  if (down.length === 0) return null;
  return t(
    `门槛依赖的服务连不上：${down.map((s) => `${s.name}（${s.addr}）：${s.error}`).join("；")}。先把服务起来，然后重试（sandpipe doctor 可以检查）`,
    `Services the gate depends on are unreachable: ${down.map((s) => `${s.name} (${s.addr}): ${s.error}`).join("; ")}. Start them first, then retry (sandpipe doctor can check)`,
  );
}

/** 剩余空间的最低值（GB），配置项 preflight.minFreeGb 的默认。 / Minimum free space (GB); the default of the preflight.minFreeGb config. */
export const DEFAULT_MIN_FREE_GB = 5;

/** fs.statfsSync 的可注入子集：测试里换成假实现，不碰真实磁盘。 / The injectable subset of fs.statfsSync: a fake in tests, so no real disk is touched. */
export type Statfs = (path: string) => { bavail: number | bigint; bsize: number | bigint };

/** 一个路径的量测结果：够 / 不够 / 量不到（freeBytes 是剩余字节数，error 是 statfs 的报错）。 / One path's outcome: enough / low / unknown (freeBytes is the free space in bytes, error the statfs failure). */
export type DiskResult =
  | { path: string; status: "enough"; freeBytes: number }
  | { path: string; status: "low"; freeBytes: number }
  | { path: string; status: "unknown"; error: string };

/**
 * 逐个量路径的剩余空间（bavail * bsize），和阈值比出够 / 不够；statfs 抛错就算「量不到」，带上错误那一句。
 * Measure each path's free space (bavail * bsize) against the threshold; a throwing statfs counts as "unknown", carrying the error's message.
 */
export function diskProblems(paths: readonly string[], thresholdBytes: number, statfs: Statfs = statfsSync): DiskResult[] {
  return paths.map((path) => {
    let freeBytes: number;
    try {
      const s = statfs(path);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      return { path, status: "unknown", error: e instanceof Error ? e.message : String(e) };
    }
    return { path, status: freeBytes >= thresholdBytes ? "enough" : "low", freeBytes };
  });
}

/**
 * podman 的容器存储路径（GraphRoot）；podman 用不了（没装、podman machine 没起）或输出为空时返回 null。
 * podman's container storage path (GraphRoot); null when podman is unusable (not installed, machine not started) or the output is empty.
 */
export function containerStorePath(run: Run = trySh): string | null {
  const r = run("podman", ["info", "--format", "{{.Store.GraphRoot}}"], 60_000);
  const path = r.ok ? r.out.trim() : "";
  return path === "" ? null : path;
}

/** 报错的文字：Error 只取 message，不带「Error: 」前缀。 / An error's text: just the message for an Error, without the "Error: " prefix. */
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 预检发现的一个问题：原因（写明是哪一项、差多少）和处理方法（写具体命令）。 / One preflight problem: its reason (which item, by how much) and its fix (concrete commands). */
export type PreflightProblem = { reason: string; fix: string };

/**
 * run 每轮调度前的预检（#62 之二）：平台登录（checkAccess 抛错算一条，错误文本自带说明）、Claude 凭据（missingCredentials 非空算一条）、
 * 磁盘剩余空间（disk() 里只有 status: "low" 的算问题）。依赖全部可注入，空数组 = 全部通过。
 * 量不到的磁盘不算失败（只在启动时警告一次）；别家档案缺 ${VAR} 的警告 reloadModels 已经在打，这里不管。
 * The preflight before each scheduling pass of run (#62 part 2): the forge login (a throwing checkAccess counts, its error text explains itself), the Claude credentials
 * (a non-empty missingCredentials counts) and free disk space (only a status of "low" from disk() is a problem). All deps are injectable; an empty array means all clear.
 * An unmeasurable disk isn't a failure (warned once at startup); warnings about another vendor's missing ${VAR} are already printed by reloadModels, so they're not here.
 */
export function preflightProblems(deps: { checkAccess: () => string; missingCredentials: () => string[]; disk: () => DiskResult[] }): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  try {
    deps.checkAccess();
  } catch (e) {
    problems.push({
      reason: t(`平台访问检查没过：${errText(e)}`, `Forge access check failed: ${errText(e)}`),
      fix: t("重新 gh auth login，登录过期用 gh auth refresh（sandpipe doctor 可以检查）", "Run gh auth login again, or gh auth refresh to renew an expired login (sandpipe doctor can check)"),
    });
  }
  const missing = deps.missingCredentials();
  if (missing.length > 0)
    problems.push({
      reason: t(`Claude 档案的凭据缺失：${missing.join("；")} 都没有值`, `Claude profiles' credentials are missing: none of ${missing.join("; ")} has a value`),
      fix: t("claude setup-token 生成 token，填进 .sandcastle/.env（sandpipe doctor 可以检查）", "Generate a token with claude setup-token and put it into .sandcastle/.env (sandpipe doctor can check)"),
    });
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  for (const d of deps.disk()) {
    if (d.status !== "low") continue;
    problems.push({
      reason: t(`${d.path} 剩余 ${gb(d.freeBytes)} GB，少于 preflight.minFreeGb 的阈值`, `${d.path}: ${gb(d.freeBytes)} GB free, below the preflight.minFreeGb threshold`),
      fix: t("腾出空间：podman image prune、podman system prune、git worktree prune", "Free up space: podman image prune, podman system prune, git worktree prune"),
    });
  }
  return problems;
}
