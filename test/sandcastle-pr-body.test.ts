// test/sandcastle-pr-body.test.ts —— Sandcastle PR 正文的验收说明（`.sandcastle/pr-body.ts`，纯函数、不连库）：
// 格式检查（三个小标题、编号步骤、不出现二级标题）、准备段落的三种形态（配了准备步骤、改了页面但没配、没改页面）、正文各节顺序与折叠、只替换一节。
import { describe, expect, it } from 'vitest';
import { acceptanceSection, browserSection, checkAcceptanceNotes, pageChangedByReview, replaceGenerated, replaceSection, restSections, sectionOf } from '../src/pr-body.ts';
import { messages } from '../src/i18n.ts';
import crm from '../examples/duckdb_crm/sandcastle.config.ts';

const notes = [
  '### 做了什么', '',
  '登录页的邮箱框失焦时不再清掉已填的内容。', '',
  '### 怎么验证', '',
  '1. 打开 `/login`，填 `admin@crmlab-smoke.test`，点表单外：邮箱内容还在（验收标准 1）', '',
  '### 最终效果', '',
  '邮箱框行为如上，其余页面不变。', '',
].join('\n');

describe('Sandcastle 验收说明格式检查 checkAcceptanceNotes', () => {
  it('三个小标题齐全且「怎么验证」有编号步骤：无问题', () => {
    expect(checkAcceptanceNotes(notes)).toEqual([]);
  });

  it('缺哪个小标题报哪个', () => {
    const md = notes.replace('### 怎么验证\n\n1. 打开 `/login`，填 `admin@crmlab-smoke.test`，点表单外：邮箱内容还在（验收标准 1）\n\n', '');
    expect(checkAcceptanceNotes(md)).toEqual(['缺 `### 怎么验证` 小标题']);
  });

  it('「怎么验证」下面没有编号步骤时报出来', () => {
    const md = notes.replace('1. 打开', '- 打开');
    expect(checkAcceptanceNotes(md)).toEqual(['「怎么验证」下面没有编号步骤']);
  });

  it('文件不存在：报「文件不存在」', () => {
    expect(checkAcceptanceNotes(undefined)).toEqual(['文件不存在']);
  });

  it('出现 `## ` 二级标题时报出来（它会让替换这一节时切错）', () => {
    expect(checkAcceptanceNotes(`${notes}\n## 附注\n\n不该出现。\n`)).toEqual(['文件里出现了 `## ` 二级标题（只能写 `###` 小标题，二级标题会让替换这一节时切错）']);
  });
});

describe('Sandcastle 验收说明一节 acceptanceSection', () => {
  it('改了页面的票：项目配置的准备步骤（duckdb_crm：checkout / dev server / browser-lab / 登录）拼在文件内容前面', () => {
    const section = acceptanceSection('sandcastle/issue-1', notes, { pageChanged: true, pagePrep: crm.acceptancePrep });
    expect(section.startsWith('### 准备')).toBe(true);
    for (const part of [
      'git checkout sandcastle/issue-1',
      'npm run dev',
      'scripts/browser-lab.ts',
      'crmlab-smoke',
      'admin@', 'eng@', 'an@crmlab-smoke.test',
    ]) expect(section).toContain(part);
    expect(section.endsWith(notes)).toBe(true);
    expect(section.indexOf('### 准备')).toBeLessThan(section.indexOf('### 做了什么'));
  });

  it('改了页面但项目没配准备步骤：写明要起 dev server，不写「本票没改页面」', () => {
    const section = acceptanceSection('sandcastle/issue-3', notes, { pageChanged: true });
    expect(section.startsWith('### 准备')).toBe(true);
    expect(section).toContain('git checkout sandcastle/issue-3');
    expect(section).toContain('本票改了页面，需要起 dev server（项目没配准备步骤）');
    expect(section).not.toContain('本票没改页面');
    expect(section.endsWith(notes)).toBe(true);
  });

  it.each([
    ['done', true], ['missing', true], [' done\n', true],
    ['none', false], [undefined, false], ['需要', false],
  ] as const)('pageChangedByReview(%j) = %s', (tag, expected) => {
    expect(pageChangedByReview(tag)).toBe(expected);
  });

  it('没改页面的票：准备只有 checkout，不用起 dev server', () => {
    const section = acceptanceSection('sandcastle/issue-2', notes, { pageChanged: false });
    expect(section.startsWith('### 准备')).toBe(true);
    expect(section).toContain('git checkout sandcastle/issue-2');
    expect(section).not.toContain('npm run dev');
    expect(section.endsWith(notes)).toBe(true);
  });

  it('文件不存在：警告文字', () => {
    expect(acceptanceSection('b', undefined, { pageChanged: false })).toBe('⚠️ implementer 没有写验收说明');
  });

  it('格式不对：警告带问题列表，后面跟原文让人看见', () => {
    const bad = '### 做了什么\n\n没有小标题了。\n';
    const section = acceptanceSection('b', bad, { pageChanged: false });
    expect(section.startsWith('⚠️ 验收说明格式不对：')).toBe(true);
    expect(section).toContain('### 怎么验证');
    expect(section.endsWith(bad)).toBe(true);
  });
});

