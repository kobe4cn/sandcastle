// onboard：探测项目事实、生成配置与 PROJECT.md 草稿、登记 hook。生成的文件要能被流水线直接加载。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject, parseRemoteUrl } from "../src/detect.ts";
import { containerfileSource, installFiles, mergeGitignore, mergeSettings, onboardPrompt } from "../src/onboard.ts";
import { loadProject } from "../src/profile.ts";
import { parseProjectDoc } from "../src/project-doc.ts";
import { nodeRepo } from "./fixtures.ts";

const containerTemplate = readFileSync(new URL("../templates/.sandcastle/Containerfile", import.meta.url), "utf8");

describe("parseRemoteUrl", () => {
  it("认出 GitHub / GitLab 的 ssh 与 https 地址，自建 GitLab 带子组", () => {
    expect(parseRemoteUrl("git@github.com:acme/shop.git")).toEqual({ kind: "github", host: "github.com", path: "acme/shop" });
    expect(parseRemoteUrl("https://gitlab.example.com/g/sub/repo.git")).toEqual({
      kind: "gitlab",
      host: "gitlab.example.com",
      path: "g/sub/repo",
    });
    expect(parseRemoteUrl("ssh://git@gitlab.corp:2222/g/repo.git").kind).toBe("gitlab");
    expect(parseRemoteUrl("https://git.corp/x/y").kind).toBe("unknown");
  });
});

describe("detectProject", () => {
  it("node + pnpm 项目：命令、安装、服务、迁移、网页界面、提交语言", () => {
    const f = detectProject(nodeRepo());
    expect(f).toMatchObject({
      name: "shop",
      language: "node",
      packageManager: "pnpm",
      install: "npx -y pnpm@10.4.1 install --frozen-lockfile",
      commands: { typecheck: "pnpm typecheck", lint: "pnpm lint", test: "pnpm test", testFile: "npx vitest run <file>" },
      forge: { kind: "github", path: "acme/shop" },
      baseBranch: "main",
      services: ["postgres", "redis"],
      migrations: { tool: "drizzle-kit", dir: "drizzle" },
      webUi: true,
      commitLanguage: "zh",
      testDirs: ["test"],
    });
    expect(f.topDirs).toEqual(["app", "deploy", "drizzle", "test"]);
    expect(f.docs).toContain("CLAUDE.md");
  });
});

describe("installFiles", () => {
  it("生成的配置能被流水线加载，PROJECT.md 草稿能通过校验；再跑一次什么都不覆盖", async () => {
    const root = nodeRepo();
    const f = detectProject(root);
    const first = installFiles(root, f);
    expect(first.every((o) => o.status === "写入")).toBe(true);

    const project = await loadProject(join(root, ".sandcastle"));
    expect(project.install.onSandboxReady).toBe(f.install);
    expect(project.gate.script({ baseRef: "origin/main" })).toBe("pnpm typecheck && pnpm lint && pnpm test");
    expect(project.gate.testFile.test("test/a.test.ts")).toBe(true);
    expect(project.isolation.env("12")).toEqual({ SANDCASTLE_RUN_ID: "12" });

    const doc = parseProjectDoc(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8"));
    expect(doc.commands).toContain("`pnpm typecheck`");
    expect(doc.conflicts).toContain("drizzle-kit");
    expect(doc.commit).toContain("中文");

    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    const second = installFiles(root, f);
    expect(second.filter((o) => o.status === "写入")).toEqual([]);
    expect(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8")).toBe("人改过");
  });
});

describe("mergeSettings", () => {
  it("保留已有的 hook 与设置，只加一次", () => {
    const existing = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node a.mjs" }] }] } };
    const once = mergeSettings(existing);
    expect(once.changed).toBe(true);
    expect(once.settings.model).toBe("x");
    expect(once.settings.hooks!.PreToolUse.map((e) => e.matcher)).toEqual(["Bash", "Read"]);
    expect(once.settings.hooks!.PostToolUse[0].matcher).toBe("*");
    expect(mergeSettings(once.settings).changed).toBe(false);
    expect(existing.hooks.PreToolUse).toHaveLength(1);
  });
});

describe("mergeGitignore", () => {
  it("补上缺的工作目录，已有的（带不带 / 前缀、尾斜杠）不重复；都有时不改", () => {
    const out = mergeGitignore("node_modules\n/.browser-check\n")!;
    expect(out).toMatch(/^node_modules\n\/\.browser-check\n\n# Sandcastle.*\n\.playwright-cli\/\n\.pr-notes\/\n$/);
    expect(mergeGitignore(out)).toBeUndefined();
    expect(mergeGitignore("")).toContain(".browser-check/");
  });
});

describe("containerfileSource", () => {
  it("没有网页界面去掉浏览器那段；python 加工具链", () => {
    const base = detectProject(nodeRepo());
    expect(containerfileSource(containerTemplate, base)).toContain("playwright");
    const py = containerfileSource(containerTemplate, { ...base, webUi: false, language: "python" });
    expect(py).not.toContain("playwright");
    expect(py).toContain("python3-venv");
    expect(py).toContain("ENTRYPOINT");
  });
});

describe("onboardPrompt", () => {
  it("事实、模板、示例都填进去，没有残留占位符", () => {
    const p = onboardPrompt(detectProject(nodeRepo()));
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).toContain('"packageManager": "pnpm"');
    expect(p).toContain("$type<…>()");
  });
});
