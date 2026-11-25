// 用户手册中英两份（X.md 英文、X.zh-CN.md 中文）要同步：标题层级、表格行数、代码块数一致，互相链接。
// User manuals come in two copies (X.md English, X.zh-CN.md Chinese) that must stay in sync: same heading levels, table rows and code blocks, linking to each other.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

const MANUALS = ["README", "docs/config", "docs/onboarding-checklist"];
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** 结构指纹：去掉代码块内容后的标题层级、每张表的行数、代码块数。 / Structure fingerprint: heading levels, rows per table, and code block count, ignoring code block contents. */
const shape = (md: string) => {
  const lines = md.replace(/```[\s\S]*?```/g, "```").split("\n");
  const headings = lines.filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)![0].length);
  const tables: number[] = [];
  let rows = 0;
  for (const l of [...lines, ""]) {
    if (l.startsWith("|")) rows++;
    else if (rows) (tables.push(rows), (rows = 0));
  }
  return { headings, tables, codeBlocks: lines.filter((l) => l === "```").length, checkboxes: lines.filter((l) => /^\s*- \[[ x]\]/.test(l)).length };
};

describe("用户手册中英同步 / bilingual manuals in sync", () => {
  for (const name of MANUALS) {
    it(name, () => {
      const en = read(`${name}.md`);
      const zh = read(`${name}.zh-CN.md`);
      expect(shape(zh)).toEqual(shape(en));
      expect(en).toContain(`(${basename(name)}.zh-CN.md)`);
      expect(zh).toContain(`(${basename(name)}.md)`);
      // 英文版除了切换链接「[中文]」不应有中文 / Apart from the "[中文]" switch link, the English copy has no Chinese
      expect(en.replace("[中文]", "")).not.toMatch(/\p{Script=Han}/u);
    });
  }
});
