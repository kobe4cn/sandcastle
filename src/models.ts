// Sandcastle 每个阶段用哪个模型：读 .sandcastle/models.json，按阶段挑档案、撞限额时换下一个，记录每次会话的 token 用量。
// 格式与规则见 docs/internal/sandcastle.md「模型配置」。
// Which model each Sandcastle phase uses: reads .sandcastle/models.json, picks a profile per phase, moves to the next one on a usage limit, and records each session's token usage.
// Format and rules: "模型配置" in docs/internal/sandcastle.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { messages, type Messages } from "./i18n.ts";
import { t } from "./term.ts";

export const PHASES = ["prep", "implement", "review", "revise", "fix", "rebase"] as const;
export type Phase = (typeof PHASES)[number];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** sandbox.run 与 sandcastle.run 的结果都满足它。 / Results of both sandbox.run and sandcastle.run satisfy it. */
export interface AgentRun {
  readonly iterations: readonly sandcastle.IterationResult[];
  readonly completionSignal?: string;
  readonly stdout: string;
}

export interface Profile {
  readonly name: string;
  readonly model: string;
  readonly effort?: Effort;
  /**
   * 只在这次会话的 claude 进程上生效；值是 `${VAR}` 的，在容器里从同名环境变量取（来自 .sandcastle/.env）。
   * Applies only to this session's claude process; `${VAR}` values come from the same-named environment variable in the container (from .sandcastle/.env).
   */
  readonly env: Readonly<Record<string, string>>;
  /** 设了 ANTHROPIC_BASE_URL：请求发到别家，不走 Claude 订阅。 / ANTHROPIC_BASE_URL set: requests go to another vendor, not the Claude subscription. */
  readonly thirdParty: boolean;
  readonly limitPattern: RegExp;
  /** 别家报错里不带时区的重置时间按这个时区解析。 / Reset times without a time zone in another vendor's errors are parsed in this zone. */
  readonly resetTimeZone?: string;
}

interface ModelsConfig {
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly phases: Readonly<Record<Phase, readonly string[]>>;
}

const CONFIG_PATH = ".sandcastle/models.json";
const SANDCASTLE_ENV_PATH = ".sandcastle/.env";
const USAGE_LOG = ".sandcastle/logs/usage.jsonl";
const SECRET_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * 脚本统一给容器设的上下文预算（CLAUDE.md「Context budget」），档案不能改。
 * Context budget the pipeline sets for every container (CLAUDE.md "Context budget"); profiles can't change it.
 */
const RESERVED_ENV = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"];
/**
 * Claude 凭据：不能跟着请求发到别家的接口。容器级 env 里清空（CLAUDE_CREDENTIALS_CLEARED），只有 Claude 档案的会话从 stdin 拿到（agentFor）。
 * Claude credentials: they must not be sent to another vendor's API. Cleared in the container-level env (CLAUDE_CREDENTIALS_CLEARED); only Claude profiles' sessions receive them, over stdin (agentFor).
 */
export const CLAUDE_CREDENTIALS: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
/**
 * 合进 sandbox env，覆盖 sandcastle 从 .sandcastle/.env 读到的凭据：容器的 env 在 podman run 时定死，同一个容器会先后跑 Claude 和别家的会话，凭据只能按会话给。
 * Merged into the sandbox env to override the credentials sandcastle reads from .sandcastle/.env: the container's env is fixed at podman run and one container may run both Claude and other vendors' sessions, so credentials can only be given per session.
 */
export const CLAUDE_CREDENTIALS_CLEARED: Readonly<Record<string, string>> = Object.fromEntries(CLAUDE_CREDENTIALS.map((k) => [k, ""]));

/** claude-code 撞订阅限额的报错，如「You've hit your 5-hour limit · resets 6:20am (UTC)」。 */
export const CLAUDE_LIMIT_PATTERN = /hit your .*?limit/i;
/** 认不出重置时间时跳过这个档案多久。 / How long to skip a profile when the reset time can't be read. */
const UNKNOWN_RESET_SKIP_MS = 60 * 60_000;
const RESET_SLACK_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// 读配置
// Reading the config
// ---------------------------------------------------------------------------

