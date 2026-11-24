'use strict';
/**
 * 同花顺扶摇（fuyao.aicubes.cn）适配器 —— 个股/指数日线的第三备源。
 *
 * 定位：**兜底，不是主源**。本项目的日线主源是同花顺年份文件（ths）与本地库，
 * 扶摇在网络源全挂、或需要「批量月线」时才出手：
 *   - 历史 K 线：单只 1d，窗口 ≤10 年；
 *   - 批量历史：≤10 只/次，支持 1d / 1w / 1mo —— 这是本地做不到的，
 *     全市场月线扫描从「逐只 1 秒」变成「每批 10 只 0.5 秒」。
 *
 * 实测口径（2026-11-19，600986.SH）：
 *   fuyao volume=66841479 股 ↔ 本地 668415 手（÷100）；OHLC 完全一致；
 *   成交额差 2 元（各自四舍五入）。所以这里统一把 volume 折成「手」。
 *   原始价与新浪不复权逐日比对 60 天，偏差 0.0000%。
 *
 * ── 复权口径（重要）──────────────────────────────────────────
 * 接口自带的 adjust=forward 是**残缺的**：250 个月里 125 个月为负值
 * （600519.SH 2016-06 之前全负，2006-01 达 −304.31），且与 backward 的
 * 比值从 6.5 波动到 294，不是等比关系 —— 说明它用「减累计分红」而非
 * 「除权因子累乘」。任何超过约 9 年的窗口都会被污染。
 *
 * 因此本适配器的 forward **不走接口**，改为用 backward 自建：
 *     forward[t] = backward[t] / backward[last] × raw[last]
 * 这是标准前复权的等价形式（后复权 = 原始价 × 累计因子，除以最新累计因子
 * 即得前复权序列），恒为正、长历史可用。
 *
 * 注意与主链 ths 的差异：两家分红处理不同，序列平均偏差约 0.7%~2.7%
 * （有分红的票更大，600519 达 2.3%）。这是复权算法差异，不是数据错误，
 * 无法通过缩放消除。**因此禁止跨源拼接同一序列** —— 一个序列只从一个源
 * 取全，派生指标也从同一序列算（见 lib/wyckoff.js 与 lib/formula-screen.js）。
 *
 * ── 时间窗口 ─────────────────────────────────────────────────
 * 接口约束是「单次 start~end 跨度 ≤ 10 年」，不是「只能取近 10 年」。
 * 更早的历史用分段请求拼接：每段 9 年（留闰年余量），按时间升序合并去重。
 *
 * 失败一律抛错，绝不返回空数组冒充「没有数据」（与 sources.js 的 D1 约定一致）。
 */
const config = require('../../config');
const log = require('../../log');

const BASE = 'https://fuyao.aicubes.cn';
const MAX_BATCH = 10;          // 接口硬上限，11 只直接 code=1003
const TIMEOUT_MS = 15000;

function apiKey() {
  const s = (config.sources && config.sources.fuyao) || {};
  return String(s.apiKey || process.env.FUYAO_API_KEY || '').trim();
}

function enabled() { return !!apiKey(); }

/** sh600519 → 600519.SH；sz000001 → 000001.SZ；bj920876 → 920876.BJ */
function toThscode(key) {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(String(key || '').trim().toLowerCase());
  return m ? `${m[2]}.${m[1].toUpperCase()}` : null;
}

/** 600519.SH → sh600519（与项目内部 key 口径一致） */
function fromThscode(thscode) {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(String(thscode || '').trim());
  return m ? `${m[2].toLowerCase()}${m[1]}` : null;
}

function ms(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  return d.getTime();
}

/** 单次请求允许的最大跨度（年）。接口硬约束是 ≤10，取 9 留出闰年与边界余量。 */
const SEG_YEARS = 9;
const SEG_MS = SEG_YEARS * 365.25 * 24 * 3600 * 1000;

