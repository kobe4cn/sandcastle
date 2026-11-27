// onboard：探测项目事实、生成配置与 PROJECT.md 草稿、登记 hook。生成的文件要能被流水线直接加载。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectProject, parseRemoteUrl } from "../src/detect.ts";
import { agentDoneLine, agentFailureMessage, agentStartHint, agentWritable, applyLangArg, assertRepoRoot, configSource, containerfileSource, detectSummary, envStepHint, filesSummary, hasGlobalSkill, installFiles, installGlobalSkill, outputCollector, prefixLines, staleGlobalSkillFiles, projectDocDraft, mergeGitignore, mergeSettings, onboard, onboardPrompt, questionsOnlyPrecheck, questionsPrompt, TYPES_ENTRY, updateClaudeFiles, validationSummary } from "../src/onboard.ts";
import { loadProject } from "../src/profile.ts";
import { OPEN_QUESTIONS } from "../src/open-questions.ts";
import { setTermLanguage } from "../src/term.ts";
import { parseProjectDoc, SECTIONS, SECTIONS_EN } from "../src/project-doc.ts";
import { nodeRepo, pythonRepo } from "./fixtures.ts";

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
      packageManagerSpec: "pnpm@10.4.1",
      install: "pnpm install --frozen-lockfile",
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

  it("扫 env 文件里指向本机的变量：多个库、各种中间件都算，数据库类的要加后缀，其他变量不碰", () => {
    const root = nodeRepo();
    writeFileSync(
      join(root, ".env.example"),
      [
        "DATABASE_URL=postgres://u:p@localhost:5432/app",
        "ANALYTICS_DATABASE_URL=postgresql+asyncpg://u:p@127.0.0.1:5433/analytics",
        "MONGO_URL=mongodb://localhost:27017/crm",
        "REDIS_URL=redis://localhost:6379/0",
        "KAFKA_BROKERS=localhost:9092",
        "S3_ENDPOINT=http://localhost:9000",
        "REPORT_DB_HOST=localhost",
        "REPORT_DB_NAME=report",
        "REDIS_DB=0",
        "STRIPE_KEY=sk_test",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:p@localhost:5432/app\nES_URL=http://localhost:9200\n");
    const f = detectProject(root);
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
    expect([...f.serviceEnv].sort(byKey)).toEqual([
      { key: "DATABASE_URL", perTicketDb: true },
      { key: "ANALYTICS_DATABASE_URL", perTicketDb: true },
      { key: "MONGO_URL", perTicketDb: true },
      { key: "REDIS_URL", perTicketDb: false },
      { key: "KAFKA_BROKERS", perTicketDb: false },
      { key: "S3_ENDPOINT", perTicketDb: false },
      { key: "REPORT_DB_HOST", perTicketDb: false },
      { key: "REPORT_DB_NAME", perTicketDb: true },
      { key: "ES_URL", perTicketDb: false },
    ].sort(byKey));
    expect(f.serviceEnvFrom).toEqual([".env.example", ".env"]);
    expect(detectProject(nodeRepo())).toMatchObject({ serviceEnv: [], serviceEnvFrom: [] });
  });

  it("pagePaths 按前端框架给默认值；没有网页界面的项目为空", () => {
    const withDeps = (deps: Record<string, string>) => {
      const root = nodeRepo();
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", dependencies: deps }));
      return detectProject(root).pagePaths;
    };
    expect(withDeps({ react: "19", next: "15" })).toEqual(["^(app|pages|components|src/(app|pages|components))/"]);
    expect(withDeps({ react: "19", "@remix-run/node": "2" })).toEqual(["^app/(routes|components)/"]);
    expect(withDeps({ react: "19", "react-router": "7" })).toEqual(["^app/(routes|components)/"]);
    expect(withDeps({ vue: "3", nuxt: "3" })).toEqual(["^(pages|components|layouts)/|^src/(pages|components|views)/"]);
    expect(withDeps({ vue: "3" })).toEqual(["^(pages|components|layouts)/|^src/(pages|components|views)/"]);
    expect(withDeps({ svelte: "5", "@sveltejs/kit": "2" })).toEqual(["^src/(routes|lib)/"]);
    expect(withDeps({ svelte: "5" })).toEqual(["^src/(routes|lib)/"]);
    expect(withDeps({ astro: "5" })).toEqual(["^src/(pages|components|layouts)/"]);
    expect(withDeps({ react: "19" })).toEqual(["^src/.*\\.(tsx|jsx|vue|svelte|css)$"]);
    expect(withDeps({ express: "5" })).toEqual([]);
    expect(detectProject(pythonRepo()).pagePaths).toEqual([]);
  });

  it("protectedPaths 按探测结果给：快照、Playwright 快照、CI workflow、迁移目录；都没有时为空", () => {
    const add = (root: string, files: Record<string, string>) => {
      for (const [f, s] of Object.entries(files)) {
        mkdirSync(join(root, f, ".."), { recursive: true });
        writeFileSync(join(root, f), s);
      }
      execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
      return detectProject(root).protectedPaths;
    };
    // nodeRepo 有 drizzle 迁移目录
    expect(detectProject(nodeRepo()).protectedPaths).toEqual(["^drizzle/"]);
    expect(detectProject(pythonRepo()).protectedPaths).toEqual([]);
    expect(add(pythonRepo(), { ".github/workflows/ci.yml": "", "src/__snapshots__/a.test.ts.snap": "", "e2e/cart.spec.ts-snapshots/cart.png": "" })).toEqual([
      "(^|/)__snapshots__/",
      "\\.snap$",
      "-snapshots/",
      "^\\.github/workflows/",
    ]);
    // 只有 .snap 文件（不在 __snapshots__ 下）也算
    expect(add(pythonRepo(), { "tests/x.snap": "" })).toEqual(["(^|/)__snapshots__/", "\\.snap$"]);
    // 迁移目录按探测到的 dir 写成 ^<dir>/
    const root = pythonRepo();
    mkdirSync(join(root, "alembic/versions"), { recursive: true });
    expect(detectProject(root).protectedPaths).toEqual(["^alembic/versions/"]);
    const prisma = nodeRepo();
    writeFileSync(join(prisma, "package.json"), JSON.stringify({ name: "shop", dependencies: { prisma: "6" } }));
    mkdirSync(join(prisma, "prisma/migrations"), { recursive: true });
    expect(detectProject(prisma).protectedPaths).toEqual(["^prisma/migrations/"]);
    // 不是 git 仓库：快照查不了，不写；目录类的照常
    const plain = mkdtempSync(join(tmpdir(), "sc-plain-"));
    mkdirSync(join(plain, ".github/workflows"), { recursive: true });
    mkdirSync(join(plain, "src/__snapshots__"), { recursive: true });
    writeFileSync(join(plain, "src/__snapshots__/a.snap"), "");
    expect(detectProject(plain).protectedPaths).toEqual(["^\\.github/workflows/"]);
  });

  it("有 GLOSSARY.md 的仓库，文档列表里有它", () => {
    const root = nodeRepo();
    writeFileSync(join(root, "GLOSSARY.md"), "# 术语表\n");
    expect(detectProject(root).docs).toContain("GLOSSARY.md");
  });

  it("python + uv：mypy 配了 files 就不加 .，英文提交，没有服务和网页", () => {
    const f = detectProject(pythonRepo());
    expect(f).toMatchObject({
      language: "python",
      install: "uv sync",
      commands: { typecheck: "uv run mypy", lint: "uv run ruff check .", test: "uv run pytest" },
      services: [],
      webUi: false,
      commitLanguage: "en",
    });
    expect(detectProject(pythonRepo('[project]\nname = "x"\n[tool.ruff]\n[dependency-groups]\ndev = ["mypy"]\n')).commands.typecheck).toBe("uv run mypy .");
  });
});

