// gate-queue：门槛队列按优先级放行（票优先，main 兜底让位），同档先来先得，失败也释放。
// gate-queue: the gate queue releases by priority (tickets first, the main fallback yields), first come first served within a tier, released on failure too.
import { describe, expect, it } from "vitest";
import { createGateQueue } from "../src/gate-queue.ts";

/** 手动 resolve / reject 的 Promise，用来占住队列。 / A manually resolved / rejected Promise to hold the queue. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createGateQueue", () => {
  it("兜底在等时后到的票先跑 / a ticket arriving while the fallback waits runs first", async () => {
    const yields: number[] = [];
    const q = createGateQueue({ onYield: (n) => yields.push(n) });
    const events: string[] = [];
    const a = deferred();
    const b = deferred();
    const f = deferred();
    const ra = q.run(async () => (events.push("A"), a.promise), "ticket");
    const rf = q.run(async () => (events.push("F"), f.promise), "fallback");
    const rb = q.run(async () => (events.push("B"), b.promise), "ticket");
    await flush();
    expect(events).toEqual(["A"]);
    a.resolve();
    await flush();
    expect(events).toEqual(["A", "B"]);
    b.resolve();
    await flush();
    expect(events).toEqual(["A", "B", "F"]);
    f.resolve();
    await Promise.all([ra, rb, rf]);
    expect(yields).toEqual([1]);
  });

  it("A 抛错后 B 照常开跑，reject 传给调用方 / B starts after A throws, and the rejection reaches the caller", async () => {
    const q = createGateQueue();
    const events: string[] = [];
    const a = deferred();
    const ra = q.run(async () => (events.push("A"), a.promise), "ticket");
    const rb = q.run(async () => (events.push("B"), "ok"), "ticket");
    a.reject(new Error("boom"));
    await expect(ra).rejects.toThrow("boom");
    await expect(rb).resolves.toBe("ok");
    expect(events).toEqual(["A", "B"]);
  });

  it("没有票时兜底照常跑 / without tickets the fallback runs as usual", async () => {
    const yields: number[] = [];
    const q = createGateQueue({ onYield: (n) => yields.push(n) });
    const events: string[] = [];
    await q.run(async () => void events.push("F1"), "fallback");
    await q.run(async () => void events.push("F2"), "fallback");
    expect(events).toEqual(["F1", "F2"]);
    expect(yields).toEqual([]);
  });

  it("同档先来先得 / first come first served within a tier", async () => {
    const q = createGateQueue();
    const events: string[] = [];
    const a = deferred();
    const ra = q.run(async () => (events.push("A"), a.promise), "ticket");
    const rb = q.run(async () => void events.push("B"), "ticket");
    const rc = q.run(async () => void events.push("C"), "ticket");
    a.resolve();
    await Promise.all([ra, rb, rc]);
    expect(events).toEqual(["A", "B", "C"]);
  });
});
