// 命令行入口：在项目外运行时只打一行提示，不打源码行和堆栈。
// CLI entry: outside a project it prints a one-line message, not the source line and stack.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sandpipe-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runCli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SANDPIPE_LANG: "en", ...env },
  });

describe("在项目外运行", () => {
  it("run 只打找不到配置的提示，退出码 1，不带堆栈", () => {
    const r = runCli(["run"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^✗ .*sandcastle\.config\.ts not found: run in the project root/m);
    expect(r.stderr).toContain("SANDPIPE_DEBUG=1");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 30_000);

  it("SANDPIPE_DEBUG=1 时打完整堆栈", () => {
    const r = runCli(["run"], { SANDPIPE_DEBUG: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\n\s+at /);
  }, 30_000);
});
