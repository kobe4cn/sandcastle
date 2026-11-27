// 浏览器验收作为自动合并的硬条件：改了页面的票，脚本自己核对 .browser-check/ 的产物和 review 的 <browser-check> 标签，
// 不满足就留 PR，原因逐条写缺什么。纯函数，main.ts 的 land() 按 browserVerdict 的结论决定。
// Browser checks as a hard condition for auto-merge: for tickets that change pages, the script itself checks the .browser-check/ output
// and the review's <browser-check> tag; if anything is missing the PR is left open, with each missing item spelled out. Pure functions; land() in main.ts acts on browserVerdict.

import type { Messages } from "./i18n.ts";
import { t } from "./term.ts";

/** .browser-check/ 拷到宿主机后的内容（main.ts 的 collectBrowserCheck）。 / The .browser-check/ contents copied to the host (collectBrowserCheck in main.ts). */
export type BrowserCheck = { result?: string; shots: string[] };

/**
 * 改动的文件里命中 browser.pagePaths 的那些。
 * The changed files that match browser.pagePaths.
 */
export const pageFiles = (changed: string[], pagePaths: RegExp[]): string[] =>
  changed.filter((f) =>
    pagePaths.some((r) => {
      // 带 g / y 标志的正则 test 会记住 lastIndex，反复用会漏判。 / Regexes with g / y remember lastIndex across test calls and would miss matches.
      r.lastIndex = 0;
      return r.test(f);
    }),
  );

// 只看列表行和表格行：图例（「✅ 通过 ❌ 没过」）不算。 / Only list and table rows: a legend line ("✅ pass ❌ fail") doesn't count.
const ITEM_LINE = /^\s*([-*]|\d+\.|\|)/;
// 不带 U+FE0F：「⚠️」里也有「⚠」。 / Without U+FE0F: "⚠️" contains "⚠" too.
const FAILED = /❌|⚠/;
const SHOT_REF = /[\w.-]+\.(png|jpe?g)/gi;
const basename = (p: string) => p.split(/[\\/]/).at(-1) ?? p;
// 评审逐条结论里没通过的行：行首（去掉 `-` / `*` / `1.` 列表符号后）是 ❌ 或 ❓。 / Failing rows in the reviewer's per-step verdict: ❌ or ❓ at the start of the line (after any `-` / `*` / `1.` list marker).
const VERDICT_FAILED = /^([-*]|\d+\.)?\s*(❌|❓)/;

/**
 * 验收之后（browserAt..HEAD）的改动里命中页面的文件；取不到 diff 时为 "unknown"，按过期处理（fail-closed，#58）。
 * Page files among the changes since the check (browserAt..HEAD); "unknown" when the diff is unavailable, treated as stale (fail-closed, #58).
 */
export const browserStale = (changedSince: string[] | undefined, pagePaths: RegExp[]): string[] | "unknown" =>
  changedSince === undefined ? "unknown" : pageFiles(changedSince, pagePaths);

/**
 * rebase 解冲突改到的页面：冲突文件，加上 rebase 后新出现在票 diff 里的文件（rebase 前已有的不算，sha 变了不能用两点 diff，#58）。
 * before 或 after 取不到时为 "unknown"。
 * Pages touched by resolving rebase conflicts: the conflicting files plus files newly appearing in the ticket diff after the rebase
 * (ones already there before don't count; the sha changed so a two-dot diff won't do, #58). "unknown" when before or after is unavailable.
 */
export function rebasePageHits(
  conflictFiles: string[], before: string[] | undefined, after: string[] | undefined, pagePaths: RegExp[],
): string[] | "unknown" {
  if (before === undefined || after === undefined) return "unknown";
  const had = new Set(before);
  return pageFiles([...new Set([...conflictFiles, ...after.filter((f) => !had.has(f))])], pagePaths);
}

/**
 * 浏览器验收缺什么（空数组就是都满足）：至少一张截图；RESULT.md 存在、列表行没有 ❌ / ⚠、引用的截图都在；review 标签是 done；
 * 验收之后没再改页面（stale 为空或不传）；标签是 done 时，评审有逐条的 browser-verdict 且没有 ❌ / ❓ 行（#84）。
 * What the browser check is missing (empty means all satisfied): at least one screenshot; RESULT.md exists, its list rows have no ❌ / ⚠,
 * and the screenshots it references exist; the review tag is done; no page changed after the check (stale empty or omitted);
 * when the tag is done, the reviewer gave a per-step browser-verdict with no ❌ / ❓ rows (#84).
 */
