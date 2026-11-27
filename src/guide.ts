/**
 * 解析 issue 正文与门槛失败摘要的纯函数：plan() 靠它们判断 blocker 和「两张票改同一个文件」，
 * reportFlaky() 靠 flakyFailures 按报错签名去重开偶发失败的票，主循环空转退出时用 idleSummary 说明原因。单独放出来是为了能测。
 * 指引的写法见 prompts/ticket-sizing.md 的 `## Implementation guide` 模板。
 * Pure functions parsing issue bodies and gate failure summaries: plan() uses them to find blockers and "two tickets changing the same file",
 * reportFlaky() uses flakyFailures to dedupe flaky tickets by error signature, and the main loop uses idleSummary to explain an idle exit. Kept separate so they can be tested.
 * How guides are written: the `## Implementation guide` template in prompts/ticket-sizing.md.
 */

import { messages, type Messages } from "./i18n.ts";
import { t } from "./term.ts";

/**
 * 正文里 `## <title>` 一节的内容（到下一个 `## ` 为止），没有这一节时为空串。
 * Content of the `## <title>` section in a body (up to the next `## `); empty string when absent.
 */
export const section = (body: string, title: string) => {
  const m = body.match(new RegExp(`^##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"));
  return m?.[1] ?? "";
};

const BULLET = /^(\s*)[-*]\s+(.*)$/;
const CHANGE = /^\*\*Change\*\*/;
/**
 * 反引号里的第一个文件路径（`a/b.ts:12-30` → `a/b.ts`）；不像路径的（函数名、SQL）不算。
 * First file path in backticks (`a/b.ts:12-30` → `a/b.ts`); things that don't look like paths (function names, SQL) don't count.
 */
const firstPath = (text: string) => {
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1]!.split(":")[0]!;
    if (/^[\w.@-]+(\/[\w.@-]+)*\.\w+$/.test(p) && (p.includes("/") || /^[\w-]+(\.[\w-]+)*\.(ts|tsx|js|mjs|json|md|sql|ya?ml|sh)$/.test(p))) return p;
  }
  return undefined;
};

/**
 * 只追加的索引文件（项目配置 appendOnlyFiles）：几张票同时往末尾追加行也不会真冲突（prompts/rebase.md 与 PROJECT.md「合并冲突」已写明两边都保留），
 * 不拿来判断「两张票改同一个文件」。比如测试目录索引几乎每张加测试的票都改，
 * 不排除的话这类票只能一张接一张做，两个空位经常只用上一个（duckdb_crm 2026-11 #732）。
 * Append-only index files (project config appendOnlyFiles): several tickets appending lines at the end don't really conflict (prompts/rebase.md and PROJECT.md's merge conflicts section say to keep both sides),
 * so they don't count for "two tickets changing the same file". A test index, for example, is touched by almost every ticket that adds tests;
 * without excluding it those tickets run one at a time and often only one of two slots is used (duckdb_crm 2026-11 #732).
 */
const NO_APPEND_ONLY: ReadonlySet<string> = new Set();

/**
 * 指引里要改的已有文件（去掉 `:行号`），两种写法都认：
 * - `- **Change**: \`path:行\` …`，一行一个文件（括号说明、全角冒号也行）；
 * - `- **Change**（说明）：` 下面缩进的子条目，每条开头一个 \`path:行\`。
 * `fallback` 是指引里一条 Change 都没有时的兜底：取除 New / Reuse / ADRs / Tests 之外各条里的 \`path:行号\` 引用。
 * 只追加的索引文件（appendOnly）不算：有 Change 行就不走兜底（哪怕全是索引文件），返回的数组里也过滤掉。
 * 宁可多认（多排队）也不漏认（两张并行的票改同一个文件，到合并才冲突）。
 * Existing files the guide changes (`:line` removed); both forms are recognized:
 * - `- **Change**: \`path:line\` …`, one file per line (parenthetical notes and full-width colons are fine);
 * - indented sub-items under `- **Change** (note):`, each starting with a \`path:line\`.
 * `fallback` applies when the guide has no Change at all: take the \`path:line\` references from items other than New / Reuse / ADRs / Tests.
 * Append-only index files (appendOnly) don't count: any Change line disables the fallback (even if all are index files), and they are filtered from the result.
 * Better to over-match (more queueing) than miss (two parallel tickets changing one file only conflict at merge time).
 */
export const changedFiles = (body: string, appendOnly: ReadonlySet<string> = NO_APPEND_ONLY): { files: string[]; fallback: boolean } => {
  const lines = section(body, "Implementation guide").split("\n");
  const files = new Set<string>();
  let changeIndent: number | undefined;
  for (const line of lines) {
    const b = line.match(BULLET);
    if (!b) continue;
    const indent = b[1]!.replace(/\t/g, "  ").length;
    const text = b[2]!;
    if (CHANGE.test(text)) {
      changeIndent = indent;
      const p = firstPath(text);
      if (p) files.add(p);
    } else if (changeIndent !== undefined && indent > changeIndent) {
      const p = firstPath(text);
      if (p) files.add(p);
    } else changeIndent = undefined;
  }
  if (files.size > 0) return { files: [...files].filter((p) => !appendOnly.has(p)), fallback: false };

  let skip = false;
  for (const line of lines) {
    const b = line.match(BULLET);
    if (b && b[1]!.length === 0) skip = /^\*\*(New|Reuse|ADRs|Tests)\*\*/.test(b[2]!);
    if (skip) continue;
    for (const m of line.matchAll(/`([^`\s]+?):\d+[^`]*`/g)) {
      const p = firstPath(`\`${m[1]}\``);
      if (p) files.add(p);
    }
  }
  const claimed = [...files].filter((p) => !appendOnly.has(p));
  return { files: claimed, fallback: claimed.length > 0 };
};

