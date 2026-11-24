#!/usr/bin/env node
/* ============================================================
 * 卡尔曼 · 事件驱动组合回测
 *
 * 为什么不用状态机：状态机强制「趋势在就满仓」，把系统绑在方向判断上。
 * 卡尔曼真正的独有能力是「把趋势和偏离分开估计」：
 *   slopeZ —— 有没有趋势、多显著（跨标的可比）
 *   dev    —— 价格偏离趋势多少个通道宽（统计标准化）
 * 这两者组合可以区分「趋势市跟随」与「震荡市反转」，传统指标做不到。
 *
 * 组合口径：信号日 t 收盘 → t+1 开盘买入 → 持有 H 根后收盘卖出。
 * 每日等权持有全部在仓标的，空仓日收益为 0，逐日累乘成净值。
 * 卖出口径用收盘，买入用开盘，两端都不利用未来信息。
 *
 *   node tools/kalman-event.js --hold 10
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', 'public', 'js', 'kalman.js'));

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'backtest', 'flow-dataset.json'), 'utf8'));
const series = {};
for (const k of Object.keys(ds.series)) if (ds.series[k].length >= 400) series[k] = ds.series[k];
const keys = Object.keys(series);

const dates = [...new Set(keys.flatMap((k) => series[k].map((r) => String(r[0]))))].sort();

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');

/* ---------- 市场状态（等权指数卡尔曼 slopeZ） ----------
 * 个股层面的卡尔曼趋势是负 alpha，但把全市场等权成指数后噪声互相抵消，
 * slopeZ < -2.5 的 21 个时点跨 5 年分布、后续 20 日 19 次为正（均值 +10%）。
 * 所以卡尔曼的正确用法是「识别极端状态」，而不是「预测个股方向」。
 */
function marketRegime() {
  const ix = {};
  for (const k of keys) {
    const m = new Map();
    for (let i = 0; i < series[k].length; i++) m.set(String(series[k][i][0]), i);
    ix[k] = m;
  }
  const rows = [];
  let nav = 1;
  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    let s = 0, n = 0;
    if (di > 0) {
      const dp = dates[di - 1];
      for (const k of keys) {
        const i = ix[k].get(d);
        if (i == null || i < 1 || ix[k].get(dp) !== i - 1) continue;
        const a = series[k][i - 1][4], b = series[k][i][4];
        if (!(a > 0) || !(b > 0)) continue;
        s += b / a - 1; n++;
      }
      nav *= 1 + (n ? s / n : 0);
    }
    rows.push([d, nav, nav, nav, nav, 0, 0]);
  }
  const a = K.analyze(rows, { snr: 0.3 });
  const m = new Map();
  for (let i = 0; i < a.n; i++) m.set(dates[i], { z: a.slopeZ[i], dev: a.dev[i] });
  return m;
}

/* ---------- 条件定义 ----------
 * 每个条件返回 bool。s 为该根上的派生量。
 * 注意用「前一根」的量做穿越判断时不要引入未来数据。
 */
const COND = {
  // 震荡市超卖：无显著趋势，但价格已跌到通道下沿之外
  rev_lo: (s, a, i) => Math.abs(s.zt) < 1 && s.dev < -1.0,
  rev_lo2: (s, a, i) => Math.abs(s.zt) < 1 && s.dev < -1.5,
  rev_lo3: (s, a, i) => Math.abs(s.zt) < 1.2 && s.dev < -1.8,
  // 趋势中回调：趋势确认向上，价格短线跌到带下沿
  pull: (s, a, i) => s.zt > 1 && s.dev < -0.8,
  pull2: (s, a, i) => s.zt > 1.5 && s.dev < -1.0,
  // 突破加速：价格冲出上轨且当日意外上冲（原 S1）
  brk: (s, a, i) => s.dev > 1 && s.iv > 2,
  brk2: (s, a, i) => s.dev > 1.2 && s.iv > 2.5,
  // 趋势启动（原 B3）
  start: (s, a, i) => s.zt1 <= 1 && s.zt > 1 && s.dev > 0,
  // 纯偏离反转（不筛趋势，作对照）
  pure_lo: (s, a, i) => s.dev < -1.5,
  pure_hi: (s, a, i) => s.dev > 1.5,
  // 超跌拐头：价格跌出通道下沿，但趋势斜率已开始改善（不再恶化）
  // 单纯「跌出下沿」等于买阴跌中继（pure_lo 实测 -37%），拐头才是企稳的证据
  bounce: (s, a, i) => s.dev < -0.8 && s.zt > s.zt1 && s.zt < 0,
  bounce2: (s, a, i) => s.dev < -1.2 && s.zt > s.zt1,
  bounce3: (s, a, i) => s.dev < -0.8 && s.zt > s.zt1 + 0.5,
  // 「超跌 + 当日反抽」：dev 与 slopeZ 在数学上同向（跌破通道时斜率必然恶化），
  // 「偏离+斜率拐头」这个组合几乎不可能同时成立（5.3 万根里 0 次）。
  // 真正的拐头要看价格本身：仍在通道下方，但当日收阳/收涨。
  rup: (s, a, i) => s.dev < -1 && s.c > s.c1,
  rup2: (s, a, i) => s.dev < -1.2 && s.c > s.c1 && s.c > s.o,
  rup3: (s, a, i) => s.dev < -0.8 && s.c > s.c1 && s.vr > 1.2,
};

