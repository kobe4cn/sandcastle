#!/usr/bin/env -S npx tsx
// sandcastle-pipeline 的命令行入口（在目标项目根目录运行）：
//   sandcastle-pipeline [run]       跑流水线（main.ts）；SANDCASTLE_ONLY=12,13 只做这几张票
//   sandcastle-pipeline onboard     接入新项目：生成 .sandcastle/ 配置与 PROJECT.md，装上下文预算 hook（onboard.ts）
//                       [--no-agent] 不让 agent 补全 PROJECT.md；[--model <名>] agent 用的模型，默认 opus
//   sandcastle-pipeline doctor      跑之前的检查：配置、PROJECT.md、models.json、.env、平台登录、标签、镜像、hook（doctor.ts）
//                       [--fix] 缺的标签直接建上
//   sandcastle-pipeline baseline    在沙箱里对 origin/main 跑一次完整门槛，只报告不开票（接入新项目时，见 docs/onboarding-checklist.md）
const [cmd = "run", ...rest] = process.argv.slice(2);

if (cmd === "run") await import("./main.ts");
else if (cmd === "baseline") {
  process.env.SANDCASTLE_BASELINE = "1";
  await import("./main.ts");
} else if (cmd === "onboard") (await import("./onboard.ts")).onboard(rest);
else if (cmd === "doctor") await (await import("./doctor.ts")).doctor(rest);
else {
  console.error(`不认识的命令：${cmd}。可用：run、onboard、doctor、baseline`);
  process.exit(1);
}
