// src/limit-wait.ts：限额循环里醒来重试前重读 models.json（#43）。
// sleepUntil 按墙上时间分步睡，fake timers 推不动，用例注入假的 sleepUntil，在里面改配置。
// models.ts 的配置是模块级状态，每个用例 resetModules 后重新 import 一份；路径相对当前目录，用例在临时目录里 chdir。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../src/models.ts";

type Models = typeof import("../src/models.ts");
type LimitWait = typeof import("../src/limit-wait.ts");

const PHASES = ["prep", "implement", "review", "revise", "fix", "rebase", "re-review"] as const;
const startCwd = process.cwd();
let m: Models;
let lw: LimitWait;

const phasesAll = (list: string[]) => Object.fromEntries(PHASES.map((p) => [p, list]));
function project(models: unknown) {
  const root = mkdtempSync(join(tmpdir(), "sc-limit-wait-"));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeModels(models, root);
  process.chdir(root);
}
function writeModels(models: unknown, root = process.cwd()) {
  writeFileSync(join(root, ".sandcastle/models.json"), JSON.stringify(models));
}
const done = (stdout = "ok"): AgentRun => ({ iterations: [], stdout, completionSignal: "<promise>COMPLETE</promise>" });
const LIMIT = "You've hit your 5-hour limit · resets 6:20am (UTC)";

beforeEach(async () => {
  vi.resetModules();
  m = await import("../src/models.ts");
  lw = await import("../src/limit-wait.ts");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 26, 0, 0));
});
afterEach(() => {
  process.chdir(startCwd);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("untilAfterLimit 醒来重试前重读配置", () => {
  it("全部档案撞限额、等待期间配置加了新档案：重试时用新档案", async () => {
    project({ profiles: { fake: { model: "fake-model" } }, phases: phasesAll(["fake"]) });
    m.reloadModels();
    const tried: string[] = [];
    const events: string[] = [];
    const reload = vi.fn(() => (events.push("reload"), m.reloadModels()));
    const result = await lw.untilAfterLimit(
      "#104",
      () =>
        m.runWithProfile("implement", "#104", async (p) => {
          tried.push(p.name);
          events.push(`run ${p.name}`);
          if (p.name === "fake") throw new Error(LIMIT);
          return done("sonnet 干完了");
        }),
      undefined,
      {
        sleepUntil: async (at) => {
          events.push("sleep");
          writeModels({ profiles: { fake: { model: "fake-model" }, sonnet: { model: "claude-sonnet-4-5" } }, phases: phasesAll(["fake", "sonnet"]) });
          vi.setSystemTime(at);
        },
        reload,
      },
    );
    expect(result.profile.name).toBe("sonnet");
    expect(result.run.stdout).toBe("sonnet 干完了");
    // 醒来时 fake 的跳过期已过，先再试一次 fake（又撞限额），再换上等待期间加的 sonnet
    expect(events).toEqual(["run fake", "sleep", "reload", "run fake", "run sonnet"]);
    expect(tried).toEqual(["fake", "fake", "sonnet"]);
  });

  it("不是限额的错误照抛，不等也不重读", async () => {
    const sleepUntil = vi.fn(async () => {});
    const reload = vi.fn();
    await expect(lw.untilAfterLimit("#1", async () => { throw new Error("boom"); }, undefined, { sleepUntil, reload })).rejects.toThrow("boom");
    expect(sleepUntil).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("全部档案撞限额：同一次等待只评论一次，带阶段和档案名；成功后不再评论", async () => {
    project({ profiles: { opus: { model: "claude-opus-4-5" }, glm: { model: "glm-5" } }, phases: phasesAll(["opus", "glm"]) });
    m.reloadModels();
    let calls = 0;
    const comment = vi.fn();
    const result = await lw.untilAfterLimit(
      "#48",
      () =>
        m.runWithProfile("implement", "#48", async () => {
          calls++;
          // 前两轮（每轮两个档案）都撞限额，第三轮成功
          if (calls <= 4) throw new Error(LIMIT);
          return done("干完了");
        }),
      undefined,
      { sleepUntil: async (at) => void vi.setSystemTime(at), reload: () => {}, comment },
    );
    expect(result.run.stdout).toBe("干完了");
    expect(comment).toHaveBeenCalledTimes(1);
    const [limited] = comment.mock.calls[0]!;
    expect(limited).toBeInstanceOf(m.AllProfilesLimited);
    expect(limited.phase).toBe("implement");
    expect(limited.profiles).toEqual(["opus", "glm"]);
  });

  it("普通限额报错（不是 AllProfilesLimited）不评论", async () => {
    let calls = 0;
    const comment = vi.fn();
    await lw.untilAfterLimit(
      "#48",
      async () => {
        if (calls++ < 2) throw new Error(LIMIT);
        return "ok";
      },
      undefined,
      { sleepUntil: async () => {}, reload: () => {}, comment },
    );
    expect(calls).toBe(3);
    expect(comment).not.toHaveBeenCalled();
  });
});