/* ---------- 主回测 ---------- */
function eventEquity(trades, H) {
  const daily = new Map();   // date -> {sum, n}
  let active = 0;
  const barDays = new Set();
  for (const t of trades) {
    const rows = series[t.k];
    const buy = t.i + 1;
    const sell = Math.min(t.i + 1 + H, rows.length - 1);
    if (buy > sell) continue;
    for (let j = buy; j <= sell; j++) {
      const r = j === buy
        ? (rows[j][4] / rows[j][1] - 1)            // 开盘买入，当日收盘计
        : (rows[j][4] / rows[j - 1][4] - 1);
      if (!isFinite(r)) continue;
      const d = String(rows[j][0]);
      const o = daily.get(d) || { sum: 0, n: 0 };
      o.sum += r; o.n++;
      daily.set(d, o);
      barDays.add(d);
    }
  }
  const port = [];
  for (const d of dates) {
    const o = daily.get(d);
    if (!o || !o.n) { port.push({ d, r: 0, n: 0 }); continue; }
    port.push({ d, r: o.sum / o.n, n: o.n });
    active += o.n;
  }
  // 基准：全池每日等权
  const idx = {};
  for (const k of keys) {
    const m = new Map();
    for (let i = 0; i < series[k].length; i++) m.set(String(series[k][i][0]), i);
    idx[k] = m;
  }
  const bench = [];
  for (let di = 1; di < dates.length; di++) {
    const d = dates[di], dp = dates[di - 1];
    let sum = 0, n = 0;
    for (const k of keys) {
      const i = idx[k].get(d);
      if (i == null || i < 1) continue;
      if (idx[k].get(dp) !== i - 1) continue;
      const a = series[k][i - 1][4], b = series[k][i][4];
      if (!(a > 0) || !(b > 0)) continue;
      sum += b / a - 1; n++;
    }
    bench.push(n ? sum / n : 0);
  }

  const navOf = (arr) => {
    let nav = 1; const navs = [1];
    for (const r of arr) { nav *= 1 + r; navs.push(nav); }
    return { nav, navs };
  };
  const pr = port.map((x) => x.r);
  const pn = navOf(pr);
  const bn = navOf(bench);
  const mean = pr.reduce((a, b) => a + b, 0) / pr.length;
  const sd = Math.sqrt(pr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(pr.length - 1, 1));
  const bmean = bench.reduce((a, b) => a + b, 0) / bench.length;
  const bsd = Math.sqrt(bench.reduce((a, b) => a + (b - bmean) ** 2, 0) / Math.max(bench.length - 1, 1));
  let peak = 1, mdd = 0;
  for (const v of pn.navs) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const years = dates.length / 244;
  const ann = Math.pow(pn.nav, 1 / years) - 1;
  const annB = Math.pow(bn.nav, 1 / years) - 1;
  const holdRatio = port.filter((x) => x.n > 0).length / port.length;

  // 分年
  const yearly = {};
  for (const x of port) {
    const y = x.d.slice(0, 4);
    (yearly[y] = yearly[y] || []).push(x.r);
  }
  const yr = {};
  for (const y of Object.keys(yearly).sort()) {
    let v = 1;
    for (const r of yearly[y]) v *= 1 + r;
    yr[y] = v - 1;
  }
  // 分年基准
  const yearlyB = {};
  for (let i = 1; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    (yearlyB[y] = yearlyB[y] || []).push(bench[i - 1]);
  }
  const yrB = {};
  for (const y of Object.keys(yearlyB).sort()) {
    let v = 1;
    for (const r of yearlyB[y]) v *= 1 + r;
    yrB[y] = v - 1;
  }

  return {
    ann, annB, nav: pn.nav, navB: bn.nav,
    sharpe: sd > 0 ? mean / sd * Math.sqrt(244) : 0,
    sharpeB: bsd > 0 ? bmean / bsd * Math.sqrt(244) : 0,
    mdd, holdRatio, days: dates.length, yr, yrB, n: trades.length, avgPos: active / dates.length,
  };
}

