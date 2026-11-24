#!/usr/bin/env node
'use strict';
/**
 * 卖出侧（S 信号）有效性检验
 *
 * 买入侧证明了「低位 + 强流入」有效，但一个只能买不能卖的指标是不可用的：
 * 持仓什么时候走？这里检验「高位 + 强流出」的后续收益是否显著为负，
 * 以及暴跌前能否提前给出信号（这是资金指标最该有的价值）。
 *
 * 用法：node tools/flow-sell.js
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const COST = 0.0015;
const HOLD = 5;

function pos60(r, i) {
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 59; j <= i; j++) {
    if (r[j][2] > hi) hi = r[j][2];
    if (r[j][3] < lo) lo = r[j][3];
  }
  return hi > lo ? (r[i][4] - lo) / (hi - lo) : 0.5;
}

function stat(arr) {
  if (!arr.length) return { n: 0 };
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  return {
    n: arr.length,
    meanPct: +(m * 100).toFixed(2),
    downRate: +(arr.filter((x) => x < 0).length / arr.length * 100).toFixed(1),
    t: sd > 0 ? +(m / sd * Math.sqrt(arr.length)).toFixed(1) : 0,
  };
}

function main() {
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);
  console.log(`卖出侧检验 | 持有 ${HOLD} 日 | 收益为负才说明 S 信号有效\n`);

  const cases = {
    'A 高位+强流出 pos>0.8 & s<-1.5': [],
    'B 高位+强流出 pos>0.7 & s<-2': [],
    'C 中位+流出 pos>0.5 & s<-1.5': [],
    'D 高位+累计转负 pos>0.8 & cum下穿slow': [],
    'E 任意位+极强流出 s<-3': [],
  };

  for (const k of keys) {
    const r = ds.series[k];
    const ind = F.compute(r, { dir: 'vwap' });
    let lastExit = -1;
    for (let i = 61; i + HOLD + 1 < r.length; i++) {
      if (i <= lastExit) continue;
      const p = pos60(r, i);
      const s = ind.s[i];
      const entry = r[i + 1][1], exit = r[i + HOLD + 1][4];
      if (!(entry > 0) || !(exit > 0)) continue;
      const ret = exit / entry - 1 - COST;
      const hit = [];
      if (p > 0.8 && s < -1.5) hit.push('A');
      if (p > 0.7 && s < -2) hit.push('B');
      if (p > 0.5 && s < -1.5) hit.push('C');
      if (p > 0.8 && ind.fast[i - 1] >= ind.slow[i - 1] && ind.fast[i] < ind.slow[i]) hit.push('D');
      if (s < -3) hit.push('E');
      if (!hit.length) continue;
      for (const h of hit) {
        const label = Object.keys(cases).find((x) => x.startsWith(h));
        cases[label].push(ret);
      }
      lastExit = i + HOLD + 1;
    }
  }

  const out = {};
  for (const [k, arr] of Object.entries(cases)) out[k] = stat(arr);
  console.table(out);

  // 基准：全样本无条件 5 日收益
  const base = [];
  for (const k of keys) {
    const r = ds.series[k];
    for (let i = 61; i + HOLD + 1 < r.length; i += HOLD) {
      const entry = r[i + 1][1], exit = r[i + HOLD + 1][4];
      if (entry > 0 && exit > 0) base.push(exit / entry - 1 - COST);
    }
  }
  console.log('无条件基准：', JSON.stringify(stat(base)));
}

main();
