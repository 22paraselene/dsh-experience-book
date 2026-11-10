import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_HINT_LENGTH,
  STATE_SCHEMA,
  addTrigger,
  buildTrigger,
  createEmptyState,
  createStore,
  describeMatch,
  formatHint,
  isNegativeHint,
  isUserRoundStart,
  looksInstructive,
  matchesTrigger,
  modeMatches,
  normalizeState,
  removeTriggers,
  scopeLabel,
  upgradeState,
  updateTrigger,
  workspaceMatches,
} from '../lib/book.js';
import { SYSTEM_SEEDS } from '../lib/seeds/system.js';
import { createTools } from '../lib/tools.js';
import {
  __experienceBookStateForTests,
  __resetExperienceBookForTests,
  apply,
} from '../lib/index.js';

function trigger(overrides = {}) {
  return {
    id: 't-test',
    kind: 'output',
    hint: '先查父目录再建目录。',
    keywords: ['mkdir'],
    regex: '',
    tools: [],
    requireAll: [],
    window: 'message',
    workspace: '',
    mode: '',
    tag: '',
    enabled: true,
    priority: 0,
    hits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('存储 schema 拒绝 null：null 是“从未写入”哨兵', () => {
  assert.equal(STATE_SCHEMA.safeParse(null).success, false);
  assert.equal(STATE_SCHEMA.safeParse(undefined).success, false);
  assert.throws(() => STATE_SCHEMA.parse(null));
  assert.equal(STATE_SCHEMA.safeParse({ triggers: [] }).success, true);
});

test('normalizeState 对坏输入回退为空状态，不复活种子', () => {
  assert.deepEqual(normalizeState(null), { version: 4, migrations: [3, 4], triggers: [] });
  assert.deepEqual(normalizeState({ triggers: 'no' }), { version: 4, migrations: [3, 4], triggers: [] });
  const state = normalizeState({ triggers: [trigger(), { id: 'BAD ID' }, null] });
  assert.equal(state.triggers.length, 1);
  assert.equal(state.triggers[0].id, 't-test');
});

test('种子索引的提示都短、正向、可编译', () => {
  const state = createEmptyState();
  assert.ok(state.triggers.length >= SYSTEM_SEEDS.length);
  const ids = new Set();
  for (const item of state.triggers) {
    assert.ok(item.hint.length > 0 && item.hint.length <= MAX_HINT_LENGTH, item.id);
    assert.equal(isNegativeHint(item.hint), false, `${item.id} 用了否定式提示`);
    assert.equal(ids.has(item.id), false, `重复 id ${item.id}`);
    ids.add(item.id);
    if (item.regex !== '') {
      assert.doesNotThrow(() => new RegExp(item.regex, 'i'), item.id);
    }
  }
});

test('matchesTrigger 按 kind、关键词、正则与工具过滤', () => {
  const output = trigger({ keywords: ['已完成'] });
  assert.equal(matchesTrigger(output, 'output', '报告：已完成清账', undefined), true);
  assert.equal(matchesTrigger(output, 'output', '还在进行', undefined), false);
  assert.equal(matchesTrigger(output, 'tool-call', '已完成', 'pwsh'), false);
  assert.equal(matchesTrigger({ ...output, enabled: false }, 'output', '已完成'), false);

  const byRegex = trigger({ keywords: [], regex: '找不到路径|ENOENT' });
  assert.equal(matchesTrigger(byRegex, 'output', 'Error: ENOENT: no such file'), true);

  const toolCall = trigger({ kind: 'tool-call', tools: ['pwsh'], keywords: ['mkdir'] });
  assert.equal(matchesTrigger(toolCall, 'tool-call', 'pwsh\n{"command":"mkdir a"}', 'pwsh'), true);
  assert.equal(matchesTrigger(toolCall, 'tool-call', 'pwsh\n{"command":"mkdir a"}', 'bash'), false);
});

test('种子提示不写死某个工作区的事实', () => {
  const state = createEmptyState();
  for (const item of state.triggers) {
    assert.doesNotMatch(item.hint, /本工作区|没有 \.git|docs\/改动记录|_tmp_/, item.id);
  }
});



test('写入拒绝否定式提示、超长提示与重复提示', () => {
  const negative = buildTrigger({ hint: '不要用 rm 删目录', keywords: ['rm'] });
  assert.equal(negative.ok, false);
  assert.match(negative.error, /正向动作/);

  const long = buildTrigger({ hint: '先'.repeat(MAX_HINT_LENGTH + 1), keywords: ['x'] });
  assert.equal(long.ok, false);
  assert.match(long.error, /160/);

  const first = addTrigger({ version: 1, triggers: [] }, { hint: '先查父目录再建。', keywords: ['mkdir'] });
  assert.equal(first.ok, true);
  const second = addTrigger(
    { version: 1, triggers: [first.trigger] },
    { hint: '先查父目录再建。', keywords: ['mkdir -p'] },
  );
  assert.equal(second.ok, false);
  assert.match(second.error, new RegExp(first.trigger.id));
});

test('addTrigger 自动生成合法 id 并保留默认值', () => {
  const result = addTrigger({ version: 1, triggers: [] }, {
    hint: '建目录前先列父目录。',
    kind: 'tool-call',
    tools: ['pwsh'],
    regex: 'mkdir',
  });
  assert.equal(result.ok, true);
  assert.match(result.trigger.id, /^[a-z][a-z0-9-]{1,47}$/);
  assert.equal(result.trigger.enabled, true);
  assert.equal(result.trigger.hits, 0);
});

test('updateTrigger 合并字段并保留命中数', () => {
  const existing = trigger({ hits: 7 });
  const result = updateTrigger({ version: 1, triggers: [existing] }, {
    id: 't-test',
    hint: '建目录前先列父目录，再一次建全层级。',
  });
  assert.equal(result.ok, true);
  assert.equal(result.trigger.hint, '建目录前先列父目录，再一次建全层级。');
  assert.deepEqual(result.trigger.keywords, ['mkdir']);
  assert.equal(result.trigger.hits, 7);
});

test('looksInstructive 识别报错里已有的正确格式指引', () => {
  assert.equal(looksInstructive('Get-ChildItem : 找不到路径'), false);
  assert.equal(looksInstructive('CommandNotFoundException: is not recognized'), false);
  assert.equal(looksInstructive(''), false);

  assert.equal(looksInstructive('用法：rg [OPTIONS] PATTERN [PATH]'), true);
  assert.equal(looksInstructive('请使用 --json 指定输出格式'), true);
  assert.equal(looksInstructive('用法: read <path> 例如 read src/index.js'), true);
  assert.equal(looksInstructive('Error: unknown option; try `--help`'), true);
  assert.equal(looksInstructive('Invalid input: expected string, received number'), true);
});

test('removeTriggers 报告删除与缺失', () => {
  const state = { version: 1, triggers: [trigger(), trigger({ id: 't-two' })] };
  const outcome = removeTriggers(state, ['t-test', 't-missing']);
  assert.deepEqual(outcome, { ok: true, removed: ['t-test'], missing: ['t-missing'] });
  assert.equal(removeTriggers(state, []).ok, false);
});

test('系统提示带“已读即可”约束', () => {
  const line = formatHint(trigger({ id: 't-test', hint: '先查父目录，再建目录。' }));
  assert.match(line, /^【系统提示】经验提示\(t-test\)：/);
  assert.match(line, /已读即可/);
  assert.match(line, /不要回复/);
  assert.match(line, /不要复述/);
  assert.match(line, /直接执行并继续/);
  assert.doesNotMatch(line, /无需回复/);
});

test('只有真人用户消息开启新回合', () => {
  assert.equal(isUserRoundStart({ type: 'user/message', data: { source: { kind: 'user' } } }), true);
  assert.equal(isUserRoundStart({ type: 'user/message', data: { source: { kind: 'experience-book' } } }), false);
  assert.equal(isUserRoundStart({ type: 'user/message', data: {} }), false);
  assert.equal(isUserRoundStart({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false);
});

test('插件自身注入消息不重置回合去重，同一回合同一触发器只送一次', () => {
  const handlers = new Map();
  const injected = [];
  const session = { id: 's-1', header: { cwd: 'C:\\proj', agentPreset: 'standard' } };
  const agent = {
    id: 's-1',
    session,
    inject(payload) {
      injected.push(payload);
    },
    steer(payload) {
      injected.push(payload);
    },
  };
  const ctx = {
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    get(name) {
      if (name === 'agents') return new Map([[session.id, agent]]);
      return undefined;
    },
    systemPrompt: { section() {} },
    tools: { register() {} },
    effect() {},
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { seedOnFirstRun: true });
  const emit = (event) => {
    for (const handler of handlers.get('session/event') ?? []) handler(session, event);
  };
  const assistant = {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '已验证，测试通过。' },
          { type: 'tool-call', name: 'pwsh', arguments: {} },
        ],
      },
    },
  };

  emit(assistant);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source.kind, 'experience-book');
  assert.match(injected[0].content[0].text, /已读即可/);
  // 宿主要求 user/message 的 data 自带 id、role、source.kind、content，缺一即拒收。
  assert.equal(typeof injected[0].id, 'string');
  assert.ok(injected[0].id.length > 0);
  assert.equal(injected[0].role, 'user');
  assert.match(injected[0].id, /^exp-t-claim-verified-[0-9a-f]{8}-\d+$/);

  emit(assistant);
  assert.equal(injected.length, 1, '同一回合第二次命中不再注入');

  emit({ type: 'user/message', data: { source: { kind: 'experience-book' } } });
  emit(assistant);
  assert.equal(injected.length, 1, '插件自己 inject 的消息不开启新回合');

  emit({ type: 'user/message', data: { source: { kind: 'user' } } });
  emit(assistant);
  assert.equal(injected.length, 2, '真人用户发来新消息后重新计一轮');
});

