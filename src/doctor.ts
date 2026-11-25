// doctor：跑流水线之前把能在宿主机上查的都查一遍，每项给出结论和修法。
// 查：仓库根目录、配置能加载、PROJECT.md 与提示词能渲染、models.json、.env 的 token、平台登录与权限、
// 标签（--fix 时补建）、远端基础分支、沙箱镜像、上下文预算 hook、.gitignore 里的工作目录。
// 有一项 ✗ 退出码就是 1。

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Forge } from "./forge.ts";
import { inspectModels } from "./models.ts";
import { HOOK_FILE, mergeGitignore } from "./onboard.ts";
import { configDir, loadProject, type Labels, type Project } from "./profile.ts";
import { loadProjectDoc, renderPrompts } from "./project-doc.ts";
import { trySh, type TryResult } from "./shell.ts";

export type Level = "ok" | "warn" | "fail";
export type Check = { name: string; level: Level; detail: string; fix?: string };
export type Runner = (cmd: string, args: string[]) => TryResult;

const ENV_FILE = ".sandcastle/.env";
const CLAUDE_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/** --fix 补建标签用的颜色和说明。 */
const LABEL_META: Record<keyof Labels, [color: string, description: string]> = {
  picked: ["5319e7", "交给 Sandcastle 无人值守地做"],
  prepped: ["c5def5", "Sandcastle prep 已确认可实现"],
  prOpen: ["0e8a16", "Sandcastle 已开 PR，等人审"],
  stuck: ["d93f0b", "Sandcastle 做不下去，需要人介入（见评论）"],
  decided: ["fef2c0", "agent 代拍板过设计决定，等人事后确认"],
  flaky: ["fbca04", "偶发失败的测试（Sandcastle 门槛自动开票）"],
  mainBroken: ["d73a4a", "main 上的兜底完整测试失败（Sandcastle 自动开票）"],
  readyForAgent: ["0075ca", "可以交给 agent 做"],
  readyForHuman: ["e4e669", "需要人来做"],
};

