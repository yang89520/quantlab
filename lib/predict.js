'use strict';
/**
 * 预判卡生成（一期核心）
 *
 * 设计要点（docs/dev/03-phase1 §3）：
 *  - judgeEnv 必须是纯函数：一期最需要反复验证的部分，不许依赖网络
 *  - 阈值只有一套，全部来自 config.predict（不许散落魔数）
 *  - parts 必须与 score 自洽：sum(parts) === score（±1 允许取整误差）
 *  - confidence 固定 null：没算就别编一个看起来科学的数
 */
const config = require('./config');
const { isLimitUp } = require('./snapshot');

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round1 = (x) => Math.round(x * 10) / 10;

/** 均线 */
function ma(closes, n) {
  if (closes.length < n) return null;
  const seg = closes.slice(closes.length - n);
  return seg.reduce((a, b) => a + b, 0) / n;
}

/**
 * 环境判定（纯函数）
 * @param {Array} bars 指数日线 [date, open, close, high, low, volume, amount]
 * @param {object} snap 快照概要 { breadth, ztCount, ... } 或 null
 * @returns {{verdict, score, parts, metrics}}
 */
function judgeEnv(bars, snap, cfg) {
  cfg = cfg || config;
  if (!Array.isArray(bars) || bars.length < 60) {
    throw new Error(`指数 K 线不足，无法计算 MA60（当前 ${bars ? bars.length : 0} 根，至少 60 根）`);
  }

  const closes = bars.map((r) => Number(r[2]));
  const vols = bars.map((r) => Number(r[5]));
  const close = closes[closes.length - 1];
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);

  const v5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const v20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = v20 > 0 ? v5 / v20 : null;

  const breadth = snap && snap.breadth != null ? snap.breadth : null;

  // ---- 三个分项 ----
  const trend = (close > ma20 ? 20 : 0) + (ma20 > ma60 ? 20 : 0);
  const breadthScore = breadth == null ? 0 : clamp((breadth - 0.35) / 0.40) * 30;
  const volScore = volRatio == null ? 0 : clamp((volRatio - 0.70) / 0.60) * 30;

  const parts = {
    trend: round1(trend),
    breadth: round1(breadthScore),
    vol: round1(volScore),
  };
  const score = Math.round(parts.trend + parts.breadth + parts.vol);

  const th = cfg.predict.verdict;
  let verdict;
  if (score >= th.attack) verdict = 'attack';
  else if (score <= th.defend) verdict = 'defend';
  else verdict = 'wait';

  const ret20 = closes.length > 21 ? close / closes[closes.length - 21] - 1 : null;

  return {
    verdict,
    confidence: null,          // 一期不估计置信度，明说没有
    score,
    parts,
    metrics: {
      close: Number(close.toFixed(2)),
      ma20: ma20 == null ? null : Number(ma20.toFixed(2)),
      ma60: ma60 == null ? null : Number(ma60.toFixed(2)),
      ret20: ret20 == null ? null : Number(ret20.toFixed(4)),
      breadth: breadth == null ? null : Number(breadth.toFixed(4)),
      volRatio: volRatio == null ? null : Number(volRatio.toFixed(3)),
      ztCount: snap && snap.ztCount != null ? snap.ztCount : null,
      strongRatioProxy: snap && snap.strongRatioProxy != null ? Number(snap.strongRatioProxy.toFixed(4)) : null,
    },
  };
}

/** 失效条件：固定三条，多说明结论不收敛，少说明没想清楚 */
function buildInvalidIf(env, cfg) {
  cfg = cfg || config;
  const m = env.metrics;
  return [
    { id: 'E1', desc: '指数跌破 MA20', metric: 'close', op: '<', ref: 'ma20' },
    { id: 'E2', desc: '宽度低于 40%', metric: 'breadth', op: '<', value: 0.40 },
    { id: 'E3', desc: '量能萎缩至 0.7 倍', metric: 'volRatio', op: '<', value: 0.70, current: m.volRatio },
  ];
}

/** 三情景：必须互斥且穷尽，中性用「其余」兜底 */
function buildScenario(env) {
  return {
    optimistic: { cond: '指数涨 > 0.8% 且 宽度 > 55%', plan: '顺势持有，不追高' },
    neutral: { cond: '其余（兜底，保证穷尽）', plan: '观察为主，不加仓' },
    pessimistic: { cond: '指数跌 > 0.8% 或 宽度 < 40%', plan: '降仓，不接反弹' },
  };
}

function shiftTradingDay(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 粗略的下一个交易日：跳过周末；节假日不处理（有 holidays.json 时进一步校正） */
function nextTradingDay(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 8; i++) {
    d = shiftTradingDay(d, 1);
    const wd = new Date(d + 'T00:00:00').getDay();
    if (wd !== 0 && wd !== 6) return d;
  }
  return d;
}

/**
 * 组装预判卡
 * @param {object} ctx { date, targetDate, bars, snap, candidates, integrity }
 */
function build(ctx) {
  const env = judgeEnv(ctx.bars, ctx.snap, config);
  // 失效条件是七格的存在理由（06 §2.2）：必须随卡片一起落库，
  // 否则第二天对账无从判定「哪条失效条件被触发」。
  env.invalidIf = buildInvalidIf(env, config);
  const date = ctx.date;
  const targetDate = ctx.targetDate || nextTradingDay(date);

  const candidates = (ctx.candidates || []).slice(0, config.predict.candidateCount).map((c) => ({
    code: c.code,
    name: c.name || '',
    dir: c.dir || 'up',
    reason: c.reason || '自选关注',
    invalidIf: [{ id: 'C1', desc: '跌破 MA20', metric: 'close', op: '<', ref: 'ma20' }],
  }));

  const warnings = [];
  // integrity.stale 来自指数 K 线是否补齐至交易日，别写成"快照"（口径不可混用）
  if (ctx.integrity && ctx.integrity.stale) warnings.push('指数 K 线未补齐至最近交易日');
  if (env.metrics.breadth == null) warnings.push('缺少宽度数据，宽度分项按 0 计');

  return {
    schema: 1,
    date,
    targetDate,
    createdAt: new Date().toISOString(),
    dataComplete: warnings.length === 0,
    integrity: Object.assign({ warnings }, ctx.integrity || {}),
    env,
    candidates,
    scenario: buildScenario(env),
    reconcile: null,
  };
}

module.exports = { judgeEnv, buildInvalidIf, buildScenario, build, nextTradingDay, ma, clamp };
