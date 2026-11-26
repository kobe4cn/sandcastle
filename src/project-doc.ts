// PROJECT.md：一个项目交给 agent 的全部「项目知识」——结构、命令、测试、规范、红线、冲突处理、验收方式。
//
// 提示词模板（prompts/*.md）是通用的，不写任何项目的路径或命令；项目相关的内容一律放在
// `.sandcastle/PROJECT.md` 的固定章节里，启动时按章节切开、填进模板的 {{P_…}} 占位符，渲染成临时文件
// 交给 sandcastle 的 promptFile。运行时才知道的参数（TASK_ID、BRANCH……）仍走 promptArgs，由上游替换。
//
// 为什么注入而不是让 agent 自己去读 PROJECT.md：每个阶段只需要其中几节，注入能保证读到、又不多花上下文。
// PROJECT.md: all the "project knowledge" handed to the agent: structure, commands, tests, standards, red lines, conflict handling, verification.
// Prompt templates (prompts/*.md) are generic and contain no project paths or commands; everything project-specific lives in
// fixed sections of `.sandcastle/PROJECT.md`, which are split at startup, filled into the templates' {{P_…}} placeholders, rendered to temp files
// and given to sandcastle's promptFile. Parameters known only at run time (TASK_ID, BRANCH…) still go through promptArgs, replaced upstream.
// Why inject instead of letting the agent read PROJECT.md: each phase needs only a few sections, and injecting guarantees they are read without spending extra context.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./profile.ts";
import { messages, type Language, type Messages } from "./i18n.ts";
import { t } from "./term.ts";

export const PROJECT_DOC = "PROJECT.md";

/**
 * PROJECT.md 的固定章节：键 → `## 标题`。标题就是契约，改名要同步模板和 examples。
 * Fixed sections of PROJECT.md: key → `## title`. The titles are the contract; renaming one means updating the template and examples.
 */
export const SECTIONS = {
  overview: "概况",
  environment: "运行环境",
  commands: "开发命令",
  testing: "测试",
  standards: "编码规范",
  domain: "领域与文档",
  redLines: "必须停下",
  conflicts: "合并冲突",
  browser: "浏览器验收",
  humanCheck: "人工验收",
  commit: "提交",
} as const;
export type SectionKey = keyof typeof SECTIONS;

/**
 * 英文项目用的同一组章节标题（language: en 时 onboard 按这套写）；两套都认，同一节只能写一次。
 * The same sections with English titles (onboard writes these for language: en); both sets are recognized, each section only once.
 */
export const SECTIONS_EN: Record<SectionKey, string> = {
  overview: "Overview",
  environment: "Environment",
  commands: "Commands",
  testing: "Testing",
  standards: "Coding standards",
  domain: "Domain and docs",
  redLines: "Stop and ask",
  conflicts: "Merge conflicts",
  browser: "Browser check",
  humanCheck: "Human check",
  commit: "Commits",
};

const keyOfTitle = new Map<string, SectionKey>(
  (Object.keys(SECTIONS) as SectionKey[]).flatMap((k) => [
    [SECTIONS[k], k],
    [SECTIONS_EN[k], k],
  ]),
);

const REQUIRED: SectionKey[] = ["overview", "commands", "testing", "commit"];

/** 可选章节没写时填进提示词的话。 / Text put into the prompts when an optional section is missing. */
const MISSING: Record<SectionKey, string> = {
  overview: "",
  environment: "（本项目没有写运行环境：测试需要的外部服务已经由编排脚本配好，不要改连接配置。）",
  commands: "",
  testing: "",
  standards: "（本项目没有额外的编码规范。）",
  domain: "（本项目没有单独的领域文档。）",
  redLines: "（本项目没有额外的红线。）",
  conflicts: "（本项目没有特殊的冲突处理规则。）",
  browser: "",
  humanCheck: "（本项目没有写人工验收环境：按 README 的启动方式写步骤。）",
  commit: "",
};

export type ProjectDoc = Record<SectionKey, string> & { hasBrowser: boolean };

/**
 * 按 `## 标题` 切成章节；代码块里的 `## ` 不算标题。未知标题报错，防止写错字后整节静默丢失。
 * Split into sections by `## title`; `## ` inside code blocks doesn't count. Unknown titles are errors, so a typo can't silently drop a section.
 */
