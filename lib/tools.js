/**
 * 模型工具面：查、增、改、删工作经验触发器。
 *
 * 写入入口统一走 book.js 的 buildTrigger，正向动作用词与查重只在那里做一次。
 */

import {
  TRIGGER_KINDS,
  SCOPE_CONDITIONS,
  TRIGGER_CONDITIONS,
  TRIGGER_TYPES,
  TRIGGER_WINDOWS,
  addTrigger,
  describeMatch,
  removeTriggers,
  scopeLabel,
  updateTrigger,
} from './book.js';

const ANY_OBJECT = { type: 'object', additionalProperties: true };

function blocks(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function renderResult(_args, value) {
  if (value === null || typeof value !== 'object') return blocks(String(value ?? ''));
  const title = typeof value.title === 'string' ? value.title : '';
  const body = typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2);
  return blocks(title === '' || body.startsWith(title) ? body : `${title}\n${body}`);
}

const KIND_PROP = {
  type: 'string',
  enum: TRIGGER_KINDS,
  description:
    'output=输出或思维里出现关键词；tool-error=工具报错；tool-call=工具调用；turn-start=每个用户回合开始时',
};

function optionalFields() {
  return {
    kind: KIND_PROP,
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '命中的关键词，大小写不敏感，多个关键词是 OR 关系',
    },
    regex: { type: 'string', description: '命中的正则，与 keywords 也是 OR 关系' },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: '只在这些工具上触发，例如 ["read"]',
    },
    requireAll: {
      type: 'array',
      items: { type: 'string' },
      description: '这些词必须同时出现才继续看 keywords / regex，AND 关系，例如 ["合并"]',
    },
    window: {
      type: 'string',
      enum: TRIGGER_WINDOWS,
      description: 'output 的匹配窗口：message=单条消息（默认）；round=用户回合内累积',
    },
    ...Object.fromEntries(
      TRIGGER_CONDITIONS.map((condition) => [
        condition.key,
        { type: 'string', description: condition.description },
      ]),
    ),
    type: {
      type: 'string',
      enum: TRIGGER_TYPES,
      description: '不填=普通经验；system=插件自带分类；model=只在模型 ID 匹配时触发，需同时给 model',
    },
    tag: { type: 'string', description: '分组标签，例如 清账 / 文档 / 测试' },
    priority: { type: 'number', description: '越大越先触发，默认 0' },
    enabled: { type: 'boolean', description: '是否启用，默认 true' },
  };
}

