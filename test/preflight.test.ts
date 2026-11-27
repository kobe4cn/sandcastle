import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { checkServices, probeTcp, servicesProblem } from "../src/preflight.ts";
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
