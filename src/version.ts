// 版本与升级：本工具从公开的 releases 仓库分发（package.json 的 sandcastle.releases），
// 每个 Release 附一个固定名字的包 sandcastle-pipeline.tgz，所以「最新版」总有同一个下载地址。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
  sandcastle: { releases: string };
};

export const VERSION = pkg.version;
export const RELEASES_REPO = pkg.sandcastle.releases;
export const ASSET = "sandcastle-pipeline.tgz";
export const LATEST_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/${ASSET}`;
/**
 * 用装本工具的那个包管理器升级。pnpm 装的包实际放在它的 store 里：旧版是 …/.pnpm/…，
 * 新版是 …/store/v11/links/…（PNPM_HOME 可以随便设，所以不靠目录名里有没有 pnpm）。其余按 npm。
 */
export function upgradeCommand(installedAt: string = fileURLToPath(import.meta.url)): string {
  const pnpm = /[\\/]\.pnpm[\\/]|[\\/]store[\\/]v\d+[\\/]links[\\/]/.test(installedAt);
  return pnpm ? `pnpm add -g ${LATEST_URL}` : `npm i -g ${LATEST_URL}`;
}

/** 最新 Release 的版本号（去掉 v）；网络不通、还没发版时返回 undefined。 */
export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const tag = ((await res.json()) as { tag_name?: string }).tag_name;
    return tag?.replace(/^v/, "");
  } catch {
    return undefined;
  }
}

/** a 比 b 新（只比 x.y.z 的数字部分）。 */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
