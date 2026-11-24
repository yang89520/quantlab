#!/usr/bin/env node
/* ============================================================
 * 卡尔曼趋势系统 · 回测
 *
 *   node tools/kalman-backtest.js --mode state    状态机跟随（λ × enterZ × exitZ 网格）
 *   node tools/kalman-backtest.js --mode signal   信号驱动（B3 买 / S3 卖）
 *   node tools/kalman-backtest.js --mode hold     信号后固定持有 N 根
 *   node tools/kalman-backtest.js --mode cross    横截面选股（每日按 score 排序）
 *
 * 交易假设：
 *   t 日收盘出信号 → t+1 开盘成交；扣单边 0.075%（含滑点），双边 0.15%
 *   次日开盘涨停（>9.5%）视为买不到，跳过该笔 —— 不做这个过滤的 A 股回测
 *   会凭空造出一批「买入即涨停」的假收益
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', 'public', 'js', 'kalman.js'));

const ROOT = path.join(__dirname, '..');
const COST = 0.0015;
const LIMIT_UP = 0.095;

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const MODE = argOf('mode', 'state');
const YEAR = argOf('year', null);

function load() {
  const p = path.join(ROOT, 'data', 'backtest', 'flow-dataset.json');
  const ds = JSON.parse(fs.readFileSync(p, 'utf8'));
  const series = {};
  for (const k of Object.keys(ds.series)) {
    const r = ds.series[k];
    if (r.length >= 260) series[k] = r;
  }
  return series;
}

/* ---------- 统计 ---------- */
function stat(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
  const win = arr.filter((x) => x > 0);
  const loss = arr.filter((x) => x <= 0);
  const avgWin = win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0;
  const avgLoss = loss.length ? loss.reduce((a, b) => a + b, 0) / loss.length : 0;
  return {
    n,
    mean,
    median: n % 2 ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2,
    sd,
    win: win.length / n,
    pf: avgLoss ? Math.abs(avgWin / avgLoss) : Infinity,
    t: sd > 0 ? mean / sd * Math.sqrt(n) : 0,
  };
}

const pct = (x, d = 2) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const f2 = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(2));

/* ---------- 交易簿 ---------- */
function book() { return []; }

function closeTrade(bk, t) { bk.push(t); }

/**
 * 状态机：pos 由 0→1 建仓、1→0 平仓。
 * 出场用「次根开盘」，与入场对称，避免用当日收盘价出场（那是不可实现的）。
 */
function runState(rows, a, opt) {
  const bk = book();
  const n = rows.length;
  let inP = null, inI = -1;
  for (let i = opt.warm; i < n - 1; i++) {
    const p0 = a.pos[i - 1], p1 = a.pos[i];
    if (p0 === 0 && p1 === 1) {
      const buy = rows[i + 1][1];
      if (!(buy > 0)) continue;
      if (buy / rows[i][4] - 1 > LIMIT_UP) continue;   // 次日开盘涨停，买不到
      inP = buy; inI = i + 1;
    } else if (p0 === 1 && p1 === 0 && inP != null) {
      const sell = rows[i + 1][1];
      if (!(sell > 0)) continue;
      closeTrade(bk, { inD: rows[inI][0], inP, outP: sell, bars: i + 1 - inI, ret: sell / inP - 1 - COST });
      inP = null; inI = -1;
    }
  }
  if (inP != null) {
    const last = rows[n - 1][4];
    closeTrade(bk, { inD: rows[inI][0], inP, outP: last, bars: n - 1 - inI, ret: last / inP - 1 - COST });
  }
  return bk;
}

/** 信号驱动：出现 side 信号后次日开盘入场，此后出现反向 3 级信号或持有期满离场 */
function runSignal(rows, a, opt) {
  const bk = book();
  const n = rows.length;
  const sig = a.signals;
  let inP = null, inI = -1;
  let j = 0;
  for (let i = opt.warm; i < n - 1; i++) {
    while (j < sig.length && sig[j].i < i) j++;
    const here = sig[j] && sig[j].i === i ? sig[j] : null;
    if (inP == null) {
      if (here && here.side === 'B' && here.grade >= (opt.minGrade || 2)) {
        const buy = rows[i + 1][1];
        if (!(buy > 0)) continue;
        if (buy / rows[i][4] - 1 > LIMIT_UP) continue;
        inP = buy; inI = i + 1;
      }
    } else {
      const held = i + 1 - inI;
      const hitStop = here && here.side === 'S' && here.grade >= 3;
      const timeout = opt.maxHold && held >= opt.maxHold;
      if (hitStop || timeout) {
        const sell = rows[i + 1][1];
        if (!(sell > 0)) continue;
        closeTrade(bk, { inD: rows[inI][0], inP, outP: sell, bars: i + 1 - inI, ret: sell / inP - 1 - COST });
        inP = null; inI = -1;
      }
    }
  }
  if (inP != null) {
    const last = rows[n - 1][4];
    closeTrade(bk, { inD: rows[inI][0], inP, outP: last, bars: n - 1 - inI, ret: last / inP - 1 - COST });
  }
  return bk;
}

