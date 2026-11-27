// 启动预检：门槛依赖的服务（gate.services）在宿主机上能不能连上。sandpipe run 启动时和 doctor 都用。
// Startup preflight: whether the services the gate depends on (gate.services) are reachable from the host. Used at sandpipe run startup and by doctor.

import { connect } from "node:net";
import type { GateService } from "./profile.ts";
import { t } from "./term.ts";

/** 探测一个地址：连得上返回 null，连不上返回错误文本。 / Probe one address: null when reachable, the error text otherwise. */
export type Probe = (host: string, port: number) => Promise<string | null>;

/**
 * 连一次 host:port（timeoutMs 内），连上就断开、返回 null；连不上返回错误文本（超时写明毫秒数）。
 * localhost 会同时试 ::1 和 127.0.0.1，都失败时 Node 抛 message 为空的 AggregateError，这时用错误码（比如 ECONNREFUSED）。
 * Connect to host:port once (within timeoutMs): on success disconnect and return null; otherwise return the error text (a timeout names the milliseconds).
 * localhost tries both ::1 and 127.0.0.1; when both fail Node throws an AggregateError with an empty message, so the error code (e.g. ECONNREFUSED) is used instead.
 */
export function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<string | null> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (result: string | null) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(timeoutMs, () => finish(`timed out after ${timeoutMs}ms`));
    socket.once("connect", () => finish(null));
    socket.once("error", (e: NodeJS.ErrnoException) => finish(e.message || e.code || String(e)));
  });
}

export type ServiceFailure = { name: string; addr: string; error: string };

/**
 * 逐个探测，返回连不上的服务（按声明顺序）。
 * Probe each in turn and return the unreachable ones (in declaration order).
 */
export async function checkServices(list: readonly GateService[], probe: Probe): Promise<ServiceFailure[]> {
  const failed: ServiceFailure[] = [];
  for (const s of list) {
    const error = await probe(s.host, s.port);
    if (error !== null) failed.push({ name: s.name, addr: `${s.host}:${s.port}`, error });
  }
  return failed;
}

/**
 * sandpipe run 启动时的检查：有连不上的服务就返回报错文字（列出每一个的名字、host:port 和错误，提示先起服务），都连上或没声明返回 null。
 * The check at sandpipe run startup: when any service is unreachable, return the error text (each one's name, host:port and error, plus a hint to start them); null when all connect or none are declared.
 */
export async function servicesProblem(list: readonly GateService[], probe: Probe): Promise<string | null> {
  const down = await checkServices(list, probe);
  if (down.length === 0) return null;
  return t(
    `门槛依赖的服务连不上：${down.map((s) => `${s.name}（${s.addr}）：${s.error}`).join("；")}。先把服务起来，然后重试（sandpipe doctor 可以检查）`,
    `Services the gate depends on are unreachable: ${down.map((s) => `${s.name} (${s.addr}): ${s.error}`).join("; ")}. Start them first, then retry (sandpipe doctor can check)`,
  );
}
