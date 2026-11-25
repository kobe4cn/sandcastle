// .claude/ 下本工具的文件（CLAUDE_FILES）已存在、内容又和模板不同时怎么办：onboard 和 update 共用。
// What to do when one of this tool's .claude/ files (CLAUDE_FILES) exists but differs from the template: shared by onboard and update.
//
// 缺失直接写入；相同什么都不做；不同时先把模板写到 <文件>.new，再问用户保留 / 覆盖 / 留着 .new。
// 非交互（stdin 不是 TTY）时一律留 .new 并警告，让人合并后删掉。
// Missing files are written; identical ones are left alone; for differing ones the template goes to <file>.new first, then the user chooses keep / overwrite / keep the .new.
// Non-interactive (stdin is not a TTY) always keeps the .new and warns, so a person merges it and deletes it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { t } from "./term.ts";

export type ClaudeChoice = "keep" | "overwrite" | "new";

/**
 * 选择怎么处理一个和模板不同的文件；file 是相对项目根的路径，path 和 newPath 是绝对路径（newPath 里已是模板）。
 * Decide how to handle a file that differs from the template; file is relative to the project root, path and newPath are absolute (newPath already holds the template).
 */
export type Decide = (file: string, path: string, newPath: string) => Promise<ClaudeChoice>;

export type ClaudeResolution = "written" | "unchanged" | "kept" | "updated" | "saved-new";

/**
 * path 与 newPath 的 git diff --no-index 输出，在文件所在目录里跑，输出只带文件名；有差异时退出码是 1，所以不用 trySh，直接取 stdout。
 * git diff --no-index output for path vs newPath, run in the file's directory so the output shows bare file names; it exits 1 when files differ, so read stdout directly instead of using trySh.
 */
const gitDiff = (path: string, newPath: string, extra: string[] = []) =>
  spawnSync("git", ["diff", "--no-index", ...extra, basename(path), basename(newPath)], { cwd: dirname(path), encoding: "utf8" }).stdout ?? "";

/**
 * 默认的 Decide：TTY 上显示差异统计并问 k / o / n / d；非 TTY 警告后返回 new。
 * The default Decide: on a TTY show the diff stat and ask k / o / n / d; otherwise warn and return new.
 */
export const askChoice: Decide = async (file, path, newPath) => {
  const saveNew = () => {
    console.warn(
      t(
        `  ⚠ ${file} 和当前模板不同，新版另存为 ${file}.new；合并后删掉 .new`,
        `  ⚠ ${file} differs from the current template; the new version is saved as ${file}.new. Merge it, then delete the .new`,
      ),
    );
    return "new" as const;
  };
  if (!process.stdin.isTTY) return saveNew();
  console.log(t(`\n${file} 和当前模板不同：`, `\n${file} differs from the current template:`));
  console.log(gitDiff(path, newPath, ["--stat"]).trimEnd());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      // 输入结束（Ctrl+D）时 question 会抛错：按非交互处理，留 .new。
      // question throws when input ends (Ctrl+D): treat it as non-interactive and keep the .new.
      const raw = await rl
        .question(t("  [k] 保留 / [o] 覆盖 / [n] 另存为 .new / [d] 看完整 diff：", "  [k] keep / [o] overwrite / [n] save as .new / [d] show full diff: "))
        .catch(() => undefined);
      if (raw === undefined) {
        console.log();
        return saveNew();
      }
      const answer = raw.trim().toLowerCase();
      if (answer === "k") return "keep";
      if (answer === "o") return "overwrite";
      if (answer === "n") return "new";
      if (answer === "d") console.log(gitDiff(path, newPath).trimEnd());
    }
  } finally {
    rl.close();
  }
};

/**
 * 按上面的规则处理一个 CLAUDE_FILES 文件；next 是模板内容（标签已填）。
 * Handle one CLAUDE_FILES file by the rules above; next is the template content (labels filled).
 */
export async function resolveClaudeFile(root: string, file: string, next: string, decide: Decide): Promise<ClaudeResolution> {
  const path = join(root, file);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    return "written";
  }
  if (readFileSync(path, "utf8") === next) return "unchanged";
  const newPath = `${path}.new`;
  writeFileSync(newPath, next);
  const choice = await decide(file, path, newPath);
  if (choice === "keep") {
    rmSync(newPath);
    return "kept";
  }
  if (choice === "overwrite") {
    renameSync(newPath, path);
    return "updated";
  }
  return "saved-new";
}
