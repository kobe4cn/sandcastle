# TASK

实现 issue #{{TASK_ID}}：{{ISSUE_TITLE}}。只做这一张票。分支 `{{BRANCH}}`。

1. 看票和全部评论（命令见下面「平台命令」）。评论里可能有上一次会话留下的进度——从那里接着做，不要重做。
2. 如果这个分支已经有 PR，先逐条处理里面的 review 意见，包括行内意见。
3. `git log --oneline {{BRANCH}} -n 10` 看这个分支已经提交了什么。

在 issue 上留进度评论时，第一行写这次会话用的模型档案：`echo "$SANDCASTLE_PROFILE"`（为空就不写）。

# 平台命令

{{FORGE}}

# 项目概况

{{P_OVERVIEW}}

# CONTEXT BUDGET

这次会话要在 ~150k token 内完成。

- 上下文到约 100k 时，hook 会提醒你收尾交接：提交能通过测试的部分、在 issue 上留进度评论（已完成 / 未完成 / 下一步的 file:line），然后结束会话、**不输出 COMPLETE**，下一个全新会话会接着做。收到提醒就照做，不要硬撑着做完：压缩后的会话会丢细节，换新会话更可靠。
- 票的 `## Implementation guide` 就是你的探索结果。从它的 `file:line` 出发，`grep -n` 确认行号再改。不要做广泛探索。
- 只整读要改的、300 行以内的文件；长文件用 `grep -n` + `sed -n` 读要改的函数。要了解一个不改的模块，读它的头注释和 `grep -n '^export'`。
- 长输出（构建、成批测试）写进文件再 `grep`，不要整段打印。
- 指引和代码对不上（文件挪了、函数没了）时，**停下**：在 issue 上评论说明，不输出 COMPLETE。
- 要做指引没提到的设计决定时，按下面「设计决定」判断：
  - 可以代拍板：按它做完，照常输出 COMPLETE。
  - 必须停下：提交已经能通过测试的部分，在 issue 上评论要决定什么、有哪几个选项、你的建议，然后输出 `<promise>NEEDS_DECISION</promise>` 结束。脚本会直接把票交给人，不再开新会话。

# EXECUTION

红-绿循环，一次一个验收标准：写一个测试 → 跑红 → 实现 → 跑绿。全部完成后再整理。

# FEEDBACK LOOPS

- 开发中只跑相关的测试文件。**不用跑完整测试**：review 之后编排脚本会自己跑一遍完整测试作为合并门槛，失败时会再叫你修。
- 提交前跑类型检查 / lint（命令见下面「开发命令」）和你改到的、相关的测试文件。
- 不要把 `origin/` 上的主分支合并（`git merge`）或 rebase 进分支：分支里有 merge 提交就合不进去。和主分支的冲突由编排脚本落地前的 rebase 处理。
- **不要一声不响地等超过 5 分钟**：会话 10 分钟没有任何输出就会被编排脚本当作卡死杀掉，已经写好的改动也不会落地。连跑 N 次、加压复现这类长任务，在后台跑并把输出写文件，然后分段查看：每次用 `timeout 240 sh -c 'until grep -q END /tmp/loop.log; do sleep 15; done'; tail -3 /tmp/loop.log` 这样最多等 4 分钟就返回的命令，看一眼进度再接着等。不要用一条前台命令或一次等待挂到长任务结束。
- 票里有 **Browser check**：HTTP / 接口测试通过、提交之后，按下面的「浏览器验收」做。

## 运行环境

{{P_ENVIRONMENT}}

## 开发命令

{{P_COMMANDS}}

## 测试

{{P_TESTING}}

# 浏览器验收（只在票里有 Browser check 时）

{{IF_BROWSER}}沙箱里用 `playwright-cli`（无头 Chromium，`playwright-cli --help` 看命令）。项目怎么准备数据、起服务、登录，见本节后面的「本项目」。

通用做法：

