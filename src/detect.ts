// onboard 的第一步：只读文件和 git，探测项目的事实（语言、包管理、命令、托管平台、文档、测试、迁移、依赖的服务）。
// 不调 agent、不联网；结果用来生成 sandcastle.config.ts 与 PROJECT.md 草稿，再交给 agent 补全（onboard.ts）。
// Step one of onboard: reads only files and git to detect project facts (language, package manager, commands, forge, docs, tests, migrations, services).
// No agent, no network; the result generates sandcastle.config.ts and the PROJECT.md draft, which the agent then completes (onboard.ts).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Language as TextLanguage } from "./i18n.ts";
import { trySh } from "./shell.ts";

export type Language = "node" | "python" | "go" | "rust" | "other";
export type ForgeKind = "github" | "gitlab" | "unknown";

export interface ProjectFacts {
  root: string;
  name: string;
  language: Language;
  /** node 的包管理器；其他语言为空 / node's package manager; empty for other languages */
  packageManager?: "pnpm" | "yarn" | "npm" | "bun";
  /** 镜像里要全局装的包管理器（pnpm@10.4.1）；npm、yarn（node 镜像自带，berry 走 yarnPath）与 bun 不用 / Package manager to install globally in the image (pnpm@10.4.1); not needed for npm, yarn (bundled in the node image, berry goes through yarnPath) or bun */
  packageManagerSpec?: string;
  /** 沙箱里装依赖的命令 / Command that installs dependencies in the sandbox */
  install: string;
  /** 从宿主机拷进 worktree 的目录（省掉从头安装） / Directories copied from the host into the worktree (saves a full install) */
  copyToWorktree: string[];
  commands: { typecheck?: string; lint?: string; test?: string; testFile?: string; format?: string; e2e?: string };
  /** 测试文件路径的正则源码（不带 ^$） / Regex source for test file paths (no ^$) */
  testFilePattern: string;
  testDirs: string[];
  forge: { kind: ForgeKind; host?: string; path?: string };
  remote: string;
  baseBranch: string;
  /** 根目录下存在的给人 / agent 看的文档 / Docs in the root meant for humans / agents */
  docs: string[];
  /** 顶层目录（不含隐藏目录与依赖、构建产物） / Top-level directories (no hidden dirs, dependencies or build output) */
  topDirs: string[];
  /** 迁移目录与生成工具 / Migration directory and generator tool */
  migrations?: { dir: string; tool: string };
  /** docker compose 里的服务镜像（postgres、redis……） / Service images in docker compose (postgres, redis…) */
  services: string[];
  /**
   * env 文件里指向本机服务的变量（值里有 localhost / 127.0.0.1，或是 *_DB_NAME 这类库名变量），perTicketDb 表示要加库名后缀
   * Variables in env files that point at local services (value contains localhost / 127.0.0.1, or a db-name variable like *_DB_NAME); perTicketDb means add a db-name suffix
   */
  serviceEnv: ServiceEnvKey[];
  /** serviceEnv 是从哪些 env 文件扫出来的 / Which env files serviceEnv was scanned from */
  serviceEnvFrom: string[];
  /** 有网页界面（按依赖判断），可能需要浏览器验收 / Has a web UI (judged by dependencies), may need a browser check */
  webUi: boolean;
  /** 页面文件路径的正则源码（按前端框架给的默认值），没有网页界面时为空 / Regex sources for page file paths (defaults by frontend framework); empty without a web UI */
  pagePaths: string[];
  /**
   * 受保护路径的正则源码（按探测结果给：快照、CI workflow、迁移目录；有网页界面或探测到 Playwright 时总有基准截图目录），都没有时为空；lockfile 不进默认值
   * Regex sources for protected paths (by what was detected: snapshots, CI workflows, migration directory; the baseline screenshot directory is always included with a web UI or detected Playwright); empty when none; lockfiles are not a default
   */
  protectedPaths: string[];
  /**
   * 提到浏览器验收的现成资料（文档、旧的 .sandcastle 提示词、test/e2e 说明、scripts/ 里建种子或验收数据的脚本），给 onboard 的 agent 先读
   * Existing material that mentions browser checks (docs, old .sandcastle prompts, test/e2e notes, seed or acceptance-data scripts under scripts/), for onboard's agent to read first
   */
  browserHints: string[];
  /** 最近几条提交的标题，用来判断提交信息的语言与风格 / Subjects of the last few commits, used to judge commit message language and style */
  recentCommits: string[];
  commitLanguage: TextLanguage;
  /**
   * commitLanguage 是怎么定的：commits 按足够多的提交；few-commits 提交太少、文档文字也不够，按那几条提交；docs 提交太少，按项目文档的主要语言；lang 提交太少，按 onboard 的 --lang（detect 不产出，由 onboard 的 applyLangArg 设置）
   * How commitLanguage was decided: commits from enough commits; few-commits too few commits and too little doc text, from those few commits; docs too few commits, from the docs' main language; lang too few commits, from onboard's --lang (never produced by detect; set by onboard's applyLangArg)
   */
  commitLanguageBasis: "commits" | "few-commits" | "docs" | "lang";
}

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "__pycache__", "venv", ".venv"]);
const DOC_CANDIDATES = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "CONTEXT.md",
  "GLOSSARY.md",
  "CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "docs/adr/README.md",
  "docs/adr",
  "docs/decisions",
  "test/README.md",
  "tests/README.md",
  "test/CATALOG.md",
];
const WEB_DEPS = [
  "react",
  "vue",
  "svelte",
  "@angular/core",
  "next",
  "nuxt",
  "solid-js",
  "preact",
  "@remix-run/react",
  "react-router",
  "astro",
];
/**
 * 前端框架 → 页面文件路径的正则源码，按顺序取第一个匹配的（next 先于 react，nuxt 先于 vue）；都不匹配但有网页界面时用 PAGE_PATHS_FALLBACK。
 * Frontend framework → regex source for page file paths; the first match wins (next before react, nuxt before vue). With a web UI but no match, PAGE_PATHS_FALLBACK.
 */
