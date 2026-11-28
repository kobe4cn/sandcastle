// 主动通知：webhook URL 的读取与消息发送（不连网，fetch 换成假的）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNotifier, readNotifyUrl } from "../src/notify.ts";
import { setTermLanguage } from "../src/term.ts";

/** 临时目录，带空的 .sandcastle/。 / Temp directory with an empty .sandcastle/. */
const withSandcastle = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"));
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  return dir;
};

describe("readNotifyUrl", () => {
  it("读 .sandcastle/.env 里的值；值为空时取宿主机同名环境变量；文件不存在返回 undefined", () => {
    const file = withSandcastle();
    writeFileSync(join(file, ".sandcastle", ".env"), "OTHER=1\nSANDPIPE_NOTIFY_WEBHOOK=https://hooks.example/from-file\n");
    expect(readNotifyUrl("SANDPIPE_NOTIFY_WEBHOOK", file)).toBe("https://hooks.example/from-file");
    expect(readNotifyUrl("OTHER_VAR", file)).toBeUndefined();

    const blank = withSandcastle();
    writeFileSync(join(blank, ".sandcastle", ".env"), "SANDPIPE_NOTIFY_WEBHOOK=\n");
    process.env.SANDPIPE_NOTIFY_WEBHOOK = "https://hooks.example/from-host";
    try {
      expect(readNotifyUrl("SANDPIPE_NOTIFY_WEBHOOK", blank)).toBe("https://hooks.example/from-host");
    } finally {
      delete process.env.SANDPIPE_NOTIFY_WEBHOOK;
    }

    expect(readNotifyUrl("SANDPIPE_NOTIFY_WEBHOOK", withSandcastle())).toBeUndefined();
  });
});

