// 终端输出的语言：命令开头按环境定一个默认值，读到项目配置后改成项目的 language。
// 字符串就地写成中英一对 t("中文", "English")，不进 i18n.ts 的消息表（那里只放写到托管平台上的文字）。
//
// Terminal output language: a default from the environment at startup, switched to the project's `language` once the config is loaded.
// Strings are written in place as pairs t("中文", "English"); they don't go into the i18n.ts catalog (that holds only text written to the forge).

import type { Language } from "./i18n.ts";

/**
 * 环境里的默认语言：SANDPIPE_LANG（zh / en）优先，其次 LC_ALL / LC_MESSAGES / LANG 以 zh 开头的算中文，其余英文。
 * Default language from the environment: SANDPIPE_LANG (zh / en) first, then LC_ALL / LC_MESSAGES / LANG starting with "zh" means Chinese, anything else English.
 */
export function envLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const forced = env.SANDPIPE_LANG?.toLowerCase();
  if (forced === "zh" || forced === "en") return forced;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^zh/i.test(locale) ? "zh" : "en";
}

let current: Language = envLanguage();

/**
 * 读到项目配置后调用：跟随项目语言；设了 SANDPIPE_LANG 时以它为准。
 * Call after loading the project config: follow the project's language, unless SANDPIPE_LANG is set.
 */
export function setTermLanguage(lang: Language | undefined, env: NodeJS.ProcessEnv = process.env) {
  current = env.SANDPIPE_LANG ? envLanguage(env) : (lang ?? current);
}

/** 当前终端语言。 / The current terminal language. */
export const termLanguage = (): Language => current;

/** 按终端语言二选一。 / Pick one of the pair by terminal language. */
export const t = (zh: string, en: string): string => (current === "en" ? en : zh);
