// 语言开关（项目配置 language）：脚本写到平台上的文字和 agent 的固定格式都跟着变，中文是默认。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubForge } from "../src/forges/github.ts";
import { flakyTickets } from "../src/guide.ts";
import { messages } from "../src/i18n.ts";
import { usageTable } from "../src/models.ts";
import { acceptanceSection, checkAcceptanceNotes } from "../src/pr-body.ts";
import { DEFAULT_LABELS, defaultTexts, resolveProject } from "../src/profile.ts";
import { parseProjectDoc, PROMPT_NAMES, renderPrompts } from "../src/project-doc.ts";

const en = messages("en");
const enNotes = "### What changed\n\nAdds a flag.\n\n### How to verify\n\n1. Run it → prints the version\n\n### Result\n\nDone.";

const render = (language?: "zh" | "en") => {
  const files = renderPrompts({
    doc: parseProjectDoc(["## 概况", "x", "## 开发命令", "`make`", "## 测试", "`make test`", "## 提交", "英文"].join("\n")),
    forgeGuide: githubForge(() => "").agentGuide(),
    labels: DEFAULT_LABELS,
    dir: mkdtempSync(join(tmpdir(), "sc-i18n-")),
    language,
  });
  return Object.fromEntries(PROMPT_NAMES.map((n) => [n, readFileSync(files[n], "utf8")]));
};

describe("language", () => {
  it("默认中文", () => {
    expect(resolveProject({ install: { onSandboxReady: "true" }, isolation: { env: () => ({}) }, gate: { script: () => "true", testFile: /x/ } } as never).language).toBe("zh");
    expect(checkAcceptanceNotes(undefined)).toEqual(["文件不存在"]);
  });

  it("英文：验收说明按英文小标题检查，中文小标题不算", () => {
    expect(checkAcceptanceNotes(enNotes, en)).toEqual([]);
    expect(checkAcceptanceNotes("### 做了什么\n### 怎么验证\n1. x\n### 最终效果", en)).toHaveLength(3);
    expect(acceptanceSection("b", enNotes, { pageChanged: false, m: en })).toMatch(/^### Setup\n\n`git checkout b` \(no page changes/);
  });

  it("英文：用量表、偶发失败票标题、默认开票正文", () => {
    expect(usageTable([], en)).toBe("(no usage recorded)");
    expect(flakyTickets(["t/a.py", "t/b.py"], "", [], /\S+\.py/, en).map((t) => t.title)).toEqual(["Flaky test: t/a.py", "Flaky test: t/b.py"]);
    expect(flakyTickets(["t/a.py"], "", [{ number: 7, title: "Flaky test: t/a.py", body: "" }], /\S+\.py/, en)[0]!.existing).toBe(7);
    const texts = defaultTexts("en");
    expect(texts.flakyIssueBody({ files: ["t/a.py"], seen: "s", env: "e", prior: "", summary: "x" })).toContain("## How to fix");
    expect(texts.revisePrompt({ issueId: "1", branch: "b", title: "t", viewIssue: "v", items: "i" })).toMatch(/^Output language: .*English/);
    expect(defaultTexts("zh").revisePrompt({ issueId: "1", branch: "b", title: "t", viewIssue: "v", items: "i" })).not.toMatch(/Output language/);
  });

  it("提示词：开头是输出语言规则，验收说明小标题按语言填", () => {
    const zh = render();
    const english = render("en");
    for (const name of PROMPT_NAMES) {
      expect(zh[name]).toMatch(/^输出语言：/);
      expect(english[name]).toMatch(/^Output language: /);
    }
    expect(zh.implement).toContain("`### 做了什么`");
    expect(english.implement).toContain("`### What changed`");
    expect(english.review).toContain("`### How to verify`");
  });
});

describe("PROJECT.md 英文标题", () => {
  const en = ["## Overview", "x", "## Commands", "`make`", "## Testing", "`make test`", "## Commits", "English"];
  it("英文标题和中文标题解析成同一组章节", () => {
    const doc = parseProjectDoc([...en, "## Browser check", "open it"].join("\n"));
    expect(doc.overview).toBe("x");
    expect(doc.commit).toBe("English");
    expect(doc.hasBrowser).toBe(true);
  });
  it("同一节用中英文各写一次算重复；不认识的标题报错", () => {
    expect(() => parseProjectDoc([...en, "## 概况", "y"].join("\n"))).toThrow(/写了两次/);
    expect(() => parseProjectDoc([...en, "## Overveiw", "y"].join("\n"))).toThrow(/不认识的章节「Overveiw」/);
  });
});
