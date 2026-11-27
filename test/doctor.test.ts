// doctor：在 onboard 刚生成的项目上跑，逐项给出结论；--fix 补建缺的标签。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { nodeRepo, pythonRepo } from "./fixtures.ts";

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

/**
 * tokenOk=false 时用 .env 的 token 调 gh api 返回 403（模拟 token 没给 Pull requests 权限）。
 * issues 是 issue list 按接入标签（Sandcastle）返回的 open 票，mainBroken 是按 sandcastle:main-broken 返回的票号；
 * missing 里的编号 issue view 报不存在，failing 里的报网络错误，其他返回 OPEN。
 */
function fakeGh(
  labels: string[],
  created: string[][],
  tokenOk = true,
  tickets: { issues?: { number: number; body: string }[]; mainBroken?: number[]; missing?: number[]; failing?: number[]; listError?: boolean } = {},
) {
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
    if (args[0] === "issue" && args[1] === "list") {
      if (tickets.listError) throw new Error("issue list 超时");
      // doctor 只按 --label 查 open 票：接入标签走 issues，sandcastle:main-broken 走 mainBroken，两边互不串
      const label = args[args.indexOf("--label") + 1];
      const list = label === "sandcastle:main-broken" ? (tickets.mainBroken ?? []).map((n) => ({ number: n, body: "无" })) : (tickets.issues ?? []);
      return JSON.stringify(
        list.map((i) => ({ ...i, title: `票 ${i.number}`, labels: [{ name: label }], updatedAt: "2026-11-26T00:00:00Z", author: { login: "alice", is_bot: false } })),
      );
    }
    if (args[0] === "issue" && args[1] === "view") {
      const m = Number(args[2]);
      if (tickets.missing?.includes(m))
        throw Object.assign(new Error("gh"), { stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${m}.` });
      if (tickets.failing?.includes(m)) throw new Error("connection reset");
      return "OPEN";
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
      // 探测到服务时生成的 isolation.env 读项目根的 .env，刚 onboard 时还没有
      "宿主机 env 文件": "warn",
      "PROJECT.md": "warn",
      // nodeRepo 有 react，草稿不生成浏览器验收
      浏览器验收: "warn",
      // onboard 生成的配置 autoMerge: false
      合并条件: "ok",
      受保护路径: "ok",
      项目知识: "warn",
      "models.json": "ok",
      ".env": "fail",
      "平台（github）": "ok",
      标签: "fail",
      "Blocked by": "ok",
      // 刚 onboard 的项目没有开着的 main-broken 票
      "main 兜底测试": "ok",
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

/** nodeRepo 有 react（探测到网页界面），准备好的项目要写上浏览器验收。 */
const BROWSER_SECTION = "\n## 浏览器验收\n\n1. 起服务：`pnpm dev --port 5180 &`，等 curl 通。\n";

/** onboard 生成、.env 填好、PROJECT.md 写完（去掉「待补」）的项目。 */
function readyRepo() {
  const root = nodeRepo();
  installFiles(root, detectProject(root));
  writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
  writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:p@localhost:5432/app\n");
  const doc = join(root, ".sandcastle/PROJECT.md");
  writeFileSync(doc, readFileSync(doc, "utf8").replace(/<!--[\s\S]*?-->/g, "") + BROWSER_SECTION);
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

describe("diagnose：浏览器验收", () => {
  const run = (root: string) => diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });

  it("有网页界面、PROJECT.md 没有这一节：警告，指向 config 文档", async () => {
    const root = readyRepo();
    const doc = join(root, ".sandcastle/PROJECT.md");
    const before = readFileSync(doc, "utf8");
    expect(before).toContain(BROWSER_SECTION);
    writeFileSync(doc, before.replace(BROWSER_SECTION, ""));
    const checks = await run(root);
    expect(check(checks, "浏览器验收")).toMatchObject({
      level: "warn",
      detail: expect.stringMatching(/网页界面.*改页面的票会留给人看.*onboard.*docs\/config\.zh-CN\.md/),
    });
    // PROJECT.md 那一项不再拼浏览器验收的文字
    expect(check(checks, "PROJECT.md")?.detail).not.toContain("浏览器验收");
  });

  it("有网页界面、有这一节：通过", async () => {
    expect(check(await run(readyRepo()), "浏览器验收")?.level).toBe("ok");
  });

  it("没有网页界面但配了 browser.pagePaths、PROJECT.md 没有这一节：同样警告", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("  autoMerge: false,", "  autoMerge: false,\n  browser: { pagePaths: [/\\.tsx$/] },"));
    // 这个夹具是英文项目，检查项名和文案都是英文
    expect(check(await run(root), "Browser check")).toMatchObject({ level: "warn", detail: expect.stringMatching(/browser\.pagePaths.*onboard.*docs\/config\.md/) });
  });

  it("没有网页界面：没有这一项", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    expect(check(await run(root), "浏览器验收")).toBeUndefined();
  });
});

describe("diagnose：合并条件", () => {
  const run = (opts: { merge: string; workflow?: string }) => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("  autoMerge: false,", opts.merge));
    if (opts.workflow) {
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      writeFileSync(join(root, ".github/workflows", opts.workflow), "on: push\n");
    }
    return diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) }).then((c) => check(c, "合并条件"));
  };
  const none = '  autoMerge: true,\n  mergeRequires: { checks: "none" },';

  it("自动合并、checks 为 none、有 workflow：警告，提示 gate.script 或改回 all / required", async () => {
    expect(await run({ merge: none, workflow: "ci.yml" })).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("不等 CI"),
      fix: expect.stringMatching(/gate\.script[\s\S]*"all" \/ "required"[\s\S]*docs\/config\.zh-CN\.md/),
    });
  });

  it("有 workflow 但 checks 为 all（默认）：通过，写明门槛 + 所有检查", async () => {
    expect(await run({ merge: "  autoMerge: true,", workflow: "ci.yaml" })).toMatchObject({ level: "ok", detail: "门槛 + PR 上所有检查" });
  });

  it("checks 为 none 但没有 workflow：通过", async () => {
    expect(await run({ merge: none })).toMatchObject({ level: "ok", detail: expect.stringContaining("只看门槛") });
  });

  it("workflows 目录里没有 yml：通过", async () => {
    expect((await run({ merge: none, workflow: "README.md" }))?.level).toBe("ok");
  });

  it("配置加载失败：没有这一项", async () => {
    const root = readyRepo();
    writeFileSync(join(root, ".sandcastle/sandcastle.config.ts"), "export default {;\n");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "配置")?.level).toBe("fail");
    expect(check(checks, "合并条件")).toBeUndefined();
  });

  it("autoMerge 为 false：通过，即使 checks 为 none 且有 workflow", async () => {
    const c = await run({ merge: '  autoMerge: false,\n  mergeRequires: { checks: "none" },', workflow: "ci.yml" });
    expect(c).toMatchObject({ level: "ok", detail: expect.stringContaining("autoMerge: false") });
  });
});

describe("diagnose：受保护路径", () => {
  const run = (root: string) => diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });

  it("onboard 按探测写了：逐条列出正则，通过", async () => {
    // nodeRepo 有 drizzle 迁移目录
    expect(check(await run(readyRepo()), "受保护路径")).toMatchObject({ level: "ok", detail: "/^drizzle\\//" });
  });

  it("手动配了多条：逐条列出", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/  protectedPaths: .*\n/, "  protectedPaths: [/^\\.github\\//, /\\.snap$/],\n"));
    expect(check(await run(root), "受保护路径")).toMatchObject({ level: "ok", detail: "/^\\.github\\//、/\\.snap$/" });
  });

  it("没配：写未配置，通过（英文项目用英文）", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    expect(check(await run(root), "Protected paths")).toMatchObject({ level: "ok", detail: "not configured" });
  });

  it("配置加载失败：没有这一项", async () => {
    const root = readyRepo();
    writeFileSync(join(root, ".sandcastle/sandcastle.config.ts"), "export default {;\n");
    expect(check(await run(root), "受保护路径")).toBeUndefined();
  });
});

describe("diagnose：门槛依赖的服务", () => {
  const run = async (services: string | null, down: number[] = []) => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    if (services !== null) writeFileSync(config, readFileSync(config, "utf8").replace("  gate: {", `  gate: {\n    services: ${services},`));
    const probed: string[] = [];
    const checks = await diagnose({
      cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []),
      probe: async (host, port) => (probed.push(`${host}:${port}`), down.includes(port) ? "connect ECONNREFUSED" : null),
    });
    return { checks, probed };
  };
  const two = '[{ name: "postgres", host: "localhost", port: 5432 }, { name: "redis", host: "127.0.0.1", port: 6379 }]';

  it("每个服务一行：连上 ok，连不上 fail 并附修复提示", async () => {
    const { checks, probed } = await run(two, [6379]);
    expect(probed).toEqual(["localhost:5432", "127.0.0.1:6379"]);
    expect(check(checks, "门槛服务 postgres")).toMatchObject({ level: "ok", detail: "localhost:5432" });
    expect(check(checks, "门槛服务 redis")).toMatchObject({
      level: "fail",
      detail: expect.stringMatching(/127\.0\.0\.1:6379[\s\S]*ECONNREFUSED/),
      fix: expect.stringContaining("先把服务起来"),
    });
  });

  it("没声明 gate.services：不探测，也没有这类检查项", async () => {
    const { checks, probed } = await run(null);
    expect(probed).toEqual([]);
    expect(checks.filter((c) => c.name.startsWith("门槛服务"))).toEqual([]);
  });
});

describe("diagnose：Blocked by", () => {
  const run = (tickets: Parameters<typeof fakeGh>[3]) =>
    diagnose({ cwd: readyRepo(), env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, [], true, tickets) });

  it("没有带 Sandcastle 标签的票：通过", async () => {
    expect(check(await run({}), "Blocked by")?.level).toBe("ok");
  });

  it("引用都存在：通过，写明查了几张票", async () => {
    const c = check(await run({ issues: [{ number: 5, body: "## Blocked by\n- #3\n" }, { number: 6, body: "无" }] }), "Blocked by");
    expect(c).toMatchObject({ level: "ok", detail: expect.stringContaining("2") });
  });

  it("引用了不存在的票：警告，列出 #n → #m，提示改正", async () => {
    const issues = [
      { number: 5, body: "## Blocked by\n- #3\n- #99\n" },
      { number: 7, body: "## Blocked by\n- #99、#4\n" },
    ];
    const c = check(await run({ issues, missing: [99] }), "Blocked by");
    expect(c).toMatchObject({ level: "warn", fix: expect.stringContaining("Blocked by") });
    expect(c?.detail).toContain("#5 → #99");
    expect(c?.detail).toContain("#7 → #99");
    expect(c?.detail).not.toContain("#3");
  });

  it("单个 blocker 查询出错（不是 missing）：跳过这个 blocker", async () => {
    const c = check(await run({ issues: [{ number: 5, body: "## Blocked by\n- #8\n" }], failing: [8] }), "Blocked by");
    expect(c?.level).toBe("ok");
  });

  it("列票失败：整项警告并附错误", async () => {
    const c = check(await run({ listError: true }), "Blocked by");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("issue list 超时") });
  });
});

describe("diagnose：main 兜底测试", () => {
  const run = (tickets: Parameters<typeof fakeGh>[3]) =>
    diagnose({ cwd: readyRepo(), env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, [], true, tickets) });

  it("有开着的 main-broken 票：警告，列出票号，提示期间不自动合并", async () => {
    const c = check(await run({ mainBroken: [12, 15] }), "main 兜底测试");
    expect(c).toMatchObject({ level: "warn" });
    expect(c?.detail).toContain("#12、#15");
    expect(c?.fix).toContain("不自动合并");
  });

  it("没有开着的 main-broken 票：通过（Sandcastle 票不算）", async () => {
    expect(check(await run({ issues: [{ number: 5, body: "## Blocked by\n- #3\n" }] }), "main 兜底测试")?.level).toBe("ok");
  });

  it("列票失败：整项警告并附错误", async () => {
    const c = check(await run({ listError: true }), "main 兜底测试");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("issue list 超时") });
  });

  it("有票（英文项目）：文案是英文，票号用逗号连接", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, [], true, { mainBroken: [12] }) });
    expect(check(checks, "Main fallback test")).toMatchObject({ level: "warn", detail: expect.stringContaining("#12") });
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

  it("config 声明了 hostEnvFiles：缺的文件警告并给修法，补上后通过", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("  isolation: {", '  isolation: {\n    hostEnvFiles: [".env.test"],'));
    const base = { cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) };
    expect(check(await diagnose(base), "宿主机 env 文件")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining(".env.test"),
      fix: expect.stringContaining(".env.example"),
    });

    writeFileSync(join(root, ".env.test"), "TEST_DB=x\n");
    expect(check(await diagnose(base), "宿主机 env 文件")).toMatchObject({ level: "ok", detail: ".env.test" });
  });

  it("没声明 hostEnvFiles：扫 config 源码里的 .env 字面量，排除 .sandcastle/ 下的、示例文件和 .envrc", async () => {
    const root = readyRepo();
    rmSync(join(root, ".env"));
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(
      config,
      `import { existsSync } from "node:fs";\nconst files = [".env", '.sandcastle/.env', \`.env.example\`, ".env.sample", ".envrc"].filter(existsSync);\n` +
        readFileSync(config, "utf8"),
    );
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    const host = check(checks, "宿主机 env 文件");
    expect(host?.level).toBe("warn");
    expect(host?.detail).toMatch(/读取的 \.env 在宿主机上不存在/);
  });

  it("只缺 needs-triage / sandcastle:trusted（用到时自动建）：通过", async () => {
    const root = readyRepo();
    const labels = allLabels.filter((l) => l !== DEFAULT_LABELS.needsTriage && l !== DEFAULT_LABELS.trusted);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(labels, []) });
    const labelCheck = check(checks, "标签");
    expect(labelCheck?.level).toBe("ok");
    expect(labelCheck?.detail).toMatch(/用到时自动建/);
    expect(labelCheck?.detail).toContain("needs-triage");
    expect(labelCheck?.detail).toContain("sandcastle:trusted");
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
