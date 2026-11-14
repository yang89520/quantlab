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
