/**
 * 工作经验书：状态形状、种子索引、匹配与写入校验。
 *
 * 判据：经验提示写成“下一步做什么”。否定式提示（“不要…”）会让索引膨胀、
 * 且执行时还得先反推动作，所以写入入口直接拒绝；提示统一用正向祈使句。
 */

import { SEEDS } from './seeds/index.js';
import { SYSTEM_SEEDS } from './seeds/system.js';

export const STATE_VERSION = 4;
export const TRIGGER_KINDS = ['output', 'tool-error', 'tool-call', 'turn-start'];
export const TRIGGER_TYPES = ['system', 'model'];
export const TRIGGER_WINDOWS = ['message', 'round'];
export const MAX_HINT_LENGTH = 160;
export const MAX_LIST_ITEMS = 12;
export const MAX_SCOPE_LENGTH = 120;

const NEGATIVE_START = /^(千万)?(不要|别|勿|禁止|切勿|不可|不能|避免|没必要|严禁)/;
const NEGATIVE_ANY = /(不要|禁止|切勿|严禁|请勿)/;

/** 合并自 fullrun-reminder 的三条经理模式规则：升级旧状态时只补这三条，不复活其他被删种子。 */
const MANAGER_SEED_IDS = ['t-fullrun', 't-merge', 't-reuse'];
export const MANAGER_SEEDS = SEEDS.filter((item) => MANAGER_SEED_IDS.includes(item.id));

function materialize(item, now) {
  return {
    ...item,
    keywords: [...item.keywords],
    tools: [...item.tools],
    requireAll: [...item.requireAll],
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyState() {
  return { version: STATE_VERSION, migrations: [3, 4], triggers: [] };
}

export function createEmptyState() {
  const now = Date.now();
  return {
    version: STATE_VERSION,
    migrations: [3, 4],
    triggers: SEEDS.map((item) => materialize(item, now)),
  };
}

/**
 * 把旧状态升到当前版本。迁移标记用 migrations 而不是 version：存储层读回记录会先过
 * STATE_SCHEMA，version 已被 normalizeState 抬到当前值，按 version 判断会永远跳过迁移。
 * 迁移 3 只补三条经理规则，按 id 去重；迁移 4 只给已有系统种子打 system 分类。
 * 其他种子被用户删过的不复活；分类也只改 type 为空的条目，不覆盖用户已改的类型。
 */
export function upgradeState(raw) {
  const from = Number(raw?.version) || 1;
  const state = normalizeState(raw);
  const applied = new Set(state.migrations);
  const added = [];
  if (state.triggers.length > 0 && !applied.has(3)) {
    const now = Date.now();
    for (const seedTrigger of MANAGER_SEEDS) {
      if (state.triggers.some((item) => item.id === seedTrigger.id)) continue;
      state.triggers.push(materialize(seedTrigger, now));
      added.push(seedTrigger.id);
    }
    applied.add(3);
  }
  if (!applied.has(4)) {
    for (const seedTrigger of SYSTEM_SEEDS) {
      const existingTrigger = state.triggers.find((item) => item.id === seedTrigger.id);
      if (existingTrigger && existingTrigger.type === '') existingTrigger.type = 'system';
    }
    applied.add(4);
  }
  state.migrations = [...applied].sort((left, right) => left - right);
  return { state, from, added };
}

export function normalizeHint(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,，、\n]/);
  const out = [];
  for (const item of items) {
    const text = String(item ?? '').trim();
    if (text === '' || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makeId(kind) {
  const stamp = Date.now().toString(36).slice(-4);
  const rand = Math.random().toString(36).slice(2, 6);
  return `t-${kind}-${stamp}${rand}`;
}

export function isNegativeHint(hint) {
  return NEGATIVE_START.test(hint) || NEGATIVE_ANY.test(hint);
}

export function normalizeTrigger(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? '').trim();
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) return null;
  if (!TRIGGER_KINDS.includes(value.kind)) return null;
  const hint = normalizeHint(value.hint).slice(0, MAX_HINT_LENGTH);
  if (hint === '') return null;
  const type = TRIGGER_TYPES.includes(value.type) ? value.type : '';
  const model = type === 'model' ? String(value.model ?? '').trim().slice(0, MAX_SCOPE_LENGTH) : '';
  return {
    id,
    kind: value.kind,
    hint,
    keywords: normalizeList(value.keywords),
    regex: typeof value.regex === 'string' ? value.regex.trim() : '',
    tools: normalizeList(value.tools),
    requireAll: normalizeList(value.requireAll),
    window: TRIGGER_WINDOWS.includes(value.window) ? value.window : 'message',
    workspace: normalizeScope(value.workspace),
    mode: normalizeScope(value.mode),
    type,
    model,
    tag: typeof value.tag === 'string' ? value.tag.trim().slice(0, 24) : '',
    enabled: value.enabled !== false,
    priority: finiteNumber(value.priority, 0),
    hits: Math.max(0, Math.trunc(finiteNumber(value.hits, 0))),
    createdAt: finiteNumber(value.createdAt, 0),
    updatedAt: finiteNumber(value.updatedAt, 0),
  };
}

function normalizeScope(value) {
  return String(value ?? '').trim().slice(0, MAX_SCOPE_LENGTH);
}

/**
 * 存储层用到的 schema 形状；不用 zod，打开域时只要求 parse / safeParse。
 * 必须拒绝 null/undefined：存储层把 null 当“从未写入”的哨兵，接受 null 的 schema
 * 会在 openDomain 时被直接拒绝，域打不开就只能退回内存态。
 */
export const STATE_SCHEMA = {
  parse(value) {
    if (value == null) throw new Error('state must not be null');
    return normalizeState(value);
  },
  safeParse(value) {
    if (value == null) return { success: false, error: new Error('state must not be null') };
    try {
      return { success: true, data: normalizeState(value) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.triggers)) return emptyState();
  const triggers = [];
  const ids = new Set();
  for (const raw of value.triggers) {
    const trigger = normalizeTrigger(raw);
    if (!trigger || ids.has(trigger.id)) continue;
    ids.add(trigger.id);
    triggers.push(trigger);
  }
  return { version: STATE_VERSION, migrations: normalizeMigrations(value.migrations), triggers };
}

function normalizeMigrations(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => Number.isInteger(item) && item > 0))].sort(
    (left, right) => left - right,
  );
}

