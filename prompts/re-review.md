# TASK

分支 `{{BRANCH}}`（issue #{{TASK_ID}}）已经评审通过，之后又经过一步改动（`{{KIND}}`：`fix` 是门槛失败后修门槛，`rebase` 是 rebase 解冲突），改动后门槛已重新跑过并通过。你要复审的**只是这一步带来的改动**（`fix` 是新加的提交，`rebase` 是 rebase 前后的差别），判断它能不能直接合并。

只评，不改代码、不提交。

# CONTEXT

## 要复审的改动

运行下面的命令看这一步带来的改动（**不要**看整个分支相对主干的 diff，之前的改动已经评审过）：

```
{{DIFF_CMD}}
```

diff 很大时先 `--stat` 看概况，再按文件看。

`rebase` 时上面是 `git range-diff`：对比 rebase 前后分支上的每个提交，只看 rebase 带来的变化（解冲突时改了什么）。重点看解冲突时有没有丢掉或改动测试、丢掉本分支的改动。

## 平台命令

{{FORGE}}

## 项目概况

{{P_OVERVIEW}}

## 开发命令

{{P_COMMANDS}}

# 检查什么

**验收标准**：看票（issue #{{TASK_ID}}），逐条对照验收标准：这一步的改动有没有让某条不再成立、或者让它的测试不再真正覆盖它。

**有没有靠改测试过门槛**（重点）：

- 删除测试文件、删除测试用例。
- 跳过测试：`.skip`、`.only`（让别的用例不跑）、`.todo`、`xit` / `xdescribe`、`skipIf` 之类的条件跳过、注释掉用例。
- 放宽断言：删断言；`toEqual` / `toBe` 换成 `toBeTruthy` / `toBeDefined`；精确值换成 `expect.anything()` / `toMatch(/.*/)`；加大容差或超时；把期望值改成当前（错误的）输出；`try … catch` 吞掉异常让用例不失败。
- 改门槛本身：改测试配置排除文件、改类型检查配置放宽规则、加 `@ts-ignore` / `@ts-expect-error` / `any` 绕过类型错误。

确实是测试本身写错、改它有充分理由的（比如被测行为按票的要求就该变），在摘要里说明理由，不算问题。

**Standards**：

{{DOC_STANDARDS}}

# OUTPUT

先给结论，二选一：

- `<verdict>merge</verdict>`：这一步的改动没有上面的问题，验收标准仍然都成立、都有测试覆盖。
- `<verdict>pr</verdict>`：其余情况（有问题，或拿不准），留 PR 给人审。

然后输出给 PR 用的摘要（简短）：

<review-summary>
**改了什么**：这一步改动做了什么，一两句
**验收标准**：每条 ✅/❌ 一行
**测试**：有没有删除 / 跳过测试、放宽断言（有的写出文件和位置）
**问题**：…（没有就写「无」）
</review-summary>

然后输出 <promise>COMPLETE</promise>。