1. `rm -rf .browser-check && mkdir .browser-check`。
2. 按「本项目」准备数据、起 dev server（后台，输出写文件）、登录。
3. 照 Browser check 操作。每个要看的状态截一张：`playwright-cli screenshot --filename=.browser-check/<两位序号>-<说明>.png`，然后**用 Read 看截图**，对照 Browser check 判断。当前模型看不到图片时（Read 图片会被 hook 拦下并说明），用 Agent 工具起 `subagent_type: "screenshot-checker"` 看图：一次一张，prompt 里给截图路径和要核对的点，几张可以在同一条消息里并行起。文案、结构、class 这类文字能核对的，先用 `playwright-cli snapshot` / `eval`。
4. 查错：`playwright-cli console error`，再看 dev server 的日志。
5. 发现问题就修（能用接口测试锁住的补测试），提交后重新截图。
6. 写 `.browser-check/RESULT.md`（中文，会原样进 PR 正文）：Browser check 每一步 ✅/❌/⚠️ 一行，引用对应截图文件名；页面或服务端报错；没能验证的及原因。
7. 收尾：`playwright-cli close`，停掉 dev server。`.browser-check/` 不提交，编排脚本会把它拷出来附到 PR 上。

浏览器验收通过与否都不影响你输出 COMPLETE；改了页面的票只有 `RESULT.md` 每一步都是 ✅ 时才可能自动合并，否则留 PR 由人看截图。

本项目：

{{P_BROWSER}}{{ELSE_BROWSER}}本项目不做沙箱里的浏览器验收。票里有 Browser check 时，把它的每一步写进下面验收说明的「怎么验证」，由人在宿主机上看。{{END_BROWSER}}

# 验收说明

写 `.pr-notes/验收说明.md`（中文，不提交）：写给验收 PR 的人，让他们能在**宿主机**上照着一步步验证这张票。文件里必须有三个 `###` 小标题，**不能出现 `## ` 二级标题**（脚本按它切分 PR 正文的一节，会被切错）：

- `### 做了什么`：1–3 句，从用户或调用方的角度说，不写实现。
- `### 怎么验证`：编号步骤（`1.`），每步写「操作 → 应该看到什么」。每条验收标准至少对应一步，步骤末尾标 `（验收标准 n）`。写法按优先级选：
  1. 页面上能看到变化的，写页面操作{{IF_BROWSER}}，引用 Browser check 的截图文件名作为预期{{ELSE_BROWSER}}{{END_BROWSER}}。
  2. 一条命令能看到变化的（`curl`、脚本、数据库查询），写命令和应该看到的输出。
  3. 用户和调用方都看不到变化的（重构、测试代码、偶发失败修复）：在「做了什么」里写明**无用户可见变化**，这里写跑哪些测试文件、哪些用例证明行为没变。
- `### 最终效果`：做完后系统处于什么状态，以及哪些没变、不在本次范围内。

PR 正文开头的准备段落（切到分支、启动服务等）由脚本加，**不要自己写**；这张票自己要准备的数据写在你的步骤里。宿主机上的验收环境：

{{P_HUMAN_CHECK}}

**每次会话都完整重写这个文件**：人在 PR 上要求修改后开的是新沙箱、新 worktree，上次写的已经没了。文件缺失或格式不对，PR 不会自动合并。

# 设计决定

{{DOC_DECISIONS}}

# COMMIT

提交前按下面「编码规范」自查一遍改动，review 会按它打回。

{{DOC_STANDARDS}}

## 提交信息与登记

{{P_COMMIT}}

提交信息末尾写 `(#{{TASK_ID}})`。

不要 push，不要开 PR，不要合并，不要关 issue——这些由编排脚本来做。

除了本票（issue #{{TASK_ID}}）和本次会话里自己新开的 issue，不要改其他 issue 的标签或正文（评论除外）；本次会话之前开出的票（包括本票早先会话开的）也不能改。

# 结束

- 完成：输出 <promise>COMPLETE</promise>。输出前必须写好 `.pr-notes/验收说明.md`（见上面「验收说明」）。
- 必须由人拍板：见上面 CONTEXT BUDGET 一节，输出 `<promise>NEEDS_DECISION</promise>`。
- 没完成（上下文快满、卡住、指引过时）：提交已经能通过测试的部分，在 issue 上评论「已完成什么 / 还差什么 / 下一步从哪开始」，不输出 COMPLETE。下一次会话会从你的评论接着做。
