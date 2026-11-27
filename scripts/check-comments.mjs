#!/usr/bin/env node
// 检查代码注释中英对照：每段注释（连续的 // 行、一个 /* */ 块、行尾注释）都要同时有中文和英文。
// Check that code comments are bilingual: every comment block (consecutive // lines, one /* */ block, or a trailing comment) must contain both Chinese and English.
//
// 用法 / Usage:
//   node scripts/check-comments.mjs            列出不合格的注释，有就退出码 1 / list failing comments, exit 1 if any
//   node scripts/check-comments.mjs --json     输出 JSON（给批量补译用） / print JSON (for batch translation)
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 要检查的目录（不含测试：测试名和用例本身就是中文说明）。 / Directories to check (tests excluded: their names and cases are documentation in themselves). */
const DIRS = ["src", "scripts", "claude/hooks"];

const HAN = /\p{Script=Han}/u;
/** 英文：去掉反引号里的代码后，至少有连续三个英文单词。 / English: at least three consecutive English words once `code` spans are removed. */
const ENGLISH = /[A-Za-z][a-z']*[,:;.]?\s+[A-Za-z][a-z']*[,:;.]?\s+[A-Za-z][a-z']*/;
/** 不算说明文字的注释：shebang、工具指令、分隔线。 / Comments that aren't prose: shebangs, tool directives, separator lines. */
const EXEMPT = /^(#!|\s*(eslint|@ts-|prettier|biome)|[\s\-=*/]*$)/;

const files = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** 文件里的全部注释段，连续的 // 行合成一段。 / All comment blocks in a file, merging consecutive // lines into one. */
export function commentBlocks(text, fileName = "x.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const seen = new Map();
  const collect = (ranges) => {
    for (const r of ranges ?? []) seen.set(r.pos, r);
  };
  // 用 getChildren 连逗号、括号这些 token 也走一遍：对象属性、数组元素后的行尾注释挂在逗号后面，只看语法节点的结尾取不到。
  // Walk tokens such as commas and brackets via getChildren: a trailing comment after an object property or array element sits past the comma, out of reach from syntax node ends alone.
  // JSDoc 本身就是一段注释，不往里走：它的子节点后面的 // 是正文，不是另一段注释。
  // Don't descend into JSDoc, which is a comment itself: a // after its child nodes is body text, not another comment.
  const visit = (node) => {
    if (ts.isJSDoc(node)) return;
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const blocks = [];
  for (const r of [...seen.values()].sort((a, b) => a.pos - b.pos)) {
    const raw = text.slice(r.pos, r.end);
    const line = lineOf(r.pos);
    const lineStart = text.lastIndexOf("\n", r.pos - 1) + 1;
    const trailing = text.slice(lineStart, r.pos).trim() !== "";
    const prev = blocks.at(-1);
    if (r.kind === ts.SyntaxKind.SingleLineCommentTrivia && !trailing && prev?.kind === "line" && !prev.trailing && prev.endLine === line - 1) {
      prev.text += `\n${raw}`;
      prev.endLine = line;
      continue;
    }
    blocks.push({ kind: r.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block", trailing, line, endLine: lineOf(r.end), text: raw });
  }
  return blocks;
}

/** 这段注释缺哪种语言（都有时返回 undefined）。 / Which language a comment block lacks (undefined when it has both). */
export function missingLanguage(comment) {
  const prose = comment
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/+|\/\*+|\*\/|\*)?\s?/, "").replace(/\*\/\s*$/, ""))
    .filter((l) => !EXEMPT.test(l))
    .join("\n");
  if (!/[A-Za-z\p{Script=Han}]/u.test(prose)) return undefined;
  const hasZh = HAN.test(prose);
  const latin = prose.replace(/(?<!`)`[^`\n]+`(?!`)/g, " ");
  // 三个连续英文单词；或者有一行（或「 / 」后面的一段）没有中文、带英文单词，比如「---- 版本 ---- / Version」。
  // Three consecutive English words; or a line (or a part after " / ") with no Chinese but an English word, e.g. "---- 版本 ---- / Version".
  const sentence = ENGLISH.test(latin.replace(/\p{Script=Han}+/gu, "\n"));
  const hasEn = sentence || latin.split(/\n| \/ /).some((s) => !HAN.test(s) && /[A-Za-z]{3,}/.test(s));
  // 没有中文、也不成句（「---- .env ----」「Plan」这类小标题）不算说明文字。
  // No Chinese and no sentence (headings like "---- .env ----" or "Plan") isn't prose.
  if (!hasZh) return sentence ? "zh" : undefined;
  return hasEn ? undefined : "en";
}

export function failures() {
  return DIRS.flatMap((dir) => files(dir)).flatMap((file) =>
    commentBlocks(readFileSync(join(ROOT, file), "utf8"), file)
      .map((b) => ({ file: relative(ROOT, join(ROOT, file)), ...b, missing: missingLanguage(b.text) }))
      .filter((b) => b.missing),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = failures();
  if (process.argv.includes("--json")) console.log(JSON.stringify(bad, null, 1));
  else {
    for (const b of bad) console.log(`${b.file}:${b.line} 缺${b.missing === "en" ? "英文" : b.missing === "zh" ? "中文" : "中英文"} / missing ${b.missing}: ${b.text.split("\n")[0].slice(0, 100)}`);
    console.log(bad.length ? `\n${bad.length} 段注释不合格 / ${bad.length} comment block(s) fail` : "注释都是中英对照 / all comments are bilingual");
  }
  if (bad.length) process.exitCode = 1;
}
