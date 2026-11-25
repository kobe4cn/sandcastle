// doctor：在 onboard 刚生成的项目上跑，逐项给出结论；--fix 补建缺的标签。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.ts";
import { diagnose, formatChecks, type Runner } from "../src/doctor.ts";
import { githubForge } from "../src/forges/github.ts";
import { installFiles } from "../src/onboard.ts";
import { DEFAULT_LABELS } from "../src/profile.ts";
import { trySh } from "../src/shell.ts";
import { nodeRepo } from "./fixtures.ts";

/** git 本地命令真跑；连远端和 podman 的换成假的。 */
const runner =
  (opts: { image: boolean }): Runner =>
  (cmd, args) => {
    if (cmd === "git" && args.includes("ls-remote")) return { ok: true, out: "abc\trefs/heads/main" };
    if (cmd === "podman") return args[0] === "image" ? { ok: opts.image, out: "" } : { ok: true, out: "arm64" };
    return trySh(cmd, args);
  };

function fakeGh(labels: string[], created: string[][]) {
  return githubForge((args) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return "acme/shop WRITE";
    if (args[0] === "label" && args[1] === "list") return labels.join("\n");
    if (args[0] === "label" && args[1] === "create") {
      created.push(args);
      return "";
    }
    throw new Error(`没料到的 gh ${args.join(" ")}`);
  });
}

const levels = (checks: { name: string; level: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c.level]));

describe("diagnose", () => {
  it("onboard 刚生成：草稿 PROJECT.md 警告，没有 .env、缺标签、没有镜像都不通过；补齐后全过", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    const env = {} as NodeJS.ProcessEnv;
    const created: string[][] = [];

    const first = await diagnose({ cwd: root, env, run: runner({ image: false }), forge: fakeGh(["bug"], created) });
    expect(levels(first)).toEqual({
      仓库: "ok",
      配置: "ok",
      "PROJECT.md": "warn",
      "models.json": "ok",
      ".env": "fail",
      "平台（github）": "ok",
      标签: "fail",
      远端分支: "ok",
      沙箱镜像: "fail",
      "上下文 hook": "ok",
      ".gitignore": "ok",
    });
    const text = formatChecks(first);
    expect(text).toContain("cp .sandcastle/.env.example .sandcastle/.env");
    expect(text).toMatch(/podman build -t \S+ -f \.sandcastle\/Containerfile \.sandcastle/);
    expect(text).toContain("doctor --fix");

    // .env 里只有 GH_TOKEN：缺 Claude 凭据
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\n");
    const second = await diagnose({ cwd: root, env, run: runner({ image: true }), forge: fakeGh(["bug"], created) });
    expect(second.find((c) => c.name === ".env")).toMatchObject({
      level: "fail",
      detail: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"),
    });

    // 值空着、取宿主机环境变量也算；--fix 建好全部标签
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=\n");
    const third = await diagnose({
      cwd: root,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      run: runner({ image: true }),
      forge: fakeGh(["bug", "Sandcastle"], created),
      fix: true,
    });
    expect(third.filter((c) => c.level === "fail")).toEqual([]);
    expect(created.map((a) => a[2])).toEqual(Object.values(DEFAULT_LABELS).filter((l) => l !== "Sandcastle"));
  });

  it(".env 没被 git 忽略直接不通过", async () => {
    const root = nodeRepo();
    installFiles(root, detectProject(root));
    writeFileSync(join(root, ".sandcastle/.gitignore"), "logs/\n");
    writeFileSync(join(root, ".sandcastle/.env"), "GH_TOKEN=x\nCLAUDE_CODE_OAUTH_TOKEN=y\n");
    const checks = await diagnose({ cwd: root, env: {}, run: runner({ image: true }), forge: fakeGh(Object.values(DEFAULT_LABELS), []) });
    expect(checks.find((c) => c.name === ".env")).toMatchObject({ level: "fail", detail: expect.stringContaining("没被 git 忽略") });
  });
});
