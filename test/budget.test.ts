import { describe, expect, it } from "vitest";
import { BudgetExceeded, recordTokens, ticketSpend } from "../src/budget.ts";
import type { UsageRecord } from "../src/models.ts";

/** 造一条用量记录：只填要断言的字段，其余给 0 / 占位值。 / Make a usage record: only the asserted fields matter, the rest get 0 / placeholders. */
const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  at: "2026-11-28T00:00:00.000Z",
  issue: "1",
  phase: "implement",
  run: "implement-1-1",
  profile: "claude",
  model: "opus",
  sessions: 1,
  input: 0,
  cacheCreation: 0,
  cacheRead: 0,
  output: 0,
  peak: 0,
  ...over,
});

describe("recordTokens（#61 决定 2 的口径）", () => {
  it("没有 models 时取主行的输入、缓存写、缓存读、输出四项之和", () => {
    expect(recordTokens(rec({ input: 100, cacheCreation: 20, cacheRead: 300, output: 40 }))).toBe(460);
  });

  it("有 models 时取各模型四项之和，不再加主行（主行是主会话口径，看不出子代理用的模型）", () => {
    const r = rec({
      input: 1000, cacheCreation: 1000, cacheRead: 1000, output: 1000,
      models: [
        { model: "opus→glm-5.3", input: 1, cacheCreation: 2, cacheRead: 3, output: 4 },
        { model: "haiku→glm-4.5-air", input: 10, cacheCreation: 20, cacheRead: 30, output: 40 },
      ],
    });
    expect(recordTokens(r)).toBe(110);
  });

  it("models 是空数组时和没有一样，退回主行四项之和", () => {
    expect(recordTokens(rec({ input: 5, cacheCreation: 6, cacheRead: 7, output: 8, models: [] }))).toBe(26);
  });
});

describe("ticketSpend（#61 决定 3 的口径）", () => {
  it("各条记录相加：不同阶段、不同 run、limited 的记录都算", () => {
    const records = [
      rec({ phase: "prep", input: 100 }),
      rec({ phase: "implement", run: "implement-1-1", input: 200, cacheRead: 50 }),
      rec({ phase: "implement", run: "implement-1-2", limited: true, input: 30 }),
      rec({ phase: "review", input: 0, models: [{ model: "opus", input: 1, cacheCreation: 2, cacheRead: 3, output: 4 }] }),
    ];
    expect(ticketSpend(records)).toBe(390);
  });

  it("没有记录时是 0", () => {
    expect(ticketSpend([])).toBe(0);
  });
});

describe("BudgetExceeded", () => {
  it("带上已用和上限，name 标成类名", () => {
    const e = new BudgetExceeded(250_000, 200_000);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BudgetExceeded");
    expect([e.used, e.limit]).toEqual([250_000, 200_000]);
  });
});
