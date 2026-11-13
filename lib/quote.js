'use strict';
/**
 * 行情数据层：代码规范化 + 多源适配（见 lib/sources.js）+ 统一输出结构
 * 所有对外函数都返回 Promise，失败抛出带 code 的错误
 */

const S = require('./sources');

/* ---------------- 指数 ---------------- */
/**
 * 指数与个股的代码空间是重叠的：000001 既是上证指数（沪）又是平安银行（深）。
 * 因此指数一律用「市场前缀 + 6 位」作为唯一键（sh000001），
 * 个股仍用裸 6 位，两者在存储与路由里不会互相顶掉。
 */
const INDEX_LIST = [
  { key: 'sh000001', name: '上证指数', short: '上证' },
  { key: 'sz399001', name: '深证成指', short: '深成' },
  { key: 'sz399006', name: '创业板指', short: '创业板' },
  { key: 'sh000300', name: '沪深300', short: '沪深300' },
  { key: 'sh000688', name: '科创50', short: '科创50' },
  { key: 'sh000905', name: '中证500', short: '中证500' },
  { key: 'sh000852', name: '中证1000', short: '中证1000' },
  { key: 'sh000016', name: '上证50', short: '上证50' },
  { key: 'bj899050', name: '北证50', short: '北证50' },
];

/** 指数代码段：沪 000xxx、深 399xxx、北证 899xxx（个股不会落在这三段） */
function isIndexCode(market, code) {
  if (market === 'sh') return /^000\d{3}$/.test(code);
  if (market === 'sz') return /^399\d{3}$/.test(code);
  if (market === 'bj') return /^899\d{3}$/.test(code);
  return false;
}

/* ---------------- 代码规范化 ---------------- */
/** 把 600986 / sh600986 / 600986.SH / SZ000001 / sh000001 统一成 { code, market, secid, symbol, asset } */
function normalize(input) {
  if (!input) return null;
  let raw = String(input).trim().toUpperCase().replace(/\s/g, '');
  let market = null;
  let m = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (m) { market = m[1].toLowerCase(); raw = m[2]; }
  m = raw.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (m) { market = m[2].toLowerCase(); raw = m[1]; }
  if (!/^\d{6}$/.test(raw)) return null;
  if (!market) {
    // 6 开头沪市，0/3 深市，4/8/9 北交所
    if (/^6/.test(raw)) market = 'sh';
    else if (/^(0|3)/.test(raw)) market = 'sz';
    else market = 'bj';
  }
  const prefix = market === 'sh' ? '1' : '0';
  const asset = isIndexCode(market, raw) ? 'index' : 'stock';
  return {
    code: raw,
    market,
    secid: prefix + '.' + raw,
    symbol: market + raw,
    // 存储 / 路由用的唯一键：指数带市场前缀，个股保持裸代码（兼容既有数据）
    key: asset === 'index' ? market + raw : raw,
    asset,
    display: raw + '.' + market.toUpperCase(),
  };
}

/* ---------------- 实时快照 ---------------- */
/**
 * 批量实时行情
 * @param {string[]} codes 原始代码数组（个股裸代码，或指数 sh000001）
 * @returns {Promise<Object>} code -> snapshot
 */