function samePattern(left, right) {
  const key = (trigger) =>
    [
      trigger.kind,
      [...trigger.keywords].sort().join('|'),
      [...trigger.requireAll].sort().join('|'),
      trigger.regex,
      [...trigger.tools].sort().join('|'),
      trigger.window,
      trigger.workspace,
      trigger.mode,
      trigger.type,
      trigger.model,
    ].join('::');
  return key(left) === key(right);
}

/**
 * 合并默认值并校验一条触发器。existing 非空时按 id 保留未提供的字段。
 * 返回 { ok: true, trigger } 或 { ok: false, error }。
 */
export function buildTrigger(input = {}, existing = null, all = []) {
  const kind = TRIGGER_KINDS.includes(input.kind) ? input.kind : existing?.kind ?? 'output';
  const hint = normalizeHint(input.hint !== undefined ? input.hint : existing?.hint);
  const keywords = normalizeList(input.keywords !== undefined ? input.keywords : existing?.keywords);
  const tools = normalizeList(input.tools !== undefined ? input.tools : existing?.tools);
  const requireAll = normalizeList(input.requireAll !== undefined ? input.requireAll : existing?.requireAll);
  const regex = String(input.regex !== undefined ? input.regex : existing?.regex ?? '').trim();
  const window = TRIGGER_WINDOWS.includes(input.window)
    ? input.window
    : TRIGGER_WINDOWS.includes(existing?.window)
      ? existing.window
      : 'message';
  const workspace = normalizeScope(input.workspace !== undefined ? input.workspace : existing?.workspace);
  const mode = normalizeScope(input.mode !== undefined ? input.mode : existing?.mode);
  const type = input.type !== undefined
    ? (TRIGGER_TYPES.includes(input.type) ? input.type : null)
    : (existing?.type ?? '');
  if (type === null) {
    return { ok: false, error: `type 只能是 ${TRIGGER_TYPES.join(' / ')}（不填=普通经验）。` };
  }
  const model = String(input.model !== undefined ? input.model : existing?.model ?? '').trim();
  const tag = String(input.tag !== undefined ? input.tag : existing?.tag ?? '').trim().slice(0, 24);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled !== false;
  const priority = finiteNumber(input.priority, existing?.priority ?? 0);
  const providedId = String(input.id ?? '').trim();
  const id = existing?.id ?? (providedId !== '' ? providedId : makeId(kind));

  if (hint === '') return { ok: false, error: 'hint 不能为空：写一句可执行的下一步动作。' };
  if (hint.length > MAX_HINT_LENGTH) {
    return { ok: false, error: `提示词 ${hint.length} 字，压到 ${MAX_HINT_LENGTH} 字以内。` };
  }
  if (isNegativeHint(hint)) {
    return { ok: false, error: '提示词写正向动作，例如“先查父目录再建”，把“不要…”改成下一步做什么。' };
  }
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) {
    return { ok: false, error: `id 不合法：用小写字母、数字、短横线，以字母开头（${id}）。` };
  }
  if (kind === 'turn-start') {
    if (keywords.length > 0 || regex !== '') {
      return { ok: false, error: 'turn-start 在每轮开始时触发，不需要 keywords / regex；删掉这些匹配条件。' };
    }
  } else if (kind === 'tool-call') {
    if (keywords.length === 0 && regex === '' && requireAll.length === 0 && tools.length === 0) {
      return { ok: false, error: 'tool-call 触发器至少给 tools、keywords 或 regex 之一，否则每次工具调用都会触发。' };
    }
  } else if (keywords.length === 0 && regex === '' && requireAll.length === 0) {
    return { ok: false, error: `${kind} 触发器至少给一个 keywords、requireAll 或 regex，否则永远不会触发。` };
  }
  if (regex !== '') {
    try {
      new RegExp(regex, 'i');
    } catch (error) {
      return { ok: false, error: `正则编译失败：${error?.message ?? error}` };
    }
  }
  if (type === 'model') {
    if (model === '') {
      return { ok: false, error: 'type=model 需要 model 正则：写能匹配模型 ID 的表达式，例如 deepseek-.*。' };
    }
    try {
      new RegExp(model, 'i');
    } catch (error) {
      return { ok: false, error: `model 正则编译失败：${error?.message ?? error}` };
    }
  } else if (model !== '') {
    return { ok: false, error: '只有 type=model 才能配 model 正则；把 type 改成 model，或删掉 model。' };
  }

  const now = Date.now();
  const trigger = {
    id,
    kind,
    hint,
    keywords,
    regex,
    tools,
    requireAll,
    window,
    workspace,
    mode,
    type,
    model,
    tag,
    enabled,
    priority,
    hits: existing?.hits ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const others = all.filter((item) => item.id !== id);
  const sameHint = others.find(
    (item) =>
      item.hint.toLowerCase() === hint.toLowerCase() &&
      item.workspace === workspace &&
      item.mode === mode,
  );
  if (sameHint) {
    return { ok: false, error: `已有相同提示的触发器 ${sameHint.id}：改它，不要新建。` };
  }
  const duplicate = others.find((item) => samePattern(item, trigger));
  if (duplicate) {
    return { ok: false, error: `已有匹配条件相同的触发器 ${duplicate.id}：改它，不要新建。` };
  }
  return { ok: true, trigger };
}