/** 报错的文字：Error 只取 message，不带「Error: 」前缀。 / An error's text: just the message for an Error, without the "Error: " prefix. */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const fail = (message: string): never => {
  throw new Error(`${CONFIG_PATH}${t("：", ": ")}${message}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * sandcastle 只把 .sandcastle/.env 里列出的键带进容器（值取文件里的，空的取宿主机环境变量），两边都没值的不带。
 * sandcastle passes only the keys listed in .sandcastle/.env into the container (values from the file; empty ones from the host environment); keys with no value either way are dropped.
 */
function sandcastleEnv(): Record<string, string> {
  if (!existsSync(SANDCASTLE_ENV_PATH)) return {};
  const vars = parseEnv(readFileSync(SANDCASTLE_ENV_PATH, "utf8"));
  const resolved: Record<string, string> = {};
  for (const k of Object.keys(vars)) {
    const value = vars[k] || process.env[k];
    if (value) resolved[k] = value;
  }
  return resolved;
}
const sandcastleEnvKeys = () => new Set(Object.keys(sandcastleEnv()));

/**
 * .sandcastle/.env 里有值的 Claude 凭据，按 CLAUDE_CREDENTIALS 的顺序。
 * Claude credentials with a value in .sandcastle/.env, in CLAUDE_CREDENTIALS order.
 */
function claudeCredentials(): [string, string][] {
  const env = sandcastleEnv();
  return CLAUDE_CREDENTIALS.flatMap((k): [string, string][] => (env[k] ? [[k, env[k]]] : []));
}

function parseProfile(name: string, raw: unknown, warn: (m: string) => void): Profile & { readonly refs: readonly { where: string; variable: string }[] } {
  const at = `profiles.${name}`;
  if (!isRecord(raw)) return fail(t(`${at} 要是对象`, `${at} must be an object`));
  const harness = raw.harness ?? "claude-code";
  if (harness === "codex") fail(t(`${at}.harness 是 codex：还没实现，目前只支持 claude-code`, `${at}.harness is codex: not implemented yet, only claude-code is supported`));
  if (harness !== "claude-code") fail(t(`${at}.harness 只能是 claude-code`, `${at}.harness must be claude-code`));
  if (typeof raw.model !== "string" || !raw.model) fail(t(`${at}.model 要是非空字符串`, `${at}.model must be a non-empty string`));
  if (raw.effort !== undefined && !EFFORTS.includes(raw.effort as Effort)) fail(t(`${at}.effort 只能是 ${EFFORTS.join(" / ")}`, `${at}.effort must be one of ${EFFORTS.join(" / ")}`));
  if (raw.env !== undefined && !isRecord(raw.env)) fail(t(`${at}.env 要是对象`, `${at}.env must be an object`));

  const env: Record<string, string> = {};
  const refs: { where: string; variable: string }[] = [];
  for (const [key, value] of Object.entries(raw.env ?? {})) {
    if (!ENV_KEY.test(key)) fail(t(`${at}.env 的键 ${key} 不是合法的环境变量名`, `${at}.env key ${key} isn't a valid environment variable name`));
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail(t(`${at}.env.${key} 要是字符串或数字`, `${at}.env.${key} must be a string or number`));
    if (RESERVED_ENV.includes(key)) {
      warn(t(`${at}.env.${key} 忽略：上下文预算由脚本统一设置`, `${at}.env.${key} ignored: the context budget is set by the pipeline`));
      continue;
    }
    if (CLAUDE_CREDENTIALS.includes(key)) fail(t(`${at}.env 不能设 ${key}`, `${at}.env can't set ${key}`));
    const text = String(value);
    const ref = SECRET_REF.exec(text);
    if (ref) {
      refs.push({ where: `${at}.env.${key}`, variable: ref[1]! });
    } else if (text.includes("${")) {
      fail(t(`${at}.env.${key}：\${VAR} 只能单独作为整个值`, `${at}.env.${key}: \${VAR} must be the whole value on its own`));
    }
    env[key] = text;
  }

  const thirdParty = "ANTHROPIC_BASE_URL" in env;
  if (thirdParty && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    warn(
      t(
        `${at} 发到别家但没设 ANTHROPIC_DEFAULT_HAIKU_MODEL：Claude Code 的后台小任务和子 agent 会拿 Claude 的模型名去请求别家接口`,
        `${at} goes to another vendor but doesn't set ANTHROPIC_DEFAULT_HAIKU_MODEL: Claude Code's background tasks and subagents would request Claude model names from that vendor`,
      ),
    );
  }
  if (raw.limitPattern !== undefined && typeof raw.limitPattern !== "string") fail(t(`${at}.limitPattern 要是正则字符串`, `${at}.limitPattern must be a regex string`));
  let limitPattern = CLAUDE_LIMIT_PATTERN;
  if (typeof raw.limitPattern === "string") {
    try {
      limitPattern = new RegExp(raw.limitPattern, "i");
    } catch (e) {
      fail(t(`${at}.limitPattern 不是合法的正则：`, `${at}.limitPattern isn't a valid regex: `) + errorText(e));
    }
  } else if (thirdParty) {
    warn(
      t(
        `${at} 发到别家但没设 limitPattern：撞了它的限额认不出来，只会当成普通报错`,
        `${at} goes to another vendor but doesn't set limitPattern: hitting its limit won't be recognized and counts as an ordinary error`,
      ),
    );
  }
  if (raw.resetTimeZone !== undefined) {
    if (typeof raw.resetTimeZone !== "string") fail(t(`${at}.resetTimeZone 要是时区名，如 Asia/Shanghai`, `${at}.resetTimeZone must be a time zone name, e.g. Asia/Shanghai`));
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw.resetTimeZone as string });
    } catch {
      fail(t(`${at}.resetTimeZone 不是合法的时区：`, `${at}.resetTimeZone isn't a valid time zone: `) + String(raw.resetTimeZone));
    }
  }
  return {
    name,
    model: raw.model as string,
    effort: raw.effort as Effort | undefined,
    env,
    thirdParty,
    limitPattern,
    resetTimeZone: raw.resetTimeZone as string | undefined,
    refs,
  };
}

