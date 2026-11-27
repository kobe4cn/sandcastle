// 受保护路径作为自动合并的关卡：票的最终 diff 改到 protectedPaths 命中的文件就不自动合并，留 PR 给人看。
// 纯函数，main.ts 的 land() 和 rebaseAndMerge() 按 protectedBlock 的结论决定（见 docs/adr/0003-protected-paths.md）。
// Protected paths as an auto-merge gate: if a ticket's final diff touches a file matched by protectedPaths, it isn't auto-merged and the PR is left for a human.
// Pure functions; land() and rebaseAndMerge() in main.ts act on protectedBlock (see docs/adr/0003-protected-paths.md).

import { section } from "./guide.ts";
import type { Messages } from "./i18n.ts";

/** 一个命中：文件（相对仓库根）和它命中的规则源码。 / One hit: the file (relative to the repo root) and the source of the rule it matched. */
export type ProtectedHit = { file: string; rule: string };

/**
 * 改动的文件里命中 protectedPaths 的那些，按 diff 顺序；每个文件只报第一条命中的规则（String(re)）。
 * The changed files that match protectedPaths, in diff order; each file reports only the first rule it matches (String(re)).
 */
export function protectedHits(changed: string[], rules: RegExp[]): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const file of changed) {
    const rule = rules.find((r) => {
      // 带 g / y 标志的正则 test 会记住 lastIndex，反复用会漏判。 / Regexes with g / y remember lastIndex across test calls and would miss matches.
      r.lastIndex = 0;
      return r.test(file);
    });
    if (rule) hits.push({ file, rule: String(rule) });
  }
  return hits;
}

/**
 * 票的实现指引（`## Implementation guide` 一节）里 `- **Protected**` 列表项允许改的路径：取项里每个反引号的内容（相对仓库根，`/` 结尾表示目录）。
 * 只认这一项，不认正文其它地方的说法，免得 agent 或外部内容随口放行（docs/adr/0003-protected-paths.md）。
 * Paths the ticket's implementation guide (the `## Implementation guide` section) allows via the `- **Protected**` list item: the content of each backtick span in it (relative to the repo root; a trailing `/` means a directory).
 * Only that item counts, not wording elsewhere in the body, so an agent or outside content can't wave changes through (docs/adr/0003-protected-paths.md).
 */
export function allowedProtected(body: string): string[] {
  const guide = section(body, "Implementation guide");
  return guide
    .split("\n")
    .filter((line) => /^\s*[-*]\s*\*\*Protected\*\*/.test(line))
    .flatMap((line) => [...line.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!));
}

/** 文件是否被某条允许项覆盖：`/` 结尾按目录前缀，否则全等。 / Whether an allowed entry covers the file: a trailing `/` is a directory prefix, otherwise exact match. */
const isAllowed = (file: string, allowed: string[]) => allowed.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));

/**
 * 把命中分成票允许的和仍要挡的，各自保持原顺序。
 * Split hits into those the ticket allows and those still blocked, each in the original order.
 */
export function splitAllowed(hits: ProtectedHit[], allowed: string[]): { blocked: ProtectedHit[]; allowed: ProtectedHit[] } {
  return {
    blocked: hits.filter((h) => !isAllowed(h.file, allowed)),
    allowed: hits.filter((h) => isAllowed(h.file, allowed)),
  };
}

/**
 * 受保护路径挡不挡自动合并：没配规则 → undefined（不挡）；配了规则但 changed 为 undefined（取不到 diff）→ 按命中处理（fail-closed）；
 * 去掉票允许的（allowed，见 allowedProtected）后还有命中 → 逐条列出的原因；都没命中 → undefined。
 * Whether protected paths block auto-merge: no rules → undefined (no block); rules configured but changed is undefined (diff unreadable) → treated as a hit (fail-closed);
 * hits left after dropping the ones the ticket allows (allowed, see allowedProtected) → the reason listing each one; nothing left → undefined.
 */
export function protectedBlock(changed: string[] | undefined, rules: RegExp[], m: Messages, allowed: string[] = []): string | undefined {
  if (rules.length === 0) return undefined;
  if (changed === undefined) return m.reasonProtectedUnknown;
  const { blocked } = splitAllowed(protectedHits(changed, rules), allowed);
  return blocked.length > 0 ? m.reasonProtected(blocked) : undefined;
}

/**
 * PR 正文 `## Protected paths` 一节的内容：票允许的命中逐条「文件 — 规则（ticket allowed）」；没有（含没配规则、取不到 diff）时 undefined，不放这一节。
 * Content of the PR body's `## Protected paths` section: each ticket-allowed hit as "file — rule (ticket allowed)"; undefined when there are none (including no rules or an unreadable diff), so the section is omitted.
 */
export function allowedSection(changed: string[] | undefined, rules: RegExp[], allowed: string[], m: Messages): string | undefined {
  if (changed === undefined) return undefined;
  const hits = splitAllowed(protectedHits(changed, rules), allowed).allowed;
  return hits.length > 0 ? m.protectedAllowed(hits) : undefined;
}
