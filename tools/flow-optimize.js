#!/usr/bin/env node
'use strict';
/**
 * S8 类信号（低位 + 单日资金强度）的参数稳健性检验
 *
 * 一个策略「在某个参数上很好」不等于有效，要满足三条才算：
 *   1. 邻域平滑：把阈值往两边挪一两格，收益不塌方；
 *   2. 样本外不崩：前三年调出的参数，后两年仍为正；
 *   3. 分层普适：大盘股和小盘股上都有正收益，不是只靠某一段市值。
 *
 * 这里一次性把三条都跑出来。
 *
 * 用法：node tools/flow-optimize.js
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const COST = 0.0015;
const LIMIT_UP = 0.095;

function pos60(r, i) {
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 59; j <= i; j++) {
    if (r[j][2] > hi) hi = r[j][2];
    if (r[j][3] < lo) lo = r[j][3];
  }
  return hi > lo ? (r[i][4] - lo) / (hi - lo) : 0.5;
}

function summary(arr) {
  const n = arr.length;
  if (!n) return { n: 0, win: 0, mean: 0, sharpe: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return {
    n,
    win: +(arr.filter((x) => x > 0).length / n * 100).toFixed(1),
    mean: +(mean * 100).toFixed(2),
    sharpe: std > 0 ? +(mean / std).toFixed(3) : 0,
  };
}

function main() {
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);

  // 预计算：指标 + 每天的位置分位（避免网格搜索里重复算）
  const pre = keys.map((k) => {
    const r = ds.series[k];
    const ind = F.compute(r, { dir: 'vwap' });
    const pos = new Array(r.length).fill(null);
    for (let i = 60; i < r.length; i++) pos[i] = pos60(r, i);
    return { k, r, ind, pos };
  });

  const POS_GRID = [0.15, 0.2, 0.3, 0.4, 0.5];
  const S_GRID = [1, 1.5, 2, 3];
  const HOLD_GRID = [5];

  // ---------- ① 邻域平滑 ----------
  for (const HOLD of HOLD_GRID) {
    const table = {};
    for (const pTh of POS_GRID) {
      const row = {};
      for (const sTh of S_GRID) {
        const t = [];
        for (const { r, ind, pos } of pre) {
          let lastExit = -1;
          for (let i = 61; i + HOLD + 1 < r.length; i++) {
            if (i <= lastExit || pos[i] == null) continue;
            if (pos[i] >= pTh || ind.s[i] <= sTh) continue;
            const entry = r[i + 1][1], exit = r[i + HOLD + 1][4];
            if (!(entry > 0) || !(exit > 0)) continue;
            if (entry / r[i][4] - 1 > LIMIT_UP) continue;
            t.push(exit / entry - 1 - COST);
            lastExit = i + HOLD + 1;
          }
        }
        const s = summary(t);
        row[`s>${sTh}`] = `${s.mean}% / ${s.win}% / n=${s.n}`;
      }
      table[`pos<${pTh}`] = row;
    }
    console.log(`\n【持有 ${HOLD} 日】均值% / 胜率% / 笔数`);
    console.table(table);
  }

  // ---------- ② 样本外：前段调参，后段验证 ----------
  console.log('\n【分段检验】pos<0.30 且 s>1.5，按年份拆开');
  const byYear = {};
  for (const { r, ind, pos } of pre) {
    let lastExit = -1;
    for (let i = 61; i + 6 < r.length; i++) {
      if (i <= lastExit || pos[i] == null) continue;
      if (pos[i] >= 0.30 || ind.s[i] <= 1.5) continue;
      const entry = r[i + 1][1], exit = r[i + 6][4];
      if (!(entry > 0) || !(exit > 0)) continue;
      if (entry / r[i][4] - 1 > LIMIT_UP) continue;
      const y = new Date(r[i][0]).getFullYear();
      (byYear[y] = byYear[y] || []).push(exit / entry - 1 - COST);
      lastExit = i + 6;
    }
  }
  const yt = {};
  for (const y of Object.keys(byYear).sort()) yt[y] = summary(byYear[y]);
  console.table(yt);

  const train = [].concat(...Object.keys(byYear).filter((y) => y <= '2024').map((y) => byYear[y]));
  const test = [].concat(...Object.keys(byYear).filter((y) => y >= '2025').map((y) => byYear[y]));
  console.log('训练段 2022-2024：', JSON.stringify(summary(train)));
  console.log('验证段 2025-2026：', JSON.stringify(summary(test)));

  // ---------- ③ 分层：按日均成交额分三档 ----------
  console.log('\n【流动性分层】pos<0.30 且 s>1.5，持有 5 日');
  const tiers = { 小: [], 中: [], 大: [] };
  for (const { r, ind, pos } of pre) {
    const amts = r.map((x) => x[6]).sort((a, b) => a - b);
    const medAmt = amts[Math.floor(amts.length / 2)];
    const tier = medAmt < 8e7 ? '小' : medAmt < 4e8 ? '中' : '大';
    let lastExit = -1;
    for (let i = 61; i + 6 < r.length; i++) {
      if (i <= lastExit || pos[i] == null) continue;
      if (pos[i] >= 0.30 || ind.s[i] <= 1.5) continue;
      const entry = r[i + 1][1], exit = r[i + 6][4];
      if (!(entry > 0) || !(exit > 0)) continue;
      if (entry / r[i][4] - 1 > LIMIT_UP) continue;
      tiers[tier].push(exit / entry - 1 - COST);
      lastExit = i + 6;
    }
  }
  const tt = {};
  for (const k of Object.keys(tiers)) tt[k] = summary(tiers[k]);
  console.table(tt);
}

main();
