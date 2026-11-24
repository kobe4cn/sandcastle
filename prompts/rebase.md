# TASK

分支 `{{BRANCH}}`（issue #{{TASK_ID}}）要 rebase 到 `{{BASE}}` 上才能合并（或留给人审时不冲突）。`{{BASE}}` 上先合进的票改了相近的地方。

现在的状态：{{SITUATION}}

你的任务只是让本票的改动**原样**落在 `{{BASE}}` 之上，不加功能、不顺手重构。之后编排脚本会自己跑类型检查与完整测试，通过才合并或更新 PR，所以你不用跑完整测试。

# 先看清两边

- `git status`、`git diff --name-only --diff-filter=U` 看冲突文件。
- 本票要做什么：看 issue #{{TASK_ID}} 的验收标准（命令见下面「平台命令」）。
- 对方改了什么：`git log --oneline origin/{{BRANCH}}..{{BASE}}`，按冲突文件看 `git diff origin/{{BRANCH}}...{{BASE}} -- <file>`。不要一次看全部 diff。

# 怎么解决

- **两边都在追加的文件**（目录、索引、登记表、翻译表这类）：两边都保留，按文件原有顺序排好。
- **代码冲突**：读懂两边的意图再合。对方的行为不能被本票改掉；本票的行为也不能丢。
- rebase 进行中时，每解决完一个提交：`git add` 后 `GIT_EDITOR=true git rebase --continue`，直到结束。rebase 结束后才重新生成的东西（比如迁移），单独提交，提交信息末尾 `(#{{TASK_ID}})`。
- 结束前跑类型检查，以及冲突文件对应的测试文件。

本项目的具体规则（优先于上面的通用做法）：

{{P_CONFLICTS}}

## 开发命令

{{P_COMMANDS}}

## 平台命令

{{FORGE}}

# 解决不了时

需要做产品或设计判断（两边对同一行为的要求矛盾），或者你没把握合对：执行 `git rebase --abort`，然后在 issue 上评论哪些文件冲突、两边各要什么、为什么不能自动合。不要硬合。

# 结束

rebase 已经结束（`git status` 不再显示 rebase 进行中）、类型检查通过时，输出 <promise>COMPLETE</promise>。

不要 push、不要合并、不要关 issue。
