// PROJECT.md 的解析与提示词渲染：模板里不能有项目细节，项目细节一条不少地进到对应阶段。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubForge } from "../src/forges/github.ts";
import { DEFAULT_LABELS } from "../src/profile.ts";
import { parseProjectDoc, projectDocWatcher, PROMPT_NAMES, readPromptSource, renderPrompts, renderTemplate } from "../src/project-doc.ts";

const crmDoc = readFileSync(new URL("../examples/duckdb_crm/PROJECT.md", import.meta.url), "utf8");
const templateDoc = readFileSync(new URL("../templates/.sandcastle/PROJECT.md", import.meta.url), "utf8");
const emptyCwd = mkdtempSync(join(tmpdir(), "sc-test-"));

const minimal = (extra = "") =>
  ["## 概况", "一个服务", "## 开发命令", "`make check`", "## 测试", "`make test`", "## 提交", "英文提交信息", extra].join("\n");

const render = (md: string, language?: "zh" | "en") => {
  const files = renderPrompts({
    doc: parseProjectDoc(md),
    forgeGuide: githubForge(() => "").agentGuide(),
    labels: DEFAULT_LABELS,
    dir: emptyCwd,
    ...(language ? { language } : {}),
  });
  return Object.fromEntries(PROMPT_NAMES.map((n) => [n, readFileSync(files[n], "utf8")])) as Record<(typeof PROMPT_NAMES)[number], string>;
};

/** 每个阶段在运行时由 main.ts 经 promptArgs 提供的参数 */
const RUNTIME_ARGS = {
  implement: ["TASK_ID", "ISSUE_TITLE", "BRANCH"],
  review: ["TASK_ID", "BRANCH", "BASE", "ROUND", "REVISE_MAX"],
  prep: ["TASK_ID", "REPREP_MARK", "BASE"],
  rebase: ["TASK_ID", "BRANCH", "BASE", "SITUATION"],
  "re-review": ["TASK_ID", "BRANCH", "KIND", "DIFF_CMD"],
};

describe("parseProjectDoc", () => {
  it("按 ## 标题切章节，HTML 注释不进内容，代码块里的 ## 不算标题，可选章节填默认话", () => {
    const doc = parseProjectDoc(minimal("## 合并冲突\n<!-- 说明 -->\n```md\n## 概况\n```"));
    expect(doc.overview).toBe("一个服务");
    expect(doc.conflicts).toBe("```md\n## 概况\n```");
    expect(doc.redLines).toContain("没有额外的红线");
    expect(doc.hasBrowser).toBe(false);
  });

  it("缺必填章节、只有注释的必填章节都报错", () => {
    expect(() => parseProjectDoc("## 概况\nx")).toThrow(/开发命令.*测试.*提交/);
    expect(() => parseProjectDoc(templateDoc)).toThrow(/缺少必填章节.*概况.*开发命令.*测试.*提交/);
  });

  it("不认识的标题、重复标题、!`…` 都报错", () => {
    expect(() => parseProjectDoc(minimal("## 部署\nx"))).toThrow(/不认识的章节「部署」/);
    expect(() => parseProjectDoc(minimal("## 概况\ny"))).toThrow(/写了两次/);
    expect(() => parseProjectDoc(minimal("## 运行环境\n!`env`"))).toThrow(/!`/);
  });
});

describe("renderTemplate", () => {
  it("只换渲染期占位符，运行时的留给上游；未知的渲染期占位符报错", () => {
    expect(renderTemplate("{{P_A}} {{TASK_ID}} {{IF_BROWSER}}有{{ELSE_BROWSER}}无{{END_BROWSER}}", { P_A: "a" }, { browser: false })).toBe(
      "a {{TASK_ID}} 无",
    );
    expect(() => renderTemplate("{{P_NOPE}}", {}, { browser: true })).toThrow(/P_NOPE/);
  });
});

describe("通用提示词模板", () => {
  it("不含任何项目或平台的细节", () => {
    for (const name of [...PROMPT_NAMES, "decisions", "coding-standards", "ticket-sizing"]) {
      const src = readPromptSource(name, emptyCwd);
      expect(src, name).not.toMatch(/crm|i18n|drizzle|CATALOG|npm run|vitest|CLAUDE\.md|ADR-\d|\bgh (issue|pr|api)\b|origin\/main/i);
    }
  });
});

describe("用 duckdb_crm 的 PROJECT.md 渲染", () => {
  const out = render(crmDoc);

  it("渲染后只剩运行时参数，并且和 main.ts 传的一致", () => {
    for (const name of PROMPT_NAMES) {
      const left = new Set([...out[name].matchAll(/\{\{\s*([A-Za-z_]+)\s*\}\}/g)].map((m) => m[1]));
      expect([...left].sort(), name).toEqual([...RUNTIME_ARGS[name]].sort());
    }
  });

  it("只有 review 有 !`…` 命令块（两条 git）", () => {
    expect(out.review.match(/!`/g)).toHaveLength(2);
    for (const name of ["implement", "prep", "rebase", "re-review"] as const) expect(out[name], name).not.toContain("!`");
  });

  it("原提示词里的项目规则都到了对应阶段", () => {
    expect(out.implement).toContain("npm run i18n:ratchet");
    expect(out.implement).toContain("scripts/browser-lab.ts");
    expect(out.implement).toContain("crm_platform");
    expect(out.implement).toContain("test/CATALOG.md");
    expect(out.implement).toContain("cmpName");
    expect(out.review).toContain("cmpName");
    expect(out.review).toContain("改了页面的：`.browser-check/RESULT.md` 存在");
    expect(out.review).toContain("<browser-check>missing</browser-check>");
    expect(out.review).toContain("租户隔离");
    expect(out.rebase).toContain("npm run db:generate -- --name <原来的名字>");
    expect(out.rebase).toContain("i18n-ratchet-baseline.json");
    expect(out.prep).toContain("docs/adr/README.md");
    expect(out.prep).toContain('gh issue edit <n> --add-label "<label>"');
    expect(out.prep).toContain("`sandcastle:prepped`");
    expect(out.prep).toContain("/fill-project-docs");
  });

  it("票里写了待决定项但没写明选了哪个时，不从标签推断、交给人（#18）", () => {
    expect(out.prep).toContain("不代表待决定项已经选好");
    expect(out.prep).toContain("先看正文有没有没决定的选项");
    for (const name of ["prep", "implement", "review"] as const) {
      expect(out[name], name).toContain("票里写了但没写明选了哪个的设计决定");
      expect(out[name], name).toContain("不管票带什么标签都交给人");
      expect(out[name], name).toContain("没写明选了哪个的待决定项，也一律归这一类，不能代选");
    }
    expect(out.review).toContain("decided 评论选的正好是票正文列出的待决定项");
    expect(out.review).toContain("decided 评论的内容碰了「必须停下」");
  });
});

