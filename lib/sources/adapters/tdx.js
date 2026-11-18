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
  available, probeDetail, kline, quote, blocks, stat, hy, isBlockIndex,
  base, timeoutMs,
};
