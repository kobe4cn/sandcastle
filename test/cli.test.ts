// 命令行入口：在项目外运行时只打一行提示，不打源码行和堆栈。
// CLI entry: outside a project it prints a one-line message, not the source line and stack.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sandpipe-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runCli = (args: string[], env: Record<string, string> = {}, cwd = dir) =>
  spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SANDPIPE_LANG: "en", ...env },
  });

/** 新临时目录，可带一份 .sandcastle/.env（notify 的 URL 只从这里或宿主机同名变量读）。 / A fresh temp directory, optionally with a .sandcastle/.env (notify's URL is read only from there or the host's same-named variable). */
const withEnvFile = (value: string): string => {
  const d = mkdtempSync(join(tmpdir(), "sandpipe-cli-"));
  mkdirSync(join(d, ".sandcastle"), { recursive: true });
  writeFileSync(join(d, ".sandcastle", ".env"), `SANDPIPE_NOTIFY_WEBHOOK=${value}\n`);
  return d;
};

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

  it("run 出错时项目外没有 .sandcastle/.env、环境里没配 webhook：不发 crashed 通知，退出码 1、输出不变", () => {
    const r = runCli(["run"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^✗ .*sandcastle\.config\.ts not found: run in the project root/m);
    expect(r.stderr).toContain("SANDPIPE_DEBUG=1");
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain("Notify webhook");
  }, 30_000);

  it("run 出错时发 crashed 通知：.env 里配了坏 URL 时发不出去，只多一行警告，照常退出码 1、错误输出不变", () => {
    // 坏 URL 在 fetch 解析就失败，不连网；这条警告只有 crashed 通知真的去发了才会出现。
    // A broken URL fails at fetch's URL parsing, no network; this warning appears only when the crashed notification was actually attempted.
    const r = runCli(["run"], {}, withEnvFile("not a url"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Notify webhook failed");
    expect(r.stderr).toMatch(/^✗ .*sandcastle\.config\.ts not found: run in the project root/m);
    expect(r.stderr).toContain("SANDPIPE_DEBUG=1");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 30_000);
});