test('宿主在 session/event 派发期间拒绝 append 时，提示经微任务重投不丢失', async () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: false });
  await harness.tools.get('experience_add').execute({
    id: 't-reentrant',
    kind: 'output',
    keywords: ['重投验证'],
    hint: '先核对重投后的写入路径。',
  });

  // 宿主 Session.commit() 在派发 session/event 时把会话标记为 publishing，
  // 监听器内再 append 会抛这条错误；派发结束后才允许写入。
  let publishing = true;
  const delivered = [];
  harness.agent.inject = (payload) => {
    if (publishing) throw new Error('session append cannot reenter while another append is being published');
    delivered.push(payload);
  };
  const emit = (event) => {
    for (const handler of harness.handlers.get('session/event') ?? []) handler(harness.session, event);
  };
  emit({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '重投验证：派发期间先被拒。' },
          { type: 'tool-call', name: 'pwsh', arguments: {} },
        ],
      },
    },
  });
  assert.equal(delivered.length, 0, '派发期间注入被宿主拒绝');
  publishing = false;
  await Promise.resolve();
  assert.equal(delivered.length, 1, '派发结束后微任务重投成功');
  assert.match(delivered[0].id, /^exp-t-reentrant-[0-9a-f]{8}-[0-9]+$/);
  __resetExperienceBookForTests();
});