function parseConfig(text: string, envKeys: Set<string>, warn: (m: string) => void): ModelsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(t("不是合法的 JSON：", "invalid JSON: ") + errorText(e));
  }
  if (!isRecord(raw) || !isRecord(raw.profiles) || !isRecord(raw.phases)) return fail(t("要有 profiles 和 phases 两个对象", "must have two objects, profiles and phases"));
  const profiles = new Map(Object.entries(raw.profiles).map(([name, p]) => [name, parseProfile(name, p, warn)]));
  for (const key of Object.keys(raw.phases)) {
    if (!PHASES.includes(key as Phase)) fail(t(`phases 里的 ${key} 不是阶段；阶段是 ${PHASES.join(" / ")}`, `${key} in phases isn't a phase; phases are ${PHASES.join(" / ")}`));
  }
  const phases = {} as Record<Phase, string[]>;
  for (const phase of PHASES) {
    const list = raw.phases[phase];
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string")) {
      fail(t(`phases.${phase} 要是非空的档案名列表`, `phases.${phase} must be a non-empty list of profile names`));
    }
    for (const name of list as string[]) if (!profiles.has(name)) fail(t(`phases.${phase} 里的档案 ${name} 不在 profiles 里`, `profile ${name} in phases.${phase} isn't in profiles`));
    phases[phase] = list as string[];
  }
  // 只查阶段用到的档案：没启用的档案（比如还没填密钥的别家）不挡运行。
  // Only check profiles that phases use: unused profiles (e.g. another vendor without a key yet) don't block the run.
  for (const name of new Set(Object.values(phases).flat())) {
    for (const { where, variable } of profiles.get(name)!.refs) {
      if (!envKeys.has(variable)) fail(
          t(
            `${where} 引用的 ${variable} 不在 ${SANDCASTLE_ENV_PATH} 里（或值为空）：sandcastle 只把那里列出的变量带进容器`,
            `${variable} referenced by ${where} isn't in ${SANDCASTLE_ENV_PATH} (or is empty): sandcastle only passes the variables listed there into the container`,
          ),
        );
    }
  }
  return { profiles, phases };
}

