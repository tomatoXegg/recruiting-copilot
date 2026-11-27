import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, readRoleTable } from '../model.mjs';
import {
  compileEffectiveRules,
  evaluateCandidate,
  validateScreeningRules
} from '../screen-gate-domain.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

const RULES_RELATIVE = '_shared/screening-rules.json';
const CONFIG_RELATIVE = '_shared/recruit-board.config.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

async function readWorkspaceTextFile(root, relative, missingCode = null) {
  const file = path.join(root, relative);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (missingCode) throw failure(missingCode, `未找到文件：${relative}`, 404);
      return { status: 'missing', text: null, revision: null, bytes: 0 };
    }
    throw failure('SCREEN_GATE_UNREADABLE', `无法读取文件：${relative}`, 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('SCREEN_GATE_UNSAFE', `文件必须位于工作区内且不能为符号链接：${relative}`, 403);
  }
  if (info.size > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { status: 'ok', text, revision: digest(bytes), bytes: bytes.length };
  } catch {
    throw failure('SCREEN_GATE_ENCODING', `文件不是有效的 UTF-8 文本：${relative}`, 422);
  }
}

async function loadScreeningRules(root) {
  const loaded = await readWorkspaceTextFile(root, RULES_RELATIVE, 'SCREENING_RULES_MISSING');
  let parsed;
  try { parsed = JSON.parse(loaded.text.replace(/^\uFEFF/, '')); }
  catch { throw failure('SCREENING_RULES_INVALID', `${RULES_RELATIVE} 不是有效的 JSON`, 422); }
  return { revision: loaded.revision, config: validateScreeningRules(parsed) };
}

/**
 * Resolve role metadata natively from v0.9.0 CONTEXT.md 7-column role table (`role_id` + `name`)
 * and optional `_shared/recruit-board.config.json` `roleAliases`.
 */
async function loadWorkspaceRoleIndex(root) {
  const context = await readSource(root, 'CONTEXT.md');
  let rows = [];
  if (context.status === 'ok') {
    try { rows = readRoleTable(context.text).rows; }
    catch { rows = []; }
  }
  let roleAliases = {};
  const configSource = await readSource(root, CONFIG_RELATIVE);
  if (configSource.status === 'ok' && rows.length > 0) {
    try {
      const configured = rows.map(row => ({ name: row.name, priority: row.priority, status: row.status, configured: true }));
      roleAliases = readConfig(configSource.text, configured).roleAliases;
    } catch {
      roleAliases = {};
    }
  }
  return { rows, roleAliases };
}

function resolveRoleMetadata(roleIndex, roleQuery) {
  const trimmed = roleQuery.trim();
  const aliased = Object.hasOwn(roleIndex.roleAliases, trimmed) ? roleIndex.roleAliases[trimmed] : trimmed;
  const matchedRow = roleIndex.rows.find(row =>
    (row.roleId !== null && row.roleId === trimmed) ||
    row.name === trimmed ||
    row.name === aliased
  ) ?? null;

  if (!matchedRow) {
    return {
      roleId: null,
      canonicalName: aliased,
      internalPath: null,
      fallbackKeys: aliased !== trimmed ? [aliased] : []
    };
  }
  const fallbackKeys = [];
  if (matchedRow.roleId && matchedRow.roleId !== trimmed) fallbackKeys.push(matchedRow.roleId);
  if (matchedRow.name && matchedRow.name !== trimmed) fallbackKeys.push(matchedRow.name);
  if (aliased !== trimmed && !fallbackKeys.includes(aliased)) fallbackKeys.push(aliased);

  return {
    roleId: matchedRow.roleId,
    canonicalName: matchedRow.name,
    internalPath: matchedRow.internalPath,
    fallbackKeys
  };
}

export async function validateScreeningRulesWorkspace(workspace) {
  const root = await resolveWorkspace(workspace);
  const { revision, config } = await loadScreeningRules(root);
  const roleIndex = await loadWorkspaceRoleIndex(root);
  const roleKeys = Object.keys(config.roles);
  const knownIdentifiers = new Set();
  for (const row of roleIndex.rows) {
    if (row.roleId) knownIdentifiers.add(row.roleId);
    knownIdentifiers.add(row.name);
  }
  const unmatchedRoleKeys = [];
  for (const key of roleKeys) {
    compileEffectiveRules(config, key);
    if (roleIndex.rows.length > 0 && !knownIdentifiers.has(key)) {
      unmatchedRoleKeys.push(key);
    }
  }
  return {
    valid: true,
    revision,
    defaultRuleCount: Object.keys(config.defaults).length,
    roleOverrideCount: roleKeys.length,
    roleOverrides: roleKeys,
    contextRoleCount: roleIndex.rows.length,
    unmatchedRoleKeys
  };
}

