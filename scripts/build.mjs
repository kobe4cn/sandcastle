// 打包：src/cli.ts（命令行）与 src/index.ts（给项目配置 import 的接口）→ dist/，压缩、共享模块拆成 chunk。
// 依赖（@ai-hero/sandcastle）不打进来，安装时从 npm 装。运行时按 import.meta.url 找 ../prompts、../templates 等，
// 所以 dist/ 必须是平铺的一层。
// 类型声明（tsc）放 dist/types/：package.json 的 types 和目标项目 .sandcastle/tsconfig.json 的 paths 指向它。
// Bundling: src/cli.ts (CLI) and src/index.ts (API imported by project configs) → dist/, minified, shared modules split into chunks.
// The dependency (@ai-hero/sandcastle) isn't bundled; it's installed from npm. At runtime ../prompts, ../templates etc. are found via import.meta.url,
// so dist/ must be one flat level.
// Type declarations (tsc) go to dist/types/: package.json's types and the target project's .sandcastle/tsconfig.json paths point there.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: { cli: "src/cli.ts", index: "src/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  minify: true,
  chunkNames: "chunk-[hash]",
  legalComments: "none",
  logLevel: "info",
});
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