/**
 * 默认窗口 8.9 年。恰好落在单段内（SEG_YEARS=9），避免默认走分段多一次往返。
 * 8.9 年 ≈ 106 根月线，足够 60 月均线 + 34 月箱体 + 30 月量位的预热。
 * 需要更早历史时由调用方显式传 start，自动切段。
 */
function defaultStart(end) {
  return Number(end) - Math.round(8.9 * 365.25 * 24 * 3600 * 1000);
}

/** 把 [start,end] 切成若干段，每段跨度 ≤ SEG_YEARS。相邻段在边界处重叠 1 个时间点，由 Map 去重。 */
function splitSegments(start, end) {
  const e = Number(end);
  let s = Number(start);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) return [[e - SEG_MS, e]];
  const out = [];
  while (s < e) {
    const stop = Math.min(s + SEG_MS, e);
    out.push([s, stop]);
    s = stop;
  }
  return out;
}

function ymd(dateMs) {
  const d = new Date(Number(dateMs));
  // 接口给的是当日 00:00（Asia/Shanghai），用 UTC+8 反解，避免服务器时区不同导致差一天
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

async function call(pathname, params) {
  const key = apiKey();
  if (!key) throw new Error('未配置 sources.fuyao.apiKey（或环境变量 FUYAO_API_KEY）');
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}${pathname}?${qs}`, {
    headers: { 'X-api-key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`扶摇 HTTP ${r.status}`);
  const j = await r.json();
  // 业务错误也是 HTTP 200，必须看 code
  if (!j || j.code !== 0) {
    throw new Error(`扶摇返回 code=${j && j.code}：${(j && j.message) || 'unknown'}`);
  }
  return j.data;
}

/** 单根 K 线 → 项目内部对象行 {d,o,c,h,l,v,a}（与 thsDaily 的输出契约一致） */
function toRow(b) {
  return {
    d: ymd(b.date_ms),
    o: Number(b.open_price),
    c: Number(b.close_price),
    h: Number(b.high_price),
    l: Number(b.low_price),
    v: Math.round(Number(b.volume) / 100),        // 股 → 手，与本地库同口径
    a: Math.round(Number(b.turnover) || 0),
  };
}

/**
 * 分段取单只历史，返回按日期升序、去重后的原始 item 数组。
 * 接口限制的是「单次跨度」而非「只能取近 10 年」，早于 10 年的历史靠切段拿。
 */
async function segmentedItems(thscode, interval, start, end, adjust) {
  const segs = splitSegments(start, end);
  const byDate = new Map();
  for (const [s, e] of segs) {
    const d = await call('/api/a-share/prices/historical', {
      thscode,
      interval,
      start: String(Math.round(s)),
      end: String(Math.round(e)),
      adjust,
    });
    for (const it of (d && d.item) || []) byDate.set(ymd(it.date_ms), it);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((x) => x[1]);
}

/**
 * 取「不复权最新收盘」，用于把 backward 序列换算回前复权。
 * 只取尾部几天，成本可忽略。
 */
async function lastRawClose(thscode, interval, end) {
  const tailStart = Number(end) - 30 * 24 * 3600 * 1000;
  const d = await call('/api/a-share/prices/historical', {
    thscode,
    interval,
    start: String(Math.round(tailStart)),
    end: String(Math.round(end)),
    adjust: 'none',
  });
  const items = (d && d.item) || [];
  if (!items.length) throw new Error(`扶摇无 ${thscode} 的不复权数据，无法换算前复权`);
  return Number(items[items.length - 1].close_price);
}

/** 前复权重建：价格按比例缩放；量额必须换成不复权的真值 */
function rebuildForward(bwItems, rawLast, rawItems) {
  const bwLast = Number(bwItems[bwItems.length - 1].close_price);
  if (!(bwLast > 0) || !(rawLast > 0)) throw new Error('扶摇后复权基准异常，无法重建前复权');
  const k = rawLast / bwLast;

  /*
   * 关键：backward 会把成交量除以复权因子（为了维持「额 = 量 × 价」）。
   * 实测 600986 2026-08-10：none volume=64977422，backward volume=11713215，
   * 相差 5.55 倍。若直接沿用 backward 的量，重建后的序列「量 × 价」会比
   * 真实成交额小 5.5 倍，量位（V 的 30 期分位）随之失真。
   * 所以量、额一律取 none 口径的真值；取不到时退回按价格因子反向缩放。
   */
  const byDate = rawItems ? new Map(rawItems.map((it) => [ymd(it.date_ms), it])) : null;

  return bwItems.map((it) => {
    const d = ymd(it.date_ms);
    const raw = byDate ? byDate.get(d) : null;
    return {
      ...it,
      open_price: Number(it.open_price) * k,
      close_price: Number(it.close_price) * k,
      high_price: Number(it.high_price) * k,
      low_price: Number(it.low_price) * k,
      // none 口径的量额是真值；缺失时按价格因子反向缩放（保持量×价 ≈ 额）
      volume: raw ? Number(raw.volume) : Number(it.volume) / k,
      turnover: raw ? Number(raw.turnover) : Number(it.turnover),
    };
  });
}

/**
 * 单只历史 K 线。
 * @param {string} key  项目内部代码（sh600519 / sz000001 / bj920876）
 * @param {object} opt  { start, end, interval, adjust }
 *   adjust: 'forward'（默认，用 backward 重建）/ 'backward' / 'none'
 *   start 早于 end-9 年时自动分段，可拿全部上市历史。
 * @returns {Promise<{rows:Array, interval:string, adjust:string, segments:number}>}
 */
async function historical(key, opt) {
  const o = opt || {};
  const thscode = toThscode(key);
  if (!thscode) throw new Error(`无法识别的代码：${key}`);
  const end = o.end != null ? Number(o.end) : Date.now();
  const start = o.start != null ? Number(o.start) : defaultStart(end);
  const interval = o.interval || '1d';
  const want = o.adjust || 'forward';
  const segs = splitSegments(start, end);

  let items;
  if (want === 'forward') {
    // 接口自带的 forward 会出负价，改用 backward 重建（等价、恒正、长历史可用）。
    // 量额另取 none：backward 的成交量被除过复权因子，不是真值。
    const [bw, raw] = await Promise.all([
      segmentedItems(thscode, interval, start, end, 'backward'),
      segmentedItems(thscode, interval, start, end, 'none'),
    ]);
    if (!bw.length) throw new Error(`扶摇无 ${thscode} 的 ${interval} 数据`);
    const lastDate = ymd(bw[bw.length - 1].date_ms);
    const rawTail = raw.length ? raw.find((it) => ymd(it.date_ms) === lastDate) : null;
    const rawLast = rawTail ? Number(rawTail.close_price) : (raw.length ? Number(raw[raw.length - 1].close_price) : 0);
    items = rebuildForward(bw, rawLast, raw);
  } else {
    items = await segmentedItems(thscode, interval, start, end, want);
  }

  if (!items.length) throw new Error(`扶摇无 ${thscode} 的 ${interval} 数据`);
  return { interval, adjust: want, segments: segs.length, rows: items.map(toRow) };
}

/**
 * 分段取批量历史，返回 Map<内部key, 升序去重后的原始 item 数组>。
 * 批量同样受「单次跨度 ≤10 年」约束，超过就切段。
 */
async function segmentedBatchItems(pairs, interval, start, end, adjust) {
  const segs = splitSegments(start, end);
  const acc = new Map();                                  // key -> Map(date -> item)
  for (const [s, e] of segs) {
    const d = await call('/api/a-share/prices/historical-batch', {
      thscodes: pairs.map((p) => p[1]).join(','),
      interval,
      start: String(Math.round(s)),
      end: String(Math.round(e)),
      adjust,
    });
    for (const g of (d && d.item) || []) {
      const k = fromThscode(g.thscode);
      if (!k) continue;
      if (!acc.has(k)) acc.set(k, new Map());
      const m = acc.get(k);
      for (const it of g.item || []) m.set(ymd(it.date_ms), it);
    }
  }
  const out = new Map();
  for (const [k, m] of acc) {
    const rows = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((x) => x[1]);
    if (rows.length) out.set(k, rows);
  }
  return out;
}

/** 批量取「不复权最新收盘」，一次请求最多 10 只，只取尾部 30 天 */
async function batchLastRawClose(pairs, interval, end) {
  const tailStart = Number(end) - 30 * 24 * 3600 * 1000;
  const d = await call('/api/a-share/prices/historical-batch', {
    thscodes: pairs.map((p) => p[1]).join(','),
    interval,
    start: String(Math.round(tailStart)),
    end: String(Math.round(end)),
    adjust: 'none',
  });
  const out = new Map();
  for (const g of (d && d.item) || []) {
    const k = fromThscode(g.thscode);
    const items = g.item || [];
    if (k && items.length) out.set(k, Number(items[items.length - 1].close_price));
  }
  return out;
}

/**
 * 批量历史 K 线（≤10 只）。一次请求内所有代码共用窗口与复权方式。
 * 返回 Map<内部key, rows>；接口明确返回空组的代码进 empty，不静默丢弃。
 * adjust 语义同 historical：forward 走 backward 重建，避免负价。
 */
async function historicalBatch(keys, opt) {
  const o = opt || {};
  const list = Array.from(new Set((keys || []).map(String)));
  if (!list.length) return { rows: new Map(), empty: [], interval: o.interval || '1d' };
  if (list.length > MAX_BATCH) throw new Error(`扶摇批量上限 ${MAX_BATCH} 只，收到 ${list.length} 只`);

  const pairs = list.map((k) => [k, toThscode(k)]).filter((p) => p[1]);
  if (!pairs.length) throw new Error('批量请求里没有可识别的代码');

  const end = o.end != null ? Number(o.end) : Date.now();
  const start = o.start != null ? Number(o.start) : defaultStart(end);
  const interval = o.interval || '1d';
  const want = o.adjust || 'forward';
  const segs = splitSegments(start, end);

  let byKey;
  if (want === 'forward') {
    const [bw, raw] = await Promise.all([
      segmentedBatchItems(pairs, interval, start, end, 'backward'),
      segmentedBatchItems(pairs, interval, start, end, 'none'),
    ]);
    byKey = new Map();
    for (const [k, items] of bw) {
      const rawItems = raw.get(k) || [];
      const rawMap = new Map(rawItems.map((x) => [ymd(x.date_ms), x]));
      const lastDate = ymd(items[items.length - 1].date_ms);
      const tail = rawMap.get(lastDate) || rawItems[rawItems.length - 1];
      const rawLast = tail ? Number(tail.close_price) : 0;
      if (!(rawLast > 0)) {
        log.warn('fuyao.batch_no_raw_tail', { key: k });
        continue;
      }
      try {
        byKey.set(k, rebuildForward(items, rawLast, rawItems));
      } catch (e) {
        // 单只复权基准异常不该拖垮整批，但必须留痕
        log.warn('fuyao.batch_rebuild_failed', { key: k, error: e.message });
      }
    }
  } else {
    byKey = await segmentedBatchItems(pairs, interval, start, end, want);
  }

  const out = new Map();
  const empty = [];
  for (const k of list) {
    const items = byKey.get(k);
    if (!items || !items.length) { empty.push(k); continue; }
    out.set(k, items.map(toRow));
  }
  return { rows: out, empty, interval, adjust: want, segments: segs.length };
}

module.exports = {
  enabled, toThscode, fromThscode, historical, historicalBatch,
  MAX_BATCH, SEG_YEARS, splitSegments, defaultStart, ymd, toRow,
  // 以下仅供单测校验数学性质，业务代码不要直接用
  rebuildForward, segmentedItems, splitSegments,
};
