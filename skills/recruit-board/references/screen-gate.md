# 确定性硬门槛预筛（`_shared/screening-rules.json`）

`screen-gate.mjs` 与 v0.9.0 的 `role-context.mjs` 互补配合，将初筛拆为两段：

1. **硬门槛脚本预筛（`screen-gate.mjs`）**：按「全岗位统一规则（`defaults`）+ 单岗差异覆盖（`roles[role_id]`）」毫秒级过滤客观硬条件（年龄、学历/统招、院校层次/黑名单、分学历年限、薪资、空白期、跳槽工龄豁免、活跃度、城市）；
2. **单岗语义深评（`role-context.mjs` + LLM）**：只把通过硬门槛的候选人连同 `role-context.mjs` 切出的单岗热包交给大模型，专注评估命脉技能与项目深度。

未创建 `_shared/screening-rules.json` 的工作区保持原有行为不变。

## 配置文件：`_shared/screening-rules.json`（可选）

推荐使用 v0.9.0 岗位表中的不可变 `role_id` 作为 `roles` 键（也兼容标准岗位名）：

```json
{
  "schemaVersion": 1,
  "defaults": {
    "maxAge": 35,
    "minDegree": "本科",
    "requireFullTime": true,
    "excludeEducationTypes": ["专升本", "非全日制"],
    "maxGapMonths": 6,
    "maxRecentJobs": 3,
    "exemptIfLongestTenureMonths": 24,
    "maxInactiveDays": 30
  },
  "schoolEquivalents": {
    "虚构理工学院": "211"
  },
  "excludedSchools": ["虚构独立学院"],
  "roles": {
    "STAR-ENG": {
      "minSchoolTier": "211",
      "maxSalaryK": 30,
      "allowedCities": ["深圳"]
    },
    "CRAFT-PE": {
      "maxAge": null,
      "minDegree": "大专",
      "minExperienceByDegree": { "本科": 5, "大专": 7 },
      "maxSalaryK": 22
    }
  }
}
```

### 继承规则

- `defaults`：全岗位默认生效的统一规则。
- `roles[role_id | 岗位名]`：**只写单岗差异项**：
  - 未写字段自动继承 `defaults`；
  - 写具体值覆盖 `defaults`；
  - 显式写 `null` 表示**本岗取消/放宽该全局规则**（如上例 `CRAFT-PE` 的 `"maxAge": null`）。

## 共用 CLI：`skills/recruit-board/scripts/screen-gate.mjs`

`--role` 原生支持传入 `role_id`、标准岗位名或 `_shared/recruit-board.config.json` 中的 `roleAliases`：

```bash
# 1. 校验配置 Schema、合并区间合法性及与 CONTEXT.md 岗位表的匹配度
node skills/recruit-board/scripts/screen-gate.mjs validate --workspace <目录>

# 2. 查看单个岗位的生效规则与每项来源（default / role-override / relaxed-by-role）
node skills/recruit-board/scripts/screen-gate.mjs effective-rules --workspace <目录> --role STAR-ENG

# 3. 单人客观硬门槛预筛（输出 PASS_HARD_GATES / REJECT_HARD_GATE / NEED_DETAIL）
node skills/recruit-board/scripts/screen-gate.mjs evaluate \
  --workspace <目录> \
  --role STAR-ENG \
  --input '{"name":"样例甲","age":31,"degree":"本科","fullTime":true,"school":"虚构理工学院","expectedSalaryK":26,"gapMonths":1,"recentJobCount":2,"inactiveDays":3,"city":"深圳"}'

# 4. 批量预筛候选人卡片数组（过滤掉明显不符项，再由 role-context.mjs + LLM 深评通过者）
node skills/recruit-board/scripts/screen-gate.mjs evaluate-batch \
  --workspace <目录> \
  --role STAR-ENG \
  --input-file runtime/candidates-batch.json
```
