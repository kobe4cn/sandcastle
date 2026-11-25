// 宿主机命令：一律带超时，连远端的 git 遇到临时错误时等一会儿重试。main.ts 与各 Forge 共用。

import { execFileSync } from "node:child_process";

// 宿主机命令一律带超时：2026-11-07 机器睡眠醒来后一个 git fetch 挂了一个多小时不返回，整个运行停在那里。
// 超时抛的错带 TIMEOUT_TEXT，被 TRANSIENT 认作临时错误。
export const SH_TIMEOUT_MS = 10 * 60_000;
export const GIT_REMOTE_TIMEOUT_MS = 5 * 60_000;
export const TIMEOUT_TEXT = "命令超时";

export const sh = (cmd: string, args: string[], timeout = SH_TIMEOUT_MS, env?: NodeJS.ProcessEnv) => {
  try {
    // stderr 不透传到终端：trySh 探测时的预期失败（如 `gh pr view` 的 no pull requests found）每轮会刷屏；
    // 失败时 stderr 仍在抛出的错误里（e.stderr / message），调用方照常拿得到。
    return execFileSync(cmd, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], env }).trim();
  } catch (e) {
    if ((e as { code?: unknown }).code === "ETIMEDOUT") throw new Error(`${TIMEOUT_TEXT}（${timeout / 1000} 秒）：${cmd} ${args.join(" ").slice(0, 200)}`);
    throw e;
  }
};

export type TryResult = { ok: true; out: string } | { ok: false; out: string };

const errorText = (e: unknown) => String((e as { stderr?: unknown }).stderr || e);

export const trySh = (cmd: string, args: string[], timeout?: number): TryResult => {
  try {
    return { ok: true as const, out: sh(cmd, args, timeout) };
  } catch (e) {
    return { ok: false as const, out: errorText(e) };
  }
};

/** 把会抛错的调用（比如 Forge 的方法）包成 trySh 那样的结果：成功带返回值，失败时 out 是错误文本。 */
export const attempt = <T>(fn: () => T): { ok: true; value: T } | { ok: false; out: string } => {
  try {
    return { ok: true as const, value: fn() };
  } catch (e) {
    return { ok: false as const, out: errorText(e) };
  }
};

// 连远端的 git（fetch / push）偶尔撞上 SSH、DNS、网络抖动（2026-11-04 一次
// `Permission denied (publickey)` 让 #390 落地失败、下次开头的 fetch 直接让进程崩了）。
// 这类错误等一会儿重试，最多等约半小时；被拒（non-fast-forward、lease 过期）之类的照常立即失败。
export const REMOTE_TRANSIENT = new RegExp(
  [
    "Permission denied \\(publickey\\)", "Could not read from remote repository", "Could not resolve host",
    "Connection (timed out|reset|refused|closed)", "Operation timed out", "Network is unreachable", "early EOF",
    "unexpected disconnect", "kex_exchange_identification", "ssh_exchange_identification", "unable to access",
    "RPC failed", "HTTP 5\\d\\d", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "TLS handshake timeout", TIMEOUT_TEXT,
  ].join("|"),
  "i",
);
const REMOTE_RETRY_WAITS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];

export async function gitRemote(args: string[]) {
  for (let attempt = 0; ; attempt++) {
    const result = trySh("git", args, GIT_REMOTE_TIMEOUT_MS);
    const wait = REMOTE_RETRY_WAITS_MS[attempt];
    if (result.ok || wait === undefined || !REMOTE_TRANSIENT.test(result.out)) return result;
    console.warn(`  ⚠ git ${args.join(" ")} 连不上远端（${result.out.split("\n")[0].slice(0, 160)}），${wait / 1000} 秒后重试（第 ${attempt + 1}/${REMOTE_RETRY_WAITS_MS.length} 次）`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 同 gitRemote，重试用完仍失败就抛错（原来直接用 sh 的地方）。 */
export async function gitRemoteOrThrow(args: string[]) {
  const result = await gitRemote(args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} 失败：${result.out.slice(0, 500)}`);
  return result.out;
}

export const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
export const envPrefix = (env: Record<string, string>) =>
  `env ${Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`;
