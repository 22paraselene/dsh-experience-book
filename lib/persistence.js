/**
 * 经验索引的进程级存储连接。
 *
 * storageDomain 由宿主在 storage backend 就绪后异步 provide，插件 apply 可能
 * 早于它；域又是独占资源，同名第二次 open 会抛 already-open。所以 open 与
 * writer 绑定必须收敛到一处：一个 store、一个域、一个写入链，失败按次数重试，
 * 已打开的域直接复用。
 */

import {
  STATE_SCHEMA,
  createEmptyState,
  createStore,
  emptyState,
  upgradeState,
} from './book.js';

export const DOMAIN_NAME = 'experience_book';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_MS = 300;
const MAX_REASON_CHARS = 80;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function reasonOf(error) {
  const text = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '未知错误';
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

/** 宿主用 DomainError.code 标记独占冲突；旧版本只给 message。 */
function isAlreadyOpen(error) {
  return error?.code === 'already-open' || /already open/i.test(reasonOf(error));
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function createPersistentStore(options = {}) {
  const attempts = positiveInt(options.attempts, DEFAULT_ATTEMPTS);
  const retryMs = nonNegativeNumber(options.retryMs, DEFAULT_RETRY_MS);
  const store =
    options.seedOnFirstRun === false
      ? createStore(emptyState())
      : createStore(createEmptyState());
  const status = { state: 'pending', error: null };
  let domain = null;
  let opening = null;
  let logger = { info() {}, warn() {} };

  function bindWriter(nextDomain) {
    store.setWriter(async (snapshot) => {
      try {
        await nextDomain.global.set(snapshot);
        status.state = 'connected';
        status.error = null;
      } catch (error) {
        status.state = 'memory';
        status.error = reasonOf(error);
        logger.warn('经验索引写入失败，后续只保存在内存', error);
        throw error;
      }
    });
  }

  function adopt(nextDomain) {
    // 存储层把 null 当「从未写入」哨兵，真实读取时已回填 initial，这里不做兜底。
    const upgraded = upgradeState(nextDomain.global.get());
    domain = nextDomain;
    store.replace(upgraded.state);
    bindWriter(nextDomain);
    status.state = 'connected';
    status.error = null;
    return upgraded;
  }

  async function openOnce(storage) {
    try {
      const handle = await storage.open({
        name: DOMAIN_NAME,
        version: 1,
        layout: 'single',
        invalidRecords: 'backup-and-skip',
        global: { schema: STATE_SCHEMA, initial: store.snapshot() },
        tables: {},
      });
      return { handle, reused: false };
    } catch (error) {
      if (!isAlreadyOpen(error)) throw error;
      const existing = typeof storage.get === 'function' ? storage.get(DOMAIN_NAME) : undefined;
      if (!existing) throw error;
      return { handle: existing, reused: true };
    }
  }

  async function openWithRetry(storage) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await openOnce(storage);
      } catch (error) {
        lastError = error;
        logger.warn(`经验索引存储打开失败（第 ${attempt}/${attempts} 次），稍后重试`, error);
        if (attempt < attempts) await sleep(retryMs * attempt);
      }
    }
    throw lastError;
  }

  /**
   * 幂等：并发调用共用同一个 opening；成功后不再打开第二次。
   * 失败不抛给调用方（插件不能因为存储不可用而起不来），状态写进 status。
   */
  function connect(storage, log) {
    if (log) logger = log;
    if (opening) return opening;
    if (status.state === 'connected') return Promise.resolve({ connected: true });
    status.state = 'pending';
    status.error = null;
    opening = (async () => {
      try {
        const { handle, reused } = await openWithRetry(storage);
        const upgraded = adopt(handle);
        await store.flush().catch(() => {
          // writer 已把 status 置为 memory，flush 的拒绝不再上抛。
        });
        if (status.state === 'connected') {
          logger.info(
            `已载入 ${upgraded.state.triggers.length} 条经验触发器${reused ? '（复用已打开的域）' : ''}`,
          );
          if (upgraded.added.length > 0) {
            logger.info(`已从 v${upgraded.from} 升级，补入 ${upgraded.added.join('、')}`);
          }
        }
        return { connected: status.state === 'connected', reused };
      } catch (error) {
        status.state = 'memory';
        status.error = reasonOf(error);
        logger.warn('经验索引存储不可用，本次运行只保存在内存', error);
        return { connected: false };
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  function ready() {
    return opening ?? Promise.resolve({ connected: status.state === 'connected' });
  }

  function markUnavailable(error) {
    if (status.state === 'connected') return;
    status.state = 'memory';
    status.error = reasonOf(error ?? 'storageDomain 不可用');
  }

  function persistenceLine() {
    if (status.state === 'connected') return '持久化：已连接';
    if (status.state === 'pending') return '持久化：正在连接（本次写入尚未确认落盘）';
    return status.error
      ? `持久化：仅内存（${status.error}）`
      : '持久化：仅内存（宿主重启后本次写入会丢失）';
  }

  return {
    store,
    status,
    domain: () => domain,
    connect,
    ready,
    markUnavailable,
    persistenceLine,
  };
}