export function addTrigger(state, input = {}) {
  return buildTrigger(input, null, state.triggers);
}

export function updateTrigger(state, input = {}) {
  const id = String(input?.id ?? '').trim();
  if (id === '') return { ok: false, error: 'update 需要 id，先用 experience_list 查。' };
  const existing = state.triggers.find((item) => item.id === id);
  if (!existing) return { ok: false, error: `没有 id 为 ${id} 的触发器；先用 experience_list 查现有索引。` };
  return buildTrigger(input, existing, state.triggers);
}

export function removeTriggers(state, ids) {
  const wanted = normalizeList(ids);
  if (wanted.length === 0) return { ok: false, error: 'remove 需要 ids（至少一个）。' };
  const removed = [];
  const missing = [];
  for (const id of wanted) {
    const found = state.triggers.find((item) => item.id === id);
    if (found) removed.push(found.id);
    else missing.push(id);
  }
  if (removed.length === 0) {
    return { ok: false, error: `没有找到：${missing.join('、')}；先用 experience_list 查。` };
  }
  return { ok: true, removed, missing };
}

export function matchesTrigger(trigger, kind, text, toolName, modelId = '') {
  if (!trigger || !trigger.enabled || trigger.kind !== kind) return false;
  if (trigger.type === 'model') {
    const wanted = String(trigger.model ?? '');
    if (modelId === '' || wanted === '') return false;
    try {
      if (!new RegExp(wanted, 'i').test(modelId)) return false;
    } catch {
      return false;
    }
  }
  if (kind === 'turn-start') return true;
  const tools = trigger.tools ?? [];
  if (tools.length > 0 && (!toolName || !tools.includes(toolName))) return false;

  const haystack = String(text ?? '');
  const keywords = trigger.keywords ?? [];
  const requireAll = trigger.requireAll ?? [];
  const hasKeywords = keywords.length > 0;
  const hasRegex = trigger.regex !== '';
  const hasRequire = requireAll.length > 0;
  if (!hasKeywords && !hasRegex && !hasRequire) return kind === 'tool-call' && tools.length > 0;

  const lower = haystack.toLowerCase();
  if (hasRequire) {
    for (const token of requireAll) {
      if (!lower.includes(token.toLowerCase())) return false;
    }
  }

  if (hasKeywords) {
    for (const keyword of keywords) {
      if (lower.includes(keyword.toLowerCase())) return true;
    }
  }
  if (hasRegex) {
    try {
      if (new RegExp(trigger.regex, 'i').test(haystack)) return true;
    } catch {
      return false;
    }
  }
  return hasRequire && !hasKeywords && !hasRegex;
}

