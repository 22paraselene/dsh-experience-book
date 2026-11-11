import { buildTrigger, normalizeTrigger, triggerMetrics } from './book.js';

export const EXPORT_FORMAT = 'dsh-experience-book';
export const EXPORT_VERSION = 1;

function requestedIds(ids) {
  if (!Array.isArray(ids)) return null;
  return new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean));
}

/** 默认只分享规则本身，不带本地命中与反馈数据。 */
export function exportTriggers(state, { ids, includeStats = false } = {}) {
  const wanted = requestedIds(ids);
  const selected = wanted
    ? state.triggers.filter((trigger) => wanted.has(trigger.id))
    : state.triggers;
  const found = new Set(selected.map((trigger) => trigger.id));
  return {
    document: {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      triggers: selected.map((trigger) => {
        const normalized = normalizeTrigger(trigger);
        return includeStats ? normalized : { ...normalized, ...triggerMetrics() };
      }),
    },
    missing: wanted ? [...wanted].filter((id) => !found.has(id)) : [],
  };
}

/**
 * 导入先构造完整预览；只有调用方明确提交时才使用返回的 state。
 * id、提示和匹配条件沿用新增条目的同一套去重判据。
 */
export function planImport(state, input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, error: '导入内容不是有效 JSON。' };
    }
  }
  if (!data || data.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION) {
    return { ok: false, error: `只支持 ${EXPORT_FORMAT} version ${EXPORT_VERSION} 的经验包。` };
  }
  if (!Array.isArray(data.triggers)) {
    return { ok: false, error: '经验包缺少 triggers 数组。' };
  }

  const accepted = [];
  const skipped = [];
  let working = state.triggers;
  for (const item of data.triggers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ id: '(无效条目)', reason: '条目必须是对象' });
      continue;
    }
    const id = String(item?.id ?? '').trim();
    if (id && working.some((trigger) => trigger.id === id)) {
      skipped.push({ id, reason: 'id 已存在' });
      continue;
    }
    const built = buildTrigger(item, null, working);
    if (!built.ok) {
      skipped.push({ id: id || '(未提供 id)', reason: built.error });
      continue;
    }
    const trigger = normalizeTrigger({
      ...built.trigger,
      createdAt: item.createdAt ?? built.trigger.createdAt,
      updatedAt: item.updatedAt ?? built.trigger.updatedAt,
      ...triggerMetrics(item),
    });
    accepted.push(trigger);
    working = [...working, trigger];
  }
  return { ok: true, accepted, skipped, state: { ...state, triggers: working } };
}