test('作用域：工作区按末段或绝对前缀匹配，模式识别经理别名', () => {
  assert.equal(workspaceMatches('D:\\Users\\35419\\Documents\\deepseek-harness\\default-workspace', 'default-workspace'), true);
  assert.equal(workspaceMatches('D:\\Users\\35419\\Documents\\deepseek-harness\\default-workspace', 'workspace'), false);
  assert.equal(workspaceMatches('D:\\a\\proj\\sub', 'D:\\a\\proj'), true);
  assert.equal(workspaceMatches('D:\\a\\proj2', 'D:\\a\\proj'), false);
  assert.equal(workspaceMatches('D:\\a\\proj', ''), true);

  assert.equal(modeMatches('', { manager: false }), true);
  assert.equal(modeMatches('manager', { manager: true }), true);
  assert.equal(modeMatches('派活', { manager: true }), true);
  assert.equal(modeMatches('manager', { manager: false, preset: 'standard' }), false);
  assert.equal(modeMatches('standard', { preset: 'standard' }), true);
});

test('requireAll 先全含，再走关键词或正则', () => {
  const merge = trigger({ requireAll: ['合并'], keywords: ['paihuo', '派活', '分支'], window: 'round' });
  assert.equal(matchesTrigger(merge, 'output', '先把分支合并，再派活'), true);
  assert.equal(matchesTrigger(merge, 'output', '先派活再说'), false);
  assert.equal(matchesTrigger(merge, 'output', '只说合并'), false);
});

