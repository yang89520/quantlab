#!/usr/bin/env node
'use strict';
/**
 * 资金量价策略回测
 *
 * 交易协议（严格无未来函数）：
 *   · t 日收盘后由指标产生信号；
 *   · t+1 开盘买入；若 t+1 开盘涨幅 > 9.5%（一字板/接近涨停），视为买不进，剔除该信号；
 *   · 持有 H 日后收盘卖出；同标的持仓期间不重复开仓；
 *   · 双边成本 0.15%（佣金 0.025%×2 + 印花税 0.05% + 滑点约 0.05%）。
 *
 * 对照组（缺了就没有说服力）：
 *   · base — 同池、同期间、同持有期的无条件平均收益，即「什么都不看随便买」；
 *   · 策略只有稳定跑赢 base，才说明指标本身有信息，而不是靠牛市 beta。
 *
 * 用法：node tools/flow-backtest.js [--hold 5] [--year 2024]
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const COST = 0.0015;
const LIMIT_UP = 0.095;

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const HOLD = Number(arg('--hold', 5));
const YEAR_FILTER = arg('--year', null);

function maAt(rows, i, n, field = 4) {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += rows[j][field];
  return s / n;
}

/**
 * 策略定义：返回 true 表示在 i 日收盘触发买入。
 * 所有条件只用到 <= i 的数据。
 */
const STRATEGIES = {
  // S0 用户原式：实体方向 + 全历史累计 + 快慢线交叉
  S0_body_raw: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    return up && ind.s[i] > 0;
  },
  // S1 标准 CLV/CMF 口径
  S1_clv: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    return up && ind.s[i] > 0;
  },
  // S2 VWAP 方向 + 交叉
  S2_vwap: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    return up && ind.s[i] > 0;
  },
  // S3 VWAP 交叉 + 站上 MA20（趋势过滤）
  S3_vwap_ma20: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    const ma20 = maAt(r, i, 20);
    return up && ind.s[i] > 0 && ma20 != null && r[i][4] > ma20;
  },
  // S4 VWAP 交叉 + 不追高（20 日涨幅 < 8%）
  S4_vwap_notchase: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    if (i < 21) return false;
    const mom20 = r[i][4] / r[i - 20][4] - 1;
    return up && ind.s[i] > 0 && mom20 < 0.08;
  },
  // S5 VWAP 交叉 + 放量确认（当日量 > 1.2 倍 5 日均量）
  S5_vwap_vol: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    const ma5 = maAt(r, i, 5, 5);
    return up && ind.s[i] > 0 && ma5 != null && r[i][5] > 1.2 * ma5;
  },
  // S6 组合：不追高 + 放量
  S6_combo: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    if (i < 21) return false;
    const mom20 = r[i][4] / r[i - 20][4] - 1;
    const ma5 = maAt(r, i, 5, 5);
    return up && ind.s[i] > 0 && mom20 < 0.08 && ma5 != null && r[i][5] > 1.2 * ma5;
  },
  // S7 反向：超跌 + 资金回流（检验「反转」是否比「延续」更强）
  S7_reversal: (r, i, ind) => {
    if (i < 21) return false;
    const mom10 = r[i][4] / r[i - 10][4] - 1;
    return ind.s[i] > 0.5 && mom10 < -0.06;
  },
  // S8 低位单日大额流入（位置分位 < 0.30 且 强度 > 1.5）
  S8_lowpos_surge: (r, i, ind) => i >= 60 && pos60(r, i) < 0.30 && ind.s[i] > 1.5,
  // S9 量价背离吸筹：价格 20 日跌超 5%，但累计资金 5 日仍在流入
  S9_divergence: (r, i, ind) => {
    if (i < 25) return false;
    const mom20 = r[i][4] / r[i - 20][4] - 1;
    return mom20 < -0.05 && ind.cum[i] > ind.cum[i - 5] && ind.s[i] > 0;
  },
  // S10 低位 + 资金 + 放量（三重确认）
  S10_triple: (r, i, ind) => {
    if (i < 60) return false;
    const ma5 = maAt(r, i, 5, 5);
    return pos60(r, i) < 0.30 && ind.s[i] > 1.0 && ma5 != null && r[i][5] > 1.2 * ma5;
  },
  // S11 与 S4 同构，但「不追高」改用位置分位（<0.45），检验阈值形式是否敏感
  S11_pos45: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    return up && ind.s[i] > 0 && i >= 60 && pos60(r, i) < 0.45;
  },
  // S4b/S4c：S4 的阈值敏感性（12% / 5%）
  S4b_chase12: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    if (i < 21) return false;
    return up && ind.s[i] > 0 && r[i][4] / r[i - 20][4] - 1 < 0.12;
  },
  S4c_chase05: (r, i, ind) => {
    const up = ind.fast[i - 1] <= ind.slow[i - 1] && ind.fast[i] > ind.slow[i];
    if (i < 21) return false;
    return up && ind.s[i] > 0 && r[i][4] / r[i - 20][4] - 1 < 0.05;
  },
};

/** 收盘价在最近 60 日 [最低, 最高] 区间中的位置，0=最低，1=最高 */
function pos60(r, i) {
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 59; j <= i; j++) {
    if (r[j][2] > hi) hi = r[j][2];
    if (r[j][3] < lo) lo = r[j][3];
  }
  return hi > lo ? (r[i][4] - lo) / (hi - lo) : 0.5;
}

