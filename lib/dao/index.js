'use strict';
/**
 * 统一 DAO 入口：业务代码只认这一层，不关心底层是 DuckDB 还是 JSONL。
 *
 * engine 语义（docs/dev/01-architecture.md §3.3）：
 *   duckdb — 全走 DuckDB；不可用时启动失败，**不静默降级**
 *   jsonl  — 全走 JSONL（原生模块装不上时的强制降级模式）
 *   auto   — 能开 DuckDB 就用，否则自动降级并 log.warn
 */
const path = require('path');
const config = require('../config');
const log = require('../log');

// 读写分开缓存：duckdao 已是「每次操作开关实例」的短连接，缓存对象本身不占文件锁；
// 但若把 /api/health 首次打开的只读实例复用给写操作，会报 read-only（实测踩过）。
let cachedRW = null;
let cachedRO = null;
let lastError = null;

function engineOrder() {
  const e = String(config.storage.engine || 'auto').toLowerCase();
  if (e === 'duckdb') return ['duckdb'];
  if (e === 'jsonl') return ['jsonl'];
  return ['duckdb', 'jsonl'];
}

async function build(target, opts) {
  opts = opts || {};
  if (target === 'duckdb') {
    const { create, probe } = require('./duckdao');
    const p = probe();
    if (!p.available) throw new Error(`DuckDB 驱动不可用：${p.reason}`);
    const dbPath = config.abs(config.storage.ownDb);
    // 启动断言：自有库绝不能与上游行情库是同一个文件（09 §2.2）
    const marketDb = config.localDb && config.localDb.marketDb ? config.abs(config.localDb.marketDb) : null;
    if (marketDb && path.resolve(marketDb) === path.resolve(dbPath)) {
      throw new Error(`配置错误：storage.ownDb 与 localDb.marketDb 指向同一文件（${dbPath}）。前者可写、后者只读，必须分开。`);
    }
    const store = create(dbPath, { readOnly: !!opts.readOnly });
    // 只读连接不能建表：跳过迁移。表不存在时查询会抛错，由调用方兜住。
    if (!opts.readOnly) await store.migrate();
    return store;
  }

  const { create } = require('./jsondao');
  const dir = path.join(config.abs('data'), 'jsonl');
  const store = create(dir);
  await store.migrate();
  return store;
}

/** 打开（并缓存）store；幂等 */
async function open(opts) {
  opts = opts || {};                    // build() 会读 opts.readOnly，绝不能传 undefined
  const ro = !!opts.readOnly;
  const cached = ro ? cachedRO : cachedRW;
  if (cached) return cached;
  const order = engineOrder();
  const errors = [];
  for (const target of order) {
    try {
      const s = await build(target, opts);
      const degraded = target !== order[0];
      if (degraded) {
        log.warn('store.degraded', { wanted: order[0], using: target, reason: errors.join(' / ') });
      } else {
        log.info('store.ready', { engine: s.engine, path: s.path });
      }
      if (ro) cachedRO = s; else cachedRW = s;
      return s;
    } catch (e) {
      lastError = e.message;
      errors.push(`${target}: ${e.message}`);
      log.warn('store.backend_failed', { target, error: e.message });
    }
  }
  // 全失败：这是配置/环境问题，必须炸
  throw new Error(`所有存储后端均不可用：${errors.join(' | ')}`);
}

/** 供 /api/health 用 */
async function info(opts) {
  try {
    const s = await open(opts || { readOnly: true });
    return {
      engine: s.engine,
      path: s.path,
      degraded: s.engine !== engineOrder()[0],
      wanted: engineOrder()[0],
      lastError: lastError || null,
    };
  } catch (e) {
    return { engine: null, degraded: true, error: e.message };
  }
}

module.exports = { open, info, TABLES: require('./schema').TABLES };
