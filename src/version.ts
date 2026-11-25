// 版本与升级：每次发版同时发到 npm（包名 sandpipe）和公开的 releases 仓库（package.json 的
// sandcastle.releases，附固定名字的 sandpipe.tgz，给不方便用 npm 源的人）。最新版本按 npm 查。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
  sandcastle: { releases: string };
};

export const VERSION = pkg.version;
export const PACKAGE = "sandpipe";
export const RELEASES_REPO = pkg.sandcastle.releases;
export const ASSET = "sandpipe.tgz";
export const LATEST_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/${ASSET}`;
/**
 * 用装本工具的那个包管理器升级。pnpm 装的包实际放在它的 store 里：旧版是 …/.pnpm/…，
 * 新版是 …/store/v11/links/…（PNPM_HOME 可以随便设，所以不靠目录名里有没有 pnpm）。其余按 npm。
 */
export function upgradeCommand(installedAt: string = fileURLToPath(import.meta.url)): string {
  const pnpm = /[\\/]\.pnpm[\\/]|[\\/]store[\\/]v\d+[\\/]links[\\/]/.test(installedAt);
  return pnpm ? `pnpm add -g ${PACKAGE}@latest` : `npm i -g ${PACKAGE}@latest`;
}

/** npm 上的最新版本号；网络不通、还没发版时返回 undefined。 */
export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
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
