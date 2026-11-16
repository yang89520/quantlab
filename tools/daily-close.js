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
 *   node tools/daily-close.js --date 2026-11-13 --from-local   # 回补单个历史日（本地合成快照）
 *   node tools/daily-close.js --backfill 20                    # 回补最近 20 个交易日（同进程循环）
 *   node tools/daily-close.js --date 2026-11-13 --skip-fetch   # 用已有快照重跑
 *   node tools/daily-close.js --force                          # 强制重算对账
 *
 * --backfill 为什么要在**同一个进程**里循环：板块成分股要打 221 次新浪接口，
 * 20 天各起一个进程就是 4420 次请求，慢且容易被限流。同进程内 sectordata 会
 * 复用第一次抓到的「字典 + 成分股」，整轮只打 221 次。
 */
const store = require('../lib/dao');
const ds = require('../lib/datasource');
const config = require('../lib/config');
const log = require('../lib/log');
const snapLib = require('../lib/snapshot');
const predict = require('../lib/predict');
const { reconcile } = require('../lib/reconcile');
const watchStore = require('../lib/store');
const sectordata = require('../lib/sectordata');
const watchpool = require('../lib/watchpool');
const localdb = require('../lib/sources/adapters/local-db');
const track = require('../lib/track');
const strategies = require('../lib/strategy');
const gatesLib = require('../lib/gates');
const lab = require('../lib/lab');

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

/**
 * 处理单个交易日（步骤 2–10）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{fromLocal?:boolean, skipFetch?:boolean, skipSector?:boolean,
 *          force?:boolean, reuse?:boolean}} opt
 * @returns {Promise<object>} 该日的摘要数字，供多日汇总打印
 */
