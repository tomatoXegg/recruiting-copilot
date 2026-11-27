# ADR 0008：基于 `role_id` 的确定性硬门槛预筛（`screen-gate.mjs`）

日期：2026-11-27

状态：提案实施中。

## 问题

v0.9.0（[ADR 0007](0007-state-log-separation-and-deterministic-workspace-cli.md)）已通过 `role-context.mjs` 实现了单岗 Markdown 上下文切片，但候选人初筛中的纯客观硬门槛（年龄、学历层次、统招全日制、院校等价/黑名单、分学历工作年限、期望薪资、空白期、跳槽频次及连续工龄豁免、活跃度、城市）仍完全依赖大模型逐条阅读自然语言文档自行判断，存在两类问题：

1. **确定性逻辑交由概率模型反复执行**：在长批量卡片初筛中，大模型容易漏算或混淆全局规则与单岗例外，且大量明显不符硬门槛的候选人仍要消耗推理 token。
2. **规则覆盖缺少可校验的继承结构**：当在招岗位增至 10–20+ 个时，全岗位统一硬规则与单岗差异覆盖（包括个别岗位放宽某条全局规则）需要一份可机器校验、可溯源的轻量结构化配置。

## 决策

1. **新增可选的两层继承规则文件 `_shared/screening-rules.json`（`schemaVersion: 1`）**：
   - `defaults` 声明全岗位统一硬门槛；
   - `roles[role_id | 岗位名]` 仅记录与统一规则不同的单岗差异项（Delta），未填写的字段自动继承 `defaults`；显式写 `null` 表示该岗位放宽/取消对应全局规则。
   - 原生对接 v0.9.0 `CONTEXT.md` 七列表的不可变 `role_id`（通过 `model.mjs` 的 `readRoleTable`）及 `_shared/recruit-board.config.json` 的 `roleAliases`：调用时传入 `role_id`、标准岗位名或旧别名均可确定性解析。
2. **新增确定性预筛 CLI `skills/recruit-board/scripts/screen-gate.mjs`，与 `role-context.mjs` 互补分工**：
   - `validate`：校验规则 Schema、合并后区间一致性（如 `minAge <= maxAge`），并报告未匹配到当前 `CONTEXT.md` 岗位表的 `unmatchedRoleKeys`。
   - `effective-rules`：输出单个岗位的合并生效规则及每项来源（`default` / `role-override` / `relaxed-by-role`）。
   - `evaluate` / `evaluate-batch`：只评估无歧义的客观可算维度，输出明确三态：
     - `REJECT_HARD_GATE`：命中硬门槛并返回精确 `failedRules[]`，直接拦截，不消耗大模型深评；
     - `PASS_HARD_GATES`：硬门槛通过，再配合 `role-context.mjs` 的单岗热包交由大模型做命脉技能与项目深度评估；
     - `NEED_DETAIL`：无规则否决但存在缺失字段（如列表卡片缺年龄），提示拉取完整简历或交人工核对。
3. **明确不做的范围**：不重复实现 `role-context.mjs` 的单岗文本切片，不把主观语义判断硬塞进 DSL，不修改任何形式化验证覆盖的核心文件，不引入外部运行时依赖。

## 验收

- 原生兼容 v0.9.0 七列表 `role_id`、标准岗位名与 `roleAliases`；`defaults` 继承、单岗覆写与 `null` 放宽及区间冲突校验通过单测。
- `evaluate` / `evaluate-batch` 准确覆盖全部客观维度与三态输出，且拦截工作区外符号链接。
- 既有全部单测、安装测试与 8 套形式化验证基线零破坏。