export function browserProblems(
  b: BrowserCheck | undefined, tag: string | undefined, m: Messages, stale?: string[] | "unknown", verdict?: string,
): string[] {
  if (!b) return [m.browserNotDone];
  const problems: string[] = [];
  // 验收之后又改了页面，截图对应的不是最终代码（#58）。 / Pages changed after the check, so the screenshots don't show the final code (#58).
  if (stale === "unknown") problems.push(m.browserStaleUnknown);
  else if (stale?.length) problems.push(m.browserStale(m.list(stale)));
  if (b.shots.length === 0) problems.push(m.browserNoShots);
  if (b.result === undefined) problems.push(m.browserNoResultFile);
  else {
    const failed = b.result.split("\n").filter((l) => ITEM_LINE.test(l) && FAILED.test(l)).map((l) => l.trim());
    if (failed.length) problems.push(m.browserFailedItems(failed));
    const have = new Set(b.shots.map(basename));
    const missing = [...new Set(b.result.match(SHOT_REF) ?? [])].filter((f) => !have.has(f));
    if (missing.length) problems.push(m.browserMissingShots(m.list(missing)));
  }
  const value = tag?.trim();
  if (value !== "done") problems.push(value ? m.browserTagNotDone(value) : m.browserNoTag);
  // done 必须基于评审自己看截图的结论（#84）；不比对 RESULT.md 的步骤，那交给评审。
  // done must rest on the reviewer's own look at the screenshots (#84); RESULT.md's steps aren't compared here, that's the reviewer's job.
  else if (!verdict?.trim()) problems.push(m.browserNoVerdict);
  else {
    const failed = verdict.split("\n").map((l) => l.trim()).filter((l) => VERDICT_FAILED.test(l));
    if (failed.length) problems.push(m.browserVerdictFailed(failed));
  }
  return problems;
}

/**
 * 合并前的结论：没改页面不挡；改了页面但项目没配浏览器验收、或验收有缺，给出留 PR 的原因 block。
 * The pre-merge verdict: no page changes, no block; pages changed but the project has no browser check configured, or the check falls short, gives a reason `block` for leaving the PR.
 */
export function browserVerdict(
  x: { pages: boolean; hasBrowser: boolean; browser?: BrowserCheck; tag?: string; stale?: string[] | "unknown"; verdict?: string },
  m: Messages,
): { block?: string } {
  if (!x.pages) return {};
  if (!x.hasBrowser) return { block: m.reasonNoBrowserConfig };
  const problems = browserProblems(x.browser, x.tag, m, x.stale, x.verdict);
  return problems.length ? { block: m.reasonBrowser(problems.join(m.sep)) } : {};
}

/**
 * 票正文里有没有 Browser check：实现指引里的列表项 `- **Browser check**`（prompts/ticket-sizing.md），不是 `##` 节。
 * Whether the ticket body has a Browser check: the `- **Browser check**` list item of the implementation guide (prompts/ticket-sizing.md), not a `##` section.
 */
export const ticketHasBrowserCheck = (body: string): boolean => /\*\*Browser check\*\*/.test(body);

/**
 * 项目有页面（探测到网页界面或配了 browser.pagePaths）却没配浏览器验收时的提醒：run 启动时和 doctor 共用这段文案。
 * 只打在终端，按终端语言（term.ts 的 t）。docPath 是 config 文档路径（onboard.ts 的 manual）。
 * The reminder when the project has pages (a detected web UI or browser.pagePaths set) but no browser check configured: shared by run's startup and doctor.
 * Terminal only, in the terminal language (t in term.ts). docPath is the config manual path (manual in onboard.ts).
 */
export const browserSetupWarning = (docPath: string): string =>
  t(
    `探测到网页界面（或配了 browser.pagePaths），但 PROJECT.md 没有「浏览器验收」：改页面的票会留给人看、不会自动合并。补法：重跑 onboard 让它写这一节；或在 .sandcastle/PROJECT.md 里手动加 \`## 浏览器验收\`（怎么准备数据、在后台起 dev server、登录、查日志），写法见 ${docPath} 的「浏览器验收」一节。`,
    `A web UI was detected (or browser.pagePaths is set), but PROJECT.md has no Browser check section: tickets that change pages are left for a human and won't auto-merge. To fix: rerun onboard so it writes the section; or add \`## Browser check\` to .sandcastle/PROJECT.md by hand (preparing data, starting the dev server in the background, logging in, checking logs), following the Browser check section of ${docPath}.`,
  );