const PAGE_PATHS: [(deps: Record<string, string>) => boolean, string][] = [
  [(d) => "next" in d, "^(app|pages|components|src/(app|pages|components))/"],
  [(d) => Object.keys(d).some((k) => k.startsWith("@remix-run/")) || "react-router" in d, "^app/(routes|components)/"],
  [(d) => "nuxt" in d || "vue" in d, "^(pages|components|layouts)/|^src/(pages|components|views)/"],
  [(d) => "@sveltejs/kit" in d || "svelte" in d, "^src/(routes|lib)/"],
  [(d) => "astro" in d, "^src/(pages|components|layouts)/"],
];
const PAGE_PATHS_FALLBACK = String.raw`^src/.*\.(tsx|jsx|vue|svelte|css)$`;

/** Playwright 配置文件的后缀，根目录有任一个就算探测到 Playwright / Playwright config file extensions; any one in the root counts as detected Playwright */
const PLAYWRIGHT_CONFIG_EXTS = ["ts", "js", "mjs", "cjs"];

/** 镜像名里的关键字 → 服务名（pgvector 也是 PostgreSQL）；服务名用英文，会写进 PROJECT.md 草稿和配置注释。 / Image-name keyword → service name (pgvector is PostgreSQL too); names are English since they go into the PROJECT.md draft and config comments. */
const SERVICE_IMAGES: [RegExp, string][] = [
  [/postgres|pgvector|postgis|timescale/, "postgres"],
  [/mysql|mariadb/, "mysql"],
  [/mongo/, "mongodb"],
  [/redis|valkey/, "redis"],
  [/minio|seaweedfs|localstack/, "s3"],
  [/elasticsearch|opensearch/, "elasticsearch"],
  [/rabbitmq/, "rabbitmq"],
  [/kafka|redpanda/, "kafka"],
  [/clickhouse/, "clickhouse"],
];

