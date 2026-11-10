import { SYSTEM_SEEDS } from './system.js';

let personalSeeds = [];
try {
  personalSeeds = (await import('./personal.js')).PERSONAL_SEEDS;
} catch (error) {
  // 公开仓库不带 personal.js；只有“这个文件不存在”才允许静默跳过，
  // 文件存在但内部报错（语法、依赖）必须暴露出来。
  const missingPersonal =
    error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.message ?? '').includes('personal.js');
  if (!missingPersonal) throw error;
}

/**
 * 系统条目随插件公开分发；personal.js 是本地文件（见 .gitignore），缺失时只跑系统条目。
 * 同一份插件代码因此既能本地带个人经验，也能直接公开推送。
 */
export const SEEDS = [...SYSTEM_SEEDS, ...personalSeeds];