/** 作用域判据：工作区按路径末段或绝对前缀匹配，模式按 preset / manager 别名匹配。 */
export function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

export function workspaceMatches(cwd, wanted) {
  const actual = normalizePath(cwd);
  const scope = normalizePath(wanted);
  if (scope === '') return true;
  if (actual === '') return false;
  if (actual === scope) return true;
  // 绝对路径按前缀算；只有末段名（如 default-workspace）按整段相等算，避免子串误命中。
  if (/^[a-z]:\//.test(scope) || scope.includes('/')) {
    return actual.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
  }
  return actual.split('/').includes(scope);
}

export function modeMatches(wanted, info = {}) {
  const scope = String(wanted ?? '').trim().toLowerCase();
  if (scope === '') return true;
  if (scope === 'manager' || scope === 'paihuo' || scope === '派活') {
    return info.manager === true;
  }
  return String(info.preset ?? '').toLowerCase() === scope;
}

export function scopeMatches(trigger, context = {}) {
  return (
    workspaceMatches(context.workspace ?? '', trigger.workspace ?? '') &&
    modeMatches(trigger.mode ?? '', context)
  );
}

export function scopeLabel(trigger) {
  if (trigger.workspace && trigger.mode) return 'workspace+mode';
  if (trigger.workspace) return 'workspace';
  if (trigger.mode) return 'mode';
  return 'global';
}

/**
 * 报错文本是否已经含有可照做的指引（用法、正确格式、示例等）。
 * 判据：错误本身已经把正确写法送到模型面前时，再补一条“去查正确写法”
 * 只会增加噪声，也让模型把已解决的问题重复记成经验。
 */
const INSTRUCTION_HINTS = [
  /用\s*法|语\s*法|正确格式|格式(为|是|如下)|示\s*例|应(写|为|当)/,
  /请(使用|改用|传入|提供|指定)|可以(使用|改用)|改(用|成)/,
  /例如|比如|参考|参数说明|可用参数/,
  /\busage\b|\bsyntax\b|\bdid you mean\b|\bexpected\b|\bexample\b|\bsuggestion\b|\bhint\b|\btry\s+`/i,
];

export function looksInstructive(text) {
  const value = String(text ?? '');
  if (value.trim() === '') return false;
  return INSTRUCTION_HINTS.some((pattern) => pattern.test(value));
}

export function describeMatch(trigger) {
  const keywords = trigger.keywords ?? [];
  const tools = trigger.tools ?? [];
  const requireAll = trigger.requireAll ?? [];
  const parts = [];
  if (trigger.type === 'system') parts.push('系统条目');
  if (trigger.type === 'model') parts.push(`模型 /${trigger.model}/i`);
  if (trigger.workspace) parts.push(`工作区 ${trigger.workspace}`);
  if (trigger.mode) parts.push(`模式 ${trigger.mode}`);
  if (trigger.kind === 'output' && trigger.window === 'round') parts.push('整轮累积');
  if (requireAll.length > 0) parts.push(`同时含 ${requireAll.join('/')}`);
  if (tools.length > 0) parts.push(`工具 ${tools.join('/')}`);
  if (keywords.length > 0) parts.push(`关键词 ${keywords.join('/')}`);
  if (trigger.regex !== '') parts.push(`正则 /${trigger.regex}/i`);
  if (parts.length === 0) return trigger.kind === 'turn-start' ? '每轮开始' : '无匹配条件';
  return parts.join(' · ');
}

export function formatHint(trigger) {
  return `【系统提示】经验提示(${trigger.id})：${trigger.hint}\n（已读即可：不要回复、不要复述、不要确认，直接执行并继续。）`;
}

/** 只有真人用户发来的消息才开启新的“一轮”；插件自己注入/steer 的消息不重置去重。 */
export function isUserRoundStart(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user';
}

/** 状态存储：内存立即改，落盘串行且合并短时间内的多次写入。 */
export function createStore(initial, writer = null) {
  let state = initial;
  let saveTimer = null;
  let chain = Promise.resolve();

  const snapshot = () => JSON.parse(JSON.stringify(state));

  function persist() {
    if (!writer) return chain;
    const snap = snapshot();
    chain = chain.then(() => writer(snap)).catch(() => {});
    return chain;
  }

  return {
    get: () => state,
    replace(next) {
      state = next;
    },
    setWriter(next) {
      writer = typeof next === 'function' ? next : null;
    },
    saveSoon() {
      if (!writer || saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void persist();
      }, 300);
      if (typeof saveTimer.unref === 'function') saveTimer.unref();
    },
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await persist();
    },
    snapshot,
  };
}
