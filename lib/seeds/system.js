import { seed } from './helper.js';

/**
 * 系统条目：随插件公开分发，只收 DSH 标准工具面、跨工作区成立的做法。
 * 个人习惯与依赖其他插件的条目留在 personal.js。
 * 判据：换一台机器、换一个工作区仍然成立，才放进这里。
 */
export const SYSTEM_SEEDS = [
  seed('t-claim-verified', 'output',
    '说“已验证”前先跑验收命令，把命令与通过数一起写出来。',
    { keywords: ['已验证', '已测试', '测试通过', '验证通过', 'i verified', "i've verified", 'i have verified', 'verification passed', 'test passed', 'tests passed', 'all tests pass'], tag: '证据', priority: 50, system: true }),
  seed('t-visual-evidence', 'output',
    '界面与图片结论先用 read_image 看清楚，没看过就写“未目视”。',
    { keywords: ['截图', '面板', '生成图', 'screenshot shows', 'image shows', 'panel shows', 'visually verified'], tag: '证据', priority: 40, system: true }),
  seed('t-read-text', 'tool-call',
    '看文本用 read 工具（带行号、可分页），命令只用于跑测试与查环境。',
    { regex: '\\b(cat|head|tail|more|Get-Content)\\s', tag: '文件', priority: 30, system: true }),
  seed('t-destructive-delete', 'tool-call',
    '删除前先把目标解析成绝对路径并确认是预期路径，再执行删除。',
    { regex: '(Remove-Item|rmdir|del\\s|rm\\s+-[a-z]*[rf])', tag: '危险操作', priority: 60, system: true }),
  seed('t-cmd-not-found', 'tool-error',
    '命令不存在时先查可用命令与路径，再换正确写法重跑。',
    { regex: '(is not recognized|不是内部或外部命令|CommandNotFound|command not found)', tag: '命令', priority: 50, system: true }),
  seed('t-stale-edit', 'tool-error',
    '替换失败时重读文件的当前内容，按最新文本重取 old_string。',
    { regex: '(old_string|string not found|未找到要替换|no match)', tag: '编辑', priority: 50, system: true }),
];
