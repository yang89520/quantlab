'use strict';
/**
 * 板块四因子强度 —— 纯函数，不触网、不读库（docs/dev/04 §2.2）。
 *
 * 与 judgeEnv 同标准：所有算法可离线单测，输入是聚合好的板块日线 + 成分股快照。
 * 阈值全部来自 config.sector，不许裸数字（G8）。
 */
const config = require('./config');
const { isLimitUp } = require('./snapshot');

function mean(a) {
  const v = (a || []).filter((x) => Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 横截面分位：小于或等于 v 的占比 → 0~1。[1,2,3] 分别 ≈33/66/100 */
function pctile(all, v) {
  const arr = (all || []).filter((x) => Number.isFinite(Number(x))).map(Number);
  if (!arr.length || !Number.isFinite(Number(v))) return null;
  const x = Number(v);
  let le = 0;
  for (const a of arr) if (a <= x) le++;
  return le / arr.length;
}

function chgOf(snapshot, code) {
  const c = String(code).replace(/^(sh|sz|bj)/, '');
  const stocks = snapshot && (snapshot.stocks || (snapshot.get ? undefined : snapshot));
  let s = null;
  if (stocks) s = stocks[c] || stocks[String(code)] || null;
  if (!s && snapshot && typeof snapshot.get === 'function') s = snapshot.get(c) || null;
  if (s == null) return null;
  let v;
  if (typeof s === 'number') v = s;
  else v = s.c !== undefined ? s.c : (s.chg_pct !== undefined ? s.chg_pct : s.chgPct);
  v = Number(v);
  return Number.isFinite(v) ? v : null;
}

/**
 * 单个板块的原始特征。sectorBars 为 [date,open,close,high,low,volume,amount] 行数组。
 * @returns {object|{insufficient:true,reason:string}}
 */
function extractFeat(sectorBars, members, snapshot, opt) {
  const cfg = Object.assign({}, config.sector, (opt && opt.config) || {});
  const rows = sectorBars || [];
  const n = rows.length;
  if (n < 21) return { insufficient: true, reason: `bars<21 (${n})` };

  const close = rows.map((r) => Number(r[2]));
  const vol = rows.map((r) => Number(r[5]));
  const amount = rows.map((r) => Number(r[6]));

  const ret5 = close[n - 6] > 0 ? close[n - 1] / close[n - 6] - 1 : null;
  const ret20 = close[n - 21] > 0 ? close[n - 1] / close[n - 21] - 1 : null;
  const ma20 = mean(close.slice(n - 20));
  const vol5 = mean(vol.slice(n - 5));
  const vol20 = mean(vol.slice(n - 20));
  const volRatio = vol20 && vol20 > 0 ? vol5 / vol20 : null;

  const codes = (members || []).map(String);
  const chgs = codes.map((c) => chgOf(snapshot, c)).filter((v) => v != null);
  const upRatio = chgs.length ? chgs.filter((v) => v > 0).length / chgs.length : null;
  const ztCount = codes.filter((c) => {
    const v = chgOf(snapshot, c);
    return v != null && isLimitUp(c, v);
  }).length;

  let daysAboveMa20 = 0;
  for (let i = n - cfg.continuityDays; i < n; i++) {
    const m = mean(close.slice(Math.max(0, i - (cfg.continuityDays - 1)), i + 1));
    if (m != null && close[i] > m) daysAboveMa20++;
  }

  // 单板块自身近 250 日成交额分位（纵向，与横截面动量分位不是一个维度）
  const window = amount.slice(Math.max(0, n - cfg.amountLookback)).filter((v) => Number.isFinite(v) && v > 0);
  const amountPctile = window.length ? pctile(window, amount[n - 1]) : null;

  return {
    insufficient: false,
    ret5, ret20, ma20, volRatio,
    close: close[n - 1],
    upRatio, ztCount, daysAboveMa20,
    amountPctile,
    netInflowPctile: (opt && opt.netInflowPctile !== undefined) ? opt.netInflowPctile : null,
    memberCount: codes.length,
    validChgs: chgs.length,
  };
}

/**
 * ABCD 分档。判定顺序不可换：D 必须放在 A/B 之后（04 L123）。
 */
function grade(momentum, funds, close, ma20, opt) {
  const cfg = Object.assign({}, config.sector, (opt && opt.config) || {});
  if (momentum == null || funds == null || close == null || ma20 == null) return null;
  if (momentum >= cfg.minMomentum && funds >= cfg.minFunds) return 'A';
  if (momentum >= cfg.minMomentum && funds < cfg.minFunds) return 'B';
  if (close < ma20 && momentum < cfg.dropMomentum) return 'D';
  return 'C';
}

/**
 * 批量评分：动量分位在「同类型榜内」算，行业与概念绝不混排（04 §2.4）。
 * @param {Array<{sector,name,type,feat}>} feats
 * @returns {Array<object>} 每条含 score/grade/parts/metrics/degraded/degradeReason
 */
function scoreBatch(feats, opt) {
  const cfg = Object.assign({}, config.sector, (opt && opt.config) || {});
  const all = (feats || []).filter((f) => f && f.feat && !f.feat.insufficient);
  if (all.length < cfg.minSectors) {
    throw new Error(`参评板块不足 ${cfg.minSectors} 个（实际 ${all.length}），分位无意义，不评分`);
  }

  // 按 type 分组，每组独立算横截面分位
  const groups = new Map();
  for (const f of all) {
    const t = f.type || 'industry';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(f);
  }
  const mixOf = (f) => cfg.mixRet.ret5 * (f.feat.ret5 || 0) + cfg.mixRet.ret20 * (f.feat.ret20 || 0);
  const groupMix = new Map();
  for (const [t, list] of groups) groupMix.set(t, list.map(mixOf));

  return all.map((f) => {
    const ft = f.feat;
    const t = f.type || 'industry';
    const mixList = groupMix.get(t);
    const momentum = pctile(mixList, mixOf(f)) * 100;

    const degrade = [];
    const volScore = ft.volRatio == null
      ? null
      : clamp((ft.volRatio - cfg.volScore.base) / cfg.volScore.span, 0, 1) * 100;
    const amountPart = ft.amountPctile == null ? null : ft.amountPctile * 100;

    let funds;
    if (ft.netInflowPctile != null) {
      if (amountPart == null || volScore == null) {
        funds = null;
        degrade.push('funds_input_missing');
      } else {
        funds = cfg.funds.amountPctile * amountPart
          + cfg.funds.volScore * volScore
          + cfg.funds.netInflowPctile * (ft.netInflowPctile * 100);
      }
    } else {
      // 降级口径 0.70/0.30，必须标 degraded（04 L93/L110）
      degrade.push('net_inflow_missing');
      if (amountPart == null || volScore == null) funds = null;
      else funds = cfg.funds.degradedAmount * amountPart + cfg.funds.degradedVol * volScore;
    }

    let upPart;
    if (ft.upRatio == null) {
      upPart = cfg.breadth.neutralUpRatio;
      degrade.push('up_ratio_missing');
    } else {
      upPart = ft.upRatio * 100;
    }
    const breadth = upPart * cfg.breadth.upRatio
      + Math.min(ft.ztCount / cfg.breadth.ztFull, 1) * 100 * cfg.breadth.zt;
    const continuity = (ft.daysAboveMa20 / cfg.continuityDays) * 100;

    const parts = { momentum, funds, breadth, continuity };
    const score = (funds == null || momentum == null)
      ? null
      : cfg.weights.momentum * momentum
        + cfg.weights.funds * funds
        + cfg.weights.breadth * breadth
        + cfg.weights.continuity * continuity;
    const g = grade(momentum, funds, ft.close, ft.ma20, { config: cfg });

    return {
      schema: 1,
      sector: f.sector,
      name: f.name || '',
      type: t,
      score: score == null ? null : Number(score.toFixed(2)),
      grade: g,
      parts: {
        momentum: momentum == null ? null : Number(momentum.toFixed(2)),
        funds: funds == null ? null : Number(funds.toFixed(2)),
        breadth: Number(breadth.toFixed(2)),
        continuity: Number(continuity.toFixed(2)),
      },
      metrics: {
        ret5: ft.ret5, ret20: ft.ret20, ma20: ft.ma20,
        amountPctile: ft.amountPctile, volRatio: ft.volRatio,
        netInflowPctile: ft.netInflowPctile,
        upRatio: ft.upRatio, ztCount: ft.ztCount,
        daysAboveMa20: ft.daysAboveMa20,
      },
      degraded: degrade.length > 0,
      degradeReason: degrade.length ? degrade.join(',') : null,
      pctileScope: t,
      survivorBias: true,
    };
  });
}

/** 某板块在当日全部板块中的得分分位（0~1），供 direction 归因 */
function rankInAll(rows, code) {
  const valid = (rows || []).filter((r) => r && Number.isFinite(Number(r.score)))
    .sort((a, b) => Number(b.score) - Number(a.score));
  if (!valid.length) return null;
  const idx = valid.findIndex((r) => String(r.sector) === String(code));
  if (idx < 0) return null;
  return valid.length === 1 ? 1 : 1 - idx / (valid.length - 1);
}

module.exports = { pctile, mean, extractFeat, grade, scoreBatch, rankInAll };
