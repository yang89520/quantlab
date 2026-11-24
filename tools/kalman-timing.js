#!/usr/bin/env node
/* ============================================================
 * 卡尔曼 · 市场状态择时
 *
 * 个股信号已被证否（趋势跟随/偏离反转/超跌反抽全部负 alpha），
 * 但「全市场等权指数的 slopeZ」能识别极端状态：slopeZ < -2.5 的 21 个
 * 时点跨 5 年分布，后续 20 日 19 次为正、均值 +10%。
 *
 * 这里检验它作为「仓位旋钮」的实际效果：按状态调仓 vs 恒定满仓。
 * 仓位按日调整、每次变动收 0.1% 成本，避免用理想化的零成本结论。
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

const ix = {};
for (const k of keys) {
  const m = new Map();
  for (let i = 0; i < series[k].length; i++) m.set(String(series[k][i][0]), i);
  ix[k] = m;
}
const dates = [...new Set(keys.flatMap((k) => series[k].map((r) => String(r[0]))))].sort();

// 等权指数 + 每日市场收益
const mkt = [];
const navSeries = [];
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
  }
  const r = n ? s / n : 0;
  nav *= 1 + r;
  mkt.push(r);
  navSeries.push(nav);   // 必须逐日保存：用最终净值填满全序列会让卡尔曼看到常数，slopeZ 全为 0
}
const idxRows = navSeries.map((v, i) => [dates[i], v, v, v, v, 0, 0]);
const A = K.analyze(idxRows, { snr: 0.3 });

/* ---------- 仓位规则 ---------- */
const RULES = {
  '恒定满仓': () => 1,
  '反向（恐慌加/亢奋减）': (z) => (z < -2.5 ? 1.0 : z < -0.5 ? 0.6 : z < 0.5 ? 0.5 : z < 2.5 ? 0.7 : 0.3),
  '仅在恐慌时持有': (z) => (z < -2 ? 1 : 0),
  '趋势跟随（正斜率持有）': (z) => (z > 0.5 ? 1 : z > -0.5 ? 0.5 : 0),
  '温和反向': (z) => (z < -1.5 ? 0.9 : z < 0 ? 0.6 : z < 1.5 ? 0.5 : 0.3),
};

function run(rule, cost) {
  let w = 0, navP = 1;
  const navs = [], rets = [];
  for (let i = 1; i < dates.length; i++) {
    const z = A.slopeZ[i - 1];       // 前一日收盘定仓位
    const target = isFinite(z) ? rule(z) : 0;
    const turn = Math.abs(target - w);
    w = target;
    const r = mkt[i] * w - turn * cost;
    navP *= 1 + r;
    rets.push(r); navs.push(navP);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  let peak = 1, mdd = 0;
  for (const v of navs) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const years = rets.length / 244;
  const yearly = {};
  for (let i = 1; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    yearly[y] = (yearly[y] || 1) * (1 + rets[i - 1]);
  }
  return {
    ann: Math.pow(navP, 1 / years) - 1, nav: navP, mdd,
    sharpe: mean / sd * Math.sqrt(244),
    calmar: (Math.pow(navP, 1 / years) - 1) / Math.abs(mdd),
    yearly: Object.fromEntries(Object.entries(yearly).map(([y, v]) => [y, v - 1])),
  };
}

const COST = 0.001;
console.log(`等权指数 ${dates[0]} → ${dates[dates.length - 1]}  ${dates.length} 根  ${(dates.length / 244).toFixed(1)} 年\n`);
console.log('规则                      年化     期末净值  最大回撤  Sharpe  Calmar');
for (const name of Object.keys(RULES)) {
  const e = run(RULES[name], COST);
  console.log(
    name.padEnd(22),
    ((e.ann * 100).toFixed(1) + '%').padStart(8),
    e.nav.toFixed(3).padStart(9),
    ((e.mdd * 100).toFixed(1) + '%').padStart(9),
    e.sharpe.toFixed(2).padStart(7),
    e.calmar.toFixed(2).padStart(7)
  );
}

console.log('\n分年：');
const names = Object.keys(RULES);
const yrs = Object.keys(run(RULES['恒定满仓'], COST).yearly).sort();
console.log('规则'.padEnd(22) + yrs.map((y) => y.padStart(9)).join(''));
for (const name of names) {
  const e = run(RULES[name], COST);
  console.log(name.padEnd(22) + yrs.map((y) => ((e.yearly[y] * 100).toFixed(1) + '%').padStart(9)).join(''));
}

/* 阈值敏感性：只在「z < 阈值」时满仓，其余空仓 */
console.log('\n=== 阈值敏感性（z < 阈值 时满仓，其余空仓）===');
console.log('阈值     触发天数  年化     最大回撤  Sharpe');
for (const th of [-1.5, -2, -2.5, -3, -3.5]) {
  let w = 0, navP = 1, cnt = 0;
  const navs = [], rets = [];
  for (let i = 1; i < dates.length; i++) {
    const z = A.slopeZ[i - 1];
    const target = isFinite(z) && z < th ? 1 : 0;
    if (target) cnt++;
    const turn = Math.abs(target - w); w = target;
    const r = mkt[i] * w - turn * COST;
    navP *= 1 + r; rets.push(r); navs.push(navP);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  let peak = 1, mdd = 0;
  for (const v of navs) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const ann = Math.pow(navP, 1 / (rets.length / 244)) - 1;
  console.log(
    String(th).padEnd(8), String(cnt).padStart(6),
    ((ann * 100).toFixed(1) + '%').padStart(9),
    ((mdd * 100).toFixed(1) + '%').padStart(9),
    (mean / sd * Math.sqrt(244)).toFixed(2).padStart(7)
  );
}
