#!/usr/bin/env node
/**
 * 起龙（龙道线）月线选股 —— 独立验算
 *
 * 目的：不复用选股器里的指标代码，用另一条取数链路（ths 月线）重算一遍，
 * 逐条件比对，确认「命中」不是算错出来的。
 *
 * 用法：node tools/longdao-verify.js sz001219:2026-10-30 sz002164:2026-09-30
 */
process.chdir(require('path').join(__dirname, '..'));
const Q = require('../lib/quote');

const EMA = (a, n) => {
  const k = 2 / (n + 1);
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(i === 0 ? a[i] : a[i] * k + out[i - 1] * (1 - k));
  return out;
};
const MA = (a, n) => a.map((_, i) => (i + 1 < n ? null : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n));

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('用法: node tools/longdao-verify.js <sym>:<YYYY-MM-DD> [...]');
    process.exit(1);
  }
  for (const a of args) {
    const [sym, date] = a.split(':');
    const r = await Q.klines(sym, 140, 'month');
    const rows = (r.rows || []).map((x) => ({ d: String(x[0]).slice(0, 10), o: x[1], c: x[2], h: x[3], l: x[4], v: x[5] }));
    const C = rows.map((x) => x.c), H = rows.map((x) => x.h), L = rows.map((x) => x.l);
    const ma5 = MA(C, 5), ma20 = MA(C, 20);
    const ld = EMA(C.map((c, i) => (2 * c + H[i] + L[i]) / 4), 13);
    const i = rows.findIndex((x) => x.d === date);
    if (i < 0) { console.log(`${sym} ${date} 不在数据里（源 ${r.source}）`); continue; }
    const prev = rows[i - 1];
    const c1 = C[i], h1 = H[i], l1 = L[i];
    const zt = c1 > prev.c * 1.095 && Math.abs(c1 - h1) < 1e-9;
    const cross = c1 > ld[i] && prev.c <= ld[i - 1];
    const trend = ma5[i] > ma20[i];
    console.log(`\n${sym} ${r.name || ''}  ${date}  源=${r.source}`);
    console.log(`  月K: O=${rows[i].o} C=${c1} H=${h1} L=${l1}  上月C=${prev.c}`);
    console.log(`  月涨幅 ${((c1 / prev.c - 1) * 100).toFixed(2)}%   收=高? ${Math.abs(c1 - h1) < 1e-9}`);
    console.log(`  MA5=${ma5[i] && ma5[i].toFixed(3)}  MA20=${ma20[i] && ma20[i].toFixed(3)}  龙道线=${ld[i].toFixed(3)} (上月 ${ld[i - 1].toFixed(3)})`);
    console.log(`  条件: 趋势(MA5>MA20)=${trend}  上穿龙道线=${cross}  月ZT=${zt}`);
    console.log(`  => ${trend && cross && zt ? '✓ 成立' : '✗ 不成立'}`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
