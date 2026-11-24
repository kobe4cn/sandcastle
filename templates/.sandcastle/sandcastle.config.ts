// Sandcastle 项目配置：编排脚本里随项目变的部分。字段说明见 sandcastle-pipeline 的 src/profile.ts，
// 完整例子见 examples/duckdb_crm/sandcastle.config.ts。
import { defineProject } from "sandcastle-pipeline";

export default defineProject({
  // forge: githubForge(),          // 默认 GitHub（宿主机的 gh）
  // maxParallel: 2,                // 同时实现几张票：受测试依赖的服务与机器负载限制

  install: {
    // 沙箱建好后装依赖（容器是 linux，宿主机拷进来的原生包可能用不了）
    onSandboxReady: "npm ci",
    // copyToWorktree: ["node_modules"],
  },

  isolation: {
    // 每张票（runId）独立的测试环境：库名、前缀加 runId，并行的沙箱互不干扰
    env: (runId) => ({ TEST_RUN_SUFFIX: `_i${runId}` }),
    // cleanup: async (runId) => { /* 删掉这张票的测试库 */ },
  },

  gate: {
    // 合并门槛，退出码 0 算通过；输出约定见 src/profile.ts 的 GateConfig
    script: () => "npm run typecheck && npm test",
    testFile: /test\/\S+\.test\.tsx?/,
    typecheck: "npm run typecheck",
  },

  // integrity: { name: "迁移链", command: (head, baseRef) => "...", broken: (baseRef) => "..." },
  // appendOnlyFiles: ["CHANGELOG.md"],
});