/** 提交少于这么多条时，提交语言改按文档推断 / Below this many commits, the commit language is inferred from the docs */
const MIN_COMMITS = 5;
/** 文档里中文字符加 ASCII 字母少于这么多时，文字不够判断语言 / Below this many CJK characters plus ASCII letters, the docs are too short to judge */
const MIN_DOC_CHARS = 200;

const read = (root: string, f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : undefined);
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** 浏览器验收相关的关键字 / Keywords that point at browser-check material */
const BROWSER_WORDS = /playwright|ego-browser|puppeteer|cypress|browser|浏览器|截图|screenshot|dev server|e2e|验收/i;
/** scripts/ 下按文件名就算相关的脚本（建种子、验收数据、演示租户） / Scripts under scripts/ that count by name alone (seeds, acceptance data, demo tenants) */
const BROWSER_SCRIPT_NAMES = /seed|browser|e2e|lab|fixture|demo|playwright/i;

/**
 * 找提到浏览器验收的现成资料：只看文件名和前 64KB 内容，最多 20 条。
 * Find existing material that mentions browser checks: only file names and the first 64KB of content, at most 20 entries.
 */
export function browserHints(root: string): string[] {
  const list = (dir: string, keep: (name: string) => boolean) =>
    isDir(join(root, dir))
      ? readdirSync(join(root, dir), { withFileTypes: true })
          .filter((e) => e.isFile() && keep(e.name))
          .map((e) => `${dir}/${e.name}`)
      : [];
  const mentions = (rel: string) => {
    try {
      return BROWSER_WORDS.test(readFileSync(join(root, rel), "utf8").slice(0, 65536));
    } catch {
      return false;
    }
  };
  const docs = [
    ...DOC_CANDIDATES.filter((f) => f.endsWith(".md") && existsSync(join(root, f))),
    ...list("docs", (n) => n.endsWith(".md")),
    ...["test", "tests", "e2e"].flatMap((d) => list(d, (n) => /\.md$/i.test(n))),
    ...list(".sandcastle", (n) => /prompt/i.test(n) && n.endsWith(".md")),
    ...list(".sandcastle/prompts", (n) => n.endsWith(".md")),
  ];
  const scripts = list("scripts", (n) => BROWSER_SCRIPT_NAMES.test(n));
  return [...new Set([...docs.filter(mentions), ...scripts])].slice(0, 20);
}

/**
 * 项目文档的主要语言：DOC_CANDIDATES 里的文件拼起来，中文字符 × 4 不少于 ASCII 字母算中文；文字不够时返回 undefined。
 * 乘 4 是因为中文文档里也夹着大量英文（命令、路径、代码），一个汉字表达的内容约等于几个英文字母。
 * The docs' main language: concatenate the files in DOC_CANDIDATES; CJK characters × 4 at least the ASCII letters means Chinese; undefined when there's too little text.
 * The × 4 is because Chinese docs are full of English too (commands, paths, code), and one Han character carries about as much as several English letters.
 */
function docsLanguage(root: string): TextLanguage | undefined {
  const text = DOC_CANDIDATES.filter((f) => !isDir(join(root, f)))
    .map((f) => read(root, f) ?? "")
    .join("\n");
  const cjk = text.match(/[一-鿿]/g)?.length ?? 0;
  const ascii = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (cjk + ascii < MIN_DOC_CHARS) return undefined;
  return cjk * 4 >= ascii ? "zh" : "en";
}

export function parseRemoteUrl(url: string): ProjectFacts["forge"] {
  // git@host:group/sub/repo.git、ssh://git@host:22/group/repo.git、https://host/group/repo(.git)
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) return { kind: "unknown" };
  const [, host, path] = m;
  const kind: ForgeKind = /github/i.test(host) ? "github" : /gitlab/i.test(host) ? "gitlab" : "unknown";
  return { kind, host, path };
}

