'use strict';
/**
 * 板块强度人读报告 / 采集入口（docs/dev/04 T8）。
 *
 *   node tools/sector-report.js                    读今日库内榜单
 *   node tools/sector-report.js --date 2026-11-13 读指定日
 *   node tools/sector-report.js --capture         重新采集后出报告
 *   node tools/sector-report.js --type concept   只看概念榜
 *   node tools/sector-report.js --history 20     看轮动历史
 */
const config = require('../lib/config');
const sd = require('../lib/sectordata');
const ds = require('../lib/datasource');
const log = require('../lib/log');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (n) => process.argv.includes('--' + n);

const GRADE_CN = { A: '主攻', B: '蓄势', C: '修复', D: '退潮' };

function printBoard(rows, type) {
  const list = rows.filter((r) => !type || r.type === type);
  console.log(`\n【${type === 'concept' ? '概念榜' : '行业榜'}】共 ${list.length} 个板块`);
  console.log('  排名  板块           档位    得分   动量   资金   宽度   持续   标记');
  let n = 0;
  for (const r of list.slice(0, 15)) {
    n++;
    const p = r.parts || {};
    const f = (v) => v == null ? '  —  ' : String(Math.round(v)).padStart(5);
    console.log(`  ${String(n).padStart(3)}   ${String(r.name || r.sector).slice(0, 10).padEnd(12)}`
      + `  ${GRADE_CN[r.grade] || '—'}   ${f(r.score)}${f(p.momentum)}${f(p.funds)}`
      + `${f(p.breadth)}${f(p.continuity)}  ${r.degraded ? '降级:' + r.degradeReason : ''}`);
  }
  const grades = ['A', 'B', 'C', 'D'].map((g) => `${g}=${list.filter((r) => r.grade === g).length}`).join(' ');
  console.log(`  分档统计 ${grades}｜降级 ${list.filter((r) => r.degraded).length} 个`);
}

async function main() {
  const t0 = Date.now();
  log.info('sector-report.start', { argv: process.argv.slice(2) });
  let date = typeof arg('date') === 'string' ? arg('date') : null;
  if (!date) {
    const t = await ds.latestTradingDay();
    date = t.date;
  }

  if (has('capture')) {
    const r = await sd.capture({ date });
    console.log(`采集完成：${date}｜评分 ${r.rows.length} 个板块｜不足 ${r.insufficient.length} 个`);
    console.log('留痕 ' + JSON.stringify(r.provenance));
  }

  if (has('history')) {
    const rows = await sd.readHistory(Number(arg('history', 20)) || 20);
    const byDate = new Map();
    for (const r of rows) {
      const d = String(r.date);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }
    console.log(`\n【轮动历史】${byDate.size} 个交易日`);
    for (const [d, list] of Array.from(byDate.entries()).sort().slice(-20)) {
      const top = list.filter((r) => r.grade === 'A').slice(0, 3).map((r) => r.name).join('、');
      console.log(`  ${d}  A档 ${list.filter((r) => r.grade === 'A').length} 个｜${top || '无'}`);
    }
    log.info('sector-report.done', { ms: Date.now() - t0 });
    return;
  }

  const rows = await sd.readStrength(date, null, { readOnly: true });
  if (!rows.length) {
    console.log(`${date} 还没有板块强度数据，请先执行：node tools/sector-report.js --capture`);
    log.warn('sector-report.empty', { date });
    return;
  }
  console.log(`板块强度 ${date}｜共 ${rows.length} 个板块`);
  const type = typeof arg('type') === 'string' ? arg('type') : null;
  if (!type || type === 'industry') printBoard(rows, 'industry');
  if (!type || type === 'concept') printBoard(rows, 'concept');
  console.log('\n注：历史强度基于当前成分回算，长周期仅供参考（幸存者偏差）');
  log.info('sector-report.done', { date, count: rows.length, ms: Date.now() - t0 });
}

main().catch((e) => {
  log.error('sector-report.failed', { error: e.message, stack: e.stack });
  console.error('失败：' + e.message);
  process.exitCode = 1;
});
