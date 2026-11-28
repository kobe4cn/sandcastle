# main-broken 票开着时其他票不自动合并

## 背景

main 上定期的兜底完整测试失败时，脚本自动开一张带 `sandcastle:main-broken` 的修复票（调度和 prep 时排最前）。在那之前这类票开着期间自动合并照常：别张票照常合进一个已知坏掉的 main，修复票合进来之前每张都在重复「在坏基线上跑门槛、再合一次」，失败了又要再修，人也不知道 main 是坏的。

## 决定

有开着的 `sandcastle:main-broken` 票时，其他票走到自动合并这一步不合并：照常开 PR、过门槛，然后留 PR（`sandcastle:pr-open`），PR 评论和终端写明「main 兜底完整测试失败，等 #n 修好」。细节：

- 检查在合并流程里做（`src/merge-flow.ts`）：等完 PR 检查、直接合并前一次；rebase 补救 force-push 后、重试合并前一次。覆盖「等检查期间才开出 main-broken 票」的情况。
- **只看标签不看作者**：`sandcastle:main-broken` 本身要打标签才挂得上，打标签至少要 triage 权限（ADR 0006），所以不用再按可信作者过滤。外部用户伪造不了。
- **不挡自己人**：main-broken 票本身、它们正文 `## Split into` 列出的子票照常合并；两张 main-broken 票互不挡（所有 main-broken 票及其子票都放行），否则修复票会互相死锁、谁也合不进去。被挡的票写明挡它的是第一张开着的 main-broken 票。
- **列票出错 fail-closed**：查不到开着的 main-broken 票（`listOpenIssues` 报错）时按有票处理，留 PR、评论写明查不到的原因，和 `protectedHits`、`needsReReview` 同一口径。
- 外部 PR 和 `autoMerge: false` 的项目本来就不自动合并，不受影响。

## 考虑过的方案

- **main-broken 开着时暂停整条流水线（不跑新票）**：否决。修复票自己也是票、也要走同一条流水线；暂停会让修复卡住，还浪费本来能开工的空位。留 PR 让修复票尽快合进去、其他票等人一眼，代价更小。
- **把检查放在编排器开工前（不开新票）**：否决。票做完到合并之间 main 可能刚好变坏，开工前查挡不住；而且已经做完的票还是得留 PR，等价于在合并前查。
- **只看修复票的作者是不是机器人**：否决。标签本身就有权限门槛，多一层过滤只会让「人手动开的修复票」挡不住。
- **列票出错时放行（fail-open）**：否决。查不到就合，等于把「main 是坏的」这个信号丢掉，和项目里其他拿不到信息就拦下的关卡不一致。

## 后果

- main 坏掉期间自动合并暂停（只有修复票及其子票例外），PR 会积压等人处理；main-broken 票关掉后，之后走到合并这一步的票恢复自动合并；这期间已经留下的 PR 由「恢复」（下节）自动接回，不再要人手动合。
- 判断逻辑放在已受保护的 `src/merge-flow.ts`（判合并文件），但它依赖未受保护的 `src/guide.ts` 的 `splitChildren` 解析子票：那里解析错了只影响「放行子票」这一侧（多放行或少放行一张子票），不影响 fail-closed 的挡合并本身。

## 恢复

被挡住（含列票出错 fail-closed）而留 PR 的票打 `sandcastle:waiting-main`；main-broken 票都关掉后，调度时自动回到合并流程（#86）：

- **只恢复带 waiting-main 的票**：本机制上线前只带 `sandcastle:pr-open` 的老 PR 仍要人手动合——不知道它们被挡的原因是不是 main-broken，自动合并它们等于凭空放宽「为什么留 PR」这道说明。
- **恢复时强制 rebase 并重跑门槛**：被挡时的门槛是对着坏 main 跑的，不能沿用；rebase 后 agent 解过冲突时照旧再查受保护路径、复审、浏览器验收，不放宽任何关卡。分支已包含最新 main 时（如修复票没合代码就关了）不强制 rebase，照普通合并流程等检查。
- **列票出错时这一轮不恢复**（fail-closed）：和挡住时的判定同口径，查不到开着的 main-broken 票就不动，下一轮再试。
- **票离开「只被 main-broken 挡住」的状态就去掉 waiting-main**：打回（去 pr-open）、带 merging 却没有开着的 PR 交回调度（去 merging）时一并去掉。waiting-main 只能表示「其他关卡都过了、只被 main-broken 挡住」；残留的话，重新实现后因别的原因（reviewer 给 `pr`、受保护路径、浏览器验收没过）留下的 PR 会被误恢复、自动合并。
- 恢复途中又开出新的 main-broken 票时，合并流程里的同一套检查会再次挡住并重新打上 waiting-main。已关闭票上残留的 waiting-main 由 `cleanupClosedIssues` 清掉。
