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
import { formatChecks } from "../src/doctor.ts";
import { envLanguage, setTermLanguage, t, termLanguage } from "../src/term.ts";

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
    expect(acceptanceSection("b", enNotes, { pageChanged: true, m: en })).toContain("the project has no setup steps configured");
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

describe("终端语言 / terminal language", () => {
  it("环境默认：SANDPIPE_LANG 优先，其次 LANG 以 zh 开头算中文，其余英文", () => {
    expect(envLanguage({ SANDPIPE_LANG: "en", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(envLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(envLanguage({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(envLanguage({ LANG: "C.UTF-8" })).toBe("en");
    expect(envLanguage({})).toBe("en");
  });

  it("读到项目配置后跟项目语言；设了 SANDPIPE_LANG 时不跟", () => {
    try {
      setTermLanguage("en", {});
      expect(termLanguage()).toBe("en");
      expect(formatChecks([{ name: "Config", level: "fail", detail: "x", fix: "y" }])).toBe("✗ Config: x\n    → y");
      setTermLanguage("en", { SANDPIPE_LANG: "zh" });
      expect(t("中", "en")).toBe("中");
    } finally {
      setTermLanguage("zh", {});
    }
  });
});

describe("英文分钟数单复数 / minute pluralization", () => {
  it("reasonChecksTimeout 写 1 minute、2 minutes", () => {
    expect(en.reasonChecksTimeout("- x", 1)).toContain("after 1 minute,");
    expect(en.reasonChecksTimeout("- x", 2)).toContain("after 2 minutes,");
  });
});

describe("标签描述长度", () => {
  // GitHub 标签描述最多 100 个字符，超了 gh label create 报 422、标签建不起来（e2e R3：英文 merging 标签）。
  // GitHub label descriptions are capped at 100 characters; longer ones make gh label create fail with 422 (e2e R3: the English merging label).
  it.each(["zh", "en"] as const)("%s 的所有 *LabelDesc 不超过 100 个字符", (lang) => {
    const m = messages(lang) as unknown as Record<string, unknown>;
    const descs = Object.entries(m).filter(([k, v]) => k.endsWith("LabelDesc") && typeof v === "string");
    expect(descs.length).toBeGreaterThan(0);
    for (const [k, v] of descs) expect([...(v as string)].length, k).toBeLessThanOrEqual(100);
  });
});

describe("limitedWaiting（#48）", () => {
  it("中英文正文写明阶段、档案、恢复时间，末尾是标记", () => {
    const mark = "<!-- sandcastle:limited -->";
    for (const lang of ["zh", "en"] as const) {
      const body = messages(lang).limitedWaiting("implement", ["opus", "glm"], "2026/11/26 11:02:00", mark);
      expect(body).toContain("implement");
      expect(body).toContain("`opus`");
      expect(body).toContain("`glm`");
      expect(body).toContain("2026/11/26 11:02:00");
      expect(body.endsWith(mark)).toBe(true);
    }
  });
});

describe("通知原因（#133）", () => {
  it("全部档案撞限额：中英都写明阶段、档案名和恢复时间", () => {
    expect(messages("zh").notifyLimited("implement", ["opus", "glm"], "2026/11/26 11:02:00"))
      .toBe("阶段 implement 的档案（opus、glm）都撞上了用量限额，预计 2026/11/26 11:02:00（本地时间）恢复后接着跑。");
    expect(messages("en").notifyLimited("implement", ["opus", "glm"], "2026/11/26 11:02:00"))
      .toBe("every profile for phase implement (opus, glm) hit its usage limit; the run resumes around 2026/11/26 11:02:00 (local time).");
  });

  it("prep 撞限额只写恢复时间；prep stuck 让人看票上的评论", () => {
    expect(messages("zh").notifyPrepLimited("2026/11/26 11:02:00")).toBe("prep 撞上了用量限额，预计 2026/11/26 11:02:00（本地时间）恢复后接着跑。");
    expect(messages("en").notifyPrepLimited("2026/11/26 11:02:00")).toBe("prep hit its usage limit; it resumes around 2026/11/26 11:02:00 (local time).");
    expect(messages("zh").notifyPrepStuck).toBe("prep 要人拍板或缺信息，见票上的评论。");
    expect(messages("en").notifyPrepStuck).toBe("prep needs a human decision or more information; see the comments on the ticket.");
  });
});

describe("gateEnvDown（#54）", () => {
  it("中英文都写明匹配到的那一行，并提示去掉 stuck", () => {
    const line = "connect ECONNREFUSED 127.0.0.1:5432";
    expect(messages("zh").gateEnvDown(line, "`sandcastle:stuck`")).toBe("门槛依赖的服务连不上（`connect ECONNREFUSED 127.0.0.1:5432`），重试用完仍未恢复。先把服务起来，再去掉 `sandcastle:stuck`。");
    const en = messages("en").gateEnvDown(line, "`sandcastle:stuck`");
    expect(en).toContain("`connect ECONNREFUSED 127.0.0.1:5432`");
    expect(en).toContain("`sandcastle:stuck`");
  });
});
