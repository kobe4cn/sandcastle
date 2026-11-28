import { describe, expect, it } from "vitest";
import { BudgetExceeded, daySpend, nextLocalMidnight, recordTokens, ticketSpend } from "../src/budget.ts";
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

describe("daySpend（#152 当天口径，按本地日期）", () => {
  it("只把本地日期等于 now 的记录相加：别的票、别的阶段都算，本地前一天 23:59 / 次日 00:01 的不算", () => {
    // now 和 at 都用本地时间构造再转 ISO，不依赖运行机器的时区（vitest 没固定 TZ）。
    // Both now and at are built from local wall-clock times, so the test doesn't depend on the machine's timezone (vitest doesn't pin TZ).
    const now = new Date(2026, 10, 28, 23, 59);
    const records = [
      rec({ at: new Date(2026, 10, 28, 0, 1).toISOString(), issue: "41", input: 100 }),
      rec({ at: new Date(2026, 10, 28, 23, 58).toISOString(), issue: "42", phase: "review", input: 20 }),
      rec({ at: new Date(2026, 10, 27, 23, 59).toISOString(), input: 999 }),
      rec({ at: new Date(2026, 10, 29, 0, 1).toISOString(), input: 888 }),
    ];
    expect(daySpend(records, now)).toBe(120);
  });

  it("当天没有记录时是 0", () => {
    expect(daySpend([rec({ at: new Date(2026, 10, 27, 23, 59).toISOString(), input: 100 })], new Date(2026, 10, 28))).toBe(0);
  });
});

describe("nextLocalMidnight", () => {
  it("当天任意时刻都指向次日本地 0 点（不用 +24h，夏令时切换日不是 24 小时）", () => {
    expect(nextLocalMidnight(new Date(2026, 10, 28, 23, 59))).toBe(new Date(2026, 10, 29).getTime());
    expect(nextLocalMidnight(new Date(2026, 10, 28, 0, 0))).toBe(new Date(2026, 10, 29).getTime());
    // 夏令时切换的日期也按本地日历 +1 天 / A DST transition day still advances one local calendar day
    expect(nextLocalMidnight(new Date(2026, 2, 8, 1, 0))).toBe(new Date(2026, 2, 9).getTime());
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
