// 代码注释中英对照（scripts/check-comments.mjs）：不合格的注释会列在报错里。
// Code comments must be bilingual (scripts/check-comments.mjs): failing comments are listed in the error.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commentBlocks, missingLanguage } from "../scripts/check-comments.mjs";

it("注释都是中英对照 / all comments are bilingual", () => {
  const script = fileURLToPath(new URL("../scripts/check-comments.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(r.status, r.stdout).toBe(0);
});

describe("commentBlocks 收集行尾注释", () => {
  const trailingLines = (src: string) => commentBlocks(src).filter((b) => b.trailing).map((b) => [b.line, b.text]);

  it("对象字面量属性后的行尾注释，最后一项有没有尾逗号都算", () => {
    expect(trailingLines(`export const L = {\n  a: "x", // 甲\n  b: "y", // 乙\n};\n`)).toEqual([
      [2, "// 甲"],
      [3, "// 乙"],
    ]);
    expect(trailingLines(`const L = {\n  a: "x", // 甲\n  b: "y" // 乙\n};\n`)).toEqual([
      [2, "// 甲"],
      [3, "// 乙"],
    ]);
  });

  it("数组元素后的行尾注释，最后一项有没有尾逗号都算", () => {
    expect(trailingLines(`const A = [\n  1, // 甲\n  2, // 乙\n];\n`)).toEqual([
      [2, "// 甲"],
      [3, "// 乙"],
    ]);
    expect(trailingLines(`const A = [\n  1, // 甲\n  2 // 乙\n];\n`)).toEqual([
      [2, "// 甲"],
      [3, "// 乙"],
    ]);
  });

  it("嵌套的对象和数组、函数实参也收集，不重复", () => {
    const src = `f(\n  { a: [1, // 甲\n    2], // 乙\n  }, // 丙\n  3, // 丁\n);\n`;
    expect(trailingLines(src)).toEqual([
      [2, "// 甲"],
      [3, "// 乙"],
      [4, "// 丙"],
      [5, "// 丁"],
    ]);
  });

  it("普通语句后的行尾注释照旧收集，独占一行的注释不算行尾", () => {
    const blocks = commentBlocks(`// 头 / head comment here\nconst z = 1; // 尾\n`);
    expect(blocks.map((b) => [b.line, b.trailing, b.text])).toEqual([
      [1, false, "// 头 / head comment here"],
      [2, true, "// 尾"],
    ]);
  });

  it("JSDoc 正文里的 // 不当成另一段注释", () => {
    const src = `/**\n * 说明 / docs here\n * @param a // 不是注释\n * @see {@link x} // 也不是\n */\nfunction f(a) {}\n`;
    expect(commentBlocks(src).map((b) => b.line)).toEqual([1]);
  });

  it("只有中文的行尾注释报缺 en", () => {
    const [b] = commentBlocks(`export const L = {\n  a: "x", // 只有中文\n};\n`);
    expect(missingLanguage(b.text)).toBe("en");
  });
});