test('turn-start 每轮触发一次，且不允许关键词条件', () => {
  const reuse = trigger({ kind: 'turn-start', keywords: [], regex: '', mode: 'paihuo' });
  assert.equal(matchesTrigger(reuse, 'turn-start', '', undefined), true);
  assert.equal(matchesTrigger(reuse, 'output', '', undefined), false);

  const rejected = buildTrigger({ kind: 'turn-start', hint: '每轮先看可复用会话。', keywords: ['开工'] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /turn-start/);

  const accepted = buildTrigger({ kind: 'turn-start', hint: '每轮先看可复用会话。', mode: 'paihuo' });
  assert.equal(accepted.ok, true);
  assert.equal(scopeLabel(accepted.trigger), 'mode');
});

test('v3 状态升级补迁移 4，并给已有系统种子打 system 分类', () => {
  const v3 = {
    version: 3,
    migrations: [3],
    triggers: [
      trigger({ id: 't-claim-verified', type: '' }),
      trigger({ id: 't-custom' }),
    ],
  };
  const { state } = upgradeState(v3);
  assert.equal(state.version, 4);
  assert.deepEqual(state.migrations, [3, 4]);
  assert.equal(state.triggers.find((item) => item.id === 't-claim-verified').type, 'system');
  assert.equal(state.triggers.find((item) => item.id === 't-custom').type, '');
  assert.equal(upgradeState(state).added.length, 0);
});

test('工具写入保留迁移标记', async () => {
  const store = createStore(createEmptyState());
  const tools = Object.fromEntries(createTools(store).map((item) => [item.name, item]));

  await tools.experience_add.execute({ hint: '先查父目录再建目录。', id: 't-tool-probe', keywords: ['__tool_probe__'] });
  assert.deepEqual(store.get().migrations, [3, 4]);

  await tools.experience_remove.execute({ ids: ['t-tool-probe'] });
  assert.deepEqual(store.get().migrations, [3, 4]);
  assert.equal(store.get().triggers.some((item) => item.id === 't-tool-probe'), false);
});

function assertIdentifiedMessage(message) {
  assert.equal(typeof message?.id, 'string', '缺 message.id');
  assert.ok(message.id.length > 0, 'message.id 为空');
  assert.equal(message.role, 'user', 'user/message 的 role 必须是 user');
  assert.ok(Array.isArray(message.content) && message.content.length > 0, '缺 content');
  assert.equal(typeof message.source?.kind, 'string', '缺 source.kind');
  assert.ok(message.source.kind.length > 0, 'source.kind 为空');
}

function createHarness(storage) {
  const handlers = new Map();
  const injected = [];
  const tools = new Map();
  const sections = [];
  const session = {
    id: `s-${Math.random().toString(16).slice(2)}`,
    header: { cwd: 'C:\\proj', agentPreset: 'standard' },
  };
  const agent = {
    id: session.id,
    session,
    inject(payload) {
      injected.push(payload);
    },
    steer(payload) {
      injected.push(payload);
    },
  };
  const ctx = {
    storageDomain: storage,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    get(name) {
      if (name === 'agents') return new Map([[session.id, agent]]);
      return undefined;
    },
    systemPrompt: { section(definition) { sections.push(definition); } },
    tools: { register(definition) { tools.set(definition.name, definition); } },
    effect() {},
    logger: { info() {}, warn() {} },
  };
  return { ctx, session, agent, handlers, injected, tools, sections };
}

function createStorageMock({ stored = null, failOpens = 0 } = {}) {
  const calls = { opens: 0, writes: [] };
  let snapshot = stored;
  let initial = null;
  let domain = null;
  const storage = {
    get(name) {
      return name === 'experience_book' ? domain : undefined;
    },
    async open(spec) {
      calls.opens += 1;
      if (calls.opens <= failOpens) throw new Error(`open failed ${calls.opens}`);
      initial = spec.global.initial;
      domain = {
        closed: false,
        global: {
          // 真实存储层在快照为 null 时回填 spec.initial，mock 必须一致，否则种子被清空。
          get: () => (snapshot === null ? initial : snapshot),
          set: async (next) => {
            const copy = JSON.parse(JSON.stringify(next));
            calls.writes.push(copy);
            snapshot = copy;
          },
        },
        close: async () => {
          domain.closed = true;
        },
      };
      return domain;
    },
  };
  return { storage, calls };
}

test('持久化：多次 apply 共用一份 store，只打开一次域', async () => {
  __resetExperienceBookForTests();
  const { storage, calls } = createStorageMock();
  const first = createHarness(storage);
  const second = createHarness(storage);
  apply(first.ctx, { seedOnFirstRun: true, openRetryMs: 1 });
  apply(second.ctx, { seedOnFirstRun: true, openRetryMs: 1 });
  const hub = __experienceBookStateForTests();
  await hub.ready();

  assert.equal(calls.opens, 1);
  assert.equal(hub.persistenceLine(), '持久化：已连接');

  await second.tools.get('experience_add').execute({
    hint: '先查父目录再建目录。',
    id: 't-shared-probe',
    keywords: ['__shared_probe__'],
  });
  const listed = await first.tools.get('experience_list').execute({ query: 't-shared-probe' });
  assert.match(listed.text, /t-shared-probe/);
  assert.ok(calls.writes.at(-1).triggers.some((item) => item.id === 't-shared-probe'));
  __resetExperienceBookForTests();
});

test('持久化：打开失败按次数重试，成功后绑定 writer', async () => {
  __resetExperienceBookForTests();
  const { storage, calls } = createStorageMock({ failOpens: 2 });
  const harness = createHarness(storage);
  apply(harness.ctx, {
    seedOnFirstRun: true,
    openAttempts: 3,
    openRetryMs: 1,
  });
  const hub = __experienceBookStateForTests();
  await hub.ready();

  assert.equal(calls.opens, 3);
  assert.equal(hub.persistenceLine(), '持久化：已连接');

  await harness.tools.get('experience_add').execute({
    hint: '先查父目录再建目录。',
    id: 't-retry-probe',
    keywords: ['__retry_probe__'],
  });
  assert.ok(calls.writes.length > 0);
  assert.ok(calls.writes.at(-1).triggers.some((item) => item.id === 't-retry-probe'));
  __resetExperienceBookForTests();
});

test('持久化：打开彻底失败时工具输出标明仅内存', async () => {
  __resetExperienceBookForTests();
  const { storage, calls } = createStorageMock({ failOpens: 99 });
  const harness = createHarness(storage);
  apply(harness.ctx, {
    seedOnFirstRun: true,
    openAttempts: 2,
    openRetryMs: 1,
  });
  await __experienceBookStateForTests().ready();

  assert.equal(calls.opens, 2);
  const listed = await harness.tools.get('experience_list').execute({});
  assert.match(listed.text, /持久化：仅内存/);
  __resetExperienceBookForTests();
});

test('持久化：服务缺失时标明仅内存，注入消息仍带完整身份', async () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: true });
  await __experienceBookStateForTests().ready();

  const listed = await harness.tools.get('experience_list').execute({});
  assert.match(listed.text, /持久化：仅内存/);

  const emit = (event) => {
    for (const handler of harness.handlers.get('session/event') ?? []) handler(harness.session, event);
  };
  emit({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '已验证，测试通过。' },
          { type: 'tool-call', name: 'pwsh', arguments: {} },
        ],
      },
    },
  });
  assert.ok(harness.injected.length > 0);
  for (const message of harness.injected) assertIdentifiedMessage(message);
  const ids = harness.injected.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length, '同一次运行内 id 必须唯一');
  __resetExperienceBookForTests();
});

