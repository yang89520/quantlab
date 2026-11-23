'use strict';
/**
 * 通达信网关适配器（docs/dev/10 §3.1）。
 *
 * 数据来自 tdx-gateway（Go，:7710），它解析通达信协议连 7709 端口的行情服务器。
 * 为什么值得接：通达信协议**直接提供板块指数日线**（880xxx），而新浪/东财都没有 ——
 * 这是本项目「板块 K 线只能靠本地 38.5GB 库聚合」这个硬约束的唯一解法。
 *
 * 三条硬规矩：
 *  1. 网关不可用时**快速失败**，不拖住整个取数链（健康探测结果缓存 60s）
 *  2. `until` 必须透传：网关那边按日期截断，这里绝不能自己补
 *  3. 返回格式与 lib/sources.js 完全一致（[date,open,close,high,low,vol,amount]），
 *     否则 clean.js / shape.js 会静默算错
 */
const config = require('../../config');
const log = require('../../log');

const CFG = () => (config.sources && config.sources.tdx) || {};

function base() {
  const c = CFG();
  return String(c.baseUrl || 'http://127.0.0.1:7710').replace(/\/$/, '');
}
function timeoutMs() {
  return Number(CFG().timeoutMs) || 20000;
}

/** 健康探测结果缓存：每次取数都探一次会把网关打满 */
let _probe = { at: 0, ok: false, detail: null };