function nodeFacts(root: string, pkg: Record<string, any>) {
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const pmField = String(pkg.packageManager ?? "");
  const pm: ProjectFacts["packageManager"] =
    pmField.startsWith("pnpm") || existsSync(join(root, "pnpm-lock.yaml"))
      ? "pnpm"
      : pmField.startsWith("yarn") || existsSync(join(root, "yarn.lock"))
        ? "yarn"
        : existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))
          ? "bun"
          : "npm";
  const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
  const pick = (...names: string[]) => names.find((n) => scripts[n]);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const tc = pick("typecheck", "type-check", "tsc", "check-types");
  const lint = pick("lint");
  const test = pick("test", "test:unit");
  const fmt = pick("format", "fmt");
  const webUi = WEB_DEPS.some((d) => d in deps);
  const runner = deps.vitest ? "vitest" : deps.jest ? "jest" : deps.mocha ? "mocha" : undefined;
  // Playwright e2e 命令：写了 test:e2e / e2e script 就用它（前者优先）；没写但根目录有 playwright.config 时给默认命令，门槛直接能跑。
  // The Playwright e2e command: the test:e2e / e2e script when there is one (the former wins); with no script but a playwright.config in the root, a default so the gate runs it out of the box.
  const e2eScript = pick("test:e2e", "e2e");
  const hasPlaywrightConfig = PLAYWRIGHT_CONFIG_EXTS.some((ext) => existsSync(join(root, `playwright.config.${ext}`)));
  let e2e: string | undefined;
  if (e2eScript) e2e = run(e2eScript);
  else if (hasPlaywrightConfig) {
    if (pm === "npm") e2e = "npx playwright test";
    else if (pm === "bun") e2e = "bunx playwright test";
    else e2e = `${pm} exec playwright test`;
  }
  // 宿主机（macOS）的 node_modules 缺 linux 原生包，沙箱里按锁文件重装。pnpm 由镜像全局装好 package.json 里的版本，yarn 是 node 镜像自带的，
  // 门槛和 agent 也直接用 pnpm / yarn 命令。
  // The host's (macOS) node_modules lacks linux native packages, so the sandbox reinstalls from the lockfile. The image installs pnpm globally at the version in package.json and yarn comes with the node image,
  // so the gate and the agent call pnpm / yarn directly too.
  const pmVersion = pmField.includes("@") ? pmField.split("+")[0] : pm;
  const install =
    pm === "pnpm" || pm === "yarn"
      ? `${pm} install --frozen-lockfile`
      : pm === "bun"
          ? "bun install --frozen-lockfile"
          : existsSync(join(root, "package-lock.json"))
            ? "npm ci"
            : "npm install";
  return {
    packageManager: pm,
    packageManagerSpec: pm === "pnpm" ? pmVersion : undefined,
    install,
    copyToWorktree: ["node_modules"],
    commands: {
      typecheck: tc ? run(tc) : deps.typescript ? "npx tsc --noEmit" : undefined,
      lint: lint ? run(lint) : undefined,
      test: test ? run(test) : undefined,
      testFile:
        runner === "vitest"
          ? "npx vitest run <file>"
          : runner === "jest"
            ? "npx jest <file>"
            : runner === "mocha"
              ? "npx mocha <file>"
              : undefined,
      format: fmt ? run(fmt) : undefined,
      e2e,
    },
    testFilePattern: String.raw`\S+\.(test|spec)\.[cm]?[jt]sx?`,
    webUi,
    pagePaths: webUi ? [PAGE_PATHS.find(([has]) => has(deps))?.[1] ?? PAGE_PATHS_FALLBACK] : [],
    migrations: deps["drizzle-kit"]
      ? { tool: "drizzle-kit", dir: "drizzle" }
      : deps.prisma
        ? { tool: "prisma", dir: "prisma/migrations" }
        : deps.knex
          ? { tool: "knex", dir: "migrations" }
          : deps.typeorm
            ? { tool: "typeorm", dir: "src/migrations" }
            : undefined,
  };
}

