// 版本：比较、从 releases 仓库取最新版本（不连网，fetch 换成假的）。
import { describe, expect, it } from "vitest";
import { LATEST_URL, latestVersion, newer, upgradeCommand } from "../src/version.ts";

describe("newer", () => {
  it("按数字比 x.y.z", () => {
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
    expect(newer("0.1.0", "1.0.0")).toBe(false);
  });
});

describe("latestVersion", () => {
  it("取 tag_name 去掉 v；不是 200 或连不上返回 undefined", async () => {
    const ok = (async () => new Response(JSON.stringify({ tag_name: "v0.2.0" }))) as typeof fetch;
    expect(await latestVersion(ok)).toBe("0.2.0");
    expect(await latestVersion((async () => new Response("", { status: 404 })) as typeof fetch)).toBeUndefined();
    expect(
      await latestVersion((async () => {
        throw new Error("offline");
      }) as typeof fetch),
    ).toBeUndefined();
    expect(LATEST_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/sandcastle-releases\/releases\/latest\/download\/sandcastle-pipeline\.tgz$/);
  });
});

describe("upgradeCommand", () => {
  it("pnpm 全局装的用 pnpm add -g，其余用 npm i -g", () => {
    expect(upgradeCommand("/Users/a/Library/pnpm/global/5/.pnpm/sandcastle-pipeline@0.1.0/node_modules/sandcastle-pipeline/dist/cli.js")).toBe(
      `pnpm add -g ${LATEST_URL}`,
    );
    expect(upgradeCommand("/tmp/home/store/v11/links/@/sandcastle-pipeline/0.1.0/ecb4/node_modules/sandcastle-pipeline/dist/cli.js")).toMatch(/^pnpm add -g /);
    expect(upgradeCommand("/opt/homebrew/lib/node_modules/sandcastle-pipeline/dist/cli.js")).toBe(`npm i -g ${LATEST_URL}`);
  });
});
