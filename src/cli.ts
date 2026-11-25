#!/usr/bin/env node
// sandpipe 的命令行入口（在目标项目根目录运行）。用法见 help()。终端语言先按环境（SANDPIPE_LANG / LANG），读到项目配置后跟项目。
// sandpipe CLI entry (run in the target project's root). Usage is in help(). Terminal language starts from the environment (SANDPIPE_LANG / LANG) and follows the project once its config is loaded.
import { t } from "./term.ts";

const help = () =>
  t(
    `用法（在目标项目根目录运行）：
  sandpipe [run]       跑流水线；SANDCASTLE_ONLY=12,13 只做这几张票
  sandpipe onboard     接入新项目：生成 .sandcastle/ 配置与 PROJECT.md，装上下文预算 hook
                      [--no-agent] 不让 agent 补全 PROJECT.md；[--model <名>] agent 用的模型，默认 opus
                      [--lang zh|en] PROJECT.md 草稿和 issue / PR / 终端用的语言，默认按提交信息判断
  sandpipe doctor      跑之前的检查：配置、PROJECT.md、models.json、.env、平台登录、标签、镜像、hook
                      [--fix] 缺的标签直接建上
  sandpipe baseline    在沙箱里对 origin/main 跑一次完整门槛，只报告不开票（接入新项目时，见 docs/onboarding-checklist.zh-CN.md）
  sandpipe update      把项目 .claude/ 里本工具的 hook、子代理、skill 刷成当前版本，重写 .sandcastle/tsconfig.json（升级后跑）
  sandpipe upgrade     装 npm 上的最新版本（按安装方式用 npm 或 pnpm）
  sandpipe --version
  sandpipe --help

终端语言：项目配置的 language；没有项目配置时看 LANG。设 SANDPIPE_LANG=zh|en 可以强制指定。`,
    `Usage (run in the target project's root):
  sandpipe [run]       run the pipeline; SANDCASTLE_ONLY=12,13 only works these tickets
  sandpipe onboard     onboard a new project: generate the .sandcastle/ config and PROJECT.md, install the context budget hook
                      [--no-agent] don't let the agent complete PROJECT.md; [--model <name>] model for the agent, default opus
                      [--lang zh|en] language of the PROJECT.md draft and of issues / PRs / the terminal, default from the commit messages
  sandpipe doctor      pre-run checks: config, PROJECT.md, models.json, .env, forge login, labels, image, hook
                      [--fix] create missing labels
  sandpipe baseline    run the full gate once against origin/main in a sandbox, report only (when onboarding, see docs/onboarding-checklist.md)
  sandpipe update      refresh this tool's hook, subagent and skill under .claude/ and rewrite .sandcastle/tsconfig.json (run after upgrading)
  sandpipe upgrade     install the latest version from npm (with npm or pnpm, matching how it was installed)
  sandpipe --version
  sandpipe --help

Terminal language: the project config's language; without a project config, LANG. Set SANDPIPE_LANG=zh|en to force one.`,
  );

const [cmd = "run", ...rest] = process.argv.slice(2);

if (cmd === "run") await import("./main.ts");
else if (cmd === "baseline") {
  process.env.SANDCASTLE_BASELINE = "1";
  await import("./main.ts");
} else if (cmd === "onboard") (await import("./onboard.ts")).onboard(rest);
else if (cmd === "doctor") await (await import("./doctor.ts")).doctor(rest);
else if (cmd === "update") {
  const changed = (await import("./onboard.ts")).updateClaudeFiles(process.cwd());
  console.log(changed.length ? changed.map((f) => `✓ ${f}`).join("\n") : t("都是当前版本，没有改动。", "Everything is current; nothing changed."));
} else if (cmd === "upgrade") {
  const command = (await import("./version.ts")).upgradeCommand();
  const { execSync } = await import("node:child_process");
  console.log(command);
  execSync(command, { stdio: "inherit" });
  console.log(t("装好了。到各项目里跑 sandpipe update 刷新 .claude/ 下的文件和 .sandcastle/tsconfig.json。", "Installed. Run sandpipe update in each project to refresh the files under .claude/ and .sandcastle/tsconfig.json."));
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") console.log(help());
else if (cmd === "--version" || cmd === "-v") console.log((await import("./version.ts")).VERSION);
else {
  console.error(`${t("不认识的命令：", "Unknown command: ")}${cmd}\n\n${help()}`);
  process.exit(1);
}