let config: ModelsConfig | undefined;
/**
 * 上次读成功的 models.json 内容（去掉格式差异）和警告：没变就不重复打印。
 * Content of the last successfully read models.json (formatting stripped) and its warning text (joined by newlines): unchanged means not printed again.
 */
let lastConfigJson: string | undefined;
let lastWarningText: string | undefined;

/**
 * doctor 用：读一遍 models.json，返回各阶段用到的档案和警告；读不成直接抛。
 * For doctor: read models.json once and return the profiles each phase uses plus warnings; throws if it can't be read.
 */
export function inspectModels(): { phases: Record<Phase, readonly string[]>; used: Profile[]; warnings: string[] } {
  const warnings: string[] = [];
  const c = parseConfig(readFileSync(CONFIG_PATH, "utf8"), sandcastleEnvKeys(), (m) => warnings.push(m));
  const used = [...new Set(Object.values(c.phases).flat())].map((name) => c.profiles.get(name)!);
  return { phases: c.phases, used, warnings };
}

/**
 * 每轮开头调用。第一次读不成直接抛（运行起不来）；之后读不成就警告并沿用上一份，不打断正在跑的运行（这个提示每轮都打，要人去修）。
 * 模型行启动时打印一次，之后只在 models.json 内容变化时打「模型配置已更新」；警告只在警告文本变化时重打。
 * 内容按 JSON 解析后再序列化来比：空白和缩进不算变化，键的顺序变了算；改坏后又改回原样不算变化。
 * Called at the start of each pass. The first failed read throws (the run can't start); later failures warn and keep the previous config without interrupting the run (that warning repeats every pass, since someone needs to fix it).
 * The models line is printed once at startup, then only as "Models updated" when models.json's content changes; warnings are reprinted only when their text changes.
 * Content is compared after parsing and re-serializing the JSON: whitespace and indentation don't count, key order does; breaking the file and then restoring it doesn't count.
 */
export function reloadModels() {
  const warnings: string[] = [];
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const next = parseConfig(text, sandcastleEnvKeys(), (m) => warnings.push(m));
    const key = JSON.stringify(JSON.parse(text));
    const warningKey = warnings.join("\n");
    if (warningKey !== lastWarningText) for (const w of warnings) console.warn(`  ⚠ ${CONFIG_PATH}${t("：", ": ")}${w}`);
    config = next;
    const list = PHASES.map((p) => `${p}=${next.phases[p].join("→")}`).join("  ");
    if (lastConfigJson === undefined) console.log(`${t("模型：", "Models: ")}${list}`);
    else if (key !== lastConfigJson) console.log(`${t("模型配置已更新：", "Models updated: ")}${list}`);
    lastConfigJson = key;
    lastWarningText = warningKey;
  } catch (e) {
    if (!config) throw e;
    console.warn(`  ⚠ ${errorText(e)}${t("；沿用上一次读到的配置", "; keeping the previously loaded config")}`);
  }
}

