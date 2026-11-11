# 工作经验书（dsh-experience-book）

把一次踩坑后得到的正确做法，留成下一次会自动出现的提醒。

插件会在助手输出、工具调用、工具报错或用户回合开始时检查经验条目。命中后，DSH 会收到一条简短提示，例如：

> 【系统提示】经验提示(t-read-text)：看文本用 read 工具……

看到提示后直接照做并继续当前任务即可，不必回复提示本身。

## 安装与重载

在 DSH 中通过 `plugin_manager` 安装本目录。安装后的插件入口是 `include:experience-book`。

修改插件代码后，用 `plugin_manager` 把这个入口先停用、再启用。宿主支持 HMR 时无需重启；不支持时，按工具返回的提示重启。

## 管理经验

经验通过以下工具维护：

| 工具 | 用途 |
|---|---|
| `experience_list` | 查看、搜索和筛选现有条目；新增前先查重 |
| `experience_check` | 用一段模拟内容预检命中范围，不注入提示、不写统计 |
| `experience_feedback` | 记录“有用”或“误报”，误报达到阈值时提醒处理 |
| `experience_add` | 新增条目；通常让插件自动生成 id |
| `experience_update` | 按 id 修改条目；未提供的字段保持不变 |
| `experience_remove` | 删除过期、重复或写错的条目 |
| `experience_export` | 导出经验包 JSON，默认不带本地统计 |
| `experience_import` | 预览或导入经验包；只有 `commit=true` 才写入 |

例如，让助手记下一条经验：

> 用 experience_add 新增：输出里准备声称“已验证”时，先运行验收命令并报告结果。

提示词应写成可以直接执行的动作，一条只写一件事，最长 160 字。相同提示或相同匹配条件会被查重拦截，此时应修改已有条目。

保存前可以先做 dry-run。例如检查某段输出在指定工作区会命中哪些条目：

```json
{
  "kind": "output",
  "text": "Review this merge request.",
  "workspace": "C:\\proj",
  "modelId": "k3.1-pro"
}
```

`experience_check` 返回命中条目及其提示，但不会注入消息，也不会增加触发或注入次数。要验证带 `workspace`、`mode` 或 `model` 条件的规则，需在 dry-run 中提供对应的模拟值。

## 什么时候触发

| `kind` | 触发时机 | 可匹配的内容 |
|---|---|---|
| `output` | 助手输出或思维落库时 | 关键词、正则、`requireAll` |
| `tool-call` | 工具执行前 | 工具名、参数文本、关键词、正则 |
| `tool-error` | 工具返回错误后 | 错误文本、工具名、关键词、正则 |
| `turn-start` | 每个用户回合开始时 | 不匹配文本，只按类型和作用域判断 |

常用匹配字段：

- `keywords`：任一关键词出现即可，大小写不敏感。
- `regex`：正则命中即可，与 `keywords` 是 OR 关系。
- `requireAll`：列出的词必须全部出现，才继续判断关键词或正则。
- `tools`：只匹配指定工具。
- `window`：仅用于 `output`；`message` 检查单条消息，`round` 检查本回合累积文本。
- `enabled`：是否启用。
- `priority`：同时命中多条时，数值大的优先。

同一用户回合内，同一条目最多提醒一次；每回合默认最多提醒 10 条。错误信息已经给出正确做法时，插件不会再补一条笼统的“记录经验”提示。

## 统计与误报反馈

`experience_list` 分别显示以下数据：

- **触发**：通过本轮去重与数量上限，准备提醒的次数。
- **注入**：`inject` 或回合收尾的 `steer` 实际成功的次数。
- **有用 / 误报**：通过 `experience_feedback` 明确反馈的次数。
- **最近命中 / 最近反馈**：对应事件的最近时间。

提示不相关时，用 `experience_feedback` 记录 `outcome: "irrelevant"`，并尽量写明原因。误报累计达到 `falsePositiveThreshold`（默认 5）后，工具结果会提醒 AI 和用户检查规则；可以用 `experience_update` 缩小条件，或用 `experience_remove` 删除。反馈本身不会自动修改经验。

