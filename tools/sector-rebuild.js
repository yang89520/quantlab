'use strict';
/**
 * 板块强度批量重算（不重跑快照/预判）。
 *
 * 用途：把历史某段日期的 `sector_strength` 用当前代码重算一遍。
 * 与 `daily-close --backfill` 的区别是它**只动板块**，不碰快照、预判、对账——
 * 回补板块不需要历史快照，用板块指数 K 线（until=date）+ 库里成分就能算。
 *
 * 一个必须知道的边界：
 *   资金流（net_inflow）**没有历史数据**。新浪接口只返回「此刻」的值，
 *   字典文件里存的也是最近一次采集。所以历史日重算后 netInflow 仍是 null，
 *   分档依据是「成交额 + 量能」的降级口径 —— 这就是 2026-11-24 之前的原始口径，
 *   重算不会改变它，也不该改变它（拿今天的资金流写进过去就是前视偏差，D3）。
 *
 *   也就是说：**这项工具统一的是 K 线来源与评分逻辑，统一不了资金分项**。
 *   资金分项只能从接入那天（11-24）起自然累积。
 *
 * 用法：
 *   node tools/sector-rebuild.js --days 25          # 最近 25 个交易日
 *   node tools/sector-rebuild.js --from 2026-10-19 --to 2026-11-20
 *   node tools/sector-rebuild.js --days 25 --dry    # 只列日期不执行
 */
const config = require('../lib/config');
const log = require('../lib/log');
const store = require('../lib/dao');
const sectordata = require('../lib/sectordata');
const ds = require('../lib/datasource');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (n) => process.argv.includes('--' + n);

(async () => {
  const t0 = Date.now();
  const dry = has('dry');

  // 日期来源：库里有预判卡的那些天（说明确实是交易日且系统跑过）
  const st = await store.open({ readOnly: true });
  const preds = await st.query('prediction', { limit: 100000 });
  let dates = Array.from(new Set(preds.map((p) => String(p.date).slice(0, 10)))).sort();

  const from = arg('from');
  if (from) dates = dates.filter((d) => d >= String(from));
  const to = arg('to');
  if (to) dates = dates.filter((d) => d <= String(to));
  const days = Number(arg('days')) || 0;
  if (days > 0) dates = dates.slice(-days);

  if (!dates.length) {
    console.error('没有可重算的日期（库里没有预判卡？先跑 daily-close）');
    process.exitCode = 1;
    return;
  }

  let latest = null;
  try {
    const td = await ds.latestTradingDay();
    latest = String((td && td.date) || '').slice(0, 10);
  } catch (e) { /* 拿不到就按全部历史处理，capture 内部还会再判一次 */ }

  console.log(`待重算 ${dates.length} 天：${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`最近已收盘交易日：${latest || '未知'}（该日会保留资金流，其余日剥掉）`);
  if (dry) { console.log(dates.join(' ')); return; }

  let ok = 0, failed = 0;
  const rows = [];
  for (const d of dates) {
    const t = Date.now();
    try {
      const r = await sectordata.capture({ date: d, membersFrom: 'store' });
      const g = r.rows.reduce((a, x) => { a[x.grade] = (a[x.grade] || 0) + 1; return a; }, {});
      const inflow = r.provenance.netInflow || {};
      rows.push({ d, n: r.rows.length, a: g.A || 0, b: g.B || 0, c: g.C || 0, dd: g.D || 0,
        inflow: inflow.source || '—', sec: ((Date.now() - t) / 1000).toFixed(0) });
      ok++;
      console.log(`  ✓ ${d}  板块 ${r.rows.length}  A${g.A || 0} B${g.B || 0} C${g.C || 0} D${g.D || 0}  资金=${inflow.source || '—'}  ${((Date.now() - t) / 1000).toFixed(0)}s`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${d}  ${e.message}`);
      log.warn('sector-rebuild.failed', { date: d, error: e.message });
    }
  }

  console.log(`\n重算完成：成功 ${ok} 天、失败 ${failed} 天｜总耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
  if (ok) {
    const avgA = (rows.reduce((s, r) => s + r.a, 0) / ok).toFixed(1);
    console.log(`A 档均值 ${avgA} 个/天（历史无资金流的口径）`);
    const withInflow = rows.filter((r) => r.inflow !== '—').length;
    console.log(`带资金流的天数 ${withInflow}/${ok}（只有最近交易日会有）`);
  }
  log.info('sector-rebuild.done', { ok, failed, ms: Date.now() - t0 });
})().catch((e) => {
  console.error('重算失败：' + e.message);
  log.error('sector-rebuild.fatal', { error: e.message });
  process.exitCode = 1;
});
