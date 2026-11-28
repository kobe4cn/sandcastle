# Sandcastle：无人值守地实现 issue

`npm run run:sandcastle` 跑 `.sandcastle/main.ts`：每张票 prep → plan → implement + review → 门槛 → 合并。能合并的直接 rebase 合并进 `main`；不能合并的留 PR 给人审。

脚本不分轮，按空位调度：最多 `MAX_PARALLEL`（2）张票同时在做，一张票从开工到落地完一直占着一个空位。有空位时做一次调度（整理 → prep → plan），把空位补满；每张票独立跑完 build 和落地，做完马上让出空位，再调度一次，不等同批的另一张。有空位但开不了工时，每 `POLL_INTERVAL_MS`（10 分钟）重新调度一次，所以人合并了 PR、blocker 关了、去掉了 stuck，最晚 10 分钟后就能开工，不用等正在做的票做完。没有票在做、也开不出新票算一次空转，连续 `MAX_ITERATIONS`（12）次空转（约 2 小时）就结束运行；`maxIdlePolls` 配 `Infinity` 时为一直运行模式，不空闲退出（空转进度只写次数、不带分母），供 systemd / launchd 守护下长跑——停服务发的 SIGTERM 走 Ctrl-C 同一路径收尾（打提示、exit 事件里释放运行锁），退出码 143（#154）。结束时如果这次运行一张票都没开工，不打印「全部完成」，改为打印空转原因：列出最后一次调度里被 blocker 挡住的票（`#n 等 #m、#k`），没有被挡的票时说明没有可开工的票（没有带 `Sandcastle` 标签、还没开工的票，或者都在等人审 PR / 带 `sandcastle:stuck`）。调度和落地都在宿主机上动 git 与标签，两者串行（`withHost`）；build 在沙箱里并行。落地里的 rebase 补救（开沙箱、rebase、重跑门槛）会先放开宿主机锁，push 与合并前再拿回，跑门槛的半小时里调度照常给另一个空位开新票（2026-11-24）。自动合并前等 PR 上的 forge 检查时也放开宿主机锁，而且这张票不算空位：它仍在 `running` 里（不会被重新开工，改的文件照样占着），调度可以趁这时开新票（#28）。

## 标签状态机

人只需要做两件事：给要做的票打 `Sandcastle`，以及处理带 `sandcastle:pr-open` / `sandcastle:stuck` 的票。带 `sandcastle:decided` 的票不阻塞运行，有空时事后确认即可。其余标签由脚本和 agent 维护。

| 状态 | 标签 | 谁设置 | 下一步 |
|---|---|---|---|
| 选中 | `Sandcastle` + `ready-for-agent` | 人 | 下次调度 prep |
| 已准备 | + `sandcastle:prepped` | prep agent（指引新鲜、≤3 条验收标准、blocker 都已关闭） | plan 选中后实现 |
| 已拆分 | 父票去掉 `Sandcastle`；子票带 `Sandcastle` + `ready-for-agent` | prep agent | 子票马上各自 prep；子票全关后，脚本在下次调度开头勾上 `## Split into` 清单并关掉父票（子票只认列表项开头的票号） |
| 评审已过 | + `sandcastle:reviewed`，issue 上留 `<!-- sandcastle:reviewed@<sha> -->` 评论（末尾 JSON 存 summary、修改轮次、browser-check、评审逐条的 browser-verdict；旧评论没有 browser-verdict 时按缺失，门槛挡下） | 脚本（review 给出 merge 后、跑门槛前；落地开头不论成败都去掉标签） | 进程中断重启后票照常被 plan 选中；build 里 worktree HEAD 还是这个 sha 就打「接着上次：#n 评审已过，直接跑门槛」，跳过 implement / review，PR 用量表和预算取 `usage.jsonl` 里的 implement / review / revise 记录；HEAD 变了就去掉标签正常重做（#49） |
| 已合并 | issue 关闭（PR 正文 `Closes #n`） | 脚本 | 依赖它的票下次调度开工 |
| 等人审 | + `sandcastle:pr-open` | 脚本（没能自动合并时，含 forge 检查失败或超时） | 人审 PR：没问题就合并（issue 自动关闭）；要改就在 PR 上发 `/sandcastle` 开头的评论或 review |
| 等 main 修好 | + `sandcastle:waiting-main`（同时带 `sandcastle:pr-open`） | 脚本（被开着的 main-broken 票挡住留 PR 时，含查不到票的 fail-closed） | main-broken 票都关掉后，下次调度自动回到合并流程：强制 rebase、重跑门槛、等检查后合并（ADR 0007「恢复」） |
| 打回 | 去掉 `sandcastle:pr-open`，一并去掉 `sandcastle:waiting-main` | 脚本（每次调度开头看到打回信号时） | 这次调度重新 plan，implementer 在原分支上先处理 PR 意见 |
| 退回重新准备 | 去掉 `sandcastle:prepped`，issue 上留 `<!-- sandcastle:reprep -->` 评论 | 脚本（implementer 第一次用完会话没做完时） | 下次调度 prep 按进度：指引不对就重写；票太大就把没完成的验收标准拆成子票（被本票 block），本票只留已完成的部分，在原分支上收尾合并 |
| 需要人 | + `sandcastle:stuck`（评论里写原因） | 脚本（重新准备后仍没做完、沙箱出错、implementer 输出 `NEEDS_DECISION`、Blocked by 引用的票不存在）或 agent（含 prep 缺意图信息：评论写明缺什么、写进哪份文档，提示 `/fill-project-docs`） | 人处理后去掉 `sandcastle:stuck`；带 `ready-for-human` 的（prep 打的、implementer 输出 `NEEDS_DECISION` 的）一并去掉 |
| 代拍板 | + `sandcastle:decided`（票仍照常合并或留 PR） | 脚本（落地时 issue 上有 `<!-- sandcastle:decided -->` 开头的评论） | 人看 PR 上的「代拍板」评论：同意就去掉标签；不同意在 issue 上回复，另开票改 |

## 设计决定：代拍板还是停下

prep、implementer、reviewer 遇到票和指引都没写到的设计决定、或票里写了待决定项但没写明选了哪个时，按 `.sandcastle/DECISIONS.md` 分两类处理。票正文列了待决定的选项、正文和人的评论（不以 `<!-- sandcastle:decided -->` 开头的）里又没有人的决定时，按必须停下处理：`ready-for-agent` 标签只说明可以排期，不算决定；碰到「必须停下」（含修订 ADR）的，不管票带什么标签都交给人。reviewer 看到 decided 评论选的正是票正文的待决定项、或内容碰了「必须停下」时，写进「需要人判断」，票留 PR（#18）。

- **必须停下**：要改 ADR 的方向、改公共接口语义或数据库 schema、涉及权限和敏感字段、删改用户数据、选项都难以撤回或给不出推荐。prep 打 `sandcastle:stuck` + `ready-for-human`；implementer 提交已完成的部分、评论选项后输出 `<promise>NEEDS_DECISION</promise>`，脚本推上分支、直接打 stuck，不再开新会话，也不退回 prep。
- **可以代拍板**：收窄范围（没做到的部分记进 `KNOWN_GAPS`、另开后续票）或可以撤回的局部取舍。agent 按推荐做，在 issue 上留 `<!-- sandcastle:decided -->` 开头的评论，写清选项和理由，照常做完。落地时脚本给票打 `sandcastle:decided`，把这些评论贴到 PR 上。reviewer 会核对代拍板属于这一类，不属于的写进「需要人判断」，留 PR。

找所有待确认的代拍板：`gh issue list --state all --label sandcastle:decided`。

## reviewer 打回（revise）

reviewer 的结论有三种：`merge`、`revise`、`pr`（规则在 `prompts/review.md`）。