function otherLanguageFacts(root: string, language: Language): Pick<ProjectFacts, "install" | "copyToWorktree" | "commands" | "testFilePattern" | "migrations"> {
  if (language === "python") {
    const uv = existsSync(join(root, "uv.lock"));
    const poetry = existsSync(join(root, "poetry.lock"));
    const prefix = uv ? "uv run " : poetry ? "poetry run " : "";
    const pyproject = read(root, "pyproject.toml") ?? "";
    return {
      install: uv
        ? "uv sync"
        : poetry
          ? "poetry install"
          : existsSync(join(root, "requirements.txt"))
            ? "pip install -r requirements.txt"
            : "pip install -e .",
      copyToWorktree: [] as string[],
      commands: {
        typecheck: /mypy/.test(pyproject)
          ? `${prefix}mypy${/\[tool\.mypy\][^[]*\bfiles\s*=/.test(pyproject) ? "" : " ."}` // 项目配了 files 就按它的范围 / use the project's files setting when it has one
          : /pyright/.test(pyproject) ? `${prefix}pyright` : undefined,
        lint: /ruff/.test(pyproject) ? `${prefix}ruff check .` : undefined,
        test: `${prefix}pytest`,
        testFile: `${prefix}pytest <file>`,
      },
      testFilePattern: String.raw`\S*test_\S+\.py`,
      migrations: existsSync(join(root, "alembic")) ? { tool: "alembic", dir: "alembic/versions" } : undefined,
    };
  }
  if (language === "go")
    return {
      install: "go mod download",
      copyToWorktree: [] as string[],
      commands: { typecheck: "go vet ./...", test: "go test ./...", testFile: "go test ./<package>/ -run <TestName>" },
      testFilePattern: String.raw`\S+_test\.go`,
      migrations: undefined,
    };
  if (language === "rust")
    return {
      install: "cargo fetch",
      copyToWorktree: [] as string[],
      commands: {
        typecheck: "cargo check --all-targets",
        lint: "cargo clippy --all-targets",
        test: "cargo test",
        testFile: "cargo test --test <name>",
      },
      testFilePattern: String.raw`tests/\S+\.rs`,
      migrations: undefined,
    };
  return { install: "true", copyToWorktree: [] as string[], commands: {}, testFilePattern: String.raw`\S*test\S*`, migrations: undefined };
}

/**
 * 根目录与一级子目录（db_script/、docker/、deploy/……）里的 compose 文件用到的服务
 * Services used by compose files in the root and first-level subdirectories (db_script/, docker/, deploy/…)
 */
function composeServices(root: string): string[] {
  const names = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
  const dirs = [
    ".",
    ...readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !IGNORED_DIRS.has(d.name))
      .map((d) => d.name),
  ];
  const text = dirs
    .flatMap((d) =>
      readdirSync(join(root, d))
        .filter((f) => names.test(f))
        .map((f) => readFileSync(join(root, d, f), "utf8")),
    )
    .join("\n");
  const images = [...text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]);
  return [...new Set(images.flatMap((img) => SERVICE_IMAGES.filter(([re]) => re.test(img.toLowerCase())).map(([, name]) => name)))];
}

export type ServiceEnvKey = { key: string; perTicketDb: boolean };

/**
 * 要扫的 env 文件：只扫 .env 和它的示例，因为生成的配置运行时只读 .env。
 * Env files to scan: only .env and its examples, since the generated config reads only .env at run time.
 */