describe("提交语言：提交太少时的推断", () => {
  const zhReadme = `# 账本\n\n${"这是一个记账工具，给小团队记录日常开支并按月出报表。".repeat(10)}\n`;
  const commitMany = (root: string, n: number) => {
    for (let i = 0; i < n; i++)
      execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", `Add feature ${i}`], { stdio: "ignore" });
  };

  it("提交少于 5 条、文档是中文：按文档定为中文，草稿注明是推断的", () => {
    const root = pythonRepo();
    writeFileSync(join(root, "README.md"), zhReadme);
    const f = detectProject(root);
    expect(f).toMatchObject({ commitLanguage: "zh", commitLanguageBasis: "docs" });
    const commit = parseProjectDoc(projectDocDraft(f, "zh")).commit;
    expect(commit).toContain("中文");
    expect(commit).toContain("只有 1 条");
    expect(commit).toContain("项目文档");
    const en = projectDocDraft(f, "en");
    expect(en).not.toMatch(/[一-鿿]/);
    expect(parseProjectDoc(en).commit).toContain("only 1 commit; the commit language was inferred from the project docs");
  });

  it("提交少于 5 条、文档文字不够：仍按那几条提交，标为 few-commits", () => {
    const f = detectProject(nodeRepo());
    expect(f).toMatchObject({ commitLanguage: "zh", commitLanguageBasis: "few-commits" });
    expect(parseProjectDoc(projectDocDraft(f, "zh")).commit).toContain("可能不准");
    // 一条提交都没有：不说「按这几条推断」 / No commits at all: don't claim it was inferred from them
    const none = { ...f, recentCommits: [], commitLanguage: "en" as const };
    expect(parseProjectDoc(projectDocDraft(none, "zh")).commit).toContain("还没有提交，提交语言没法判断");
    expect(parseProjectDoc(projectDocDraft(none, "en")).commit).toContain("There are no commits yet, so the commit language couldn't be judged");
  });

  it("提交 ≥5 条：照旧按提交判断，草稿里没有推断说明", () => {
    const root = pythonRepo();
    writeFileSync(join(root, "README.md"), zhReadme);
    commitMany(root, 4);
    const f = detectProject(root);
    expect(f).toMatchObject({ commitLanguage: "en", commitLanguageBasis: "commits" });
    expect(parseProjectDoc(projectDocDraft(f, "zh")).commit).not.toContain("推断");
    // 提交够多时 --lang 不改提交语言 / With enough commits --lang doesn't change the commit language
    expect(applyLangArg(f, "zh")).toMatchObject({ commitLanguage: "en", commitLanguageBasis: "commits" });
  });

  it("--lang 在提交不足时优先：basis 改成 lang，草稿跟着 --lang", () => {
    const root = pythonRepo();
    writeFileSync(join(root, "README.md"), zhReadme);
    const f = applyLangArg(detectProject(root), "en");
    expect(f).toMatchObject({ commitLanguage: "en", commitLanguageBasis: "lang" });
    const commit = parseProjectDoc(projectDocDraft(f, "en")).commit;
    expect(commit).toContain("English");
    expect(commit).toContain("inferred from `--lang`");
    expect(applyLangArg(detectProject(root), undefined)).toMatchObject({ commitLanguage: "zh", commitLanguageBasis: "docs" });
  });
});

