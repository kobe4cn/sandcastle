import { describe, expect, it } from "vitest";
import { resumableWaitingMain } from "../src/waiting-main.ts";

/** main-broken 修好后的恢复（#86）：waiting-main 候选里哪些票这一轮可以回到合并流程。 */
describe("resumableWaitingMain", () => {
  const issue = (number: number, body = "") => ({ number, body });

  it("没有开着的 main-broken 票 → 全部可恢复", () => {
    expect(resumableWaitingMain([issue(7), issue(8)], [])).toEqual([7, 8]);
  });

  it("别的 main-broken 票还开着 → 不可恢复", () => {
    expect(resumableWaitingMain([issue(7), issue(8)], [issue(31, "")])).toEqual([]);
  });

  it("本票是开着的 main-broken 票 ## Split into 的子票 → 可恢复，别的票照旧被挡", () => {
    expect(resumableWaitingMain([issue(7), issue(33)], [issue(31, "## Split into\n\n- [ ] #32\n- #33")])).toEqual([33]);
  });
});
