// src/models.ts 的纯逻辑：按阶段挑档案、撞限额换档案、重置时间解析、别家档案的环境变量、热重载、用量记录（e2e 计划 N1a–N1f）。
// 不起容器、不调真实 claude：runWithProfile 传假的 fn，agentFor 只看拼出的命令行。
// models.ts 的配置和「跳过到何时」是模块级状态，每个用例重新 import 一份；路径是相对当前目录的，用例在临时目录里 chdir。
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../src/i18n.ts";
import type { AgentRun, Profile } from "../src/models.ts";

type Models = typeof import("../src/models.ts");

const PHASES = ["prep", "implement", "review", "revise", "fix", "rebase", "re-review"] as const;
const startCwd = process.cwd();
let m: Models;
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** 每个阶段都用 list，再按 overrides 改个别阶段。 */
const phasesAll = (list: string[], overrides: Record<string, unknown> = {}) => ({ ...Object.fromEntries(PHASES.map((p) => [p, list])), ...overrides });

/** 在临时目录里写 .sandcastle/models.json（字符串原样写，对象转 JSON）和可选的 .sandcastle/.env，并 chdir 过去。 */
function project(models: unknown, env?: string) {
  const root = mkdtempSync(join(tmpdir(), "sc-models-"));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeModels(models, root);
  if (env !== undefined) writeFileSync(join(root, ".sandcastle/.env"), env);
  process.chdir(root);
  return root;
}
function writeModels(models: unknown, root = process.cwd()) {
  writeFileSync(join(root, ".sandcastle/models.json"), typeof models === "string" ? models : JSON.stringify(models));
}

const claude = (model = "claude-opus-4-5", extra: Record<string, unknown> = {}) => ({ model, ...extra });
const done = (stdout = "ok"): AgentRun => ({ iterations: [], stdout, completionSignal: "<promise>COMPLETE</promise>" });
const LIMIT = "You've hit your 5-hour limit · resets 6:20am (UTC)";