test('同一回合命中超过上限时只注入 maxHintsPerTurn 条', async () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: false });
  const add = harness.tools.get('experience_add');
  for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    await add.execute({
      id: `t-limit-${word}`,
      kind: 'output',
      keywords: [word],
      hint: `先核对 ${word} 输入。`,
    });
  }

  const emit = (event) => {
    for (const handler of harness.handlers.get('session/event') ?? []) handler(harness.session, event);
  };
  const assistant = {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'alpha beta gamma delta epsilon 全部命中。' },
          { type: 'tool-call', name: 'pwsh', arguments: {} },
        ],
      },
    },
  };

  emit(assistant);
  assert.equal(harness.injected.length, 3, '五条命中时只注入上限三条');
  assert.equal(new Set(harness.injected.map((message) => message.id)).size, 3);

  emit(assistant);
  assert.equal(harness.injected.length, 3, '上限内已注入的不再重复');
  __resetExperienceBookForTests();
});

test('经验新增后同一实例立刻命中，不要求重载', async () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: false });
  await harness.tools.get('experience_add').execute({
    id: 't-live-add',
    kind: 'tool-call',
    tools: ['ops_glob'],
    keywords: ['liveaddprobe'],
    hint: '先确认新增探针命中再继续。',
  });

  const pre = harness.handlers.get('tools/pre-execute');
  const exec = {
    name: 'ops_glob',
    arguments: { pattern: ['**/liveaddprobe*'] },
    agent: harness.agent,
  };
  await pre[0](exec, () => ({ kind: 'allow' }));

  assert.equal(harness.injected.length, 1);
  assert.match(harness.injected[0].content[0].text, /t-live-add/);
  __resetExperienceBookForTests();
});

