import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 生成的项目配置 import "sandcastle-pipeline"：运行时由 loadProject 的解析 hook 指回本工具，测试里由这个别名指过去。
export default defineConfig({
  resolve: { alias: { "sandcastle-pipeline": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
});