beforeEach(async () => {
  vi.resetModules();
  m = await import("../src/models.ts");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(startCwd);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("N1a 按阶段挑档案", () => {
  it("每个阶段取列表里第一个档案", async () => {
    project({
      profiles: { opus: claude("claude-opus-4-5", { effort: "high" }), sonnet: claude("claude-sonnet-4-5") },
      phases: phasesAll(["opus", "sonnet"], { review: ["sonnet", "opus"] }),
    });
    m.reloadModels();
    const used: string[] = [];
    for (const phase of PHASES) {
      const { profile } = await m.runWithProfile(phase, "#1", async (p) => (used.push(p.name), done()));
      expect(profile.name).toBe(phase === "review" ? "sonnet" : "opus");
    }
    expect(used).toEqual(["opus", "opus", "sonnet", "opus", "opus", "opus", "opus"]);
    const { phases, used: profiles } = m.inspectModels();
    expect(phases.review).toEqual(["sonnet", "opus"]);
    expect(profiles.map((p) => p.name).sort()).toEqual(["opus", "sonnet"]);
    expect(profiles.find((p) => p.name === "opus")).toMatchObject({ model: "claude-opus-4-5", effort: "high", thirdParty: false, limitPattern: m.CLAUDE_LIMIT_PATTERN });
  });

  it("没调 reloadModels 就 runWithProfile：报错", async () => {
    await expect(m.runWithProfile("implement", "#1", async () => done())).rejects.toThrow("reloadModels");
  });

  const bad: [string, unknown, string][] = [
    ["未知阶段", { profiles: { a: claude() }, phases: phasesAll(["a"], { deploy: ["a"] }) }, "phases 里的 deploy 不是阶段"],
    ["未知档案", { profiles: { a: claude() }, phases: phasesAll(["a"], { implement: ["a", "ghost"] }) }, "phases.implement 里的档案 ghost 不在 profiles 里"],
    ["空列表", { profiles: { a: claude() }, phases: phasesAll(["a"], { review: [] }) }, "phases.review 要是非空的档案名列表"],
    ["列表里不是字符串", { profiles: { a: claude() }, phases: phasesAll(["a"], { fix: [1] }) }, "phases.fix 要是非空的档案名列表"],
    ["缺阶段", { profiles: { a: claude() }, phases: Object.fromEntries(PHASES.filter((p) => p !== "rebase").map((p) => [p, ["a"]])) }, "phases.rebase 要是非空的档案名列表"],
    ["re-review 空列表", { profiles: { a: claude() }, phases: phasesAll(["a"], { "re-review": [] }) }, "phases.re-review 要是非空的档案名列表"],
    ["re-review 未知档案", { profiles: { a: claude() }, phases: phasesAll(["a"], { "re-review": ["ghost"] }) }, "phases.re-review 里的档案 ghost 不在 profiles 里"],
    ["缺 phases", { profiles: { a: claude() } }, "要有 profiles 和 phases 两个对象"],
    ["缺 profiles", { phases: phasesAll(["a"]) }, "要有 profiles 和 phases 两个对象"],
    ["档案缺 model", { profiles: { a: { effort: "high" } }, phases: phasesAll(["a"]) }, "profiles.a.model 要是非空字符串"],
    ["档案不是对象", { profiles: { a: "opus" }, phases: phasesAll(["a"]) }, "profiles.a 要是对象"],
    ["effort 不认识", { profiles: { a: claude("x", { effort: "turbo" }) }, phases: phasesAll(["a"]) }, "profiles.a.effort 只能是"],
    ["harness 是 codex", { profiles: { a: claude("x", { harness: "codex" }) }, phases: phasesAll(["a"]) }, "profiles.a.harness 是 codex"],
    ["limitPattern 不是合法正则", { profiles: { a: claude("x", { limitPattern: "(" }) }, phases: phasesAll(["a"]) }, "profiles.a.limitPattern 不是合法的正则"],
    ["resetTimeZone 不合法", { profiles: { a: claude("x", { resetTimeZone: "Mars/Base" }) }, phases: phasesAll(["a"]) }, "profiles.a.resetTimeZone 不是合法的时区"],
    ["不是 JSON", "{ profiles: ", "不是合法的 JSON"],
  ];
  it.each(bad)("%s：报错并指明位置", (_name, models, message) => {
    project(models);
    expect(() => m.inspectModels()).toThrow(`.sandcastle/models.json：`);
    expect(() => m.inspectModels()).toThrow(message);
    expect(() => m.reloadModels()).toThrow(message);
  });

  it("没写 re-review：不报错，沿用 review 的档案列表", async () => {
    project({
      profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") },
      phases: Object.fromEntries(PHASES.filter((p) => p !== "re-review").map((p) => [p, p === "review" ? ["sonnet", "opus"] : ["opus"]])),
    });
    m.reloadModels();
    expect(m.inspectModels().phases["re-review"]).toEqual(["sonnet", "opus"]);
    const { profile } = await m.runWithProfile("re-review", "#1", async () => done());
    expect(profile.name).toBe("sonnet");
  });

  it("写了 re-review：按它选档案", async () => {
    project({ profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["opus"], { "re-review": ["sonnet"] }) });
    m.reloadModels();
    const { profile } = await m.runWithProfile("re-review", "#1", async () => done());
    expect(profile.name).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
describe("N1b 撞限额换档案", () => {
  const NOW = Date.UTC(2026, 10, 26, 0, 0); // 2026-11-26 00:00Z
  const SLACK = 2 * 60_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    project({
      profiles: {
        opus: claude(),
        glm: { model: "glm-4.6", env: { ANTHROPIC_BASE_URL: "https://glm.example", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" }, limitPattern: "quota exceeded", resetTimeZone: "UTC" },
        sonnet: claude("claude-sonnet-4-5"),
      },
      phases: phasesAll(["opus", "glm"], { review: ["sonnet", "opus"] }),
    });
    m.reloadModels();
  });

  it("第一个档案抛出的报错命中 limitPattern：换下一个，并记下重置时间", async () => {
    const tried: string[] = [];
    const { profile, run } = await m.runWithProfile("implement", "#7", async (p) => {
      tried.push(p.name);
      if (p.name === "opus") throw new Error(LIMIT);
      return done("glm 干完了");
    });
    expect(tried).toEqual(["opus", "glm"]);
    expect(profile.name).toBe("glm");
    expect(run.stdout).toBe("glm 干完了");
    expect(log.mock.calls.flat().join("\n")).toContain("档案 opus 撞上用量限额");
    // opus 在别的阶段（所有票共用）也被跳过，直到 06:22Z
    const again: string[] = [];
    await m.runWithProfile("review", "#8", async (p) => (again.push(p.name), done()));
    expect(again).toEqual(["sonnet"]);
    vi.setSystemTime(Date.UTC(2026, 10, 26, 6, 21));
    const later: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (later.push(p.name), done()));
    expect(later).toEqual(["glm"]);
    vi.setSystemTime(Date.UTC(2026, 10, 26, 6, 22));
    const after: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (after.push(p.name), done()));
    expect(after).toEqual(["opus"]);
  });

  it("撞限额时调 onLimited：抛错的不带 run，作为输出返回的带 run；没撞不调", async () => {
    const limited: [string, AgentRun | undefined][] = [];
    const onLimited = (p: Profile, r?: AgentRun) => limited.push([p.name, r]);
    await m.runWithProfile("review", "#7", async (p) => {
      if (p.name === "sonnet") throw new Error(LIMIT);
      return done();
    }, onLimited);
    expect(limited).toEqual([["sonnet", undefined]]);

    limited.length = 0;
    const quota: AgentRun = { iterations: [{}], stdout: LIMIT };
    await m.runWithProfile("implement", "#8", async (p) => (p.name === "opus" ? quota : done()), onLimited);
    expect(limited).toEqual([["opus", quota]]);

    limited.length = 0;
    await m.runWithProfile("implement", "#9", async () => done(), onLimited);
    expect(limited).toEqual([]);
  });

  it("限额文本作为最后的输出、不带完成信号返回：也换档案；带完成信号的不算", async () => {
    const tried: string[] = [];
    const { profile } = await m.runWithProfile("implement", "#7", async (p) => {
      tried.push(p.name);
      return p.name === "opus" ? { iterations: [], stdout: `...\n${LIMIT}\n` } : done();
    });
    expect(tried).toEqual(["opus", "glm"]);
    expect(profile.name).toBe("glm");

    // 完成了但输出里恰好提到限额文本：照常返回
    const r = await m.runWithProfile("review", "#9", async () => done(`讨论 "${LIMIT}" 这句报错`));
    expect(r.profile.name).toBe("sonnet");
  });

  it("不是限额的报错照抛，不换档案", async () => {
    const tried: string[] = [];
    await expect(
      m.runWithProfile("implement", "#7", async (p) => {
        tried.push(p.name);
        throw new Error("container exited 137");
      }),
    ).rejects.toThrow("container exited 137");
    expect(tried).toEqual(["opus"]);
  });

  it("全部撞限额：抛 AllProfilesLimited，until 是最早的恢复时间（含 2 分钟余量）", async () => {
    const tried: string[] = [];
    const err = await m
      .runWithProfile("implement", "#7", async (p) => {
        tried.push(p.name);
        throw new Error(p.name === "opus" ? LIMIT : "429 quota exceeded, resets at 2026-11-26 03:00:00");
      })
      .catch((e: unknown) => e);
    expect(tried).toEqual(["opus", "glm"]);
    expect(err).toBeInstanceOf(m.AllProfilesLimited);
    const limited = err as InstanceType<Models["AllProfilesLimited"]>;
    expect(limited.phase).toBe("implement");
    expect(limited.profiles).toEqual(["opus", "glm"]);
    expect(limited.until).toBe(Date.UTC(2026, 10, 26, 3, 0) + SLACK);
    expect(limited.message).toContain("阶段 implement 的档案都撞上了用量限额");

    // 再跑：不调用 fn，直接抛
    const fn = vi.fn(async () => done());
    await expect(m.runWithProfile("implement", "#7", fn)).rejects.toBeInstanceOf(m.AllProfilesLimited);
    expect(fn).not.toHaveBeenCalled();
  });

  it("恢复时间写进 .sandcastle/logs/limits.json：重启后照样跳过，过了 until 又会试它、条目被清掉（#46）", async () => {
    await m.runWithProfile("implement", "#7", async (p) => {
      if (p.name === "opus") throw new Error(LIMIT);
      return done();
    });
    const until = Date.UTC(2026, 10, 26, 6, 20) + SLACK;
    expect(JSON.parse(readFileSync(".sandcastle/logs/limits.json", "utf8"))).toEqual({ opus: until });

    // 模拟重启：重新加载模块
    vi.resetModules();
    m = await import("../src/models.ts");
    m.reloadModels();
    const tried: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (tried.push(p.name), done()));
    expect(tried).toEqual(["glm"]);

    // 都在等：until 来自文件
    const err = await m
      .runWithProfile("implement", "#7", async () => {
        throw new Error("429 quota exceeded, resets at 2026-11-26 08:00:00");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(m.AllProfilesLimited);
    expect((err as InstanceType<Models["AllProfilesLimited"]>).until).toBe(until);

    // 过了 opus 的 until：重启后又会试 opus，写文件时丢掉过期条目
    vi.setSystemTime(until);
    vi.resetModules();
    m = await import("../src/models.ts");
    m.reloadModels();
    const later: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (later.push(p.name), done()));
    expect(later).toEqual(["opus"]);
  });

  it("limits.json 里过期的条目：读入时丢掉，内存里过期的写入时也丢掉（#46）", async () => {
    mkdirSync(".sandcastle/logs", { recursive: true });
    writeFileSync(".sandcastle/logs/limits.json", JSON.stringify({ old: NOW - 1, glm: NOW + 60_000 }));
    await m
      .runWithProfile("implement", "#7", async () => {
        throw new Error(LIMIT);
      })
      .catch(() => {});
    const opusUntil = Date.UTC(2026, 10, 26, 6, 20) + SLACK;
    // 读入时丢掉 old
    expect(JSON.parse(readFileSync(".sandcastle/logs/limits.json", "utf8"))).toEqual({ glm: NOW + 60_000, opus: opusUntil });

    // 不重启，glm 在内存里过期；review 的 sonnet 撞限额时整表重写，glm 不再出现
    vi.setSystemTime(NOW + 60_000);
    await m
      .runWithProfile("review", "#8", async () => {
        throw new Error(LIMIT);
      })
      .catch(() => {});
    expect(JSON.parse(readFileSync(".sandcastle/logs/limits.json", "utf8"))).toEqual({ opus: opusUntil, sonnet: opusUntil });
  });

  it("limits.json 是坏 JSON 或不是对象：当作空，不抛", async () => {
    mkdirSync(".sandcastle/logs", { recursive: true });
    writeFileSync(".sandcastle/logs/limits.json", "{not json");
    const tried: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (tried.push(p.name), done()));
    expect(tried).toEqual(["opus"]);

    vi.resetModules();
    m = await import("../src/models.ts");
    m.reloadModels();
    writeFileSync(".sandcastle/logs/limits.json", JSON.stringify({ opus: "soon", glm: [1] }));
    const again: string[] = [];
    await m.runWithProfile("implement", "#7", async (p) => (again.push(p.name), done()));
    expect(again).toEqual(["opus"]);
  });

  it("只配一个档案、撞限额后等待期间配置补上新档案：reloadModels 后重跑用新档案（#43）", async () => {
    writeModels({ profiles: { fake: claude("fake-model") }, phases: phasesAll(["fake"]) });
    m.reloadModels();
    const err = await m
      .runWithProfile("implement", "#104", async () => {
        throw new Error(LIMIT);
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(m.AllProfilesLimited);
    writeModels({ profiles: { fake: claude("fake-model"), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["fake", "sonnet"]) });
    m.reloadModels();
    const tried: string[] = [];
    const { profile } = await m.runWithProfile("implement", "#104", async (p) => (tried.push(p.name), done()));
    // fake 还在跳过期内，直接用 sonnet
    expect(tried).toEqual(["sonnet"]);
    expect(profile.name).toBe("sonnet");
  });

  it("认不出重置时间：跳过 1 小时", async () => {
    const err = await m
      .runWithProfile("implement", "#7", async () => {
        throw new Error("You've hit your limit, try later");
      })
      .catch((e: unknown) => e);
    // opus 认不出 → now+1h；glm 抛的也是这句，但 glm 的 limitPattern 是 quota exceeded，不认 → 照抛原错误
    expect(err).not.toBeInstanceOf(m.AllProfilesLimited);
    expect(String(err)).toContain("try later");
    const tried: string[] = [];
    const err2 = await m
      .runWithProfile("implement", "#7", async (p) => {
        tried.push(p.name);
        throw new Error("quota exceeded");
      })
      .catch((e: unknown) => e);
    expect(tried).toEqual(["glm"]);
    expect((err2 as InstanceType<Models["AllProfilesLimited"]>).until).toBe(NOW + 60 * 60_000);
    expect(log.mock.calls.flat().join("\n")).toContain("认不出重置时间");
  });
});

// ---------------------------------------------------------------------------
describe("N1c 重置时间解析 limitResetAt", () => {
  const at = (iso: string) => Date.parse(iso);

  it("Claude 的写法：resets 6:20am (UTC)，取下一次到这个钟点的时刻", () => {
    expect(m.limitResetAt(LIMIT, undefined, at("2026-11-26T05:00:00Z"))).toBe(at("2026-11-26T06:20:00Z"));
    expect(m.limitResetAt(LIMIT, undefined, at("2026-11-26T07:00:00Z"))).toBe(at("2026-11-27T06:20:00Z"));
  });

  it("Claude 的写法带别的时区、不带分钟、12am / 12pm", () => {
    const now = at("2026-11-26T00:00:00Z");
    expect(m.limitResetAt("You've hit your limit · resets 7pm (Asia/Shanghai)", undefined, now)).toBe(at("2026-11-26T11:00:00Z"));
    expect(m.limitResetAt("hit your weekly limit · resets 12am (UTC)", undefined, at("2026-11-26T08:00:00Z"))).toBe(at("2026-11-27T00:00:00Z"));
    expect(m.limitResetAt("hit your limit · resets 12pm (UTC)", undefined, now)).toBe(at("2026-11-26T12:00:00Z"));
    // 冬令时的纽约 UTC-5
    expect(m.limitResetAt("hit your limit · resets 9:30am (America/New_York)", undefined, now)).toBe(at("2026-11-26T14:30:00Z"));
    // 消息里的时区优先于 resetTimeZone
    expect(m.limitResetAt(LIMIT, "Asia/Shanghai", at("2026-11-26T05:00:00Z"))).toBe(at("2026-11-26T06:20:00Z"));
  });

  it("Claude 的写法带不认识的时区：null", () => {
    expect(m.limitResetAt("hit your limit · resets 6am (Mars/Base)", undefined, at("2026-11-26T00:00:00Z"))).toBeNull();
  });

  it("别家不带时区的时间戳按 resetTimeZone 解析", () => {
    const now = at("2026-11-26T00:00:00Z");
    expect(m.limitResetAt("quota exceeded, reset at 2026-11-26 15:30:00", "Asia/Shanghai", now)).toBe(at("2026-11-26T07:30:00Z"));
    expect(m.limitResetAt("quota exceeded, reset at 2026-11-26 15:30:00", "UTC", now)).toBe(at("2026-11-26T15:30:00Z"));
    expect(m.limitResetAt("reset 2026-11-26T15:30", "America/New_York", now)).toBe(at("2026-11-26T20:30:00Z"));
  });

  it("别家时间戳不给 resetTimeZone：按宿主机时区", () => {
    expect(m.limitResetAt("reset at 2026-12-01 08:15:00", undefined, at("2026-11-26T00:00:00Z"))).toBe(new Date(2026, 11, 1, 8, 15, 0).getTime());
  });

  it("时间已过或认不出：null", () => {
    expect(m.limitResetAt("reset at 2026-11-25 15:30:00", "UTC", at("2026-11-26T00:00:00Z"))).toBeNull();
    expect(m.limitResetAt("rate limited, try again later", "UTC", at("2026-11-26T00:00:00Z"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("N1d 别家档案的环境变量", () => {
  const VAR = "SC_MODELS_TEST_GLM_KEY";
  const glm = (env: Record<string, unknown> = {}) => ({
    model: "glm-4.6",
    limitPattern: "quota",
    env: { ANTHROPIC_BASE_URL: "https://glm.example/api", ANTHROPIC_AUTH_TOKEN: `\${${VAR}}`, ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air", ...env },
  });
  const print = (p: Profile, phase?: (typeof PHASES)[number]) =>
    m.agentFor(p, { GH_TOKEN: "x" }, phase).buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: true });
  const command = (p: Profile, phase?: (typeof PHASES)[number]) => print(p, phase).command;
  // 宿主机上的 Claude 凭据会被当成 .env 空值的来源，用例里先拿掉，结束时还原。
  let savedCreds: Record<string, string | undefined> = {};
  beforeEach(() => {
    delete process.env[VAR];
    savedCreds = Object.fromEntries(m.CLAUDE_CREDENTIALS.map((k) => [k, process.env[k]]));
    for (const k of m.CLAUDE_CREDENTIALS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of m.CLAUDE_CREDENTIALS) {
      if (savedCreds[k] === undefined) delete process.env[k];
      else process.env[k] = savedCreds[k];
    }
  });

  it("设了 ANTHROPIC_BASE_URL：命令前清掉 Claude 凭据，${VAR} 写成容器里的 \"$VAR\"", () => {
    project({ profiles: { glm: glm(), opus: claude() }, phases: phasesAll(["glm", "opus"]) }, `${VAR}=secret-value\nGH_TOKEN=x\n`);
    const { used, warnings } = m.inspectModels();
    expect(warnings).toEqual([]);
    const p = used.find((x) => x.name === "glm")!;
    expect(p.thirdParty).toBe(true);
    const cmd = command(p, "implement");
    expect(cmd.startsWith("env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY ")).toBe(true);
    expect(cmd).toContain(`ANTHROPIC_AUTH_TOKEN="$${VAR}"`);
    expect(cmd).toContain("ANTHROPIC_BASE_URL='https://glm.example/api'");
    expect(cmd).toContain("SANDCASTLE_PROFILE='glm'");
    expect(cmd).toContain("SANDCASTLE_PHASE='implement'");
    expect(cmd).not.toContain("secret-value");
    expect(cmd).toContain("glm-4.6");

    const opus = used.find((x) => x.name === "opus")!;
    expect(opus.thirdParty).toBe(false);
    // .env 没列凭据：Claude 档案也清掉容器里的空凭据，不加 read 前缀
    const c2 = command(opus);
    expect(c2).not.toContain("SANDCASTLE_PHASE");
    expect(c2.startsWith("env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY SANDCASTLE_PROFILE='opus' ")).toBe(true);
    expect(print(opus).stdin).toBe("hi");
  });

  it("容器级 env 清空凭据：CLAUDE_CREDENTIALS_CLEARED 两个键都是空串", () => {
    expect(m.CLAUDE_CREDENTIALS_CLEARED).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" });
  });

  it("命令带 --settings：关掉 Claude Code 自带的提交 / PR 署名，别家档案不留 Anthropic 模型名", () => {
    project({ profiles: { glm: glm() }, phases: phasesAll(["glm"]) }, `${VAR}=k\nGH_TOKEN=x\n`);
    const cmd = command(m.inspectModels().used[0]!);
    const json = JSON.stringify(m.NO_ATTRIBUTION_SETTINGS);
    expect(cmd).toContain(`claude --settings '${json}' `);
    // 新旧两种署名开关都写上，命令里不出现 Anthropic 的模型名
    expect(json).toContain(`"includeCoAuthoredBy":false`);
    expect(json).toContain(`"attribution":{"commit":"","pr":""}`);
    expect(cmd).not.toContain("Co-Authored");
    expect(cmd).not.toContain("Opus");
  });

  it("Claude 档案的凭据分支和 resume 会话也带同样的 --settings", () => {
    project({ profiles: { opus: claude() }, phases: phasesAll(["opus"]) }, "CLAUDE_CODE_OAUTH_TOKEN=tok\n");
    const p = m.inspectModels().used[0]!;
    const flag = `claude --settings '${JSON.stringify(m.NO_ATTRIBUTION_SETTINGS)}' `;
    expect(command(p)).toContain(flag);
    const r = m.agentFor(p, {}, "revise").buildPrintCommand({ prompt: "go", dangerouslySkipPermissions: true, resumeSession: "sess-1" });
    expect(r.command).toContain(flag);
    expect(r.command).toContain("--resume 'sess-1'");
  });

  it("Claude 档案 + .env 有 token：token 从 stdin 第一行送进 claude，命令行里没有值", () => {
    project({ profiles: { glm: glm(), opus: claude() }, phases: phasesAll(["opus", "glm"]) }, `CLAUDE_CODE_OAUTH_TOKEN=tok-secret\nANTHROPIC_API_KEY=\n${VAR}=k\n`);
    const used = m.inspectModels().used;
    const { command: cmd, stdin } = print(used.find((x) => x.name === "opus")!);
    expect(stdin).toBe("tok-secret\nhi");
    expect(cmd).not.toContain("tok-secret");
    expect(cmd.startsWith(`IFS= read -r __c0; export CLAUDE_CODE_OAUTH_TOKEN="$__c0"; exec env -u ANTHROPIC_API_KEY SANDCASTLE_PROFILE='opus' claude `)).toBe(true);

    // 第三方档案：stdin 和命令都没有 token
    const g = print(used.find((x) => x.name === "glm")!);
    expect(g.stdin).toBe("hi");
    expect(g.command).not.toContain("tok-secret");
    expect(g.command).not.toContain("read -r");
    expect(g.command.startsWith("env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY ")).toBe(true);
    // provider env 也进容器级 env：两种档案都不放凭据
    for (const p of used) for (const k of m.CLAUDE_CREDENTIALS) expect(m.agentFor(p, { GH_TOKEN: "x" }).env).not.toHaveProperty(k);
  });

  it("两个凭据都有值（空的取宿主机）：按顺序各读一行，resume 会话同样处理", () => {
    process.env.ANTHROPIC_API_KEY = "key-from-host";
    project({ profiles: { opus: claude() }, phases: phasesAll(["opus"]) }, "ANTHROPIC_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=tok\n");
    const p = m.inspectModels().used[0]!;
    const r = m.agentFor(p, {}, "revise").buildPrintCommand({ prompt: "go", dangerouslySkipPermissions: true, resumeSession: "sess-1" });
    expect(r.stdin).toBe("tok\nkey-from-host\ngo");
    expect(r.command).toContain(`IFS= read -r __c0; IFS= read -r __c1; export CLAUDE_CODE_OAUTH_TOKEN="$__c0" ANTHROPIC_API_KEY="$__c1"; exec env SANDCASTLE_PROFILE='opus' `);
    expect(r.command).not.toContain("-u ");
    expect(r.command).toContain("--resume 'sess-1'");
    expect(r.command).not.toContain("key-from-host");
  });

  it("值里的单引号被转义", () => {
    project({ profiles: { a: claude("x", { env: { NOTE: "it's" } }) }, phases: phasesAll(["a"]) });
    expect(command(m.inspectModels().used[0]!)).toContain(`NOTE='it'\\''s'`);
  });

  it("${VAR} 不在 .sandcastle/.env 里、或值为空且宿主机也没有：报错", () => {
    project({ profiles: { glm: glm() }, phases: phasesAll(["glm"]) }, "GH_TOKEN=x\n");
    expect(() => m.inspectModels()).toThrow(`profiles.glm.env.ANTHROPIC_AUTH_TOKEN 引用的 ${VAR} 不在 .sandcastle/.env 里`);
    writeFileSync(".sandcastle/.env", `${VAR}=\n`);
    expect(() => m.inspectModels()).toThrow(`引用的 ${VAR} 不在`);
    // 值为空但宿主机有：sandcastle 会从宿主机取
    process.env[VAR] = "from-host";
    try {
      expect(() => m.inspectModels()).not.toThrow();
    } finally {
      delete process.env[VAR];
    }
  });

  it("没有 .sandcastle/.env：引用变量报错；没被阶段用到的档案不查", () => {
    project({ profiles: { glm: glm(), opus: claude() }, phases: phasesAll(["glm"]) });
    expect(() => m.inspectModels()).toThrow(`引用的 ${VAR} 不在`);
    writeModels({ profiles: { glm: glm(), opus: claude() }, phases: phasesAll(["opus"]) });
    expect(() => m.inspectModels()).not.toThrow();
  });

  it("${VAR} 不是整个值：报错", () => {
    project({ profiles: { a: claude("x", { env: { URL: "https://${HOST}/v1" } }) }, phases: phasesAll(["a"]) });
    expect(() => m.inspectModels()).toThrow("profiles.a.env.URL：${VAR} 只能单独作为整个值");
  });

  it("档案不能覆盖 CLAUDE_CODE_AUTO_COMPACT_WINDOW：忽略并警告", () => {
    project({ profiles: { a: claude("x", { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000", FOO: 1 } }) }, phases: phasesAll(["a"]) });
    const { used, warnings } = m.inspectModels();
    expect(used[0]!.env).toEqual({ FOO: "1" });
    expect(warnings.join("\n")).toContain("profiles.a.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW 忽略");
    expect(command(used[0]!)).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  });

  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])("档案 env 不能设 %s", (key) => {
    project({ profiles: { a: claude("x", { env: { [key]: "x" } }) }, phases: phasesAll(["a"]) });
    expect(() => m.inspectModels()).toThrow(`profiles.a.env 不能设 ${key}`);
  });

  it("别家档案没设 ANTHROPIC_DEFAULT_HAIKU_MODEL / limitPattern：警告", () => {
    project({ profiles: { other: { model: "x", env: { ANTHROPIC_BASE_URL: "https://example.com" } } }, phases: phasesAll(["other"]) });
    const { warnings } = m.inspectModels();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("profiles.other 发到别家但没设 ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(warnings[1]).toContain("没设 limitPattern");
    // reloadModels 把警告打到 stderr
    m.reloadModels();
    expect(warn.mock.calls.flat().join("\n")).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });
});

// ---------------------------------------------------------------------------
describe("missingCredentials（run 每轮预检用的凭据检查，#62）", () => {
  const VAR = "SC_MODELS_TEST_GLM_KEY";
  const glm = () => ({
    model: "glm-4.6",
    limitPattern: "quota",
    env: { ANTHROPIC_BASE_URL: "https://glm.example/api", ANTHROPIC_AUTH_TOKEN: `\${${VAR}}`, ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" },
  });
  // 宿主机上的 Claude 凭据会被当成 .env 空值的来源，用例里先拿掉，结束时还原。
  let savedCreds: Record<string, string | undefined> = {};
  beforeEach(() => {
    delete process.env[VAR];
    savedCreds = Object.fromEntries(m.CLAUDE_CREDENTIALS.map((k) => [k, process.env[k]]));
    for (const k of m.CLAUDE_CREDENTIALS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of m.CLAUDE_CREDENTIALS) {
      if (savedCreds[k] === undefined) delete process.env[k];
      else process.env[k] = savedCreds[k];
    }
  });

  it("没调 reloadModels（config 还没读）或只有别家档案：不算缺失，返回空", () => {
    expect(m.missingCredentials()).toEqual([]);
    project({ profiles: { glm: glm() }, phases: phasesAll(["glm"]) }, `${VAR}=k\nGH_TOKEN=x\n`);
    m.reloadModels();
    expect(m.missingCredentials()).toEqual([]);
  });

  it("被用到的档案里有 Claude 的、.env 没有任何 Claude 凭据：返回变量名；补上 token 后恢复为空", () => {
    project({ profiles: { glm: glm(), opus: claude() }, phases: phasesAll(["opus"]) }, `${VAR}=k\nGH_TOKEN=x\n`);
    m.reloadModels();
    expect(m.missingCredentials()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY"]);
    writeFileSync(".sandcastle/.env", `CLAUDE_CODE_OAUTH_TOKEN=tok\n${VAR}=k\nGH_TOKEN=x\n`);
    m.reloadModels();
    expect(m.missingCredentials()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("N1e 热重载 reloadModels", () => {
  it("改 models.json 后再 reloadModels 生效", async () => {
    project({ profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["opus"]) });
    m.reloadModels();
    expect(log.mock.calls.flat().join("\n")).toContain("implement=opus");
    expect((await m.runWithProfile("implement", "#1", async () => done())).profile.name).toBe("opus");

    writeModels({ profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["sonnet", "opus"]) });
    // 没 reload 之前还是旧配置
    expect((await m.runWithProfile("implement", "#1", async () => done())).profile.name).toBe("opus");
    m.reloadModels();
    expect(log.mock.calls.flat().join("\n")).toContain("implement=sonnet→opus");
    expect((await m.runWithProfile("implement", "#1", async () => done())).profile.name).toBe("sonnet");
  });

  it("之后改坏了：不抛，提示并沿用上一份", async () => {
    project({ profiles: { sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["sonnet"]) });
    m.reloadModels();
    writeModels("{ not json");
    expect(() => m.reloadModels()).not.toThrow();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/不是合法的 JSON.*沿用上一次读到的配置/);
    expect(warn.mock.calls.flat().join("\n")).toContain(".sandcastle/models.json：");
    expect(warn.mock.calls.flat().join("\n")).not.toContain("Error: ");
    writeModels({ profiles: { sonnet: claude() }, phases: phasesAll(["ghost"]) });
    expect(() => m.reloadModels()).not.toThrow();
    expect(warn.mock.calls.flat().join("\n")).toContain("档案 ghost 不在 profiles 里");
    expect((await m.runWithProfile("implement", "#1", async () => done())).profile).toMatchObject({ name: "sonnet", model: "claude-sonnet-4-5" });
  });

  it("英文下改坏了：提示用半角冒号，不带「Error: 」前缀", async () => {
    (await import("../src/term.ts")).setTermLanguage("en", {});
    project({ profiles: { sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["sonnet"]) });
    m.reloadModels();
    writeModels("{ not json");
    m.reloadModels();
    const text = warn.mock.calls.flat().join("\n");
    expect(text).toMatch(/⚠ \.sandcastle\/models\.json: invalid JSON: .*; keeping the previously loaded config/);
    expect(text).not.toContain("Error: ");
    expect(text).not.toContain("：");
  });

  it("同一份配置 reload 两次：Models 行只打一次", () => {
    project({ profiles: { opus: claude() }, phases: phasesAll(["opus"]) });
    m.reloadModels();
    m.reloadModels();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/^模型：prep=opus/);
  });

  it("只是格式变了（空白不同）：不算变化", () => {
    const models = { profiles: { opus: claude() }, phases: phasesAll(["opus"]) };
    project(models);
    m.reloadModels();
    writeModels(JSON.stringify(models, null, 2));
    m.reloadModels();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("改了 phases 再 reload：多打一行「模型配置已更新」", () => {
    project({ profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["opus"]) });
    m.reloadModels();
    writeModels({ profiles: { opus: claude(), sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["opus"], { implement: ["sonnet"] }) });
    m.reloadModels();
    m.reloadModels();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1]![0])).toContain("模型配置已更新");
    expect(String(log.mock.calls[1]![0])).toContain("implement=sonnet");
  });

  it("只改档案的 model：也打「模型配置已更新」", () => {
    project({ profiles: { opus: claude() }, phases: phasesAll(["opus"]) });
    m.reloadModels();
    writeModels({ profiles: { opus: claude("claude-opus-4-6") }, phases: phasesAll(["opus"]) });
    m.reloadModels();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1]![0])).toContain("模型配置已更新");
  });

  it("带警告的配置 reload 两次：警告只打一次", () => {
    project({ profiles: { other: { model: "x", env: { ANTHROPIC_BASE_URL: "https://example.com" } } }, phases: phasesAll(["other"]) });
    m.reloadModels();
    const once = warn.mock.calls.length;
    expect(once).toBeGreaterThan(0);
    m.reloadModels();
    expect(warn).toHaveBeenCalledTimes(once);
  });

  it("配置变了但警告文本没变：只打「已更新」，警告不重打", () => {
    const other = (model: string) => ({ profiles: { other: { model, env: { ANTHROPIC_BASE_URL: "https://example.com" } } }, phases: phasesAll(["other"]) });
    project(other("x"));
    m.reloadModels();
    const once = warn.mock.calls.length;
    writeModels(other("y"));
    m.reloadModels();
    expect(warn).toHaveBeenCalledTimes(once);
    expect(String(log.mock.calls[1]![0])).toContain("模型配置已更新");
  });

  it("改坏后又改回原样：每轮提示沿用，改回后不打「已更新」", () => {
    const models = { profiles: { sonnet: claude("claude-sonnet-4-5") }, phases: phasesAll(["sonnet"]) };
    project(models);
    m.reloadModels();
    writeModels("{ not json");
    m.reloadModels();
    m.reloadModels();
    expect(warn.mock.calls.flat().filter((s) => String(s).includes("沿用上一次读到的配置"))).toHaveLength(2);
    writeModels(models);
    m.reloadModels();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("第一次就读不成：直接抛", () => {
    project("{ not json");
    expect(() => m.reloadModels()).toThrow("不是合法的 JSON");
  });

  it("models.json 不存在：第一次抛", () => {
    process.chdir(mkdtempSync(join(tmpdir(), "sc-models-empty-")));
    expect(() => m.reloadModels()).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("N1f 用量记录", () => {
  const profile = (): Profile => {
    project({ profiles: { p1: claude("claude-opus-4-5") }, phases: phasesAll(["p1"]) });
    return m.inspectModels().used[0]!;
  };
  const sessionFile = () => {
    const file = join(mkdtempSync(join(tmpdir(), "sc-session-")), "s.jsonl");
    const a = (id: string, u: [number, number, number, number]) =>
      JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } });
    writeFileSync(
      file,
      [
        a("m1", [10, 100, 0, 5]),
        a("m1", [10, 100, 0, 20]), // 同一条消息分多行写：按 id 去重取最后一行
        JSON.stringify({ type: "user", message: { content: "x" } }),
        a("m2", [4, 50, 3000, 40]),
        "{broken",
        "",
      ].join("\n"),
    );
    return file;
  };

  it("agentFor 带 onModelUsage：result 行的 modelUsage 原样回调，其余行、坏 JSON、没有 modelUsage 的 result 行不回调；返回值与不传时相同", () => {
    const p = profile();
    const got: unknown[] = [];
    const wrapped = m.agentFor(p, {}, "implement", (mu) => got.push(mu));
    const usage = { "claude-opus-4-5": { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4, costUSD: 0.01 } };
    const resultLine = JSON.stringify({ type: "result", result: "x", modelUsage: usage });
    expect(wrapped.parseStreamLine(resultLine)).toEqual(m.agentFor(p, {}).parseStreamLine(resultLine));
    expect(got).toEqual([usage]);
    wrapped.parseStreamLine('{"type":"assistant","message":{"content":"hi"}}');
    wrapped.parseStreamLine("{broken");
    wrapped.parseStreamLine('{"type":"result","result":"y"}');
    expect(got).toHaveLength(1);
  });

  it("recordUsage 按会话汇总并追加到 usage.jsonl，每条带 issue / phase / profile / model / peak", () => {
    const p = profile();
    const run: AgentRun = {
      stdout: "",
      iterations: [
        { sessionFilePath: sessionFile() },
        { usage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 1000, outputTokens: 7 } },
        {},
      ],
    };
    const rec = m.recordUsage("#12", "implement", run, "implement", p);
    expect(rec).toMatchObject({
      issue: "#12", phase: "implement", run: "implement", profile: "p1", model: "claude-opus-4-5",
      sessions: 3, input: 15, cacheCreation: 152, cacheRead: 4000, output: 67, peak: 3054,
    });
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
    m.recordUsage("#12", "review", { stdout: "", iterations: [{ sessionFilePath: "/nonexistent/x.jsonl" }] }, "review", p);
    m.recordUsage("#12", "re-review", { stdout: "", iterations: [] }, "re-review", p);

    const lines = readFileSync(".sandcastle/logs/usage.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual(rec);
    expect(lines[1]).toMatchObject({ issue: "#12", phase: "review", profile: "p1", model: "claude-opus-4-5", sessions: 1, peak: 0 });
    expect(lines[2]).toMatchObject({ issue: "#12", phase: "re-review", run: "re-review", sessions: 0 });
    for (const l of lines) expect(Object.keys(l)).toEqual(expect.arrayContaining(["issue", "phase", "profile", "model", "peak"]));
  });

  it("第三方档案的 model 是别名、env 里有对应的 ANTHROPIC_DEFAULT_*_MODEL：记成「别名→实际名」", () => {
    const empty: AgentRun = { stdout: "", iterations: [] };
    const used = (model: string, env: Record<string, string>) => {
      project({ profiles: { p1: { model, env } }, phases: phasesAll(["p1"]) }, "GLM_MODEL=glm-5.3\n");
      return m.recordUsage("#1", "implement", empty, "implement", m.inspectModels().used[0]!).model;
    };
    const glm = { ANTHROPIC_BASE_URL: "https://glm.example", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" };
    expect(used("opus", { ...glm, ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]" })).toBe("opus→glm-5.3[1m]");
    expect(used("sonnet[1m]", { ...glm, ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3" })).toBe("sonnet[1m]→glm-5.3");
    expect(used("haiku", glm)).toBe("haiku→glm-4.5-air");
    // 值只在容器里（${VAR}）、没设对应变量、不是别名：原样记
    expect(used("opus", { ...glm, ANTHROPIC_DEFAULT_OPUS_MODEL: "${GLM_MODEL}" })).toBe("opus");
    expect(used("opus", glm)).toBe("opus");
    expect(used("opusplan", { ...glm, ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" })).toBe("opusplan");
    // Claude 档案：别名原样记
    expect(used("opus", { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5" })).toBe("opus");
  });

  it("sessionPeak：会话文件里单条消息的最大上下文；没有文件退回最后一条的快照", () => {
    expect(m.sessionPeak({ sessionFilePath: sessionFile() })).toBe(3054);
    expect(m.sessionPeak({ usage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 99 } })).toBe(6);
    expect(m.sessionPeak({})).toBe(0);
  });

  it("usage.jsonl 写不进去：只警告，照样返回记录", () => {
    const p = profile();
    writeFileSync(".sandcastle/logs", "不是目录");
    const rec = m.recordUsage("#1", "prep", { stdout: "", iterations: [] }, "prep", p);
    expect(rec).toMatchObject({ issue: "#1", sessions: 0, peak: 0 });
    expect(warn.mock.calls.flat().join("\n")).toContain("用量没写进 .sandcastle/logs/usage.jsonl");
  });

  it("readUsage：只返回这张票指定 phase 的记录，按文件顺序；坏行和写了一半的末行跳过", () => {
    const p = profile();
    const empty = { stdout: "", iterations: [] };
    m.recordUsage("41", "prep", empty, "prep-41", p);
    m.recordUsage("42", "prep", empty, "prep-42", p);
    m.recordUsage("41", "implement", empty, "implement", p);
    m.recordUsage("41", "prep", empty, "reprep-41", p);
    appendFileSync(".sandcastle/logs/usage.jsonl", `{broken\n"str"\nnull\n{"issue":41,"phase":"prep"}\n{"issue":"41","phase":"pr`);
    expect(m.readUsage("41", "prep").map((r) => r.run)).toEqual(["prep-41", "reprep-41"]);
    expect(m.readUsage("41").map((r) => r.run)).toEqual(["prep-41", "implement", "reprep-41"]);
    expect(m.readUsage("99", "prep")).toEqual([]);
  });

  it("readUsage：usage.jsonl 不存在时返回空数组", () => {
    profile();
    expect(m.readUsage("41", "prep")).toEqual([]);
  });

  it("usageTable：每次 run 一行，token 以 k 计；没有记录时给提示；英文表头", () => {
    const rec = (run: string, peak: number) => ({
      at: "", issue: "#1", phase: "implement" as const, run, profile: "p1", model: "claude-opus-4-5",
      sessions: 3, input: 15, cacheCreation: 152, cacheRead: 4000, output: 67, peak,
    });
    const zh = m.usageTable([rec("implement", 3054), rec("review", 120_000)]);
    const lines = zh.split("\n");
    expect(lines[0]).toBe(messages("zh").usageHeader);
    expect(lines[1]).toBe("|---|---|---|---|---|---|---|---|");
    expect(lines[2]).toBe("| implement | p1（claude-opus-4-5） | 3 | 0.0k | 0.2k | 4.0k | 0.1k | 3.1k |");
    expect(lines[3]).toContain("| review |");
    expect(lines[3]).toContain("| 120.0k |");
    expect(lines).toHaveLength(4);
    expect(m.usageTable([])).toBe(messages("zh").usageNone);
    const en = m.usageTable([rec("implement", 3054)], messages("en"));
    expect(en).toContain("| Session | Profile |");
    expect(en).toContain("p1 (claude-opus-4-5)");
    expect(m.usageTable([], messages("en"))).toBe("(no usage recorded)");
  });

  it("recordUsage 带 modelUsage：按模型累加写进 models；Claude 档案带 costUSD，第三方不带且键等于 ANTHROPIC_DEFAULT_*_MODEL 的值时记成「别名→实际名」；不传或空数组时不写 models", () => {
    const p = profile();
    const empty: AgentRun = { stdout: "", iterations: [] };
    const mu = (model: string, n: [number, number, number, number], costUSD = 0) =>
      ({ [model]: { inputTokens: n[0], cacheCreationInputTokens: n[1], cacheReadInputTokens: n[2], outputTokens: n[3], costUSD } });
    const rec = m.recordUsage("#5", "implement", empty, "implement", p, false, [
      mu("claude-opus-4-5", [10, 100, 0, 5], 0.1),
      mu("claude-haiku-4-5", [1, 2, 3, 4], 0.01),
      mu("claude-opus-4-5", [7, 70, 0, 2], 0.2),
    ]);
    expect(rec.models).toEqual([
      { model: "claude-opus-4-5", input: 17, cacheCreation: 170, cacheRead: 0, output: 7, costUSD: 0.1 + 0.2 },
      { model: "claude-haiku-4-5", input: 1, cacheCreation: 2, cacheRead: 3, output: 4, costUSD: 0.01 },
    ]);
    const used = (model: string, env: Record<string, string>, modelUsage: ReturnType<typeof mu>[], envFile?: string) => {
      project({ profiles: { p1: { model, env } }, phases: phasesAll(["p1"]) }, envFile);
      return m.recordUsage("#1", "implement", empty, "implement", m.inspectModels().used[0]!, false, modelUsage);
    };
    const glmEnv = { ANTHROPIC_BASE_URL: "https://glm.example/api", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" };
    // glm 档案：不写 costUSD；modelUsage 的键是映射后的真实名，等于 ANTHROPIC_DEFAULT_HAIKU_MODEL 的值 → haiku→glm-4.5-air；查不到别名的原样
    expect(used("glm-4.6", glmEnv, [mu("glm-4.6", [10, 0, 0, 5], 0.1), mu("glm-4.5-air", [2, 0, 0, 1], 0.02)]).models).toEqual([
      { model: "glm-4.6", input: 10, cacheCreation: 0, cacheRead: 0, output: 5 },
      { model: "haiku→glm-4.5-air", input: 2, cacheCreation: 0, cacheRead: 0, output: 1 },
    ]);
    expect(used("glm-4.6", glmEnv, [mu("glm-5.3", [1, 0, 0, 1])]).models).toEqual([{ model: "glm-5.3", input: 1, cacheCreation: 0, cacheRead: 0, output: 1 }]);
    // 值是 ${VAR}（真实值只在容器里）：反查不到，原样记
    expect(used("opus", { ...glmEnv, ANTHROPIC_DEFAULT_OPUS_MODEL: "${GLM_MODEL}" }, [mu("glm-5.3[1m]", [1, 0, 0, 1])], "GLM_MODEL=glm-5.3\n").models).toEqual([{ model: "glm-5.3[1m]", input: 1, cacheCreation: 0, cacheRead: 0, output: 1 }]);
    // 不传 / 空数组：不写 models 字段（老记录、没拿到 result 行的都这样）
    expect("models" in m.recordUsage("#5", "review", empty, "review", p)).toBe(false);
    expect("models" in m.recordUsage("#5", "review", empty, "review", p, false, [])).toBe(false);
  });

  it("recordUsage 撞限额的记录：带 limited: true，没有 run 时 token 0、sessions 0；没撞的不写 limited", () => {
    const p = profile();
    const rec = m.recordUsage("#3", "implement", undefined, "implement", p, true);
    expect(rec).toMatchObject({
      issue: "#3", phase: "implement", run: "implement", profile: "p1", model: "claude-opus-4-5",
      sessions: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, peak: 0, limited: true,
    });
    const withRun = m.recordUsage("#3", "implement", { stdout: "", iterations: [{ usage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 } }] }, "implement", p, true);
    expect(withRun).toMatchObject({ sessions: 1, input: 1, output: 4, limited: true });
    m.recordUsage("#3", "implement", { stdout: "", iterations: [] }, "implement", p);
    const lines = readFileSync(".sandcastle/logs/usage.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.limited)).toEqual([true, true, undefined]);
    expect("limited" in lines[2]).toBe(false);
    expect(m.readUsage("#3").map((r) => r.limited)).toEqual([true, true, undefined]);
  });

  it("usageTable：models 有 2 个及以上模型时行下面每个模型一行「↳」，次数和上下文峰值格 —，列数不变；只有 1 个或没有时不加行", () => {
    const rec = { at: "", issue: "#1", phase: "implement" as const, run: "implement", profile: "glm", model: "glm-4.6", sessions: 3, input: 15, cacheCreation: 152, cacheRead: 4000, output: 67, peak: 3054 };
    const models = [
      { model: "glm-4.6", input: 1000, cacheCreation: 20, cacheRead: 300, output: 500 },
      { model: "haiku→glm-4.5-air", input: 200, cacheCreation: 0, cacheRead: 0, output: 100 },
    ];
    const zh = m.usageTable([{ ...rec, models }]).split("\n");
    expect(zh).toHaveLength(5);
    expect(zh[3]).toBe("| | ↳ glm-4.6 | — | 1.0k | 0.0k | 0.3k | 0.5k | — |");
    expect(zh[4]).toBe("| | ↳ haiku→glm-4.5-air | — | 0.2k | 0.0k | 0.0k | 0.1k | — |");
    const cols = (line: string) => line.split("|").length;
    expect(cols(zh[3]!)).toBe(cols(zh[2]!));
    expect(cols(zh[3]!)).toBe(cols(zh[0]!));
    // 只有 1 个模型、没有 models（老记录）：输出与现在完全一样
    const one = m.usageTable([{ ...rec, models: models.slice(0, 1) }]);
    expect(one).toBe(m.usageTable([rec]));
  });

  it("usageTable：limited 的行次数格写「撞限额，换下一个档案」，数值格 —，列数不变；老记录不变", () => {
    const rec = { at: "", issue: "#1", phase: "implement" as const, run: "implement", profile: "p1", model: "claude-opus-4-5", sessions: 3, input: 15, cacheCreation: 152, cacheRead: 4000, output: 67, peak: 3054 };
    const cols = (line: string) => line.split("|").length;
    const zh = m.usageTable([{ ...rec, limited: true }, rec]).split("\n");
    expect(zh[2]).toBe("| implement | p1（claude-opus-4-5） | 撞限额，换下一个档案 | — | — | — | — | — |");
    expect(zh[3]).toBe("| implement | p1（claude-opus-4-5） | 3 | 0.0k | 0.2k | 4.0k | 0.1k | 3.1k |");
    expect(cols(zh[2]!)).toBe(cols(zh[3]!));
    expect(cols(zh[2]!)).toBe(cols(zh[0]!));
    const en = m.usageTable([{ ...rec, limited: true }], messages("en")).split("\n");
    expect(en[2]).toBe("| implement | p1 (claude-opus-4-5) | hit usage limit, switched to next profile | — | — | — | — | — |");
  });
});