const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env"];
/** 这些 scheme 的 URL 带库名，每张票要独立的库（scheme 里 + 后面的驱动名不算）。 / URLs with these schemes carry a db name that must differ per ticket (a +driver part of the scheme is ignored). */
const DB_SCHEMES = new Set(["postgres", "postgresql", "mysql", "mariadb", "mongodb", "mssql", "sqlserver", "cockroachdb"]);
const LOCAL_HOST = /\b(localhost|127\.0\.0\.1)\b/;
/** 库名单独一个变量（DB_NAME、REPORT_DATABASE……）。 / The db name in its own variable (DB_NAME, REPORT_DATABASE…). */
const DB_NAME_KEY = /(^|_)(DB|DATABASE|DB_NAME|DBNAME|DATABASE_NAME)$/;

/**
 * 判断一个 env 变量是否指向本机服务、要不要按票加库名后缀；不相关的返回 undefined。
 * Decides whether an env variable points at a local service and whether it needs a per-ticket db suffix; returns undefined for unrelated ones.
 */
export function classifyEnvEntry(key: string, value: string): ServiceEnvKey | undefined {
  const scheme = /^([a-z][\w.+-]*):\/\//i.exec(value)?.[1].toLowerCase().split("+")[0];
  if (LOCAL_HOST.test(value)) return { key, perTicketDb: scheme !== undefined && DB_SCHEMES.has(scheme) };
  if (DB_NAME_KEY.test(key) && value !== "" && !/^\d+$/.test(value) && scheme === undefined) return { key, perTicketDb: true };
  return undefined;
}

/**
 * 扫根目录的 env 文件，找出指向本机服务的变量（同名只留第一次）。
 * Scans the root's env files for variables pointing at local services (keeping the first of each name).
 */
function scanServiceEnv(root: string): { serviceEnv: ServiceEnvKey[]; serviceEnvFrom: string[] } {
  const serviceEnv: ServiceEnvKey[] = [];
  const serviceEnvFrom: string[] = [];
  for (const file of ENV_FILES) {
    const text = read(root, file);
    if (text === undefined) continue;
    let found = false;
    for (const [key, value] of Object.entries(parseEnv(text))) {
      const entry = value === undefined ? undefined : classifyEnvEntry(key, value);
      if (!entry) continue;
      found = true;
      if (!serviceEnv.some((e) => e.key === key)) serviceEnv.push(entry);
    }
    if (found) serviceEnvFrom.push(file);
  }
  return { serviceEnv, serviceEnvFrom };
}

/** Playwright 基准截图目录的规则 / The rule for the Playwright baseline screenshot directory */
const PLAYWRIGHT_SNAPSHOTS = "-snapshots/";
/** 快照类规则，每组里有一条命中仓库文件就整组写上 / Snapshot rules; a group is written whole when any of its rules matches a repo file */
const SNAPSHOT_RULES = [["(^|/)__snapshots__/", String.raw`\.snap$`], [PLAYWRIGHT_SNAPSHOTS]];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 受保护路径的默认值。快照按 git 跟踪（含未忽略的未跟踪文件）的文件判断，git 不可用时不写；workflow 与迁移按目录判断。
 * 有网页界面或探测到 Playwright 时，基准截图目录（-snapshots/）即使还没有快照文件也默认受保护：更新基准只能由人确认后合并。
 * Default protected paths. Snapshots are judged from files git knows (tracked plus untracked, not ignored), skipped when git is unavailable; workflows and migrations by directory.
 * With a web UI or detected Playwright, the baseline screenshot directory (-snapshots/) is protected by default even with no snapshot files yet: a baseline update only merges after a human confirms it.
 */
