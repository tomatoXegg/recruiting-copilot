import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compileEffectiveRules,
  evaluateCandidate,
  validateScreeningRules
} from '../skills/recruit-board/screen-gate-domain.mjs';
import {
  evaluateCandidateBatch,
  evaluateSingleCandidate,
  getEffectiveRoleRules,
  screenGateCLI,
  screenGateError,
  validateScreeningRulesWorkspace
} from '../skills/recruit-board/scripts/screen-gate.mjs';

const sampleRules = {
  schemaVersion: 1,
  defaults: {
    maxAge: 35,
    minDegree: '本科',
    requireFullTime: true,
    excludeEducationTypes: ['专升本', '非全日制'],
    maxGapMonths: 6,
    maxRecentJobs: 3,
    exemptIfLongestTenureMonths: 24,
    maxInactiveDays: 30
  },
  schoolEquivalents: {
    虚构理工学院: '211'
  },
  excludedSchools: ['虚构独立学院'],
  roles: {
    'STAR-ENG': {
      minSchoolTier: '211',
      maxSalaryK: 30,
      allowedCities: ['深圳']
    },
    'CRAFT-PE': {
      maxAge: null,
      minDegree: '大专',
      minExperienceByDegree: { 本科: 5, 大专: 7 },
      maxSalaryK: 22
    }
  }
};

const sampleContext = [
  '# CONTEXT.md —— 虚构工作区',
  '',
  '## 四、在招岗位与优先级',
  '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
  '|---|---|---|---|---|---|---|',
  '| STAR-ENG | 星图程序岗 | 急岗 | 在招 | `01-jd/星图程序岗.md` | `01-jd/_internal/星图程序岗.md` | — |',
  '| CRAFT-PE | 云帆工艺岗 | 常规 | 在招 | `01-jd/云帆工艺岗.md` | `01-jd/_internal/云帆工艺岗.md` | — |',
  ''
].join('\n');

