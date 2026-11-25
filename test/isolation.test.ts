// isolation 辅助函数：读宿主机 env 文件（临时目录）、换宿主机地址、加库名后缀、跑回收脚本。
// Isolation helpers: reading host env files (temp directory), swapping the host address, suffixing db names, running cleanup scripts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTAINER_HOST, readHostEnv, runHostScript, toContainerHost, withDbSuffix } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "isolation-"));

describe("readHostEnv", () => {
  it("按顺序读多个文件并合并，后面的覆盖前面的", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "A=1\nB=from-env\n");
    writeFileSync(join(root, ".env.test"), "B=from-test\nC=3\n");
    expect(readHostEnv([".env", ".env.test"], root)).toEqual({ A: "1", B: "from-test", C: "3" });
  });

  it("单个文件名也可以", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "A=1\n");
    expect(readHostEnv(".env", root)).toEqual({ A: "1" });
  });

  it("文件不存在时跳过，不抛错", () => {
    const root = tmp();
    expect(readHostEnv([".env", ".env.test"], root)).toEqual({});
    writeFileSync(join(root, ".env.test"), "C=3\n");
    expect(readHostEnv([".env", ".env.test"], root)).toEqual({ C: "3" });
  });

  it("默认按当前目录算相对路径", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "A=cwd\n");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(readHostEnv(".env")).toEqual({ A: "cwd" });
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("toContainerHost", () => {
  it("把 localhost 和 127.0.0.1 换成容器访问宿主机的地址", () => {
    expect(CONTAINER_HOST).toBe("host.containers.internal");
    expect(toContainerHost("postgres://u:p@localhost:5432/db")).toBe("postgres://u:p@host.containers.internal:5432/db");
    expect(toContainerHost("http://127.0.0.1:8333")).toBe("http://host.containers.internal:8333");
  });

  it("其他主机不动", () => {
    expect(toContainerHost("postgres://db.example.com/x")).toBe("postgres://db.example.com/x");
  });
});

describe("withDbSuffix", () => {
  it("postgres URL 的库名加后缀", () => {
    expect(withDbSuffix("postgres://crm:crm@localhost:5432/crm_test", "_i12")).toBe("postgres://crm:crm@localhost:5432/crm_test_i12");
  });

  it("mongodb URL 保留 query", () => {
    expect(withDbSuffix("mongodb://u:p@localhost:27017/crm_test?authSource=admin", "_i12")).toBe(
      "mongodb://u:p@localhost:27017/crm_test_i12?authSource=admin",
    );
  });

  it("不是 URL 的值直接拼接", () => {
    expect(withDbSuffix("crm_test", "_i12")).toBe("crm_test_i12");
    expect(withDbSuffix("/tmp/lake", "_i12")).toBe("/tmp/lake_i12");
  });

  it("s3 前缀加后缀，结尾的 / 保留", () => {
    expect(withDbSuffix("s3://bucket/prefix", "_i12")).toBe("s3://bucket/prefix_i12");
    expect(withDbSuffix("s3://bucket/prefix/", "_i12")).toBe("s3://bucket/prefix_i12/");
  });

  it("没有库名的 URL 抛错，不静默返回原值；报错里遮掉密码", () => {
    expect(() => withDbSuffix("postgres://u:p@localhost:5432", "_i12")).toThrow(/postgres:\/\/u:\*\*\*@localhost:5432/);
    expect(() => withDbSuffix("mongodb://localhost:27017/?authSource=admin", "_i12")).toThrow();
  });
});

describe("runHostScript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功时返回 stdout", async () => {
    expect(await runHostScript(process.execPath, ["-e", "console.log('ok')"], "回收")).toBe("ok\n");
  });

  it("失败时警告一行并返回 undefined，不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runHostScript(process.execPath, ["-e", "console.error('boom'); process.exit(1)"], "#7 回收失败");
    expect(r).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("#7 回收失败");
    expect(warn.mock.calls[0][0]).toContain("boom");
  });

  it("命令不存在时也不抛错", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runHostScript("definitely-not-a-command-xyz", [], "x")).toBeUndefined();
  });
});