- `revise`：有要改行为、但正确做法明确的问题，比如漏了验收标准或测试、测试缺断言、重复已有 helper、术语不对。改动**新引入**的 fail-open（本该留给人审、或本该被关卡拦下的 PR / 票会因为这次改动被自动合并、绕过关卡）一律 `revise`，实现指引或票说「本票不处理」、按设计决定收窄范围推迟到后续票也不放过，`<revise>` 里写怎么改成 fail-closed；改动之前就存在的 fail-open 交给人（写进「需要人判断」）。reviewer 在 `<revise>` 里逐条写位置、改法和验证方式。脚本把这些意见交给一个新的 implementer 会话，改完后再审一次。最多打回 `REVISE_MAX = 2` 次。
- 两次之后仍是 `revise`，就留 PR 给人审。PR 正文的 Review 一节会附上每次的意见。
- 要人判断的问题会决定怎么改时，reviewer 直接给 `pr`，不打回。
- review 只验本票：验收标准涉及别的 issue 时（开新票、给别的票加评论或标签），只核对本票确实做过这件事，不拿那张票当前的标签和状态去比对指引——对不上视为人后来改过。review / revise / fix / implement 会话不改本票和本次会话里自己新开的 issue 以外任何 issue 的标签或正文（评论除外）；本次会话之前开出的票也不能改。

## 什么时候自动合并

全部满足才合并（`gh pr merge --rebase`），否则留 PR 并在 PR 上评论原因：

1. reviewer 给出 `<verdict>merge</verdict>`：验收标准都实现且有测试、没有要人判断的问题、改了页面的浏览器验收每步都通过（见「浏览器验收」）、没动权限 / 敏感字段处理、没有改已有数据或删改列的迁移、票里没要求人亲自验收、没改弱已有测试（新增 / 修改 ADR 和代拍板本身不再拦合并，2026-11-24；前提是改 ADR 是票正文或人明确要求的，agent 自己决定修订 ADR 属于「必须停下」）（规则在 `prompts/review.md`）。
2. 门槛通过：脚本在沙箱里自己跑 `npm run typecheck` 与完整测试。
   - 门槛同一时间只跑一个，不分档位（`runGate` 排队，票优先、main 兜底让位，`src/gate-queue.ts`）：两个沙箱同时跑时 CPU 和 PG 被挤满，2026-11-24 实测完整门槛同时跑要 76.6 分钟（失败）、精简门槛 37.7 分钟，比先后跑（约 33 + 21 分钟）还慢。排上队的门槛用 8 个 worker（`GATE_WORKERS`），宿主机 PG 要 `max_connections` ≥ 600（`db_script/pg_setup.sh`）；agent 自己在沙箱里跑单个测试文件不排队，仍是 4 个 worker。门槛用时（和排队时间）打进日志，并在 PR 的 **Gate** 一节末尾写一行 `GATE_TIME`。门槛开始时打印日志路径，输出逐行实时写进 `.sandcastle/logs/gate-<票号>-<时间戳>.log`（每次重跑另开新文件），运行中每 5 分钟打印一次心跳（`src/gate-progress.ts`）；终端不逐行打印门槛输出，免得多个沙箱的输出混在一起。档位、`GATE_FLAKY`、`GATE_TIME` 看的是自己累积的完整输出，不是沙箱传了 `onLine` 后只剩末尾 64KB 的 stdout。
   - 顺序：typecheck → `test/` 根目录的单元测试（约 1–2 分钟）→ `test/http` 与 `test/pipeline`。单元测试失败就直接判门槛失败，不再等后面的测试；i18n 棘轮这类几秒就能报的失败，以前要等 40 分钟的完整测试跑完才看到（2026-11-24 #1172、#1182）。implementer 提交前也要跑 `npm run i18n:ratchet`（`implement-prompt.md`）。
   - 按依赖选测试，规则见下面「合并门槛怎么选测试」。门槛输出里有一行 `GATE_TIER: selected|full`，PR 的 **Gate** 一节写明跑的是哪一档。
   - 单元测试或后面一段测试失败、且这一段失败的文件不超过 3 个时，先把这几个文件单独重跑一次：重跑通过算通过，PR 的 **Gate** 一节标出「偶发失败」和第一次的失败摘要。报错只是超时或连不上（负载、并发抢 PG 的症状，或摘要里没有报错）、且同一文件 7 天内第一次出现的，只记进 `.sandcastle/logs/flaky.json`、在 PR 上评论一句，不开票；7 天内第二次出现、或报错是断言失败这类，才开票（规则在 `guide.ts` 的 `flakyTriage`，2026-11-24：过去的偶发失败票七成是环境原因，单次抖动就开票会把真 bug 淹掉）。同一报错签名的文件共用一张票，标题是 `偶发失败：<文件>`，带 `flaky`、`Sandcastle`、`ready-for-agent` 标签，正文附失败摘要、开票时同时在做的票与宿主机负载、7 天内之前的出现、复现方法和验收标准；下次调度会自动 prep 并修：prep 先查同样的报错是否已被别的提交修掉，修掉了就只核实、不改代码；没修掉要给出修复前变红、修复后变绿的复现（跨沙箱竞争写并发用例），重复单跑总共不超过 20 分钟。已经有同名的 open 票时，就在那张票上追加一次出现记录。票号会评论到 PR 上。重跑仍失败、或失败文件更多，才算门槛失败。
   - 门槛失败时让 implementer 用新会话修一次，再跑一次门槛。
   - reviewer 给了 `merge`、fix 会话有新提交（fix 前后 HEAD 不同）且门槛重跑通过时，合并前再起一次复审会话（阶段 `re-review`，run 名 `re-review-<票号>-fix`，提示词 `prompts/re-review.md`），只看 fix 前 HEAD 之后的提交：对照验收标准，重点查删测试、跳过测试（skip / only / todo）、放宽断言。复审只给 `merge` / `pr`，不进 revise 循环（再改又要再审，没有尽头）；不是 `merge`（含没输出结论）就留 PR，评论写「fix 之后的复审没通过」和复审摘要。复审用量进 `usage.jsonl` 和 PR 的 Usage 表。没跑 fix、或 fix 没有新提交时不复审（#70，`src/re-review.ts`）。fix 前或 fix 后的 HEAD 取不到时不复审，也不自动合并：留 PR，评论写明「取不到 fix 前后的 HEAD，没法确定 fix 改了什么，未复审」，终端打一行 ⚠（#73）。复审只评不改：复审会话前后各取一次沙箱 HEAD，前后不同（复审会话自己提交了改动）或取不到时按不通过处理，不看它给的结论，评论写「复审会话提交了改动」并附复审前后的 HEAD（#72）。
   - 失败摘要只取 vitest 的 Failed Tests / Failed Suites 一节。
3. GitHub 能 rebase 合并，且本票的 drizzle 迁移接在 `origin/main` 最新的迁移后面（两张票各加一个迁移时没有文本冲突，但迁移链会分叉，所以合并前脚本先查）。

   不满足时脚本自动补救一次：在原分支上开沙箱 `git rebase origin/main`；有冲突或迁移链分叉就开一次 agent 会话按 `.sandcastle/rebase-prompt.md` 处理（追加型文件两边都留，迁移删掉重新 `db:generate`，要做判断的放弃并在 issue 上评论）；然后**重跑门槛**（和开工时同一套选测试规则，按分支相对新 main 的改动选，冲突文件已在其中），通过才 force-push 再合并。起过解冲突 agent（有冲突或迁移链分叉）时，门槛通过后、push 前还要复审：起一次复审会话（阶段 `re-review`，run 名 `re-review-<票号>-rebase`，提示词 `prompts/re-review.md`），只看 rebase 前后的 `git range-diff <旧 base>..<旧 HEAD> origin/main..HEAD`，重点查解冲突时丢掉 / 改动的测试；不是 `merge`（含没输出结论）就不 push、不合并，留 PR，评论写「rebase 解冲突之后的复审没通过」、复审摘要和这次复审的用量表；取不到 rebase 前的分支范围时不起会话，直接按不通过处理。复审用量进 `usage.jsonl`，不改 PR 正文。干净 rebase（没起 agent）和只 typecheck 留给人审的 rebase 不复审（#71）。复审前后 HEAD 不同或取不到时同样按不通过处理、不 push（#72）。补救不成就留 PR 并写原因。

   reviewer 不给 `merge`、但门槛通过、要留 PR 给人审的票，也先查一次：和最新的 `origin/main` 有文本冲突或迁移链分叉（开工后 main 上合进了改同一处的票）时，同样 rebase、处理冲突，但只跑 typecheck、不重跑测试（省一遍门槛，也不占门槛的队列；2026-11-24），force-push 后不合并，PR 上评论冲突文件并写明 Gate 里的测试结果是 rebase 之前的，由人合并前判断是否补跑。这样人审到的 PR 能直接合并。补救不成就在「没有自动合并」的评论里写上原因。

