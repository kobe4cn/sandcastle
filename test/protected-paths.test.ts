// test/protected-paths.test.ts —— 受保护路径（`src/protected-paths.ts`，纯函数）：
// 票的 diff 里哪些文件命中 protectedPaths，每个文件报第一条命中的规则（规则源码 String(re)）；挡不挡合并（取不到 diff 时 fail-closed）。
import { describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import { allowedProtected, allowedSection, protectedBlock, protectedHits, splitAllowed } from "../src/protected-paths.ts";

describe("protectedHits：diff 里命中 protectedPaths 的文件和规则", () => {
  it("没配规则时一个都不算", () => {
    expect(protectedHits(["src/a.ts", ".github/workflows/ci.yml"], [])).toEqual([]);
  });
  it("没改文件时为空", () => {
    expect(protectedHits([], [/^\.github\//])).toEqual([]);
  });
  it("多文件多规则：挑出命中的文件，按 diff 顺序，带上命中的规则", () => {
    expect(protectedHits(["src/a.ts", ".github/workflows/ci.yml", "package-lock.json", "README.md"], [/^\.github\//, /(^|\/)package-lock\.json$/])).toEqual([
      { file: ".github/workflows/ci.yml", rule: "/^\\.github\\//" },
      { file: "package-lock.json", rule: "/(^|\\/)package-lock\\.json$/" },
    ]);
  });
  it("一个文件命中多条规则时只报第一条", () => {
    expect(protectedHits([".github/workflows/ci.yml"], [/\.yml$/, /^\.github\//])).toEqual([{ file: ".github/workflows/ci.yml", rule: "/\\.yml$/" }]);
  });
  it("带 g 标志的正则反复用也不漏判", () => {
    const g = /^migrations\//g;
    expect(protectedHits(["migrations/1.sql", "migrations/2.sql", "migrations/3.sql"], [g]).map((h) => h.file)).toEqual([
      "migrations/1.sql",
      "migrations/2.sql",
      "migrations/3.sql",
    ]);
    expect(protectedHits(["migrations/1.sql"], [g])).toEqual([{ file: "migrations/1.sql", rule: "/^migrations\\//g" }]);
  });
});

describe("reasonProtected：留 PR 的原因逐条列出文件和规则", () => {
  const hits = protectedHits([".github/workflows/ci.yml", "migrations/1.sql"], [/^\.github\//, /^migrations\//]);
  it("中文", () => {
    expect(messages("zh").reasonProtected(hits)).toBe(
      "改到了受保护路径（protectedPaths），需要人看过再合并：\n\n- `.github/workflows/ci.yml` — `/^\\.github\\//`\n- `migrations/1.sql` — `/^migrations\\//`",
    );
  });
  it("英文", () => {
    expect(messages("en").reasonProtected(hits)).toContain("- `migrations/1.sql` — `/^migrations\\//`");
  });
});

describe("protectedBlock：受保护路径挡不挡自动合并", () => {
  const zh = messages("zh");
  const rules = [/^\.github\//];
  it.each([
    ["没配规则：改了什么都不挡", ["\.github/x.yml"], [], undefined],
    ["没配规则：取不到 diff 也不挡", undefined, [], undefined],
    ["配了规则、没命中：不挡", ["src/a.ts"], rules, undefined],
    ["配了规则、取不到 diff：按命中处理", undefined, rules, zh.reasonProtectedUnknown],
    ["配了规则、没改文件：不挡", [], rules, undefined],
  ] as const)("%s", (_name, changed, rs, want) => {
    expect(protectedBlock(changed && [...changed], [...rs], zh)).toBe(want);
  });
  it("有命中：原因逐条列出", () => {
    expect(protectedBlock(["src/a.ts", ".github/ci.yml"], rules, zh)).toBe(zh.reasonProtected([{ file: ".github/ci.yml", rule: "/^\\.github\\//" }]));
  });
  it("英文取不到 diff 的文案", () => {
    expect(protectedBlock(undefined, rules, messages("en"))).toContain("Couldn't read this ticket's diff");
  });
});

describe("allowedProtected：票的实现指引里 `- **Protected**` 项允许的路径", () => {
  it("没有实现指引一节 → 空", () => {
    expect(allowedProtected("## What to build\n\n- **Protected**: `a.yml`\n")).toEqual([]);
  });
  it("一项里多个反引号路径都取，目录保留结尾的 /", () => {
    const body = "## Implementation guide\n\n- **Change**: `src/a.ts`\n- **Protected**: `.github/workflows/ci.yml`, `migrations/`（要加迁移）\n* **Protected**：`x/__snapshots__/a.snap`\n";
    expect(allowedProtected(body)).toEqual([".github/workflows/ci.yml", "migrations/", "x/__snapshots__/a.snap"]);
  });
  it("项写在其它节里不算", () => {
    const body = "## What to build\n\n- **Protected**: `a.yml`\n\n## Implementation guide\n\n- **Change**: `src/a.ts`\n\n## Notes\n\n- **Protected**: `b.yml`\n";
    expect(allowedProtected(body)).toEqual([]);
  });
  it("路径里可以有空格；开头的 ./ 和 / 去掉；去掉后为空的不算", () => {
    const body = "## Implementation guide\n\n- **Protected**: `docs/my file.md`, `./migrations/`, `/.github/ci.yml`, `/`, `./`\n";
    expect(allowedProtected(body)).toEqual(["docs/my file.md", "migrations/", ".github/ci.yml"]);
  });
  it("别的列表项里提到 Protected 不算", () => {
    expect(allowedProtected("## Implementation guide\n\n- **Watch out**: **Protected** `a.yml` 不要改\n")).toEqual([]);
  });
});

describe("splitAllowed：命中分成被票允许的和要挡的", () => {
  const hits = protectedHits(["migrations/1.sql", "migrations2/1.sql", ".github/ci.yml", ".github/ci.yml.bak"], [/^migrations/, /^\.github\//]);
  it("目录前缀（以 / 结尾）与全等两种匹配", () => {
    expect(splitAllowed(hits, ["migrations/", ".github/ci.yml"])).toEqual({
      allowed: [hits[0], hits[2]],
      blocked: [hits[1], hits[3]],
    });
  });
  it("没有允许项时全挡", () => {
    expect(splitAllowed(hits, [])).toEqual({ allowed: [], blocked: hits });
  });
});

describe("protectedBlock 带票允许的路径", () => {
  const zh = messages("zh");
  const rules = [/^\.github\//];
  it("命中全被允许：不挡", () => {
    expect(protectedBlock([".github/a.yml"], rules, zh, [".github/"])).toBeUndefined();
  });
  it("部分被允许：原因只列没被允许的", () => {
    expect(protectedBlock([".github/a.yml", ".github/b.yml"], rules, zh, [".github/a.yml"])).toBe(
      zh.reasonProtected([{ file: ".github/b.yml", rule: "/^\\.github\\//" }]),
    );
  });
  it("挡住时提示没匹配上任何命中的放行项", () => {
    const reason = protectedBlock([".github/b.yml"], rules, zh, ["github/", ".github/a.yml"]);
    expect(reason).toBe(`${zh.reasonProtected([{ file: ".github/b.yml", rule: "/^\\.github\\//" }])}${zh.protectedAllowedUnmatched(["github/", ".github/a.yml"])}`);
    expect(zh.protectedAllowedUnmatched(["github/"])).toContain("`github/`");
    expect(messages("en").protectedAllowedUnmatched(["github/"])).toContain("`github/`");
  });
  it("放行项都匹配上了别的命中：不提示", () => {
    expect(protectedBlock([".github/a.yml", ".github/b.yml"], rules, zh, [".github/a.yml"])).not.toContain(zh.protectedAllowedUnmatched([".github/a.yml"]));
  });
  it("取不到 diff：允许了也按命中处理", () => {
    expect(protectedBlock(undefined, rules, zh, [".github/"])).toBe(zh.reasonProtectedUnknown);
  });
});

describe("allowedSection：PR 正文 Protected paths 一节", () => {
  const rules = [/^\.github\//];
  it("有被允许的命中：逐条列出文件、规则和（ticket allowed）", () => {
    expect(allowedSection([".github/a.yml", "src/x.ts", ".github/b.yml"], rules, [".github/a.yml"], messages("zh"))).toBe(
      "- `.github/a.yml` — `/^\\.github\\//`（ticket allowed）",
    );
    expect(allowedSection([".github/a.yml"], rules, [".github/"], messages("en"))).toBe("- `.github/a.yml` — `/^\\.github\\//` (ticket allowed)");
  });
  it("except 里的文件不再列（rebase 前已在 PR 里标过）", () => {
    expect(allowedSection([".github/a.yml", ".github/b.yml"], rules, [".github/"], messages("zh"), [".github/a.yml"])).toBe(
      "- `.github/b.yml` — `/^\\.github\\//`（ticket allowed）",
    );
    expect(allowedSection([".github/a.yml"], rules, [".github/"], messages("zh"), [".github/a.yml"])).toBeUndefined();
  });
  it("没有被允许的命中、没配规则或取不到 diff：undefined", () => {
    expect(allowedSection([".github/a.yml"], rules, [], messages("zh"))).toBeUndefined();
    expect(allowedSection([".github/a.yml"], [], [".github/"], messages("zh"))).toBeUndefined();
    expect(allowedSection(undefined, rules, [".github/"], messages("zh"))).toBeUndefined();
  });
});