describe("没有浏览器验收的项目", () => {
  const out = render(minimal());

  it("implement 不提 playwright，review 把改页面的票留给人", () => {
    expect(out.implement).not.toContain("playwright");
    expect(out.implement).toContain("本项目不做沙箱里的浏览器验收");
    expect(out.review).toContain("没有改页面");
    expect(out.review).not.toContain("RESULT.md` 存在");
    expect(out.review).toContain("<browser-check>missing</browser-check>");
  });
});

describe("进度评论第一行跟随项目语言", () => {
  it("中文项目写「模型档案：」，英文项目写「Model profile: 」", () => {
    expect(render(minimal()).implement).toContain("第一行写 `模型档案：<档案名>`");
    const en = render(minimal(), "en").implement;
    expect(en).toContain("第一行写 `Model profile: <档案名>`");
    expect(en).not.toContain("模型档案：");
  });
});

describe("projectDocWatcher：运行中改了 PROJECT.md 只提醒一次（#52）", () => {
  it("内容不变返回 false", () => {
    const changed = projectDocWatcher(() => "原文");
    expect(changed()).toBe(false);
    expect(changed()).toBe(false);
  });

  it("改了返回 true，下一轮没再变返回 false，又改了再返回 true", () => {
    let text = "原文";
    const changed = projectDocWatcher(() => text);
    text = "改一";
    expect(changed()).toBe(true);
    expect(changed()).toBe(false);
    text = "改二";
    expect(changed()).toBe(true);
    expect(changed()).toBe(false);
  });

  it("改回启动时的内容返回 false", () => {
    let text = "原文";
    const changed = projectDocWatcher(() => text);
    text = "改一";
    expect(changed()).toBe(true);
    text = "原文";
    expect(changed()).toBe(false);
  });

  it("改回原文后再改成报过的内容，算一次新的修改，再报一次", () => {
    let text = "原文";
    const changed = projectDocWatcher(() => text);
    text = "改一";
    expect(changed()).toBe(true);
    text = "原文";
    expect(changed()).toBe(false);
    text = "改一";
    expect(changed()).toBe(true);
  });

  it("read 抛错（文件被删）返回 false，不抛错", () => {
    let gone = false;
    const changed = projectDocWatcher(() => {
      if (gone) throw new Error("ENOENT");
      return "原文";
    });
    gone = true;
    expect(changed()).toBe(false);
  });
});