// ---------------------------------------------------------------------------
// 档案 → agent provider
// Profile → agent provider
// ---------------------------------------------------------------------------

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * createSandbox 里的 sandbox.run 不用 agent provider 的 env（只用容器启动时的），所以档案的 env 加在命令前面：
 * `env -u … K=V claude …`，另加 SANDCASTLE_PROFILE（implementer 在进度评论里写明用的档案）。命令在容器里由 sh -c 执行，`${VAR}` 写成 "$VAR"，密钥不出现在宿主机的命令行里。
 *
 * Claude 凭据不在容器级 env 里（main.ts 用 CLAUDE_CREDENTIALS_CLEARED 清空），按会话给：
 * - Claude 档案：.env 里有值的凭据每个一行放在 prompt 前面从 stdin 送进去，sh 用 read 读进没导出的变量、export 后 exec 成 claude，
 *   值不进任何命令行，sh 被替换掉；没值的凭据 `env -u`（容器里是空串）。
 * - 别家档案：`env -u` 两个凭据，stdin 只有 prompt，这次会话起的进程都没有凭据（之前 Claude 会话留在后台的进程除外）。
 *
 * Profile env goes in front of the command because sandbox.run in createSandbox ignores the agent provider's env: `env -u … K=V claude …`,
 * plus SANDCASTLE_PROFILE. The command runs under sh -c in the container; `${VAR}` becomes "$VAR", so secrets never appear on the host's command line.
 * Claude credentials aren't in the container-level env (main.ts clears them with CLAUDE_CREDENTIALS_CLEARED); they're given per session:
 * - Claude profiles: each credential with a value goes as one stdin line ahead of the prompt; sh reads it into an unexported variable, exports it and execs claude,
 *   so the value is on no command line and sh is replaced; credentials without a value are `env -u`'d (they're empty strings in the container).
 * - Other vendors' profiles: both credentials are `env -u`'d and stdin is just the prompt, so no process the session starts has them (except background processes an earlier Claude session left running).
 */