async function createWorkspace(t, { rules = sampleRules, context = sampleContext, config = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-screen-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '_shared'), { recursive: true });
  if (rules !== null) await writeFile(path.join(root, '_shared/screening-rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
  if (context !== null) await writeFile(path.join(root, 'CONTEXT.md'), context);
  if (config !== null) await writeFile(path.join(root, '_shared/recruit-board.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

test('统一规则 + 单岗覆盖 + null 放宽合并准确且记录来源，非法规则被拒绝', () => {
  const star = compileEffectiveRules(sampleRules, 'STAR-ENG');
  assert.equal(star.rules.maxAge, 35);
  assert.equal(star.provenance.maxAge, 'default');
  assert.equal(star.rules.maxSalaryK, 30);
  assert.equal(star.provenance.maxSalaryK, 'role-override');
  assert.equal(star.rules.minSchoolTier, '211');

  // CRAFT-PE 用 null 放宽全局 maxAge
  const craft = compileEffectiveRules(sampleRules, 'CRAFT-PE');
  assert.equal(Object.hasOwn(craft.rules, 'maxAge'), false);
  assert.equal(craft.provenance.maxAge, 'relaxed-by-role');
  assert.equal(craft.rules.minDegree, '大专');
  assert.equal(craft.provenance.minDegree, 'role-override');

  // 未配置覆盖的岗位自动继承 defaults
  const generic = compileEffectiveRules(sampleRules, 'NEW-ROLE');
  assert.equal(generic.hasRoleOverride, false);
  assert.equal(generic.rules.maxAge, 35);
  assert.equal(generic.rules.minDegree, '本科');

  // 非法配置校验
  assert.throws(() => validateScreeningRules({ schemaVersion: 2 }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(() => validateScreeningRules({ schemaVersion: 1, defaults: { maxAge: null } }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(() => validateScreeningRules({ schemaVersion: 1, defaults: { minAge: 40, maxAge: 30 } }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(
    () => compileEffectiveRules({ schemaVersion: 1, defaults: { minAge: 35 }, roles: { 'ROLE-X': { maxAge: 30 } } }, 'ROLE-X'),
    error => error.code === 'SCREENING_RULES_INVALID'
  );
});

test('确定性硬门槛预筛覆盖三态（通过 / 否决 / 缺字段）、院校等价、分学历年限与工龄豁免', () => {
  const star = compileEffectiveRules(sampleRules, 'STAR-ENG');

  // 1. 通过：院校等价命 211 + 跳槽 4 段但最长单段 30 月触发豁免
  const passed = evaluateCandidate(star, {
    name: '样例甲',
    age: 31,
    degree: '本科',
    fullTime: true,
    educationType: '统招',
    school: '虚构理工学院',
    expectedSalaryK: 28,
    gapMonths: 2,
    recentJobCount: 4,
    longestTenureMonths: 30,
    inactiveDays: 5,
    city: '深圳'
  });
  assert.equal(passed.verdict, 'PASS_HARD_GATES');
  assert.equal(passed.failedRules.length, 0);
  assert.equal(passed.missingFields.length, 0);

  // 2. 否决：超龄 + 专升本 + 黑名单院校 + 薪资超上限 + 城市不符
  const rejected = evaluateCandidate(star, {
    name: '样例乙',
    age: 38,
    degree: '本科',
    fullTime: true,
    educationType: '专升本',
    school: '虚构独立学院',
    expectedSalaryK: 36,
    gapMonths: 1,
    recentJobCount: 2,
    inactiveDays: 2,
    city: '北京'
  });
  assert.equal(rejected.verdict, 'REJECT_HARD_GATE');
  const failedNames = new Set(rejected.failedRules.map(item => item.rule));
  assert.ok(failedNames.has('maxAge'));
  assert.ok(failedNames.has('excludeEducationTypes'));
  assert.ok(failedNames.has('excludedSchools'));
  assert.ok(failedNames.has('maxSalaryK'));
  assert.ok(failedNames.has('allowedCities'));

  // 3. 缺字段：列表页缺 age 和 expectedSalaryK，且已提供字段均未触发否决 -> NEED_DETAIL
  const needDetail = evaluateCandidate(star, {
    name: '样例丙',
    degree: '本科',
    fullTime: true,
    schoolTier: '211',
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 1,
    city: '深圳'
  });
  assert.equal(needDetail.verdict, 'NEED_DETAIL');
  assert.ok(needDetail.missingFields.includes('age'));
  assert.ok(needDetail.missingFields.includes('expectedSalaryK'));

  // 4. 分学历年限门槛（CRAFT-PE：大专须 7 年，且全局 maxAge 已用 null 放宽）
  const craft = compileEffectiveRules(sampleRules, 'CRAFT-PE');
  const seniorPass = evaluateCandidate(craft, {
    name: '样例丁',
    age: 42,
    degree: '大专',
    fullTime: true,
    experienceYears: 8,
    expectedSalaryK: 20,
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 4
  });
  assert.equal(seniorPass.verdict, 'PASS_HARD_GATES');

  const shortExpReject = evaluateCandidate(craft, {
    name: '样例戊',
    age: 29,
    degree: '大专',
    fullTime: true,
    experienceYears: 5,
    expectedSalaryK: 18,
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 4
  });
  assert.equal(shortExpReject.verdict, 'REJECT_HARD_GATE');
  assert.equal(shortExpReject.failedRules[0].rule, 'minExperienceByDegree');
});

test('原生对接 v0.9.0 七列表 role_id、标准岗位名与 roleAliases 解析', async t => {
  const root = await createWorkspace(t, {
    config: { schemaVersion: 1, statusStages: {}, roleAliases: { 星图旧称: '星图程序岗' } }
  });
  for (const query of ['STAR-ENG', '星图程序岗', '星图旧称']) {
    const effective = await getEffectiveRoleRules(root, query);
    assert.equal(effective.roleId, 'STAR-ENG');
    assert.equal(effective.canonicalName, '星图程序岗');
    assert.equal(effective.matchedRoleKey, 'STAR-ENG');
    assert.equal(effective.rules.maxSalaryK, 30);
    assert.equal(effective.internalPath, '01-jd/_internal/星图程序岗.md');
  }

  const validated = await validateScreeningRulesWorkspace(root);
  assert.equal(validated.valid, true);
  assert.deepEqual(validated.unmatchedRoleKeys, []);
});

test('validate 检出未匹配到 CONTEXT.md 岗位表的残留规则键', async t => {
  const root = await createWorkspace(t, {
    rules: {
      ...sampleRules,
      roles: { ...sampleRules.roles, 'GHOST-ROLE': { maxAge: 30 } }
    }
  });
  const validated = await validateScreeningRulesWorkspace(root);
  assert.equal(validated.valid, true);
  assert.deepEqual(validated.unmatchedRoleKeys, ['GHOST-ROLE']);
});

test('批量预筛、CLI 端到端与符号链接越权保护', async t => {
  const root = await createWorkspace(t);
  const batch = await evaluateCandidateBatch({
    workspace: root,
    role: 'STAR-ENG',
    candidates: [
      { name: '合格甲', age: 30, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' },
      { name: '超龄乙', age: 40, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' },
      { name: '缺龄丙', degree: '本科', fullTime: true, schoolTier: '211', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' }
    ]
  });
  assert.equal(batch.roleId, 'STAR-ENG');
  assert.deepEqual(batch.summary, { total: 3, pass: 1, reject: 1, needDetail: 1 });

  const single = await evaluateSingleCandidate({
    workspace: root,
    role: '星图程序岗',
    candidate: { name: '合格甲', age: 30, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' }
  });
  assert.equal(single.roleId, 'STAR-ENG');
  assert.equal(single.verdict, 'PASS_HARD_GATES');

  const cliRules = await screenGateCLI(['effective-rules', '--workspace', root, '--role', 'CRAFT-PE']);
  assert.equal(cliRules.roleId, 'CRAFT-PE');
  assert.equal(cliRules.provenance.maxAge, 'relaxed-by-role');

  await assert.rejects(screenGateCLI(['unknown', '--workspace', root]), error => {
    const formatted = screenGateError(error);
    assert.equal(formatted.error.code, 'SCREEN_GATE_INPUT_INVALID');
    return true;
  });

  // 符号链接越权保护
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-outside-gate-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'rules.json'), JSON.stringify(sampleRules));
  await rm(path.join(root, '_shared/screening-rules.json'));
  await symlink(path.join(outside, 'rules.json'), path.join(root, '_shared/screening-rules.json'));
  await assert.rejects(validateScreeningRulesWorkspace(root), error => error.code === 'SCREEN_GATE_UNSAFE' && error.status === 403);
});