如果某条经验的关键词确有必要，可以接受它的误报而不再计入误报统计：用 `experience_update` 设置 `ignoreFalsePositives: true`。开启后，`irrelevant` 反馈不增加误报数、不更新反馈时间，也不触发处理提醒；总触发、实际注入和“有用”反馈继续统计，历史误报数保留。设为 `false` 可恢复后续误报统计。`experience_list` 会标出“忽略误报”的条目。

## 条件字段与作用域

所有条件都遵循同一个写法：**留空 = 不加限制；填了才生效**。字段之间相互独立，可以叠加。

| 字段 | 留空 | 填写后 |
|---|---|---|
| `workspace` | 所有工作区 | 绝对路径按目录前缀匹配；单段目录名按路径中的完整目录段匹配 |
| `mode` | 所有会话模式 | 只匹配指定会话模式 |
| `model` | 不限模型 | 当前模型 ID 命中正则才触发，例如 `deepseek-.*` |
| `system` | 普通条目 | `true`：插件自带示例的分类标记，不参与匹配 |

`system` 和 `model` 可以同时出现，例如 `{ system: true, model: 'deepseek-.*' }`：既是系统示例，又只在匹配模型上触发。模型未知时，带 `model` 的条目不触发；`model` 正则必须可编译，`system` 只接受布尔值。

工作区专属事实（例如文档位置、目录约定）更适合写进该工作区的 `AGENTS.md`，经验条目则记录可复用的处理方法。

## 内置条目与个人条目

`lib/seeds/system.js` 是随仓库分发的系统条目，只使用 DSH 自带能力，不依赖其他插件。它们是示例和起点，可以按自己的工作方式修改或删除。

需要保留本机习惯时，可自建已被 Git 忽略的 `lib/seeds/personal.js`；文件缺失不会影响启动：

```js
import { seed } from './helper.js';

export const PERSONAL_SEEDS = [
  seed(
    't-my-habit',
    'output',
    '引用文件前先读取最新内容。',
    { keywords: ['引用文件'] },
  ),
];
```

系统条目与个人条目会在首次初始化时合并载入。之后可以在索引中自由增删；删除的条目不会因普通重载而恢复。

## 导出与导入

`experience_export` 生成 `format: "dsh-experience-book"`、`version: 1` 的 JSON 经验包。默认导出全部规则，并移除命中与反馈统计；可用 `ids` 只导出指定条目。确实需要迁移统计数据时，再设 `includeStats: true`。

把经验包对象或 JSON 字符串传给 `experience_import`，默认只返回预览：哪些会新增、哪些因 id、提示或匹配条件重复而跳过。确认预览后，用相同 `data` 并设 `commit: true` 才会写入。导入不会覆盖已有条目。

## 存储

经验保存在 DSH 的 `experience_book` 存储域，通常位于 `~/.dsh/storages/experience_book.json`，不会写入项目工作区。

工具输出末尾会显示持久化状态：

- `已连接`：改动会写入存储。
- `正在连接…`：存储仍在初始化。
- `仅内存（原因）`：当前改动只保留在进程内，重启后会丢失。

## 配置

`apply(ctx, config)` 支持以下配置：

| 配置 | 默认值 | 用途 |
|---|---|---|
| `enabled` | `true` | 是否启用提醒 |
| `seedOnFirstRun` | `true` | 首次运行时是否载入内置条目 |
| `maxHintsPerTurn` | `10` | 每回合最多提醒几条 |
| `fallbackOnUnknownError` | `true` | 未识别错误是否提示记录经验 |
| `falsePositiveThreshold` | `5` | 累计几次误报后提醒处理，不自动改规则 |
| `openAttempts` | `3` | 存储打开尝试次数 |
| `openRetryMs` | `300` | 存储重试间隔，单位毫秒 |

## 测试

公开形态（不含个人条目）：

```bash
node --test test/book.test.mjs
```

本地存在个人条目时，可再运行：

```bash
node --test test/personal-seeds.test.mjs
```

## 许可

MIT，见 [LICENSE](LICENSE)。
