'use strict';
/**
 * 策略信号跟踪（docs/dev/02 S11/S12、05 §7.2）。
 *
 * 口径：price 是信号日收盘价；tN 是信号后第 N 个**交易日**相对 price 的涨跌（不是自然日）；
 * buy 信号 chg>0 记 hit=true；A 股只做多，sell 信号不判 hit。
 *
 * 回填必须幂等且补漏：每次 daily 运行回填「所有到期但未填」的记录，不只回填今日的。
 * 到期仍无数据（停牌/退市）保持 null 并标 reason:'no_data'，绝不填 0（D1）。
 */
const config = require('./config');
const log = require('./log');
const store = require('./dao');
const localdb = require('./sources/adapters/local-db');

const DAYS = config.gates.trackDays;

/** 记录某策略某日命中的信号；scanned 必须记录预筛后实际扫描数量（05 §7.1） */
async function record(date, strategyId, version, signals, scanned) {
  const st = await store.open();
  const rows = (signals || []).filter((s) => s && /^\d{6}$/.test(String(s.code))).map((s) => {
    const code = String(s.code);
    return {
      date, strategy_id: strategyId, version,
      code, action: s.action || 'buy', price: Number(s.price),
      payload: {
        schema: 1, date, strategyId, version, code,
        action: s.action || 'buy', price: Number(s.price),
        track: { t1: null, t5: null, t10: null },
        reasons: {},
        scanned: scanned == null ? null : Number(scanned),
      },
    };
  });
  if (rows.length) await st.upsert('strategy_signal', rows);
  log.info('track.recorded', { date, strategyId, signals: rows.length, scanned });
  return rows.length;
}

/**
 * 幂等补漏回填。
 * @param {string} today 当前交易日
 * @param {string[]} sessionDates 升序交易日序列（必须覆盖所有信号日 + 10 个交易日）
 */
async function backfill(today, sessionDates) {
  const st = await store.open();
  const all = await st.query('strategy_signal', { order: 'date', desc: false, limit: 100000 });
  const idx = new Map((sessionDates || []).map((d, i) => [String(d).slice(0, 10), i]));
  const pending = [];
  for (const r of all) {
    const p = (r.payload && typeof r.payload === 'object') ? r.payload : null;
    if (!p) continue;
    const t = p.track || {};
    const si = idx.get(String(r.date));
    if (si === undefined) continue;
    const need = DAYS.filter((n) => t[`t${n}`] == null && si + n < sessionDates.length
      && String(sessionDates[si + n]) <= String(today));
    if (need.length) pending.push({ row: r, payload: p, track: t, si, need });
  }
  if (!pending.length) return { checked: all.length, filled: 0, noData: 0 };

  const codes = Array.from(new Set(pending.map((x) => String(x.row.code))));
  let klines = {};
  try {
    klines = await localdb.readMemberKlines(codes, Math.max(60, sessionDates.length));
  } catch (e) {
    log.warn('track.klines_unavailable', { error: e.message });
  }

  let filled = 0, noData = 0;
  const changed = [];
  for (const x of pending) {
    const bars = klines[String(x.row.code)] || [];
    const byDate = new Map(bars.map((b) => [String(b[0]).slice(0, 10), Number(b[2])]));
    const track = Object.assign({}, x.track);
    const reasons = Object.assign({}, x.payload.reasons || {});
    for (const n of x.need) {
      const target = String(sessionDates[x.si + n]).slice(0, 10);
      const close = byDate.get(target);
      const key = `t${n}`;
      if (!Number.isFinite(close) || close <= 0 || !Number(x.row.price)) {
        track[key] = null;
        reasons[key] = 'no_data';
        noData++;
      } else {
        const chg = close / Number(x.row.price) - 1;
        track[key] = {
          chg: Number(chg.toFixed(4)),
          hit: String(x.row.action) === 'buy' ? chg > 0 : null,
        };
        delete reasons[key];
        filled++;
      }
    }
    x.payload.track = track;
    x.payload.reasons = reasons;
    changed.push({
      date: x.row.date, strategy_id: x.row.strategy_id, code: x.row.code,
      version: x.row.version, action: x.row.action, price: x.row.price,
      payload: x.payload,
    });
  }
  if (changed.length) await st.upsert('strategy_signal', changed);
  log.info('track.backfilled', { today, checked: all.length, pending: pending.length, filled, noData });
  return { checked: all.length, filled, noData };
}

/** 实盘命中率（基于 t1）；样本不足返回 null，不编 0 */
async function winRate(strategyId, opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('strategy_signal', { where: { strategy_id: strategyId }, limit: 100000 });
  let hit = 0, valid = 0;
  for (const r of rows) {
    const t = (r.payload && r.payload.track) || {};
    if (!t.t1 || t.t1.hit == null) continue;
    valid++;
    if (t.t1.hit) hit++;
  }
  return {
    strategyId, sample: valid,
    liveWinRate: valid ? Number((hit / valid).toFixed(4)) : null,
  };
}

async function listSignals(date, opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('strategy_signal', { where: { date }, limit: 100000 });
  return rows.map((r) => ({
    date: r.date, strategyId: r.strategy_id, version: r.version,
    code: r.code, action: r.action, price: r.price,
    track: (r.payload && r.payload.track) || null,
    reasons: (r.payload && r.payload.reasons) || {},
    scanned: r.payload ? r.payload.scanned : null,
  }));
}

async function listByStrategy(strategyId, opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('strategy_signal', {
    where: { strategy_id: strategyId }, order: 'date', desc: false, limit: 100000,
  });
  return rows.map((r) => ({
    date: r.date, strategyId: r.strategy_id, version: r.version,
    code: r.code, action: r.action, price: r.price,
    track: (r.payload && r.payload.track) || null,
    reasons: (r.payload && r.payload.reasons) || {},
    scanned: r.payload ? r.payload.scanned : null,
  }));
}

module.exports = { DAYS, record, backfill, winRate, listSignals, listByStrategy };
