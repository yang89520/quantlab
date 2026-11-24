#!/usr/bin/env node
'use strict';
/**
 * 方向代理 × 视界 的 IC 矩阵
 *
 * 目的：单日强度是「延续」还是「反转」，往往随视界翻转。
 * 把 horizon 从 1 拉到 20，能看出每个代理的信息半衰期与符号稳定性。
 *
 * 用法：node tools/flow-ic-grid.js
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const HORIZONS = [1, 2, 3, 5, 10, 20];

function pearson(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
}

function main() {
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);
  const variants = ['body', 'clv', 'vwap', 'blend'];

  // 预计算：每只股票每个代理的 s 序列，避免重复算
  const cache = new Map();
  for (const k of keys) {
    const r = ds.series[k];
    const m = {};
    for (const dir of variants) m[dir] = F.compute(r, { dir }).s;
    cache.set(k, m);
  }

  console.log(`样本 ${keys.length} 只 | 不重叠采样（步长=视界）\n`);
  const rows = {};
  for (const dir of variants) rows[dir] = {};

  for (const H of HORIZONS) {
    for (const dir of variants) {
      const xs = [], ys = [];
      for (const k of keys) {
        const r = ds.series[k];
        const s = cache.get(k)[dir];
        for (let i = 60; i + H + 1 < r.length; i += H) {
          const entry = r[i + 1][1], exit = r[i + H + 1][4];
          if (!(entry > 0) || !(exit > 0)) continue;
          xs.push(s[i]); ys.push(exit / entry - 1);
        }
      }
      rows[dir][`${H}日`] = +pearson(xs, ys).toFixed(4);
    }
  }
  console.table(rows);

  // 附带：纯动量基准（过去 H 日涨幅）——判断资金代理是否只是动量的马甲
  const mom = {};
  for (const H of HORIZONS) {
    const xs = [], ys = [];
    for (const k of keys) {
      const r = ds.series[k];
      for (let i = 60; i + H + 1 < r.length; i += H) {
        const entry = r[i + 1][1], exit = r[i + H + 1][4];
        if (!(entry > 0) || !(exit > 0)) continue;
        xs.push(r[i][4] / r[i - H][4] - 1);
        ys.push(exit / entry - 1);
      }
    }
    mom[`${H}日`] = +pearson(xs, ys).toFixed(4);
  }
  console.log('\n基准 · 纯动量（过去 H 日涨幅）的 IC：');
  console.table({ 动量: mom });
}

main();