export function parseProjectDoc(md: string, file = PROJECT_DOC): ProjectDoc {
  const byKey = new Map<SectionKey, string[]>();
  const unknown: string[] = [];
  let current: string[] | undefined;
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^## (.+?)\s*$/.exec(line);
    if (heading) {
      const key = keyOfTitle.get(heading[1]);
      current = [];
      if (!key) unknown.push(heading[1]);
      else if (byKey.has(key))
        throw new Error(t(`${file}：章节「${heading[1]}」写了两次（中英文标题算同一节）`, `${file}: section "${heading[1]}" appears twice (Chinese and English titles count as the same section)`));
      else byKey.set(key, current);
    } else {
      current?.push(line);
    }
  }
  const known = [...keyOfTitle.keys()];
  if (unknown.length > 0) {
    throw new Error(
      t(
        `${file}：不认识的章节${unknown.map((x) => `「${x}」`).join("、")}；只能用 ${known.map((x) => `「${x}」`).join("、")}`,
        `${file}: unknown section(s) ${unknown.map((x) => `"${x}"`).join(", ")}; allowed: ${known.map((x) => `"${x}"`).join(", ")}`,
      ),
    );
  }
  const doc = {} as ProjectDoc;
  const missing: string[] = [];
  for (const [key, zhTitle] of Object.entries(SECTIONS) as [SectionKey, string][]) {
    const title = t(zhTitle, SECTIONS_EN[key]);
    // HTML 注释是模板里给人看的填写说明，不进提示词 / HTML comments are filling instructions for humans in the template and don't go into the prompts
    const body = (byKey.get(key) ?? [])
      .join("\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (body.includes("!`"))
      throw new Error(
        t(
          `${file}「${title}」里有 !\`…\`：提示词里这是「执行命令并替换」的语法，命令请写成普通的 \`…\``,
          `${file} "${title}" contains !\`…\`: in prompts that means "run the command and substitute its output"; write commands as plain \`…\``,
        ),
      );
    if (!body && REQUIRED.includes(key)) missing.push(title);
    doc[key] = body || MISSING[key];
  }
  if (missing.length > 0)
    throw new Error(
      t(`${file} 缺少必填章节（或内容为空）：${missing.map((x) => `「${x}」`).join("、")}`, `${file} is missing required sections (or they're empty): ${missing.map((x) => `"${x}"`).join(", ")}`),
    );
  doc.hasBrowser = doc.browser !== "";
  return doc;
}

/** 读配置目录（见 configDir）里的 PROJECT.md。 / Read PROJECT.md from the config directory (see configDir). */
export function loadProjectDoc(dir = configDir()): ProjectDoc {
  const file = join(dir, PROJECT_DOC);
  if (!existsSync(file)) throw new Error(t(`找不到 ${file}：先跑 sandpipe onboard 生成，或按 templates/.sandcastle/PROJECT.md 写一份`, `${file} not found: run sandpipe onboard, or write one following templates/.sandcastle/PROJECT.md`));
  return parseProjectDoc(readFileSync(file, "utf8"), file);
}

// ---- 提示词渲染 ---- / Prompt rendering