describe("installFiles", () => {
  it("生成的配置能被流水线加载，PROJECT.md 草稿能通过校验；再跑一次什么都不覆盖", async () => {
    const root = nodeRepo();
    const f = detectProject(root);
    const first = installFiles(root, f);
    expect(first.every((o) => o.status === "written")).toBe(true);

    const project = await loadProject(join(root, ".sandcastle"));
    expect(project.install.onSandboxReady).toBe(f.install);
    expect(project.gate.script({ baseRef: "origin/main" })).toBe("pnpm typecheck && pnpm lint && pnpm test");
    expect(project.gate.testFile.test("test/a.test.ts")).toBe(true);
    // 探测到 postgres + redis：从项目根 .env 读连接串，换成容器能访问的主机，库名加 _i<runId>；没有 .env 时只有 runId
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(project.isolation.env("12")).toEqual({ SANDCASTLE_RUN_ID: "12" });
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:p@localhost:5432/app\nREDIS_URL=redis://127.0.0.1:6379\n");
      expect(project.isolation.env("12")).toEqual({
        SANDCASTLE_RUN_ID: "12",
        DATABASE_URL: "postgres://u:p@host.containers.internal:5432/app_i12",
        REDIS_URL: "redis://host.containers.internal:6379",
      });
    } finally {
      cwd.mockRestore();
    }
    // 新项目试跑期：只开 PR 不合并、一次一张（docs/onboarding-checklist.md）
    expect(project).toMatchObject({ autoMerge: false, maxParallel: 1, language: f.commitLanguage });

    expect(JSON.parse(readFileSync(join(root, ".sandcastle/package.json"), "utf8"))).toEqual({ type: "module" });

    const doc = parseProjectDoc(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8"));
    expect(doc.commands).toContain("`pnpm typecheck`");
    expect(doc.conflicts).toContain("drizzle-kit");
    expect(doc.commit).toContain("中文");

    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    const second = installFiles(root, f);
    expect(second.filter((o) => o.status === "written")).toEqual([]);
    expect(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8")).toBe("人改过");
  });
});

describe("configSource", () => {
  it("没探测到服务：import 行和 isolation 区块不变，不读宿主机 .env", () => {
    const src = configSource({ ...detectProject(nodeRepo()), services: [] }, "sandpipe");
    expect(src).toContain('import { defineProject } from "sandpipe";');
    expect(src).not.toContain("readHostEnv");
    expect(src).toContain(
      [
        "  isolation: {",
        "    env: (runId) => ({",
        "      // 测试依赖外部服务（数据库、缓存、对象存储）时，在这里给每张票独立的库名 / 前缀（加 runId）。",
        "      // If tests use external services (database, cache, object storage), give each ticket its own database name / prefix here (add runId).",
        "      SANDCASTLE_RUN_ID: runId,",
        "    }),",
        "    // cleanup: async (runId) => { /* 关沙箱后删掉这张票的测试库 */ },",
        "    // cleanup: async (runId) => { /* drop this ticket's test database after the sandbox closes */ },",
        "  },",
      ].join("\n"),
    );
  });

  it("env 文件里没扫到：按服务猜键名，惯例键名撞了改用 <服务>_URL，不丢服务；只给数据库加后缀", () => {
    const src = configSource({ ...detectProject(nodeRepo()), services: ["postgres", "mysql", "redis"] }, "sandpipe");
    expect(src).toContain('import { defineProject, readHostEnv, toContainerHost, withDbSuffix } from "sandpipe";');
    expect(src).toContain("if (host.DATABASE_URL) env.DATABASE_URL = withDbSuffix(toContainerHost(host.DATABASE_URL), suffix);");
    expect(src).toContain("if (host.MYSQL_URL) env.MYSQL_URL = withDbSuffix(toContainerHost(host.MYSQL_URL), suffix);");
    expect(src).toContain("if (host.REDIS_URL) env.REDIS_URL = toContainerHost(host.REDIS_URL);");
    expect(src).toContain("runHostScript");
  });

  it("有网页界面：写 browser.pagePaths，加载后是能匹配页面文件的正则；没有网页界面不写", async () => {
    const root = nodeRepo(); // 依赖有 react、没有更具体的框架：走 src/ 下 tsx 等的兜底
    const f = detectProject(root);
    const src = configSource(f, "sandpipe");
    expect(src).toContain("  browser: { pagePaths: [/^src\\/.*\\.(tsx|jsx|vue|svelte|css)$/] },");
    expect(src).toContain("// Page file paths");
    expect(src).toContain("// 页面文件的路径");
    installFiles(root, f);
    const project = await loadProject(join(root, ".sandcastle"));
    expect(project.browser.pagePaths).toHaveLength(1);
    expect(project.browser.pagePaths[0]).toBeInstanceOf(RegExp);
    expect(project.browser.pagePaths[0].test("src/ui/Cart.tsx")).toBe(true);
    expect(project.browser.pagePaths[0].test("src/db/cart.ts")).toBe(false);
    const nextSrc = configSource({ ...f, pagePaths: ["^(app|pages|components|src/(app|pages|components))/"] }, "sandpipe");
    expect(nextSrc).toContain("pagePaths: [/^(app|pages|components|src\\/(app|pages|components))\\//]");
    expect(configSource(detectProject(pythonRepo()), "sandpipe")).not.toContain("pagePaths");
  });

  it("探测到受保护路径：写 protectedPaths，加载后的正则能匹配对应文件；为空不写", async () => {
    const root = nodeRepo();
    const f = { ...detectProject(root), protectedPaths: ["(^|/)__snapshots__/", "\\.snap$", "-snapshots/", "^\\.github/workflows/", "^drizzle/"] };
    const src = configSource(f, "sandpipe");
    expect(src).toContain("  protectedPaths: [/(^|\\/)__snapshots__\\//, /\\.snap$/, /-snapshots\\//, /^\\.github\\/workflows\\//, /^drizzle\\//],");
    expect(src).toContain("// Protected paths");
    expect(src).toContain("// 受保护路径");
    installFiles(root, f);
    const project = await loadProject(join(root, ".sandcastle"));
    const hit = (file: string) => project.protectedPaths.some((re) => re.test(file));
    expect(project.protectedPaths).toHaveLength(5);
    for (const file of ["src/__snapshots__/a.test.ts.snap", "__snapshots__/x", "tests/x.snap", "e2e/cart.spec.ts-snapshots/cart.png", ".github/workflows/ci.yml", "drizzle/0001_x/migration.sql"])
      expect(hit(file), file).toBe(true);
    for (const file of ["src/cart.ts", "github/workflows/x.yml", "src/drizzle/x.ts", "snapshots/a.txt"]) expect(hit(file), file).toBe(false);
    expect(configSource(detectProject(pythonRepo()), "sandpipe")).not.toContain("protectedPaths");
  });

  it("env 文件里有多个库和中间件：生成的配置逐个换主机，数据库各自加 _i<runId>", async () => {
    const root = nodeRepo();
    writeFileSync(
      join(root, ".env.example"),
      "DATABASE_URL=postgres://u:p@localhost:5432/app\nANALYTICS_DB_URL=mysql://u:p@localhost:3306/stats\nKAFKA_BROKERS=localhost:9092\nSTRIPE_KEY=x\n",
    );
    const f = detectProject(root);
    const src = configSource(f, "sandpipe");
    expect(src).toContain(".env.example");
    expect(src).not.toContain("REDIS_URL");
    installFiles(root, f);
    const project = await loadProject(join(root, ".sandcastle"));
    writeFileSync(
      join(root, ".env"),
      "DATABASE_URL=postgres://u:p@localhost:5432/app\nANALYTICS_DB_URL=mysql://u:p@127.0.0.1:3306/stats\nKAFKA_BROKERS=localhost:9092\nSTRIPE_KEY=x\n",
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(project.isolation.env("7")).toEqual({
        SANDCASTLE_RUN_ID: "7",
        DATABASE_URL: "postgres://u:p@host.containers.internal:5432/app_i7",
        ANALYTICS_DB_URL: "mysql://u:p@host.containers.internal:3306/stats_i7",
        KAFKA_BROKERS: "host.containers.internal:9092",
      });
    } finally {
      cwd.mockRestore();
    }
  });
});

const overwrite = async () => "overwrite" as const;

describe("updateClaudeFiles", () => {
  it("改过的 CLAUDE_FILES 按选择处理：选另存时不算改动、留下 .new；tsconfig 照旧直接刷新", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const skill = join(root, ".claude/skills/prep-ticket/SKILL.md");
    const original = readFileSync(skill, "utf8");
    writeFileSync(skill, "旧版");
    rmSync(join(root, ".sandcastle/tsconfig.json"));
    const asked: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await updateClaudeFiles(root, async (file) => {
        asked.push(file);
        return "new";
      }),
    ).toEqual([".sandcastle/tsconfig.json"]);
    expect(warn.mock.calls.flat().join("\n")).toContain(".claude/skills/prep-ticket/SKILL.md.new");
    warn.mockRestore();
    expect(asked).toEqual([".claude/skills/prep-ticket/SKILL.md"]);
    expect(readFileSync(skill, "utf8")).toBe("旧版");
    expect(readFileSync(`${skill}.new`, "utf8")).toBe(original);
  });

  it("onboard 遇到已存在且不同的 CLAUDE_FILES 会询问；相同的不问；.sandcastle/ 下的照旧跳过", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const agent = join(root, ".claude/agents/screenshot-checker.md");
    writeFileSync(agent, "旧版");
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    const asked: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await onboard(["--no-agent", "--verbose"], root, async (file) => {
      asked.push(file);
      return "keep";
    });
    const out = log.mock.calls.flat().join("\n");
    log.mockRestore();
    warn.mockRestore();
    expect(asked).toEqual([".claude/agents/screenshot-checker.md"]);
    expect(readFileSync(agent, "utf8")).toBe("旧版");
    expect(existsSync(`${agent}.new`)).toBe(false);
    expect(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8")).toBe("人改过");
    expect(out).toMatch(/· \.claude\/agents\/screenshot-checker\.md：已存在，保留|· \.claude\/agents\/screenshot-checker\.md: kept existing/);
  });

  it("onboard 装上 prep-ticket skill；update 只覆盖改过的，再跑没有改动；不碰 .sandcastle/", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const skill = join(root, ".claude/skills/prep-ticket/SKILL.md");
    const original = readFileSync(skill, "utf8");
    expect(original).toContain("prep-ticket");
    // 拆票规则跟着装上，标签名已填好
    const sizing = readFileSync(join(root, ".claude/skills/prep-ticket/ticket-sizing.md"), "utf8");
    expect(sizing).toContain("ready-for-agent");
    expect(sizing).not.toMatch(/\{\{/);
    writeFileSync(skill, "旧版");
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    expect(await updateClaudeFiles(root, overwrite)).toEqual([".claude/skills/prep-ticket/SKILL.md"]);
    expect(readFileSync(skill, "utf8")).toBe(original);
    expect(await updateClaudeFiles(root, overwrite)).toEqual([]);
    expect(readFileSync(join(root, ".sandcastle/PROJECT.md"), "utf8")).toBe("人改过");
  });

  it("onboard 装上 fill-project-docs skill 和 NOTICE；update 只覆盖改过的，再跑没有改动", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const skill = join(root, ".claude/skills/fill-project-docs/SKILL.md");
    const original = readFileSync(skill, "utf8");
    expect(original).toContain("name: fill-project-docs");
    const notice = readFileSync(join(root, ".claude/skills/fill-project-docs/NOTICE"), "utf8");
    expect(notice).toContain("Matt Pocock");
    expect(notice).toContain("MIT");
    writeFileSync(skill, "旧版");
    expect(await updateClaudeFiles(root, overwrite)).toEqual([".claude/skills/fill-project-docs/SKILL.md"]);
    expect(readFileSync(skill, "utf8")).toBe(original);
    expect(await updateClaudeFiles(root, overwrite)).toEqual([]);
  });

  it("fill-project-docs：description 写明何时用，正文涵盖清单、答案写到哪和自检", () => {
    const skill = readFileSync(new URL("../claude/skills/fill-project-docs/SKILL.md", import.meta.url), "utf8");
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? "";
    expect(description).toMatch(/onboard/);
    expect(description).toMatch(/doctor/);
    for (const s of ["OPEN-QUESTIONS", "GLOSSARY.md", "CONTEXT.md", "ADR", "必须停下", "Stop and ask", "领域与文档", "Domain and docs", "sandpipe doctor"]) {
      expect(skill).toContain(s);
    }
    // 不能有标签占位符：toolFile 会替换它
    expect(skill).not.toMatch(/\{\{L_/);
  });
});

describe("全局 prep-ticket skill", () => {
  it("sandpipe skill 装到 ~/.claude/skills/：标签已填、带拆票规则；再装没有改动；改过的会被刷回", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(hasGlobalSkill(claudeDir)).toBe(false);
    expect(installGlobalSkill(claudeDir)).toHaveLength(2);
    expect(hasGlobalSkill(claudeDir)).toBe(true);
    const skill = readFileSync(join(claudeDir, "skills/prep-ticket/SKILL.md"), "utf8");
    expect(skill).toContain("ready-for-agent");
    expect(skill).not.toMatch(/\{\{/);
    expect(existsSync(join(claudeDir, "skills/prep-ticket/ticket-sizing.md"))).toBe(true);
    expect(installGlobalSkill(claudeDir)).toEqual([]);
    writeFileSync(join(claudeDir, "skills/prep-ticket/SKILL.md"), "旧版");
    expect(staleGlobalSkillFiles(claudeDir)).toEqual([join(claudeDir, "skills/prep-ticket/SKILL.md")]);
    expect(installGlobalSkill(claudeDir)).toEqual([join(claudeDir, "skills/prep-ticket/SKILL.md")]);
    expect(readFileSync(join(claudeDir, "skills/prep-ticket/SKILL.md"), "utf8")).toBe(skill);
    rmSync(claudeDir, { recursive: true });
  });

  it("没接 sandcastle 的仓库也能用：没有 PROJECT.md 时退到 CLAUDE.md / AGENTS.md / README，标签名会看项目配置", () => {
    const skill = readFileSync(new URL("../claude/skills/prep-ticket/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/If `\.sandcastle\/PROJECT\.md` exists/);
    expect(skill).toMatch(/CLAUDE\.md`, `AGENTS\.md`, `README\.md`/);
    expect(skill).toContain("labels.readyForAgent");
    // 标签名只在一处出现（占位符），其余都说「ready label」，项目改了标签名也不会漏
    expect(skill.match(/ready-for-agent|\{\{L_READY_FOR_AGENT\}\}/g)).toHaveLength(1);
  });

  it("Blocked by 的写法：一个 blocker 一行列表项，列表项外的票号不算（#100）", () => {
    const skill = readFileSync(new URL("../claude/skills/prep-ticket/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("one list item per blocker (`- #n`)");
    expect(skill).toContain("issue numbers outside list items (prose, continuation lines) don't count");
  });
});

describe("编辑器类型", () => {
  it("onboard 写 .sandcastle/tsconfig.json（paths 指向本工具的声明文件）并忽略它；老项目由 update 补上", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const tsconfigPath = join(root, ".sandcastle/tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    expect(tsconfig.compilerOptions.paths).toEqual({ sandpipe: [TYPES_ENTRY] });
    expect(tsconfig.compilerOptions.types).toBeUndefined();
    const ignorePath = join(root, ".sandcastle/.gitignore");
    expect(readFileSync(ignorePath, "utf8").split("\n")).toContain("tsconfig.json");

    // 老项目：没有 tsconfig.json，.gitignore 是旧模板
    rmSync(tsconfigPath);
    writeFileSync(ignorePath, ".env\nlogs/\nworktrees/\n");
    expect(await updateClaudeFiles(root, overwrite)).toEqual([".sandcastle/.gitignore", ".sandcastle/tsconfig.json"]);
    expect(readFileSync(ignorePath, "utf8")).toMatch(/^\.env\nlogs\/\nworktrees\/\n\n# Sandcastle：.*\n# Sandcastle: .*\ntsconfig\.json\n$/);
    expect(await updateClaudeFiles(root, overwrite)).toEqual([]);
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
    expect(out).toMatch(/^node_modules\n\/\.browser-check\n\n# Sandcastle：.*\n# Sandcastle: .*\n\.playwright-cli\/\n\.pr-notes\/\n$/);
    expect(mergeGitignore(out)).toBeUndefined();
    expect(mergeGitignore("")).toContain(".browser-check/");
  });
});

describe("containerfileSource", () => {
  it("所有项目都装 playwright-cli + Chromium（没有网页界面也装）；python 加工具链", () => {
    const base = detectProject(nodeRepo());
    const node = containerfileSource(containerTemplate, base);
    expect(node).toContain("playwright");
    // pnpm 装进镜像，而且在切到 agent 用户之前（全局装要 root）
    expect(node.indexOf("RUN npm install -g pnpm@10.4.1")).toBeGreaterThan(-1);
    expect(node.indexOf("RUN npm install -g pnpm@10.4.1")).toBeLessThan(node.indexOf("USER "));
    const py = containerfileSource(containerTemplate, { ...base, webUi: false, language: "python", packageManagerSpec: undefined });
    expect(py).toContain("playwright");
    expect(py).toContain("python3-venv");
    expect(py).toContain("ENTRYPOINT");
    expect(py).not.toContain("pnpm");
  });
});

describe("非网页项目也默认装好浏览器验收的产物", () => {
  it("Containerfile 含 playwright，.gitignore 有工作目录，screenshot-checker 子代理装上", () => {
    const root = pythonRepo();
    const f = detectProject(root);
    expect(f.webUi).toBe(false);
    installFiles(root, f);
    expect(readFileSync(join(root, ".sandcastle/Containerfile"), "utf8")).toContain("playwright");
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    for (const d of [".browser-check/", ".playwright-cli/", ".pr-notes/"]) expect(ignore).toContain(d);
    expect(existsSync(join(root, ".claude/agents/screenshot-checker.md"))).toBe(true);
  });
});

describe("browserHints", () => {
  it("找出提到浏览器验收的文档、旧 .sandcastle 提示词和 scripts/ 里建数据的脚本", () => {
    const root = nodeRepo();
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test/README.md"), "## 浏览器验收（ego-browser）\n先跑 scripts/browser-lab.ts\n");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/browser-lab.ts"), "");
    writeFileSync(join(root, "scripts/build.ts"), "");
    mkdirSync(join(root, ".sandcastle"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/implement-prompt.md"), "起 dev server，用 playwright 登录");
    const hints = detectProject(root).browserHints;
    expect(hints).toEqual(expect.arrayContaining(["test/README.md", "scripts/browser-lab.ts", ".sandcastle/implement-prompt.md"]));
    expect(hints).not.toContain("scripts/build.ts");
  });
});

describe("onboardPrompt", () => {
  it("给 agent 的示例 PROJECT.md 能通过校验", () => {
    const example = readFileSync(new URL("../templates/example-PROJECT.md", import.meta.url), "utf8");
    expect(parseProjectDoc(example).hasBrowser).toBe(true);
  });

  it("浏览器验收是必经的一步：先读已有资料，拼不全就把具体问题写进缺口清单", () => {
    const p = onboardPrompt(detectProject(nodeRepo()));
    expect(p).toContain("先读项目已有资料");
    expect(p).toContain("browserHints");
    expect(p).toContain("ego-browser");
    expect(p).toContain("换成沙箱里的 `playwright-cli`");
    expect(p).toContain("dev server 启动命令与端口");
    expect(p).toContain("PROJECT.md「浏览器验收」");
    expect(onboardPrompt(detectProject(pythonRepo()), "en")).toContain("PROJECT.md「Browser check」");
  });

  it("事实、模板、示例都填进去，没有残留占位符", () => {
    const p = onboardPrompt(detectProject(nodeRepo()));
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).toContain('"packageManager": "pnpm"');
    expect(p).toContain("shop-admin");
  });

  it("默认允许写缺口清单，并写明格式；清单不在可写列表里时要求不要动它", () => {
    const f = detectProject(nodeRepo());
    const p = onboardPrompt(f);
    expect(p).toContain("OPEN-QUESTIONS.md");
    expect(p).toContain("→");
    expect(p).toContain("[意图]");
    expect(p).not.toContain("需要人确认");
    expect(p).not.toContain("待补");
    const only = onboardPrompt(f, "zh", [".sandcastle/PROJECT.md"]);
    expect(only).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(only).toContain("不要动它");
    expect(only).not.toContain("[意图]");
  });

  it("英文变体：清单类别用 [convention] / [intent]，没有残留占位符", () => {
    const p = onboardPrompt(detectProject(pythonRepo()), "en");
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).toContain("[intent]");
    expect(p).toContain("[convention]");
    expect(p).toContain("# Open questions");
  });

  it("agentWritable：清单已存在时只给 PROJECT.md", () => {
    const root = nodeRepo();
    expect(agentWritable(root)).toEqual([".sandcastle/PROJECT.md", ".sandcastle/OPEN-QUESTIONS.md"]);
    mkdirSync(join(root, ".sandcastle"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "# 缺口清单\n");
    expect(agentWritable(root)).toEqual([".sandcastle/PROJECT.md"]);
  });
});

describe("questionsPrompt / --questions-only", () => {
  const projectMd = "## 概况\n\n独有的标记 shop-marker-42\n";
  const files = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.name === ".git" || e.name === "node_modules") continue;
        if (e.isDirectory()) walk(rel);
        else out.push(`${rel}:${readFileSync(join(root, rel), "utf8")}`);
      }
    };
    walk("");
    return out.sort();
  };

  it("中文：有现有 PROJECT.md 和清单路径，只许写清单，没有残留占位符", () => {
    const p = questionsPrompt(detectProject(nodeRepo()), "zh", projectMd);
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).toContain("shop-marker-42");
    expect(p).toContain('"packageManager": "pnpm"');
    expect(p).toContain("`.sandcastle/OPEN-QUESTIONS.md`");
    expect(p).not.toContain("`.sandcastle/PROJECT.md`、");
    expect(p).not.toContain("用 Write 写 `.sandcastle/PROJECT.md`");
    expect(p).toContain("[意图]");
    expect(p).not.toContain("需要人确认");
  });

  it("缺口清单提示词：有网页界面却没有浏览器验收时必须列出具体问题", () => {
    const p = questionsPrompt(detectProject(nodeRepo()), "zh", projectMd);
    expect(p).toContain("browserHints");
    for (const q of ["dev server 的启动命令与端口", "验收数据怎么建", "登录方式与账号", "dev server 需要的环境变量"]) expect(p).toContain(q);
    expect(p).toContain("PROJECT.md「浏览器验收」");
  });

  it("英文：清单类别用 [convention] / [intent]，没有残留占位符", () => {
    const p = questionsPrompt(detectProject(pythonRepo()), "en", projectMd);
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).toContain("shop-marker-42");
    expect(p).toContain("[intent]");
    expect(p).toContain("# Open questions");
  });

  it("「写到哪」只许用现有节名：中文列中文节名，英文列英文节名，写明不能新建节", () => {
    const zh = Object.values(SECTIONS).map((s) => `「${s}」`);
    const en = Object.values(SECTIONS_EN).map((s) => `「${s}」`);
    for (const p of [questionsPrompt(detectProject(nodeRepo()), "zh", projectMd), onboardPrompt(detectProject(nodeRepo()), "zh")]) {
      for (const s of zh) expect(p).toContain(s);
      expect(p).not.toContain(en.join("、"));
      expect(p).toContain("不能新建");
    }
    const qEn = questionsPrompt(detectProject(pythonRepo()), "en", projectMd);
    const oEn = onboardPrompt(detectProject(pythonRepo()), "en");
    for (const p of [qEn, oEn]) {
      for (const s of en) expect(p).toContain(s);
      expect(p).not.toContain(zh.join("、"));
      expect(p).toContain("不能新建");
    }
    // 完整 onboard 带着中文模板（开头的规则把节名映射成英文），只有 --questions-only 能断言一个中文节名都没有。
    // A full onboard carries the Chinese template (the rule up front maps titles to English); only --questions-only can assert no Chinese title at all.
    for (const s of zh) expect(qEn).not.toContain(s);
  });

  it("questionsOnlyPrecheck：清单已存在 / 没有 PROJECT.md / 都满足", () => {
    const root = nodeRepo();
    expect(questionsOnlyPrecheck(root)).toContain("onboard");
    mkdirSync(join(root, ".sandcastle"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), projectMd);
    expect(questionsOnlyPrecheck(root)).toBeNull();
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "# 缺口清单\n");
    expect(questionsOnlyPrecheck(root)).toContain("OPEN-QUESTIONS.md");
  });

  it("onboard --questions-only：清单已存在时不生成也不改动任何文件", async () => {
    const root = nodeRepo();
    mkdirSync(join(root, ".sandcastle"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), projectMd);
    writeFileSync(join(root, ".sandcastle/OPEN-QUESTIONS.md"), "# 缺口清单\n");
    const before = files(root);
    await onboard(["--questions-only"], root);
    expect(files(root)).toEqual(before);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("onboard --questions-only：没有 PROJECT.md 时也不生成任何文件", async () => {
    const root = nodeRepo();
    const before = files(root);
    await onboard(["--questions-only"], root);
    expect(files(root)).toEqual(before);
  });

  it("--questions-only 和 --no-agent 不能同时给", async () => {
    await expect(onboard(["--questions-only", "--no-agent"], nodeRepo())).rejects.toThrow("--questions-only");
  });
});

describe("生成文件的语言 / language of generated files", () => {
  const han = /\p{Script=Han}/u;
  it("配置和 Containerfile 的注释中英成对：每行中文注释后面跟一行英文", () => {
    const f = { ...detectProject(nodeRepo()), language: "python" as const };
    for (const src of [configSource(f, "sandpipe"), containerfileSource(containerTemplate, f)]) {
      const comments = src.split("\n").map((l) => l.trim()).filter((l) => /^(\/\/|#) /.test(l) && !l.startsWith("//   "));
      for (const [i, l] of comments.entries()) if (han.test(l)) expect(comments.slice(i + 1).find((x) => !han.test(x)), l).toBeDefined();
      expect(comments.filter((l) => han.test(l)).length).toBeGreaterThan(0);
      expect(comments.filter((l) => !han.test(l)).length).toBeGreaterThan(0);
    }
  });

  it("英文项目：PROJECT.md 草稿用英文标题和 TODO，能通过校验；配置写 language: en；提示词开头是输出语言", () => {
    const f = detectProject(pythonRepo());
    const draft = projectDocDraft(f, "en");
    expect(draft).toContain("## Overview");
    expect(draft).toContain("<!-- TODO:");
    expect(draft).not.toMatch(han);
    expect(parseProjectDoc(draft).commit).toMatch(/English/);
    expect(configSource(f, "sandpipe", "en")).toContain('language: "en",');
    expect(onboardPrompt(f, "en")).toMatch(/^Output language: .*概况 → `## Overview`/);
    expect(onboardPrompt(f, "zh")).not.toMatch(/^Output language/);
    expect(parseProjectDoc(projectDocDraft(f, "zh")).overview).toBeDefined();
  });
});

describe("在项目外运行 onboard / update", () => {
  it("onboard 在非 git 目录或仓库子目录里报错，不写任何文件", async () => {
    const plain = mkdtempSync(join(tmpdir(), "sandpipe-plain-"));
    await expect(onboard(["--no-agent"], plain)).rejects.toThrow(/不是 git 仓库|isn't a git repository/);
    expect(readdirSync(plain)).toEqual([]);
    const root = nodeRepo();
    const sub = join(root, "pkg");
    mkdirSync(sub);
    expect(() => assertRepoRoot(sub)).toThrow(/不在仓库根目录|Not in the repository root/);
    expect(() => assertRepoRoot(root)).not.toThrow();
  });

  it("update 在没接入的目录里报错，不写任何文件", async () => {
    const plain = mkdtempSync(join(tmpdir(), "sandpipe-plain-"));
    await expect(updateClaudeFiles(plain, overwrite)).rejects.toThrow("sandcastle.config.ts");
    expect(readdirSync(plain)).toEqual([]);
  });
});

describe("prefixLines", () => {
  it("凑齐的完整行加前缀返回，半行留到下一个 chunk 或 flush", () => {
    const p = prefixLines("  [claude] ");
    expect(p.push("第一行\nWarning: expired\n")).toBe("  [claude] 第一行\n  [claude] Warning: expired\n");
    expect(p.push("半")).toBe("");
    expect(p.push("行\n")).toBe("  [claude] 半行\n");
    expect(p.flush()).toBe("");
  });

  it("结束时把剩下的半行补一个换行输出，之后再 flush 为空", () => {
    const p = prefixLines("[x] ");
    expect(p.push("a\nb")).toBe("[x] a\n");
    expect(p.flush()).toBe("[x] b\n");
    expect(p.flush()).toBe("");
  });

  it("空 chunk 不产出任何内容", () => {
    const p = prefixLines("> ");
    expect(p.push("")).toBe("");
    expect(p.flush()).toBe("");
  });
});

describe("claude 输出按 UTF-8 流式解码", () => {
  const zhong = Buffer.from("中");

  it("prefixLines 收 Buffer：「中」的 3 个字节拆成两个 chunk 也拼出完整的字", () => {
    const p = prefixLines("[c] ");
    expect(p.push(zhong.subarray(0, 1))).toBe("");
    expect(p.push(Buffer.concat([zhong.subarray(1), Buffer.from("\n")]))).toBe("[c] 中\n");
    expect(p.push(zhong.subarray(0, 2))).toBe("");
    expect(p.push(zhong.subarray(2))).toBe("");
    expect(p.flush()).toBe("[c] 中\n");
  });

  it("outputCollector：拆开的多字节字符拼回完整，上限按字节数算", () => {
    const c = outputCollector(5);
    expect(c.push(zhong.subarray(0, 2))).toBe(true);
    expect(c.push(zhong.subarray(2))).toBe(true);
    expect(c.text()).toBe("中");
    expect(c.push(Buffer.from("ab"))).toBe(true);
    expect(c.push(Buffer.from("c"))).toBe(false);
  });
});

describe("agentFailureMessage", () => {
  it("退出码 / 原因在前，stderr 末尾几行按 [claude] 前缀跟在后面", () => {
    expect(agentFailureMessage("claude 退出码 1", ["a", "b"])).toBe("claude 退出码 1\n  [claude] a\n  [claude] b");
  });

  it("只保留最后 5 行；没有 stderr 时只有原因本身", () => {
    expect(agentFailureMessage("r", ["1", "2", "3", "4", "5", "6", "7"])).toBe(
      "r\n  [claude] 3\n  [claude] 4\n  [claude] 5\n  [claude] 6\n  [claude] 7",
    );
    expect(agentFailureMessage("r", [])).toBe("r");
  });
});

describe("起 agent 的提示和 .env 那一步", () => {
  it("提示写明在本机用 claude -p 跑、用本机 Claude Code 登录的账号，不是 .env 的 token", () => {
    for (const kind of ["doc", "questions"] as const) {
      const zh = agentStartHint(kind, "opus");
      expect(zh).toContain("claude -p");
      expect(zh).toContain("本机 Claude Code 登录");
      expect(zh).toContain("不是 .sandcastle/.env 里的 token");
      expect(zh).toContain("opus");
    }
    expect(agentStartHint("doc", "opus")).toContain(".sandcastle/PROJECT.md");
    expect(agentStartHint("questions", "opus")).toContain(OPEN_QUESTIONS);
  });

  it("英文文案", () => {
    try {
      setTermLanguage("en", {});
      for (const kind of ["doc", "questions"] as const) {
        const en = agentStartHint(kind, "opus");
        expect(en).toContain("claude -p");
        expect(en).toContain("local Claude Code login");
        expect(en).toContain("not the token in .sandcastle/.env");
      }
    } finally {
      setTermLanguage("zh", {});
    }
  });

  it("下一步的 .env 提示写明流水线用的 token 和与本机登录无关", () => {
    const zh = envStepHint();
    expect(zh).toContain("cp .sandcastle/.env.example .sandcastle/.env");
    expect(zh).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(zh).toContain("claude setup-token");
    expect(zh).toContain("ANTHROPIC_API_KEY");
    expect(zh).toContain("与本机 Claude Code 登录无关");
  });

  it(".env 提示的英文文案", () => {
    try {
      setTermLanguage("en", {});
      const en = envStepHint();
      expect(en).toContain("cp .sandcastle/.env.example .sandcastle/.env");
      expect(en).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(en).toContain("claude setup-token");
      expect(en).toContain("ANTHROPIC_API_KEY");
      expect(en).toMatch(/independent of .*local Claude Code login/);
    } finally {
      setTermLanguage("zh", {});
    }
  });

  it("onboard 的「下一步」里有带 token 说明的 .env 一步", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent"], root, async () => "keep");
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(out).toContain("claude setup-token");
      expect(out).toContain("与本机 Claude Code 登录无关");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("onboard 的阶段摘要（--verbose 才打明细）", () => {
  it("detectSummary：两行——项目 / 平台 / 基线，门槛 / 受保护路径条数 / 网页界面；不打印正则字面量", () => {
    const f = detectProject(nodeRepo());
    expect(f.protectedPaths.length).toBeGreaterThan(0);
    const lines = detectSummary(f);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("shop");
    expect(lines[0]).toContain("node/pnpm");
    expect(lines[0]).toContain("github acme/shop");
    expect(lines[0]).toContain("基线 main");
    expect(lines[1]).toContain("门槛 typecheck + lint + test");
    expect(lines[1]).toContain(`受保护路径 ${f.protectedPaths.length} 条`);
    expect(lines[1]).toContain("有网页界面");
    // 只给条数：第二行里不能出现正则字面量的斜杠
    // Count only: no slash from a regex literal may appear on the second line
    expect(lines[1]).not.toContain("/");
  });

  it("filesSummary：已存在没动的（skipped / kept / unchanged）都算跳过，updated 单独计数，saved-new 不计数", () => {
    expect(filesSummary([{ file: "a", status: "written" }, { file: "b", status: "written" }, { file: "c", status: "skipped" }])).toBe(
      "文件  新建 2 个，跳过 1 个（已存在）",
    );
    expect(filesSummary([{ file: "a", status: "kept" }, { file: "b", status: "unchanged" }, { file: "c", status: "updated" }, { file: "d", status: "saved-new" }])).toBe(
      "文件  新建 0 个，跳过 2 个（已存在），更新 1 个",
    );
  });

  it("validationSummary：PROJECT.md 是否通过、缺口清单条数；没生成 / 没过不用计数表达", () => {
    expect(validationSummary(true, { count: 5, state: "ok" })).toBe("校验  PROJECT.md ✓ · 缺口清单 5 条");
    expect(validationSummary(true, { count: 0, state: "ok" })).toBe("校验  PROJECT.md ✓ · 缺口清单 0 条");
    expect(validationSummary(false, { count: 3, state: "ok" })).toBe("校验  PROJECT.md ✗ · 缺口清单 3 条");
    expect(validationSummary(true, { count: 0, state: "missing" })).toContain("缺口清单（没生成）");
    expect(validationSummary(true, { count: 0, state: "invalid" })).toContain("缺口清单 ✗");
  });

  it("agentDoneLine：doc 写「完成」和笔记路径，questions 不写 logs 只写「完成」", () => {
    expect(agentDoneLine("doc")).toBe("完成，笔记见 .sandcastle/logs/onboard.md");
    expect(agentDoneLine("questions")).toBe("完成");
  });

  it("英文文案", () => {
    try {
      setTermLanguage("en", {});
      const f = detectProject(nodeRepo());
      const lines = detectSummary(f);
      expect(lines[0]).toContain("Detect  shop");
      expect(lines[0]).toContain("base main");
      expect(lines[1]).toContain("gate typecheck + lint + test");
      expect(lines[1]).toContain(`· ${f.protectedPaths.length} protected path(s) ·`);
      expect(lines[1]).toContain("web UI");
      expect(filesSummary([{ file: "a", status: "written" }, { file: "b", status: "skipped" }])).toBe("Files  1 written, 1 skipped (already present)");
      expect(filesSummary([{ file: "a", status: "kept" }, { file: "b", status: "updated" }])).toBe("Files  0 written, 1 skipped (already present), 1 updated");
      expect(validationSummary(true, { count: 5, state: "ok" })).toBe("Checks  PROJECT.md ✓ · 5 open question(s)");
      expect(validationSummary(true, { count: 0, state: "missing" })).toContain("open questions (not written)");
      expect(validationSummary(false, { count: 0, state: "invalid" })).toContain("open questions ✗");
      expect(agentDoneLine("doc")).toBe("Done; notes in .sandcastle/logs/onboard.md");
      expect(agentDoneLine("questions")).toBe("Done");
    } finally {
      setTermLanguage("zh", {});
    }
  });

  it("默认输出收成阶段摘要：探测两行、文件一行计数、校验一行；没有逐个文件行、命令明细和正则字面量", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent"], root, async () => "keep");
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("探测  shop");
      expect(out).toMatch(/受保护路径 \d+ 条/);
      expect(out).not.toContain("命令：");
      expect(out).not.toContain("受保护路径：");
      expect(out).toMatch(/文件  新建 \d+ 个，跳过 \d+ 个（已存在）/);
      expect(out).not.toContain("：写入");
      expect(out).not.toContain("：已存在，跳过");
      expect(out).not.toContain("：无需改动");
      expect(out).toContain("校验  PROJECT.md ✓");
      expect(out).toContain("缺口清单（没生成）");
      expect(warn.mock.calls.flat().join("\n")).toContain("⚠ 没有生成缺口清单");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("--verbose 打完整明细：各命令、受保护路径的正则、逐个文件的状态行、缺口清单明细", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, OPEN_QUESTIONS), "# 缺口清单\n- [规范] 用什么测试风格？ → PROJECT.md「测试」\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent", "--verbose"], root, async () => "keep");
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("命令：typecheck=");
      expect(out).toContain("受保护路径：");
      expect(out).toMatch(/· \.sandcastle\/\S+：已存在，跳过/);
      expect(out).toContain("✓ 缺口清单还有 1 条");
      expect(out).toContain("缺口清单 1 条");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("另存为 .new 的文件在摘要之外单独成醒目一行，不被计数收掉", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".claude/agents/screenshot-checker.md"), "旧版");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent"], root, async () => "new");
      const out = log.mock.calls.flat().join("\n");
      expect(warn.mock.calls.flat().join("\n")).toContain("⚠ .claude/agents/screenshot-checker.md 和当前模板不同，新版另存为 .claude/agents/screenshot-checker.md.new");
      expect(out).not.toContain("：写入");
      expect(out).toMatch(/文件  新建 \d+ 个/);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("PROJECT.md 校验失败：摘要行给 ✗，报错单独成一行", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/PROJECT.md"), "人改过");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent"], root, async () => "keep");
      expect(log.mock.calls.flat().join("\n")).toContain("校验  PROJECT.md ✗");
      expect(warn.mock.calls.flat().join("\n")).toContain("⚠ PROJECT.md 校验没过：");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("远端是 GitLab 时警告仍然单独成一行", async () => {
    const root = nodeRepo();
    execFileSync("git", ["-C", root, "remote", "set-url", "origin", "git@gitlab.com:acme/shop.git"]);
    installFiles(root, detectProject(root));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await onboard(["--no-agent"], root, async () => "keep");
      expect(warn.mock.calls.flat().join("\n")).toContain("⚠ 远端是 GitLab");
      expect(log.mock.calls.flat().join("\n")).toContain("探测  shop");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("help 和 README 中英都写上 --verbose", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    // 中英两份 help 里各出现一次
    // Once in each of the two help texts
    expect((cli.match(/--verbose/g) ?? []).length).toBeGreaterThanOrEqual(2);
    for (const p of ["../README.md", "../README.zh-CN.md"])
      expect(readFileSync(new URL(p, import.meta.url), "utf8")).toMatch(/onboard \[--no-agent\] \[--model[^\n]*\] \[--verbose\]/);
  });

  it("help 和 README 写明 agent 的 stderr 与笔记全文只在 --verbose 打，questions-only 也认 --verbose", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    // 中英两份 help 里各提到一次 stderr
    // stderr is mentioned once in each of the two help texts
    expect((cli.match(/stderr/g) ?? []).length).toBeGreaterThanOrEqual(2);
    for (const p of ["../README.md", "../README.zh-CN.md"])
      expect(readFileSync(new URL(p, import.meta.url), "utf8")).toMatch(/--questions-only \[--model[^\n]*\] \[--verbose\]/);
  });
});
