'use strict';
/**
 * 收盘后编排入口（一期）
 *
 * 顺序不可调换（docs/dev/03 §4）：
 *   1 交易日 → 2 指数K线 → 3 快照 → 4 对账(昨日) → 5 预判(今日) → 6 摘要
 * 第 4 步必须在第 5 步之前：先生成新预判会覆盖上下文，且对账要用昨日预判与今日实际。
 *
 * 用法：
 *   node tools/daily-close.js
 *   node tools/daily-close.js --date 2026-11-13
 *   node tools/daily-close.js --skip-fetch     # 用已有快照重跑
 *   node tools/daily-close.js --force          # 强制重算对账
 */
const store = require('../lib/dao');
const ds = require('../lib/datasource');
const config = require('../lib/config');
const log = require('../lib/log');
const snapLib = require('../lib/snapshot');
const predict = require('../lib/predict');
const { reconcile } = require('../lib/reconcile');
const watchStore = require('../lib/store');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes('--' + name);

async function collectCandidates() {
  // 一期候选来自用户自选股——真实且有意义的关注池，不是拍脑袋筛出来的
  const items = watchStore.listItems();
  const out = [];
  for (const it of items.slice(0, config.predict.candidateCount)) {
    out.push({ code: it.code, name: it.name, dir: 'up', reason: '自选关注' });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  log.info('daily-close.start', { argv: process.argv.slice(2) });

  const st = await store.open();
  log.info('daily-close.store', { engine: st.engine });

  // ---- 1. 交易日 ----
  const overrideDate = typeof arg('date') === 'string' ? arg('date') : null;
  const tday = overrideDate
    ? { date: overrideDate, source: 'arg', level: 'C' }
    : await ds.latestTradingDay();
  const date = tday.date;
  log.info('daily-close.date', { date, source: tday.source });

  // ---- 2. 指数 K 线（本地优先，只补当日） ----
  const idx = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 260 });
  if (!idx.rows || idx.rows.length < config.integrity.minBars) {
    throw new Error(`指数 K 线不足 ${config.integrity.minBars} 根（实际 ${idx.rows ? idx.rows.length : 0}），无法计算 MA60`);
  }
  log.info('daily-close.bars', { bars: idx.rows.length, source: idx.source, asOf: idx.asOf });

  // ---- 3. 快照 ----
  let snapRec = null;
  if (!has('skip-fetch')) {
    snapRec = await snapLib.capture(date);
  } else {
    const s = await snapLib.readSummary(date);
    snapRec = { date, complete: !!s, count: s ? s.count : 0, source: 'skip-fetch' };
    log.info('daily-close.snapshot_skipped', snapRec);
  }

  const summary = await snapLib.readSummary(date);
  if (!summary) {
    throw new Error(`快照为空（date=${date}），无法生成预判。请先不带 --skip-fetch 跑一次。`);
  }
  log.info('daily-close.snapshot', {
    date, count: summary.count, breadth: summary.breadth, zt: summary.ztCount,
  });

  // ---- 4. 对账（先于预判） ----
  // 找出所有「目标日 <= 今天 且 尚未对账」的预判，逐条对账
  const recentPreds = await st.query('prediction', { order: 'date', desc: true, limit: 10 });
  let reconciled = 0;
  let pendingCount = 0;

  for (const p of recentPreds) {
    if (p.date >= date) continue;                       // 今天及以后的预判还没到期
    const payload = p.payload || {};
    const target = payload.targetDate || p.target_date;
    if (!target || target > date) continue;             // 目标日还没到

    const done = await st.query('reconcile', { where: { date: p.date } });
    if (done.length && !has('force')) continue;         // 已对账（幂等）

    pendingCount++;
    const prevMap = await snapLib.readMap(p.date);
    const bars = idx.rows.filter((r) => String(r[0]).slice(0, 10) <= target);
    const result = reconcile(payload, prevMap, summary, bars);

    await st.upsert('reconcile', [{
      date: p.date,
      env_hit: result.envResult ? result.envResult.hit : null,
      cand_hit_ratio: result.candHitRatio,
      attribution: result.attribution,
      judgment_score: result.judgmentScore,
      skipped: result.skipped,
      payload: result,
    }]);

    payload.reconcile = result;
    await st.upsert('prediction', [{
      date: p.date,
      target_date: target,
      verdict: p.verdict,
      score: p.score,
      data_complete: p.data_complete,
      created_at: p.created_at,
      payload,
    }]);

    reconciled++;
    log.info('daily-close.reconciled', {
      date: p.date, target,
      attribution: result.attribution,
      envHit: result.envResult ? result.envResult.hit : null,
      score: result.judgmentScore,
      skipped: result.skipped,
      skipReason: result.skipReason || null,
    });
  }
  if (!pendingCount) log.info('daily-close.reconcile_none', { note: '没有到期的待对账预判（首次运行属正常）' });

  // ---- 5. 生成今日预判 ----
  const existing = await st.query('prediction', { where: { date } });
  const payload = predict.build({
    date,
    targetDate: predict.nextTradingDay(date),
    bars: idx.rows,
    snap: summary,
    candidates: await collectCandidates(),
    integrity: {
      snapshotCount: summary.count,
      bars: idx.rows.length,
      lastBarDate: idx.asOf,
      stale: !!idx.stale,
      warnings: [],
    },
  });

  await st.upsert('prediction', [{
    date: payload.date,
    target_date: payload.targetDate,
    verdict: payload.env.verdict,
    score: payload.env.score,
    data_complete: payload.dataComplete,
    created_at: payload.createdAt,
    payload,
  }]);

  log.info('daily-close.predicted', {
    date,
    verdict: payload.env.verdict,
    score: payload.env.score,
    parts: payload.env.parts,
    candidates: payload.candidates.length,
    overwritten: existing.length > 0,
  });

  // ---- 6. 摘要 ----
  console.log('');
  console.log(`日期 ${date} → 目标 ${payload.targetDate}｜${payload.env.verdict} ${payload.env.score} 分`
    + `（趋势 ${payload.env.parts.trend} + 宽度 ${payload.env.parts.breadth} + 量能 ${payload.env.parts.vol}）`);
  console.log(`快照 ${summary.count} 只｜宽度 ${(summary.breadth * 100).toFixed(1)}%｜涨停 ${summary.ztCount}｜候选 ${payload.candidates.length} 只`);
  console.log(`对账 ${reconciled ? '已完成 1 条' : '无待办'}｜总耗时 ${Date.now() - t0}ms`);
}

main().catch((e) => {
  log.error('daily-close.failed', { error: e.message, stack: e.stack });
  process.exitCode = 1;   // 不许打印错误后正常退出（G3）
});
