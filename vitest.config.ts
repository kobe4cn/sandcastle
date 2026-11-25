import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 生成的项目配置 import "sandpipe"：运行时由 loadProject 的解析 hook 指回本工具，测试里由这个别名指过去。
// Generated project configs import "sandpipe": at runtime loadProject's resolve hook points it back at this tool; in tests this alias does.
// 终端语言固定为中文，测试结果不随机器的 LANG 变（英文输出单独测）。
// Terminal language is pinned to Chinese so results don't depend on the machine's LANG (English output is tested separately).
export default defineConfig({
  resolve: { alias: { "sandpipe": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: { env: { SANDPIPE_LANG: "zh" } },
});