4. 验收说明齐全：implementer 写了 `.pr-notes/验收说明.md` 且格式对（三个小标题、「怎么验证」有编号步骤，检查在 `.sandcastle/pr-body.ts` 的 `checkAcceptanceNotes`）。缺失或格式不对时正文写警告、留 PR（见「验收说明」）。

5. PR 上的 forge 检查（CI）通过（[ADR 0002](../adr/0002-merge-requires-forge-checks.md)）：以上都满足、`autoMerge: true` 时，合并前按 `mergeRequires` 等检查（默认 `checks: "all"`、最多 30 分钟，`"required"` 只看必需检查）。有失败或超时留 PR（`sandcastle:pr-open`），评论列出检查名和链接；PR 上没有检查不阻塞（空列表宽限 60 秒后当作没有 CI）；空列表时先看 PR 是否和 main 冲突（forge 的 `prMergeable`，GitHub 对有冲突的 PR 不跑 CI），连续两轮（约 30 秒）都冲突就不再等、也不试合并（只看一次可能读到 force-push 前的旧状态），终端打「有冲突，先 rebase」后直接走 rebase 补救，不当作没有 CI。rebase 补救 force-push 后要重新等检查再合。`checks: "none"` 时只看门槛，给 CI 不可靠的项目用。forge 没实现 `prChecks` 时每次运行在终端警告一次、按没有检查合并。

6. 没有开着的 `sandcastle:main-broken` 票（[ADR 0007](../adr/0007-main-broken-holds-merge.md)）：等完 PR 检查、直接合并前查一次，rebase 补救 force-push 后、重试合并前再查一次（等检查期间才开出的修复票也挡得住）。有票开着时留 PR（`sandcastle:pr-open`），评论和终端写「main 兜底测试失败，等 #n 修好」；修复票本身、它 `## Split into` 的子票、别的 main-broken 票不挡。查不到开着的修复票（`listOpenIssues` 报错）也留 PR（fail-closed）。外部 PR 和 `autoMerge: false` 本来就不自动合并，不查。被挡住（含 fail-closed）而留 PR 的票同时打 `sandcastle:waiting-main`；main-broken 票都关掉后，下次调度开头自动恢复（`resumeWaitingMain`）：打 `sandcastle:merging`、去 `pr-open`，终端写「main 修好了，#n rebase 后重跑门槛」，然后强制 rebase 到最新 main、重跑门槛、等检查再合并——被挡时的门槛是对着坏 main 跑的，必须重跑，不放宽任何关卡（rebase 解冲突照旧复审、查受保护路径）。`waiting-main` 不在恢复一开始就去（#119），留到结果出来再按结果处理：合并了、因别的原因留 PR（受保护路径、复审、浏览器验收、检查失败）、`autoMerge: false` 留 PR 时去掉（`removeWaitingMainAfterResume`）；恢复途中又开出新的 main-broken 票时，上面的同一套检查会再挡住并重新打上 waiting-main，保留到下一轮恢复；恢复中途抛错时去掉（`mergeWhenReady` 的 finally 已去掉 merging、票已离开被挡状态，start 的兜底打 stuck 后下一轮也捡不到它，保留只会让人去掉 stuck 重新实现后被 `resumeWaitingMain` 误自动合并）；被 kill（finally 没跑、merging 还在）时保留，下一轮这张票仍带 waiting-main、仍按「main 修好后的恢复」走强制 rebase 重跑门槛，不退化成普通的中断恢复。分支已包含最新 main 时（如修复票没合代码就关了）不强制 rebase，照普通流程等检查（强行走 rebase 会按 `rebaseNotBehind` 被当成合并失败）。查 main-broken 票出错时这一轮不恢复（fail-closed，和挡住时同口径）。已关闭票上残留的 waiting-main 在调度开头清掉。

   以上都满足但 `gh pr merge` 被仓库的分支保护挡住（报错含 `base branch policy prohibits the merge`、`required status check`、`approving review` / `review is required`、`protected branch`，`isBranchProtectionError`）时，不走 rebase 补救（rebase 解决不了审批和必需检查，只会白跑一遍门槛），直接留 PR（`sandcastle:pr-open`），评论写明是分支保护挡住的并附 gh 报错，由人合并或调整分支保护 / `mergeRequires`；rebase 补救里的合并重试碰到这类报错也立刻停（#29）。只看报错文本，不查保护规则（那要 admin 权限）。

### 合并门槛怎么选测试（2026-11-24）

代码在 `.sandcastle/main.ts` 的 `GATE_SELECT`。改动范围是分支相对它和 `origin/main` 分叉点的 diff。

- **每次都跑**：`test/http` 全部、`test/` 根目录的单元测试。`test/http/harness.ts` 另起 vite、用 `ssrLoadModule` 加载整个应用，vitest 的依赖图看不到它和 `app/` 的关系（改 `workbench-ai.ts` 选不到 `test/http/workbench.test.ts`），所以不靠依赖图选。
- **`test/pipeline` 按依赖图选**：`vitest related <改到的文件>` 选中的文件，加上分支改到的 pipeline 测试文件本身。
- **退回完整测试**（`GATE_TIER: full`，输出里写原因）：
  - 改到 `FULL_PATHS`：依赖图看不到的测试基础设施，`vitest.config.ts`、`vite.config.ts`、`test/global-setup.ts`、`test/setup-env.ts`、`test/http/harness.ts`、`drizzle/`、`package.json`、`pnpm-lock.yaml`、`.sandcastle/Containerfile`。发现新的盲区就加进这份名单。
  - 选中的 pipeline 文件超过总数一半：改 `llm.ts`、`schema.ts`、`audit.ts`、`model-draft.ts` 这类核心模块时依赖图几乎全选（80 多个），挑着跑省不了多少。
  - `vitest related` 失败或超时（300 秒）；`GATE_FULL=1`。
- **兜底**：按依赖选测试的票每合并 4 张（`MAIN_CHECK_EVERY`），脚本在后台对当时的 `origin/main` 跑一次完整测试（`runMainFullCheck`，排在票的门槛后面，有票在等就让位；已开跑的不中断，测试资源后缀 `_imain`）。兜住依赖图漏选，和两张票各自通过、合在一起才坏的情况。计数和上次通过的提交存在 `.sandcastle/logs/main-check.json`，重启后接着算。失败时开一张 `sandcastle:main-broken` + `Sandcastle` + `ready-for-agent` 的修复票，正文列出失败摘要和上次通过以来进 main 的提交；调度和 prep 时这类票排最前。修复票（及其 `## Split into` 的子票）照常合并，其他票不自动合并、留 PR 等修好（ADR 0007；修好后带 `sandcastle:waiting-main` 的票自动恢复合并，见「什么时候自动合并」第 6 条）。已有 open 的修复票时只在上面追加评论。

上线前用历史门槛失败验证过（12 个 `test/pipeline` 失败样例，在各 PR 当时的提交上重跑选测试）：9 个退回完整测试，1 个按依赖选且选中了失败的文件，2 个没选中的都是环境原因的失败（2026-11-07 三个门槛同时跑超时、数据湖认证失败），和改动无关。同一套规则下，最近 9 个 PR 里 6 个走按依赖选（pipeline 只跑 0–7 个文件），#1203、#1205、#1200 原来都要跑完整测试。

## 其他规则