/** 固定持有 N 根：统计「某条件下买入，N 根后卖出」的条件分布 */
function runHold(rows, a, opt) {
  const bk = book();
  const n = rows.length;
  const H = opt.hold || 10;
  const sig = a.signals;
  let j = 0;
  for (let i = opt.warm; i + H < n; i++) {
    while (j < sig.length && sig[j].i < i) j++;
    const here = sig[j] && sig[j].i === i ? sig[j] : null;
    if (!here) continue;
    if (!opt.filter(here)) continue;
    const buy = rows[i + 1][1], sell = rows[i + H][4];
    if (!(buy > 0) || !(sell > 0)) continue;
    if (buy / rows[i][4] - 1 > LIMIT_UP) continue;
    closeTrade(bk, { inD: rows[i][0], inP: buy, outP: sell, bars: H, ret: sell / buy - 1 - COST });
  }
  return bk;
}

/* ---------- 基准：同池无条件买入持有 N 根 ---------- */
function baseline(series, H, year) {
  const out = [];
  for (const k of Object.keys(series)) {
    const r = series[k];
    for (let i = 60; i + H < r.length; i += H) {
      if (year && String(r[i][0]).slice(0, 4) !== String(year)) continue;
      const buy = r[i + 1][1], sell = r[i + H][4];
      if (!(buy > 0) || !(sell > 0)) continue;
      if (buy / r[i][4] - 1 > LIMIT_UP) continue;
      out.push(sell / buy - 1 - COST);
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */
const series = load();
const keys = Object.keys(series);
const t0 = Date.now();
console.log(`样本 ${keys.length} 只 · 日线 · ${YEAR ? '仅 ' + YEAR + ' 年' : '全区间'}`);

function analyzeAll(lam, opt) {
  const map = {};
  for (const k of keys) {
    const rows = series[k];
    map[k] = K.analyze(rows, Object.assign({ snr: lam }, opt));
  }
  return map;
}

if (MODE === 'state') {
  const LAMS = [3e-3, 1e-2, 3e-2, 1e-1, 3e-1];
  const ENTER = [0.8, 1.0, 1.5, 2.0];
  const EXIT = [-1.0, -0.5, 0, 0.5];
  console.log('\nλ       enterZ  exitZ   笔数   胜率    均值      中位    盈亏比   均持仓   年化     t');
  for (const lam of LAMS) {
    for (const ez of ENTER) {
      for (const xz of EXIT) {
        const all = [];
        const bars = [];
        for (const k of keys) {
          const rows = series[k];
          const a = K.analyze(rows, { snr: lam, enterZ: ez, exitZ: xz });
          const bk = runState(rows, a, { warm: 60 });
          for (const t of bk) {
            if (YEAR && String(t.inD).slice(0, 4) !== String(YEAR)) continue;
            all.push(t.ret); bars.push(t.bars);
          }
        }
        const s = stat(all);
        const avgBars = bars.length ? bars.reduce((a, b) => a + b, 0) / bars.length : 0;
        const yr = avgBars > 0 ? Math.pow(1 + s.mean, 244 / avgBars) - 1 : 0;
        console.log(
          f2(lam).padEnd(7), String(ez).padEnd(7), String(xz).padEnd(6),
          String(s.n).padStart(5), pct(s.win, 1).padStart(6),
          pct(s.mean).padStart(8), pct(s.median).padStart(8),
          f2(s.pf).padStart(7), f2(avgBars).padStart(7),
          pct(yr, 0).padStart(7), f2(s.t).padStart(7)
        );
      }
    }
  }
  const b = stat(baseline(series, 20, YEAR));
  console.log(`\n基准（无条件买入持有 20 根）：${b.n} 笔 均值 ${pct(b.mean)} 胜率 ${pct(b.win, 1)} 中位 ${pct(b.median)}`);
}

if (MODE === 'signal') {
  const LAMS = [1e-2, 3e-2, 1e-1, 3e-1];
  console.log('\nλ       最低级别  最长持有  笔数   胜率    均值      中位    盈亏比   均持仓    t');
  for (const lam of LAMS) {
    for (const mg of [2, 3]) {
      for (const mh of [0, 20, 40]) {
        const all = [], bars = [];
        for (const k of keys) {
          const rows = series[k];
          const a = K.analyze(rows, { snr: lam });
          const bk = runSignal(rows, a, { warm: 60, minGrade: mg, maxHold: mh });
          for (const t of bk) {
            if (YEAR && String(t.inD).slice(0, 4) !== String(YEAR)) continue;
            all.push(t.ret); bars.push(t.bars);
          }
        }
        const s = stat(all);
        const avgBars = bars.length ? bars.reduce((a, b) => a + b, 0) / bars.length : 0;
        console.log(
          f2(lam).padEnd(7), String('B' + mg).padEnd(9), String(mh || '—').padEnd(9),
          String(s.n).padStart(5), pct(s.win, 1).padStart(6),
          pct(s.mean).padStart(8), pct(s.median).padStart(8),
          f2(s.pf).padStart(7), f2(avgBars).padStart(7), f2(s.t).padStart(7)
        );
      }
    }
  }
}

if (MODE === 'hold') {
  const LAMS = [1e-2, 3e-2, 1e-1, 3e-1];
  const kinds = [
    ['B3 启动', (s) => s.side === 'B' && s.grade === 3],
    ['B2 回调', (s) => s.side === 'B' && s.grade === 2],
    ['B1 突破', (s) => s.side === 'B' && s.grade === 1],
    ['S3 破位', (s) => s.side === 'S' && s.grade === 3],
    ['S1 过热', (s) => s.side === 'S' && s.grade === 1],
  ];
  for (const H of [5, 10, 20]) {
    console.log(`\n=== 持有 ${H} 根 ===`);
    console.log('λ       类型        笔数   胜率    均值      中位    盈亏比    t');
    for (const lam of LAMS) {
      for (const [label, fn] of kinds) {
        const all = [];
        for (const k of keys) {
          const rows = series[k];
          const a = K.analyze(rows, { snr: lam });
          for (const t of runHold(rows, a, { warm: 60, hold: H, filter: fn })) {
            if (YEAR && String(t.inD).slice(0, 4) !== String(YEAR)) continue;
            all.push(t.ret);
          }
        }
        const s = stat(all);
        if (!s.n) continue;
        console.log(
          f2(lam).padEnd(7), label.padEnd(11),
          String(s.n).padStart(5), pct(s.win, 1).padStart(6),
          pct(s.mean).padStart(8), pct(s.median).padStart(8),
          f2(s.pf).padStart(7), f2(s.t).padStart(7)
        );
      }
    }
    const b = stat(baseline(series, H, YEAR));
    console.log(`基准：${b.n} 笔 均值 ${pct(b.mean)} 胜率 ${pct(b.win, 1)} 中位 ${pct(b.median)}`);
  }
}

if (MODE === 'cross') {
  // 横截面：每个交易日按 score 排序，取前 N 只等权，持有 H 根
  const LAMS = [3e-2, 1e-1, 3e-1];
  for (const lam of LAMS) {
    const cache = {};
    for (const k of keys) cache[k] = K.analyze(series[k], { snr: lam });
    // 建立日期 -> [{k, i, score}]
    const byDate = new Map();
    for (const k of keys) {
      const rows = series[k], a = cache[k];
      for (let i = 80; i < rows.length; i++) {
        const zt = a.slopeZ[i];
        if (!isFinite(zt)) continue;
        const d = String(rows[i][0]);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({ k, i, zt, dev: a.band[i] > 0 ? (a.price[i] - a.level[i]) / a.band[i] : 0 });
      }
    }
    for (const H of [5, 10, 20]) {
      for (const N of [5, 10, 20]) {
        const rets = [];
        for (const [d, arr] of byDate) {
          if (YEAR && d.slice(0, 4) !== String(YEAR)) continue;
          arr.sort((x, y) => y.zt - x.zt);
          const pick = arr.slice(0, N);
          for (const p of pick) {
            const rows = series[p.k];
            if (p.i + 1 + H >= rows.length) continue;
            const buy = rows[p.i + 1][1], sell = rows[p.i + H][4];
            if (!(buy > 0) || !(sell > 0)) continue;
            if (buy / rows[p.i][4] - 1 > LIMIT_UP) continue;
            rets.push(sell / buy - 1 - COST);
          }
        }
        const s = stat(rets);
        console.log(`λ=${f2(lam)} N=${String(N).padStart(2)} H=${String(H).padStart(2)}  ${String(s.n).padStart(6)} 笔  胜率 ${pct(s.win, 1)}  均值 ${pct(s.mean)}  中位 ${pct(s.median)}  t ${f2(s.t)}`);
      }
    }
    console.log('');
  }
  const b = stat(baseline(series, 10, YEAR));
  console.log(`基准（持有 10 根）：均值 ${pct(b.mean)} 胜率 ${pct(b.win, 1)}`);
}

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
