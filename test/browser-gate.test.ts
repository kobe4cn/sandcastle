// test/browser-gate.test.ts —— 浏览器验收作为自动合并的硬条件（`src/browser-gate.ts`，纯函数）：
// 哪些改动算改了页面、浏览器验收缺什么（返回问题数组，缺哪个报哪个）、合并前的结论（留不留 PR、原因）。
import { describe, expect, it } from "vitest";
import { browserProblems, browserSetupWarning, browserVerdict, pageFiles, ticketHasBrowserCheck } from "../src/browser-gate.ts";
import { messages } from "../src/i18n.ts";
import { setTermLanguage } from "../src/term.ts";

const zh = messages("zh");
const en = messages("en");

const result = ["# 浏览器验收", "", "图例：✅ 通过 ❌ 没过 ⚠ 有疑问", "", "- ✅ 登录后看到客户列表（list.png）", "- ✅ 新建客户成功（new.png）"].join("\n");
const ok = { result, shots: ["/tmp/x/list.png", "/tmp/x/new.png"] };

describe("pageFiles：diff 里命中 browser.pagePaths 的文件", () => {
  it("挑出命中任一正则的文件", () => {
    expect(pageFiles(["src/app/page.tsx", "src/db.ts", "styles/a.css"], [/\.tsx$/, /\.css$/])).toEqual(["src/app/page.tsx", "styles/a.css"]);
  });
  it("没配 pagePaths 时一个都不算", () => {
    expect(pageFiles(["src/app/page.tsx"], [])).toEqual([]);
  });
  it("带 g 标志的正则反复用也不漏判", () => {
    const g = /\.tsx$/g;
    expect(pageFiles(["a.tsx", "b.tsx", "c.tsx"], [g])).toEqual(["a.tsx", "b.tsx", "c.tsx"]);
  });
});

describe("browserProblems：浏览器验收缺什么", () => {
  it("全部满足：无问题", () => {
    expect(browserProblems(ok, "done", zh)).toEqual([]);
  });
  it("没有 .browser-check/：说清是改了页面但没做浏览器验收", () => {
    expect(browserProblems(undefined, "missing", zh)).toEqual(["改了页面但没做浏览器验收（worktree 里没有 `.browser-check/`）"]);
  });
  it("没有截图", () => {
    expect(browserProblems({ result: "- ✅ 页面正常", shots: [] }, "done", zh)).toEqual(["没有截图"]);
  });
  it("RESULT.md 缺失", () => {
    expect(browserProblems({ shots: ok.shots }, "done", zh)).toEqual(["没有 RESULT.md"]);
  });
  it("列表行有 ❌（图例行不算）", () => {
    const md = `${result}\n- ❌ 删除客户报错`;
    expect(browserProblems({ ...ok, result: md }, "done", zh)).toEqual(["RESULT.md 有没通过的项（❌ / ⚠）：「- ❌ 删除客户报错」"]);
  });
  it("表格行有 ⚠（带 U+FE0F 的也算）", () => {
    const md = `${result}\n| 导出 | ⚠️ 文件名乱码 |`;
    expect(browserProblems({ ...ok, result: md }, "done", zh)).toEqual(["RESULT.md 有没通过的项（❌ / ⚠）：「| 导出 | ⚠️ 文件名乱码 |」"]);
  });
  it("编号列表行有 ❌", () => {
    expect(browserProblems({ ...ok, result: `${result}\n1. ❌ 保存失败` }, "done", zh)).toHaveLength(1);
  });
  it("引用的截图不存在", () => {
    const md = `${result}\n- ✅ 编辑客户（edit.png、EDIT2.JPG）`;
    expect(browserProblems({ ...ok, result: md }, "done", zh)).toEqual(["RESULT.md 引用的截图不存在：edit.png、EDIT2.JPG"]);
  });
  it("review 的 browser-check 不是 done", () => {
    expect(browserProblems(ok, "missing", zh)).toEqual(["review 的 browser-check 是 `missing`，不是 done"]);
    expect(browserProblems(ok, undefined, zh)).toEqual(["review 没有给出 browser-check（要求是 done）"]);
  });
  it("几个问题同时出现时逐条报", () => {
    expect(browserProblems({ shots: [] }, "none", zh)).toHaveLength(3);
  });
});

describe("browserVerdict：合并前的结论", () => {
  it("没改页面：不挡", () => {
    expect(browserVerdict({ pages: false, hasBrowser: false }, zh)).toEqual({});
    expect(browserVerdict({ pages: false, hasBrowser: true }, zh)).toEqual({});
  });
  it("改了页面、全部满足：不挡", () => {
    expect(browserVerdict({ pages: true, hasBrowser: true, browser: ok, tag: "done" }, zh)).toEqual({});
  });
  it("改了页面、有问题：原因逐条写缺什么", () => {
    const { block } = browserVerdict({ pages: true, hasBrowser: true, browser: { result: "- ✅ 页面正常", shots: [] }, tag: "missing" }, zh);
    expect(block).toContain("没有截图；review 的 browser-check 是 `missing`");
    expect(block).toMatch(/^改了页面，浏览器验收不满足自动合并的条件/);
  });
  it("改了页面但没配浏览器验收：留 PR 并给补法", () => {
    const { block } = browserVerdict({ pages: true, hasBrowser: false, browser: ok, tag: "done" }, zh);
    expect(block).toContain("改了页面、本项目没配浏览器验收");
    expect(block).toContain("onboard");
    expect(block).toContain("## 浏览器验收");
  });
});

describe("英文文案", () => {
  it("问题与原因都是英文", () => {
    expect(browserProblems(undefined, "missing", en)).toEqual(["pages changed but no browser check was done (no `.browser-check/` in the worktree)"]);
    expect(browserProblems({ shots: [] }, "done", en)).toEqual(["no screenshots", "no RESULT.md"]);
    expect(browserVerdict({ pages: true, hasBrowser: false }, en).block).toContain("## Browser check");
    expect(browserVerdict({ pages: true, hasBrowser: true, browser: ok, tag: "none" }, en).block).toMatch(/^Pages changed/);
  });
});

describe("ticketHasBrowserCheck：票正文有没有 Browser check", () => {
  it("实现指引里的列表项算", () => {
    expect(ticketHasBrowserCheck("## Implementation guide\n- **Change**: `a.ts`\n- **Browser check**：以管理员打开 /customers，应看到列表")).toBe(true);
  });
  it("没有这一项不算；只提到 browser check 字样也不算", () => {
    expect(ticketHasBrowserCheck("## Implementation guide\n- **Change**: `a.ts`\n后面再做 browser check")).toBe(false);
  });
});

describe("browserSetupWarning：项目有页面却没配浏览器验收", () => {
  it("中文：说明后果，给两种补法和文档路径", () => {
    setTermLanguage("zh", {});
    const w = browserSetupWarning("docs/config.zh-CN.md");
    expect(w).toContain("PROJECT.md 没有「浏览器验收」");
    expect(w).toContain("改页面的票会留给人看");
    expect(w).toContain("onboard");
    expect(w).toContain("## 浏览器验收");
    expect(w).toContain("docs/config.zh-CN.md");
  });
  it("英文", () => {
    setTermLanguage("en", {});
    const w = browserSetupWarning("docs/config.md");
    expect(w).toContain("no Browser check section");
    expect(w).toContain("onboard");
    expect(w).toContain("## Browser check");
    expect(w).toContain("docs/config.md");
  });
});