async function get(path, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || timeoutMs());
  try {
    const r = await fetch(base() + path, { signal: ac.signal, headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error('网关返回不是合法 JSON');
    if (!j.ok) throw new Error(j.error || ('网关 HTTP ' + r.status));
    return j.data;
  } finally {
    clearTimeout(timer);
  }
}

/** 网关是否可用（结果缓存 60s；强制刷新传 true） */
async function available(force) {
  // 开关必须在缓存之前判：否则关掉 tdx 后，之前探活成功的结果会继续生效 60 秒
  if (CFG().enabled === false) {
    _probe = { at: Date.now(), ok: false, detail: 'disabled' };
    return false;
  }
  const ttl = Number(CFG().probeTtlMs) || 60000;
  if (!force && Date.now() - _probe.at < ttl) return _probe.ok;
  try {
    const d = await get('/health', 5000);
    _probe = { at: Date.now(), ok: true, detail: d };
    return true;
  } catch (e) {
    _probe = { at: Date.now(), ok: false, detail: e.message };
    log.warn('tdx.unavailable', { error: e.message, base: base() });
    return false;
  }
}

function probeDetail() {
  return _probe.detail;
}

/**
 * 日线（个股 / 指数 / 板块指数统一入口）
 * @param {string} code sh600000 | sz000001 | 880301（板块指数不带市场前缀）
 * @param {{bars?:number, until?:string}} opt
 * @returns {Promise<{rows:Array, asOf:string, upCount:number, downCount:number,
 *                    source:string, level:string, degraded:boolean}>}
 */
async function kline(code, opt) {
  const o = opt || {};
  const bars = Math.max(1, Number(o.bars) || 250);
  const q = new URLSearchParams({ code: String(code), count: String(bars) });
  if (o.until) q.set('until', String(o.until).slice(0, 10));
  const d = await get('/kline?' + q.toString());
  return {
    rows: d.rows || [],
    asOf: d.asOf || null,
    // 板块指数/指数有效（上涨家数），个股为 0
    upCount: Number(d.upCount) || 0,
    downCount: Number(d.downCount) || 0,
    source: 'tdx',
    level: 'B',          // 网络源，不是本地定稿数据
    degraded: false,
  };
}

/** 实时五档报价（批量，最多 800 只） */
async function quote(codes) {
  const list = (codes || []).filter(Boolean);
  if (!list.length) return [];
  const d = await get('/quote?codes=' + encodeURIComponent(list.join(',')), Math.max(timeoutMs(), 30000));
  return d.list || [];
}

/**
 * 全市场快照（A 股个股，一次拿完）。
 *
 * 输出直接对齐 lib/datasource 里 snapshot 的既有形状，调用方不用二次加工：
 *   { code（6位）, symbol（带前缀）, price, chgPct, amount, amplitude,
 *     turnover:null, floatCap:null }
 *
 * 为什么 turnover / floatCap 是 null：通达信报价协议里没有换手率和流通市值。
 * 缺就是缺，不拿 volume/price 去猜（D1）。下游看到的 degraded 标记由此而来。
 * 沪市 8 秒 / 命中代码缓存 3 秒，比新浪（1.5 秒）慢，但新浪是单点，
 * 一旦被限流整条链就断。
 */
async function snapshot(date) {
  // date 传了就取历史某日，不传取当日。
  //
  // 历史日必须**分片拉**：整份 5583 只逐只查 K 线要 6 分钟，而 Node 的 fetch
  // 默认 bodyTimeout 是 300 秒 —— 一次拿完必然在 305 秒左右报 fetch failed，
  // 而网关那边还在白算（实测：进度跑到 4500 时客户端已断开）。
  // 分片后每片 800 只约 48 秒，远低于限制，慢请求也不会长占网关的串行锁。
  let raw = [];
  let ms = 0;
  if (!date) {
    const d = await get('/snapshot', Math.max(timeoutMs(), 120000));
    raw = d.list || [];
    ms = d.ms || 0;
  } else {
    const day = String(date).slice(0, 10);
    let offset = 0;
    let guard = 0;
    for (;;) {
      const d = await get(
        `/snapshot?date=${encodeURIComponent(day)}&offset=${offset}&limit=500`,
        Math.max(timeoutMs(), 180000),
      );
      const got = d.list || [];
      raw = raw.concat(got);
      ms += d.ms || 0;
      log.info('tdx.snapshot_slice', {
        date: day, offset, got: got.length, total: d.total, hasMore: !!d.hasMore,
      });
      if (!d.hasMore) break;
      offset = Number(d.nextOffset) || (offset + got.length);
      if (++guard > 20) throw new Error('历史快照分片超过 20 片，疑似死循环');
    }
  }
  const rows = [];
  let bad = 0;
  for (const s of raw) {
    const price = Number(s.price);
    const pre = Number(s.preClose);
    if (!Number.isFinite(price) || price <= 0) { bad++; continue; }
    const hasPre = Number.isFinite(pre) && pre > 0;
    const hi = Number(s.high);
    const lo = Number(s.low);
    const amt = Number(s.amount);
    rows.push({
      code: String(s.code).slice(-6),          // 6 位，供序列聚合用
      symbol: String(s.code),                  // sh600000，供 MARKET_OF 判市场
      price,
      chgPct: hasPre ? Number((((price / pre) - 1) * 100).toFixed(4)) : null,
      amount: Number.isFinite(amt) && amt > 0 ? amt : null,
      amplitude: (hasPre && Number.isFinite(hi) && Number.isFinite(lo))
        ? Number((((hi - lo) / pre) * 100).toFixed(2))
        : null,
      turnover: null,
      floatCap: null,
      preClose: hasPre ? pre : null,
      volume: Number(s.volume) || null,
    });
  }
  return {
    data: rows,
    count: rows.length,
    invalid: bad,
    ms,
    // 历史快照必须带回它自己的日期，否则调用方会拿今天的时点去标它（D3）
    asOf: date ? String(date).slice(0, 10) : null,
    source: date ? 'tdx-history' : 'tdx',
    level: 'B',
    nullFields: ['turnover', 'floatCap'],
  };
}

/** 板块：名称→指数代码映射 + 三套成分。整包 16 秒左右，调用方应缓存 */
async function blocks() {
  const d = await get('/blocks', Math.max(timeoutMs(), 90000));
  return { indexMap: d.indexMap || [], blocks: d.blocks || {}, ms: d.ms };
}

/** 个股统计（PE / 股息 / 连涨跌 / 区间涨幅） */
async function stat() {
  const d = await get('/stat', Math.max(timeoutMs(), 60000));
  return d.list || [];
}

/** 行业归属（通达信 T + 申万 X） */
async function hy() {
  const d = await get('/hy', Math.max(timeoutMs(), 30000));
  return d.list || [];
}

/** 板块指数代码是否形如 880301（通达信板块指数） */
function isBlockIndex(code) {
  return /^8\d{5}$/.test(String(code || ''));
}

module.exports = {
  available, probeDetail, kline, quote, snapshot, blocks, stat, hy, isBlockIndex,
  base, timeoutMs,
};