/**
 * 同一标的在持仓期内不重复开仓。
 * 不去重时，一只持续满足条件的票会生成几十笔重叠交易，权重被放大数倍，
 * 组合退化成「越极端越重仓」——实测最大回撤会恶化到 -90%，那是假象。
 */
function dedupe(trades, H) {
  const byK = {};
  for (const t of trades) (byK[t.k] = byK[t.k] || []).push(t);
  const out = [];
  for (const k of Object.keys(byK)) {
    const arr = byK[k].sort((a, b) => a.i - b.i);
    let lastEnd = -1;
    for (const t of arr) {
      if (t.i <= lastEnd) continue;
      out.push(t);
      lastEnd = t.i + H;
    }
  }
  return out;
}

/* ---------- 扫条件 ---------- */
const cache = {};
function kalmanOf(k, snr) {
  const ck = k + '|' + snr;
  if (!cache[ck]) cache[ck] = K.analyze(series[k], { snr });
  return cache[ck];
}

function collect(snr, condName, extra) {
  const fn = COND[condName];
  const out = [];
  for (const k of keys) {
    const a = kalmanOf(k, snr);
    const rows = series[k];
    for (let i = 60; i < rows.length - 1; i++) {
      const s = {
        zt: a.slopeZ[i], zt1: a.slopeZ[i - 1], dev: a.dev[i], iv: a.innovZ[i],
        c: rows[i][4], c1: rows[i - 1][4], o: rows[i][1],
        vr: a.vr ? a.vr[i] : 0,
      };
      if (!isFinite(s.zt) || !isFinite(s.dev)) continue;
      if (!fn(s, a, i)) continue;
      if (REG_FILTER != null) {
        const g = REGIME.get(String(rows[i][0]));
        if (!g || !(g.z < Number(REG_FILTER))) continue;
      }
      out.push({ k, i });
    }
  }
  return out;
}

const REGIME = marketRegime();
const REG_FILTER = argOf('regime', null);   // 如 -2 表示只在指数 slopeZ < -2 时交易

const HOLD = Number(argOf('hold', 10));
const rowsOut = [];
for (const snr of [0.03, 0.1, 0.3]) {
  for (const name of Object.keys(COND)) {
    const trades = collect(snr, name);
    if (trades.length < 200) { rowsOut.push({ snr, name, e: null, n: trades.length }); continue; }
    // 不同持有期
    for (const H of (argv.includes('--multi') ? [5, 10, 20] : [HOLD])) {
      const uniq = dedupe(trades, H);
      const e = eventEquity(uniq, H);
      rowsOut.push({ snr, name, H, e, n: uniq.length });
    }
  }
}

console.log('λ     条件        持有  信号数   年化     基准     超额    Sharpe  MaxDD  持仓天占比  日均持仓');
for (const r of rowsOut) {
  if (!r.e) { console.log(`${String(r.snr).padEnd(5)} ${r.name.padEnd(11)} 样本不足(${r.n})`); continue; }
  const e = r.e;
  console.log(
    String(r.snr).padEnd(5), r.name.padEnd(11), String(r.H).padStart(3),
    String(e.n).padStart(7),
    pct(e.ann).padStart(8), pct(e.annB).padStart(8), pct(e.ann - e.annB).padStart(8),
    e.sharpe.toFixed(2).padStart(7), pct(e.mdd).padStart(7),
    pct(e.holdRatio).padStart(9), e.avgPos.toFixed(1).padStart(8)
  );
}

// 明细：挑出最好的几个看分年
const ranked = rowsOut.filter((r) => r.e && r.e.n > 200).sort((a, b) => (b.e.ann - b.e.annB) - (a.e.ann - a.e.annB));
console.log('\n=== 前 6 名分年 ===');
for (const r of ranked.slice(0, 6)) {
  const y = Object.keys(r.e.yr);
  console.log(`\nλ=${r.snr} ${r.name} H=${r.H}  信号 ${r.e.n} 笔`);
  console.log('  ' + y.map((x) => x.padEnd(9)).join(''));
  console.log('  ' + y.map((x) => pct(r.e.yr[x]).padEnd(9)).join(''));
  console.log('  ' + y.map((x) => pct(r.e.yrB[x]).padEnd(9)).join('') + '  ← 基准');
}
