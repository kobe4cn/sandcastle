// 票作者可不可信：机器人、白名单、仓库权限 admin / write；查权限按登录名缓存 1 小时。
import { describe, expect, it } from "vitest";
import { createTrust, needsHold } from "../src/trust.ts";

const user = (login: string) => ({ login, bot: false });

/** 假 permission：按登录名回放，记录调用。 / Fake permission: replays by login and records calls. */
function fake(perms: Record<string, string | Error>) {
  const calls: string[] = [];
  const permission = (login: string) => {
    calls.push(login);
    const p = perms[login];
    if (p instanceof Error) throw p;
    return p ?? "none";
  };
  return { permission, calls };
}

const httpError = (stderr: string) => Object.assign(new Error("Command failed: gh api"), { stderr });

describe("createTrust", () => {
  it("机器人可信，不查权限", () => {
    const { permission, calls } = fake({});
    const trusted = createTrust({ permission, trustedAuthors: [] });
    expect(trusted({ login: "app/sandcastle", bot: true })).toBe(true);
    expect(calls).toEqual([]);
  });

  it("白名单里的可信，不查权限", () => {
    const { permission, calls } = fake({ alice: "read" });
    const trusted = createTrust({ permission, trustedAuthors: ["alice"] });
    expect(trusted(user("alice"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("admin / write 可信，read / none 不可信", () => {
    const { permission } = fake({ a: "admin", w: "write", r: "read", n: "none" });
    const trusted = createTrust({ permission, trustedAuthors: [] });
    expect([user("a"), user("w"), user("r"), user("n")].map(trusted)).toEqual([true, true, false, false]);
  });

  it("查权限 404 算 none", () => {
    const { permission } = fake({ ghost: httpError("gh: Not Found (HTTP 404)") });
    const trusted = createTrust({ permission, trustedAuthors: [] });
    expect(trusted(user("ghost"))).toBe(false);
  });

  it("其他错误照旧抛出，不缓存", () => {
    const { permission, calls } = fake({ bob: httpError("gh: Server Error (HTTP 502)") });
    const trusted = createTrust({ permission, trustedAuthors: [] });
    expect(() => trusted(user("bob"))).toThrow();
    expect(() => trusted(user("bob"))).toThrow();
    expect(calls).toEqual(["bob", "bob"]);
  });

  it("同一个登录名 1 小时内只查一次，过了再查", () => {
    const { permission, calls } = fake({ bob: "write", carol: "read" });
    let now = 0;
    const trusted = createTrust({ permission, trustedAuthors: [], now: () => now });
    trusted(user("bob"));
    trusted(user("carol"));
    now = 60 * 60 * 1000 - 1;
    trusted(user("bob"));
    trusted(user("carol"));
    expect(calls).toEqual(["bob", "carol"]);
    now = 60 * 60 * 1000;
    trusted(user("bob"));
    expect(calls).toEqual(["bob", "carol", "bob"]);
  });
});

describe("needsHold", () => {
  const isTrusted = (a: { login: string }) => a.login === "ok";
  it("作者不可信、又没有 trusted 标签时挡住", () => {
    expect(needsHold({ labels: ["Sandcastle"], author: user("x") }, "sandcastle:trusted", isTrusted)).toBe(true);
  });
  it("作者可信不挡", () => {
    expect(needsHold({ labels: [], author: user("ok") }, "sandcastle:trusted", isTrusted)).toBe(false);
  });
  it("带 trusted 标签时不查作者", () => {
    const check = () => {
      throw new Error("不该查");
    };
    expect(needsHold({ labels: ["sandcastle:trusted"], author: user("x") }, "sandcastle:trusted", check)).toBe(false);
  });
});
