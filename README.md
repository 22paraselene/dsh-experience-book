# 工作经验书（dsh-experience-book）

把「这次该怎么做」沉淀成可自动触发的经验条：AI 输出命中关键词、工具调用前、工具报错后、或每个用户回合开始时，插件发一行提示；AI 用工具自己增删改索引。

条目分三类：普通条目按信号触发；`system` 只是“插件自带示例”的分类标记，不改变触发；`model` 额外要求当前模型 ID 匹配正则。内置条目拆成两份：`lib/seeds/system.js` 是任何 DSH 环境都成立的基础做法（公开仓库只带这份），`lib/seeds/personal.js` 是本机工作习惯（不发布；缺失时插件照常启动）。

## 类型

| type | 含义 | 对触发的影响 |
|---|---|---|
| 不填 / `''` | 普通经验 | 按 kind、关键词、正则、工具、作用域匹配 |
| `system` | 插件自带条目的分类标记 | 无；仍按普通规则匹配，只用于区分“示例”与“自己写的” |
| `model` | 指定模型 | 在普通匹配之上，还要求当前模型 ID 命中 `model` 正则；模型未知（空字符串）时不触发 |

- `system` 不是权限，也不是“只读”；它只是一个分类，方便用 `experience_list` 的 `type` 过滤查看，也方便公开仓库做文件隔离。
- `model` 必须同时给可编译的 `model` 正则（如 `deepseek-.*`，忽略大小写）；普通条目带 `model` 会被拒绝。目前内置条目里没有 `model` 类型，留空即可。
- 写入时 `type` 只接受 `''` / `system` / `model`；`model` 条目必须有 `model` 正则，`type` 不是 `model` 时带 `model` 会被拒绝。

## 触发类型与作用域

| kind | 时机 | 扫描内容 |
|---|---|---|
| `output` | 助手消息落库 | 正文与思维块文本；`window: "round"` 时扫描整个用户回合累积文本 |
| `tool-call` | 工具执行前 | 工具名 + 参数 JSON |
| `tool-error` | 工具报错后 | 错误消息 + 文本内容 |
| `turn-start` | 用户回合开始 | 不看文本，只按作用域触发一次 |

每条触发器带两个可选作用域字段：

| 字段 | 省略（默认） | 填写后 |
|---|---|---|
| `workspace` | 全局，任何工作区都触发 | 只在匹配的工作区触发；绝对路径按前缀匹配，单段目录名按路径整段相等匹配 |
| `mode` | 全局，任何模式都触发 | 只在指定模式触发；`manager` / `paihuo` / `派活` 走经理判据，其他值与会话 preset 相等 |

两个都填时必须同时满足。字段都省略就是全局触发器。

## 送达与去重

- 提示统一为 `【系统提示】经验提示(<id>)：<下一步动作>`，并带“已读即可：不要回复、不要复述、不要确认，直接执行并继续。”——`formatHint` 是唯一前缀来源。
- 所有路径都经过同一个 `remind(agent, trigger, { session, immediate })`：作用域、每回合一次、整轮上限都在这里判。
- `output` 命中且该消息带工具调用 → `agent.inject` 立即送下一步；纯文本收尾消息 → 进 `pending`，在 `agent/turn-stopping` 用 `agent.steer` 推回当前回合。
- 注入与 steer 的都是完整消息：`{ id, role: 'user', content, source: { kind: 'experience-book' } }`。宿主按 `user/message` 的 data 校验身份，缺 `id`/`role` 会以 `lacks an identified message` 拒绝落库。
- `tool-call` / `tool-error` / `turn-start` 命中 → `agent.inject` 立即送达。
- `type=model` 的条目还要求当前模型 ID 匹配 `model` 正则；模型未知（空字符串）时不触发。模型 ID 由 `agent.model.current()?.model` 读取，测试 harness 没有模型服务时按未知处理。
- 宿主在派发 `session/event` 期间把会话标成 publishing，监听器里再 `session.append` 会被拒（`session append cannot reenter while another append is being published`）。`output` 与 `turn-start` 的立即注入正好落在这个窗口里，所以 `injectNow` 首次被拒时会在派发结束后的微任务重投一次，两次都失败才记警告；否则提示会静默丢失，却已计入命中数并占掉本轮名额。
- 同一 `(用户回合, trigger)` 只发一次；用户回合以 `user/message`（`source.kind === 'user'`）为界，插件自己的 inject/steer 不重置去重。
- 每回合最多 `maxHintsPerTurn` 条（默认 3）。
- 报错文本已含可照做的指引（用法、正确格式、示例等）时，不再补 `t-unknown-error` 兜底提示。

## 经理模式的三条规则

本地 `lib/seeds/personal.js` 带这三条（公开仓库不带，缺失时只是没有它们）：

| id | kind | 触发 | 提示 |
|---|---|---|---|
| `t-reuse` | `turn-start` | 模式 `paihuo`，回合开始 | 派活前先看可复用的空闲工程师 |
| `t-fullrun` | `output` | 关键词 `全量` | 判断能否延后，别默认全量 |
| `t-merge` | `output` / `round` | 整轮同时含 `合并` 与 `paihuo`/`派活`/`分支` | 同批次且文件不重叠才合成一次合并 |

只读会话（例如 `dsh-paihuo` 的经理模式）里，宿主需要把 `experience_list` / `experience_add` / `experience_update` / `experience_remove` 放进该模式的工具白名单，AI 才看得到这些工具。经验书只写自己的 `storageDomain`，不碰工作区文件。

## 工具

