// 受保护路径作为自动合并的关卡：票的最终 diff 改到 protectedPaths 命中的文件就不自动合并，留 PR 给人看。
// 纯函数，main.ts 的 land() 和 rebaseAndMerge() 按 protectedBlock 的结论决定（见 docs/adr/0003-protected-paths.md）。
// Protected paths as an auto-merge gate: if a ticket's final diff touches a file matched by protectedPaths, it isn't auto-merged and the PR is left for a human.
// Pure functions; land() and rebaseAndMerge() in main.ts act on protectedBlock (see docs/adr/0003-protected-paths.md).

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
 * 受保护路径挡不挡自动合并：没配规则 → undefined（不挡）；配了规则但 changed 为 undefined（取不到 diff）→ 按命中处理（fail-closed）；
 * 有文件命中 → 逐条列出的原因；都没命中 → undefined。
 * Whether protected paths block auto-merge: no rules → undefined (no block); rules configured but changed is undefined (diff unreadable) → treated as a hit (fail-closed);
 * any file matches → the reason listing each one; nothing matches → undefined.
 */
export function protectedBlock(changed: string[] | undefined, rules: RegExp[], m: Messages): string | undefined {
  if (rules.length === 0) return undefined;
  if (changed === undefined) return m.reasonProtectedUnknown;
  const hits = protectedHits(changed, rules);
  return hits.length > 0 ? m.reasonProtected(hits) : undefined;
}
