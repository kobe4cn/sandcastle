import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { checkServices, containerStorePath, DEFAULT_MIN_FREE_GB, diskProblems, probeTcp, servicesProblem } from "../src/preflight.ts";
import { setTermLanguage } from "../src/term.ts";

const listen = () =>
  new Promise<{ server: Server; port: number }>((done) => {
    const server = createServer((s) => s.end());
    server.listen(0, "127.0.0.1", () => done({ server, port: (server.address() as { port: number }).port }));
  });
const close = (s: Server) => new Promise<void>((done) => s.close(() => done()));

describe("probeTcp", () => {
  it("连得上返回 null", async () => {
    const { server, port } = await listen();
    try {
      expect(await probeTcp("127.0.0.1", port)).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("server 关掉后再连同一个端口：返回错误文本", async () => {
    const { server, port } = await listen();
    await close(server);
    expect(await probeTcp("127.0.0.1", port)).toMatch(/ECONNREFUSED/);
  });

  it("localhost 连不上（::1 和 127.0.0.1 都拒绝，Node 抛 AggregateError）：错误文本不为空", async () => {
    const { server, port } = await listen();
    await close(server);
    expect(await probeTcp("localhost", port)).toMatch(/ECONNREFUSED/);
  });
});

describe("checkServices", () => {
  it("只返回连不上的服务，带 host:port 和错误", async () => {
    const seen: string[] = [];
    const failed = await checkServices(
      [
        { name: "db", host: "localhost", port: 5432 },
        { name: "redis", host: "127.0.0.1", port: 6379 },
      ],
      async (host, port) => {
        seen.push(`${host}:${port}`);
        return port === 6379 ? "connect ECONNREFUSED" : null;
      },
    );
    expect(seen).toEqual(["localhost:5432", "127.0.0.1:6379"]);
    expect(failed).toEqual([{ name: "redis", addr: "127.0.0.1:6379", error: "connect ECONNREFUSED" }]);
  });

  it("没有声明服务：空数组", async () => {
    expect(await checkServices([], async () => "never")).toEqual([]);
  });
});

describe("servicesProblem（sandpipe run 启动时的报错）", () => {
  const services = [
    { name: "postgres", host: "localhost", port: 5432 },
    { name: "redis", host: "127.0.0.1", port: 6379 },
    { name: "mongo", host: "localhost", port: 27017 },
  ];
  const down = (...ports: number[]) => async (_host: string, port: number) => (ports.includes(port) ? "connect ECONNREFUSED" : null);

  it("都连得上 / 没声明：null（照常启动）", async () => {
    expect(await servicesProblem(services, down())).toBeNull();
    expect(await servicesProblem([], down(5432))).toBeNull();
  });

  it("中文：列出每一个连不上的服务（名字、host:port、错误），提示先把服务起来", async () => {
    setTermLanguage("zh", {});
    expect(await servicesProblem(services, down(5432, 27017))).toBe(
      "门槛依赖的服务连不上：postgres（localhost:5432）：connect ECONNREFUSED；mongo（localhost:27017）：connect ECONNREFUSED。先把服务起来，然后重试（sandpipe doctor 可以检查）",
    );
  });

  it("英文", async () => {
    setTermLanguage("en", {});
    try {
      expect(await servicesProblem(services, down(6379))).toBe(
        "Services the gate depends on are unreachable: redis (127.0.0.1:6379): connect ECONNREFUSED. Start them first, then retry (sandpipe doctor can check)",
      );
    } finally {
      setTermLanguage("zh", {});
    }
  });
});

const GB = 1024 ** 3;

/** 按路径返回剩余字节数的假 statfs（bsize 固定 4096）；值是 Error 就抛，路径不在表里抛 ENOENT。 */
const fakeStatfs = (free: Record<string, number | Error>) =>
  (path: string): { bavail: number; bsize: number } => {
    const v = free[path];
    if (v === undefined) throw new Error(`ENOENT: no such file or directory, statfs '${path}'`);
    if (v instanceof Error) throw v;
    return { bavail: v / 4096, bsize: 4096 };
  };

describe("diskProblems（磁盘剩余空间）", () => {
  it("每个路径一项：够 / 不够 / 量不到，剩余空间是 bavail * bsize", () => {
    const results = diskProblems(["/a", "/b", "/c"], 5 * GB, fakeStatfs({ "/a": 6 * GB, "/b": 4 * GB, "/c": new Error("boom") }));
    expect(results).toEqual([
      { path: "/a", status: "enough", freeBytes: 6 * GB },
      { path: "/b", status: "low", freeBytes: 4 * GB },
      { path: "/c", status: "unknown", error: "boom" },
    ]);
  });

  it("量不到时带上 statfs 错误的那一句", () => {
    const [r] = diskProblems(["/gone"], 5 * GB, fakeStatfs({}));
    expect(r).toEqual({ path: "/gone", status: "unknown", error: expect.stringContaining("ENOENT") });
  });

  it("bavail / bsize 是 bigint 也算得出；剩余正好等于阈值算够", () => {
    const [r] = diskProblems(["/a"], 5 * GB, () => ({ bavail: BigInt((5 * GB) / 4096), bsize: 4096n }));
    expect(r).toEqual({ path: "/a", status: "enough", freeBytes: 5 * GB });
  });

  it("默认阈值是 5 GB", () => {
    expect(DEFAULT_MIN_FREE_GB).toBe(5);
  });
});

describe("containerStorePath（podman 的 GraphRoot）", () => {
  it("podman info 给出路径：记下命令、去掉首尾空白返回", () => {
    const seen: string[][] = [];
    const path = containerStorePath((cmd, args, _timeout?) => (seen.push([cmd, ...args]), { ok: true, out: "/var/lib/containers/storage\n" }));
    expect(path).toBe("/var/lib/containers/storage");
    expect(seen).toEqual([["podman", "info", "--format", "{{.Store.GraphRoot}}"]]);
  });

  it("podman info 失败或输出为空：null", () => {
    expect(containerStorePath(() => ({ ok: false, out: "Cannot connect to Podman" }))).toBeNull();
    expect(containerStorePath(() => ({ ok: true, out: "  \n" }))).toBeNull();
  });
});
