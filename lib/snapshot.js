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
 * A 股个股白名单（按号段）。
 *
 * 上游 kline_daily 里混着指数和基金：sh 有 000001/000016/000300/000688/000852/000905
 * 六个指数、sz 有 399001/399006，2026-11-13 全表 5554 行里 9 行不是个股。
 * 回补快照只取个股 —— 指数点位和个股价格不同量纲，混进去会把 breadth 与涨停统计带偏。
 * 同时用 market 限定，避免 000001 在 sh 是指数、在 sz 是平安银行的跨市场同号问题。
 *
 * 302xxx 是创业板 2026 年启用的新号段（实测 302132 已在网络快照里出现），
 * 漏掉它会让回补日少一只票 —— 量级 0.02%，但既然发现了就补上。
 */
const A_SHARE_WHERE = `(
  (market = 'sh' AND (code LIKE '600%' OR code LIKE '601%' OR code LIKE '603%'
                      OR code LIKE '605%' OR code LIKE '688%' OR code LIKE '689%'))
  OR (market = 'sz' AND (code LIKE '000%' OR code LIKE '001%' OR code LIKE '002%'
                         OR code LIKE '003%' OR code LIKE '300%' OR code LIKE '301%'
                         OR code LIKE '302%'))
  OR (market = 'bj' AND (code LIKE '4%' OR code LIKE '8%' OR code LIKE '92%'))
)`;

/**
 * 抓取并落盘当日快照（网络实时源）。
 *
 * **历史日护栏（D3）**：网络快照永远是「此刻」的数据，它只可能对应
 * `snap.asOf`（最近已收盘交易日）那一天。以前这里用调用方传进来的 `date`
 * 给行打标签，于是 `daily-close --date 2026-11-13` 会把今天的行情写成 11-13 —— 
 * 版本库里凭空多出一份标错日期的假历史，而且看起来完全正常。
 * 现在：行一律按 `snap.asOf` 打标签；请求日与 asOf 不一致就直接拒绝，
 * 并提示改用 `captureFromLocal()`（从上游日线合成）。
 *
 * @param {string} [date] 期望写入的交易日；不传则用数据的真实 asOf
 */
