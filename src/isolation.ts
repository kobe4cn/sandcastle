// isolation 辅助函数：给 sandcastle.config.ts 的 isolation.env / cleanup 用，省掉读 .env、换宿主机地址、加库名后缀、跑回收脚本的样板。
// config 在宿主机上被 import，这些函数都跑在宿主机，相对路径按项目根（当前目录）算。
//
// Isolation helpers for isolation.env / cleanup in sandcastle.config.ts, replacing the boilerplate of reading .env, swapping the host address, suffixing db names and running cleanup scripts.
// The config is imported on the host, so these functions run on the host, and relative paths resolve against the project root (the current directory).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { t } from "./term.ts";

/** 容器里访问宿主机用的主机名。 / Hostname the container uses to reach the host. */
export const CONTAINER_HOST = "host.containers.internal";

/**
 * 按顺序读宿主机上的 env 文件并合并，后面的覆盖前面的；不存在的文件跳过，不抛错。
 * Reads host env files in order and merges them, later files overriding earlier ones; missing files are skipped without throwing.
 */
export function readHostEnv(files: string | string[], projectRoot = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of Array.isArray(files) ? files : [files]) {
    const path = join(projectRoot, file);
    if (!existsSync(path)) continue;
    for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/**
 * 把 localhost / 127.0.0.1 换成 host.containers.internal，沙箱容器才连得上宿主机上的服务。
 * Replaces localhost / 127.0.0.1 with host.containers.internal so the sandbox container can reach services on the host.
 */
export const toContainerHost = (value: string): string => value.replace(/\b(localhost|127\.0\.0\.1)\b/g, CONTAINER_HOST);

/**
 * 给库名 / 前缀加后缀（如 `_i12`），每张票用独立的库。不是 URL 的值直接拼接；URL 在路径末尾拼接，结尾的 / 保留，query 和 hash 不动。
 * URL 没有库名时抛错：静默返回原值会让测试打到开发库。
 * Appends a suffix (e.g. `_i12`) to a db name / prefix so each ticket gets its own database. Non-URL values are concatenated; for URLs the suffix goes at the end of the path, keeping a trailing slash, query and hash.
 * Throws when the URL has no db name: silently returning it unchanged would point tests at the dev database.
 */
export function withDbSuffix(url: string, suffix: string): string {
  if (!url.includes("://")) return url + suffix;
  const u = new URL(url);
  const trailing = u.pathname.endsWith("/");
  const path = trailing ? u.pathname.slice(0, -1) : u.pathname;
  if (path === "") {
    // 报错信息里遮掉密码，免得写进日志。 / Mask the password in the error so it doesn't end up in logs.
    const shown = new URL(url);
    if (shown.password) shown.password = "***";
    throw new Error(
      t(`withDbSuffix：${shown} 没有库名或前缀，无法按票隔离`, `withDbSuffix: ${shown} has no database name or prefix, so it cannot be isolated per ticket`),
    );
  }
  u.pathname = `${path}${suffix}${trailing ? "/" : ""}`;
  return u.toString();
}

/**
 * 在宿主机上异步跑回收脚本：成功返回 stdout；失败 console.warn 一行（label 加 stderr 前 500 字）并返回 undefined，从不抛错。
 * Runs a cleanup script on the host asynchronously: returns stdout on success; on failure logs one console.warn line (label plus the first 500 chars of stderr) and returns undefined, never throwing.
 */
export async function runHostScript(command: string, args: string[], label: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(command, args, { encoding: "utf8" });
    return stdout;
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    console.warn(`  ⚠ ${label}${t("：", ": ")}${(stderr || stdout || String(e)).trim().slice(0, 500)}`);
    return undefined;
  }
}