- 只跑指定的票：`SANDCASTLE_ONLY=328,329 npm run run:sandcastle`（prep 与 plan 都只看名单里的票；拆出来的子票不在名单里，要另外加）。
- plan 由脚本自己算，不用 agent：在已准备的票里排除 `## Blocked by` 里还有 open 票的（只认列表项里的票号，括号里的是说明，不算），剩下的按编号从小到大选（`sandcastle:main-broken` 修复票排最前），和已选的票改同一个文件（指引里 `- **Change**: \`path\`` 行的路径，以及 `**Change**` 下缩进子条目开头的路径；一条 Change 都没有时兜底取指引里 New / Reuse / ADRs / Tests 之外的 `path:行号` 引用，并在日志里警告；解析在 `.sandcastle/guide.ts`）就跳过，所以冲突时总是编号小的先做，最多 `MAX_PARALLEL`（2）张。只追加的索引文件（`APPEND_ONLY`：`test/CATALOG.md`、`test/README.md`、`CONTEXT.md`、`docs/adr/README.md`，以及翻译表 `app/i18n/en.client.json`、`app/i18n/en.server.json`（按键排序，`npm run i18n:sort`，新词条插在各自位置，并行的票很少文本冲突）和中文棘轮基线 `test/i18n-ratchet-baseline.json`，冲突时 rebase 重算）不算改同一个文件，两张票都改它们也照常并行——冲突交给 rebase（`rebase-prompt.md` 已写明两边都在追加的文件两边都保留）。被 blocker 挡住的票不占文件。等人审（`sandcastle:pr-open`）的票也占着它的文件：PR 合入或关闭之前，改同一个文件的票不会开工，免得两个 PR 在同一个文件上冲突；代价是 PR 一直不审，这些票就一直排不上。跳过原因会打在日志里。
- prep 和 plan 都按票号从小到大处理：prep 一张接一张串行跑完，plan 才开始选票。
- 有 open blocker 的票不会被 prep（脚本直接跳过，不开 prep 会话，日志打「跳过 prep #n」），也不会被 plan 选中。`## Blocked by` 里的票号在本仓库查不到（gh 报 `Could not resolve to an issue or pull request`）时不当成 open 一直等：日志打「跳过 #n：blocker #m 不存在或无权访问」，票打 `sandcastle:stuck` 并留言；人改好 Blocked by、去掉 stuck 后照常调度。网络、权限等其他查询错误仍按 open 处理，不打 stuck。blocker 留成 PR 时，依赖它的票在你合并之后的下一次轮询开工（运行已结束时要重新运行）。
- 每次调度开头重新查询 issue，拆出来的子票在下次调度被看到。plan 选不出票、但这次拆出了还没 prep 的子票时，马上再调度一次，不算空转。
- 轮询比原来按轮跑频繁，所以本次运行里 prep 过、却既没打上 prepped 也没拆的票（比如 prep 会话出错），只有 issue 有了变化（评论、正文、标签）才再开 prep 会话。
- 撞上 Claude 用量限额（`You've hit your … limit · resets 6:20am (UTC)`）不算票失败，不打 `sandcastle:stuck`：脚本从报错里解析重置时间，等到那之后再多等 2 分钟，然后重跑撞上的那一步。prep 不在调度里等（会占着宿主机，做完的票落不了地）：停下这次的 prep，下次调度再试；没有票在做时，主循环等到重置再调度，不算空转。实现中的票先把已有提交推到远端，再在原分支上从 implement 重跑，implementer 看到已有提交会直接收尾，review 与门槛从头跑；rebase 补救同样重跑。认不出重置时间就每 30 分钟试一次。这个阶段的档案全都撞上限额（`AllProfilesLimited`）进入等待时，在票上评论一次，写明阶段、档案名和预计恢复时间（运行机器的本地时间），带标记 `<!-- sandcastle:limited -->`：同一次等待（醒来再撞、每 30 分钟重来）只发一条，票上可信作者的最后一条评论已经带这个标记时也不发（重启后不重复；外部用户伪造的标记不算，#80），成功跑完后下次再撞会重新发（前提是中间票上有过可信作者的别的评论：成功后紧接着 rebase 又撞上、期间没有新评论时，最后一条仍带标记，不再发）；单个 Claude 限额报错（不是 `AllProfilesLimited`）和已关的票不发，发失败只警告（#48）。进程被中断（Ctrl-C、关机）时，已有提交在本地同名分支上，重跑 `npm run run:sandcastle` 会接着做。
- 每次调度开头 `git fetch origin main`，新分支从 `origin/main` 建。prep 与 plan 不建分支，沙箱挂的是宿主机工作区（本地 HEAD），所以 fetch 后宿主机在 `main` 上时把本地 `main` 快进到 `origin/main`（`git merge --ff-only`），prep 的 Explore 才看得到已合并的代码；不在 `main` 上、本地领先或分叉、或快进会覆盖未提交的改动时只打警告、不动工作区，这时 prep 读到的是旧代码。运行时宿主机留在 `main` 上，不要在本地 `main` 上做未推送的提交。
- 运行中途可以手动合并或关掉正在做的票：落地前脚本会查 issue，已关闭就跳过（不 push、不开 PR、不打标签），本地分支先留着。每次调度开头清一次已关闭票的残留：去掉 `sandcastle:prepped` / `pr-open` / `stuck` / `waiting-main`（`decided`、`flaky` 不动）；票已关闭、且分支有已合并的 PR 时，删掉 `sandcastle/issue-<n>` 的远端分支、本地 worktree（有未提交改动就留着并警告）和本地分支。没合并就关掉的票，分支留着。连远端的 git（每次调度开头和落地时的 fetch、push）撞上 SSH、DNS 或网络错误（`Permission denied (publickey)`、`Could not resolve host` 等）时，等 30 秒到 15 分钟逐步加长，共重试 6 次（约半小时）；被拒（non-fast-forward、lease 过期）不重试。宿主机上的命令都有超时：连远端的 git 5 分钟，其余 10 分钟，超时算网络错误，照样重试。建沙箱或落地时撞上临时错误（复制 `node_modules` 到工作区超时、GitHub API 读超时、连接被重置等）也不直接打 stuck：分别等 1、5、15 分钟后整步重跑，3 次都不行才算失败。门槛依赖的服务连不上（门槛退出码非 0 且输出命中 `ECONNREFUSED`、`getaddrinfo ENOTFOUND` / `EAI_AGAIN`、容器运行时连不上，或项目的 `gate.envErrorPattern`，#54）也按这条路走：终端打出那一行，不开 fix 会话，用完重试打 stuck 时评论写明那一行。配置里声明了 `gate.services`（`[{ name, host, port }]`，宿主机地址）时，启动（运行锁和 podman 检查之后）先逐个用 TCP 连一次，有连不上的就报错退出，写明服务名和 `host:port`；`sandpipe doctor` 每个服务一行 ok / fail（#55）。磁盘剩余空间也查（`src/preflight.ts` 的 `diskProblems`，statfs 可注入）：doctor 量工作目录和容器存储（`containerStorePath` 用 `podman info --format {{.Store.GraphRoot}}` 取路径，取不到或 statfs 抛错只 warn——macOS 的 podman machine 下 GraphRoot 在虚拟机里，宿主机量不到；自定义 sandbox 不查容器存储），低于 `preflight.minFreeGb`（默认 5 GB）fail 并给清理命令（#62 之一）。`sandpipe run` 每轮调度前也预检（`src/preflight.ts` 的 `preflightProblems`，#62 之二）：gh 登录（`forge.checkAccess`）、被用到的 Claude 档案的凭据（`src/models.ts` 的 `missingCredentials`）、工作目录和容器存储的剩余空间（GraphRoot 启动时取一次）；有失败时这一轮不开任何新会话（prep / implement 都不开），不打 `sandcastle:stuck`、也不算空转，终端写明每条原因和处理方法（问题和上一轮相同时只打一行「预检仍未通过」，不刷屏），已在跑的票不受影响，下一轮再查，从失败转为通过时打一行「预检通过，继续调度」。凭据失效时不发通知，只写终端（#62 上定的）。会话中途撞上认证失效（`src/models.ts` 的 `AGENT_AUTH_PATTERN`：401、invalid api key、token 过期、要 /login、`authentication_error`，对所有档案生效，不新增配置项；抛出来的整段认，作为最后输出、不带完成信号返回的只认很短的输出——整段 trim 后不超过 500 字、且某一行以报错开头（允许行首空白或 `Error:` 一类前缀），句子中间、反引号里引用到的不算，#142 打回归定的收窄：review / prep 会话正常结束也没有完成信号，结论里引用关键词不能误判成认证失效）也按环境类错误处理（#62 之三）：`runWithProfile` 改抛 `AgentAuthError`（`src/lifecycle.ts`，前缀 `agent auth:`）——不换档案、不记限额、不消耗 implement 轮次、不算失败，`retryTransient` 不重试它。build 由 `untilAuthRecovered` 包在最外层：终端写明原因和处理方法后等凭据指纹（`credentialsFingerprint`，对 `.sandcastle/.env` 列出的键求的 sha256，只比较变没变、不打印）变化，或等满 30 分钟兜底，然后在原分支上重跑（implement 会话从第 1 次重新数）；凭据一直没换时同一张票最多撞 3 次（含第一次，#142 打回归定的上限）：到上限不再等，按普通失败走 stuck 出口——打 `sandcastle:stuck`、在票上评论写明「连续 3 次撞上认证失效、凭据未更换」并照常发 stuck 通知（这条走 stuck 通知，不违背凭据失效暂停期间不发通知），同时清掉全局暂停标志，别的票照常调度；凭据换过后计数重新数。prep 撞上时不写 `prepTried`、置同一个标志后停下；prep 也有同样的上限（逐票计数，和 build 共用 `src/lifecycle.ts` 的 `nextAuthHits` / `authHitCapped`）：凭据指纹一直没变时同一张票的 prep 撞到第 3 次就清掉暂停标志，按 prep 的普通失败处理（记错误日志、写 `prepTried`，票更新前不再 prep），prep 成功或凭据换过后计数重新数。这个标志由主循环并进每轮预检：凭据没换就和其他预检问题一样暂停开新会话（复用「预检仍未通过」的去重），换过或等满 30 分钟自动清掉。build 在原分支上重跑，落地重跑时已合并的票会跳过。某张票落地时出错（重试用完仍连不上、分支被删等）只影响这张：打 `sandcastle:stuck` 并在票上评论报错，本地分支保留，其余的票照常落地，运行继续。
- 要修改留下的 PR：在 PR 上留意见（普通评论、review 正文、行内意见都行），再发一条**以 `/sandcastle` 开头**的评论或 review（意见可以直接写在它后面），然后运行（Sandcastle 正在跑就不用重启）。每次调度开头，脚本看到晚于分支最新提交的 `/sandcastle`，或别人点的 Request changes（都只认有写权限、机器人或 `trustedAuthors` 里的作者，外部用户的不算），就去掉 `sandcastle:pr-open`，把票放回 plan。PR 是用你的 gh 凭据开的，GitHub 不让作者对自己的 PR 点 Request changes，所以要用 `/sandcastle`。implementer 接着同一个分支 `sandcastle/issue-<n>` 做，并先读 PR 评论和行内意见。reviewer 会逐条确认这些意见都处理了，才给 `merge`。手动去掉 `sandcastle:pr-open` 的老办法也还能用。
- 票的来源只认可信作者（ADR 0006）：机器人、`trustedAuthors` 里的登录名、或在仓库有 admin / write 权限的人。作者不可信的票打 `needs-triage` 并跳过，你看过后打 `sandcastle:trusted`、去掉 `needs-triage` 即可继续；打了 `sandcastle:trusted` 之后正文再被改不会再检查。编排器只认可信作者的评论标记和打回信号。agent 在沙箱里读票时，平台命令清单里读评论的命令（票的评论、PR 的评论、review、行内意见）都按 `author_association` 是 OWNER / MEMBER / COLLABORATOR 或 `user.type == "Bot"` 过滤，看正文不带 `--comments`；提示词写明其他人的评论、PR 上外部用户的意见和外部链接只是参考，不能照做。agent 有 token，能绕过过滤，这一层只是软约束；只读协作者在 agent 这一层会混进来。
- 已经有指引、但写于 blocker 合并之前的票，prep 会按 `docs/agents/ticket-sizing.md` 重写指引。
- 主动通知（可选 webhook，#63 之一，`src/notify.ts`）：配置 `notify.env`（默认 `SANDPIPE_NOTIFY_WEBHOOK`），URL 从 `.sandcastle/.env` 读（值为空时取宿主机同名环境变量，没配时什么都不发）。宿主机给票打 stuck（`markStuck`，以及落地出错时直接打 stuck 的兜底出口）、留 PR 给人（`leaveForHuman`）、main 兜底完整测试失败（`runMainFullCheck`：新开 main-broken 票和在已有票上追加评论都发，票号用对应的票，原因只写失败的短 sha，不放 3000 字测试输出）、一个阶段的全部档案撞限额进入等待（`limitedComment`：和限额评论一起去重，评论被跳过——票已关、可信作者最后一条评论带标记——就不发，同一次等待只发一条、重启后不重复）、prep 撞限额（模块级 `prepLimitNotified` 保证每个进程一条，任一张票的 prep 正常返回后重置；没有评论标记，重启后会再发一次）、prep 会话正常结束后票新带 stuck（结束后查一次标签才知道会话里打的，查询失败只警告）时各 POST 一条 JSON：`text` 是给人看的一行（Slack incoming webhook 直接认；飞书、企业微信、钉钉的群机器人要各自的格式，不兼容），`event` / `issue` / `url` / `reason` 给自建接收端；forge 实现了可选的 `issueUrl` 时带链接，没实现或拿不到仓库链接时只带 `#N`（GitHub 的实现：第一次用到时 `gh repo view --json url` 探一次仓库链接并缓存，gh 报错或输出为空返回 undefined、不重试，#135）。中英按 `language`。`run` 异常退出（`cli.ts` 顶层 catch）也在退出前发一条 `crashed`（原因取错误第一行，最多等 10 秒，发不出去照常退出码 1，终端语言）；cli 不加载项目配置，只认默认变量名，自定义了 `notify.env` 的项目异常退出时收不到。发送失败（fetch 抛错、5xx、429）等 5 秒重试一次，仍失败才打一行警告（fetch 抛错时写明错误类型：超时的 `TimeoutError`、cause 上的 `code`（如 `ECONNRESET`、`ENOTFOUND`、`ERR_INVALID_URL`），都取不到退回先抹掉 URL 的错误文本；按最后一次结果选文案）、不阻塞主流程，4xx（除 429）不重试，crashed 通知和 doctor 的 `--notify-test` 传 `retry: false` 不重试（总等待仍封顶 10 秒、交互命令马上出结论），警告和日志里不出现 URL；这个变量在所有沙箱的 env 里清空（原因同 Claude 凭据，ADR 0004），agent 拿不到。doctor 也检查它（`src/doctor.ts` 的「通知」一节）：配了 URL 时发一次 HEAD 看连不连得上（收到任何 HTTP 响应算 ok，连不上只 warn、detail / fix 不带 URL），`--notify-test` 用同一个 notifier 发一条 `test` 事件的测试消息（中英按 `language`，2xx ok、其他 warn，`--fix` 时不发、只做连通检查），没配 URL 时 ok「未配置，不发通知」。

