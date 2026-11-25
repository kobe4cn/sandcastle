# 端到端测试计划

测试项目：`kobe4cn/sandcastle-e2e`（private），本地在 `~/dev/sandcastle-e2e`。它是 Python + uv + pytest + ruff + mypy 写的 SQLite 记账 CLI，提交信息用英文，没有网页界面，没有外部服务。
它和 duckdb_crm 差别很大（换了语言，没有 PG，没有页面），所以也用来验证通用性。

每一项记录结果（✓ / ✗ + 问题）。发现的问题先修，补上单元测试，再从出问题的那一步接着测。

## A. 安装

- [ ] A1 从 Release 链接 `npm i -g` 安装，确认 `--version`
- [ ] A2 `pnpm add -g <同一链接>` 安装
- [ ] A3 在项目根目录以外的目录运行：给出明确提示，不崩溃

## B. onboard（开着 agent）

- [ ] B1 探测结果：python、uv、`uv sync`、`uv run mypy .`、`uv run ruff check .`、`uv run pytest`、github、main、commitLanguage en、没有 webUi、没有 services
- [ ] B2 生成的 `sandcastle.config.ts` 能加载；`gate.typecheck` 有值；`autoMerge: false`、`maxParallel: 1`
- [ ] B3 agent 写的 PROJECT.md：没有「待补」，内容符合本项目（金额用分、LEDGER_DB、英文提交），没有照抄 shop-admin 示例
- [ ] B4 Containerfile 是 Python 版（有 uv，没有 playwright），`podman build` 能建成
- [ ] B5 `.gitignore`、`.claude/settings.json` hook、`.claude/skills/prep-ticket` 已装好
- [ ] B6 再跑一次 onboard，什么都不覆盖

## C. doctor

- [ ] C1 没有 `.env`：✗，并给出修法
- [x] C2 ✓ 填好 `.env`、还没建标签：⚠/✗ 提示缺标签
- [x] C3 ✓（顺带：改名后 hook 不一致，`update` 刷新后 doctor 全绿）`doctor --fix` 建好标签，GitHub 上能看到；再跑全部 ✓
- [ ] C4 镜像不存在时 ✗，并给出 build 命令

## D. baseline

- [x] D1 ✓ 41 秒 在沙箱里对 origin/main 跑完整门槛：通过，输出 GATE_TIME
- [x] D2 ✓ 退出码 1 门槛故意失败（本地临时把 gate.script 改成会失败）：报告失败，退出码非 0，不开票
- [x] D3 ✓ 结束后沙箱和 worktree 都清理掉

## E. 票（`autoMerge: false`、`maxParallel: 1`）

- [x] E1 ✓ 约 4 分钟（prep→implement→review→门槛），PR #2；修了：进度评论第一行只有「opus」看着像笔误，改成 `模型档案：opus`；prep 看的是宿主机工作目录（会看到 `.venv`、未提交的改动），提示词里说明以 origin/main 为准。金丝雀票：加 `ledger --version`。检查：
  - prep 写了 `## Implementation guide`，打了 prepped
  - 开出 PR，PR 正文有 Review、Gate、用量
  - 没有合并，打了 pr-open，评论说明是因为 autoMerge: false
  - 提交信息是英文
- [x] E2 ✓ 约 2.5 分钟，PR 加了 `-V` 的提交、验收说明更新、重新打 pr-open。人打回：在 E1 的 PR 上评论 `/sandcastle …` 提修改意见。下一轮去掉 pr-open，按意见改完后 PR 更新
- [x] E3 ✓ #3 拆成 #5/#6/#7，有 Parent、Blocked by，父票去掉标签；#5 代拍板打了 decided。注意：子票标题和正文是中文（原票是英文）。大票（超过 3 条验收标准，比如「月度预算」功能）：prep 拆成子票，子票继承 Sandcastle 标签、写了 Blocked by，父票去掉标签
- [x] E4 ✓ #4 prep 时打 stuck，评论列了 4 个决定和建议，指出改 expenses 表是红线。要人拍板的票（含糊的需求）：打 stuck 并评论原因，或者自己拍板后打 decided
- [x] E5 ✓ 去掉标签，删远端和本地分支，worktree 干净。人合并 E1 的 PR 后，下一轮清理：关掉 issue，删掉分支和 worktree

## F. 自动合并与并行（`autoMerge: true`、`maxParallel: 2`）

- [x] F1 ✓ #6/#9 同时开工，PR #13/#14；#10/#12 也并行。两张互不相关的票（改不同的文件）并行做完，都自动合并，issue 都关闭
- [x] F2 ✓ #10/#11 都改 money.py，plan 时排开，#11 等 #10 合并后开工（没走到 rebase）。两张改同一个文件的票：plan 时排开不并行，或者后合并的那张走 rebase 路径，最后都能合进去
- [x] F3 ✓ #12 Blocked by #9，#9 合并后才开工。显式依赖：B 票写 `## Blocked by #A`，A 关掉之前 B 不开工
- [x] F4 ✓ #5→#6→#7 依次合并（PR #18），子票全关后自动关闭父票 #3。E3 拆出来的子票按依赖顺序做完

## G. 收尾检查

- [x] G1 ✓ 日志无报错，e2e 没有残留容器（在跑的两个属于 duckdb_crm），worktree 和 sandcastle 分支都已清理。`.sandcastle/logs/` 没有异常；`podman ps -a` 没有残留的沙箱；`git worktree list` 干净
- [x] G2 ✓ 每个会话上下文峰值约 34–39k，实现一张小票缓存读约 36 万 token。用量统计是否合理（每张票的 token）

## H. 升级

- [x] H1 ✓ 发 v0.1.2（Actions + Trusted Publishing，没用 npm token）；装着 0.1.1 时 doctor 提示有新版本
- [x] H2 ✓ `sandpipe upgrade` 升到 0.1.2
- [x] H3 ✓ `sandpipe update` 补上 `.sandcastle/.gitignore` 和 tsconfig.json，doctor 全绿；不装任何依赖时 `tsc -p .sandcastle` 通过

## 不在本次范围

- `GATE_TIER` / main 兜底完整测试 / `GATE_FLAKY`：门槛需要按依赖选测试，或者自己实现重跑。本项目的门槛是完整测试，用不到。留到 duckdb_crm 验收时测。
- 页面验收和截图：本项目没有页面，留到 duckdb_crm 验收时测。
- 外部 PR 打回：需要另一个账号开 PR，以后再测。
- GitLab：还没实现。