async function snapshots(codes) {
  const items = codes.map(normalize).filter(Boolean);
  if (!items.length) return {};
  const out = {};
  const ckey = 'snap:' + items.map((x) => x.symbol).sort().join(',');
  const cached = S.getCached(ckey);
  if (cached) return cached;

  const raw = await S.tencentSnaps(items);

  for (const it of items) {
    const s = raw[it.symbol];
    // 腾讯对北交所常返回全 0 行，视作无效
    if (!s || !s.price) continue;
    out[it.key] = {
      code: it.asset === 'index' ? it.key : s.code,
      key: it.key,
      name: s.name,
      price: s.price,
      chg: s.chg,
      chgPct: s.chgPct,
      open: s.open,
      high: s.high,
      low: s.low,
      prevClose: s.prevClose,
      volume: s.volume,
      amount: s.amount,
      turnover: it.asset === 'index' ? null : s.turnover,
      pe: it.asset === 'index' ? null : s.pe,
      pb: it.asset === 'index' ? null : s.pb,
      amplitude: s.amplitude,
      floatCap: it.asset === 'index' ? null : s.floatCap,
      totalCap: it.asset === 'index' ? null : s.totalCap,
      floatShares: it.asset === 'index' ? null : s.floatShares,
      totalShares: it.asset === 'index' ? null : s.totalShares,
      upLimit: it.asset === 'index' ? null : s.upLimit,
      downLimit: it.asset === 'index' ? null : s.downLimit,
      volRatio: s.volRatio,
      mainNet: null,          // 腾讯不提供主力净流入，前端已做缺失降级
      industry: '',
      asset: it.asset,
    };
  }

  // 腾讯拿不到的（北交所等）用新浪排行兜底
  const missing = items.filter((it) => !out[it.key]);
  if (missing.length && missing.length <= 80) {
    try {
      const list = await S.marketList('all');
      const idx = new Map(list.map((x) => [x.code, x]));
      for (const it of missing) {
        const x = idx.get(it.code);
        if (!x) continue;
        out[it.key] = Object.assign({}, x, {
          key: it.key,
          asset: it.asset,
          mainNet: null,
          industry: '',
          floatCap: it.asset === 'index' ? null : x.floatCap,
          totalCap: it.asset === 'index' ? null : x.totalCap,
          floatShares: it.asset === 'index' ? null : x.floatShares,
          turnover: it.asset === 'index' ? null : x.turnover,
          pe: it.asset === 'index' ? null : x.pe,
          pb: it.asset === 'index' ? null : x.pb,
        });
      }
    } catch (e) { /* 兜底失败不影响主流程 */ }
  }

  S.setCached(ckey, out, 8000);
  return out;
}

function num(v) {
  if (v === '-' || v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- K 线 ---------------- */
/**
 * @param {string} code
 * @param {number} bars 需要的根数
 * @param {string} period day|week|month
 */
async function klines(code, bars = 500, period = 'day') {
  const it = normalize(code);
  if (!it) throw Object.assign(new Error('代码格式不正确'), { code: 400 });
  const lim = Math.min(5000, Math.max(30, bars));
  const got = await S.klines(it, lim, period);
  if (!got || !got.rows.length) {
    throw Object.assign(new Error('未获取到该代码的行情数据'), { code: 404 });
  }
  return {
    name: got.name, code: it.code, market: it.market,
    key: it.key, asset: it.asset, display: it.display,
    rows: got.rows,
    turnover: got.turnover,
    quality: got.quality,
    source: got.source,
  };
}

/* ---------------- 搜索 ---------------- */
async function search(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const key = 's:' + q;
  const cached = S.getCached(key);
  if (cached) return cached;

  let out = [];
  try {
    const rows = await S.sinaSuggest(q);
    out = rows.map((r) => {
      const it = normalize(r.symbol);
      if (!it) return null;
      return {
        code: it.key,
        name: r.name,
        market: it.market,
        display: it.display,
        type: it.asset === 'index' ? 'index' : 'stock',
        typeName: it.asset === 'index' ? '指数' : 'A股',
      };
    }).filter(Boolean);
  } catch (e) { out = []; }

  // 去重（新浪 suggest 会同时给出简称与原名）
  const uniq = new Map();
  for (const x of out) if (!uniq.has(x.code)) uniq.set(x.code, x);
  const list = [...uniq.values()];
  // 指数排前面：搜「上证」「000001」时，用户多半想先看指数
  list.sort((a, b) => (a.type === 'index' ? 0 : 1) - (b.type === 'index' ? 0 : 1));
  S.setCached(key, list, 300000);
  return list;
}

module.exports = {
  normalize, snapshots, klines, search, num, INDEX_LIST, isIndexCode,
  marketList: S.marketList, probe: S.probe, health: S.health, sources: S,
};
