#!/usr/bin/env node
'use strict';
/**
 * 信号样本诊断
 *
 * 高分策略的第一嫌疑永远是「样本集中」：某些极端收益集中在某几个月，
 * 或者靠少数几只票撑起均值。这里把命中样本摊开看：
 *   ① 按年月统计笔数与均值 —— 看是否集中在单一行情段；
 *   ② 收益分布 —— 看均值是否被尾部几笔拉起来；
 *   ③ 抽样明细 —— 人工可核对。
 *
 * 用法：node tools/flow-diagnose.js --pos 0.2 --s 2 --hold 5
 */

const fs = require('fs');
const path = require('path');
const F = require('../lib/flow-signal');

const FILE = path.join(__dirname, '..', 'data', 'backtest', 'flow-dataset.json');
const COST = 0.0015;

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const POS_TH = Number(arg('--pos', 0.2));
const S_TH = Number(arg('--s', 2));
const HOLD = Number(arg('--hold', 5));

function pos60(r, i) {
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 59; j <= i; j++) {
    if (r[j][2] > hi) hi = r[j][2];
    if (r[j][3] < lo) lo = r[j][3];
  }
  return hi > lo ? (r[i][4] - lo) / (hi - lo) : 0.5;
}

function main() {
  const ds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const keys = Object.keys(ds.series);
  const trades = [];
  const byMonth = new Map();

  for (const k of keys) {
    const r = ds.series[k];
    const ind = F.compute(r, { dir: 'vwap' });
    let lastExit = -1;
    for (let i = 61; i + HOLD + 1 < r.length; i++) {
      if (i <= lastExit) continue;
      const p = pos60(r, i);
      if (p >= POS_TH || ind.s[i] <= S_TH) continue;
      const entry = r[i + 1][1], exit = r[i + HOLD + 1][4];
      if (!(entry > 0) || !(exit > 0)) continue;
      if (entry / r[i][4] - 1 > 0.095) continue;
      const ret = exit / entry - 1 - COST;
      const m = String(r[i][0]).slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(ret);
      trades.push({ k, d: r[i][0], pos: +p.toFixed(3), s: +ind.s[i].toFixed(2), ret, entry: entry.toFixed(2) });
      lastExit = i + HOLD + 1;
    }
  }

  console.log(`条件 pos<${POS_TH} & s>${S_TH} | 持有 ${HOLD} 日 | 共 ${trades.length} 笔\n`);

  // ① 按年月
  const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  console.log('【按年月】笔数 / 均值% / 胜率%');
  const rows = months.map(([m, arr]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length * 100;
    const win = arr.filter((x) => x > 0).length / arr.length * 100;
    return { 月份: m, 笔数: arr.length, 均值: +mean.toFixed(1), 胜率: +win.toFixed(0) };
  });
  console.table(rows);

  // ② 分布
  const sorted = trades.map((t) => t.ret).sort((a, b) => a - b);
  const q = (p) => (sorted[Math.floor(p * (sorted.length - 1))] * 100).toFixed(2);
  const mean = trades.reduce((a, t) => a + t.ret, 0) / trades.length * 100;
  const top10 = [...trades].sort((a, b) => b.ret - a.ret).slice(0, 10);
  const topShare = top10.reduce((a, t) => a + t.ret, 0) / (mean / 100 * trades.length) * 100;
  console.log(`\n【收益分布】均值 ${mean.toFixed(2)}% | P5 ${q(0.05)}% | P25 ${q(0.25)}% | 中位 ${q(0.5)}% | P75 ${q(0.75)}% | P95 ${q(0.95)}%`);
  console.log(`前 10 笔贡献了总收益的 ${topShare.toFixed(0)}%（>50% 说明靠尾部，不稳）`);

  // ③ 明细抽样
  console.log('\n【明细 · 前 12 笔（按时间）】');
  console.table(trades.slice(0, 12).map((t) => ({
    日期: t.d, 代码: t.k, 位置: t.pos, 强度: t.s, 开盘价: t.entry, 收益: +(t.ret * 100).toFixed(1),
  })));

  // ④ 剔除极端行情段再算：2024-02（救市反弹）、2024-09/10（政策行情）
  const scen = [
    ['剔除 2024-02', /^2024-02/],
    ['剔除 2024-02 与 09/10', /^2024-(02|09|10)/],
    ['只留 2025-2026', /^(2022|2023|2024)/],
  ];
  console.log('');
  for (const [label, re] of scen) {
    const arr = trades.filter((t) => !re.test(t.d));
    if (!arr.length) continue;
    const m = arr.reduce((a, t) => a + t.ret, 0) / arr.length * 100;
    const w = arr.filter((t) => t.ret > 0).length / arr.length * 100;
    const sd = Math.sqrt(arr.reduce((a, t) => a + (t.ret - m / 100) ** 2, 0) / arr.length);
    console.log(`${label}：${arr.length} 笔，均值 ${m.toFixed(2)}%，胜率 ${w.toFixed(1)}%，t=${(m/100/sd*Math.sqrt(arr.length)).toFixed(1)}`);
  }
}

main();
