'use strict';
/**
 * 上游行情库只读适配器（docs/dev/09 §7.4 / 10 §3.3）。
 * 铁律：readOnly 打开、短连接、绝不写；本项目不修改上游库任何一行。
 *
 * 用途：给板块聚合提供成分股日线（上游没有任何源直接提供板块 K 线）。
 * 同时提供交易日序列，供观察池 daysInState 按交易日计。
 */
const ds = require('../../datasource');
const log = require('../../log');

const BATCH = 400;

function toNum(v) { return typeof v === 'bigint' ? Number(v) : Number(v); }

/**
 * 6 位纯代码 → 带市场前缀。与 sina-sector.withMarket 同一口径，
 * 额外兼容 920xxx（北交所新号段，原先被 `^(6|9)→sh` 误判成沪市）。
 */
function withMarket(code) {
  const c = String(code).replace(/^(sh|sz|bj)/, '');
  if (/^92/.test(c)) return `bj${c}`;          // 北交所 920xxx
  if (/^(6|9)/.test(c)) return `sh${c}`;       // 沪市 A/B
  if (/^(4|8)/.test(c)) return `bj${c}`;       // 北交所 4xxxxx / 8xxxxx
  return `sz${c}`;
}
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
 *
 * 必须按 **(market, code) 联合键**取序列 —— 只按 code 取会撞车：
 * 上游 kline_daily 里同一个 6 位代码可能同时存在两个市场，代表完全不同的标的。
 * 实测 000001 有 sh（上证指数，3700 点）与 sz（平安银行，11 元）两条序列，
 * 全库共 5 个这样的 code：000001 / 000016 / 000688 / 000852 / 000905。
 * 旧实现 SQL 里 SELECT 了 market 却没用它过滤，两条序列按日期交错塞进同一个数组，
 * aggregate 里 prevClose 被来回覆盖 —— 板块指数单日涨跌幅算出 ±30000%，
 * ret20 变成 270 万 %。所以这里一条序列一份，绝不合并（09 §D5）。
 *
 * @param {string[]} codes 6 位纯代码，或已带市场前缀的 sh600000
 * @param {number} bars 最近多少根（默认 250）
 * @returns {Promise<Record<string, Array<[date,open,close,high,low,volume,amount]>>>}
 */
async function readMemberKlines(codes, bars) {
  // code -> 期望市场（调用方显式给了前缀就听它的，否则按号段规则补）
  const want = new Map();
  for (const raw of codes || []) {
    const s = String(raw == null ? '' : raw).trim();
    const m = /^(sh|sz|bj)(\d{6})$/.exec(s);
    if (m) want.set(m[2], m[1]);
    else if (/^\d{6}$/.test(s)) want.set(s, withMarket(s).slice(0, 2));
  }
  const list = Array.from(want.keys());
  if (!list.length) return {};
  const n = Math.max(21, Number(bars) || 250);

  return ds.withMarketDb(async (conn) => {
    const dr = await conn.runAndReadAll(
      'SELECT DISTINCT date FROM kline_daily ORDER BY date DESC LIMIT ?', [n]
    );
    const dates = dr.getRowObjects().map((x) => toNum(x.date));
    if (!dates.length) return {};
    const minDate = Math.min.apply(null, dates);

    // code -> Map(market -> rows)
    const buckets = new Map();
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
        const mk = String(row.market);
        if (!buckets.has(code)) buckets.set(code, new Map());
        const byMk = buckets.get(code);
        if (!byMk.has(mk)) byMk.set(mk, []);
        byMk.get(mk).push([
          toDate(row.date),
          toNum(row.open), toNum(row.close), toNum(row.high), toNum(row.low),
          toNum(row.volume), toNum(row.amount),
        ]);
      }
    }

    const out = {};
    const collisions = [];
    for (const [code, byMk] of buckets) {
      const pref = want.get(code);
      let mk = pref && byMk.has(pref) ? pref : null;
      if (!mk) {
        // 期望市场没数据（号段规则判错 / 该票换过板）：取行数最多的那条，
        // 仍然只取一条序列，不合并 —— 合并就是这次事故的成因。
        let best = -1;
        for (const [k, rows] of byMk) if (rows.length > best) { best = rows.length; mk = k; }
      }
      if (!mk) continue;
      if (byMk.size > 1) collisions.push(`${code}:${Array.from(byMk.keys()).join('/')}→${mk}`);
      out[code] = byMk.get(mk);
    }
    // 跨市场同号必须留痕，否则下次再出问题无从追溯（09 §D4）
    if (collisions.length) {
      log.warn('localdb.code_market_collision', {
        count: collisions.length, picked: collisions.slice(0, 20).join(' '),
      });
    }
    return out;
  });
}

module.exports = { sessionDates, readMemberKlines, withMarket };