test('经验改工具名后同一实例立刻命中，不要求重载', async () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: false });
  await harness.tools.get('experience_add').execute({
    id: 't-live-update',
    kind: 'tool-call',
    tools: ['pwsh'],
    keywords: ['liveupdateprobe'],
    hint: '先确认改工具名后的探针命中再继续。',
  });

  const pre = harness.handlers.get('tools/pre-execute')[0];
  const exec = {
    name: 'ops_glob',
    arguments: { pattern: ['**/liveupdateprobe*'] },
    agent: harness.agent,
  };
  await pre(exec, () => ({ kind: 'allow' }));
  assert.equal(harness.injected.length, 0, '旧工具名不应命中');

  await harness.tools.get('experience_update').execute({
    id: 't-live-update',
    tools: ['ops_glob'],
  });
  await pre(exec, () => ({ kind: 'allow' }));

  assert.equal(harness.injected.length, 1);
  assert.match(harness.injected[0].content[0].text, /t-live-update/);
  __resetExperienceBookForTests();
});

test('system 类型只是分类，不改变匹配', () => {
  const system = trigger({ type: 'system', keywords: ['系统分类探针'] });
  assert.equal(matchesTrigger(system, 'output', '系统分类探针命中', undefined, ''), true);
  assert.match(describeMatch(system), /系统条目/);
});

