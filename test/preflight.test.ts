import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { checkServices, probeTcp } from "../src/preflight.ts";

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