async function capture(date) {
  const t0 = Date.now();
  const snap = await ds.resolve({ kind: 'snapshot' });

  const realAsOf = snap.asOf ? String(snap.asOf).slice(0, 10) : null;
  const asked = date ? String(date).slice(0, 10) : null;
  const sess = asked || realAsOf || ds.todayStr();

  if (realAsOf && asked && asked !== realAsOf) {
    throw new Error(
      `拒绝为 ${asked} 写快照：网络快照实际对应 ${realAsOf}，`
      + `写成 ${asked} 等于往库里写标错日期的假数据（09 §D3）。`
      + `要回补历史日请走：node tools/daily-close.js --date ${asked} --from-local`,
    );
  }

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

/**
 * 从上游日线**合成**某个历史交易日的快照 —— 回补专用，不触网。
 *
 * 为什么需要它：网络快照只能拿到「此刻」，而闭环要攒够 20 天对账才能算命中率。
 * 历史日唯一可用的真实数据就是上游 kline_daily，用它算 chg_pct 与振幅是
 * 如实还原当日行情，不是造数据（09 §D1 禁止的是编造，不是推导）。
 *
 * 口径与网络源严格对齐（G4）：
 *   · chg_pct   = (close / prev_close - 1) * 100        ← 百分数，与 sina 一致
 *   · amplitude = (high - low) / prev_close * 100       ← 与 lib/sources.js 同一公式
 *   · turnover / float_cap = null                       ← 上游日线没有换手率与流通市值，
 *                                                          缺就是缺，不猜（D1）
 *
 * 停牌（当日无 K 线）的股不写入 —— 它既不该算进 breadth 分母，也不该出现在快照里。
 *
 * @param {string} date YYYY-MM-DD，必须是上游库里存在的交易日
 * @returns {Promise<object>} 与 capture() 同形状，额外带 synthesized 标记与空字段清单
 */
async function captureFromLocal(date) {
  const t0 = Date.now();
  if (!date) throw new Error('captureFromLocal 需要 date');
  const d = String(date).slice(0, 10);
  const dInt = Number(d.replace(/-/g, ''));
  if (!/^\d{8}$/.test(String(dInt))) throw new Error(`日期格式需为 YYYY-MM-DD：${date}`);

  const got = await ds.withMarketDb(async (c) => {
    // 取 <= 目标日的最近两个交易日：目标日本身 + 它的上一交易日（算涨跌幅要前收）
    const dr = await c.runAndReadAll(
      'SELECT DISTINCT date FROM kline_daily WHERE date <= ? ORDER BY date DESC LIMIT 2', [dInt]
    );
    const days = dr.getRowObjects().map((x) => Number(x.date));
    if (!days.length) return { target: null, prev: null, rows: [] };
    if (days[0] !== dInt) {
      // 目标日不是交易日（或上游库还没有这一天）：如实报错，退到别的日期就是伪造
      return { target: days[0], prev: days[1] || null, rows: [], notTradingDay: true };
    }
    const target = days[0];
    const prev = days[1] || null;
    if (!prev) return { target, prev: null, rows: [] };

    const r = await c.runAndReadAll(
      `WITH s AS (
         SELECT market, code, date, close, high, low, amount,
                LAG(close) OVER (PARTITION BY market, code ORDER BY date) AS prev_close
           FROM kline_daily
          WHERE date >= ? AND date <= ? AND ${A_SHARE_WHERE}
       )
       SELECT market, code, close, high, low, amount, prev_close
         FROM s WHERE date = ?`,
      [prev, target, target]
    );
    return { target, prev, rows: r.getRowObjects() };
  });

  if (got.notTradingDay) {
    throw new Error(`${d} 不是上游库里的交易日（按 <= ${d} 最近的一天是 ${fmtInt(got.target)}），`
      + '无法合成该日快照。请传一个真实交易日。');
  }
  if (!got.rows.length) {
    throw new Error(`上游库没有 ${d} 的前一交易日数据，无法计算涨跌幅，拒绝合成（D1）。`);
  }

  const rows = [];
  let invalid = 0;
  let noPrev = 0;
  for (const r of got.rows) {
    const close = Number(r.close);
    const pc = Number(r.prev_close);
    if (!Number.isFinite(close) || close <= 0) { invalid++; continue; }
    const hasPrev = Number.isFinite(pc) && pc > 0;
    if (!hasPrev) noPrev++;
    const high = Number(r.high);
    const low = Number(r.low);
    const amt = Number(r.amount);
    rows.push({
      date: d,
      market: String(r.market),
      code: String(r.code),
      price: close,
      // 无前收（新股首日/长期停牌复牌）→ null，让 readSummary 把它排除在分母外
      chg_pct: hasPrev ? Number((((close / pc) - 1) * 100).toFixed(4)) : null,
      amount: Number.isFinite(amt) && amt > 0 ? amt : null,
      turnover: null,
      float_cap: null,
      amplitude: (hasPrev && Number.isFinite(high) && Number.isFinite(low))
        ? Number((((high - low) / pc) * 100).toFixed(2))
        : null,
    });
  }

  const st = await store.open();
  if (rows.length) await st.upsert('snapshot', rows);

  const complete = rows.length >= config.integrity.minSnapshotCount;
  const rec = {
    date: d,
    complete,
    count: rows.length,
    invalid,
    noPrevClose: noPrev,
    source: 'market-db-aggregate',
    level: 'A',                       // 上游日线是已定稿的历史数据
    asOf: d,
    stale: d !== ds.todayStr(),
    synthesized: true,
    nullFields: ['turnover', 'float_cap'],
    baseDate: fmtInt(got.prev),
    ms: Date.now() - t0,
  };
  if (!complete) {
    log.warn('snapshot.from_local_incomplete', rec);
  } else {
    log.info('snapshot.from_local', rec);
  }
  return rec;
}

/** 20261113 → 2026-11-13 */
function fmtInt(n) {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
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

module.exports = { capture, captureFromLocal, readMap, readSummary, isLimitUp, A_SHARE_WHERE };
