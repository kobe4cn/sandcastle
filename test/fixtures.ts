// 测试共用的夹具：一个 node + pnpm 的小仓库（带 compose、迁移、CLAUDE.md、origin 远端），一个 python + uv 的小仓库。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function nodeRepo() {
  const root = mkdtempSync(join(tmpdir(), "sc-onboard-"));
  const w = (f: string, s: string) => {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), s);
  };
  w(
    "package.json",
    JSON.stringify({
      name: "shop",
      packageManager: "pnpm@10.4.1+sha512.abc",
      scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" },
      dependencies: { react: "19", "drizzle-orm": "1" },
      devDependencies: { vitest: "3", "drizzle-kit": "1", typescript: "5" },
    }),
  );
  w("pnpm-lock.yaml", "");
  w("compose.yml", "services:\n  db:\n    image: pgvector/pgvector:pg17\n");
  w("deploy/docker-compose.dev.yml", "services:\n  cache:\n    image: 'redis:7'\n");
  w("drizzle/0000_init/migration.sql", "");
  w("CLAUDE.md", "# rules");
  w("test/a.test.ts", "");
  w("app/index.ts", "");
  w("node_modules/x/index.js", "");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:acme/shop.git");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "加购物车");
  return root;
}

/** python + uv + ruff + mypy（mypy 配了 files），英文提交、没有服务。pyproject 可以替换。 */
export function pythonRepo(pyproject = '[project]\nname = "ledger"\n\n[dependency-groups]\ndev = ["pytest", "ruff", "mypy"]\n\n[tool.mypy]\nstrict = true\nfiles = ["src"]\n') {
  const root = mkdtempSync(join(tmpdir(), "sc-onboard-py-"));
  writeFileSync(join(root, "pyproject.toml"), pyproject);
  writeFileSync(join(root, "uv.lock"), "");
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/test_db.py"), "");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:acme/ledger.git");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "Add expense listing");
  return root;
}