test('model 类型按模型 ID 正则门控，模型未知不触发', () => {
  const built = buildTrigger({
    hint: '在匹配的模型上先查上下文再回答。',
    keywords: ['模型门控探针'],
    type: 'model',
    model: 'deepseek-.*',
  });
  assert.equal(built.ok, true);
  const modelTrigger = built.trigger;
  assert.equal(matchesTrigger(modelTrigger, 'output', '模型门控探针', undefined, 'deepseek-chat'), true);
  assert.equal(matchesTrigger(modelTrigger, 'output', '模型门控探针', undefined, 'DeepSeek-Reasoner'), true);
  assert.equal(matchesTrigger(modelTrigger, 'output', '模型门控探针', undefined, 'gpt-4o'), false);
  assert.equal(matchesTrigger(modelTrigger, 'output', '模型门控探针', undefined, ''), false);
  assert.match(describeMatch(modelTrigger), /模型/);
});

test('type/model 写入校验', () => {
  const missingModel = buildTrigger({ hint: '缺模型正则。', keywords: ['x'], type: 'model' });
  assert.equal(missingModel.ok, false);
  assert.match(missingModel.error, /model 正则/);

  const badModel = buildTrigger({ hint: '坏模型正则。', keywords: ['x'], type: 'model', model: '[' });
  assert.equal(badModel.ok, false);
  assert.match(badModel.error, /model 正则编译失败/);

  const strayModel = buildTrigger({ hint: '普通条目带模型。', keywords: ['x'], model: 'gpt' });
  assert.equal(strayModel.ok, false);

  const badType = buildTrigger({ hint: '非法类型。', keywords: ['x'], type: 'other' });
  assert.equal(badType.ok, false);

  const system = buildTrigger({ hint: '系统分类条目。', keywords: ['x'], type: 'system' });
  assert.equal(system.ok, true);
  assert.equal(system.trigger.type, 'system');
});

test('系统条目只收通用做法且带 system 分类', () => {
  const state = createEmptyState();
  const systems = state.triggers.filter((item) => item.type === 'system');
  assert.equal(systems.length, SYSTEM_SEEDS.length);
  const ids = systems.map((item) => item.id);
  assert.ok(ids.includes('t-claim-verified'));
  assert.ok(ids.includes('t-read-text'));
  assert.ok(!ids.includes('t-fullrun'));
  assert.ok(!ids.includes('t-merge'));
  assert.ok(!ids.includes('t-reuse'));
  for (const item of SYSTEM_SEEDS) {
    assert.equal(item.mode, '', item.id);
    assert.equal(item.workspace, '', item.id);
    assert.deepEqual(item.tools, [], item.id);
  }
  assert.doesNotMatch(
    JSON.stringify(SYSTEM_SEEDS),
    /paihuo|派活|pwsh|personal|t-fullrun|t-merge|t-reuse/i,
  );
});

test('公开系统提示与工具说明不依赖本地条目或其他插件', () => {
  __resetExperienceBookForTests();
  const harness = createHarness();
  apply(harness.ctx, { seedOnFirstRun: false });
  const section = harness.sections.find((item) => item.name === 'experience-book');
  assert.ok(section);
  assert.match(section.text, /填 mode 只在指定会话模式触发/);
  assert.doesNotMatch(section.text, /paihuo|派活|personal|t-fullrun|t-merge|t-reuse/i);

  const definitions = createTools(createStore({ triggers: [] }));
  assert.doesNotMatch(JSON.stringify(definitions), /paihuo|派活|pwsh/i);
  __resetExperienceBookForTests();
});
