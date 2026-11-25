#!/usr/bin/env node
// sandpipe 的命令行入口（在目标项目根目录运行）。用法见 HELP。
const HELP = `用法（在目标项目根目录运行）：
  sandpipe [run]       跑流水线（main.ts）；SANDCASTLE_ONLY=12,13 只做这几张票
  sandpipe onboard     接入新项目：生成 .sandcastle/ 配置与 PROJECT.md，装上下文预算 hook（onboard.ts）
                      [--no-agent] 不让 agent 补全 PROJECT.md；[--model <名>] agent 用的模型，默认 opus
  sandpipe doctor      跑之前的检查：配置、PROJECT.md、models.json、.env、平台登录、标签、镜像、hook（doctor.ts）
                      [--fix] 缺的标签直接建上
  sandpipe baseline    在沙箱里对 origin/main 跑一次完整门槛，只报告不开票（接入新项目时，见 docs/onboarding-checklist.md）
  sandpipe update      把项目 .claude/ 里本工具的 hook、子代理、skill 刷成当前版本，重写 .sandcastle/tsconfig.json（升级后跑）
  sandpipe upgrade     装 npm 上的最新版本（按安装方式用 npm 或 pnpm）
  sandpipe --version
  sandpipe --help`;

const [cmd = "run", ...rest] = process.argv.slice(2);

if (cmd === "run") await import("./main.ts");
else if (cmd === "baseline") {
  process.env.SANDCASTLE_BASELINE = "1";
  await import("./main.ts");
} else if (cmd === "onboard") (await import("./onboard.ts")).onboard(rest);
else if (cmd === "doctor") await (await import("./doctor.ts")).doctor(rest);
else if (cmd === "update") {
  const changed = (await import("./onboard.ts")).updateClaudeFiles(process.cwd());
  console.log(changed.length ? changed.map((f) => `✓ ${f}`).join("\n") : "都是当前版本，没有改动。");
} else if (cmd === "upgrade") {
  const command = (await import("./version.ts")).upgradeCommand();
  const { execSync } = await import("node:child_process");
  console.log(command);
  execSync(command, { stdio: "inherit" });
  console.log("装好了。到各项目里跑 sandpipe update 刷新 .claude/ 下的文件和 .sandcastle/tsconfig.json。");
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") console.log(HELP);
else if (cmd === "--version" || cmd === "-v") console.log((await import("./version.ts")).VERSION);
else {
  console.error(`不认识的命令：${cmd}\n\n${HELP}`);
  process.exit(1);
}
