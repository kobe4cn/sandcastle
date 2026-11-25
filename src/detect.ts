// onboard 的第一步：只读文件和 git，探测项目的事实（语言、包管理、命令、托管平台、文档、测试、迁移、依赖的服务）。
// 不调 agent、不联网；结果用来生成 sandcastle.config.ts 与 PROJECT.md 草稿，再交给 agent 补全（onboard.ts）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { trySh } from "./shell.ts";

export type Language = "node" | "python" | "go" | "rust" | "other";
export type ForgeKind = "github" | "gitlab" | "unknown";

export interface ProjectFacts {
  root: string;
  name: string;
  language: Language;
  /** node 的包管理器；其他语言为空 */
  packageManager?: "pnpm" | "yarn" | "npm" | "bun";
  /** 沙箱里装依赖的命令 */
  install: string;
  /** 从宿主机拷进 worktree 的目录（省掉从头安装） */
  copyToWorktree: string[];
  commands: { typecheck?: string; lint?: string; test?: string; testFile?: string; format?: string };
  /** 测试文件路径的正则源码（不带 ^$） */
  testFilePattern: string;
  testDirs: string[];
  forge: { kind: ForgeKind; host?: string; path?: string };
  remote: string;
  baseBranch: string;
  /** 根目录下存在的给人 / agent 看的文档 */
  docs: string[];
  /** 顶层目录（不含隐藏目录与依赖、构建产物） */
  topDirs: string[];
  /** 迁移目录与生成工具 */
  migrations?: { dir: string; tool: string };
  /** docker compose 里的服务镜像（postgres、redis……） */
  services: string[];
  /** 有网页界面（按依赖判断），可能需要浏览器验收 */
  webUi: boolean;
  /** 最近几条提交的标题，用来判断提交信息的语言与风格 */
  recentCommits: string[];
  commitLanguage: "zh" | "en";
}

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "__pycache__", "venv", ".venv"]);
const DOC_CANDIDATES = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "CONTEXT.md",
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

const read = (root: string, f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : undefined);
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

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
  const runner = deps.vitest ? "vitest" : deps.jest ? "jest" : deps.mocha ? "mocha" : undefined;
  // 宿主机（macOS）的 node_modules 缺 linux 原生包，沙箱里按锁文件重装；pnpm 用 package.json 里的版本
  const pmVersion = pmField.includes("@") ? pmField.split("+")[0] : pm;
  const install =
    pm === "pnpm"
      ? `npx -y ${pmVersion} install --frozen-lockfile`
      : pm === "yarn"
        ? `npx -y ${pmVersion} install --frozen-lockfile`
        : pm === "bun"
          ? "bun install --frozen-lockfile"
          : existsSync(join(root, "package-lock.json"))
            ? "npm ci"
            : "npm install";
  return {
    packageManager: pm,
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
    },
    testFilePattern: String.raw`\S+\.(test|spec)\.[cm]?[jt]sx?`,
    webUi: WEB_DEPS.some((d) => d in deps),
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

function otherLanguageFacts(root: string, language: Language) {
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
          ? `${prefix}mypy${/\[tool\.mypy\][^[]*\bfiles\s*=/.test(pyproject) ? "" : " ."}` // 项目配了 files 就按它的范围
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

/** 根目录与一级子目录（db_script/、docker/、deploy/……）里的 compose 文件用到的服务 */
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
    language === "node" ? nodeFacts(root, pkg) : { ...otherLanguageFacts(root, language), webUi: false, packageManager: undefined };

  const git = (args: string[]) => trySh("git", ["-C", root, ...args]);
  const remote = git(["remote"]).out.split("\n").includes("origin") ? "origin" : git(["remote"]).out.split("\n")[0] || "origin";
  const remoteUrl = git(["remote", "get-url", remote]);
  const headRef = git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  const baseBranch =
    headRef.ok && headRef.out ? headRef.out.replace(`${remote}/`, "") : git(["rev-parse", "--verify", "-q", "main"]).ok ? "main" : "master";
  const log = git(["log", "-n", "8", "--format=%s", baseBranch]);
  const recentCommits = log.ok ? log.out.split("\n").filter(Boolean) : [];
  const cjk = recentCommits.filter((s) => /[一-鿿]/.test(s)).length;

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
    webUi: lang.webUi,
    recentCommits,
    commitLanguage: cjk * 2 >= recentCommits.length && cjk > 0 ? "zh" : "en",
  };
}