## 外部 PR：让 Sandcastle 接手别人开的 PR

其他 agent 或人开的 PR，满足下面几条，就能像 Sandcastle 自己的 PR 一样用 `/sandcastle` 打回：

- PR 正文写 `Closes #<n>`，关联一张 issue。分支在本仓库，不能来自 fork，因为 Sandcastle 要往这个分支推提交。
- 这张 issue 带 `Sandcastle`、`ready-for-agent`、`sandcastle:prepped`、`sandcastle:pr-open`，表示 PR 已开、等人审，不再 prep。正文按 `ticket-sizing.md` 写：验收标准最多 3 条，而且 agent 能自己验证；有 `## Implementation guide`，要改的文件各写一行 `- **Change**:`。
- 打回的写法和上面一样：发一条以 `/sandcastle` 开头的评论或 review，时间要晚于分支的最新提交。

脚本按 issue 关联的 open PR 找分支，同一张票同时有 `sandcastle/issue-<n>` 时优先用它；关联了多个外部 PR 时跳过这张票。对外部 PR，脚本会：

- 把远端分支同步到本地，在对方的提交上接着改。
- review 和完整测试照常跑。
- 只做普通 push，不 force、不 rebase、不删分支。
- 不自动合并：在 PR 上评论 review 结论和测试结果，重新打上 `sandcastle:pr-open`，由人合并。

