/**
 * 「工作经验书」Host 插件入口。
 *
 * 触发面：助手消息（输出与思维）、工具调用前、工具报错后、回合收尾。
 * 提示只发一行，索引由模型通过 experience_* 工具自建、修改、删除。
 */

import { randomUUID } from 'node:crypto';

import {
  formatHint,
  isUserRoundStart,
  looksInstructive,
  matchesTrigger,
  scopeMatches,
} from './book.js';
import { createPersistentStore } from './persistence.js';
import { createTools } from './tools.js';

export const inject = ['tools', 'systemPrompt', 'storageDomain'];

const DEFAULTS = {
  enabled: true,
  seedOnFirstRun: true,
  maxHintsPerTurn: 3,
  fallbackOnUnknownError: true,
  openAttempts: 3,
  openRetryMs: 300,
};

const INJECTION_SOURCE = 'experience-book';
const injectionRun = randomUUID().slice(0, 8);
let injectionSeq = 0;

/**
 * 宿主把 user/message 的 data 当消息本身校验：缺 id 或 role 会以
 * 「lacks an identified message」拒绝落库。id 只需非空且进程内唯一。
 */
function injectionMessage(text, label) {
  injectionSeq += 1;
  return {
    id: `exp-${label}-${injectionRun}-${injectionSeq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: INJECTION_SOURCE },
  };
}

/**
 * 插件可能被 apply 多次（配置重载、HMR），而域是独占资源：模块级单例保证
 * 所有 apply 共用同一个 store 与同一个 writer，不会出现两份互不相干的索引。
 */
let shared = null;

function sharedBook(options) {
  if (shared === null) {
    shared = createPersistentStore({
      seedOnFirstRun: options.seedOnFirstRun !== false,
      attempts: options.openAttempts,
      retryMs: options.openRetryMs,
    });
  }
  return shared;
}

export function __resetExperienceBookForTests() {
  shared = null;
}

export function __experienceBookStateForTests() {
  return shared;
}

const SECTION_TEXT = [
  '## 工作经验书',
  '工具调用、工具报错或你的输出/思维命中经验触发器时，你会收到一行 `【系统提示】经验提示(<id>)：<下一步动作>`；这是系统通知，已读即可：不要回复、不要复述，直接照做并继续。',
  '同一个用户回合内，每条提示最多出现一次；没有新的用户消息时不会重复提醒。',
  '触发器的作用域：不填 workspace / mode 是全局；填 workspace 只在指定工作区触发；填 mode 只在指定会话模式触发；两个都填要同时满足。',
  'turn-start 类型在每个用户回合开始时触发一次，适合“开工前先做什么”的提醒。',
  'type：不填=普通经验；system=插件自带示例，只作分类；model=只在模型 ID 匹配时触发，配 model 正则（如 deepseek-.*），不填 model 不触发。',
  '需要新增、修正或删除经验时，先用 experience_list 查索引，再用 experience_add / experience_update / experience_remove 维护。',
  '新增经验写正向动作（先查 X，再做 Y），一条只写一个动作，不超过 160 字。',
  '报错里已经给出正确格式时直接照做；错误没说清下一步时，再把正确做法写成一条经验。',
  '经验只记跨工作区成立的做法；某个工作区的事实（有没有 .git、文档路径）写进该工作区 AGENTS.md。',
].join('\n');

const UNKNOWN_ERROR = {
  id: 't-unknown-error',
  kind: 'tool-error',
  hint: '用 experience_add 把这次报错的正确做法写成一条正向经验。',
  hits: 0,
};

function errorText(value) {
  const parts = [];
  if (value?.error && typeof value.error === 'object') {
    if (typeof value.error.message === 'string') parts.push(value.error.message);
    if (typeof value.error.reason === 'string') parts.push(value.error.reason);
  }
  if (Array.isArray(value?.content)) {
    for (const block of value.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').slice(0, 4000);
}

function toolCallText(exec) {
  let body = '';
  try {
    body = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments ?? {});
  } catch {
    body = '';
  }
  return `${exec.name ?? ''}\n${body}`;
}

function assistantText(message) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function isMetaTool(name) {
  return typeof name === 'string' && name.startsWith('experience_');
}

function isAbortLike(text) {
  return /\b(aborted|cancelled|canceled|interrupted)\b/i.test(text);
}

function currentModelId(agent) {
  try {
    const current = agent?.model?.current?.();
    return typeof current?.model === 'string' ? current.model : '';
  } catch {
    return '';
  }
}

function warn(ctx, message, error) {
  try {
    const detail = error === undefined ? '' : `：${error?.message ?? error}`;
    ctx.logger?.warn?.(`[experience-book] ${message}${detail}`);
  } catch {
    // 日志不可用时不影响主流程。
  }
}

function info(ctx, message) {
  try {
    ctx.logger?.info?.(`[experience-book] ${message}`);
  } catch {
    // 同上。
  }
}

const modeCache = new Map();

/** paihuo 投影优先于会话头：会话内切换 preset 只写投影，不回头改头。 */
function projectionState(ctx, session) {
  const projections = ctx.get('sessionProjections');
  try {
    const value = projections?.stateOf?.(session, 'paihuo');
    if (value !== undefined) return value;
  } catch {
    // 投影未注册时退回 snapshot。
  }
  try {
    return projections?.snapshot?.(session, ['paihuo'])?.values?.paihuo;
  } catch {
    return undefined;
  }
}

function modeInfo(ctx, session) {
  const sessionId = session?.id ?? '';
  const state = projectionState(ctx, session);
  const headerPreset = session?.header?.agentPreset;
  const signature = `${state?.preset ?? ''}|${state?.role ?? ''}|${headerPreset ?? ''}`;
  const cached = sessionId === '' ? undefined : modeCache.get(sessionId);
  if (cached && cached.signature === signature) return cached.info;

  const info = {
    preset: state?.preset ?? headerPreset ?? '',
    role: state?.role ?? '',
    manager:
      state?.preset === 'paihuo' || headerPreset === 'paihuo' || state?.role === 'manager',
  };
  if (sessionId !== '') {
    if (modeCache.size > 500) modeCache.clear();
    modeCache.set(sessionId, { signature, info });
  }
  return info;
}

function workspaceOf(ctx, session) {
  try {
    const value = ctx.get('workingDirectory')?.get?.(session);
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    // 服务不可用时退回会话头的 cwd。
  }
  return session?.header?.cwd ?? '';
}

function scopeContext(ctx, session) {
  return { workspace: workspaceOf(ctx, session), ...modeInfo(ctx, session) };
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const hub = sharedBook(options);
  const store = hub.store;
  const perAgent = new Map();

  function stateOf(agentId) {
    let state = perAgent.get(agentId);
    if (!state) {
      state = { seen: new Set(), pending: [], roundText: '', turnStart: true };
      perAgent.set(agentId, state);
    }
    return state;
  }

  function collect(kind, { session, text = '', roundText = '', toolName, modelId = '' } = {}) {
    const scope = session ? scopeContext(ctx, session) : { workspace: '', manager: false };
    return store
      .get()
      .triggers.filter((trigger) => scopeMatches(trigger, scope))
      .filter((trigger) =>
        matchesTrigger(
          trigger,
          kind,
          trigger.kind === 'output' && trigger.window === 'round' ? roundText : text,
          toolName,
          modelId,
        ),
      )
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  function injectNow(agent, trigger) {
    trigger.hits += 1;
    store.saveSoon();
    const message = injectionMessage(formatHint(trigger), trigger.id);
    const deliver = () => {
      try {
        const pending = agent.inject(message);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => warn(ctx, '注入经验提示失败', error));
        }
        return true;
      } catch (error) {
        return error;
      }
    };
    const failure = deliver();
    if (failure === true) return;
    // 宿主 Session.commit() 在派发 session/event 期间把会话标记为 publishing，
    // 监听器里再 append 会被拒（session append cannot reenter while another append is
    // being published）。输出类与 turn-start 提示都在该派发内触发，必须等派发结束后的
    // 微任务重投；否则提示静默丢失，却已计入 hits 并占掉本轮 maxHintsPerTurn 名额。
    queueMicrotask(() => {
      const retry = deliver();
      if (retry !== true) warn(ctx, '注入经验提示失败', retry);
    });
  }

  /**
   * 单次提醒的唯一入口：作用域、每轮一次、每轮上限都在这里判。
   * immediate=false 时只进 pending，由 turn-stopping 统一 steer。
   */
  function remind(agent, trigger, { session, immediate = false } = {}) {
    if (!agent || typeof agent.inject !== 'function') return false;
    if (!trigger || trigger.enabled === false) return false;
    const liveSession = session ?? agent.session;
    if (liveSession && !scopeMatches(trigger, scopeContext(ctx, liveSession))) return false;
    const state = stateOf(agent.id);
    if (state.seen.has(trigger.id)) return false;
    if (state.seen.size >= options.maxHintsPerTurn) return false;
    state.seen.add(trigger.id);
    if (immediate) injectNow(agent, trigger);
    else state.pending.push(trigger);
    return true;
  }

  /** 每个用户回合只跑一次；第一批提示立即注入，不等模型先开口。 */
  function fireTurnStart(agent, session) {
    const state = stateOf(agent.id);
    if (!state.turnStart) return;
    state.turnStart = false;
    for (const trigger of collect('turn-start', { session, modelId: currentModelId(agent) })) {
      remind(agent, trigger, { session, immediate: true });
    }
  }

  // ── 提示词与工具 ──────────────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'experience-book',
    order: 2380,
    text: SECTION_TEXT,
  });

  for (const definition of createTools(store, { statusLine: () => hub.persistenceLine() })) {
    ctx.tools.register(definition);
  }

  // ── 助手消息：输出与思维命中 ──────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (!options.enabled || !session || !event || typeof event !== 'object') return;
    const type = event.type;

    // 每轮只在真人用户发来新消息时重置去重；插件自己 inject/steer 的消息不算新的一轮。
    if (type === 'user/message') {
      if (isUserRoundStart(event)) {
        const state = stateOf(session.id);
        state.seen.clear();
        state.pending.length = 0;
        state.roundText = '';
        state.turnStart = true;
        const agent = ctx.get('agents')?.get?.(session.id);
        if (agent) fireTurnStart(agent, session);
      }
      return;
    }
    if (type !== 'assistant/message') return;

    const message = event.data?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return;
    const text = assistantText(message);
    if (text.trim() === '') return;

    const agent = ctx.get('agents')?.get?.(session.id);
    if (!agent) return;
    fireTurnStart(agent, session);

    const state = stateOf(agent.id);
    state.roundText = `${state.roundText}\n${text}`.slice(-8000);
    const continues = message.content.some((block) => block && block.type === 'tool-call');
    for (const trigger of collect('output', { session, text, roundText: state.roundText, modelId: currentModelId(agent) })) {
      remind(agent, trigger, { session, immediate: continues });
    }
  });

  // ── 回合收尾：输出类提示在这里补一句 steer，保证本轮能看到 ─────────────
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      if (!options.enabled) return;
      const agent = payload?.agent;
      if (!agent) return;
      const state = perAgent.get(agent.id);
      if (!state || state.pending.length === 0) return;
      const hints = state.pending.splice(0, state.pending.length);
      const text = hints.map(formatHint).join('\n');
      const pending = agent.steer(injectionMessage(text, 'batch'));
      if (pending && typeof pending.catch === 'function') {
        await pending.catch((error) => warn(ctx, '回合收尾提示失败', error));
      }
    } catch (error) {
      warn(ctx, '回合收尾提示失败', error);
    }
  });

  // ── 工具调用前 ────────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (options.enabled && exec?.agent && !isMetaTool(exec.name)) {
        const session = exec.agent.session;
        const text = toolCallText(exec);
        for (const trigger of collect('tool-call', { session, text, toolName: exec.name, modelId: currentModelId(exec.agent) })) {
          remind(exec.agent, trigger, { session, immediate: true });
        }
      }
    } catch (error) {
      warn(ctx, '工具调用提示失败', error);
    }
    return next();
  });

  // ── 工具报错后 ────────────────────────────────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!options.enabled || !result?.isError) return;
      const agent = exec?.agent;
      if (!agent || isMetaTool(exec.name)) return;
      const text = errorText(result);
      if (isAbortLike(text)) return;

      const session = agent.session;
      const hits = collect('tool-error', { session, text, toolName: exec.name, modelId: currentModelId(agent) });
      if (hits.length > 0) {
        for (const trigger of hits) remind(agent, trigger, { session, immediate: true });
        return;
      }
      if (!options.fallbackOnUnknownError) return;
      if (looksInstructive(text)) return;

      remind(agent, UNKNOWN_ERROR, { session, immediate: true });
    } catch (error) {
      warn(ctx, '工具报错提示失败', error);
    }
  });

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent?.id) {
      perAgent.delete(agent.id);
      modeCache.delete(agent.id);
    }
  });

  // ── 持久化：域可用时载入；不可用时只保存在内存 ─────────────────────────
  // storageDomain 由 storage backend 就绪后 provide；inject 声明后 apply 会等它，
  // 但仍保留 ctx.get 兜底，旧宿主不提供注入时也不至于崩。
  const storage = ctx.storageDomain ?? ctx.get('storageDomain');
  if (!storage || typeof storage.open !== 'function') {
    hub.markUnavailable('storageDomain 不可用');
    warn(ctx, 'storageDomain 不可用，经验索引只保存在内存中');
  } else {
    void hub.connect(storage, {
      info: (message) => info(ctx, message),
      warn: (message, error) => warn(ctx, message, error),
    });
  }
}