/** 流水线第一次用到时自己建（main.ts 里 ensureLabel），缺了不算问题。 */
const AUTO_LABELS: (keyof Labels)[] = ["flaky", "mainBroken"];

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function diagnose(opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  /** 测试里换成假实现；默认用配置里的 forge */
  forge?: Forge;
  /** 缺的标签直接建上 */
  fix?: boolean;
}): Promise<Check[]> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const run: Runner = opts.run ?? ((cmd, args) => trySh(cmd, args, 60_000));
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string, fix?: string) => checks.push({ name, level, detail, fix });
  const rel = (p: string) => relative(cwd, p) || ".";

  // ---- 仓库 ----
  const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!top.ok) add("仓库", "fail", "当前目录不是 git 仓库", "在目标项目的根目录运行");
  else if (realpathSync(top.out.trim()) !== realpathSync(cwd))
    add("仓库", "fail", `不在仓库根目录（根目录是 ${top.out.trim()}）`, "cd 到仓库根目录再运行");
  else add("仓库", "ok", cwd);

  // ---- 配置 ----
  const dir = configDir(cwd, env);
  let project: Project | undefined;
  try {
    project = await loadProject(dir);
    add("配置", "ok", rel(join(dir, "sandcastle.config.ts")));
  } catch (e) {
    add("配置", "fail", errText(e), "没有配置先跑 sandcastle-pipeline onboard");
  }
  const forge = opts.forge ?? project?.forge;

  // ---- PROJECT.md 与提示词 ----
  try {
    const doc = loadProjectDoc(dir);
    if (project && forge)
      rmSync(dirname(Object.values(renderPrompts({ doc, forgeGuide: forge.agentGuide(), labels: project.labels, dir }))[0]!), {
        recursive: true,
      });
    const source = readFileSync(join(dir, "PROJECT.md"), "utf8");
    const browser = doc.hasBrowser ? "有浏览器验收" : "没有「浏览器验收」：改页面的票会留给人看";
    const todo = source.match(/<!--\s*待补/g)?.length ?? 0;
    if (todo) add("PROJECT.md", "warn", `还有 ${todo} 处「待补」，是没写完的草稿；${browser}`, "跑 onboard 让 agent 补全，或手工写完");
    else add("PROJECT.md", "ok", `能渲染进提示词；${browser}`);
  } catch (e) {
    add("PROJECT.md", "fail", errText(e));
  }

  // ---- models.json ----
  let models: ReturnType<typeof inspectModels> | undefined;
  try {
    models = withCwd(cwd, inspectModels);
    const summary = Object.entries(models.phases)
      .map(([p, list]) => `${p}=${list.join("→")}`)
      .join(" ");
    if (models.warnings.length) add("models.json", "warn", `${summary}；${models.warnings.join("；")}`);
    else add("models.json", "ok", summary);
  } catch (e) {
    add("models.json", "fail", errText(e), "照 templates/.sandcastle/models.json 改；引用的 ${VAR} 要在 .sandcastle/.env 里列出");
  }

  // ---- .env ----
  const envPath = join(cwd, ENV_FILE);
  if (!existsSync(envPath)) {
    add(".env", "fail", `没有 ${ENV_FILE}`, `cp ${ENV_FILE}.example ${ENV_FILE}，填 token`);
  } else {
    const vars = parseEnv(readFileSync(envPath, "utf8"));
    const has = (k: string) => k in vars && Boolean(vars[k] || env[k]);
    const missing: string[] = [];
    // 有阶段用 Claude 自家的档案（没设 ANTHROPIC_BASE_URL）才要 Claude 凭据
    if ((!models || models.used.some((p) => !p.thirdParty)) && !CLAUDE_KEYS.some(has)) missing.push(CLAUDE_KEYS.join(" 或 "));
    if (forge && !has(forge.tokenEnv)) missing.push(forge.tokenEnv);
    const ignored = run("git", ["-C", cwd, "check-ignore", "-q", ENV_FILE]).ok;
    if (!ignored) add(".env", "fail", `${ENV_FILE} 没被 git 忽略，token 会被提交`, "在 .sandcastle/.gitignore 里加一行 .env");
    else if (missing.length)
      add(
        ".env",
        "fail",
        `缺 ${missing.join("、")}（文件里要列出这个键；值可以空着、取宿主机的同名环境变量）`,
        "Claude 订阅的 token 用 claude setup-token 生成",
      );
    else add(".env", "ok", "token 齐全，已被 git 忽略");
  }

  // ---- 平台与标签 ----
  if (forge && project) {
    let reachable = false;
    try {
      add(`平台（${forge.name}）`, "ok", forge.checkAccess());
      reachable = true;
    } catch (e) {
      add(`平台（${forge.name}）`, "fail", errText(e));
    }
    if (reachable) {
      try {
        const existing = new Set(forge.listLabels());
        const missing = (Object.keys(project.labels) as (keyof Labels)[]).filter((k) => !existing.has(project.labels[k]));
        const names = (keys: (keyof Labels)[]) => keys.map((k) => project.labels[k]).join("、");
        const required = missing.filter((k) => !AUTO_LABELS.includes(k));
        const later = missing.length > required.length ? `；${names(missing.filter((k) => AUTO_LABELS.includes(k)))} 用到时自动建` : "";
        if (!missing.length) add("标签", "ok", `${Object.keys(project.labels).length} 个都在`);
        else if (opts.fix) {
          for (const k of missing) forge.ensureLabel(project.labels[k], ...LABEL_META[k]);
          add("标签", "ok", `补建了 ${names(missing)}`);
        } else if (required.length) {
          add("标签", "fail", `缺 ${names(required)}：给票打标签会失败${later}`, "sandcastle-pipeline doctor --fix 补建");
        } else add("标签", "ok", `都在${later}`);
      } catch (e) {
        add("标签", "fail", errText(e));
      }
    }

    const ref = `refs/heads/${project.baseBranch}`;
    const remote = run("git", ["-C", cwd, "ls-remote", "--exit-code", project.remote, ref]);
    if (remote.ok) add("远端分支", "ok", `${project.remote}/${project.baseBranch}`);
    else
      add(
        "远端分支",
        "fail",
        `${project.remote} 上没有 ${project.baseBranch}：${firstLine(remote.out)}`,
        "检查配置里的 remote / baseBranch",
      );
  }

  // ---- 沙箱镜像 ----
  if (project?.customSandbox) {
    add("沙箱镜像", "ok", "配置里自定义了 sandbox，不查 podman");
  } else if (project) {
    const image = defaultImageName(cwd);
    const containerfile = [join(dir, "Containerfile"), join(cwd, ".sandcastle/Containerfile")].find(existsSync);
    const build = containerfile
      ? `podman build -t ${image} -f ${rel(containerfile)} ${rel(dirname(containerfile))}`
      : "先跑 onboard 生成 Containerfile";
    const info = run("podman", ["info", "--format", "{{.Host.Arch}}"]);
    if (!info.ok) add("沙箱镜像", "fail", `podman 用不了：${firstLine(info.out)}`, "装 podman；macOS 上 podman machine start");
    else if (!run("podman", ["image", "exists", image]).ok) add("沙箱镜像", "fail", `没有镜像 ${image}`, build);
    else add("沙箱镜像", "ok", `${image}（改了 Containerfile 要重建：${build}）`);
  }

  // ---- 上下文预算 hook ----
  const settingsPath = join(cwd, ".claude/settings.json");
  const registered = existsSync(settingsPath) && readFileSync(settingsPath, "utf8").includes(HOOK_FILE);
  const present = existsSync(join(cwd, ".claude/hooks", HOOK_FILE));
  if (registered && present) add("上下文 hook", "ok", `.claude/hooks/${HOOK_FILE}`);
  else
    add(
      "上下文 hook",
      "warn",
      `${present ? "" : "没有 hook 文件；"}${registered ? "" : "settings.json 里没登记；"}会话到预算时不会提醒收尾`,
      "跑 onboard 补上（不覆盖已有文件）",
    );

  // ---- .gitignore ----
  const ignorePath = join(cwd, ".gitignore");
  if (mergeGitignore(existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "") === undefined)
    add(".gitignore", "ok", "流水线的工作目录都已忽略");
  else add(".gitignore", "warn", "缺 .browser-check/ 等工作目录：implementer 的 git add -A 会把截图和验收说明提交进去", "跑 onboard 补上");

  return checks;
}

/** models.ts 按 cwd 读 .sandcastle/models.json 与 .env。 */
function withCwd<T>(cwd: string, fn: () => T): T {
  const before = process.cwd();
  if (resolve(before) === resolve(cwd)) return fn();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

const MARK: Record<Level, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  return checks
    .flatMap((c) => [`${MARK[c.level]} ${c.name}：${c.detail}`, ...(c.level !== "ok" && c.fix ? [`    → ${c.fix}`] : [])])
    .join("\n");
}

export async function doctor(argv: string[]) {
  const checks = await diagnose({ fix: argv.includes("--fix") });
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  console.log(
    failed ? `\n${failed} 项不通过${warned ? `，${warned} 项警告` : ""}。` : `\n可以跑了${warned ? `（${warned} 项警告）` : ""}。`,
  );
  if (failed) process.exitCode = 1;
}
