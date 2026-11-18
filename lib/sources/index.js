'use strict';
/**
 * 统一取数入口 fetchAsset（docs/dev/10 §4）。
 * 每次调用三件事：熔断检查 → 按风险配速 → 留痕（成功/失败都记）。
 * 全源失败抛 NoSourceError，绝不返回空数据冒充「没有」（D1 / 10 L306）。
 */
const { ASSETS, LEVEL, asset } = require('./registry');
const health = require('./health');
const pacing = require('./pacing');
const sina = require('./adapters/sina-sector');
const em = require('./adapters/em');
const tdx = require('./adapters/tdx');
const log = require('../log');

class NoSourceError extends Error {
  constructor(key, cause) {
    super(`全部数据源不可用：${key}${cause ? `（${cause.message}）` : ''}`);
    this.name = 'NoSourceError';
    this.assetKey = key;
    this.cause = cause;
  }
}

const ADAPTERS = {
  'sina-hy': () => sina.fetchIndustry(),
  'sina-fljk': () => sina.fetchConcept(),
  'sina-node': (p) => sina.fetchMembers((p && p.node) || ''),

  // 通达信网关（2026-11-18）。这几个是薄封装：真正的取数在主链路上有更复杂的
  // 本地优先/逐根补齐逻辑（见 lib/datasource.js），这里只保证注册表里
  // 写的每个源名都真能对应到一个实现，而不是只写在文档里。
  'tdx-kline': async (p) => {
    if (!p || !p.code) throw new Error('tdx-kline 需要 code 参数');
    const r = await tdx.kline(p.code, { bars: p.bars, until: p.until });
    return { rows: r.rows, asOf: r.asOf, upCount: r.upCount, downCount: r.downCount };
  },
  'tdx-snapshot': async () => {
    const s = await tdx.snapshot();
    return { list: s.data, count: s.count, asOf: null, nullFields: s.nullFields };
  },
  'tdx-block-index': async () => {
    // 板块指数要用「我们的板块 code → 880xxx」的映射，那个上下文只在
    // lib/sectordata.js 里（tools/tdx-map.js 生成）。这里不复制一份，避免两处口径
    throw new Error('板块指数按板块映射调用，见 lib/sectordata.js');
  },
  'tdx-stat': async () => tdx.stat(),
  'tdx-hy': async () => tdx.hy(),

  'em-clist-industry': () => em.fetchIndustry(),
  'em-clist-concept': () => em.fetchConcept(),
  'em-clist-f62': () => em.fetchInflow(),
  'em-clist-members': (p) => {
    // 实测 fs=b:BK**** 常返 000；保留入口但不伪装成可用
    throw new Error('东财板块成分接口实测不可用（000）');
  },
  'em-push2delay': () => { throw new Error('本资产由既有 quote.marketList 承担'); },
  'em-push2ex': (p) => em.fetchZTPool(p && p.date),
  'snapshot-derive': () => { throw new Error('涨停池推导由 snapshot 模块承担'); },
  none: () => { throw new Error('无可用数据源'); },
};

/**
 * @returns {{data, source, level, asOf, stale, degraded, degradeReason, missing}}
 */
async function fetchAsset(assetKey, params) {
  const meta = asset(assetKey);
  // 有些资产的取数逻辑留在 datasource 里（要做本地优先、逐根补齐、跨日缓存等编排），
  // 这里不复制一份。直接说清楚该去哪个入口，而不是让人对着 NoSourceError 猜。
  if (meta.via === 'datasource') {
    throw new Error(`${assetKey} 的取数入口是 datasource.resolve({kind:'${assetKey === 'stock-kline' ? 'kline-daily' : 'snapshot'}'})`);
  }
  let lastErr = null;
  let skipped = 0;
  for (const src of meta.sources) {
    if (health.isTripped(assetKey, src)) { skipped++; continue; }
    await pacing.wait(assetKey, src);
    const fn = ADAPTERS[src];
    if (!fn) { health.record(assetKey, src, false, null, '适配器未实现'); continue; }
    const t0 = Date.now();
    try {
      const data = await fn(params || {});
      health.record(assetKey, src, true, Date.now() - t0);
      const usedFallback = meta.sources.indexOf(src) > 0;
      return {
        data,
        source: src,
        level: LEVEL[src] || null,
        asOf: (data && data.asOf) || null,
        stale: false,
        degraded: usedFallback || LEVEL[src] === 'C',
        degradeReason: usedFallback ? `主源不可用，改用 ${src}` : null,
        missing: [],
      };
    } catch (e) {
      lastErr = e;
      health.record(assetKey, src, false, null, e.message);
      log.warn('sources.adapter_failed', { asset: assetKey, src, error: e.message });
    }
  }
  throw new NoSourceError(assetKey, lastErr || new Error(`${skipped} 个源处于熔断冷却期`));
}

/** 可选增强：失败返回 null，让上层走降级口径，不阻断主流程 */
async function tryAsset(assetKey, params) {
  try { return await fetchAsset(assetKey, params); }
  catch (e) {
    if (e instanceof NoSourceError) return null;
    throw e;
  }
}

/** 每 5 分钟探活（Web 常驻进程 setInterval 调用），结果进 /api/health */
async function probe() {
  const out = {};
  for (const [key, meta] of Object.entries(ASSETS)) {
    if (meta.risk === 'none' || meta.risk === 'low') continue;
    const src = meta.sources[0];
    if (src === 'none') continue;
    if (health.isTripped(key, src)) continue;   // 冷却期内不再打，避免把源打封
    const fn = ADAPTERS[src];
    if (!fn) continue;
    const t0 = Date.now();
    try {
      await fn({ node: 'new_blhy', date: undefined });
      health.record(key, src, true, Date.now() - t0);
      out[key] = 'ok';
    } catch (e) {
      health.record(key, src, false, null, e.message);
      out[key] = 'down';
    }
  }
  return out;
}

module.exports = {
  NoSourceError, fetchAsset, tryAsset, probe,
  snapshot: health.snapshot,
  resetHealth: health.reset,
  ASSETS,
};
