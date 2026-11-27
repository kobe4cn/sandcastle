# 浏览器验收之后改了页面，截图作废

## 背景

浏览器验收在 implement 会话里做，产物是 worktree 里的 `.browser-check/`。之后 revise、门槛失败后的 fix、rebase 补救里的解冲突 agent 都可能再改页面代码，却不会重新验收；land 时 `collectBrowserCheck` 拿到的还是旧截图，对应的不是最终代码（#58）。

## 决定

- **由编排器记录验收提交**：implement 循环结束、review 之前，worktree 里有 `.browser-check/` 就记下沙箱 HEAD（`Reviewed.browserAt`）。不让 agent 写进 `RESULT.md`：agent 验收完可能还会再提交，而且 `.browser-check/` 被 gitignore，不进历史。
- **land 用两点 diff**：revise 和 fix 在同一个沙箱里只往后追加提交，`git diff --name-only <browserAt> HEAD` 就是验收之后的改动；命中 `browser.pagePaths` 就是截图过期，作为浏览器验收的一个问题留 PR。只在有 `.browser-check/` 时判断（没有时本来就报「没做浏览器验收」）。
- **rebase 只看冲突文件和新出现的文件**：rebase 之后 sha 全变，`<browserAt>..HEAD` 会混进 main 的改动。照受保护路径（#76）的做法，取「冲突文件 ∪（rebase 后 diff − rebase 前 diff）」，命中页面就不 push、留 PR。只在起过解冲突 agent 时查；干净 rebase 不查。rebase 开的是新沙箱，里面没有 `.browser-check/`，所以条件是「配了 `browser.pagePaths` 且 PROJECT.md 有浏览器验收」，不看这个目录。
- **取不到就当过期（fail-closed）**：没有 `browserAt`（恢复路径、取 HEAD 失败）或 diff 取不到时按过期处理，先例是 ADR 0003、`fixHeadUnknown` 和 `reReviewNoRange`。
- **只留 PR，不重新验收**：先保证不把过期截图当成通过；自动重做浏览器验收留作后续。

## 考虑过的方案

- **让 agent 把验收时的提交写进 RESULT.md**：否决，理由见上。
- **rebase 也用 `<browserAt>..HEAD`**：否决，会把 main 上的页面改动算进来，几乎每次 rebase 都会挡。
- **过期时自动重做浏览器验收**：暂缓。要再起一次会话、起 dev server，成本和失败面都大，先留 PR 让人看。

## 后果

- 评审打回或 fix 改了页面的票不再自动合并，需要人重新验收；恢复路径上改了页面的票也会留 PR。
- rebase 补救里解冲突改到页面的票不 push，PR 保持 rebase 前的样子，由人处理。
