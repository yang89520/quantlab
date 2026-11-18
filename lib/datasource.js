'use strict';
/**
 * 统一数据访问（本地优先解析链）
 *
 * 顺序（docs/dev/09-data-access.md §4.1）：
 *   ① 本地库 market.db（只读，仅历史 ≤ T-1）
 *   ② 网络接口（同花顺 → 新浪 → 腾讯）
 *   ③ 全失败 → 返回 null + missing[]，**绝不编造**
 *
 * 时效边界（§5）：请求日期 > 库内 MAX(date) 时强制走网络。
 * 当日行情绝不能拿 T-1 本地数据冒充。
 */
const fs = require('fs');
const config = require('./config');
const log = require('./log');
const Q = require('./quote');
const cache = require('./cache');
// 通达信网关（Go，:7710）。运行时可见性不确定，所以用惰性 require：
// 网关没部署时不该让整个 datasource 加载失败。
let _tdx = null;
function tdxSrc() {
  if (!_tdx) _tdx = require('./sources/adapters/tdx');
  return _tdx;
}

const ROOT = config.__root;

/* ---------------- 上游行情库（只读，短连接） ---------------- */

let duckdb = null;
function ducklib() {
  if (!duckdb) duckdb = require('@duckdb/node-api');
  return duckdb;
}

function marketPath() {
  const lb = config.localDb || {};
  if (!lb.enabled || !lb.marketDb) return null;
  const p = config.abs(lb.marketDb);
  return fs.existsSync(p) ? p : null;
}

let lastErr = null;

/* 上游库：每进程复用一个只读 instance。
   反复 create 会累积文件句柄，进而把自己锁死（实测过：报 Could not set lock）。
   连接仍是一次一开一关，不持有长连接。 */
let _marketInst = null;
let _marketInstPath = null;

async function marketInstance(p) {
  if (_marketInst && _marketInstPath === p) return _marketInst;
  const { DuckDBInstance } = ducklib();
  _marketInst = await DuckDBInstance.create(p, { access_mode: 'READ_ONLY' });
  _marketInstPath = p;
  return _marketInst;
}