describe('Sandcastle PR 正文其余各节 restSections', () => {
  it('顺序 Review → Browser check，Gate / Budget / Usage 各折一个 details', () => {
    const body = restSections({ review: '摘要', browser: 'RESULT 内容', gate: 'gateNote', budget: 'budgetNote', usage: 'usageTable' });
    expect(body).toBe([
      '## Review', '', '摘要', '',
      '## Browser check', '', 'RESULT 内容', '',
      '<details><summary>Gate</summary>', '', 'gateNote', '', '</details>', '',
      '<details><summary>Budget</summary>', '', 'budgetNote', '', '</details>', '',
      '<details><summary>Usage</summary>', '', 'usageTable', '', '</details>',
    ].join('\n'));
  });

  it('有票允许的受保护路径时：Browser check 之后、Gate 之前放 Protected paths 一节', () => {
    const body = restSections({ review: '摘要', browser: 'B', protected: '- `a` — `/a/`（ticket allowed）', gate: 'g', budget: 'b', usage: 'u' });
    expect(body.indexOf('## Browser check')).toBeLessThan(body.indexOf('## Protected paths\n\n- `a` — `/a/`（ticket allowed）'));
    expect(body.indexOf('## Protected paths')).toBeLessThan(body.indexOf('Gate'));
  });
  it('没有票允许的受保护路径时没有 Protected paths 一节', () => {
    expect(restSections({ review: '摘要', gate: 'g', budget: 'b', usage: 'u' })).not.toContain('Protected paths');
  });
  it('没做浏览器验收时没有 Browser check 一节', () => {
    const body = restSections({ review: '摘要', gate: 'g', budget: 'b', usage: 'u' });
    expect(body).not.toContain('Browser check');
    expect(body.indexOf('## Review')).toBeLessThan(body.indexOf('<details>'));
  });
});

describe('Sandcastle PR 正文的 Browser check 一节 browserSection', () => {
  const b = { result: '- ✅ 列表正常（list.png）', shots: ['/tmp/list.png'] };
  it('有 .browser-check/、票里有 Browser check、评审没给结论：写明没有逐条结论，再放 RESULT.md + 截图说明', () => {
    const zh = messages('zh');
    expect(browserSection(b, false)).toBe(
      `### ${zh.browserReviewerVerdict}\n\n${zh.browserNoReviewerVerdict}\n\n### ${zh.browserSelfCheck}\n\n- ✅ 列表正常（list.png）\n\n截图 1 张，附在下面。`,
    );
    expect(zh.browserNoReviewerVerdict).toBe('评审没有给出逐条结论');
  });
  it('有评审结论：评审结论在前，implement 自评（RESULT.md）在后', () => {
    const zh = messages('zh');
    const s = browserSection(b, false, zh, '- ❌ 列表正常：截图里列表是空的')!;
    expect(zh.browserReviewerVerdict).toBe('评审结论');
    expect(zh.browserSelfCheck).toBe('implement 自评（RESULT.md）');
    expect(s.indexOf(zh.browserReviewerVerdict)).toBeLessThan(s.indexOf('截图里列表是空的'));
    expect(s.indexOf('截图里列表是空的')).toBeLessThan(s.indexOf(zh.browserSelfCheck));
    expect(s.indexOf(zh.browserSelfCheck)).toBeLessThan(s.indexOf('- ✅ 列表正常（list.png）'));
    expect(s).not.toContain(zh.browserNoReviewerVerdict);
  });
  it('没有 .browser-check/ 时评审结论不出现，行为不变', () => {
    expect(browserSection(undefined, false, messages('zh'), '- ✅ x：y')).toBeUndefined();
    expect(browserSection(undefined, true, messages('zh'), '- ✅ x：y')).toBe(messages('zh').browserNoTicketCheck);
  });
  it('没有 .browser-check/、也不缺 Browser check：没有这一节', () => {
    expect(browserSection(undefined, false)).toBeUndefined();
  });
  it('票里缺 Browser check、没有 .browser-check/：只有提示', () => {
    expect(browserSection(undefined, true)).toBe(messages('zh').browserNoTicketCheck);
    expect(messages('zh').browserNoTicketCheck).toContain('票里没有 Browser check，建议补 prep 规则');
  });
  it('票里缺 Browser check、有 .browser-check/：提示在前，RESULT.md 在后', () => {
    const s = browserSection(b, true, messages('zh'), '- ✅ 列表正常：有三行')!;
    expect(s.startsWith(messages('zh').browserNoTicketCheck)).toBe(true);
    expect(s.indexOf('有三行')).toBeLessThan(s.indexOf('列表正常（list.png）'));
  });
  it('英文', () => {
    const en = messages('en');
    expect(browserSection(undefined, true, en)).toContain('no Browser check');
    const s = browserSection(b, false, en, '- ✅ list: rows shown')!;
    expect(s.indexOf("Reviewer's verdict")).toBeLessThan(s.indexOf("Implementer's self-check (RESULT.md)"));
    expect(browserSection(b, false, en)).toContain('The reviewer gave no per-step verdict');
  });
  it('只有提示时 restSections 也出这一节', () => {
    expect(restSections({ review: 'r', browser: browserSection(undefined, true), gate: 'g', budget: 'b', usage: 'u' })).toContain('## Browser check');
  });
});

