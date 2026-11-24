#!/usr/bin/env node
'use strict';
/**
 * 资金方向代理的 IC 检验
 *
 * 问题：body / clv / vwap 三种「无 L2 方向推断」，到底哪种对未来收益有信息量？
 * 方法：把每个代理算成单日强度 s，与未来 N 日收益做相关；用不重叠采样避免
 *      重叠收益把显著性吹高；再按月算 IC，看稳定性（IR = mean/std）。
 *
 * 判据：
 *   |IC| < 0.01          → 基本无信息
 *   IC 均值正但 IR < 0.3  → 时有时无，不可交易
 *   IC > 0.02 且 IR > 0.5 → 值得做信号层
 *
 * 用法：node tools/flow-ic.js [--horizon 5] [--step 5]
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const HORIZON = numArg('--horizon', 5);
const STEP = numArg('--step', HORIZON);

function numArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 30) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

/** 秩化，用于 Spearman（对极端收益更稳健） */
function rank(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length; i++) out[idx[i][1]] = i;
  return out;
}

function spearman(xs, ys) {
  return pearson(rank(xs), rank(ys));
}

function main() {
  if (!fs.existsSync(FILE)) throw new Error(`缺少数据集 ${FILE}，先跑 tools/flow-dataset.js`);
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);
  const variants = ['body', 'clv', 'vwap', 'blend'];

  console.log(`样本 ${keys.length} 只 | 视界 ${HORIZON} 日 | 采样步长 ${STEP}\n`);

  const result = {};
  for (const dir of variants) {
    const xs = [], ys = [], months = new Map();
    for (const k of keys) {
      const r = ds.series[k];
      const ind = F.compute(r, { dir });
      const s = ind.s;
      for (let i = 60; i + HORIZON + 1 < r.length; i += STEP) {
        // t+1 开盘买入，t+HORIZON+1 收盘卖出；跳过 t+1 是为了不吃「当日已涨」的假信息
        const entry = r[i + 1][1];
        const exit = r[i + HORIZON + 1][4];
        if (!(entry > 0) || !(exit > 0)) continue;
        const y = exit / entry - 1;
        xs.push(s[i]); ys.push(y);
        const m = String(r[i][0]).slice(0, 7);
        if (!months.has(m)) months.set(m, { x: [], y: [] });
        months.get(m).x.push(s[i]); months.get(m).y.push(y);
      }
    }
    const icP = pearson(xs, ys);
    const icS = spearman(xs, ys);

    const monthly = [];
    for (const [, v] of months) {
      if (v.x.length < 200) continue;       // 月度样本太少的月不参与（春节等）
      const ic = spearman(v.x, v.y);
      if (Number.isFinite(ic)) monthly.push(ic);
    }
    const mean = monthly.reduce((a, b) => a + b, 0) / monthly.length;
    const std = Math.sqrt(monthly.reduce((a, b) => a + (b - mean) ** 2, 0) / monthly.length);
    const ir = std > 0 ? mean / std : 0;
    const pos = monthly.filter((x) => x > 0).length / monthly.length;

    result[dir] = {
      n: xs.length,
      icPearson: +icP.toFixed(4),
      icSpearman: +icS.toFixed(4),
      icMeanMonthly: +mean.toFixed(4),
      icStd: +std.toFixed(4),
      ir: +ir.toFixed(2),
      posMonths: +(pos * 100).toFixed(0),
      months: monthly.length,
    };
  }

  console.table(result);

  // 累积线与交叉信号的信息量：检验「趋势型用法」是否比单日强度更好
  const trend = {};
  for (const dir of ['clv', 'blend']) {
    const xs = [], ys = [];
    for (const k of keys) {
      const r = ds.series[k];
      const ind = F.compute(r, { dir });
      for (let i = 60; i + HORIZON + 1 < r.length; i += STEP) {
        const entry = r[i + 1][1], exit = r[i + HORIZON + 1][4];
        if (!(entry > 0) || !(exit > 0)) continue;
        xs.push(ind.fast[i] - ind.slow[i]);       // 快慢线差 = 累积动量
        ys.push(exit / entry - 1);
      }
    }
    trend[`${dir}:fast-slow`] = {
      n: xs.length,
      icPearson: +pearson(xs, ys).toFixed(4),
      icSpearman: +spearman(xs, ys).toFixed(4),
    };
  }
  console.log('\n趋势型（快慢线差）对比：');
  console.table(trend);
}

main();
