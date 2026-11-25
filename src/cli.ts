#!/usr/bin/env -S npx tsx
// sandcastle-pipeline 的命令行入口（在目标项目根目录运行）：
//   sandcastle-pipeline [run]       跑流水线（main.ts）；SANDCASTLE_ONLY=12,13 只做这几张票
//   sandcastle-pipeline onboard     接入新项目：生成 .sandcastle/ 配置与 PROJECT.md，装上下文预算 hook（onboard.ts）
//                       [--no-agent] 不让 agent 补全 PROJECT.md；[--model <名>] agent 用的模型，默认 opus
const [cmd = "run", ...rest] = process.argv.slice(2);

if (cmd === "run") await import("./main.ts");
else if (cmd === "onboard") (await import("./onboard.ts")).onboard(rest);
else {
  console.error(`不认识的命令：${cmd}。可用：run、onboard`);
  process.exit(1);
}
