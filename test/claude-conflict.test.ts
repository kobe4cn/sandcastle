// .claude 下本工具的文件和模板不同时怎么处理：缺失写入、相同不问、不同按选择保留 / 覆盖 / 另存 .new；非 TTY 默认 .new。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { askChoice, type ClaudeChoice, resolveClaudeFile } from "../src/claude-conflict.ts";
import { nodeRepo } from "./fixtures.ts";

const FILE = ".claude/skills/prep-ticket/SKILL.md";
const NEXT = "新版模板\n";

function setup(existing?: string) {
  const root = nodeRepo();
  const path = join(root, FILE);
  if (existing !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, existing);
  }
  return { root, path, newPath: `${path}.new` };
}

const stub = (choice: ClaudeChoice) => vi.fn(async () => choice);

describe("resolveClaudeFile", () => {
  it("缺失：直接写入，不问", async () => {
    const { root, path, newPath } = setup();
    const decide = stub("keep");
    expect(await resolveClaudeFile(root, FILE, NEXT, decide)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe(NEXT);
    expect(existsSync(newPath)).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("内容相同：无需改动，不问", async () => {
    const { root, newPath } = setup(NEXT);
    const decide = stub("overwrite");
    expect(await resolveClaudeFile(root, FILE, NEXT, decide)).toBe("unchanged");
    expect(existsSync(newPath)).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("不同、选保留：原文件不变，不留 .new", async () => {
    const { root, path, newPath } = setup("旧版");
    const decide = stub("keep");
    expect(await resolveClaudeFile(root, FILE, NEXT, decide)).toBe("kept");
    expect(decide).toHaveBeenCalledWith(FILE, path, newPath);
    expect(readFileSync(path, "utf8")).toBe("旧版");
    expect(existsSync(newPath)).toBe(false);
  });

  it("不同、选覆盖：内容是模板，不留 .new", async () => {
    const { root, path, newPath } = setup("旧版");
    expect(await resolveClaudeFile(root, FILE, NEXT, stub("overwrite"))).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(NEXT);
    expect(existsSync(newPath)).toBe(false);
  });

  it("不同、选另存：原文件不变，.new 是模板（旧的 .new 被覆盖）", async () => {
    const { root, path, newPath } = setup("旧版");
    writeFileSync(newPath, "上次留下的 .new");
    expect(await resolveClaudeFile(root, FILE, NEXT, stub("new"))).toBe("saved-new");
    expect(readFileSync(path, "utf8")).toBe("旧版");
    expect(readFileSync(newPath, "utf8")).toBe(NEXT);
  });

  it("decide 看到的 .new 已经写好，可以拿来 diff", async () => {
    const { root } = setup("旧版");
    let seen = "";
    await resolveClaudeFile(root, FILE, NEXT, async (_f, _p, newPath) => {
      seen = readFileSync(newPath, "utf8");
      return "keep";
    });
    expect(seen).toBe(NEXT);
  });
});

describe("askChoice", () => {
  it("非 TTY：打印警告，返回 new", async () => {
    const { path, newPath } = setup("旧版");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      expect(await askChoice(FILE, path, newPath)).toBe("new");
    } finally {
      process.stdin.isTTY = isTTY;
    }
    expect(warn.mock.calls.flat().join("\n")).toContain(`${FILE}.new`);
    warn.mockRestore();
  });
});