/** 只读短连接：连接 open → query → close（绝不持有长连接，否则上游写不进去） */
async function withMarketDb(fn, retries = 3) {
  const p = marketPath();
  if (!p) throw Object.assign(new Error('上游行情库未配置或不存在'), { code: 'no_market_db' });
  let attempt = 0;
  for (;;) {
    try {
      const inst = await marketInstance(p);
      const conn = await inst.connect();
      try {
        return await fn(conn);
      } finally {
        if (conn.closeSync) conn.closeSync(); else conn.close();
      }
    } catch (e) {
      attempt++;
      _marketInst = null;               // 实例可能已失效（上游重建库等），下次重开
      if (e.code === 'no_market_db' || attempt >= retries) throw e;
      // 上游正在写库时打不开是正常并发状态，退避重试
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

function n(v) { return typeof v === 'bigint' ? Number(v) : v; }

/** 库内最新交易日 'YYYY-MM-DD'；失败返回 null（不猜） */
async function dbLatestDate() {
  try {
    const d = await withMarketDb(async (c) => {
      const r = await c.runAndReadAll('SELECT MAX(date) AS d FROM kline_daily');
      return r.getRowObjects()[0].d;
    });
    const num = n(d);
    if (!num) return null;
    const s = String(num);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  } catch (e) {
    lastErr = e.message;
    return null;
  }
}

/** 从本地库读日线，升序返回 [date, open, close, high, low, volume, amount] */
async function readLocalKline(code, bars, until) {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(code);
  if (!m) return [];
  const [, market, num] = m;
  const untilInt = until ? Number(String(until).replace(/-/g, '')) : 99999999;
  const rows = await withMarketDb(async (c) => {
    const r = await c.runAndReadAll(
      `SELECT date, open, close, high, low, volume, amount
         FROM kline_daily
        WHERE market = ? AND code = ? AND date <= ?
        ORDER BY date DESC LIMIT ?`,
      [market, num, untilInt, Math.max(1, bars)]
    );
    return r.getRowObjects();
  });
  const out = rows.map((r) => {
    const s = String(n(r.date));
    return [`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`,
      n(r.open), n(r.close), n(r.high), n(r.low), n(r.volume), n(r.amount)];
  });
  // 上游是 DESC，这里翻成升序
  return out.reverse();
}

/* ---------------- 日期工具 ---------------- */

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 最近一个「已收盘」的交易日：取本地库与网络最后一根的较大者，缓存 5 分钟。
   为什么不能只看库内 MAX(date)：上游入库是 T-1，若当日盘后还没入库，
   库内日期会落后一天，用它当 asOf 会把「昨天的数据」标成昨天——看似正确，
   但配上「今天的预判」就变成拿旧数据冒充当日（09 §D3）。*/
let _session = { date: null, at: 0 };

async function lastSessionDate() {
  if (_session.date && Date.now() - _session.at < 5 * 60 * 1000) return _session.date;
  let best = await dbLatestDate();
  try {
    const k = await Q.klines('sh000001', 30);
    const last = k.rows[k.rows.length - 1];
    if (last && last[0]) {
      const netDate = String(last[0]).slice(0, 10);
      if (!best || netDate > best) best = netDate;
    }
  } catch (e) {
    lastErr = e.message;
  }
  if (best) _session = { date: best, at: Date.now() };
  return best;
}

/** 交易日：库内 MAX(date) → 网络最后一根 → 手工表（09 §8.6） */
async function latestTradingDay() {
  const d = await dbLatestDate();
  const sess = await lastSessionDate();
  if (sess && (!d || sess > d)) return { date: sess, source: 'network', level: 'B' };
  if (d) return { date: d, source: 'market-db', level: 'A' };

  try {
    const k = await Q.klines('sh000001', 30);
    const last = k.rows[k.rows.length - 1];
    if (last && last[0]) return { date: String(last[0]).slice(0, 10), source: 'network', level: 'B' };
  } catch (e) {
    lastErr = e.message;
  }

  const hf = config.abs('data/holidays.json');
  if (fs.existsSync(hf)) {
    try {
      const hj = JSON.parse(fs.readFileSync(hf, 'utf8'));
      const days = (hj.days || []).map(String);
      let d2 = new Date();
      for (let i = 0; i < 15; i++) {
        const p = (x) => String(x).padStart(2, '0');
        const s = `${d2.getFullYear()}-${p(d2.getMonth() + 1)}-${p(d2.getDate())}`;
        const wd = d2.getDay();
        if (wd !== 0 && wd !== 6 && !days.includes(s)) return { date: s, source: 'holidays', level: 'C' };
        d2.setDate(d2.getDate() - 1);
      }
    } catch (e) {
      lastErr = `holidays.json 解析失败：${e.message}`;
    }
  }
  return { date: todayStr(), source: 'fallback-today', level: null };
}

/* ---------------- 主解析器 ---------------- */

/**
 * @param {object} req
 *   kind: 'kline-daily' | 'snapshot' | 'trading-day'
 *   code, bars, date
 * @returns {{rows?, data?, source, level, asOf, stale, degraded, missing[]}}
 */
async function resolve(req) {
  req = req || {};
  const kind = req.kind;

  if (kind === 'trading-day') {
    const t = await latestTradingDay();
    return {
      data: t.date, source: t.source, level: t.level, asOf: t.date,
      stale: t.level !== 'A' && t.level !== 'B', degraded: t.level !== 'A', missing: t.level ? [] : ['trading-day'],
    };
  }

  if (kind === 'snapshot') {
    // 全市场快照：上游库里没有当日快照，只能走网络（09 §4.2）。
    // 但 cron 与 Web 是两个进程，同一份当日快照没必要拉两次 → 走跨日必失效的二级缓存（01 §7.5）
    const cached = cache.get('market-all');
    if (cached && Array.isArray(cached.value.data) && cached.value.data.length) {
      return {
        data: cached.value.data,
        source: 'cache',
        level: 'B',
        asOf: cached.value.asOf || null,
        fetchedAt: cached.fetchedAt,
        stale: (cached.value.asOf || null) !== todayStr(),
        degraded: false,
        cached: true,
        missing: [],
      };
    }

    const list = await Q.marketList('all');
    if (!list || !list.length) {
      return { data: [], source: 'none', level: null, asOf: null, stale: true, degraded: true, missing: ['snapshot'] };
    }
    // 快照本身不带日期，时点按「最近已收盘交易日」标注。
    // 周末/盘前取到的必然是上一交易日收盘数据，stale=true 让 UI 说清楚。
    const sess = await lastSessionDate();
    const asOf = sess || todayStr();
    cache.set('market-all', { data: list, asOf });
    return {
      data: list,
      source: 'sina-quote',
      level: 'B',
      asOf,
      stale: asOf !== todayStr(),
      degraded: false,
      missing: sess ? [] : ['session-date'],
    };
  }

  if (kind === 'kline-daily') {
    if (!req.code) throw new Error('kline-daily 需要 code');
    // 两种合法写法：带市场前缀的个股/指数（sh600000 / sh000001），
    // 以及不带前缀的通达信板块指数（880301）。后者只有网关认识，本地库没有。
    const hit = /^(sh|sz|bj)\d{6}$/.test(req.code);
    const blockIdx = /^8\d{5}$/.test(req.code);
    if (!hit && !blockIdx) throw new Error(`代码格式需为 sh000001 或 880301 形式：${req.code}`);

    const bars = Math.max(30, Number(req.bars) || 260);
    const target = req.date ? String(req.date).slice(0, 10) : null;
    const dbMax = await dbLatestDate();
    // 板块指数不查本地库：上游库只有个股与大盘指数，查了必然空跑一遍
    const canLocal = !blockIdx && dbMax && (!target || target <= dbMax);

    let rows = [];
    let source = 'none';
    let level = null;
    let missing = [];
    let cachedHit = null;              // 命中二级缓存时保存来源信息，供 D4 留痕

    // ① 本地库
    if (canLocal && marketPath()) {
      try {
        rows = await readLocalKline(req.code, bars, target || dbMax);
        if (rows.length) { source = 'market-db'; level = 'A'; }
      } catch (e) {
        lastErr = e.message;
        log.warn('datasource.local_failed', { code: req.code, error: e.message });
      }
    }

    // ② 网络：本地没数据，或请求日期晚于库内最新（当日必须实时）
    const needNetwork = !rows.length || (target && dbMax && target > dbMax) || (!target && dbMax && dbMax < todayStr());
    if (needNetwork) {
      // ②-a 通达信网关优先（sources.tdx.prefer，默认开）。
      // 它有个别人没有的能力：板块指数 880xxx 也能当日线拉（见 docs/dev/10 §3.1）。
      // until 必须传：网关按日期截断，回补历史日时绝不把「未来」的 K 线混进来。
      let netDone = false;
      const tdxCfg = (config.sources || {}).tdx || {};
      if (tdxCfg.prefer !== false && await tdxSrc().available()) {
        try {
          const t = await tdxSrc().kline(req.code, {
            bars: Math.min(1200, bars),
            until: target || undefined,
          });
          if (t.rows && t.rows.length) {
            if (!rows.length) {
              rows = t.rows;
              source = 'tdx';
              level = 'B';
            } else {
              const have = new Set(rows.map((r) => String(r[0]).slice(0, 10)));
              const tail = t.rows.filter((r) => !have.has(String(r[0]).slice(0, 10)));
              if (tail.length) {
                rows = rows.concat(tail);
                source = 'market-db+tdx';
                level = 'A+B';
              }
            }
            netDone = true;
          }
        } catch (e) {
          // 网关挂了不该让整条链失败，往下退 ths / sina
          log.warn('datasource.tdx_failed', { code: req.code, error: e.message });
        }
      }

      // ②-b 传统网络源（同花顺 → 新浪）
      if (!netDone) {
        try {
          const k = await Q.klines(req.code, Math.min(1200, bars));
          let netRows = k.rows.slice();
          // 传统源不认日期，只能自己截断——否则回补历史日会算进未来（前视偏差）
          if (target) {
            netRows = netRows.filter((r) => String(r[0]).slice(0, 10) <= target);
          }
          if (!rows.length) {
            rows = netRows;
            source = k.source || 'network';
            level = 'B';
          } else {
            // 只补本地缺的那几根，不重拉全量（09 §5.3）
            const have = new Set(rows.map((r) => String(r[0]).slice(0, 10)));
            const tail = netRows.filter((r) => !have.has(String(r[0]).slice(0, 10)));
            if (tail.length) {
              rows = rows.concat(tail.map((r) => [String(r[0]).slice(0, 10)].concat(r.slice(1))));
              source = 'market-db+' + (k.source || 'network');
              level = 'A+B';
            }
          }
        } catch (e) {
          lastErr = e.message;
          missing.push('network');
          log.warn('datasource.network_failed', { code: req.code, error: e.message });
        }
      }
    }

    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (bars && rows.length > bars) rows = rows.slice(rows.length - bars);

    // ③ 二级缓存兜底：只对**历史请求**生效（历史 K 线内容固定，缓存不会变成假数据）。
    // 当日请求绝不从这里取——那正是 D3 要拦的「拿旧值冒充当日」。
    if (!rows.length && target && target < todayStr()) {
      const c = cache.get('klines-' + req.code);
      if (c && c.value && Array.isArray(c.value.rows) && c.value.rows.length) {
        const hit = c.value.rows.filter((r) => String(r[0]).slice(0, 10) <= target);
        if (hit.length) {
          rows = hit.slice(hit.length - bars);
          source = 'cache';
          level = 'B';
          cachedHit = c;
        }
      }
    }

    let asOf = rows.length ? rows[rows.length - 1][0] : null;
    const stale = !!(target && asOf && asOf < target);

    // 历史段落拉成功后写缓存，供另一进程（cron ↔ Web）复用
    if (level === 'B' && rows.length && asOf && asOf < todayStr() && !cachedHit) {
      cache.set('klines-' + req.code, { rows, asOf });
    }

    return {
      rows, source, level, asOf, stale, degraded: level !== 'A',
      cached: !!cachedHit,
      fetchedAt: cachedHit ? cachedHit.fetchedAt : undefined,
      missing,
    };
  }

  throw new Error(`未知的 kind：${kind}`);
}

/** 供 /api/health */
async function health() {
  const p = marketPath();
  let dbMax = null;
  if (p) dbMax = await dbLatestDate();
  return {
    marketDb: {
      configured: !!(config.localDb && config.localDb.marketDb),
      exists: !!p,                 // 文件在不在
      readable: dbMax !== null,    // 当前能否读到（上游持写锁时为 false）
      latest: dbMax,
      // 不可读时说明当前走的是网络兜底，不是故障（上游跑批会持排他锁）
      fallback: p && dbMax === null ? 'network' : null,
      lastError: lastErr,
    },
  };
}

module.exports = {
  resolve, latestTradingDay, lastSessionDate, dbLatestDate, health, todayStr,
  // 二期板块聚合复用上游只读连接（仍然只读、仍然短连接）
  withMarketDb, readLocalKline, marketPath,
};
