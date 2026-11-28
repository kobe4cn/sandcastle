// doctor：在 onboard 刚生成的项目上跑，逐项给出结论；--fix 补建缺的标签、按 Containerfile 建缺的镜像。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/podman";
import { detectProject } from "../src/detect.ts";
import { type Check, diagnose, formatChecks, type Runner } from "../src/doctor.ts";
import { githubForge } from "../src/forges/github.ts";
import { buildImageArgs, containerfileHash, IMAGE_LABEL } from "../src/lifecycle.ts";
import { installFiles, installGlobalSkill } from "../src/onboard.ts";
import { VERSION } from "../src/version.ts";
import { DEFAULT_LABELS } from "../src/profile.ts";
import { trySh } from "../src/shell.ts";
import { nodeRepo, pythonRepo } from "./fixtures.ts";

/** runner 给 podman info 的 GraphRoot 假路径。 / The fake GraphRoot path the runner returns for podman info. */
const STORE_PATH = "/var/lib/containers/storage";

/** git 本地命令真跑；连远端和 podman 的换成假的（label 是 image inspect 返回的 `sandpipe.containerfile` 值，缺省当作没打）。 */
const runner =
  (opts: { image: boolean; pushed?: boolean; label?: string }): Runner =>
  (cmd, args) => {
    if (cmd === "git" && args.includes("ls-remote")) return { ok: true, out: "abc\trefs/heads/main" };
    // git show origin/main:<文件>：默认当作已推送，返回工作区里的内容
    if (cmd === "git" && args.includes("show")) {
      if (opts.pushed === false) return { ok: false, out: "fatal: invalid object name 'origin/main'" };
      return { ok: true, out: readFileSync(join(args[1]!, args.at(-1)!.split(":")[1]!), "utf8") };
    }
    if (cmd === "podman") {
      if (args[0] === "image" && args[1] === "inspect") return { ok: true, out: opts.label ?? "" };
      // 磁盘预检要量的容器存储路径（假路径，配假 statfs 用）
      if (args[0] === "info" && args.includes("{{.Store.GraphRoot}}")) return { ok: true, out: `${STORE_PATH}\n` };
      return args[0] === "image" ? { ok: opts.image, out: "" } : { ok: true, out: "arm64" };
    }
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
      // 门槛也没接 e2e（nodeRepo 没有 test:e2e script）
      "浏览器 e2e": "warn",
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
    expect(text).toMatch(/podman build -t \S+ --label sandpipe\.containerfile=[0-9a-f]{64} -f \.sandcastle\/Containerfile \.sandcastle/);
    expect(text).toContain("doctor --fix");

    // .env 里只有 GH_TOKEN：缺 Claude 凭据
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\n");
    const second = await diagnose({ cwd: root, env, run: runner({ image: true }), forge: fakeGh(["bug"], created) });
    expect(second.find((c) => c.name === ".env")).toMatchObject({
      level: "fail",
      detail: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"),
    });

    // 值空着、取宿主机环境变量也算；--fix 建好全部标签（镜像的 label 与当前 Containerfile 一致，--fix 才不会去重建）
    // 有页面还要把 e2e 接进门槛（「浏览器 e2e」一项才不警告）：先加 script，再把已生成的配置里 gate 末尾接上
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=\n");
    const pkg = join(root, "package.json");
    const json = JSON.parse(readFileSync(pkg, "utf8")) as { scripts: Record<string, string> };
    json.scripts["test:e2e"] = "playwright test";
    writeFileSync(pkg, JSON.stringify(json));
    const gate = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(gate, readFileSync(gate, "utf8").replace(`&& pnpm test",`, `&& pnpm test && pnpm test:e2e",`));
    const third = await diagnose({
      cwd: root,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      run: runner({ image: true, label: containerfileHash(join(root, ".sandcastle/Containerfile")) }),
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

/** onboard 生成、.env 填好、PROJECT.md 写完（去掉「待补」）、门槛接了 e2e 的项目。 */
function readyRepo() {
  const root = nodeRepo();
  // 有页面的项目门槛要跑 e2e（doctor 有「浏览器 e2e」一项）：加 test:e2e script，installFiles 生成的 gate 会接上
  const pkg = join(root, "package.json");
  const json = JSON.parse(readFileSync(pkg, "utf8")) as { scripts: Record<string, string> };
  json.scripts["test:e2e"] = "playwright test";
  writeFileSync(pkg, JSON.stringify(json));
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

describe("diagnose：--fix 建镜像", () => {
  /** 记录收到的参数的假 build；ok=false 时 out 是多行 stderr。 */
  const fakeBuild = (ok: boolean, out = "Error: registries.conf: invalid TOML\n第二行\n第三行\n第四行\n第五行\n第六行\n") => {
    const calls: string[][] = [];
    return { calls, build: (args: string[]) => (calls.push(args), { ok, out }) };
  };

  it("fix 且镜像缺失：按 Containerfile 建镜像，参数带哈希 label，成功后该项 ok", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), fix: true, build });
    const containerfile = join(root, ".sandcastle/Containerfile");
    expect(calls).toEqual([["build", "-t", defaultImageName(root), "--label", `${IMAGE_LABEL}=${containerfileHash(containerfile)}`, "-f", containerfile, join(root, ".sandcastle")]]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "ok", detail: expect.stringContaining("建好了镜像") });
  });

  it("不带 fix：不调 build，fail 并给带哈希 label 的构建命令", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), build });
    expect(calls).toEqual([]);
    expect(check(checks, "沙箱镜像")).toMatchObject({
      level: "fail",
      detail: expect.stringContaining("没有镜像"),
      fix: expect.stringMatching(/podman build -t \S+ --label sandpipe\.containerfile=[0-9a-f]{64} -f \.sandcastle\/Containerfile \.sandcastle/),
    });
  });

  it("podman 用不了：照旧 fail，不尝试构建", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const run: Runner = (cmd, args) =>
      cmd === "podman" ? { ok: false, out: "Cannot connect to Podman\nmore" } : runner({ image: true })(cmd, args);
    const checks = await diagnose({ cwd: root, env: {}, run, forge: fakeGh(allLabels, []), fix: true, build });
    expect(calls).toEqual([]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "fail", detail: "podman 用不了：Cannot connect to Podman" });
  });

  it("构建失败：fail，detail 给 stderr 的前几行，fix 给构建命令", async () => {
    const root = readyRepo();
    const { build } = fakeBuild(false);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), fix: true, build });
    const c = check(checks, "沙箱镜像");
    expect(c).toMatchObject({ level: "fail" });
    expect(c?.detail).toContain("registries.conf");
    expect(c?.detail).toContain("第五行");
    expect(c?.detail).not.toContain("第六行");
    expect(c?.fix).toMatch(/podman build -t \S+ --label sandpipe\.containerfile=[0-9a-f]{64}/);
  });

  it("配置里自定义了 sandbox：不建镜像", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("export default defineProject({", "export default defineProject({\n  sandbox: () => ({}) as never,"));
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), fix: true, build });
    expect(calls).toEqual([]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "ok", detail: expect.stringContaining("自定义") });
  });

  it("镜像缺失且没有 Containerfile：fix 也不建，照旧提示先跑 onboard", async () => {
    const root = readyRepo();
    rmSync(join(root, ".sandcastle/Containerfile"));
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), fix: true, build });
    expect(calls).toEqual([]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "fail", fix: expect.stringContaining("先跑 onboard") });
  });

  it("镜像在但 label 对不上当前 Containerfile（含没 label）：不带 fix 报 warn，提示 doctor --fix，不构建", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), build });
    const c = check(checks, "沙箱镜像");
    expect(calls).toEqual([]);
    expect(c).toMatchObject({ level: "warn", detail: "Containerfile 改过，镜像过期" });
    expect(c?.fix).toContain("sandpipe doctor --fix");
  });

  it("镜像在且过期：带 fix 按当前 Containerfile 重建，成功后该项 ok（重建了镜像）", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), fix: true, build });
    const containerfile = join(root, ".sandcastle/Containerfile");
    expect(calls).toEqual([["build", "-t", defaultImageName(root), "--label", `${IMAGE_LABEL}=${containerfileHash(containerfile)}`, "-f", containerfile, join(root, ".sandcastle")]]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "ok", detail: expect.stringContaining("重建了镜像") });
  });

  it("镜像在且过期：带 fix 重建失败 fail，detail 给 stderr 前几行、fix 给构建命令", async () => {
    const root = readyRepo();
    const { build } = fakeBuild(false);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), fix: true, build });
    const c = check(checks, "沙箱镜像");
    expect(c).toMatchObject({ level: "fail" });
    expect(c?.detail).toContain("registries.conf");
    expect(c?.fix).toMatch(/podman build -t \S+ --label sandpipe\.containerfile=[0-9a-f]{64}/);
  });

  it("镜像在、label 与当前 Containerfile 一致：照旧 ok", async () => {
    const root = readyRepo();
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({
      cwd: root,
      env: {},
      run: runner({ image: true, label: containerfileHash(join(root, ".sandcastle/Containerfile")) }),
      forge: fakeGh(allLabels, []),
      fix: true,
      build,
    });
    expect(calls).toEqual([]);
    expect(check(checks, "沙箱镜像")).toMatchObject({ level: "ok" });
  });

  it("镜像在且过期（英文项目）：不带 fix 的警告文案是英文", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const { calls, build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), build });
    expect(calls).toEqual([]);
    const c = check(checks, "Sandbox image");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("The Containerfile changed") });
    expect(c?.fix).toContain("sandpipe doctor --fix");
  });

  it("fix 建成功（英文项目）：文案是英文", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const { build } = fakeBuild(true);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: false }), forge: fakeGh(allLabels, []), fix: true, build });
    expect(check(checks, "Sandbox image")).toMatchObject({ level: "ok", detail: expect.stringContaining("built the image") });
  });

  it("cli help 中英写明 --fix 也建缺的镜像", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("[--fix] 缺的标签和镜像直接建上");
    expect(cli).toContain("[--fix] create missing labels and the image");
  });
});

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