export async function getEffectiveRoleRules(workspace, roleQuery) {
  if (typeof roleQuery !== 'string' || !roleQuery.trim()) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '必须指定 --role');
  }
  const root = await resolveWorkspace(workspace);
  const [{ revision, config }, roleIndex] = await Promise.all([
    loadScreeningRules(root),
    loadWorkspaceRoleIndex(root)
  ]);
  const meta = resolveRoleMetadata(roleIndex, roleQuery);
  const preferredKey = meta.roleId ?? roleQuery.trim();
  const fallbacks = [roleQuery.trim(), meta.canonicalName, ...meta.fallbackKeys].filter(key => key && key !== preferredKey);
  const compiled = compileEffectiveRules(config, preferredKey, { fallbackKeys: fallbacks });
  return {
    revision,
    roleId: meta.roleId,
    canonicalName: meta.canonicalName,
    internalPath: meta.internalPath,
    ...compiled
  };
}

export async function evaluateSingleCandidate({ workspace, role, candidate }) {
  const effective = await getEffectiveRoleRules(workspace, role);
  return {
    rulesRevision: effective.revision,
    roleId: effective.roleId,
    canonicalName: effective.canonicalName,
    ...evaluateCandidate(effective, candidate)
  };
}

export async function evaluateCandidateBatch({ workspace, role, candidates }) {
  if (!Array.isArray(candidates)) throw failure('CANDIDATE_INPUT_INVALID', '批量评估输入必须为候选人数组');
  const effective = await getEffectiveRoleRules(workspace, role);
  const results = candidates.map((candidate, index) => ({
    index,
    ...evaluateCandidate(effective, candidate)
  }));
  const summary = {
    total: results.length,
    pass: results.filter(item => item.verdict === 'PASS_HARD_GATES').length,
    reject: results.filter(item => item.verdict === 'REJECT_HARD_GATE').length,
    needDetail: results.filter(item => item.verdict === 'NEED_DETAIL').length
  };
  return {
    rulesRevision: effective.revision,
    roleId: effective.roleId,
    roleKey: effective.roleKey,
    canonicalName: effective.canonicalName,
    summary,
    results
  };
}

async function readInputJSON(flags) {
  if (flags.input !== undefined && flags['input-file'] !== undefined) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '--input 与 --input-file 只能提供一个');
  }
  if (flags.input !== undefined) {
    try { return JSON.parse(flags.input); }
    catch { throw failure('SCREEN_GATE_INPUT_INVALID', '--input 不是有效的 JSON'); }
  }
  if (flags['input-file'] !== undefined) {
    const root = await resolveWorkspace(flags.workspace);
    const real = await realpath(path.resolve(flags['input-file'])).catch(() => {
      throw failure('SCREEN_GATE_INPUT_INVALID', '无法读取 --input-file');
    });
    if (!insideWorkspace(root, real)) throw failure('SCREEN_GATE_UNSAFE', '--input-file 必须位于工作区内', 403);
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', '--input-file 超过读取上限', 422);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('SCREEN_GATE_INPUT_INVALID', '--input-file 不是有效的 UTF-8 JSON'); }
  }
  throw failure('SCREEN_GATE_INPUT_INVALID', '必须提供 --input 或 --input-file 参数');
}

const commandSpecs = {
  validate: { required: ['workspace'], optional: [] },
  'effective-rules': { required: ['workspace', 'role'], optional: [] },
  evaluate: { required: ['workspace', 'role'], optional: ['input', 'input-file'] },
  'evaluate-batch': { required: ['workspace', 'role'], optional: ['input', 'input-file'] }
};

export async function screenGateCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(commandSpecs, command) ? commandSpecs[command] : null;
  if (!spec) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '用法：screen-gate.mjs validate/effective-rules/evaluate/evaluate-batch --workspace <目录> [--role <role_id|岗位名>] ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith('--')) throw failure('SCREEN_GATE_INPUT_INVALID', `无效参数：${flag ?? ''}`);
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || value === undefined || value.startsWith('--')) {
      throw failure('SCREEN_GATE_INPUT_INVALID', `参数无效、重复或缺少值：${flag}`);
    }
    flags[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(flags, key)) throw failure('SCREEN_GATE_INPUT_INVALID', `缺少必填参数：--${key}`);
  }

  if (command === 'validate') return validateScreeningRulesWorkspace(flags.workspace);
  if (command === 'effective-rules') return getEffectiveRoleRules(flags.workspace, flags.role);
  const payload = await readInputJSON(flags);
  if (command === 'evaluate') return evaluateSingleCandidate({ workspace: flags.workspace, role: flags.role, candidate: payload });
  return evaluateCandidateBatch({ workspace: flags.workspace, role: flags.role, candidates: payload });
}

export function screenGateError(error) {
  return {
    error: {
      code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'SCREEN_GATE_FAILED',
      message: error.status || error.code?.startsWith('SCREEN') || error.code?.startsWith('CANDIDATE_')
        ? error.message
        : '初筛硬门槛预筛失败，请检查工作区文件和参数'
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await screenGateCLI(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(screenGateError(error))}\n`);
    process.exitCode = 1;
  }
}
