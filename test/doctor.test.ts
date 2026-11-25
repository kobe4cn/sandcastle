// doctor：在 onboard 刚生成的项目上跑，逐项给出结论；--fix 补建缺的标签。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.ts";
import { type Check, diagnose, formatChecks, type Runner } from "../src/doctor.ts";
import { githubForge } from "../src/forges/github.ts";
import { installFiles, installGlobalSkill } from "../src/onboard.ts";
import { VERSION } from "../src/version.ts";
import { DEFAULT_LABELS } from "../src/profile.ts";
import { trySh } from "../src/shell.ts";
import { nodeRepo } from "./fixtures.ts";

/** git 本地命令真跑；连远端和 podman 的换成假的。 */
const runner =
  (opts: { image: boolean; pushed?: boolean }): Runner =>
  (cmd, args) => {
    if (cmd === "git" && args.includes("ls-remote")) return { ok: true, out: "abc\trefs/heads/main" };
    // git show origin/main:<文件>：默认当作已推送，返回工作区里的内容
    if (cmd === "git" && args.includes("show")) {
      if (opts.pushed === false) return { ok: false, out: "fatal: invalid object name 'origin/main'" };
      return { ok: true, out: readFileSync(join(args[1]!, args.at(-1)!.split(":")[1]!), "utf8") };
    }
    if (cmd === "podman") return args[0] === "image" ? { ok: opts.image, out: "" } : { ok: true, out: "arm64" };
    return trySh(cmd, args);
  };

/** tokenOk=false 时用 .env 的 token 调 gh api 返回 403（模拟 token 没给 Pull requests 权限）。 */
function fakeGh(labels: string[], created: string[][], tokenOk = true) {
  return githubForge((args, env) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return args.includes(".nameWithOwner") ? "acme/shop" : "acme/shop WRITE";
    if (args[0] === "api") {
      if (env?.GH_TOKEN !== "x" && env?.GH_TOKEN !== "y") throw new Error(`没用 .env 的 token：${env?.GH_TOKEN}`);
      if (!tokenOk && args[1]!.includes("/pulls")) throw Object.assign(new Error("gh"), { stderr: "HTTP 403: Resource not accessible by personal access token" });
      return "";
    }
    if (args[0] === "label" && args[1] === "list") return labels.join("\n");
    if (args[0] === "label" && args[1] === "create") {
      created.push(args);
      return "";
    }
    throw new Error(`没料到的 gh ${args.join(" ")}`);
  });
}

const levels = (checks: { name: string; level: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c.level]));

describe("diagnose", () => {
  it("onboard 刚生成：草稿 PROJECT.md 警告，没有 .env、缺标签、没有镜像都不通过；补齐后全过", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const env = {} as NodeJS.ProcessEnv;
    const created: string[][] = [];

    const first = await diagnose({ cwd: root, env, run: runner({ image: false }), forge: fakeGh(["bug"], created) });
    expect(levels(first)).toEqual({
      仓库: "ok",
      配置: "ok",
      宿主机依赖: "ok",
      "PROJECT.md": "warn",
      项目知识: "warn",
      "models.json": "ok",
      ".env": "fail",
      "平台（github）": "ok",
      标签: "fail",
      远端分支: "ok",
      沙箱镜像: "fail",
      编辑器类型: "ok",
      "上下文 hook": "ok",
      ".gitignore": "ok",
      "Claude 文件": "ok",
      已推送: "ok",
    });
    const text = formatChecks(first);
    expect(text).toContain("cp .sandcastle/.env.example .sandcastle/.env");
    expect(text).toMatch(/podman build -t \S+ -f \.sandcastle\/Containerfile \.sandcastle/);
    expect(text).toContain("doctor --fix");

    // .env 里只有 GH_TOKEN：缺 Claude 凭据
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\n");
    const second = await diagnose({ cwd: root, env, run: runner({ image: true }), forge: fakeGh(["bug"], created) });
    expect(second.find((c) => c.name === ".env")).toMatchObject({
      level: "fail",
      detail: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"),
    });

    // 值空着、取宿主机环境变量也算；--fix 建好全部标签
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=\n");
    const third = await diagnose({
      cwd: root,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      run: runner({ image: true }),
      forge: fakeGh(["bug", "Sandcastle"], created),
      fix: true,
    });
    expect(third.filter((c) => c.level === "fail")).toEqual([]);
    expect(created.map((a) => a[2])).toEqual(Object.values(DEFAULT_LABELS).filter((l) => l !== "Sandcastle"));
  });

  it(".env 没被 git 忽略直接不通过", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.gitignore"), "logs/\n");
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(Object.values(DEFAULT_LABELS), []) });
    expect(checks.find((c) => c.name === ".env")).toMatchObject({ level: "fail", detail: expect.stringContaining("没被 git 忽略") });
  });
});