export function agentFor(profile: Profile, env: Record<string, string>, phase?: Phase): sandcastle.AgentProvider {
  const base = sandcastle.claudeCode(profile.model, { env, ...(profile.effort ? { effort: profile.effort } : {}) });
  // SANDCASTLE_PHASE 给 .claude/hooks/sandcastle-context.mjs：上下文到预算时按阶段给出不同的收尾要求。
  // SANDCASTLE_PHASE is for .claude/hooks/sandcastle-context.mjs: at the budget it gives a different wrap-up request per phase.
  const assignments = Object.entries({ ...profile.env, SANDCASTLE_PROFILE: profile.name, ...(phase ? { SANDCASTLE_PHASE: phase } : {}) }).map(([k, v]) => {
    const ref = SECRET_REF.exec(v);
    return `${k}=${ref ? `"$${ref[1]}"` : shellQuote(v)}`;
  });
  const envPrefix = (unset: readonly string[]) => `env ${[...unset.map((k) => `-u ${k}`), ...assignments].join(" ")} `;
  return {
    ...base,
    // resume 会话也走这里（resumeSession 是 options 的一项）。 / Resumed sessions come through here too (resumeSession is one of the options).
    buildPrintCommand: (options) => {
      const cmd = base.buildPrintCommand(options);
      const creds = profile.thirdParty ? [] : claudeCredentials();
      if (creds.length === 0) return { ...cmd, command: envPrefix(CLAUDE_CREDENTIALS) + cmd.command };
      const given = new Set(creds.map(([k]) => k));
      const reads = creds.map((_, i) => `IFS= read -r __c${i}; `).join("");
      const exports = `export ${creds.map(([k], i) => `${k}="$__c${i}"`).join(" ")}; `;
      return {
        ...cmd,
        command: `${reads}${exports}exec ${envPrefix(CLAUDE_CREDENTIALS.filter((k) => !given.has(k)))}${cmd.command}`,
        stdin: creds.map(([, v]) => `${v}\n`).join("") + (cmd.stdin ?? ""),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 按阶段挑档案；撞限额换下一个
// Pick a profile per phase; move to the next on a usage limit
// ---------------------------------------------------------------------------

/**
 * 档案名 → 在这个时刻之前跳过它。所有并行的票共用：一张票撞了 opus 的限额，别的票也不再去撞。
 * Profile name → skip it until this time. Shared by all parallel tickets: once one ticket hits opus's limit, the others don't hit it again.
 */
const blockedUntil = new Map<string, number>();

/**
 * 这个阶段的档案全都在等限额重置；untilAfterLimit 认它，等到 until 再从头跑。
 * Every profile for this phase is waiting for a limit reset; untilAfterLimit recognizes it and reruns from the start after until.
 */
export class AllProfilesLimited extends Error {
  constructor(readonly phase: Phase, readonly until: number) {
    super(t(`阶段 ${phase} 的档案都撞上了用量限额，最早 ${new Date(until).toLocaleString()} 恢复`, `every profile for phase ${phase} hit its usage limit; the earliest resets at ${new Date(until).toLocaleString()}`));
  }
}

/**
 * 某时刻在 timeZone 里比 UTC 快多少毫秒；timeZone 不合法时抛 RangeError。
 * How many milliseconds timeZone is ahead of UTC at a given moment; throws RangeError for an invalid timeZone.
 */
function tzOffsetMs(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(at).map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  return Math.round((wall - at) / 60_000) * 60_000;
}

/**
 * 报错里的重置时间；认不出返回 null。认两种：
 * - claude-code 的「resets 6:20am (UTC)」：下一次到这个钟点的时刻。只认钟点，带日期的（每周限额）可能算早，
 *   醒来再撞上会重新等，代价是多一次失败的调用。
 * - 别家常见的「2026-11-07 15:30:00」：按 timeZone 解析（不给就按宿主机时区）。
 * Reset time in an error; null if unrecognized. Two forms:
 * - claude-code's "resets 6:20am (UTC)": the next time that clock time comes round. Only the clock time is read, so dated (weekly) limits may resolve early;
 *   hitting the limit again after waking just waits again, at the cost of one more failed call.
 * - the common "2026-11-07 15:30:00" from other vendors: parsed in timeZone (the host's zone if not given).
 */
export function limitResetAt(message: string, timeZone?: string, now = Date.now()): number | null {
  const clock = /resets\b.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === "pm" ? 12 : 0);
    const minute = Number(clock[2] ?? 0);
    const zone = clock[4]!.trim();
    try {
      const today = new Date(now + tzOffsetMs(now, zone));
      for (let day = 0; day <= 1; day++) {
        const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
        const at = wall - tzOffsetMs(wall, zone);
        if (at > now) return at;
      }
    } catch {
      return null;
    }
    return null;
  }
  const stamp = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(message);
  if (stamp) {
    const [y, mo, d, h, mi, s] = stamp.slice(1).map((v) => Number(v ?? 0));
    const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
    const at = timeZone ? wall - tzOffsetMs(wall, timeZone) : new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
    return at > now ? at : null;
  }
  return null;
}

/** 有的报错不抛出来，而是作为最后的输出、不带完成信号返回。 / Some errors aren't thrown but returned as the final output without the completion signal. */
const limitText = (run: AgentRun, p: Profile) =>
  run.completionSignal === undefined && p.limitPattern.test(run.stdout.slice(-2000)) ? run.stdout.slice(-2000) : undefined;

/**
 * 用这个阶段第一个没在等限额的档案跑一次会话。撞上限额就记下重置时间（认不出跳过 1 小时）、换下一个；
 * 都在等时抛 AllProfilesLimited。其他错误照抛。
 * Run one session with this phase's first profile that isn't waiting on a limit. On a limit, record the reset time (skip 1 hour if unreadable) and try the next;
 * throw AllProfilesLimited when all are waiting. Other errors are rethrown.
 */
export async function runWithProfile<T extends AgentRun>(
  phase: Phase,
  what: string,
  fn: (profile: Profile) => Promise<T>,
): Promise<{ run: T; profile: Profile }> {
  if (!config) throw new Error(t("先调用 reloadModels()", "call reloadModels() first"));
  for (;;) {
    const now = Date.now();
    const names = config.phases[phase];
    const name = names.find((n) => (blockedUntil.get(n) ?? 0) <= now);
    if (name === undefined) throw new AllProfilesLimited(phase, Math.min(...names.map((n) => blockedUntil.get(n)!)));
    const profile = config.profiles.get(name)!;
    let message: string | undefined;
    try {
      const run = await fn(profile);
      message = limitText(run, profile);
      if (message === undefined) return { run, profile };
    } catch (e) {
      message = String(e);
      if (!profile.limitPattern.test(message)) throw e;
    }
    const resetAt = limitResetAt(message, profile.resetTimeZone);
    const until = resetAt === null ? now + UNKNOWN_RESET_SKIP_MS : resetAt + RESET_SLACK_MS;
    blockedUntil.set(name, until);
    const why = resetAt === null ? t(`认不出重置时间（${message.slice(-200).trim()}），`, `couldn't read the reset time (${message.slice(-200).trim()}); `) : "";
    const at = new Date(until).toLocaleString();
    console.log(t(`  ⏸ ${what} 的档案 ${name} 撞上用量限额，${why}${at} 前跳过它`, `  ⏸ ${what}: profile ${name} hit its usage limit; ${why}skipping it until ${at}`));
  }
}

// ---------------------------------------------------------------------------
// 用量记录
// Usage records
// ---------------------------------------------------------------------------

export interface UsageRecord {
  readonly at: string;
  readonly issue: string;
  readonly phase: Phase;
  readonly run: string;
  readonly profile: string;
  readonly model: string;
  readonly sessions: number;
  readonly input: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  readonly output: number;
  /**
   * 这次 run 里单条消息的最大上下文（输入 + 缓存写 + 缓存读），预算看的就是它；会话中途压缩过时比结束时的大得多。
   * Largest context of a single message in this run (input + cache write + cache read), which is what the budget measures; much larger than the final size when the session was compacted midway.
   */
  readonly peak: number;
}

/**
 * 一次会话的 token 总数：把会话 JSONL 里每条 assistant 消息的 usage 加起来（同一条消息分多行写、usage 重复，按 id 去重取最后一行）。
 * IterationResult.usage 只是最后一条消息的快照，不能当总数用；没有会话文件时退回用它。
 */
function sessionTotals(it: sandcastle.IterationResult) {
  const zero = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, peak: 0 };
  if (it.sessionFilePath && existsSync(it.sessionFilePath)) {
    const byId = new Map<string, Record<string, number>>();
    for (const line of readFileSync(it.sessionFilePath, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) byId.set(obj.message.id ?? `#${byId.size}`, obj.message.usage);
      } catch {
        // 半行或损坏的行跳过
      }
    }
    const sum = { ...zero };
    for (const u of byId.values()) {
      sum.input += u.input_tokens ?? 0;
      sum.cacheCreation += u.cache_creation_input_tokens ?? 0;
      sum.cacheRead += u.cache_read_input_tokens ?? 0;
      sum.output += u.output_tokens ?? 0;
      sum.peak = Math.max(sum.peak, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
    }
    return sum;
  }
  const u = it.usage;
  return u
    ? {
        input: u.inputTokens, cacheCreation: u.cacheCreationInputTokens, cacheRead: u.cacheReadInputTokens, output: u.outputTokens,
        peak: u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens,
      }
    : zero;
}

/**
 * 一次会话的上下文峰值：会话文件里单条 assistant 消息的最大上下文；没有会话文件时退回最后一条消息（只是结束时的大小）。
 * A session's peak context: the largest single assistant message context in the session file; without a session file, falls back to the last message (only the final size).
 */
export const sessionPeak = (it: sandcastle.IterationResult) => sessionTotals(it).peak;

const MODEL_ALIAS = /^(opus|sonnet|haiku)(\[1m\])?$/;

/**
 * usage 里记的模型名。第三方档案的 model 是 opus/sonnet/haiku（可带 [1m]）、env 里对应的 ANTHROPIC_DEFAULT_*_MODEL 有值时，
 * 记成「别名→实际名」（如 opus→glm-5.3[1m]），免得看起来像用了 Claude；值是 `${VAR}`（真实值只在容器里）或其余情况原样记。
 * The model name recorded in usage. For a third-party profile whose model is opus/sonnet/haiku (optionally [1m]) with the matching ANTHROPIC_DEFAULT_*_MODEL set in env,
 * record "alias→actual" (e.g. opus→glm-5.3[1m]) so it doesn't look like Claude was used; a `${VAR}` value (real value only in the container) or anything else is recorded as is.
 */
function usageModel(p: Profile): string {
  const alias = p.thirdParty ? MODEL_ALIAS.exec(p.model) : null;
  const actual = alias ? p.env[`ANTHROPIC_DEFAULT_${alias[1]!.toUpperCase()}_MODEL`] : undefined;
  return actual && !SECRET_REF.test(actual) ? `${p.model}→${actual}` : p.model;
}

/**
 * 记一次 run 的用量：追加到 .sandcastle/logs/usage.jsonl 并返回；build 收集返回值写进 PR，prep 的落地时用 readUsage 读回。写不进只警告。
 * Record one run's usage: append to .sandcastle/logs/usage.jsonl and return it; build collects the result for the PR, prep's is read back with readUsage on landing. Write failures only warn.
 */
export function recordUsage(issue: string, phase: Phase, run: AgentRun, name: string, profile: Profile): UsageRecord {
  const totals = run.iterations.map(sessionTotals).reduce(
    (a, b) => ({
      input: a.input + b.input, cacheCreation: a.cacheCreation + b.cacheCreation, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output,
      peak: Math.max(a.peak, b.peak),
    }),
    { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, peak: 0 },
  );
  const record: UsageRecord = {
    at: new Date().toISOString(), issue, phase, run: name, profile: profile.name, model: usageModel(profile),
    sessions: run.iterations.length, ...totals,
  };
  try {
    mkdirSync(".sandcastle/logs", { recursive: true });
    appendFileSync(USAGE_LOG, `${JSON.stringify(record)}\n`);
  } catch (e) {
    console.warn(t(`  ⚠ 用量没写进 ${USAGE_LOG}：`, `  ⚠ Usage wasn't written to ${USAGE_LOG}: `) + String(e));
  }
  return record;
}

/**
 * 从 .sandcastle/logs/usage.jsonl 读回这张票的用量记录（可只要某个阶段），按文件顺序即时间顺序。
 * 文件不存在返回空数组；坏行和并发写入时写了一半的末行跳过。
 * Read this ticket's usage records back from .sandcastle/logs/usage.jsonl (optionally for one phase), in file order, i.e. time order.
 * A missing file gives an empty array; broken lines and a half-written last line from concurrent writers are skipped.
 */
export function readUsage(issue: string, phase?: Phase): UsageRecord[] {
  if (!existsSync(USAGE_LOG)) return [];
  let text: string;
  try {
    text = readFileSync(USAGE_LOG, "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.issue !== "string" || typeof r.phase !== "string") continue;
      if (r.issue === issue && (phase === undefined || r.phase === phase)) records.push(r);
    } catch {
      // 半行或损坏的行跳过 / Skip half-written or broken lines
    }
  }
  return records;
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/**
 * PR 正文里的用量表：每次 run 一行，只记 token 数（别家档案的「费用」是按 Claude 单价算的，没有意义）。
 * Usage table in the PR body: one row per run, token counts only (another vendor's "cost" is computed at Claude prices and means nothing).
 */
export function usageTable(records: readonly UsageRecord[], m: Messages = messages()): string {
  if (records.length === 0) return m.usageNone;
  const rows = records.map((r) => `| ${r.run} | ${m.usageProfile(r.profile, r.model)} | ${r.sessions} | ${k(r.input)} | ${k(r.cacheCreation)} | ${k(r.cacheRead)} | ${k(r.output)} | ${k(r.peak)} |`);
  return [m.usageHeader, "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}