export function createTools(store, options = {}) {
  const statusLine =
    typeof options.statusLine === 'function' ? options.statusLine : () => '';

  function result(title, lines) {
    const body = [title, ...lines.filter(Boolean)];
    const persistence = statusLine();
    if (persistence) body.push(persistence);
    return {
      shape: 'text',
      title,
      text: body.join('\n'),
    };
  }

  return [
    {
      name: 'experience_list',
      description:
        '查工作经验索引。新建经验前用它查重；怀疑提示缺失、过期或写错时用它看现状。可按 kind、type、enabled、tag、workspace、mode、query 过滤。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: KIND_PROP,
          type: { type: 'string', enum: TRIGGER_TYPES, description: '按类型筛选：system / model' },
          enabled: { type: 'boolean', description: '只看启用（true）或停用（false）的触发器' },
          tag: { type: 'string', description: '按标签筛选' },
          ...Object.fromEntries(
            SCOPE_CONDITIONS.map((condition) => [
              condition.key,
              {
                type: 'string',
                description: `只看绑定到这个${condition.label}的触发器（不含全局）`,
              },
            ]),
          ),
          query: { type: 'string', description: '在 id、提示词、关键词、标签里搜索' },
        },
      },
      output: { schema: ANY_OBJECT, render: renderResult },
      execute: async (args = {}) => {
        const state = store.get();
        let list = state.triggers;
        if (typeof args.kind === 'string' && args.kind !== '') {
          list = list.filter((item) => item.kind === args.kind);
        }
        if (typeof args.type === 'string' && args.type !== '') {
          list = list.filter((item) => item.type === args.type);
        }
        if (typeof args.enabled === 'boolean') {
          list = list.filter((item) => item.enabled === args.enabled);
        }
        if (typeof args.tag === 'string' && args.tag.trim() !== '') {
          const tag = args.tag.trim();
          list = list.filter((item) => item.tag.includes(tag));
        }
        for (const condition of SCOPE_CONDITIONS) {
          const value = typeof args[condition.key] === 'string' ? args[condition.key].trim() : '';
          if (value !== '') {
            list = list.filter((item) => item[condition.key] === value);
          }
        }
        if (typeof args.query === 'string' && args.query.trim() !== '') {
          const query = args.query.trim().toLowerCase();
          list = list.filter((item) =>
            [item.id, item.hint, item.tag, item.keywords.join(' ')]
              .join(' ')
              .toLowerCase()
              .includes(query),
          );
        }

        const sorted = [...list].sort(
          (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
        );
        const enabledCount = state.triggers.filter((item) => item.enabled).length;
        const lines = [
          `索引共 ${state.triggers.length} 条（启用 ${enabledCount}），本次列出 ${sorted.length} 条。`,
        ];
        if (sorted.length === 0) lines.push('没有符合条件的触发器。');
        for (const item of sorted) {
          const typeLabel = item.type ? ` · ${item.type}` : '';
          lines.push(
            `[${item.id}] ${item.kind}${typeLabel} · ${scopeLabel(item)}${item.enabled ? '' : ' · 停用'}${item.tag ? ` · #${item.tag}` : ''} · 命中 ${item.hits}`,
          );
          lines.push(`  匹配：${describeMatch(item)}`);
          lines.push(`  提示：${item.hint}`);
        }
        return result('工作经验索引', lines);
      },
    },
    {
      name: 'experience_add',
      description:
        '把刚学到的正确做法写成一条触发器。提示词只写正向动作（先查 X，再做 Y），一条只写一个动作，不超过 160 字。可用 workspace / mode 限定作用域，不填=全局。只记跨工作区成立的做法；某个工作区的事实（有没有 .git、文档路径）写进该工作区 AGENTS.md。写前先用 experience_list 查重；相同提示或相同匹配条件不要新建，改已有那条。type 不填=普通经验；system 只是插件自带条目的分类；model 只在模型 ID 匹配时触发，需同时给 model 正则。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hint: { type: 'string', description: '一句话经验，写下一步动作，≤160 字' },
          id: { type: 'string', description: '自定义 id；一般省略，自动生成 t-…' },
          ...optionalFields(),
        },
        required: ['hint'],
      },
      output: { schema: ANY_OBJECT, render: renderResult },
      execute: async (args = {}) => {
        const state = store.get();
        const built = addTrigger(state, args);
        if (!built.ok) return result('未新增', [built.error]);
        store.replace({ ...state, triggers: [...state.triggers, built.trigger] });
        await store.flush().catch(() => {});
        return result('已新增经验触发器', [
          `[${built.trigger.id}] ${built.trigger.kind} · ${built.trigger.hint}`,
          `匹配：${describeMatch(built.trigger)}`,
          '下次命中时模型会收到这条提示。',
        ]);
      },
    },
    {
      name: 'experience_update',
      description:
        '修正已有触发器：改提示措辞、换关键词/正则/requireAll/作用域、调窗口、工具过滤、优先级、类型或启停。先 experience_list 拿 id；没给的字段保持原值。提示词同样写正向动作，≤160 字。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要修改的触发器 id' },
          hint: { type: 'string', description: '新的一句话经验，写下一步动作，≤160 字' },
          ...optionalFields(),
        },
        required: ['id'],
      },
      output: { schema: ANY_OBJECT, render: renderResult },
      execute: async (args = {}) => {
        const state = store.get();
        const built = updateTrigger(state, args);
        if (!built.ok) return result('未修改', [built.error]);
        store.replace({
          ...state,
          triggers: state.triggers.map((item) =>
            item.id === built.trigger.id ? built.trigger : item,
          ),
        });
        await store.flush().catch(() => {});
        return result('已更新经验触发器', [
          `[${built.trigger.id}] ${built.trigger.kind}${built.trigger.enabled ? '' : ' · 停用'}`,
          `匹配：${describeMatch(built.trigger)}`,
          `提示：${built.trigger.hint}`,
        ]);
      },
    },
    {
      name: 'experience_remove',
      description:
        '删除过期、重复或写错的触发器。先 experience_list 拿 id；能删掉的就不要只停用，旧索引留着会被再次读到。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要删除的触发器 id 列表',
          },
          id: { type: 'string', description: '只删一条时的简写' },
        },
      },
      output: { schema: ANY_OBJECT, render: renderResult },
      execute: async (args = {}) => {
        const state = store.get();
        const ids = Array.isArray(args.ids) && args.ids.length > 0
          ? args.ids
          : typeof args.id === 'string' && args.id !== ''
            ? [args.id]
            : [];
        const outcome = removeTriggers(state, ids);
        if (!outcome.ok) return result('未删除', [outcome.error]);
        store.replace({
          ...state,
          triggers: state.triggers.filter((item) => !outcome.removed.includes(item.id)),
        });
        await store.flush().catch(() => {});
        const lines = [`已删除：${outcome.removed.join('、')}`];
        if (outcome.missing.length > 0) lines.push(`没找到：${outcome.missing.join('、')}`);
        return result('已删除经验触发器', lines);
      },
    },
  ];
}