export const PROMPT_NAMES = ["implement", "review", "prep", "rebase"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

const PACKAGE_PROMPTS = fileURLToPath(new URL("../prompts/", import.meta.url));

/**
 * 项目可以在配置目录的 `prompts/<name>.md` 放自己的版本整份替换；共享片段（decisions、coding-standards…）同理。
 * A project can replace a template wholesale with `prompts/<name>.md` in its config directory; same for shared fragments (decisions, coding-standards…).
 */
export function readPromptSource(name: string, dir = configDir()): string {
  const own = join(dir, "prompts", `${name}.md`);
  return readFileSync(existsSync(own) ? own : join(PACKAGE_PROMPTS, `${name}.md`), "utf8");
}

/**
 * 渲染期替换的占位符：{{P_…}}（PROJECT.md 章节）、{{DOC_…}}（共享片段）、{{L_…}}（标签名）、{{LANG_…}}（按项目语言的固定格式）、{{FORGE}}、{{IF_BROWSER}}…{{END_BROWSER}}。
 * Placeholders replaced at render time: {{P_…}} (PROJECT.md sections), {{DOC_…}} (shared fragments), {{L_…}} (label names), {{LANG_…}} (language-specific fixed formats), {{FORGE}}, {{IF_BROWSER}}…{{END_BROWSER}}.
 */
export type StaticVars = Record<string, string>;

const STATIC_PLACEHOLDER = /\{\{\s*((?:P|DOC|L|LANG)_[A-Z_]+|FORGE)\s*\}\}/g;

/**
 * 只替换渲染期占位符；其余 {{X}} 原样留给上游在运行时替换。未知的渲染期占位符报错。
 * Only render-time placeholders are replaced; other {{X}} are left for upstream to replace at run time. Unknown render-time placeholders are errors.
 */
export function renderTemplate(template: string, vars: StaticVars, opts: { browser: boolean }): string {
  const withBranches = template.replace(
    /\{\{IF_BROWSER\}\}([\s\S]*?)\{\{ELSE_BROWSER\}\}([\s\S]*?)\{\{END_BROWSER\}\}/g,
    (_, yes: string, no: string) => (opts.browser ? yes : no),
  );
  return withBranches.replace(STATIC_PLACEHOLDER, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(t(`提示词里的 {{${key}}} 没有对应的值`, `{{${key}}} in a prompt has no value`));
    return value;
  });
}

const constName = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

export const sectionVars = (doc: ProjectDoc): StaticVars =>
  Object.fromEntries((Object.keys(SECTIONS) as SectionKey[]).map((key) => [`P_${constName(key)}`, doc[key]]));

/** 标签名：{{L_PICKED}}、{{L_READY_FOR_AGENT}}…… / Label names: {{L_PICKED}}, {{L_READY_FOR_AGENT}}… */
export const labelVars = (labels: Record<string, string>): StaticVars =>
  Object.fromEntries(Object.entries(labels).map(([key, name]) => [`L_${constName(key)}`, name]));

/**
 * 按项目语言的固定格式：{{LANG_H_WHAT}} 等是验收说明必须有的三个小标题（脚本按它们检查，见 pr-body.ts）；{{LANG_PROFILE_LINE}} 是进度评论第一行的前缀。
 * Language-specific fixed formats: {{LANG_H_WHAT}} etc. are the three headings acceptance notes must have (the script checks them, see pr-body.ts); {{LANG_PROFILE_LINE}} prefixes the first line of progress comments.
 */
export const languageVars = (m: Messages): StaticVars => {
  const [what, verify, result] = m.noteHeadings;
  return { LANG_H_WHAT: what, LANG_H_VERIFY: verify, LANG_H_RESULT: result, LANG_PROFILE_LINE: m.profileLine };
};

/** 渲染全部提示词，写进临时目录，返回各自的绝对路径（给 promptFile）。 / Render all prompts into a temp directory and return their absolute paths (for promptFile). */
export function renderPrompts(args: {
  doc: ProjectDoc;
  forgeGuide: string;
  labels: Record<string, string>;
  /** 配置目录，默认 configDir() / Config directory, default configDir() */
  dir?: string;
  /** issue / PR / 评论的语言（项目配置 language），默认中文 / Language for issues / PRs / comments (project config language), Chinese by default */
  language?: Language;
}): Record<PromptName, string> {
  const { doc, forgeGuide, labels, dir: confDir = configDir(), language } = args;
  const m = messages(language);
  const base: StaticVars = { ...sectionVars(doc), ...labelVars(labels), ...languageVars(m), FORGE: forgeGuide };
  const shared = (name: string) => renderTemplate(readPromptSource(name, confDir), base, { browser: doc.hasBrowser });
  const vars: StaticVars = {
    ...base,
    DOC_DECISIONS: shared("decisions"),
    DOC_STANDARDS: shared("coding-standards"),
    DOC_TICKET_SIZING: shared("ticket-sizing"),
  };
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-prompts-"));
  const out = {} as Record<PromptName, string>;
  for (const name of PROMPT_NAMES) {
    const file = join(dir, `${name}.md`);
    writeFileSync(file, `${m.outputLanguage}\n\n${renderTemplate(readPromptSource(name, confDir), vars, { browser: doc.hasBrowser })}`);
    out[name] = file;
  }
  return out;
}