/** onboard 生成、.env 填好、PROJECT.md 写完（去掉「待补」）的项目。 */
function readyRepo() {
  const root = nodeRepo();
  installFiles(root, detectProject(root));
  writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
  const doc = join(root, ".sandcastle/PROJECT.md");
  writeFileSync(doc, readFileSync(doc, "utf8").replace(/<!--[\s\S]*?-->/g, ""));
  writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
  return root;
}
const check = (checks: Check[], name: string) => checks.find((c) => c.name === name);
const allLabels = Object.values(DEFAULT_LABELS);

describe("diagnose：项目知识", () => {
  const knowledge = async (content: string | null) => {
    const root = readyRepo();
    const file = join(root, ".sandcastle/OPEN-QUESTIONS.md");
    if (content === null) rmSync(file);
    else writeFileSync(file, content);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    return check(checks, "项目知识");
  };

  it("清单还有 2 条：警告，提示 /fill-project-docs", async () => {
    const c = await knowledge("# 缺口清单\n\n- [规范] 错误怎么处理 → PROJECT.md\n- [意图] 为什么不用 ORM → docs/adr/\n");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("2") });
    expect(c?.detail).toContain("/fill-project-docs");
  });

  it("清单只有标题：通过", async () => {
    expect((await knowledge("# 缺口清单\n"))?.level).toBe("ok");
  });

  it("清单不存在：警告，提示 onboard --questions-only", async () => {
    expect(await knowledge(null)).toMatchObject({ level: "warn", fix: expect.stringContaining("sandpipe onboard --questions-only") });
  });

  it("清单格式错：警告（不是不通过），指出行号", async () => {
    expect(await knowledge("# 缺口清单\n随手写的一行\n")).toMatchObject({ level: "warn", detail: expect.stringContaining("第 2 行") });
  });

  it("没有 PROJECT.md：不做这项检查", async () => {
    const root = readyRepo();
    rmSync(join(root, ".sandcastle/PROJECT.md"));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "项目知识")).toBeUndefined();
  });
});

describe("diagnose 的出错分支", () => {
  it("准备好的项目全部通过", async () => {
    const root = readyRepo();
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(checks.filter((c) => c.level !== "ok")).toEqual([]);
  });

  it(".env 的 GH_TOKEN 读不了 PR：不通过，说明缺什么权限", async () => {
    const root = readyRepo();
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, [], false) });
    expect(check(checks, "GH_TOKEN")).toMatchObject({ level: "fail", detail: expect.stringMatching(/PR.*403.*Pull requests/) });
  });

  it("在子目录运行、没有配置：仓库和配置都不通过", async () => {
    const root = nodeRepo();
    const checks = await diagnose({ cwd: join(root, "app"), env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "仓库")).toMatchObject({ level: "fail", detail: expect.stringContaining("不在仓库根目录") });
    expect(check(checks, "配置")).toMatchObject({ level: "fail", fix: expect.stringContaining("onboard") });
  });

  it("PROJECT.md 有不认识的标题：不通过", async () => {
    const root = readyRepo();
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8") + "\n## 杂项\n\nx\n");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "PROJECT.md")).toMatchObject({ level: "fail", detail: expect.stringContaining("杂项") });
  });

  it("models.json 能用但有警告（别家档案没设 limitPattern 等）：警告", async () => {
    const root = readyRepo();
    const profile = { model: "x", env: { ANTHROPIC_BASE_URL: "https://example.com" } };
    const phases = Object.fromEntries(["prep", "implement", "review", "revise", "fix", "rebase"].map((p) => [p, ["other"]]));
    writeFileSync(join(root, ".sandcastle/models.json"), JSON.stringify({ profiles: { other: profile }, phases }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "models.json")).toMatchObject({ level: "warn", detail: expect.stringContaining("limitPattern") });
    // 全部阶段都发到别家：不要求 Claude 凭据
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\n");
    const again = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(again, ".env")?.level).toBe("ok");
  });

  it("podman 没起来：不通过，提示 podman machine start", async () => {
    const root = readyRepo();
    const run: Runner = (cmd, args) =>
      cmd === "podman" ? { ok: false, out: "Cannot connect to Podman\nmore" } : runner({ image: true })(cmd, args);
    const checks = await diagnose({ cwd: root, env: {}, run, forge: fakeGh(allLabels, []) });
    expect(check(checks, "沙箱镜像")).toMatchObject({
      level: "fail",
      detail: "podman 用不了：Cannot connect to Podman",
      fix: expect.stringContaining("podman machine start"),
    });
  });

  it("配置里自定义了 sandbox：不查 podman", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "export default defineProject({",
        "export default defineProject({\n  sandbox: () => ({}) as never,",
      ),
    );
    const run: Runner = (cmd, args) => {
      if (cmd === "podman") throw new Error("不该调 podman");
      return runner({ image: true })(cmd, args);
    };
    const checks = await diagnose({ cwd: root, env: {}, run, forge: fakeGh(allLabels, []) });
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "ok", detail: expect.stringContaining("自定义") });
  });

  it("只缺 flaky / main-broken（用到时自动建）：通过；gh 没登录：平台不通过、不再查标签", async () => {
    const root = readyRepo();
    const labels = allLabels.filter((l) => l !== DEFAULT_LABELS.flaky && l !== DEFAULT_LABELS.mainBroken);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(labels, []) });
    expect(check(checks, "标签")).toMatchObject({ level: "ok", detail: expect.stringContaining("用到时自动建") });

    const loggedOut = githubForge(() => {
      throw new Error("not logged in");
    });
    const out = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: loggedOut });
    expect(check(out, "平台（github）")?.level).toBe("fail");
    expect(check(out, "标签")).toBeUndefined();
  });
});

