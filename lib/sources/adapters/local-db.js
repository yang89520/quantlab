'use strict';
/**
 * 上游行情库只读适配器（docs/dev/09 §7.4 / 10 §3.3）。
 * 铁律：readOnly 打开、短连接、绝不写；本项目不修改上游库任何一行。
 *
 * 用途：给板块聚合提供成分股日线（上游没有任何源直接提供板块 K 线）。
 * 同时提供交易日序列，供观察池 daysInState 按交易日计。
 */
const ds = require('../../datasource');

const BATCH = 400;

function toNum(v) { return typeof v === 'bigint' ? Number(v) : Number(v); }
function toDate(v) {
  const s = String(toNum(v));
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 最近 bars 个交易日（升序），供交易日计数与起算日期 */
async function sessionDates(bars) {
  const n = Math.max(1, Number(bars) || 250);
  return ds.withMarketDb(async (c) => {
    const r = await c.runAndReadAll(
      'SELECT DISTINCT date FROM kline_daily ORDER BY date DESC LIMIT ?', [n]
    );
    return r.getRowObjects().map((x) => toDate(x.date)).sort();
  });
}

/**
 * 批量读成分股日线。
 * @param {string[]} codes 6 位纯代码
 * @param {number} bars 最近多少根（默认 250）
 * @returns {Promise<Record<string, Array<[date,open,close,high,low,volume,amount]>>>}
 */
async function readMemberKlines(codes, bars) {
  const list = Array.from(new Set((codes || []).map((c) => String(c).replace(/^(sh|sz|bj)/, ''))))
    .filter((c) => /^\d{6}$/.test(c));
  if (!list.length) return {};
  const n = Math.max(21, Number(bars) || 250);

  return ds.withMarketDb(async (conn) => {
    const dr = await conn.runAndReadAll(
      'SELECT DISTINCT date FROM kline_daily ORDER BY date DESC LIMIT ?', [n]
    );
    const dates = dr.getRowObjects().map((x) => toNum(x.date));
    if (!dates.length) return {};
    const minDate = Math.min.apply(null, dates);

    const out = {};
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const marks = chunk.map(() => '?').join(',');
      const sql = `SELECT market, code, date, open, close, high, low, volume, amount
                     FROM kline_daily
                    WHERE date >= ? AND code IN (${marks})
                    ORDER BY code, date`;
      const r = await conn.runAndReadAll(sql, [minDate].concat(chunk));
      for (const row of r.getRowObjects()) {
        const code = String(row.code);
        if (!out[code]) out[code] = [];
        out[code].push([
          toDate(row.date),
          toNum(row.open), toNum(row.close), toNum(row.high), toNum(row.low),
          toNum(row.volume), toNum(row.amount),
        ]);
      }
    }
    return out;
  });
}

module.exports = { sessionDates, readMemberKlines };
