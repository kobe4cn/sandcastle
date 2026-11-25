// 打包：src/cli.ts（命令行）与 src/index.ts（给项目配置 import 的接口）→ dist/，压缩、共享模块拆成 chunk。
// 依赖（@ai-hero/sandcastle）不打进来，安装时从 npm 装。运行时按 import.meta.url 找 ../prompts、../templates 等，
// 所以 dist/ 必须是平铺的一层。
import { build } from "esbuild";
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
