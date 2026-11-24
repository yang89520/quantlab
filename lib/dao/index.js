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
const fs = require('fs');
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

/**
 * 只读路径是否需要先建库。
 * 判据两条：文件不存在，或文件存在但是 0 字节（上次进程被杀留下的空壳）。
 * 空壳同样会让 READ_ONLY 打开失败，表现和「不存在」一模一样。
 */
function needsBootstrap(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    return !st.isFile() || st.size === 0;
  } catch (e) {
    return true;
  }
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
    if (!opts.readOnly) {
      await store.migrate();
    } else if (needsBootstrap(dbPath)) {
      /* 首次运行死锁修复（B1）。
       *
       * 只读打开一个不存在的 DuckDB 文件会直接抛
       *   「Cannot open database ... in read-only mode: database does not exist」，
       * 而只读路径按设计又永远不会建库 —— 于是只要用户第一次访问的是
       * /api/predict/today 这类只读接口，库就永远建不出来，
       * 该接口每次都是 500，且不会自愈（只有恰好访问了写接口才恢复）。
       *
       * 这里先在只读请求上补一次建表：以读写方式打开 → migrate → 关掉，
       * 再继续走原来的只读连接（store 用的是短连接，下次 withConn 会重新打开，
       * 那时文件已存在，READ_ONLY 就能成功）。
       * 用 force 标记避免并发首个请求各建一遍：DuckDB 的建表是幂等的，
       * 真并发也只是多跑一次 DDL，不会坏数据。 */
      log.info('store.bootstrap', { reason: '自有库不存在，先以读写建表再切只读', path: dbPath });
      const init = create(dbPath, { readOnly: false });
      await init.migrate();
    }
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