- `experience_list`：按 `kind` / `type` / `enabled` / `tag` / `query` / `workspace` / `mode` 查索引，输出 id、类型、作用域、标签、命中数、匹配条件与提示。
- `experience_add`：新增，id 一般自动生成；提示必须正向、单动作、≤160 字；相同提示或相同匹配条件会被拒绝并给出已有 id。
- `experience_update`：按 id 合并字段，未给的保持原值；可改 `type` / `model`。
- `experience_remove`：按 id 删除；过期、重复、写错的条子直接删。

## 提示写法

写“先查 X，再改 Y”这类下一步动作。否定式（“不要…”）在写入时被拒绝：执行时还得先反推出动作，且容易让索引膨胀。系统条目只记跨工作区成立的做法；某个工作区的事实（有没有 `.git`、施工账放在哪）写进该工作区 `AGENTS.md`。个人条目可以记本机习惯，但同样建议把工作区事实留在工作区。

## 让 AI 主动写经验

经验书的价值在“下一次”，不在“这一次”。任务收尾时，让 AI 先问自己一句：

> 这次的做法，下次遇到同样的信号还会用到吗？会，就 `experience_add`；不会，就别写。

写法上只记正向动作、一条一个动作、写清失效条件。个人条目尽管按自己的习惯写；系统条目只放跨环境成立的基础做法。公开仓库里的系统条目是**参考写法与演示**，不是必须遵守的规则——鼓励每个人按自己的工作方式长出自己的经验书。

## 存储与迁移

`storageDomain` 域 `experience_book`（单 global 记录），落在 `~/.dsh/storages/experience_book.json`；域名只能用 `[a-z][a-z0-9_]*`，schema 必须拒绝 `null`（null 是“从未写入”哨兵）。

插件在 `inject` 里声明 `storageDomain`，等宿主 storage backend 就绪后才 apply。open 与 writer 绑定收敛在 `lib/persistence.js` 的模块级单例：多个 apply（配置重载、HMR）共用一份 store；同名域已打开时用 `storage.get()` 复用；open 失败按 `openAttempts` 重试。写入失败会把状态降为“仅内存”，不会假装落盘。

工具输出末尾固定带一行持久化状态：`持久化：已连接`、`持久化：正在连接…` 或 `持久化：仅内存（原因）`。看到“仅内存”就表示这次写入宿主重启后会丢。

状态带 `migrations` 数组而不是靠版本号判断：存储层读回记录会先过 `STATE_SCHEMA`，`version` 会被 `normalizeState` 抬到当前值，按版本号判断会永远跳过迁移。当前状态 `version` 为 4，`migrations` 累积到 `[3, 4]`：

- 迁移 3 只在首次加载旧记录时补三条经理规则，按 id 去重；删掉的规则不会复活。
- 迁移 4 给已存在的系统种子补 `type: 'system'`；不新增条目，也不复活已删除的条目。

内置条目分两份：`lib/seeds/system.js` 只收跨工作区成立的判据（读取、破坏性删除确认、命令不存在、陈旧编辑、完成断言、视觉证据）；`lib/seeds/personal.js` 是本机工作习惯。`lib/seeds/index.js` 用动态导入加载个人条目，只有当错误码是 `ERR_MODULE_NOT_FOUND` 且消息含 `personal.js` 时才跳过——公开仓库没有这份文件也能正常启动。

## 安装

```powershell
plugin_manager install_bundle <本目录绝对路径>
```

装好后入口 id 是 `include:experience-book`。改完代码用 `plugin_manager set_plugin` 对该 id 先 false 再 true 重载；只改文件不会让 host 自动重新加载。

公开仓库只含系统种子。clone 后把目录 link/复制进 profile，按需自建 `lib/seeds/personal.js`（格式见 `lib/seeds/system.js` 的 `seed()` 调用）：

```js
import { seed } from './helper.js';

export const PERSONAL_SEEDS = [
  seed({
    id: 't-my-habit',
    kind: 'tool-call',
    tools: ['pwsh'],
    hint: '先确认目标路径存在，再执行删除。',
  }),
];
```

**重载 vs 重启**：`set_plugin` 的 false→true 走宿主的 `hmr.reconcileProfile()`，它会把已加载模块与磁盘逐文件比对（内容/时间）——只有变了文件的模块会被 evict 后重新 `import()`，`apply()` 再跑一遍；文件没变的模块沿用同一个模块实例（模块级状态、随机 `injectionRun` 都不重置）。所以：

- 改过 `lib/` 后重载一次即可生效，**不需要重启宿主**；验证方法是看注入消息 id 里的 `<run>` 段变化（`exp-<trigger>-<run>-<n>`）。
- 只重载、不改文件，等于重新跑 `apply()`，不会换模块实例。
- 宿主没挂 `hmr` 服务时，`reload()` 只写配置，返回 `application: "restart-required"`、`restartReason: "no-hmr"`，这时才必须重启。

## 可调项

`apply(ctx, config)` 读取 `enabled`、`seedOnFirstRun`、`maxHintsPerTurn`、`fallbackOnUnknownError`、`openAttempts`（默认 3）、`openRetryMs`（默认 300）。插件不导出 `Config`，改默认值直接改 `lib/index.js` 的 `DEFAULTS`。

## 测试

```powershell
node --test test/book.test.mjs
```

公开形态（没有 `lib/seeds/personal.js`）30 条。本地带个人条目时，再加：

```powershell
node --test test/personal-seeds.test.mjs
```

共 33 条，全部通过。覆盖：状态归一化、种子校验、`system` 分类、`model` 门控（含大小写与未知模型）、`type`/`model` 写入校验、匹配与 `requireAll`、作用域、`turn-start`、写入校验、提示前缀、回合判定、v1/v2/v3 迁移、工具写入保留迁移标记；持久化单例/重试/仅内存状态/writer 绑定；注入消息的 `id` 与 `role`；会话派发期被拒后的微任务重投。
