'use strict';
/**
 * 对账与归因（一期核心）
 *
 * 判定顺序严格串行，不允许并行（docs/dev/03 §3.4）：
 *   环境错了就不该怪选股——环境错时选股再好也是逆势。
 *   顺序颠倒是归因分析最常见的错误。
 *
 * 二期四段（04 §3.2）：env > direction > candidate > timing > hit
 *   direction 必须排在 candidate 之前：方向错了却去怪选股，
 *   会让人一直优化选股逻辑而永远修不好。
 * directionHit === null 表示二期数据未就绪或当日榜单缺失，
 * 此时跳过该分支（不判错、也不算通过，D1）。
 */
const config = require('./config');
const { rankInAll } = require('./sector');

const clamp = (x) => Math.max(0, Math.min(1, x));

/** 求某个 metric 的当前值 */
function metricValue(metrics, key) {
  if (!metrics) return null;
  const v = metrics[key];
  return v === undefined ? null : v;
}

function compare(a, op, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

/**
 * 判定一组失效条件，返回命中的 id 列表
 * @param {Array} list invalidIf 定义
 * @param {object} metrics 当日实际指标
 */
function evalInvalidIf(list, metrics) {
  const hits = [];
  for (const item of list || []) {
    const left = metricValue(metrics, item.metric);
    const right = item.ref ? metricValue(metrics, item.ref) : item.value;
    if (compare(left, item.op, right)) hits.push(item.id);
  }
  return hits;
}

/**
 * 归因（纯函数）：优先级 env > direction > candidate > timing > hit
 * @param {object} p { envHit, directionHit, candHitRatio, hasSpikeFade, config }
 *   directionHit: true 方向对 / false 方向错 / null 二期未就绪或数据缺失
 */
function attribute(p) {
  const { envHit, candHitRatio, hasSpikeFade } = p;
  const directionHit = p.directionHit === undefined ? null : p.directionHit;
  const cfg = p.config || config;
  if (!envHit) return 'env';
  if (directionHit === false) return 'direction';
  if (candHitRatio === null || candHitRatio === undefined) return 'hit';  // 无候选，只看环境
  const minHit = (cfg.judgment && cfg.judgment.candidateMinHitRatio != null)
    ? cfg.judgment.candidateMinHitRatio
    : config.judgment.candidateMinHitRatio;   // 测试传入的精简 cfg 也能跑
  if (candHitRatio < minHit) return 'candidate';
  if (hasSpikeFade) return 'timing';
  return 'hit';
}

function scoreOf(envHit, candHitRatio) {
  const w = config.judgment;
  const envScore = envHit ? 100 : 0;
  const candScore = candHitRatio === null ? envScore : candHitRatio * 100;
  return Math.round(envScore * w.envWeight + candScore * w.candWeight);
}

/**
 * 对账
 * @param {object} pred          预判卡
 * @param {Map}    prevMap       预判日快照 Map<code,row>
 * @param {object} todaySummary  目标日快照概要 { map, breadth, ztCount, count }
 * @param {Array}  todayBars     指数日线（含目标日）
 * @param {object} [cfg]
 * @param {object} [extra] { sectorsToday } 目标日板块强度榜，供 direction 归因
 */
function reconcile(pred, prevMap, todaySummary, todayBars, cfg, extra) {
  cfg = cfg || config;
  const now = new Date().toISOString();

  // ① 门禁：数据不完整直接跳过，不进统计
  if (!todaySummary || !todaySummary.count) {
    return { schema: 1, reconciledAt: now, skipped: true, skipReason: 'no_snapshot', actual: null, envResult: null, candResults: [], candHitRatio: null, attribution: null, judgmentScore: null };
  }
  if (todaySummary.count < cfg.integrity.minSnapshotCount) {
    return { schema: 1, reconciledAt: now, skipped: true, skipReason: 'incomplete', actual: { snapshotCount: todaySummary.count }, envResult: null, candResults: [], candHitRatio: null, attribution: null, judgmentScore: null };
  }

  // ② 指数涨跌：取今日与昨日收盘
  const bars = (todayBars || []).filter((r) => r && r[0]);
  if (bars.length < 2) {
    return { schema: 1, reconciledAt: now, skipped: true, skipReason: 'no_bars', actual: null, envResult: null, candResults: [], candHitRatio: null, attribution: null, judgmentScore: null };
  }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const idxChg = (Number(last[2]) / Number(prev[2]) - 1) * 100;

  const actualDirection = idxChg > 0.5 ? 'up' : idxChg < -0.5 ? 'down' : 'flat';

  // ③ 环境判定
  const expected = pred.env.verdict;
  const envHit =
    (expected === 'attack' && actualDirection === 'up') ||
    (expected === 'defend' && actualDirection === 'down') ||
    (expected === 'wait' && actualDirection === 'flat');

  const metrics = {
    close: Number(last[2]),
    ma20: pred.env.metrics.ma20,
    ma60: pred.env.metrics.ma60,
    breadth: todaySummary.breadth,
    volRatio: pred.env.metrics.volRatio,
    ztCount: todaySummary.ztCount,
  };
  const invalidHits = evalInvalidIf(pred.env.invalidIf, metrics);

  // ③-b 方向判定（04 §3.2）：昨日 mainline 的 A 档板块，今日是否仍在前 30%
  // 榜单缺失或某板块今日不在榜 → directionHit=null（无法判定），既不判错也不算通过
  let directionHit = null;
  const directionRanks = [];
  const directionMissing = [];
  const ml = pred.mainline;
  const sectorCfg = cfg.sector || config.sector;
  if (ml && Array.isArray(ml.sectors) && ml.sectors.length) {
    const rows = extra && extra.sectorsToday;
    if (Array.isArray(rows) && rows.length) {
      for (const s of ml.sectors) {
        const r = rankInAll(rows, s.code);
        directionRanks.push({ code: s.code, rank: r });
        if (r == null) directionMissing.push(s.code);
      }
      directionHit = directionMissing.length
        ? null
        : directionRanks.every((x) => x.rank >= sectorCfg.directionRank);
    }
  }

  // ④ 逐候选
  const candResults = [];
  let valid = 0, up = 0, spikeFade = false;
  for (const c of pred.candidates || []) {
    const before = prevMap ? prevMap.get(c.code) : null;
    const after = todaySummary.map ? todaySummary.map.get(c.code) : null;
    if (!before || !after || !before.price || !after.price) {
      candResults.push({ code: c.code, chg: null, hit: false, invalidHits: [], reason: 'no_data' });
      continue;
    }
    const chg = (after.price / before.price - 1) * 100;
    valid++;
    if (chg > 0) up++;
    // 冲高回落：日内振幅够大但收跌
    if (after.amplitude != null && after.amplitude > 3 && chg < 0) spikeFade = true;
    candResults.push({
      code: c.code, chg: Number(chg.toFixed(2)), hit: chg > 0,
      invalidHits: evalInvalidIf(c.invalidIf, { close: after.price, chg }),
    });
  }
  const candHitRatio = valid ? up / valid : null;

  // ⑤ 归因 + 得分（direction 优先于 candidate）
  const attribution = attribute({
    envHit, directionHit, candHitRatio, hasSpikeFade: spikeFade, config: cfg,
  });
  const judgmentScore = scoreOf(envHit, candHitRatio);

  return {
    schema: 1,
    reconciledAt: now,
    actual: {
      idxChg: Number(idxChg.toFixed(2)),
      breadth: todaySummary.breadth == null ? null : Number(todaySummary.breadth.toFixed(4)),
      ztCount: todaySummary.ztCount,
      snapshotCount: todaySummary.count,
    },
    envResult: { hit: envHit, verdictExpected: expected, actualDirection, invalidHits },
    directionResult: {
      hit: directionHit,
      threshold: sectorCfg.directionRank,
      ranks: directionRanks,
      missing: directionMissing,
      available: !!(ml && Array.isArray(ml.sectors) && ml.sectors.length),
    },
    candResults,
    candHitRatio: candHitRatio == null ? null : Number(candHitRatio.toFixed(4)),
    attribution,
    judgmentScore,
    skipped: false,
    skipReason: null,
  };
}

module.exports = { reconcile, evalInvalidIf, attribute, scoreOf };