/**
 * 每个策略的指标参数。
 * S0 严格复现通达信原式：body 方向 + 全历史累加（λ=1）+ MA10 交叉。
 * 其余策略统一用 VWAP 方向、λ=0.98、EMA5/20，变量只有一个「过滤条件」，
 * 这样横向比较时差异只来自过滤，而不是指标口径被同时改动。
 */
const CONFIG = {
  S0_body_raw: { dir: 'body', lambda: 1, fast: 1, slow: 10, slowType: 'sma', intensityMode: 'raw' },
  S1_clv: { dir: 'clv' },
  S2_vwap: { dir: 'vwap' },
  S3_vwap_ma20: { dir: 'vwap' },
  S4_vwap_notchase: { dir: 'vwap' },
  S5_vwap_vol: { dir: 'vwap' },
  S6_combo: { dir: 'vwap' },
  S7_reversal: { dir: 'vwap' },
  S8_lowpos_surge: { dir: 'vwap' },
  S9_divergence: { dir: 'vwap' },
  S10_triple: { dir: 'vwap' },
  S11_pos45: { dir: 'vwap' },
  S4b_chase12: { dir: 'vwap' },
  S4c_chase05: { dir: 'vwap' },
};

function stats(arr, baseArr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const win = arr.filter((x) => x > 0).length;
  const gains = arr.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = arr.filter((x) => x <= 0).reduce((a, b) => a + b, 0);
  const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const baseMean = baseArr && baseArr.length ? baseArr.reduce((a, b) => a + b, 0) / baseArr.length : null;
  return {
    n,
    winRate: +(win / n * 100).toFixed(1),
    meanPct: +(mean * 100).toFixed(2),
    medianPct: +(sorted[Math.floor(n / 2)] * 100).toFixed(2),
    pf: losses ? +(Math.abs(gains / losses)).toFixed(2) : null,
    sharpe: std > 0 ? +(mean / std * Math.sqrt(250 / HOLD)).toFixed(2) : null,
    basePct: baseMean == null ? null : +(baseMean * 100).toFixed(2),
    edgePct: baseMean == null ? null : +((mean - baseMean) * 100).toFixed(2),
  };
}

function main() {
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);
  console.log(`样本 ${keys.length} 只 | 持有 ${HOLD} 日 | 成本 ${(COST * 100).toFixed(2)}% | ${YEAR_FILTER ? `仅 ${YEAR_FILTER} 年` : '全区间 2022-2026'}\n`);

  // 基准先算：策略表里的 edge 需要它，顺序错了会全是 null
  const baseTrades = [];
  for (const k of keys) {
    const r = ds.series[k];
    for (let i = 60; i + HOLD + 1 < r.length; i += HOLD) {
      const entry = r[i + 1][1], exit = r[i + HOLD + 1][4];
      if (!(entry > 0) || !(exit > 0)) continue;
      if (entry / r[i][4] - 1 > LIMIT_UP) continue;
      const y = new Date(r[i][0]).getFullYear();
      if (YEAR_FILTER && String(y) !== String(YEAR_FILTER)) continue;
      baseTrades.push(exit / entry - 1 - COST);
    }
  }
  const baseStat = stats(baseTrades, baseTrades);
  console.log('基准（无条件买入持有 ' + HOLD + ' 日）：', JSON.stringify(baseStat));
  console.log('');

  const res = {};
  const yearly = {};

  for (const name of Object.keys(STRATEGIES)) {
    const trades = [];
    const byYear = {};
    for (const k of keys) {
      const r = ds.series[k];
      const ind = F.compute(r, CONFIG[name]);
      let lastExit = -1;
      for (let i = 60; i + HOLD + 1 < r.length; i++) {
        if (i <= lastExit) continue;
        if (!STRATEGIES[name](r, i, ind)) continue;
        const entry = r[i + 1][1];
        const exit = r[i + HOLD + 1][4];
        if (!(entry > 0) || !(exit > 0)) continue;
        if (entry / r[i][4] - 1 > LIMIT_UP) continue;   // 次日一字板买不进
        const y = new Date(r[i][0]).getFullYear();
        if (YEAR_FILTER && String(y) !== String(YEAR_FILTER)) continue;
        const ret = exit / entry - 1 - COST;
        trades.push(ret);
        lastExit = i + HOLD + 1;
        (byYear[y] = byYear[y] || []).push(ret);
      }
    }
    res[name] = stats(trades, baseTrades);
    yearly[name] = byYear;
  }

  // 基准已在前面算完，这里只做策略
  console.table(res);

  // 分年度：判断是否只在某一年有效
  console.log('\n分年度平均收益（%）：');
  const years = [...new Set(Object.values(yearly).flatMap((o) => Object.keys(o)))].sort();
  const ytable = {};
  for (const name of Object.keys(STRATEGIES)) {
    ytable[name] = {};
    for (const y of years) {
      const arr = yearly[name][y] || [];
      ytable[name][y] = arr.length ? `${(arr.reduce((a, b) => a + b, 0) / arr.length * 100).toFixed(1)}(${arr.length})` : '-';
    }
  }
  console.table(ytable);
}

main();
