#!/usr/bin/env node
/**
 * 「起龙」月线选股（通达信公式原样执行）
 *
 * 公式来源：
 *   MA5:=MA(CLOSE,5);
 *   MA20:=MA(CLOSE,20);
 *   龙道线:=EMA((2*CLOSE+HIGH+LOW)/4,13);
 *   ZT:=CLOSE>REF(CLOSE,1)*1.095 AND C=H;
 *   起龙条件:=MA5>MA20 AND CROSS(C,龙道线) AND ZT;
 *   XG:起龙条件;
 *
 * 月线下三个条件的含义（与日线不同，务必看 docs/起龙-月线选股.md）：
 *   趋势   MA5>MA20        近 5 个月均价站上 20 个月均价
 *   突破   收盘上穿龙道线   13 个月 EMA((2C+H+L)/4)
 *   月ZT   月涨>9.5% 且 收=月最高
 *
 * 用法：
 *   node tools/longdao.js                      # 主板，最近 24 个月
 *   node tools/longdao.js --months 36          # 看更久
 *   node tools/longdao.js --incomplete         # 含未收的当月（观察名单）
 *   node tools/longdao.js --board all          # 全市场（含创业板/科创板）
 *   node tools/longdao.js --json out.json      # 只落盘不打印全表
 */
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');
const F = require('../lib/formula-screen');

const FORMULA = `MA5:=MA(CLOSE,5);
MA20:=MA(CLOSE,20);
龙道线:=EMA((2*CLOSE+HIGH+LOW)/4,13);
ZT:=CLOSE>REF(CLOSE,1)*1.095 AND C=H;
起龙条件:=MA5>MA20 AND CROSS(C,龙道线) AND ZT;
XG:起龙条件;`;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const board = arg('board', 'main');
  const months = Number(arg('months', 24));
  const asOf = arg('asof', null);
  const incomplete = arg('incomplete', false) === true;
  const jsonOut = arg('json', null);

  const t0 = Date.now();
  const r = await F.screen({
    formula: FORMULA, outputLine: 'XG', period: 'month',
    board: board === 'all' ? null : board,
    limit: 6000, months, asOf: asOf || undefined,
    includeIncomplete: incomplete,
    onProgress: (p, t, h, msg) => {
      if (process.stderr.isTTY) process.stderr.write(`\r  ${msg || ''} ${' '.repeat(12)}`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(60) + '\r');

  const d = r.byMonth;
  const monthKeys = Object.keys(d).sort().reverse();
  const recent = monthKeys.slice(0, 6);

  console.log(`\n起龙 · ${r.period === 'month' ? '月线' : r.period} · ${r.board === 'all' ? '全市场' : r.board === 'main' ? '主板' : r.board}`);
  console.log(`口径：${incomplete ? '含未收当月（观察）' : '仅已收月'}  asOf=${r.asOf}  数据末月=${r.dataLast.slice(0, 7)}`);
  console.log(`池 ${r.pool.total} 只 / 扫 ${r.pool.scanned} / 取数失败 ${r.failed} / 命中 ${r.hitCount} 次 / 耗时 ${(Date.now() - t0) / 1000}s`);
  console.log(`数据源：${JSON.stringify(r.sourceMix.dist)}${r.sourceMix.degraded ? '  ⚠ 跨源占比不足 95%' : ''}`);

  console.log('\n按月命中：');
  for (const m of monthKeys) {
    const bar = '▇'.repeat(Math.min(40, d[m]));
    console.log(`  ${m}  ${String(d[m]).padStart(3)}  ${bar}`);
  }

  // 最近两个月逐只列出
  for (const m of recent.slice(0, 2)) {
    const rows = r.hits.filter((h) => String(h.date).slice(0, 7) === m);
    if (!rows.length) continue;
    console.log(`\n${m} 命中 ${rows.length} 只：`);
    for (const h of rows) {
      console.log(`  ${h.sym}  ${String(h.name).padEnd(6, '　')}  ${h.date}  收 ${Number(h.close).toFixed(2)}`);
    }
  }

  const item = {
    formula: FORMULA, asOf: r.asOf, board: r.board, months, includeIncomplete: incomplete,
    pool: r.pool, scanned: r.scanned, failed: r.failed, hitCount: r.hitCount,
    latestMonth: r.latestMonth, latestCount: r.latestCount,
    dataLast: r.dataLast, byMonth: r.byMonth, hits: r.hits,
    sourceMix: r.sourceMix, elapsedMs: Date.now() - t0,
  };
  const outPath = jsonOut && typeof jsonOut === 'string'
    ? path.resolve(jsonOut)
    : path.join(__dirname, '..', 'data', 'backtest', `longdao-${r.asOf}${incomplete ? '-live' : ''}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(item, null, 1));
  console.log(`\n明细已落盘：${outPath}`);
})().catch((e) => {
  console.error('ERR', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 300) : '');
  process.exit(1);
});