Sandcastle 处理期间，PR 作者不要往这个分支推提交。本地和远端分叉时，这张票会失败并打 `sandcastle:stuck`。如果 3 次会话内没改完，脚本会推上已有的提交并打 `sandcastle:stuck`，不退回 prep。

## 上下文预算

- implementer 的每次迭代都是全新的 Claude 会话；`IMPLEMENT_MAX_ITERATIONS = 3`。第一次超过时退回 prep 重新准备（见标签状态机），分支先推到远端，已有提交列在评论里；重新准备后再超过才打 `sandcastle:stuck`。
- 判断「做没做」看分支上领先 `origin/main` 的提交，不看这次会话有没有新提交：重新准备后父票只剩已完成的部分，收尾时可能不再提交。
- 编码规范：reviewer 按 `.sandcastle/CODING_STANDARDS.md` 和根目录的 `CODING_STANDARDS.md` 审，implementer 提交前按这两份自查。review 里反复出现的问题补进 `.sandcastle/CODING_STANDARDS.md`。
- 每个会话设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`，用别家模型时也一样（见「模型配置」）。真正保证预算的是 prep 把票切小（`docs/agents/ticket-sizing.md`）。
- implementer 不跑完整测试（沙箱里很慢），完整测试由门槛跑。
- PR 正文的 **Budget** 一节记录上下文峰值，超过 150k 时会标出来。峰值取会话文件里单条消息的最大上下文（输入 + 缓存写 + 缓存读），不是会话结束时的大小：中途自动压缩过的会话，结束时只剩几十 k。每次 run 的峰值也写进 `.sandcastle/logs/usage.jsonl` 的 `peak` 字段和 PR 的 Usage 表。
- 每个会话还有 `.claude/hooks/sandcastle-context.mjs` 守着（只在有 `SANDCASTLE_PROFILE` 时生效，宿主机会话不受影响）。自动压缩只在两轮之间发生，管不住单次很大的工具结果，也会让会话丢细节，所以这个 hook 在每次工具调用后，用会话记录里最近一条消息的上下文加上刚返回的结果估算：
  - 到 100k 时要求收尾。implement 提交能过测试的部分、在 issue 上留进度评论、不输出 COMPLETE 结束，下一个全新会话接着做；3 次会话做不完退回 prep，把剩下的拆成更小的票。其他阶段把手上一项做完、输出结论。阶段名经 `SANDCASTLE_PHASE` 传进容器。
  - 之后每多 10k 再提醒一次，到 130k 时要求立刻结束。
  - 档案 `env` 里标了 `SANDCASTLE_NO_IMAGES=1` 的（主模型看不到图片），主线程 Read 图片会被拦下，看截图交给 `.claude/agents/screenshot-checker.md` 子代理：`model: haiku`，glm 档案里映射到能看图的 glm-5.3-flash；一个子代理只许读一张图（hook 按 `agent_id` 记），回文字结论，主会话只多几百 token。glm-5.3 看不到图片，一张 1280×720 截图却照样计约 6–7 万 token：2026-11-08 以来 glm 超过 150k 的 49 个会话，全是 implement 读 `.browser-check/*.png` 撑上去的，最高 407k。
  - 子代理里触发的工具调用不做预算提醒（hook 输入带 `agent_id`），它的上下文单独算，结论回到主线程时计入主会话。

## 模型配置

每个 agent 阶段（`prep`、`implement`、`review`、`revise`、`fix`、`rebase`、`re-review`）用哪个模型写在 `.sandcastle/models.json`，代码在 `.sandcastle/models.ts`。plan 和门槛是脚本自己做的，不用模型。

- `profiles` 是档案：`harness`（目前只支持 `claude-code`；`codex` 预留，写了会报错）、`model`（传给 `claude --model`）、可选的 `effort`、`env`、`limitPattern`、`resetTimeZone`。
- `env` 照抄厂商给 Claude Code 的配置（比如智谱 coding plan 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_DEFAULT_*_MODEL`）。只对这次会话的 claude 进程生效，加在命令前面（`env K=V claude …`），因为 `createSandbox` 里的 `sandbox.run` 不用 agent provider 的 env。
- 每条 claude 命令都带 `--settings`（`NO_ATTRIBUTION_SETTINGS`）：关掉 Claude Code 自带的提交 / PR 署名，别家档案的提交不会被署名成 Anthropic 的模型；`--settings` 优先级高于项目的 `.claude/settings.json`（#94）。
- 密钥不写进 `models.json`：值写成 `"${GLM_API_KEY}"`，在容器里从同名环境变量取。变量要列在 `.sandcastle/.env` 里，sandcastle 只把那里列出的变量带进容器。
- 档案设了 `ANTHROPIC_BASE_URL` 就算别家，Claude 的凭据（`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`）不会发到别家的接口，范围是整个容器，不只 claude 进程：
  - 凭据不在容器级 env 里：sandcastle 会把 `.sandcastle/.env` 的键都放进 `podman run -e`，脚本在 sandbox env 里把这两个键覆盖成空串（`CLAUDE_CREDENTIALS_CLEARED`）。同一个容器会先后跑 Claude 和别家的会话（implement=glm、review=opus，或撞限额中途换档案），容器 env 在 `podman run` 时就定死了，所以只能按会话给。通知 webhook 的 URL 同样在沙箱 env 里清空（见「其他规则」的主动通知）。
  - Claude 档案的会话：`.env` 里有值的凭据每个一行放在 prompt 前面从 stdin 送进去，命令是 `IFS= read -r __c0; export CLAUDE_CODE_OAUTH_TOKEN="$__c0"; exec env … claude …`，值不出现在任何命令行里，外层 sh 被 exec 替换掉；这次会话的 claude 及其子进程有凭据。`.env` 没列凭据时两个键都 `env -u`。
  - 别家档案的会话：命令前 `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY`，stdin 只有 prompt，这次会话里容器内任何进程的环境都没有凭据（门槛、装依赖等其它 exec 也没有）。例外：同一个容器里之前 Claude 档案的会话在后台留下、还活着的进程（如 `&` 起的 dev server）是 claude 的子进程，环境里有凭据，别家会话能从它的 `/proc/<pid>/environ` 读到。
  - 项目配置里自定义 `sandbox` 的，必须把收到的 env 原样传给容器，否则清空无效、凭据会留在容器级 env 里。
- 别家档案没设 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（后台小任务和子 agent 用）或 `limitPattern` 时启动会警告。
- 上下文预算统一 150k：档案里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 警告后忽略。主模型看不到图片的档案在 `env` 里加 `"SANDCASTLE_NO_IMAGES": "1"`，并把 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 设成能看图的模型（看图子代理用它，见「上下文预算」）。implement 只用 glm，不设后备：glm 到限额时等它恢复。
- `phases` 给每个阶段一个有序的档案列表，除 `re-review` 外都要写。`re-review` 是 fix / rebase 之后的复审会话，没写时沿用 `review` 的列表（老项目升级不用改配置）；写了但为空或档案不存在照样报错。主循环每轮读一次（不管有没有空位），撞限额等待醒来、重跑前也再读一次：改了配置下一轮生效，不用重启；启动时打印一次，之后只在配置变化时打印。第一次就读不成（JSON 坏了、档案名不存在、阶段用到的档案引用的变量不在 `.sandcastle/.env` 里）直接退出；运行中途改坏了就警告并沿用上一份。
- `PROJECT.md` 不一样：提示词启动时渲染一次，运行中改了要重启 sandpipe 才生效（正在跑的会话已经读过渲染好的文件，不做热加载）。主循环每轮（在读 `models.json` 旁）比一次内容哈希，和启动时不同、且和上一轮看到的也不同时打一行「⚠ .sandcastle/PROJECT.md 已变更，需重启 sandpipe 才生效」（路径是实际读的那份、相对当前目录，设了 `SANDCASTLE_PROJECT_DIR` 时跟着变），同一次修改只打一次；改回启动时的内容不打，文件读不到（被删）不打（#52）。
- 换档案以一次会话为单位：implement 的每次会话单独挑档案，档案名经环境变量 `SANDCASTLE_PROFILE` 给 implementer，进度评论第一行写明。不用 promptArgs：运行中的旧进程也会读到新提示词，多出的占位符会让它报错。撞上限额（Claude 档案认 `hit your … limit`，别家认 `limitPattern`）就记下这个档案的重置时间（存在 `.sandcastle/logs/limits.json`，重启后照样跳过），重置前所有票都跳过它，用列表里的下一个；认不出重置时间就跳过 1 小时。重置时间认「resets 6:20am (UTC)」和「2026-11-07 15:30:00」两种，后一种按 `resetTimeZone` 解析。列表里的都在等时，分支推到远端，等最早恢复的那个，不打 stuck，并在票上评论一次（阶段、档案、预计恢复时间，#48）。其他报错照常走临时错误重试。
- 智谱 coding plan 撞限额的错误码是 1308（5 小时额度）和 1310（周 / 月额度），报错是「已达到…的使用上限。您的限额将在 … 重置」；1302 是并发过高，1113 多半是 Key 或 Base URL 配错，都不算限额。

用量：每次 run 结束把档案、模型、会话数和输入 / 缓存写 / 缓存读 / 输出的 token 数追加到 `.sandcastle/logs/usage.jsonl`（每条会话 JSONL 里 assistant 消息的 usage 按消息 id 去重后相加；别家档案的 model 是 `opus` / `sonnet` / `haiku`（可带 `[1m]`）、env 里对应的 `ANTHROPIC_DEFAULT_*_MODEL` 有值时，model 记成 `opus→glm-5.3[1m]` 这样的「别名→实际名」，值是 `${VAR}` 或其余情况原样记；撞限额、换下一个档案的那次会话也记一条，带 `limited: true`，拿得到 run 就照常算 token，拿不到（报错是抛出来的）token 记 0、会话数 0；老记录没有这个字段），PR 正文的 **Usage** 一节是每次 run 一行的表（`limited` 的行「次数」格写「撞限额，换下一个档案」，其余数值格写 `—`；全部档案都撞限额、整次 build 重跑时，那几行只留在 `usage.jsonl`，不进表）：先列这张票的 prep（reprep 时有多次，落地时从 `usage.jsonl` 读回），再列 build 的各次 run，不含 rebase（发生在 PR 开出之后）；票关掉重开重做时旧的 prep 也会算进来。每条记录还带可选的 `models`：从这次 run 各会话 stream-json result 行的 `modelUsage` 按模型累加输入 / 缓存写 / 缓存读 / 输出 token（含子代理——主行的口径是主会话 JSONL，看不出子代理用的模型）；键是 Claude Code 实际请求的模型 ID，第三方档案下就是映射后的真实名，等于档案 env 某个 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 的明文值时记成 `haiku→glm-4.5-air`（与 `model` 字段同一写法；`${VAR}` 值只在容器里、反查不到，原样记），Claude 档案每个模型另带 `costUSD`、第三方档案不带（费用是 Claude Code 按 Claude 单价算的，没有意义），没拿到 result 行（idle 超时、报错、撞限额拿不到 run）时不写这个字段；PR 的 Usage 表不显示费用，`models` 有 2 个及以上模型时在这条 run 的行下面每个模型一行（档案格 `↳ <模型名>`、次数和上下文峰值格 `—`、四个 token 格照填；modelUsage 的键是完整模型 ID，和档案的 model 别名对不上，没法挑出「主模型」，所以全列），只有 1 个模型时不加行（#53）。配了 `spendLimit.ticketTokens`（可选，不配不限）时，这张票累计到这个数就不再开会话（#151）：每次开会话之前（implement、review、rebase、re-review、prep 都算，都在 runAgent 开头检查）把上面这些记录折算成 token 求和——每条有 `models` 取各模型四项之和、没有取主行；输入、缓存写、缓存读、输出四项相加；`limited` 记录、第三方档案的记录都算，跨运行、重启有效——已用 ≥ 上限就抛 `BudgetExceeded`（`src/budget.ts`），不开这个会话：implement / review 等走落地的失败分支、prep 走自己的 catch，都打 `sandcastle:stuck`、评论（i18n 的 `ticketBudget`）写明已用多少、上限多少，提示先调大 `spendLimit.ticketTokens` 再去掉标签，否则下一个会话马上再次停下；prep 停下时照常写 `prepTried`，不会每轮重跑。会话中途超出不打断，下一个会话才停。

## 运行前提

- `.sandcastle/`、`.claude/skills/prep-ticket/`、`CLAUDE.md`、`docs/` 要**先提交并 push**：沙箱从 `origin/main` 建 worktree，看不到未提交的改动。
- 测试依赖的服务在宿主机的 apple container 里（PG、MySQL、MongoDB、SeaweedFS；PG 镜像是带 pgvector 的 `pgvector/pgvector:pg17-trixie`，见 `db_script/pg_setup.sh`），端口发布在宿主机上，podman 容器经 `host.containers.internal` 访问。脚本读宿主机的 `.env`（`S3_*`）与 `.env.test`（`TEST_*`），把 `localhost` / `127.0.0.1` 换成 `host.containers.internal` 后传进沙箱。
- 测试库连接、上下文预算等环境变量在建沙箱时经 `podman({env})` 注入（`sandboxFor`）。`createSandbox` 里的 `sandbox.run` 不使用 `agent(env)` 的 env，放在那里进不了 agent 的 shell。
- 沙箱建好后用 `package.json` 的 `packageManager`（pnpm）按锁文件重装依赖：拷进来的 `node_modules` 是宿主机 darwin 的，缺 linux 原生包。
- 每张票的库名与前缀加 `_i<n>`（`crm_platform_test_i<n>`、`crm_source_test_i<n>`、pgvector 契约用例的 `crm_vector_test_i<n>`（`TEST_PGVECTOR_URL`，总是传进沙箱）、MySQL / MongoDB 库、`TEST_S3_LAKE_URI`），源端测试账号也按票加运行后缀（`CRM_TEST_RUN_SUFFIX`，`crm_src_reader_i<n>_w<i>`，见 `scripts/test-resource-names.ts`），并行的沙箱互不清表、不共用集群级账号；`CRM_TEST_WORKERS=4`，`MAX_PARALLEL × 4` 个 worker 的连接数要在 PG `max_connections` 以内（`MAX_PARALLEL=2` 要 300，见 `db_script/docker-compose.yml`）。2026-11-07 试过 3：三个门槛同时跑完整测试，每个都有 8～10 个文件 60 / 90 秒超时，和改动无关，单跑能过；所以降回 2。沙箱里还设 `CRM_TEST_TIMEOUT_SCALE=2`，`vitest.config.ts` 把 testTimeout / hookTimeout 乘成 180 s / 120 s（沙箱负载比本地约慢一倍，#439；这类负载超时出过 #357 / #440 / #459 三张偶发失败票后统一放宽，#461），本地与 CI 仍是 90 s / 60 s。
- 这些资源在每次关沙箱后（`build`、`rebaseAndMerge` 的收尾）由 `scripts/drop-test-resources.ts _i<n>` 在宿主机上回收：PG 的测试库（含 `crm_vector_test_i<n>*`）、验收库及其中租户的 catalog 角色 `lake_<id>`（集群级，删库带不走，没有别的库再依赖时才删），PG / MySQL 的源端测试账号 `crm_src_reader|writer_i<n>_w<i>`（集群级，同样没有依赖才删），MySQL / MongoDB 库（Mongo 连库里的用户与角色），`TEST_S3_LAKE_URI_i<n>*` 下的对象和策略只授权这些前缀的对象存储账号。不等票合并：再跑这张票时 global-setup 与夹具会重新建库。回收失败只打日志、不影响票；留下的用 `pnpm sandcastle:cleanup _i<n>` 补收（pnpm 会把 `--` 原样传给脚本，不要加），没有 Sandcastle 在跑时可用 `--all` 收全部 `_i<数字>`。
- 门槛里大量用例在 `s3-accounts.ts` 的 IAM 调用上 `TimeoutError`、资源回收也超时时，先看对象存储：`curl -s localhost:9333/dir/status` 的 `Free` 为 0、`container logs seaweedfs` 里有 `No writable volumes and no free volumes left`，就是卷数到了上限。filer 的元数据日志（`/topics/.system/log`，每天一个目录）会一直占新卷，测试越跑越多。本机的 seaweedfs 以 `-volume.max=2000 -master.volumeSizeLimitMB=1024` 启动，并把 `db_script/seaweedfs`（内含 `master.toml`，每个新桶首写只占 1 卷而非默认 7）挂到容器的 `/etc/seaweedfs`：这套卷配置三处一致（compose / CI / `db_script/start.sh`），撑得住约 1000 个每个都写过对象的桶，实测见 `docs/test-plans/bucket-per-tenant-scale.md`（#687；2026-11-03 曾把 `-volume.max` 从自动算出的 505 调到 1000，2026-11-14 换成 1 卷/桶）。宿主机切过去：`container stop seaweedfs && container rm seaweedfs` 后重跑 `db_script/start.sh`（数据在命名卷 `seaweedfs-data`，不丢）；已有桶已分配的卷不回收，只有之后新写入的桶按 1 卷增长；启动日志（`container logs seaweedfs`）应能看到读取 `/etc/seaweedfs/master.toml`（看不到时用建桶首写后 `curl -s localhost:9333/dir/status` 的卷数只 +1 来确认生效）。元数据日志由 `scripts/prune-seaweed-metalog.sh [保留天数，默认 2]`（`pnpm sandcastle:prune-metalog`）清理：删早于保留天数的日期目录，再删默认 collection 里已写满且文件全部已删的整卷（立即收回卷位和磁盘）；Sandcastle 每次调度开头会自动跑一次。同一轮还会先清一遍 `/etc/iam/policies.json`：删掉账号已不在 `/etc/iam/identities/` 里的内联策略（`scripts/prune-seaweed-iam-policies.ts`，#621：每次 IAM 改动都整份重写这个文件，删掉的账号留下的孤儿条目会把它和元数据日志一起撑大——曾涨到 6 MB、元数据日志一天 65G）。`fs.configure` 给这个路径设 TTL 不生效（filer 写自己的日志不走路径规则）。
- `GH_TOKEN` 需要 Issues 读写与 Pull requests 只读；push、开 PR、合并在宿主机上用你自己的 git / gh 凭据完成。宿主机的 `gh` 要 2.99+（`--attach` 上传截图）。
- 改了 `.sandcastle/Containerfile` 后镜像过期（按镜像 `sandpipe.containerfile` label 记的 Containerfile 内容 sha256 判断，见 docs/config 的标签一节）：doctor 报「镜像过期」、`--fix` 重建，`sandpipe run` 启动时也警告一次、不挡运行。podman 读 `~/.config/containers/registries.conf`（Podman Desktop 还会把它同步进虚拟机），这个文件不合法时构建会失败。

## 浏览器验收

改了页面的票，implementer 在沙箱里用 `playwright-cli`（无头 Chromium，镜像里装好，带中文字体）照票里的 **Browser check** 做验收，步骤在 `prompts/implement.md`。和宿主机上的 ego-browser 流程（`test/README.md`「浏览器验收」）的区别：

- 不连开发库 `crm_platform`。每张票一个验收库 `crm_platform_browser_i<n>`，`scripts/browser-lab.ts` 在里面建空的 `crmlab-smoke` 租户和 `admin@` / `eng@` / `an@crmlab-smoke.test`。需要数据时 agent 在页面上自己建。
- dev server 在沙箱里起（5180），`MAILER=console`，Magic Link 从它的日志里取。
- `/ops` 要 TOTP，沙箱里验不了。

截图和 `RESULT.md`（每一步的结论）写在 worktree 的 `.browser-check/`，不提交。关沙箱前脚本把它拷到宿主机 `$TMPDIR/sandcastle-browser-check/issue-<n>/`，开 PR 时正文的 **Browser check** 一节先写评审结论（reviewer 自己看截图、对照票的 Browser check 逐条给的 `<browser-verdict>`，没给时写明「评审没有给出逐条结论」），再写 implement 自评（`RESULT.md`），截图用 `gh --attach` 上传，显示在 Browser check 一节里（首次开 PR 和再走一轮都是）。reviewer 只在自己逐条全 ✅、且与 `RESULT.md` 一致时给 `browser-check` 的 `done`。

改了页面的票：`RESULT.md` 每一步都是 ✅、reviewer 自己看截图的结论也逐条全 ✅ 时可以自动合并（2026-11-24 放宽）；有 ❌、⚠️ 或没验证到的步骤才留 PR，由你看截图和结论后合并。

## 验收说明

每个 Sandcastle PR 的正文都以 `## 验收说明` 一节开头，写给验收 PR 的人：这个 PR 做了什么、在宿主机上怎么一步步验证、最终效果。来源是 implementer 写在 worktree `.pr-notes/验收说明.md`（不提交）的中文说明，格式要求在 `prompts/implement.md`：`### 做了什么`、`### 怎么验证`（编号步骤，每条验收标准至少一步）、`### 最终效果` 三个小标题，不能出现 `## ` 二级标题（替换这一节时会切错）；多行命令或多行内容用代码块写，行内代码只放不换行的短片段——行内代码跨不过空行，跨空行的内容会被当成 Markdown 渲染（图片语法会变成破图）。

和 Browser check 的区别：Browser check 是 implementer **在沙箱里**做过的验证记录（临时验收库、playwright 截图），沙箱关掉就没法照着重做；验收说明是写给**人在宿主机上照做**的步骤（开发库 `crm_platform`、`npm run dev`）。脚本把固定的准备段落拼在文件内容前面——`git checkout <分支>`；改了页面的票（worktree 里有 `.browser-check/`，或 reviewer 输出的 `<browser-check>` 标签是 `done` / `missing`）再加起 dev server、`scripts/browser-lab.ts` 建验收租户、Magic Link 登录（项目没配 `acceptancePrep` 时只写「本票改了页面，需要起 dev server（项目没配准备步骤）」）——拼装与格式检查是 `.sandcastle/pr-body.ts` 的纯函数。

- 缺失或格式不对：正文该节写「⚠️ implementer 没有写验收说明」或「⚠️ 验收说明格式不对：<问题>」，**不自动合并**（「什么时候自动合并」的第 4 条），打 `sandcastle:pr-open` 并在 PR 上评论原因。reviewer 也会独立核对验收说明（对照 diff 和验收标准，不执行步骤），不合格给 `revise`——两道检查互不替代。
- 重做（人在 PR 上打回）时：implementer 每次会话完整重写这个文件（新 worktree 里旧文件已经没了），脚本用 `gh pr edit` 替换正文里的 `## 验收说明` 一节，并把其余由工具生成的各节（`## Review` 到 `## Commits` 之前的 Review / Browser check / Protected paths 及 Gate / Budget / Usage）**整段换成本轮的**：上一轮有、这一轮没有的节（如 Browser check）不再保留，旧结论只留在「验收说明已更新」的评论里。写完后读回正文，核对 Review 一节与本轮结论一致才继续；不一致（编辑没保存上）抛错、打 `sandcastle:stuck`，不合并。
- 外部 PR：不改正文（那是 PR 作者写的），验收说明贴在「Sandcastle 更新了这个分支」的评论里。
