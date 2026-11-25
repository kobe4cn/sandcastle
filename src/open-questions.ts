// 缺口清单 `.sandcastle/OPEN-QUESTIONS.md`：onboard 时拿不准、需要人补的规范类和意图类问题，提交进仓库。
// 每条一行「- [类别] 问题 → 写到哪」，不编号、不加 ID；答案写进目标文档后删掉这一条。onboard 写完后用这里的解析校验，doctor 的计数也用它；onboard 还用它检查目标节名。
// The open questions list `.sandcastle/OPEN-QUESTIONS.md`: convention and intent questions onboard couldn't settle and a human must answer, committed to the repo.
// One line per item, "- [category] question → where to write it", no numbers or IDs; an item is deleted once its answer is in the target doc. onboard validates with this parser after writing, and doctor's count uses it too; onboard also uses it to check target section names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_DOC, SECTIONS, SECTIONS_EN } from "./project-doc.ts";
import { t } from "./term.ts";

export const OPEN_QUESTIONS = ".sandcastle/OPEN-QUESTIONS.md";

export type OpenQuestion = {
  category: "convention" | "intent";
  question: string;
  target: string;
  /** 在文件里的行号，从 1 开始 / Line number in the file, starting at 1 */
  line: number;
};

const CATEGORY: Record<string, OpenQuestion["category"]> = {
  规范: "convention",
  意图: "intent",
  convention: "convention",
  intent: "intent",
};

const ITEM = /^- \[(规范|意图|convention|intent)\]\s+(.+?)\s*→\s*(.+?)\s*$/;

/**
 * 解析缺口清单：空行和 `#` 标题行跳过，其余每行都必须是一条；格式不对就报错并指出行号。
 * Parse the open questions list: blank lines and `#` headings are skipped, every other line must be an item; a malformed line throws with its line number.
 */
export function parseOpenQuestions(md: string, file = OPEN_QUESTIONS): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const [i, raw] of md.split("\n").entries()) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = ITEM.exec(line);
    const n = i + 1;
    if (!m || !m[2].trim() || !m[3].trim())
      throw new Error(
        t(`${file} 第 ${n} 行格式不对：应为 - [类别] 问题 → 写到哪`, `${file} line ${n} is malformed: expected - [category] question → where to write it`),
      );
    out.push({ category: CATEGORY[m[1]], question: m[2].trim(), target: m[3].trim(), line: n });
  }
  return out;
}

/**
 * 读项目里的缺口清单：文件不存在返回 null，存在就解析（格式不对会抛错）。
 * Read the project's open questions list: null when the file doesn't exist, otherwise parsed (throws when malformed).
 */
export function readOpenQuestions(root: string): OpenQuestion[] | null {
  const path = join(root, OPEN_QUESTIONS);
  if (!existsSync(path)) return null;
  return parseOpenQuestions(readFileSync(path, "utf8"));
}

const KNOWN_SECTIONS = new Set<string>([...Object.values(SECTIONS), ...Object.values(SECTIONS_EN)]);
const QUOTED = /「([^」]+)」|"([^"]+)"|“([^”]+)”/;

/**
 * 找出「写到哪」指向 PROJECT.md 里不存在的节的条目：取第一个引号里的节名，中英文节名都认；没加引号的 PROJECT.md 目标也算，`section` 填目标原文。
 * Find items whose target points to a PROJECT.md section that doesn't exist: the name is the first quoted text, Chinese and English titles both count; an unquoted PROJECT.md target counts too, with `section` set to the raw target.
 */
export function unknownSectionTargets(qs: OpenQuestion[]): { line: number; section: string }[] {
  const out: { line: number; section: string }[] = [];
  for (const q of qs) {
    if (!q.target.startsWith(PROJECT_DOC)) continue;
    const m = QUOTED.exec(q.target);
    const section = m ? (m[1] ?? m[2] ?? m[3]).trim() : q.target;
    if (!m || !KNOWN_SECTIONS.has(section)) out.push({ line: q.line, section });
  }
  return out;
}
