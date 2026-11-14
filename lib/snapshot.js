'use strict';
/**
 * 日快照：次日对账的唯一基准。
 * 存储为长表（每只标的每天一行），便于 GROUP BY date 算宽度（docs/dev/02 §S1）。
 */
const store = require('./dao');
const ds = require('./datasource');
const config = require('./config');
const log = require('./log');

const MARKET_OF = (symbol) => {
  const s = String(symbol || '');
  if (s.startsWith('sh')) return 'sh';
  if (s.startsWith('sz')) return 'sz';
  if (s.startsWith('bj')) return 'bj';
  return 'sh';
};

/**
 * 抓取并落盘当日快照
 * @param {string} [date] 不传则用最近已收盘交易日
 */
async function capture(date) {
  const t0 = Date.now();
  const sess = date || (await ds.lastSessionDate()) || ds.todayStr();
  const snap = await ds.resolve({ kind: 'snapshot' });

  const rows = [];
  let invalid = 0;
  for (const s of snap.data) {
    const price = Number(s.price);
    if (!s.code || !Number.isFinite(price) || price <= 0) { invalid++; continue; }
    rows.push({
      date: sess,
      market: MARKET_OF(s.symbol),
      code: String(s.code),
      price,
      chg_pct: s.chgPct,
      amount: s.amount,
      turnover: s.turnover,
      float_cap: s.floatCap,
      amplitude: s.amplitude,
    });
  }

  const st = await store.open();
  if (rows.length) await st.upsert('snapshot', rows);

  const complete = rows.length >= config.integrity.minSnapshotCount;
  const rec = {
    date: sess,
    complete,
    count: rows.length,
    invalid,
    source: snap.source,
    level: snap.level,
    asOf: snap.asOf,
    stale: snap.stale,
    ms: Date.now() - t0,
  };
  if (!complete) {
    log.warn('snapshot.incomplete', { date: sess, count: rows.length, min: config.integrity.minSnapshotCount });
  } else {
    log.info('snapshot.captured', rec);
  }
  return rec;
}

/** 读某日快照为 Map<code, row>；不存在返回空 Map（不抛错） */
async function readMap(date) {
  const st = await store.open();
  const rows = await st.query('snapshot', { where: { date }, order: 'code', desc: false, limit: 100000 });
  const m = new Map();
  for (const r of rows) m.set(r.code, r);
  return m;
}

/** 读某日快照的概要（宽度、涨停数等） */
async function readSummary(date) {
  const m = await readMap(date);
  const list = Array.from(m.values());
  if (!list.length) return null;
  let up = 0, valid = 0, strong = 0, zt = 0;
  for (const r of list) {
    const c = r.chg_pct;
    if (c === null || c === undefined) continue;
    valid++;
    if (c > 0) up++;
    if (c >= 5) strong++;
    if (isLimitUp(r.code, c)) zt++;
  }
  return {
    date, count: list.length, valid,
    breadth: valid ? up / valid : null,
    strongRatioProxy: valid ? strong / valid : null,
    ztCount: zt,
    map: m,
  };
}

/** 涨停近似：主板 10% / 双创 20% / 北交所 30%（统一 9.8 会漏掉双创全部涨停） */
function isLimitUp(code, chg) {
  const c = String(code || '');
  const v = Number(chg);
  if (!Number.isFinite(v)) return false;
  if (/^(300|301|688|689)/.test(c)) return v >= 19.7;
  if (/^(4|8|9)/.test(c)) return v >= 29.6;
  return v >= 9.8;
}

module.exports = { capture, readMap, readSummary, isLimitUp };
