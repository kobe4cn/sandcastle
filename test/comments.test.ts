// 代码注释中英对照（scripts/check-comments.mjs）：不合格的注释会列在报错里。
// Code comments must be bilingual (scripts/check-comments.mjs): failing comments are listed in the error.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("注释都是中英对照 / all comments are bilingual", () => {
  const script = fileURLToPath(new URL("../scripts/check-comments.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(r.status, r.stdout).toBe(0);
});