describe("diagnose：.claude/ 文件与版本", () => {
  it("skill 被改过：警告并提示 update；有新版本：警告并提示 upgrade；已是最新：通过", async () => {
    const root = readyRepo();
    writeFileSync(join(root, ".claude/skills/prep-ticket/SKILL.md"), "旧版");
    const base = { cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) };
    const checks = await diagnose({ ...base, latest: async () => "99.0.0" });
    expect(check(checks, "Claude 文件")).toMatchObject({ level: "warn", fix: "sandpipe update" });
    expect(check(checks, "版本")).toMatchObject({ level: "warn", fix: expect.stringContaining("upgrade") });

    const ok = await diagnose({ ...base, latest: async () => VERSION });
    expect(check(ok, "版本")?.level).toBe("ok");
    expect(check(await diagnose(base), "版本")).toBeUndefined();
  });

  it("fill-project-docs skill 被改过：警告并提示 update", async () => {
    const root = readyRepo();
    writeFileSync(join(root, ".claude/skills/fill-project-docs/SKILL.md"), "旧版");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "Claude 文件")).toMatchObject({ level: "warn", fix: "sandpipe update" });
    expect(check(checks, "Claude 文件")?.detail).toContain(".claude/skills/fill-project-docs/SKILL.md");
  });

  it("全局 skill 装过但不是当前版本：警告（它会盖过项目里的）；没装或已是当前版本：不提", async () => {
    const root = readyRepo();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const base = { cwd: root, env: { HOME: home }, run: runner({ image: true }), forge: fakeGh(allLabels, []) };
    const globalWarn = (cs: Check[]) => cs.filter((c) => c.name === "Claude 文件" && c.detail.includes("全局"));
    expect(globalWarn(await diagnose(base))).toEqual([]);
    installGlobalSkill(join(home, ".claude"));
    expect(globalWarn(await diagnose(base))).toEqual([]);
    writeFileSync(join(home, ".claude/skills/prep-ticket/SKILL.md"), "旧版");
    expect(globalWarn(await diagnose(base))).toMatchObject([{ level: "warn", fix: "sandpipe update" }]);
  });
});

describe("diagnose：沙箱用到的文件是否已推送", () => {
  it("远端没有 .claude/ 和 .gitignore：警告并提示提交推送", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true, pushed: false }), forge: fakeGh([], []) });
    const c = checks.find((x) => x.name === "已推送")!;
    expect(c.level).toBe("warn");
    expect(c.detail).toContain(".claude/settings.json");
    expect(c.fix).toContain("推送");
  });
});
