#!/usr/bin/env node
/* ============================================================
 * 卡尔曼趋势系统 · 组合层回测
 *
 * 单笔均值 × 年化次数 会系统性高估：空仓期不产生收益，却被算进年化。
 * 这里构造真实净值曲线：每日按「前一日收盘」的持仓状态等权持有，
 * 空仓则收益为 0，再算年化 / Sharpe / 最大回撤 / 持仓占比。
 *
 *   node tools/kalman-portfolio.js --snr 0.1 --enter 1.0 --exit -1
 *   node tools/kalman-portfolio.js --grid        参数网格
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', 'public', 'js', 'kalman.js'));

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const GRID = argv.includes('--grid');

const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'backtest', 'flow-dataset.json'), 'utf8'));
const PERIOD = argOf('period', 'day');

/* 日线聚合成周线：开=首日开，高=max，低=min，收=末日收，量额求和。
 * 不做复权调整——源数据已是同一复权口径，直接聚合即可。 */
function toWeek(rows) {
  const out = [];
  let cur = null, key = null;
  for (const r of rows) {
    const t = Date.parse(r[0] + 'T00:00:00Z');
    if (!isFinite(t)) continue;
    const d = new Date(t);
    // 标签统一取该周周一。若用「该周实际最后一个交易日」，停牌股会把同一周
    // 标成不同日期，全局日历出现重复周，收益被算两遍（实测基准虚高到 24%）。
    const dow = (d.getUTCDay() + 6) % 7;
    const kk = new Date(t - dow * 86400000).toISOString().slice(0, 10);
    if (kk !== key) {
      if (cur) out.push(cur);
      cur = [kk, r[1], r[2], r[3], r[4], r[5] || 0, r[6] || 0];
      key = kk;
    } else {
      cur[2] = Math.max(cur[2], r[2]);
      cur[3] = Math.min(cur[3], r[3]);
      cur[4] = r[4];
      cur[5] += r[5] || 0;
      cur[6] += r[6] || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const series = {};
for (const k of Object.keys(ds.series)) {
  let r = ds.series[k];
  if (PERIOD === 'week') r = toWeek(r);
  if (r.length >= (PERIOD === 'week' ? 60 : 260)) series[k] = r;
}
const keys = Object.keys(series);
// 周线的年化基数
const BARS_PER_YEAR = PERIOD === 'week' ? 49 : 244;

/* ---------- 构造全局交易日历 ---------- */
const dateSet = new Set();
for (const k of keys) for (const r of series[k]) dateSet.add(String(r[0]));
const dates = [...dateSet].sort();

/* 每只票：日期 -> 索引，以及日收益率 */
const idxOf = {}, retOf = {};
for (const k of keys) {
  const m = new Map(), rr = new Array(series[k].length).fill(0);
  for (let i = 0; i < series[k].length; i++) m.set(String(series[k][i][0]), i);
  for (let i = 1; i < series[k].length; i++) {
    const a = series[k][i - 1][4], b = series[k][i][4];
    rr[i] = a > 0 && b > 0 ? b / a - 1 : 0;
  }
  idxOf[k] = m; retOf[k] = rr;
}

/* ---------- 净值计算 ---------- */
function equity(maskAt) {
  // maskAt(k, i) -> 0/1 表示第 i 根（收盘后）是否应持仓，实际持有从 i+1 起
  const navB = [], navS = [];
  const port = [], bench = [];
  let navP = 1, navBv = 1;
  let holdSum = 0, cnt = 0;
  const yearly = {};

  for (let di = 1; di < dates.length; di++) {
    const d = dates[di], dPrev = dates[di - 1];
    let sum = 0, n = 0, bs = 0, bn = 0;
    for (const k of keys) {
      const i = idxOf[k].get(d);
      if (i == null || i < 1) continue;
      // 前一日必须也有数据，否则这根是停牌复牌，收益率不可用
      if (idxOf[k].get(dPrev) !== i - 1) continue;
      const r = retOf[k][i];
      bs += r; bn++;
      const m = maskAt(k, i - 1);
      if (m) { sum += r; n++; }
    }
    const rp = n ? sum / n : 0;
    const rb = bn ? bs / bn : 0;
    navP *= 1 + rp; navBv *= 1 + rb;
    port.push(rp); bench.push(rb);
    holdSum += n; cnt++;
    const y = d.slice(0, 4);
    (yearly[y] = yearly[y] || { p: [], b: [], hold: 0, days: 0 });
    yearly[y].p.push(rp); yearly[y].b.push(rb);
    yearly[y].hold += n; yearly[y].days++;
    navB.push([d, navBv]); navS.push([d, navP]);
  }

  const stat = (arr) => {
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
    return { mean, sd, sharpe: sd > 0 ? mean / sd * Math.sqrt(BARS_PER_YEAR) : 0 };
  };
  const sp = stat(port), sb = stat(bench);
  let peak = 1, mdd = 0;
  for (const [, v] of navS) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const years = dates.length / BARS_PER_YEAR;
  const ann = Math.pow(navS[navS.length - 1][1], 1 / years) - 1;
  const annB = Math.pow(navB[navB.length - 1][1], 1 / years) - 1;

  const yr = {};
  for (const y of Object.keys(yearly).sort()) {
    const o = yearly[y];
    let np = 1, nb = 1;
    for (const r of o.p) np *= 1 + r;
    for (const r of o.b) nb *= 1 + r;
    yr[y] = { p: np - 1, b: nb - 1, hold: o.hold / (o.days * keys.length) };
  }

  return {
    ann, annB, sharpe: sp.sharpe, sharpeB: sb.sharpe, mdd,
    hold: holdSum / cnt / keys.length, nav: navS[navS.length - 1][1], navB: navB[navB.length - 1][1],
    yearly: yr, days: dates.length,
  };
}

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');

function buildMask(snr, enter, exit, warm) {
  const pos = {};
  for (const k of keys) {
    const a = K.analyze(series[k], { snr, enterZ: enter, exitZ: exit });
    pos[k] = a.pos;
  }
  return (k, i) => (pos[k] && pos[k][i] === 1 ? 1 : 0);
}

if (GRID) {
  console.log('λ      enter  exit   年化     基准     超额     Sharpe  基准Sh   MaxDD   持仓占比');
  for (const snr of [0.01, 0.03, 0.1, 0.3]) {
    for (const enter of [0.8, 1.0, 1.5]) {
      for (const exit of [-1.0, -0.5, 0]) {
        const m = buildMask(snr, enter, exit, 30);
        const e = equity(m);
        console.log(
          String(snr).padEnd(6), String(enter).padEnd(6), String(exit).padEnd(6),
          pct(e.ann).padStart(8), pct(e.annB).padStart(8), pct(e.ann - e.annB).padStart(8),
          e.sharpe.toFixed(2).padStart(8), e.sharpeB.toFixed(2).padStart(7),
          pct(e.mdd).padStart(8), pct(e.hold).padStart(9)
        );
      }
    }
  }
} else {
  const snr = Number(argOf('snr', 0.1));
  const enter = Number(argOf('enter', 1.0));
  const exit = Number(argOf('exit', -1.0));
  const mask = buildMask(snr, enter, exit, 30);
  const e = equity(mask);
  console.log(`λ=${snr} enterZ=${enter} exitZ=${exit}`);
  console.log(`区间 ${dates[0]} → ${dates[dates.length - 1]}  ${e.days} 个${PERIOD === 'week' ? '周' : '交易日'} ≈ ${(e.days / BARS_PER_YEAR).toFixed(1)} 年`);
  console.log(`组合     年化 ${pct(e.ann)}  Sharpe ${e.sharpe.toFixed(2)}  最大回撤 ${pct(e.mdd)}  期末净值 ${e.nav.toFixed(3)}`);
  console.log(`等权基准 年化 ${pct(e.annB)}  Sharpe ${e.sharpeB.toFixed(2)}  期末净值 ${e.navB.toFixed(3)}`);
  console.log(`平均持仓占比 ${pct(e.hold)}`);
  console.log('\n分年：');
  console.log('年份    组合      基准      超额      平均持仓');
  for (const y of Object.keys(e.yearly)) {
    const o = e.yearly[y];
    console.log(`${y}  ${pct(o.p).padStart(8)}  ${pct(o.b).padStart(8)}  ${pct(o.p - o.b).padStart(8)}  ${pct(o.hold).padStart(8)}`);
  }
}