describe("diagnose：浏览器 e2e", () => {
  const run = (root: string) => diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
  /** 把 readyRepo 生成的 gate 里的 e2e 命令换掉（replacement 为空即去掉），模拟门槛没跑 e2e / 用别的写法跑。 */
  const gateWithoutE2e = (root: string, replacement = "") => {
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(" && pnpm test:e2e", replacement ? ` && ${replacement}` : ""));
    return root;
  };

  it("有网页界面、门槛没跑 e2e：警告，说明接法并指向 config 文档", async () => {
    expect(check(await run(gateWithoutE2e(readyRepo())), "浏览器 e2e")).toMatchObject({
      level: "warn",
      detail: expect.stringMatching(/浏览器 e2e[\s\S]*gate\.script[\s\S]*gate\.services[\s\S]*docs\/config\.zh-CN\.md/),
    });
  });

  it("门槛脚本里有 playwright：通过", async () => {
    expect(check(await run(gateWithoutE2e(readyRepo(), "pnpm exec playwright test")), "浏览器 e2e")?.level).toBe("ok");
  });

  it("门槛接了探测到的 test:e2e 命令：通过", async () => {
    expect(check(await run(readyRepo()), "浏览器 e2e")?.level).toBe("ok");
  });

  it("没有网页界面：没有这一项", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    expect(check(await run(root), "浏览器 e2e")).toBeUndefined();
  });

  it("gate.script 抛错：跳过这一项，不报错", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/script: \(\) => ".*",/, 'script: () => {\n      throw new Error("配置读不了");\n    },'));
    expect(check(await run(root), "浏览器 e2e")).toBeUndefined();
  });

  it("英文文案：警告说明接法并指向英文 config 文档", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("  autoMerge: false,", "  autoMerge: false,\n  browser: { pagePaths: [/\\.tsx$/] },"));
    // 这个夹具是英文项目，检查项名和文案都是英文
    expect(check(await run(root), "Browser e2e")).toMatchObject({
      level: "warn",
      detail: expect.stringMatching(/browser e2e[\s\S]*gate\.script[\s\S]*gate\.services[\s\S]*docs\/config\.md/),
    });
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
    // nodeRepo 有 drizzle 迁移目录、有网页界面（react）：默认补 Playwright 基准截图目录（#157）
    expect(check(await run(readyRepo()), "受保护路径")).toMatchObject({ level: "ok", detail: "/-snapshots\\//、/^drizzle\\//" });
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

