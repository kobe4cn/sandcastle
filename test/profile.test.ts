import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, DEFAULT_LABELS, loadProject, resolveProject, type ProjectProfile } from "../src/profile.ts";

const minimal: ProjectProfile = {
  install: { onSandboxReady: "npm ci" },
  isolation: { env: (id) => ({ RUN: id }) },
  gate: { script: ({ baseRef }) => `echo ${baseRef}`, testFile: /test\/\S+\.test\.ts/, typecheck: "npm run typecheck" },
};

describe("resolveProject", () => {
  it("只给必填项时其余取默认值", () => {
    const p = resolveProject(minimal);
    expect(p.forge.name).toBe("github");
    expect([p.remote, p.baseBranch, p.mergeMethod, p.autoMerge, p.maxParallel, p.reviseMax, p.contextBudget]).toEqual(["origin", "main", "rebase", true, 2, 2, 150_000]);
    expect(p.labels).toEqual(DEFAULT_LABELS);
    expect(p.gate.rerunMax).toBe(3);
    expect(p.install.copyToWorktree).toEqual([]);
    expect(p.integrity).toBeUndefined();
    expect(p.mergeRequires).toEqual({ checks: "all", timeoutMinutes: 30 });
    expect(p.browser).toEqual({ pagePaths: [] });
    expect(p.texts.revisePrompt({ issueId: "1", branch: "b", title: "t", viewIssue: "gh issue view 1", items: "- x" })).toContain("gh issue view 1");
  });

  it("fixPrompt 让 agent 只跑失败的测试文件和类型检查，不跑完整门槛", () => {
    const prompt = resolveProject(minimal).texts.fixPrompt({ issueId: "1", branch: "b", title: "t", viewIssue: "gh issue view 1", gateOutput: "x", rerunMax: 3 });
    expect(prompt).toContain("单独跑失败的测试文件和类型检查");
    expect(prompt).toContain("不要跑完整门槛");
  });

  it("browser.pagePaths 原样保留", () => {
    expect(resolveProject({ ...minimal, browser: { pagePaths: [/^app\/routes\//] } }).browser.pagePaths).toEqual([/^app\/routes\//]);
    expect(resolveProject({ ...minimal, browser: {} }).browser.pagePaths).toEqual([]);
  });

  it("protectedPaths 不写时为空、写了原样保留", () => {
    expect(resolveProject(minimal).protectedPaths).toEqual([]);
    expect(resolveProject({ ...minimal, protectedPaths: [/^\.github\//, /^migrations\//] }).protectedPaths).toEqual([/^\.github\//, /^migrations\//]);
  });

  it("trustedAuthors 不写时为空、写了原样保留", () => {
    expect(resolveProject(minimal).trustedAuthors).toEqual([]);
    expect(resolveProject({ ...minimal, trustedAuthors: ["renovate-bot"] }).trustedAuthors).toEqual(["renovate-bot"]);
  });

  it("notify 不写时用默认变量名、写了只覆盖给的字段", () => {
    expect(resolveProject(minimal).notify).toEqual({ env: "SANDPIPE_NOTIFY_WEBHOOK" });
    expect(resolveProject({ ...minimal, notify: { env: "MY_WEBHOOK" } }).notify).toEqual({ env: "MY_WEBHOOK" });
    expect(resolveProject({ ...minimal, notify: {} }).notify).toEqual({ env: "SANDPIPE_NOTIFY_WEBHOOK" });
  });

  it("needsTriage / trusted 标签默认值，只覆盖一个时另一个取默认值", () => {
    expect([DEFAULT_LABELS.needsTriage, DEFAULT_LABELS.trusted]).toEqual(["needs-triage", "sandcastle:trusted"]);
    const p = resolveProject({ ...minimal, labels: { trusted: "ok-to-run" } });
    expect([p.labels.needsTriage, p.labels.trusted]).toEqual(["needs-triage", "ok-to-run"]);
    const q = resolveProject({ ...minimal, labels: { needsTriage: "triage" } });
    expect([q.labels.needsTriage, q.labels.trusted]).toEqual(["triage", "sandcastle:trusted"]);
  });

  it("mergeRequires 只给一个字段时另一个取默认值", () => {
    expect(resolveProject({ ...minimal, mergeRequires: { timeoutMinutes: 10 } }).mergeRequires).toEqual({ checks: "all", timeoutMinutes: 10 });
    expect(resolveProject({ ...minimal, mergeRequires: { checks: "required" } }).mergeRequires).toEqual({ checks: "required", timeoutMinutes: 30 });
  });

  it("标签只覆盖给了的那几个", () => {
    const p = resolveProject({ ...minimal, labels: { picked: "agent" } });
    expect(p.labels.picked).toBe("agent");
    expect(p.labels.stuck).toBe(DEFAULT_LABELS.stuck);
  });
});

describe("loadProject", () => {
  it("读项目根目录的 .sandcastle/sandcastle.config.ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-profile-"));
    mkdirSync(join(dir, ".sandcastle"));
    const profileTs = resolve("src/profile.ts");
    writeFileSync(
      join(dir, ".sandcastle/sandcastle.config.ts"),
      `import { defineProject } from ${JSON.stringify(profileTs)};
export default defineProject({ maxParallel: 5, install: { onSandboxReady: "x" }, isolation: { env: () => ({}) },
  gate: { script: () => "true", testFile: /t/, typecheck: "true" } });`,
    );
    expect((await loadProject(join(dir, ".sandcastle"))).maxParallel).toBe(5);
  });

  it("配置目录默认是 <cwd>/.sandcastle，SANDCASTLE_PROJECT_DIR 可以改到别处（相对路径按 cwd 解析）", () => {
    expect(configDir("/repo", {})).toBe("/repo/.sandcastle");
    expect(configDir("/repo", { SANDCASTLE_PROJECT_DIR: "/x/conf" })).toBe("/x/conf");
    expect(configDir("/repo", { SANDCASTLE_PROJECT_DIR: "../conf" })).toBe("/conf");
  });

  it("没有配置文件时报错说明去哪写", async () => {
    await expect(loadProject(mkdtempSync(join(tmpdir(), "sc-empty-")))).rejects.toThrow(/sandcastle\.config\.ts.*SANDCASTLE_PROJECT_DIR/);
  });
});
