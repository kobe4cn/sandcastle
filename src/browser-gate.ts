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

/**
 * 浏览器验收缺什么（空数组就是都满足）：至少一张截图；RESULT.md 存在、列表行没有 ❌ / ⚠、引用的截图都在；review 标签是 done。
 * What the browser check is missing (empty means all satisfied): at least one screenshot; RESULT.md exists, its list rows have no ❌ / ⚠,
 * and the screenshots it references exist; the review tag is done.
 */
export function browserProblems(b: BrowserCheck | undefined, tag: string | undefined, m: Messages): string[] {
  if (!b) return [m.browserNotDone];
  const problems: string[] = [];
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
  return problems;
}

/**
 * 合并前的结论：没改页面不挡；改了页面但项目没配浏览器验收、或验收有缺，给出留 PR 的原因 block。
 * The pre-merge verdict: no page changes, no block; pages changed but the project has no browser check configured, or the check falls short, gives a reason `block` for leaving the PR.
 */
export function browserVerdict(
  x: { pages: boolean; hasBrowser: boolean; browser?: BrowserCheck; tag?: string },
  m: Messages,
): { block?: string } {
  if (!x.pages) return {};
  if (!x.hasBrowser) return { block: m.reasonNoBrowserConfig };
  const problems = browserProblems(x.browser, x.tag, m);
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
