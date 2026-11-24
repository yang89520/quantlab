#!/usr/bin/env node
/**
 * 「起龙」月线信号的后验表现
 *
 * 只回答一个问题：这个信号出现后，往后 1/3/6 个月到底赚不赚、比同期主板均值好多少。
 *
 * 口径（必须写清，否则数字没法比）：
 *   - 入场：信号月「次月开盘价」买入（信号月末才知道，不能当月收盘就买）
 *   - 出场：信号月 + N 个月的收盘价
 *   - 成本：单边 0.05%（佣金+过户费）、双边 0.1%，另加卖出印花税 0.05% → 合计 0.15%
 *   - 基准：同一份月线池里，所有股票所有月份的 N 月收益（等权），不是指数
 *   - 剔除：样本不足 N+2 根的票不计
 *
 * 用法：node tools/longdao-stats.js [--months 24]
 */
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');

const COST = 0.0015;
const pct = (x) => (x * 100).toFixed(2) + '%';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function stat(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return {
    n: a.length, mean,
    med: s[Math.floor(s.length / 2)],
    win: a.filter((x) => x > 0).length / a.length,
    t: sd > 0 ? mean / sd * Math.sqrt(a.length) : 0,
  };
}

(async () => {
  const asOf = arg('asof', '2026-11-24');
  const months = Number(arg('months', 24));
  const cacheFile = path.join(__dirname, '..', 'data', 'cache', `month-${asOf}.json`);
  if (!fs.existsSync(cacheFile)) {
    console.error(`找不到月线缓存 ${cacheFile}，先跑一次 tools/longdao.js 取数`);
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const hitFile = path.join(__dirname, '..', 'data', 'backtest', `longdao-${asOf}.json`);
  if (!fs.existsSync(hitFile)) {
    console.error(`找不到命中明细 ${hitFile}，先跑 tools/longdao.js`);
    process.exit(1);
  }
  const hits = JSON.parse(fs.readFileSync(hitFile, 'utf8')).hits || [];

  // 每只票的月线：date/o/c/h/l/v —— 只保留主板，避免基准混入 20cm 板块
  const series = {};
  for (const [sym, v] of Object.entries(cache.data || {})) {
    if (!(/^sh6(?!8[89])/.test(sym) || /^sz00/.test(sym))) continue;
    if (!v || !Array.isArray(v.rows) || v.rows.length < 8) continue;
    series[sym] = v.rows.map((r) => ({ d: String(r[0]).slice(0, 10), o: +r[1], c: +r[2], h: +r[3], l: +r[4] }));
  }

  console.log(`样本：主板 ${Object.keys(series).length} 只，命中 ${hits.length} 次，asOf=${asOf}\n`);

  const rows = [];
  for (const h of hits) {
    const s = series[h.sym];
    if (!s) continue;
    const i = s.findIndex((x) => x.d === h.date);
    if (i < 0) continue;
    const row = { sym: h.sym, name: h.name, d: h.date };
    let ok = true;
    for (const N of [1, 3, 6]) {
      const j = i + N;
      if (j >= s.length) { row[`r${N}`] = null; continue; }
      // 次月开盘入场；次月不存在（如信号在最后一根）则跳过
      const entry = s[i + 0 + 1] ? s[i + 1].o : null;
      if (!entry) { row[`r${N}`] = null; ok = false; continue; }
      row[`r${N}`] = s[j].c / entry - 1 - COST;
    }
    if (ok) rows.push(row);
  }

  // 基准：同池、所有月份、同样持有期
  const base = { 1: [], 3: [], 6: [] };
  const baseByYear = {};
  for (const s of Object.values(series)) {
    for (let i = 1; i + 6 < s.length; i++) {
      const entry = s[i].o;
      if (!(entry > 0)) continue;
      const y = s[i].d.slice(0, 4);
      baseByYear[y] = baseByYear[y] || { 1: [], 3: [], 6: [] };
      for (const N of [1, 3, 6]) {
        const j = i + N - 1;
        if (j < s.length) { base[N].push(s[j].c / entry - 1); baseByYear[y][N].push(s[j].c / entry - 1); }
      }
    }
  }

  console.log('持有期   信号数   胜率     均值       中位       t     基准均值   超额');
  console.log('─'.repeat(76));
  for (const N of [1, 3, 6]) {
    const a = rows.map((r) => r[`r${N}`]).filter((x) => x != null);
    const st = stat(a); const bs = stat(base[N]);
    if (!st) { console.log(`${N} 个月   样本不足`); continue; }
    console.log(
      `${String(N).padEnd(7)} ${String(st.n).padEnd(7)} ${pct(st.win).padEnd(8)} ` +
      `${pct(st.mean).padEnd(10)} ${pct(st.med).padEnd(9)} ${st.t.toFixed(1).padEnd(6)} ` +
      `${pct(bs.mean).padEnd(10)} ${pct(st.mean - bs.mean)}`
    );
  }

  // 分年看稳定性：某一年全靠一次行情撑起来的话，这里会露出来
  console.log('\n按信号年份拆（6 个月持有，基准取同年同持有期）：');
  const byYear = {};
  for (const r of rows) {
    if (r.r6 == null) continue;
    const y = r.d.slice(0, 4);
    (byYear[y] = byYear[y] || []).push(r.r6);
  }
  for (const y of Object.keys(byYear).sort()) {
    const st = stat(byYear[y]);
    const b = stat((baseByYear[y] || {})[6] || []);
    const ex = b ? st.mean - b.mean : null;
    console.log(`  ${y}  ${String(st.n).padStart(3)} 笔  均值 ${pct(st.mean).padStart(8)}  胜率 ${pct(st.win).padStart(7)}  ` +
      `中位 ${pct(st.med).padStart(8)}  基准 ${b ? pct(b.mean).padStart(8) : '   n/a '}  超额 ${ex == null ? 'n/a' : pct(ex)}`);
  }

  // 信号月份扎堆程度：同一个月出十几只，等价于一笔交易，不能当十几个样本
  console.log('\n信号月份扎堆（前 5）：');
  const byMonth = {};
  for (const r of rows) byMonth[r.d.slice(0, 7)] = (byMonth[r.d.slice(0, 7)] || 0) + 1;
  for (const [m, n] of Object.entries(byMonth).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${m}  ${n} 只`);
  }

  // 尾部：最差 5 笔 —— 月线信号踩错一次要多久才回来
  const worst = rows.filter((r) => r.r6 != null).sort((a, b) => a.r6 - b.r6).slice(0, 5);
  console.log('\n最差 5 笔（6 个月）：');
  for (const r of worst) console.log(`  ${r.d}  ${r.sym} ${r.name}  ${pct(r.r6)}`);

  console.log('\n注：月线信号在「次月开盘」才可执行；同一只票连续多月命中只按首次计（见 hits 去重前的原始明细）。');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