describe("diagnose：磁盘", () => {
  const GB = 1024 ** 3;
  /** 按路径返回剩余字节的假 statfs（bsize 固定 4096）；路径不在表里抛 ENOENT（量不到）。 */
  const statfsWith = (free: Record<string, number>) =>
    (path: string): { bavail: number; bsize: number } => {
      const v = free[path];
      if (v === undefined) throw new Error(`ENOENT: no such file or directory, statfs '${path}'`);
      return { bavail: v / 4096, bsize: 4096 };
    };
  const run = (root: string, statfs: ReturnType<typeof statfsWith>, override?: Runner) =>
    diagnose({ cwd: root, env: {}, run: override ?? runner({ image: true }), forge: fakeGh(allLabels, []), statfs });

  it("工作目录和容器存储各一行：够 ok，detail 写剩余 GB", async () => {
    const root = readyRepo();
    const checks = await run(root, statfsWith({ [root]: 42 * GB, [STORE_PATH]: 6 * GB }));
    expect(check(checks, "磁盘（工作目录）")).toMatchObject({ level: "ok", detail: "剩余 42.0 GB" });
    expect(check(checks, "磁盘（容器存储）")).toMatchObject({ level: "ok", detail: "剩余 6.0 GB" });
  });

  it("低于阈值：fail，detail 写剩余和阈值，fix 给清理命令", async () => {
    const root = readyRepo();
    const checks = await run(root, statfsWith({ [root]: 3.2 * GB, [STORE_PATH]: 6 * GB }));
    const c = check(checks, "磁盘（工作目录）");
    expect(c).toMatchObject({ level: "fail", detail: "剩余 3.2 GB，少于阈值 5 GB" });
    expect(c?.fix).toContain("podman image prune");
    expect(c?.fix).toContain("podman system prune");
    expect(c?.fix).toContain("git worktree prune");
    expect(check(checks, "磁盘（容器存储）")).toMatchObject({ level: "ok" });
  });

  it("量不到（statfs 抛错）：warn，detail 带错误那一句，容器存储的 fix 提示 macOS 的 podman machine", async () => {
    const root = readyRepo();
    const checks = await run(root, statfsWith({ [root]: 6 * GB }));
    const c = check(checks, "磁盘（容器存储）");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("ENOENT") });
    expect(c?.fix).toContain("podman machine");
  });

  it("取不到 GraphRoot（podman info 失败）：容器存储 warn，工作目录照查", async () => {
    const root = readyRepo();
    const noStore: Runner = (cmd, args) =>
      cmd === "podman" && args.includes("{{.Store.GraphRoot}}") ? { ok: false, out: "Cannot connect to Podman" } : runner({ image: true })(cmd, args);
    const checks = await run(root, statfsWith({ [root]: 6 * GB }), noStore);
    expect(check(checks, "磁盘（容器存储）")).toMatchObject({ level: "warn", detail: expect.stringContaining("podman info") });
    expect(check(checks, "磁盘（工作目录）")).toMatchObject({ level: "ok" });
  });

  it("配置里自定义了 sandbox：不查容器存储，工作目录照查", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("export default defineProject({", "export default defineProject({\n  sandbox: () => ({}) as never,"));
    const checks = await run(root, statfsWith({ [root]: 6 * GB }));
    expect(check(checks, "磁盘（工作目录）")).toMatchObject({ level: "ok" });
    expect(check(checks, "磁盘（容器存储）")).toBeUndefined();
  });

  it("preflight.minFreeGb 配了阈值：按配置判", async () => {
    const root = readyRepo();
    const config = join(root, ".sandcastle/sandcastle.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace("export default defineProject({", "export default defineProject({\n  preflight: { minFreeGb: 2 },"));
    const checks = await run(root, statfsWith({ [root]: 3 * GB, [STORE_PATH]: 3 * GB }));
    expect(check(checks, "磁盘（工作目录）")).toMatchObject({ level: "ok", detail: "剩余 3.0 GB" });
    expect(check(checks, "磁盘（容器存储）")).toMatchObject({ level: "ok" });
  });

  it("没给 statfs：整节跳过（不碰真实磁盘）", async () => {
    const checks = await diagnose({ cwd: readyRepo(), env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(checks.filter((c) => c.name.startsWith("磁盘"))).toEqual([]);
  });

  it("低于阈值（英文项目）：行名和文案是英文", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const checks = await run(root, statfsWith({ [root]: 3 * GB, [STORE_PATH]: 6 * GB }));
    expect(check(checks, "Disk (working dir)")).toMatchObject({ level: "fail", detail: "3.0 GB free, below the 5 GB threshold" });
    expect(check(checks, "Disk (container storage)")).toMatchObject({ level: "ok", detail: "6.0 GB free" });
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

describe("diagnose：通知", () => {
  /** 记录每次请求的假 fetch，每次都返回同一个 res / 抛同一个 err（不连网）。 */
  const fakeFetch = (res: Response | Error) => {
    const calls: { url: unknown; init: RequestInit | undefined }[] = [];
    return {
      calls,
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.push({ url, init });
        if (res instanceof Error) throw res;
        return res;
      }) as typeof fetch,
    };
  };
  const WEBHOOK = "https://hooks.example.invalid/secret";
  const withWebhook = (root: string) =>
    writeFileSync(join(root, ".sandcastle/.env"), `GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\nSANDPIPE_NOTIFY_WEBHOOK=${WEBHOOK}\n`);
  /** detail / fix 拼起来不该出现 webhook URL（URL 是凭据）。 */
  const noLeak = (c: Check | undefined) => `${c?.detail ?? ""}\n${c?.fix ?? ""}`;

  it("没配 webhook（.env 和宿主机环境里都没有）：ok「未配置，不发通知」，不发请求", async () => {
    const root = readyRepo();
    const { calls, fetch } = fakeFetch(new Response(null, { status: 200 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch });
    expect(check(checks, "通知")).toMatchObject({ level: "ok", detail: "未配置，不发通知" });
    expect(calls).toEqual([]);
  });

  it("配了 webhook：发一次 HEAD，收到任何 HTTP 响应（如 405）都算连得上", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { calls, fetch } = fakeFetch(new Response(null, { status: 405 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch });
    const c = check(checks, "通知");
    expect(c).toMatchObject({ level: "ok", detail: "连得上" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: WEBHOOK, init: { method: "HEAD" } });
    expect(noLeak(c)).not.toContain(WEBHOOK);
  });

  it("网络错误：warn，detail 只写错误那一句", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { fetch } = fakeFetch(new TypeError("fetch failed"));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch });
    const c = check(checks, "通知");
    expect(c).toMatchObject({ level: "warn", detail: "fetch failed" });
    expect(noLeak(c)).not.toContain(WEBHOOK);
  });

  it("URL 不合法时错误消息里带出 URL：detail 先抹掉", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { fetch } = fakeFetch(new TypeError(`Failed to parse URL from ${WEBHOOK}`));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch });
    const c = check(checks, "通知");
    expect(c).toMatchObject({ level: "warn" });
    expect(c?.detail).toContain("Failed to parse URL");
    expect(noLeak(c)).not.toContain(WEBHOOK);
  });

  it("没给 notifyFetch：跳过这一节", async () => {
    const root = readyRepo();
    withWebhook(root);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []) });
    expect(check(checks, "通知")).toBeUndefined();
  });

  it("没配 webhook（英文项目）：文案是英文", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const { calls, fetch } = fakeFetch(new Response(null, { status: 200 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch });
    expect(check(checks, "Notify")).toMatchObject({ level: "ok", detail: "not configured, no notifications" });
    expect(calls).toEqual([]);
  });

  it("--notify-test：用 notifier 发一条 test 消息，2xx 为 ok", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { calls, fetch } = fakeFetch(new Response("{}", { status: 200 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch, notifyTest: true });
    const c = check(checks, "通知");
    expect(c).toMatchObject({ level: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.event).toBe("test");
    expect(body.reason).toContain("doctor");
    expect(body.text).toContain("测试消息");
    expect(noLeak(c)).not.toContain(WEBHOOK);
  });

  it("--notify-test 非 2xx：warn，detail 写状态码", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { calls, fetch } = fakeFetch(new Response("nope", { status: 500 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch, notifyTest: true });
    const c = check(checks, "通知");
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("500") });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(noLeak(c)).not.toContain(WEBHOOK);
  });

  it("--notify-test 配 --fix：不发测试消息，只做 HEAD 连通检查", async () => {
    const root = readyRepo();
    withWebhook(root);
    const { calls, fetch } = fakeFetch(new Response(null, { status: 200 }));
    // fix: true 而 readyRepo 的镜像 label 对不上哈希，会走重建：注入假 build，别碰宿主机的 podman（CI 上有 podman 会真建）
    // fix: true with readyRepo's image label not matching the hash triggers a rebuild: inject a fake build so the host's podman is untouched (CI has podman and would really build)
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch, notifyTest: true, fix: true, build: () => ({ ok: true, out: "" }) });
    expect(check(checks, "通知")).toMatchObject({ level: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("HEAD");
  });

  it("--notify-test（英文项目）：test 消息的文案是英文", async () => {
    const root = pythonRepo();
    installFiles(root, detectProject(root));
    withWebhook(root);
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "");
    const { calls, fetch } = fakeFetch(new Response("{}", { status: 200 }));
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(allLabels, []), notifyFetch: fetch, notifyTest: true });
    expect(check(checks, "Notify")).toMatchObject({ level: "ok" });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.event).toBe("test");
    expect(body.reason).toContain("doctor");
    expect(body.text).toContain("test message");
  });

  it("cli help 中英写明 --notify-test", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("[--notify-test] 发一条测试通知");
    expect(cli).toContain("[--notify-test] send a test notification");
  });
});

describe("diagnose 的出错分支", () => {
  it("准备好的项目全部通过", async () => {
    const root = readyRepo();
    // 镜像是按当前 Containerfile 建的（label 记的哈希一致），沙箱镜像一项才不报过期
    const checks = await diagnose({
      cwd: root,
      env: {},
      run: runner({ image: true, label: containerfileHash(join(root, ".sandcastle/Containerfile")) }),
      forge: fakeGh(allLabels, []),
    });
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

  it("只缺 sandcastle:waiting-main（用到时自动建）：通过", async () => {
    const root = readyRepo();
    const labels = allLabels.filter((l) => l !== DEFAULT_LABELS.waitingMain);
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(labels, []) });
    const labelCheck = check(checks, "标签");
    expect(labelCheck?.level).toBe("ok");
    expect(labelCheck?.detail).toMatch(/用到时自动建/);
    expect(labelCheck?.detail).toContain("sandcastle:waiting-main");
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