describe("createNotifier", () => {
  const capture = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetcher: (async (url: string | RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}");
      }) as typeof fetch,
    };
  };

  it("POST JSON：body 带 text / event / issue / url / reason，中文文案含事件、票号、链接、原因", async () => {
    const { calls, fetcher } = capture();
    const warns: string[] = [];
    const notify = createNotifier({ url: "https://hooks.example/z", language: "zh", fetcher, warn: (l) => warns.push(l) });
    await notify({ event: "stuck", issue: "132", url: "https://github.com/o/r/issues/132", reason: "实现没做完" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.example/z");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.event).toBe("stuck");
    expect(body.issue).toBe("132");
    expect(body.url).toBe("https://github.com/o/r/issues/132");
    expect(body.reason).toBe("实现没做完");
    expect(body.text).toContain("#132");
    expect(body.text).toContain("https://github.com/o/r/issues/132");
    expect(body.text).toContain("票卡住了");
    expect(body.text).toContain("实现没做完");
    expect(warns).toEqual([]);
  });

  it("没有链接时 body 不带 url 字段；英文文案单独一版", async () => {
    const { calls, fetcher } = capture();
    const notify = createNotifier({ url: "https://hooks.example/z", language: "en", fetcher });
    await notify({ event: "leftForHuman", issue: "7", reason: "not merged" });
    const body = JSON.parse(String(calls[0].init.body));
    expect("url" in body).toBe(false);
    expect(body.text).toContain("#7");
    expect(body.text).toContain("left for a human");
    expect(body.text).toContain("not merged");
  });

  it("fetch 抛错或非 2xx 时只 warn 一行、不 reject，警告里没有 webhook URL", async () => {
    const warns: string[] = [];
    const throwing = createNotifier({
      url: "https://hooks.example/secret",
      language: "zh",
      fetcher: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await expect(throwing({ event: "stuck", issue: "1", reason: "r" })).resolves.toBeUndefined();
    const failing = createNotifier({
      url: "https://hooks.example/secret",
      language: "zh",
      fetcher: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await expect(failing({ event: "stuck", issue: "1", reason: "r" })).resolves.toBeUndefined();
    expect(warns).toHaveLength(2);
    for (const line of warns) {
      expect(line).not.toContain("hooks.example");
      expect(line).not.toContain("secret");
    }
  });

  it("fetch 抛错时警告写明错误类型：超时（AbortSignal.timeout 的 reason，name 为 TimeoutError）", async () => {
    const warns: string[] = [];
    const notify = createNotifier({
      url: "https://hooks.example/z",
      language: "zh",
      fetcher: (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await notify({ event: "stuck", issue: "1", reason: "r" });
    expect(warns).toEqual(["  ⚠ 通知发送失败（TimeoutError），不影响运行"]);
  });

  it("fetch 抛错时警告写明错误类型：cause 的 code（ECONNRESET）；cause 是 AggregateError 时取 errors[0].code", async () => {
    const warns: string[] = [];
    const reset = createNotifier({
      url: "https://hooks.example/z",
      language: "zh",
      fetcher: (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await reset({ event: "stuck", issue: "1", reason: "r" });
    const aggregate = createNotifier({
      url: "https://hooks.example/z",
      language: "zh",
      fetcher: (async () => {
        throw new TypeError("fetch failed", {
          cause: new AggregateError([Object.assign(new Error("dns"), { code: "ENOTFOUND" })], "all failed"),
        });
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await aggregate({ event: "stuck", issue: "1", reason: "r" });
    expect(warns).toEqual(["  ⚠ 通知发送失败（ECONNRESET），不影响运行", "  ⚠ 通知发送失败（ENOTFOUND），不影响运行"]);
  });

  it("取不到类型时退回错误文本，message 里带 webhook URL 时先抹掉", async () => {
    const warns: string[] = [];
    const notify = createNotifier({
      url: "https://hooks.example/secret",
      language: "zh",
      fetcher: (async () => {
        throw new Error("Failed to parse URL from https://hooks.example/secret");
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await notify({ event: "stuck", issue: "1", reason: "r" });
    expect(warns).toEqual(["  ⚠ 通知发送失败（Failed to parse URL from …），不影响运行"]);
  });

  it("英文文案写明错误类型（保留 Notify webhook failed 子串）", async () => {
    setTermLanguage("en", {});
    try {
      const warns: string[] = [];
      const notify = createNotifier({
        url: "https://hooks.example/z",
        language: "en",
        fetcher: (async () => {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
        }) as typeof fetch,
        warn: (l) => warns.push(l),
        sleep: async () => {},
      });
      await notify({ event: "stuck", issue: "1", reason: "r" });
      expect(warns).toEqual(["  ⚠ Notify webhook failed (ECONNRESET); the run continues"]);
    } finally {
      setTermLanguage("zh", {});
    }
  });

  /** 按调用次数返回不同结果（抛错或 Response）的 fetcher；越界时重复最后一步。 / A fetcher returning a different result per call (throwing or a Response); past the end it repeats the last step. */
  const sequence = (steps: (() => Response)[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    return {
      calls,
      fetcher: (async (url: string | RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return steps[Math.min(i++, steps.length - 1)]();
      }) as typeof fetch,
    };
  };

  /** 记录 ms 的假 sleep。 / A fake sleep recording the waited ms. */
  const sleepLog = () => {
    const sleeps: number[] = [];
    return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
  };

  it("抛错后等 5 秒重试一次：重试成功就不警告", async () => {
    const { calls, fetcher } = sequence([
      () => {
        throw new Error("network down");
      },
      () => new Response("{}"),
    ]);
    const { sleeps, sleep } = sleepLog();
    const warns: string[] = [];
    const notify = createNotifier({ url: "https://hooks.example/z", language: "zh", fetcher, warn: (l) => warns.push(l), sleep });
    await notify({ event: "stuck", issue: "1", reason: "r" });
    expect(calls).toHaveLength(2);
    expect(warns).toEqual([]);
    expect(sleeps).toEqual([5000]);
  });

  it("重试也抛错：只 warn 一行，带错误类型、不含 webhook URL", async () => {
    const warns: string[] = [];
    const notify = createNotifier({
      url: "https://hooks.example/secret",
      language: "zh",
      fetcher: (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
      }) as typeof fetch,
      warn: (l) => warns.push(l),
      sleep: async () => {},
    });
    await notify({ event: "stuck", issue: "1", reason: "r" });
    expect(warns).toEqual(["  ⚠ 通知发送失败（ECONNRESET），不影响运行"]);
    expect(warns[0]).not.toContain("hooks.example");
  });

  it("4xx（除 429）不重试：404 只发一次、不睡，警告带状态码", async () => {
    const { calls, fetcher } = sequence([() => new Response("nope", { status: 404 })]);
    const { sleeps, sleep } = sleepLog();
    const warns: string[] = [];
    const notify = createNotifier({ url: "https://hooks.example/z", language: "zh", fetcher, warn: (l) => warns.push(l), sleep });
    await notify({ event: "stuck", issue: "1", reason: "r" });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(warns).toEqual(["  ⚠ 通知发送失败（HTTP 404），不影响运行"]);
  });

  it("5xx 和 429 重试一次：重试后仍失败按最后一次的结果警告", async () => {
    for (const status of [500, 429]) {
      const { calls, fetcher } = sequence([
        () => new Response("nope", { status }),
        () => new Response("still no", { status: 503 }),
      ]);
      const { sleeps, sleep } = sleepLog();
      const warns: string[] = [];
      const notify = createNotifier({ url: "https://hooks.example/z", language: "zh", fetcher, warn: (l) => warns.push(l), sleep });
      await notify({ event: "stuck", issue: "1", reason: "r" });
      expect(calls).toHaveLength(2);
      expect(sleeps).toEqual([5000]);
      expect(warns).toEqual(["  ⚠ 通知发送失败（HTTP 503），不影响运行"]);
    }
  });

  it("retry: false：抛错只发一次、不睡，仍只 warn 一行", async () => {
    const { calls, fetcher } = sequence([
      () => {
        throw new Error("network down");
      },
      () => new Response("{}"),
    ]);
    const { sleeps, sleep } = sleepLog();
    const warns: string[] = [];
    const notify = createNotifier({ url: "https://hooks.example/z", language: "zh", fetcher, warn: (l) => warns.push(l), sleep, retry: false });
    await notify({ event: "crashed", reason: "r" });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(warns).toEqual(["  ⚠ 通知发送失败（network down），不影响运行"]);
  });

  it("没配 URL 时是空操作，不发起请求", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    const notify = createNotifier({ language: "zh", fetcher });
    await notify({ event: "leftForHuman", issue: "9", reason: "r" });
    expect(called).toBe(0);
  });
});