async function runOne(date, opt) {
  const o = opt || {};
  const fromLocal = !!o.fromLocal;
  const skipFetch = !!o.skipFetch;
  const skipSector = !!o.skipSector;
  const force = !!o.force;
  const t0 = Date.now();

  const st = await store.open();

  // ---- 2. 指数 K 线（本地优先，只补当日） ----
  // 必须带 date：回补历史日时若不带，本地库会一路返回到最新一根，
  // 预判就会用上「未来」的指数走势（前视偏差），算出来的判断看着漂亮但不成立。
  const idx = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 260, date });
  if (!idx.rows || idx.rows.length < config.integrity.minBars) {
    throw new Error(`[${date}] 指数 K 线不足 ${config.integrity.minBars} 根（实际 ${idx.rows ? idx.rows.length : 0}），无法计算 MA60`);
  }
  log.info('daily-close.bars', { date, bars: idx.rows.length, source: idx.source, asOf: idx.asOf });

  // ---- 3. 快照 ----
  let snapRec = null;
  if (fromLocal) {
    // 回补：从上游日线合成当日快照（不触网）。turnover/float_cap 上游没有，落 null。
    snapRec = await snapLib.captureFromLocal(date);
  } else if (!skipFetch) {
    snapRec = await snapLib.capture(date);
  } else {
    const s = await snapLib.readSummary(date);
    snapRec = { date, complete: !!s, count: s ? s.count : 0, source: 'skip-fetch' };
    log.info('daily-close.snapshot_skipped', snapRec);
  }

  const summary = await snapLib.readSummary(date);
  if (!summary) {
    throw new Error(`[${date}] 快照为空，无法生成预判。请先不带 --skip-fetch 跑一次。`);
  }
  log.info('daily-close.snapshot', {
    date, count: summary.count, breadth: summary.breadth, zt: summary.ztCount,
  });

  // ---- 4. 板块强度（二期，必须早于对账与预判） ----
  // 对账的 direction 要用「目标日板块榜」判断昨日 A 档是否仍在前 30%，
  // 预判的 mainline 也要用同一批榜单；所以这一步排在对账之前。
  // 04 §6 把板块排在对账之后，会导致 direction 拿不到当日榜单，此处按数据依赖修正。
  let strengthRows = [];
  if (skipSector) {
    strengthRows = await sectordata.readStrength(date, null, { readOnly: true });
    log.info('daily-close.sector_skipped', { date, rows: strengthRows.length });
  } else {
    try {
      // reuse：多日回补共用一份「板块字典 + 成分股」，整轮只打一次新浪接口。
      // membersFrom='store'：连那一次都不打 —— 字典读盘、成分读库。
      // 回补 20 天要 221 次成分股请求，实测连续跑会被新浪限流（timeout），
      // 而成分本来就是「当前成分」（幸存者偏差见 10 §3.4），读库与联网同一口径。
      const sr = await sectordata.capture({
        date,
        reuse: !!o.reuse,
        membersFrom: o.membersFrom || 'network',
      });
      strengthRows = sr.rows;
      log.info('daily-close.sector', {
        date, rows: strengthRows.length, insufficient: sr.insufficient.length,
        provenance: sr.provenance,
      });
    } catch (e) {
      // 板块是增强维度，失败不阻断一期闭环；明确降级，不编造榜单
      log.warn('daily-close.sector_failed', { date, error: e.message });
      strengthRows = [];
    }
  }

  // ---- 5. 对账（先于预判） ----
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
    if (done.length && !force) continue;                // 已对账（幂等）

    pendingCount++;
    const prevMap = await snapLib.readMap(p.date);
    const bars = idx.rows.filter((r) => String(r[0]).slice(0, 10) <= target);
    const result = reconcile(payload, prevMap, summary, bars, config, { sectorsToday: strengthRows });

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
  if (!pendingCount) log.info('daily-close.reconcile_none', { date, note: '没有到期的待对账预判（首次运行属正常）' });

  // ---- 6. 生成今日预判 ----
  const existing = await st.query('prediction', { where: { date } });

  // D4（docs/dev/09 §4/§6）：取数元信息必须一路传到 UI，不许在编排层丢掉。
  // 指数 K 线与全市场快照是两次独立取数，各自保留 source/level/asOf/stale/degraded，
  // 不合并成一个"看起来干净"的值——合并会掩盖其中一路已经降级。
  const provenance = {
    index: {
      source: idx.source || null,
      level: idx.level || null,
      asOf: idx.asOf || null,
      stale: !!idx.stale,
      degraded: !!idx.degraded,
      degradeReason: idx.missing && idx.missing.length ? idx.missing.join(',') : null,
    },
    snapshot: {
      source: (snapRec && snapRec.source) || null,
      level: (snapRec && snapRec.level) || null,
      asOf: (snapRec && snapRec.asOf) || date,   // --skip-fetch 时用已有快照的交易日
      stale: !!(snapRec && snapRec.stale),
      degraded: !!(snapRec && snapRec.complete === false),
      count: summary.count,
      // derived=true：这份快照是从上游日线合成的（回补），不是当场抓的实时源。
      // 必须显式标出来，否则后人分不清「当时抓的」和「事后算的」（09 §D4）。
      derived: !!(snapRec && snapRec.synthesized),
      nullFields: (snapRec && snapRec.nullFields) || [],
    },
    fetchedAt: new Date().toISOString(),
  };
  log.info('daily-close.provenance', { date, provenance });

  const payload = predict.build({
    date,
    targetDate: predict.nextTradingDay(date),
    bars: idx.rows,
    snap: summary,
    candidates: await collectCandidates(),
    strengthRows,
    integrity: {
      snapshotCount: summary.count,
      bars: idx.rows.length,
      lastBarDate: idx.asOf,
      stale: !!idx.stale,
      provenance,
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

  // ---- 7. 观察池状态机推进（二期） ----
  // 每只标的用自己的 K 线；上游库不可读时不判定、不共用假数据。
  const activePool = watchpool.list().filter((e) => e.state !== 'removed');
  let poolResult = { total: 0, active: 0, moved: 0 };
  if (activePool.length) {
    let klines = {};
    try {
      klines = await localdb.readMemberKlines(activePool.map((e) => e.code), 30, date);
    } catch (e) {
      log.warn('daily-close.pool_klines_failed', { error: e.message });
    }
    const gradeOf = (sector) => {
      const r = strengthRows.find((x) => x.sector === sector);
      return r ? r.grade : null;
    };
    poolResult = await watchpool.advanceAll({
      date,
      sessionDates: idx.rows.map((r) => String(r[0]).slice(0, 10)),
      barsOf: (code) => klines[String(code)] || [],
      sectorGradeOf: gradeOf,
      stockScore: null,   // 综合评分由前端 composite 计算后随入池提交，后端不另造一套
    });
    log.info('daily-close.watchpool', poolResult);
  }
  const pruned = await watchpool.prune(date);
  if (pruned.removed) log.info('daily-close.watchpool_pruned', pruned);

  // ---- 8. 策略信号扫描（三期 S11，05 §7.1） ----
  // 只扫 active/suspect 策略；suspect 仍继续记录，为了继续观察实盘是否恢复（05 §7.3）。
  const signalRuns = [];
  const runnable = strategies.list().filter((x) => x.status === 'active' || x.status === 'suspect');
  for (const s of runnable) {
    try {
      const r = await lab.scanSignals(s, { date });
      await track.record(date, s.id, s.version, r.signals, r.scanned);
      signalRuns.push({
        id: s.id, scanned: r.scanned, candidates: r.candidates,
        hits: r.hitCount, skipped: r.skipped.length, missing: r.missing.length,
      });
    } catch (e) {
      // 单个策略失败不影响其它策略与整体流程，但必须留痕（不许静默）
      log.warn('daily-close.signal_scan_failed', { id: s.id, error: e.message });
      signalRuns.push({ id: s.id, error: e.message });
    }
  }
  if (signalRuns.length) log.info('daily-close.signals', { date, runs: signalRuns });

  // ---- 8b. 持仓风险留痕（⑤ 风险格的「昨日 → 今日」对比依赖它） ----
  let riskResult = null;
  try {
    riskResult = await watchpool.riskScan({ date });
    await watchpool.saveRiskSnapshot(date, riskResult);
    log.info('daily-close.risk_snapshot', { date, holding: riskResult.holding, risky: riskResult.risky });
  } catch (e) {
    log.warn('daily-close.risk_snapshot_failed', { error: e.message });
  }

  // ---- 9. 信号跟踪回填（幂等补漏）+ 策略自动降级 ----
  const sess = idx.rows.map((r) => String(r[0]).slice(0, 10));
  const bf = await track.backfill(date, sess);
  let degraded = 0;
  for (const s of strategies.list().filter((x) => x.status === 'active')) {
    const w = await track.winRate(s.id, { readOnly: true });
    const bt = s.params && s.params.backtestWinRate;
    if (w.sample >= config.gates.checkEveryDays && w.liveWinRate != null && bt != null
        && gatesLib.shouldDegrade(w.liveWinRate, bt)) {
      await strategies.setStatus(s.id, 'suspect');
      degraded++;
      log.warn('daily-close.strategy_degraded', {
        id: s.id, live: w.liveWinRate, backtest: bt, gap: config.gates.degradeGap,
      });
    }
  }
  log.info('daily-close.track', { date, filled: bf.filled, noData: bf.noData, degraded });

  // ---- 10. 摘要 ----
  return {
    date,
    targetDate: payload.targetDate,
    verdict: payload.env.verdict,
    score: payload.env.score,
    parts: payload.env.parts,
    snapCount: summary.count,
    breadth: summary.breadth,
    zt: summary.ztCount,
    candCount: payload.candidates.length,
    sectors: strengthRows.length,
    sectorA: strengthRows.filter((r) => r.grade === 'A').length,
    mainline: payload.mainline ? payload.mainline.sectors.length : 0,
    poolActive: poolResult.active,
    poolMoved: poolResult.moved,
    signals: signalRuns,
    risk: riskResult,
    reconciled,
    bfFilled: bf.filled,
    degraded,
  };
}

/** 多日回补时取最近 n 个交易日（升序） */
async function recentTradingDays(n) {
  const days = await localdb.sessionDates(n);
  return days.slice(-n);
}

async function main() {
  const t0 = Date.now();
  log.info('daily-close.start', { argv: process.argv.slice(2) });

  const overrideDate = typeof arg('date') === 'string' ? arg('date') : null;
  const backfillN = arg('backfill') === true ? null : Number(arg('backfill'));

  let dates;
  let fromLocal = has('from-local');

  if (backfillN) {
    if (!Number.isFinite(backfillN) || backfillN < 1) {
      throw new Error('--backfill 需要一个正整数，例如 --backfill 20');
    }
    dates = await recentTradingDays(Math.min(250, Math.floor(backfillN)));
    // 回补一律走本地合成：历史日抓不到当时的实时快照，混用两种来源会让
    // 命中率序列的口径不一致（同一指标只允许一套口径，G4）。
    fromLocal = true;
    log.info('daily-close.backfill', { days: dates.length, from: dates[0], to: dates[dates.length - 1] });
  } else if (overrideDate) {
    dates = [overrideDate];
  } else {
    const tday = await ds.latestTradingDay();
    dates = [tday.date];
    log.info('daily-close.date', { date: tday.date, source: tday.source });
  }

  // 回补模式必须显式给日期：不给就会拿「今天」去合成，而今天上游库通常还没有日线，
  // 报错会很难懂。这里提前拦住，把用法说清楚。
  if (fromLocal && !overrideDate && !backfillN) {
    throw new Error('--from-local 必须配合 --date YYYY-MM-DD 或 --backfill N');
  }

  const st = await store.open();
  log.info('daily-close.store', { engine: st.engine });

  const opt = {
    fromLocal,
    skipFetch: has('skip-fetch'),
    skipSector: has('skip-sector'),
    force: has('force'),
    reuse: dates.length > 1,
    // 回补默认离线取成分：避免 221×N 次请求把新浪打到限流（实测会 timeout）。
    // 想强制走网络加 --online-members。
    membersFrom: (dates.length > 1 && !has('online-members')) ? 'store' : 'network',
  };

  const results = [];
  for (const d of dates) {
    // 逐日跑；某天失败不应让整轮回补中断——但要明确记下来，不许静默跳过（G3）
    try {
      results.push(await runOne(d, opt));
    } catch (e) {
      log.error('daily-close.day_failed', { date: d, error: e.message, stack: e.stack });
      results.push({ date: d, error: e.message });
    }
  }

  // ---- 汇总 ----
  const ok = results.filter((r) => !r.error);
  const bad = results.filter((r) => r.error);
  console.log('');
  if (results.length === 1 && ok.length === 1) {
    const r = ok[0];
    console.log(`日期 ${r.date} → 目标 ${r.targetDate}｜${r.verdict} ${r.score} 分`
      + `（趋势 ${r.parts.trend} + 宽度 ${r.parts.breadth} + 量能 ${r.parts.vol}）`);
    console.log(`快照 ${r.snapCount} 只｜宽度 ${(r.breadth * 100).toFixed(1)}%｜涨停 ${r.zt}｜候选 ${r.candCount} 只`);
    console.log(`板块 ${r.sectors} 个｜A 档 ${r.sectorA} 个｜主线 ${r.mainline} 个`);
    console.log(`观察池 ${r.poolActive} 只在池｜迁移 ${r.poolMoved} 次｜信号回填 ${r.bfFilled} 条｜降级 ${r.degraded} 个策略`);
    const okRuns = r.signals.filter((x) => !x.error);
    if (r.signals.length) {
      const hits = okRuns.reduce((a, x) => a + x.hits, 0);
      console.log(`策略信号 ${hits} 条（${okRuns.length} 个策略扫描完成）`
        + (r.risk ? `｜持仓 ${r.risk.holding} 只、风险 ${r.risk.risky} 只` : ''));
    }
    console.log(`对账 ${r.reconciled ? '已完成 ' + r.reconciled + ' 条' : '无待办'}｜总耗时 ${Date.now() - t0}ms`);
  } else {
    console.log(`回补 ${dates.length} 个交易日：成功 ${ok.length} 天、失败 ${bad.length} 天｜总耗时 ${Date.now() - t0}ms`);
    console.log('  日期        结论     分数  宽度    涨停  板块A  主线  对账  信号');
    for (const r of results) {
      if (r.error) {
        console.log(`  ${r.date}  ✗ ${r.error.slice(0, 60)}`);
        continue;
      }
      const hits = r.signals.filter((x) => !x.error).reduce((a, x) => a + x.hits, 0);
      console.log(`  ${r.date}  ${String(r.verdict).padEnd(7)} ${String(r.score).padStart(4)}`
        + `  ${(r.breadth * 100).toFixed(1).padStart(5)}%  ${String(r.zt).padStart(4)}`
        + `  ${String(r.sectorA).padStart(5)}  ${String(r.mainline).padStart(4)}`
        + `  ${String(r.reconciled).padStart(4)}  ${String(hits).padStart(4)}`);
    }
    const recTotal = ok.reduce((a, r) => a + r.reconciled, 0);
    console.log(`  合计对账写入/更新 ${recTotal} 条`);
    if (bad.length) {
      console.log(`  失败日期：${bad.map((r) => r.date).join(', ')}`);
      process.exitCode = 1;          // 有失败就以非 0 退出（G3）
    }
  }
}

main().catch((e) => {
  log.error('daily-close.failed', { error: e.message, stack: e.stack });
  console.error('失败：' + e.message);
  process.exitCode = 1;   // 不许打印错误后正常退出（G3）
});