/**
 * 去掉括号（全角、半角）里的说明，比如「（原为 #472，已拆票）」「(#267 已拆分)」。
 * Remove notes in parentheses (full- or half-width), e.g. "（原为 #472，已拆票）" or "(#267 已拆分)".
 */
const stripParens = (line: string) => {
  let prev;
  do {
    prev = line;
    line = line.replace(/[（(][^（）()]*[）)]/g, "");
  } while (line !== prev);
  return line;
};

/**
 * `## Blocked by` 里列表项的标记与正文：认 `- `、`* `、`+ `、`- [ ] `/`- [x] `、`1. `/`1) `，
 * 取标记（含可选的复选框）后面的部分。`* ` 后面必须有空白，`**加粗**` 才不会被误认成列表项。
 * 只给 blockersOf 用；上面的 BULLET 是给 changedFiles 用的，不认序号和复选框。
 * List-item marker and text in `## Blocked by`: `- `, `* `, `+ `, `- [ ] `/`- [x] `, `1. `/`1) `,
 * capturing what follows the marker (with an optional checkbox). `* ` requires whitespace after it so `**bold**` isn't a list item.
 * Only for blockersOf; BULLET above is for changedFiles and knows no ordinals or checkboxes.
 */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/;

/**
 * `## Blocked by` 里的 blocker 票号：只认列表项（`- #68 …`、`1. #93`、`- [ ] #92`）里的，列表后面的说明段落、
 * 续行和单独一行的票号都不算——曾经把列表后面一段「属于 #77（自举）。」里的票也当成 blocker，
 * 长期开着的 epic 让那张票一直排不上（2026-11 #93）。列表项内括号里的票号仍是说明
 * （「#487（原为 #472，已拆票）」「无（#275 已关闭）」）不算，括号外的都算，一行写几个（「#275、#276」「#305, #306」）也认。
 * 曾经把括号里拆过的父票也算成 blocker，父票拆完一直 open，这些票就永远排不上（2026-11-09 #473–#476）。
 * Blocker numbers in `## Blocked by`: only those inside list items (`- #68 …`, `1. #93`, `- [ ] #92`); prose after the list,
 * continuation lines and a bare `#12` line don't count — a trailing paragraph "属于 #77（自举）。" used to count as a blocker
 * and a long-open epic kept that ticket unschedulable (2026-11 #93). Inside a list item, numbers in parentheses are still notes
 * ("#487（原为 #472，已拆票）", "无（#275 已关闭）") and don't count; everything outside does, so several per line ("#275、#276", "#305, #306") work too.
 * Split parents in parentheses used to count as blockers, and since a split parent stays open those tickets never got scheduled (2026-11-09 #473–#476).
 */
