/**
 * 种子条目的统一形状：系统条目（随仓库分发）与个人条目（本地）共用。
 * 字段与 normalizeTrigger 对齐；materialize 负责补时间与克隆数组。
 */
export function seed(id, kind, hint, match = {}) {
  return {
    id,
    kind,
    hint,
    keywords: match.keywords ?? [],
    regex: match.regex ?? '',
    tools: match.tools ?? [],
    requireAll: match.requireAll ?? [],
    window: match.window ?? 'message',
    workspace: match.workspace ?? '',
    mode: match.mode ?? '',
    system: match.system === true,
    model: match.model ?? '',
    tag: match.tag ?? '',
    enabled: true,
    priority: match.priority ?? 0,
    hits: 0,
    triggerCount: 0,
    injectedCount: 0,
    usefulCount: 0,
    falsePositiveCount: 0,
    lastHitAt: 0,
    lastFeedbackAt: 0,
    lastFeedbackReason: '',
    createdAt: 0,
    updatedAt: 0,
  };
}
