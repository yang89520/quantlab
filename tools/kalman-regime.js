#!/usr/bin/env node
/* ============================================================
 * 卡尔曼 · 市场状态（regime）
 *
 * 个股层面找不到 alpha，是因为单只票的噪声把趋势信号淹了。
 * 但把全市场等权成一个指数后再滤波，噪声会互相抵消、趋势浮出来 ——
 * 这正是卡尔曼的强项，也是「什么时候该做趋势、什么时候该做反转」的依据。
 *
 * 输出：按 slopeZ 分档，看未来 5/10/20 日的市场收益，检验单调性。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', 'public', 'js', 'kalman.js'));

const ROOT = path.join(__dirname, '..');
const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'backtest', 'flow-dataset.json'), 'utf8'));
const series = {};
for (const k of Object.keys(ds.series)) if (ds.series[k].length >= 260) series[k] = ds.series[k];
const keys = Object.keys(series);

/* ---------- 全市场等权指数 ---------- */
const idx = {};
for (const k of keys) {
  const m = new Map();
  for (let i = 0; i < series[k].length; i++) m.set(String(series[k][i][0]), i);
  idx[k] = m;
}
const dates = [...new Set(keys.flatMap((k) => series[k].map((r) => String(r[0]))))].sort();

const idxRows = [];
let nav = 1;
for (let di = 0; di < dates.length; di++) {
  const d = dates[di];
  let sum = 0, n = 0;
  if (di > 0) {
    const dp = dates[di - 1];
    for (const k of keys) {
      const i = idx[k].get(d);
      if (i == null || i < 1 || idx[k].get(dp) !== i - 1) continue;
      const a = series[k][i - 1][4], b = series[k][i][4];
      if (!(a > 0) || !(b > 0)) continue;
      sum += b / a - 1; n++;
    }
    nav *= 1 + (n ? sum / n : 0);
  }
  idxRows.push([d, nav, nav, nav, nav, 0, 0]);
}
console.log(`等权指数 ${dates[0]} → ${dates[dates.length - 1]}  ${dates.length} 根  期末 ${nav.toFixed(3)}`);

/* ---------- 对指数跑卡尔曼 ---------- */
const A = K.analyze(idxRows, { snr: 0.3 });
const last = A.n - 1;
console.log(`末根 slopeZ ${A.slopeZ[last].toFixed(2)}  趋势 ${A.level[last].toFixed(3)}  收盘 ${A.price[last].toFixed(3)}  snr ${A.snr}`);

/* ---------- 分档统计未来收益 ---------- */
function fwdRet(i, H) {
  if (i + H >= A.n) return null;
  return A.price[i + H] / A.price[i] - 1;
}

function report(label, selector) {
  console.log(`\n=== ${label} ===`);
  console.log('分档                 样本   未来5日   未来10日  未来20日   胜率(10日)');
  const buckets = selector();
  for (const b of buckets) {
    const r5 = [], r10 = [], r20 = [];
    for (const i of b.idx) {
      const a = fwdRet(i, 5), c = fwdRet(i, 10), e = fwdRet(i, 20);
      if (a != null) r5.push(a);
      if (c != null) r10.push(c);
      if (e != null) r20.push(e);
    }
    const m = (x) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : 0);
    const w = r10.filter((x) => x > 0).length / (r10.length || 1);
    console.log(
      b.label.padEnd(20), String(b.idx.length).padStart(5),
      (m(r5) * 100).toFixed(2).padStart(8) + '%',
      (m(r10) * 100).toFixed(2).padStart(8) + '%',
      (m(r20) * 100).toFixed(2).padStart(8) + '%',
      (w * 100).toFixed(0).padStart(9) + '%'
    );
  }
}

// 按 slopeZ 绝对值分档
report('按 slopeZ 绝对值（趋势强度）', () => {
  const groups = [
    [0, 0.5, '< 0.5 无趋势'],
    [0.5, 1.0, '0.5 ~ 1.0'],
    [1.0, 1.5, '1.0 ~ 1.5'],
    [1.5, 2.5, '1.5 ~ 2.5'],
    [2.5, Infinity, '> 2.5 强趋势'],
  ];
  return groups.map(([lo, hi, lb]) => {
    const out = [];
    for (let i = 40; i < A.n; i++) {
      const z = Math.abs(A.slopeZ[i]);
      if (isFinite(z) && z >= lo && z < hi) out.push(i);
    }
    return { label: lb, idx: out };
  });
});

// 按 slopeZ 符号分档
report('按 slopeZ 符号', () => {
  const mk = (test, lb) => {
    const out = [];
    for (let i = 40; i < A.n; i++) if (isFinite(A.slopeZ[i]) && test(A.slopeZ[i])) out.push(i);
    return { label: lb, idx: out };
  };
  return [
    mk((z) => z > 2, '  > +2 强上升'),
    mk((z) => z > 0.5 && z <= 2, '+0.5 ~ +2'),
    mk((z) => z >= -0.5 && z <= 0.5, '-0.5 ~ +0.5 横盘'),
    mk((z) => z < -0.5 && z >= -2, '-2 ~ -0.5'),
    mk((z) => z < -2, '  < -2 强下跌'),
  ];
});

// 按 dev（偏离通道）分档
report('按 dev（偏离通道宽度）', () => {
  const groups = [
    [-Infinity, -1.5, '< -1.5 破下轨'],
    [-1.5, -0.5, '-1.5 ~ -0.5'],
    [-0.5, 0.5, '-0.5 ~ +0.5 通道内'],
    [0.5, 1.5, '+0.5 ~ +1.5'],
    [1.5, Infinity, '> +1.5 破上轨'],
  ];
  return groups.map(([lo, hi, lb]) => {
    const out = [];
    for (let i = 40; i < A.n; i++) {
      const v = A.dev[i];
      if (isFinite(v) && v >= lo && v < hi) out.push(i);
    }
    return { label: lb, idx: out };
  });
});

/* ---------- 状态持续性：slopeZ 符号的平均持续周数 ---------- */
let run = 0, runs = [], curSign = 0;
for (let i = 1; i < A.n; i++) {
  const s = A.slopeZ[i] > 0 ? 1 : -1;
  if (s !== curSign) { if (run > 0) runs.push(run); curSign = s; run = 0; }
  run++;
}
const avgRun = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
console.log(`\nslopeZ 符号平均持续 ${avgRun.toFixed(1)} 个交易日（${(avgRun / 5).toFixed(1)} 周），共 ${runs.length} 段`);
console.log(`当前状态：slopeZ ${A.slopeZ[last].toFixed(2)}，dev ${A.dev[last].toFixed(2)}，已持续 ${run} 根`);