describe('Sandcastle 只替换正文一节 replaceSection', () => {
  const body = [
    'Closes #7', '',
    '## 验收说明', '',
    '旧的验收说明。', '',
    '## Review', '',
    '旧的摘要。', '',
    '## Gate', '',
    '旧的门槛。',
  ].join('\n');

  it('只换这一节，其余逐字不变（前后各有别的节）', () => {
    const replaced = replaceSection(body, '验收说明', '## 验收说明\n\n新的验收说明。');
    expect(replaced).toBe([
      'Closes #7', '',
      '## 验收说明', '', '新的验收说明。', '',
      '## Review', '', '旧的摘要。', '',
      '## Gate', '', '旧的门槛。',
    ].join('\n'));
  });

  it('正文里没有这一节时加在 Closes #n 后面（空一行）', () => {
    const without = body.replace('## 验收说明\n\n旧的验收说明。\n\n', '');
    expect(replaceSection(without, '验收说明', '## 验收说明\n\n新的验收说明。')).toBe(body.replace('旧的验收说明。', '新的验收说明。'));
  });

  it('格式不对的原文里有 `## 附注`：降成 `###` 进正文，重做替换时整节换掉，Review 及以后逐字不变', () => {
    const bad = `${notes}\n## 附注\n\n旧的附注文字。\n##\n`;
    const section = acceptanceSection('b', bad, { pageChanged: false });
    expect(section.split('\n').filter((line) => /^##(\s|$)/.test(line))).toEqual([]);
    expect(section).toContain('### 附注');
    const tail = ['## Review', '', '旧的摘要。', '', '## Gate', '', '旧的门槛。'].join('\n');
    const first = replaceSection(`Closes #7\n\n${tail}`, '验收说明', `## 验收说明\n\n${section}`);
    expect(first).toContain('旧的附注文字。');
    const redone = replaceSection(first, '验收说明', '## 验收说明\n\n新的验收说明。');
    expect(redone).toBe(`Closes #7\n\n## 验收说明\n\n新的验收说明。\n\n${tail}`);
    expect(redone).not.toContain('附注');
  });

  it('正文只有 Closes #n 时也能插入；`###` 小标题不会被当成节边界', () => {
    expect(replaceSection('Closes #7', '验收说明', '## 验收说明\n\n内容\n\n### 做了什么\n\n…')).toBe(
      'Closes #7\n\n## 验收说明\n\n内容\n\n### 做了什么\n\n…',
    );
  });
});

describe('Sandcastle 每轮替换正文的工具生成节 replaceGenerated', () => {
  const zh = messages('zh');
  // 第一轮：无 Browser check / Protected paths。 / Round one: no Browser check / Protected paths.
  const first = restSections({ review: '第一轮摘要。', gate: '第一轮门槛。', budget: '第一轮预算。', usage: '第一轮用量。' });
  // 第二轮：带 Browser check（评审结论 + RESULT.md）和 Protected paths。 / Round two: with Browser check (verdict + RESULT.md) and Protected paths.
  const second = restSections({
    review: '第二轮摘要。',
    browser: browserSection({ result: '- ✅ 列表正常（list.png）', shots: ['/tmp/list.png'] }, false, zh, '- ✅ 列表正常：截图里列表正确'),
    protected: 'src/trust.ts（**Protected** 放行）',
    gate: '第二轮门槛。', budget: '第二轮预算。', usage: '第二轮用量。',
  });
  // 已有 PR 的正文：验收说明 + 第一轮各节 + Commits 及 gh --attach 追加在末尾的截图行。
  // Body of the existing PR: acceptance notes + round-one sections + Commits and the screenshot lines gh --attach appended at the end.
  const tail = ['## Commits', '', '- 第一轮提交', '', '![shot](https://example.com/a.png)'].join('\n');
  const body = `Closes #7\n\n## 验收说明\n\n旧的验收说明。\n\n${first}\n\n${tail}`;

  it('整段换成本轮的内容：新出现的节在、消失的节不在，Gate 等不重复，验收说明与 Commits 起逐字不变', () => {
    const replaced = replaceGenerated(body, second);
    // 新出现的节带本轮的评审结论和 RESULT.md（验收标准 2）。 / Newly present sections carry this round's verdict and RESULT.md (criterion 2).
    expect(replaced).toContain('## Browser check');
    expect(replaced).toContain('- ✅ 列表正常：截图里列表正确');
    expect(replaced).toContain('- ✅ 列表正常（list.png）');
    expect(replaced).toContain('## Protected paths');
    // 上一轮的结论不在正文里保留。 / Last round's conclusions don't stay in the body.
    expect(replaced).not.toContain('第一轮摘要。');
    // `<details>` 挂在最后一个 `##` 节下，整段替换后不重复。 / `<details>` hangs off the last `##` section; no duplicates after the wholesale replace.
    expect(replaced.split('<details><summary>Gate</summary>').length).toBe(2);
    // 验收说明（replaceSection 单独替换的那节）不受影响。 / The acceptance notes (replaced separately by replaceSection) are untouched.
    expect(replaced).toContain('旧的验收说明。');
    // `## Commits` 及之后（含 gh 追加的截图行）逐字不变。 / `## Commits` and everything after (including gh-appended screenshot lines) stay verbatim.
    expect(replaced.slice(replaced.indexOf('## Commits'))).toBe(tail);
    // 落地读回核对的两边：读回正文与本轮 rest 各取一次 Review 一节，一样。 / The two sides of the landing read-back check: the Review section of the edited body and of this round's rest match.
    expect(sectionOf(replaced, 'Review')).toBe(sectionOf(second, 'Review'));
  });

  it('上一轮有、这一轮没有的节随整段消失', () => {
    const replaced = replaceGenerated(body.replace(first, restSections({
      review: '第一轮摘要。',
      browser: browserSection({ result: '- ✅ 列表正常（list.png）', shots: ['/tmp/list.png'] }, false, zh),
      gate: '第一轮门槛。', budget: '第一轮预算。', usage: '第一轮用量。',
    })), first);
    expect(replaced).not.toContain('## Browser check');
    expect(replaced).toContain('## Review');
  });

  it('正文里没有 `## Review` 时插在 `## Commits` 之前，不走 replaceSection 的「插在 Closes 后面」', () => {
    const noReview = `Closes #7\n\n## 验收说明\n\n旧的验收说明。\n\n${tail}`;
    expect(replaceGenerated(noReview, second)).toBe(`Closes #7\n\n## 验收说明\n\n旧的验收说明。\n\n${second}\n\n${tail}`);
  });

  it('没有 `## Commits` 时追加到末尾', () => {
    expect(replaceGenerated(`Closes #7\n\n## 验收说明\n\n旧的验收说明。`, second)).toBe(
      `Closes #7\n\n## 验收说明\n\n旧的验收说明。\n\n${second}`,
    );
  });

  it('sectionOf 取 `## 标题` 一节到下一个二级标题前（含节与下一节之间的空行），没有这一节时 undefined', () => {
    expect(sectionOf(`Closes #7\n\n## Review\n\n摘要。\n\n## Commits\n\n- 提交`, 'Review')).toBe('## Review\n\n摘要。\n');
    expect(sectionOf('Closes #7', 'Review')).toBeUndefined();
  });
});
