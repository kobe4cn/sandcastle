// 给目标项目的 .sandcastle/sandcastle.config.ts 用的公开接口。 / Public API for the target project's .sandcastle/sandcastle.config.ts.
export { defineProject, DEFAULT_LABELS, DEFAULT_TEXTS, defaultTexts, type ProjectProfile, type GateConfig, type IntegrityCheck } from "./profile.ts";
export type { Forge, ForgeIssue, ForgePr, MergeMethod } from "./forge.ts";
export { githubForge } from "./forges/github.ts";
export { sh, trySh, attempt } from "./shell.ts";
