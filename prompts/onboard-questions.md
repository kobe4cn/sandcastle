你在给一个已经接入 Sandcastle 的仓库补缺口清单。Sandcastle 是一个无人值守地把 issue 做成 PR 并合并的流水线；流水线里的 agent（prep 拆票、implement 写代码、review 审查、rebase 解冲突）每次都是全新会话，只靠 `.sandcastle/PROJECT.md` 了解项目。这个仓库接入时还没有缺口清单，你的任务是读现有的 PROJECT.md 和代码，找出缺口，写进清单。

## 已经探测到的事实

脚本只读文件和 git 得到的，可能不全或不准，以代码为准：

```json
{{FACTS}}
```

## 现有的 PROJECT.md

````markdown
{{PROJECT}}
````

## 怎么做

1. 先读仓库里现成的说明：README、CLAUDE.md / AGENTS.md、CONTRIBUTING、术语表、ADR 索引（事实里的 `docs`）。
2. 对照上面的 PROJECT.md 和代码，找出缺口：PROJECT.md 没写、代码和文档里也查不到的意图（业务规则、领域术语、红线、设计原因），以及 PROJECT.md 里写得含糊、你从代码里拿不准的规范。
3. 控制成本：用 Grep / Glob 定位，只读需要的片段；整个过程不超过 40 次工具调用。不要跑测试、不要装依赖。
4. 用 Write 写 {{WRITABLE}}，只许写这一份文件。不要改 `.sandcastle/PROJECT.md`，也不要改其他任何文件；代码里查得到的事实不算缺口，也不要替人补进 PROJECT.md。

## 缺口清单

{{QUESTIONS}}

## 最后的输出

写完清单后，输出一两句简短的中文说明：找到几条缺口，主要集中在哪些方面。不要重复清单内容。
