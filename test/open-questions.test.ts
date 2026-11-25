// 缺口清单的解析：每条一行「- [类别] 问题 → 写到哪」，中英文类别都认，格式错误报行号。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_QUESTIONS, parseOpenQuestions, readOpenQuestions } from "../src/open-questions.ts";

describe("parseOpenQuestions", () => {
  it("中英文类别都认，标题行和空行跳过，问题和目标去掉首尾空格", () => {
    const md = [
      "# 缺口清单",
      "",
      "- [意图] 哪些操作必须交给人（红线）？ → PROJECT.md「必须停下」",
      "- [规范]  提交信息用中文还是英文？  →  PROJECT.md「提交」 ",
      "",
      "- [intent] The project has no glossary yet → GLOSSARY.md",
      "- [convention] Which test helper to use? → PROJECT.md \"Testing\"",
    ].join("\n");
    expect(parseOpenQuestions(md)).toEqual([
      { category: "intent", question: "哪些操作必须交给人（红线）？", target: "PROJECT.md「必须停下」", line: 3 },
      { category: "convention", question: "提交信息用中文还是英文？", target: "PROJECT.md「提交」", line: 4 },
      { category: "intent", question: "The project has no glossary yet", target: "GLOSSARY.md", line: 6 },
      { category: "convention", question: "Which test helper to use?", target: 'PROJECT.md "Testing"', line: 7 },
    ]);
  });

  it("箭头两侧没有空格也认", () => {
    expect(parseOpenQuestions("- [规范] 用哪个测试框架？→PROJECT.md「测试」")).toEqual([
      { category: "convention", question: "用哪个测试框架？", target: "PROJECT.md「测试」", line: 1 },
    ]);
  });

  it("格式错的行报错，信息里带文件名和行号", () => {
    expect(() => parseOpenQuestions("# 缺口清单\n\n- [意图] 没有目标")).toThrow(/OPEN-QUESTIONS\.md.*第 3 行/);
    expect(() => parseOpenQuestions("- [其他] 问题 → GLOSSARY.md")).toThrow(/第 1 行/);
    expect(() => parseOpenQuestions("- [意图] 问题 -> GLOSSARY.md")).toThrow(/第 1 行/);
    expect(() => parseOpenQuestions("- [意图]  → GLOSSARY.md")).toThrow(/第 1 行/);
    expect(() => parseOpenQuestions("- [意图] 问题 → ")).toThrow(/第 1 行/);
    expect(() => parseOpenQuestions("- [意图]    → GLOSSARY.md")).toThrow(/第 1 行/);
    expect(() => parseOpenQuestions("随便一句话", "x.md")).toThrow(/x\.md 第 1 行/);
  });

  it("空字符串、只有标题都得到空列表", () => {
    expect(parseOpenQuestions("")).toEqual([]);
    expect(parseOpenQuestions("# 缺口清单\n")).toEqual([]);
    expect(parseOpenQuestions("# Open questions\n\n")).toEqual([]);
  });
});

describe("readOpenQuestions", () => {
  it("文件不存在返回 null，存在就解析", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-oq-"));
    expect(readOpenQuestions(root)).toBeNull();
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, OPEN_QUESTIONS), "# 缺口清单\n- [意图] 项目还没有术语表 → GLOSSARY.md\n");
    expect(readOpenQuestions(root)).toEqual([{ category: "intent", question: "项目还没有术语表", target: "GLOSSARY.md", line: 2 }]);
  });
});