function defaultProtectedPaths(root: string, migrations: ProjectFacts["migrations"], web: boolean): string[] {
  const ls = trySh("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]);
  const files = ls.ok ? ls.out.split("\n").filter(Boolean) : [];
  const out: string[] = [];
  // 探测条件和写出的规则用同一组源码，改一边不会漏另一边。
  // Detection and the written rules share the same sources, so changing one can't miss the other.
  for (const group of SNAPSHOT_RULES) if (files.some((f) => group.some((src) => new RegExp(src).test(f)))) out.push(...group);
  if (web && !out.includes(PLAYWRIGHT_SNAPSHOTS)) out.push(PLAYWRIGHT_SNAPSHOTS);
  if (isDir(join(root, ".github/workflows"))) out.push(String.raw`^\.github/workflows/`);
  if (migrations) out.push(`^${escapeRegex(migrations.dir)}/`);
  return out;
}

export function detectProject(root = process.cwd()): ProjectFacts {
  const pkgText = read(root, "package.json");
  const language: Language = pkgText
    ? "node"
    : existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))
      ? "python"
      : existsSync(join(root, "go.mod"))
        ? "go"
        : existsSync(join(root, "Cargo.toml"))
          ? "rust"
          : "other";
  const pkg = pkgText ? JSON.parse(pkgText) : {};
  const lang =
    language === "node" ? nodeFacts(root, pkg) : { ...otherLanguageFacts(root, language), webUi: false, pagePaths: [], packageManager: undefined, packageManagerSpec: undefined };

  const git = (args: string[]) => trySh("git", ["-C", root, ...args]);
  const remote = git(["remote"]).out.split("\n").includes("origin") ? "origin" : git(["remote"]).out.split("\n")[0] || "origin";
  const remoteUrl = git(["remote", "get-url", remote]);
  const headRef = git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  const baseBranch =
    headRef.ok && headRef.out ? headRef.out.replace(`${remote}/`, "") : git(["rev-parse", "--verify", "-q", "main"]).ok ? "main" : "master";
  const log = git(["log", "-n", "8", "--format=%s", baseBranch]);
  const recentCommits = log.ok ? log.out.split("\n").filter(Boolean) : [];
  const cjk = recentCommits.filter((s) => /[一-鿿]/.test(s)).length;
  const fromCommits: TextLanguage = cjk * 2 >= recentCommits.length && cjk > 0 ? "zh" : "en";
  const fewCommits = recentCommits.length < MIN_COMMITS;
  const fromDocs = fewCommits ? docsLanguage(root) : undefined;
  const commitLanguageBasis: ProjectFacts["commitLanguageBasis"] = !fewCommits ? "commits" : fromDocs ? "docs" : "few-commits";

  const topDirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !IGNORED_DIRS.has(d.name))
    .map((d) => d.name)
    .sort();
  const testDirs = ["test", "tests", "__tests__", "spec", "e2e"].filter((d) => isDir(join(root, d)));
  const migrations =
    lang.migrations && isDir(join(root, lang.migrations.dir))
      ? lang.migrations
      : lang.migrations && existsSync(join(root, "drizzle.config.ts"))
        ? lang.migrations
        : undefined;

  return {
    root,
    name: pkg.name ?? root.split("/").filter(Boolean).pop() ?? "project",
    language,
    packageManager: lang.packageManager,
    packageManagerSpec: lang.packageManagerSpec,
    install: lang.install,
    copyToWorktree: lang.copyToWorktree,
    commands: lang.commands,
    testFilePattern: lang.testFilePattern,
    testDirs,
    forge: remoteUrl.ok ? parseRemoteUrl(remoteUrl.out) : { kind: "unknown" },
    remote,
    baseBranch,
    docs: DOC_CANDIDATES.filter((f) => existsSync(join(root, f))),
    topDirs,
    migrations,
    services: composeServices(root),
    ...scanServiceEnv(root),
    webUi: lang.webUi,
    pagePaths: lang.pagePaths,
    protectedPaths: defaultProtectedPaths(root, migrations, lang.webUi || !!lang.commands.e2e),
    browserHints: browserHints(root),
    recentCommits,
    commitLanguage: fromDocs ?? fromCommits,
    commitLanguageBasis,
  };
}