export const blockersOf = (body: string): number[] => {
  const refs = section(body, "Blocked by")
    .split("\n")
    .map((line) => line.match(LIST_ITEM)?.[1] ?? "")
    .flatMap((text) => [...stripParens(text).matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  return [...new Set(refs)];
};

/**
 * `## Split into` 里的子票：只认列表项开头的票号（`- [ ] #496 …`、`- #68 …`），同一行后面提到的票、
 * 不以票号开头的列表项（「- 删除 … 挪到 #500，排在 #468 之后」）和说明段落都不算。曾经把这些也算成子票，
 * 其中有一张 open，父票就一直不自动关（2026-11-09 #464 被 #500 挡住，#500 又被 #464 挡住）。
 * Children in `## Split into`: only numbers at the start of a list item (`- [ ] #496 …`, `- #68 …`); tickets mentioned later on the line,
 * list items not starting with a number ("- 删除 … 挪到 #500，排在 #468 之后") and prose don't count. They used to count as children,
 * and with one of them open the parent never auto-closed (2026-11-09 #464 blocked by #500, which was blocked by #464).
 */
export const splitChildren = (body: string): number[] => {
  const refs = section(body, "Split into")
    .split("\n")
    .map((line) => line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?#(\d+)/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return [...new Set(refs)];
};

/** 默认的测试文件路径（项目配置 gate.testFile）。 / Default test file path pattern (project config gate.testFile). */
export const DEFAULT_TEST_FILE = /test\/\S+\.test\.tsx?/;
/**
 * 门槛失败摘要里的 FAIL 行：` FAIL  test/….test.ts > 用例名`（与门槛脚本 `failures()` 的输出格式一致）。
 * FAIL lines in a gate failure summary: ` FAIL  test/….test.ts > test name` (matches the output of the gate script's `failures()`).
 */
const failLine = (testFile: RegExp) => new RegExp(`^ FAIL +(${testFile.source})`);
/**
 * 报错行之后不该当成报错的行：下一条 FAIL、分隔线（⎯ / = 等）、结尾的统计行、缩进的堆栈上下文。
 * Lines after an error line that aren't part of the error: the next FAIL, separators (⎯ / = etc.), the closing stats, indented stack context.
 */
const NOT_ERROR = /^(?: FAIL |[\s⎯━─=*]{3,}| *(?:Test Files|Tests) )/;

/**
 * 报错行的归一化签名：去掉首尾空白，把 `host.containers.internal`、IP、UUID 这类易变值换成占位，
 * 数字串（端口、行号、随机数）换成 `N`，截到 160 字。同一根因只有 IP / 端口 / 行号不同的报错
 * 得到同一个签名，reportFlaky 靠它认出「又出现一次」，不再一个文件开一张票（#607）。
 * Normalized signature of an error line: trim, replace volatile values like `host.containers.internal`, IPs and UUIDs with placeholders,
 * digit runs (ports, line numbers, random numbers) with `N`, cut to 160 characters. Errors with the same root cause that differ only in IP / port / line
 * get the same signature, so reportFlaky recognizes "it happened again" instead of opening a ticket per file (#607).
 */
export const flakySignature = (errorLine: string): string =>
  errorLine
    .trim()
    .replace(/host\.containers\.internal/g, "<host>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\d+/g, "N")
    .slice(0, 160);

/**
 * 门槛失败摘要里每个失败文件的报错签名：对每个 FAIL 行取它后面第一条非空行当报错（NOT_ERROR 的行跳过并停），
 * 归一化后作为签名；同一个文件只取第一条报错。摘要可能被门槛脚本的 `head -80` 截断，最后一个文件
 * 只剩 FAIL 行、没有报错时签名为空串，reportFlaky 让它退回只按标题去重的老逻辑。
 * Error signature of each failing file in a gate failure summary: for each FAIL line, the first non-empty line after it is the error (NOT_ERROR lines stop the search),
 * normalized into the signature; only the first error per file. The summary may be cut by the gate script's `head -80`, so the last file
 * may have only its FAIL line; its signature is then empty, and reportFlaky falls back to the old dedupe-by-title logic.
 */
export const flakyFailures = (summary: string, testFile: RegExp = DEFAULT_TEST_FILE): { file: string; signature: string }[] => {
  const lines = summary.split("\n");
  const FAIL_LINE = failLine(testFile);
  const firsts = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const file = lines[i]!.match(FAIL_LINE)?.[1];
    if (!file || firsts.has(file)) continue;
    let error: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      if (!NOT_ERROR.test(line)) error = line;
      break;
    }
    firsts.set(file, error === undefined ? "" : flakySignature(error));
  }
  return [...firsts].map(([file, signature]) => ({ file, signature }));
};

/**
 * reportFlaky 的分组与匹配（#607）：门槛里重跑才通过的文件按 flakyFailures 的签名分组，同签名共用一张票；
 * 解析不到报错（摘要被截断）的文件签名为空串，各自一组、没有标记，只按标题去重。每组生成新票标题
 * （组里第一个文件，多文件加「等 N 个文件」）和正文末尾的隐藏标记 `<!-- flaky-sig: … -->`（签名里的 `-->`
 * 换成 `--›`，免得提前收掉注释），再在已开的 flaky 票里按 ①正文含标记 → ②标题 `偶发失败：<文件>` 找 existing。
 * Grouping and matching for reportFlaky (#607): files that passed only on a gate rerun are grouped by flakyFailures signature, one ticket per signature;
 * files with no parsable error (truncated summary) get an empty signature, each in its own group without a marker, deduped by title only. Each group gets a new ticket title
 * (its first file, plus "and N files" for several) and a hidden marker at the end of the body `<!-- flaky-sig: … -->` (`-->` in the signature
 * becomes `--›` so the comment doesn't close early); existing is looked up among open flaky tickets by ① body contains the marker → ② title `偶发失败：<file>`.
 */
export const flakyTickets = (
  files: string[],
  after: string,
  open: { number: number; title: string; body: string }[],
  testFile: RegExp = DEFAULT_TEST_FILE,
  m: Messages = messages(),
): { files: string[]; signature: string; marker?: string; title: string; existing?: number }[] => {
  const signatures = new Map(flakyFailures(after, testFile).map((f) => [f.file, f.signature]));
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = signatures.get(file) || `按标题：${file}`;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.values()].map((groupFiles) => {
    const signature = signatures.get(groupFiles[0]!) ?? "";
    const marker = signature ? `<!-- flaky-sig: ${signature.replaceAll("-->", "--›")} -->` : undefined;
    const title = m.flakyTitle(groupFiles[0]!, groupFiles.length);
    const existing = (marker ? open.find((i) => i.body.includes(marker)) : undefined)
      ?? open.find((i) => groupFiles.some((f) => i.title === m.flakyTitle(f, 1)));
    return { files: groupFiles, signature, marker, title, existing: existing?.number };
  });
};

/**
 * 偶发失败的一次出现，记在 .sandcastle/logs/flaky.json，flakyTriage 按它判断「同一文件 7 天内第二次」。
 * One occurrence of a flaky failure, stored in .sandcastle/logs/flaky.json; flakyTriage uses it for "the same file a second time within 7 days".
 */
export type FlakySighting = { file: string; signature: string; at: string; issue: string };
export const FLAKY_WINDOW_DAYS = 7;

/**
 * 报错只是超时或连不上（负载、并发抢 PG 这类环境症状）：签名含 timeout / timed out / ETIMEDOUT / ECONN* / connect / 超时 / 连接。
 * 签名为空（摘要截断、日志被冲掉）也算：没有报错可查，开票只会是一张没法修的空票（#1236）。
 * The error is just a timeout or connection failure (environmental symptoms like load or contention for PG): the signature contains timeout / timed out / ETIMEDOUT / ECONN* / connect / 超时 / 连接.
 * An empty signature (truncated summary, log overwritten) counts too: with no error to investigate, a ticket would be empty and unfixable (#1236).
 */
export const flakyEnvironmental = (signature: string): boolean =>
  signature === "" || /time(?:d)? ?out|ETIMEDOUT|ECONN|EPIPE|connect|超时|连接/i.test(signature);

/**
 * 偶发失败开不开票（2026-11-24）：过去 40 多张偶发失败票七成是负载下超时、并发抢资源，修完产品代码不变，
 * 单次负载抖动就开票会把真 bug（#563、#1141）淹掉。规则：
 * - 已有同签名 / 同标题的票：照旧在老票上追加一次出现记录；
 * - 报错是断言失败这类（flakyEnvironmental 为假）：马上开票，可能是真 bug；
 * - 只是超时 / 连不上：同一文件在 FLAKY_WINDOW_DAYS 天内已经出现过才开票，否则只记一次出现、不开票。
 * 返回要开票（或追加）的组、只记录的组，以及去掉窗口外旧记录、加上这次出现后的新历史。
 * Whether a flaky failure opens a ticket (2026-11-24): of 40-odd past flaky tickets, 70% were timeouts under load or resource contention, fixed without product code changes;
 * opening a ticket for every load blip buried the real bugs (#563, #1141). Rules:
 * - an existing ticket with the same signature / title: append an occurrence to it as before;
 * - errors like assertion failures (flakyEnvironmental is false): open a ticket right away, it may be a real bug;
 * - only a timeout / connection failure: open a ticket only if the same file already occurred within FLAKY_WINDOW_DAYS days, otherwise just record it.
 * Returns the groups to open (or append to), the groups only recorded, and the new history with out-of-window records dropped and this occurrence added.
 */
export const flakyTriage = <G extends { files: string[]; signature: string; existing?: number }>(
  groups: G[],
  history: FlakySighting[],
  issue: string,
  now: Date,
): { ticket: G[]; deferred: G[]; history: FlakySighting[] } => {
  const since = now.getTime() - FLAKY_WINDOW_DAYS * 86_400_000;
  const recent = history.filter((h) => Date.parse(h.at) >= since);
  const ticket: G[] = [];
  const deferred: G[] = [];
  for (const g of groups) {
    const seenBefore = recent.some((h) => g.files.includes(h.file));
    (g.existing !== undefined || !flakyEnvironmental(g.signature) || seenBefore ? ticket : deferred).push(g);
  }
  const at = now.toISOString();
  const sightings = groups.flatMap((g) => g.files.map((file) => ({ file, signature: g.signature, at, issue })));
  return { ticket, deferred, history: [...recent, ...sightings] };
};

/**
 * 一张票都没开工就空转退出时打印的原因。`waiting` 是最后一次调度里被还开着的 blocker 挡住的票（票号 → blocker 票号），
 * 按票号升序逐行写出「#n 等 #m、#k」；为空时说明没有可以开工的票（没有带 picked 标签、还没开工的票，或者都在等人审 PR / 带 stuck）。
 * 不存在的 blocker 会被打 stuck，不在 `waiting` 里，所以通用原因里要提到 stuck。
 * Reason printed when the run idles out without starting any ticket. `waiting` holds the tickets blocked by still-open blockers in the last pass (ticket → blocker numbers),
 * written one per line in ascending ticket order as "#n waiting on #m, #k"; when empty, explains that no ticket can start (no un-started ticket with the picked label, or all waiting on PR review / labelled stuck).
 * Missing blockers get labelled stuck and aren't in `waiting`, so the generic reason mentions stuck.
 */
export const idleSummary = (waiting: ReadonlyMap<number, number[]>, labels: { picked: string; stuck: string }): string => {
  if (waiting.size === 0)
    return t(
      `没有可以开工的票：没有带 ${labels.picked} 标签、还没开工的票，或者都在等人审 PR / 带 ${labels.stuck} 等人处理`,
      `No ticket can start: no un-started ticket labelled ${labels.picked}, or all are waiting on PR review / labelled ${labels.stuck} for a human`,
    );
  const lines = [...waiting]
    .sort(([a], [b]) => a - b)
    .map(([n, blockers]) => {
      const refs = blockers.map((b) => `#${b}`);
      return t(`  #${n} 等 ${refs.join("、")}`, `  #${n} waiting on ${refs.join(", ")}`);
    });
  return [t("一张票都没开工就结束了，原因：", "Stopped without starting any ticket:"), ...lines].join("\n");
};
