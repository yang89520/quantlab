'use strict';
/**
 * 成分股日线的网络批量回退。
 *
 * 存在的理由：板块强度必须由「成分股的日线序列」聚合出来（10 §3.3），
 * 而这条链路原本只有一个数据来源 —— 上游 market.db 只读批量查询。
 * 一旦本机没有那个 38GB 的库（干净环境、换机器、Mac 端首次部署都是这种情形），
 * readMemberKlines 直接抛错，所有板块都判「no_klines」，
 * 最终 daily-close 报「参评板块不足 10 个」，二期功能整体不可用。
 *
 * 这里补一条网络回退：本地库拿不到时，逐个标的走 datasource 的多源解析
 * （同花顺 → 新浪），拿到与本地库同构的 [date,o,c,h,l,v,a] 序列。
 *
 * 两条硬约束：
 *  1. **只允许当日**。历史回补时网络只能拿到「现在」的序列，
 *     用它去算某历史日的板块排名就是前视偏差（09 §9 D-4 的红线）。
 *     调用方负责判断日期，本模块只提供纯取数能力。
 *  2. **结果按日缓存**。第一次跑要拉数千只，几十秒到几分钟；
 *     同一天再跑（换参数、重试、补算）必须直接命中缓存，不能重复打上游。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../log');
const ds = require('../datasource');

/** 并发上限：上游同花顺对同 IP 的瞬时并发敏感，8 是实测既不触发限流又不至于太慢的值 */
const CONC = 8;

const bjtDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

/** 6 位纯代码 → 带市场前缀。
 *  规则与 lib/quote.js 的 normalize 保持一致（900/901 是沪B，不是北交所）。 */
function withMarket(code) {
  const s = String(code == null ? '' : code).trim();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  if (!/^\d{6}$/.test(s)) return s;
  if (/^6/.test(s)) return 'sh' + s;
  if (/^(0|2|3)/.test(s)) return 'sz' + s;
  if (/^92/.test(s)) return 'bj' + s;    // 北交所 920xxx
  if (/^9/.test(s)) return 'sh' + s;     // 900/901 沪 B
  if (/^(4|8)/.test(s)) return 'bj' + s;
  if (/^5/.test(s)) return 'sh' + s;
  return 'sz' + s;
}

function cachePath(date) {
  return path.join(config.abs('data'), 'cache', `member-klines-${date}.json`);
}

/** 读缓存；bars 不同则作废（要的根数变多时旧缓存不够用） */
function loadCache(date, bars) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(date), 'utf8'));
    if (j && Number(j.bars) >= bars && j.rows && typeof j.rows === 'object') return j.rows;
  } catch (e) {
    // 没有缓存是最常见的状态，不是错误
  }
  return null;
}

function saveCache(date, bars, rows) {
  try {
    const p = cachePath(date);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ date, bars, at: Date.now(), rows }));
    fs.renameSync(tmp, p);
  } catch (e) {
    log.warn('member_klines.cache_write_failed', { error: e.message });
  }
}

/**
 * 批量取成分股日线（网络）。
 * @param {string[]} codes 6 位代码
 * @param {number} bars 需要的根数
 * @param {{date?:string, onProgress?:Function}} opt
 * @returns {Promise<{rows:Object, missing:string[], source:string, fromCache:boolean}>}
 */
async function readNetworkKlines(codes, bars, opt) {
  const o = opt || {};
  const date = o.date || bjtDay();
  const need = Math.max(21, Number(bars) || 250);
  const list = Array.from(new Set((codes || []).map((c) => String(c)).filter((c) => /^\d{6}$/.test(c))));
  if (!list.length) return { rows: {}, missing: [], source: 'network', fromCache: false };

  const cached = loadCache(date, need);
  const rows = cached ? Object.assign({}, cached) : {};
  const missing = [];
  const todo = list.filter((c) => !rows[c]);
  const hit = list.length - todo.length;
  if (!todo.length) {
    log.info('member_klines.cache_hit', { date, codes: list.length });
    return { rows, missing, source: 'network-cache', fromCache: true };
  }

  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < todo.length) {
      const code = todo[cursor++];
      try {
        const r = await ds.resolve({ kind: 'kline-daily', code: withMarket(code), bars: need });
        if (r && Array.isArray(r.rows) && r.rows.length) rows[code] = r.rows;
        else missing.push(code);
      } catch (e) {
        missing.push(code);
      }
      done++;
      if (typeof o.onProgress === 'function' && done % 200 === 0) {
        o.onProgress({ done, total: todo.length });
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
  saveCache(date, need, rows);
  log.info('member_klines.network', {
    date, asked: list.length, cacheHit: hit, ok: Object.keys(rows).length,
    missing: missing.length, ms: Date.now() - t0,
  });
  return { rows, missing, source: 'network', fromCache: false };
}

/**
 * 读「最新一份」缓存（不论日期）。
 * 用途：在没有上游库的环境里合成历史某日的快照 —— 缓存里每只票有 250 根，
 * 足以覆盖最近一年内任意交易日。
 */
function loadLatestCachedRows() {
  try {
    const dir = path.join(config.abs('data'), 'cache');
    const files = fs.readdirSync(dir)
      .filter((f) => /^member-klines-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (!files.length) return null;
    const j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    return j && j.rows ? { date: j.date, bars: j.bars, rows: j.rows } : null;
  } catch (e) {
    return null;
  }
}

module.exports = { readNetworkKlines, withMarket, cachePath, loadLatestCachedRows };
