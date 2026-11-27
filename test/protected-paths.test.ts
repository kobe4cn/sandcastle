// test/protected-paths.test.ts —— 受保护路径（`src/protected-paths.ts`，纯函数）：
// 票的 diff 里哪些文件命中 protectedPaths，每个文件报第一条命中的规则（规则源码 String(re)）；挡不挡合并（取不到 diff 时 fail-closed）。
import { describe, expect, it } from "vitest";
import { messages } from "../src/i18n.ts";
import { protectedBlock, protectedHits } from "../src/protected-paths.ts";

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
