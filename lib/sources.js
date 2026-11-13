'use strict';
/**
 * 行情数据源适配层
 *
 * 2026-11 起东财（push2his / push2）对所有请求返回空响应（Empty reply），
 * 线上实例同样不可用 —— 单一数据源等于把整个系统押在一个会随时抽风的接口上。
 * 这里把「取数」拆成多家：同花顺 / 新浪 / 腾讯 / 东财，按能力分工并自动降级。
 *
 *   日线K线  ：同花顺（前复权，带成交额与换手率，可分年回溯）→ 新浪（不复权，仅量）
 *   周/月线  ：由日线聚合（三源口径一致，不依赖上游是否支持周月）
 *   实时快照 ：腾讯 qt.gtimg.cn（批量，带量比/涨跌停价）→ 新浪排行
 *   全市场   ：新浪排行接口（5350 只，分页并行）
 *   搜索     ：新浪 suggest → 腾讯 smartbox
 *
 * 所有行统一成 [日期, 开, 收, 高, 低, 成交量(手), 成交额(元)]，与既有前端完全兼容。
 */

const http = require('http');
const https = require('https');
const clean = require('./clean');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/* ---------------- 缓存 ---------------- */
const cache = new Map();
function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(key); return null; }
  return hit.val;
}
function setCached(key, val, ttl) {
  cache.set(key, { val, exp: Date.now() + ttl });
  if (cache.size > 900) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
  }
}

/* ---------------- 上游并发闸门 ---------------- */
let active = 0;
const waiting = [];
// 同花顺/新浪比东财宽松得多，但也不能无限并发（会被限速）
const MAX_CONCURRENT = 9;

async function gate(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

/* ---------------- HTTP ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, opts = {}) {
  const lib = url.startsWith('http://') ? http : https;
  const timeout = opts.timeout || 10000;
  const headers = Object.assign({
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }, opts.headers || {});
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error('upstream ' + res.statusCode), { status: res.statusCode }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return reject(new Error('empty response'));
        let txt;
        if (opts.encoding === 'gbk') {
          try { txt = new TextDecoder('gbk').decode(buf); } catch (e) { txt = buf.toString('latin1'); }
        } else {
          txt = buf.toString('utf8');
        }
        resolve(txt);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function requestRetry(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await gate(() => request(url, opts));
    } catch (e) {
      lastErr = e;
      // 4xx 不必重试
      if (e.status && e.status >= 400 && e.status < 500) break;
      if (i < tries - 1) await sleep(180 + i * 320);
    }
  }
  throw lastErr;
}

const toNum = (v) => {
  if (v === undefined || v === null || v === '' || v === '-' || v === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ================================================================
 * 日线：同花顺（前复权）
 * ================================================================ */

/** 同花顺 symbol：沪深统一 hs_ 前缀；指数只有沪 1A0001 / 深 399001 两个可用，其余走新浪 */
function thsPrefix(it) {
  if (it.asset === 'index') return it.key === 'sh000001' ? 'zs_1A0001' : 'zs_' + it.code;
  return 'hs_' + it.code;
}

/** 20261111 → 2026-11-11 */
const fmtDay = (d) => d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);

function parseThsBody(text) {
  // quotebridge_v6_line_hs_600000_01_last({...})
  const m = text.match(/\((\{[\s\S]*\})\)\s*;?\s*$/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { return null; }
  const rows = [];
  // 字段：日期,开,高,低,收,成交量(股),成交额(元),换手率,...
  for (const line of String(j.data || '').split(';')) {
    if (!line) continue;
    const p = line.split(',');
    if (p.length < 7 || p[0].length !== 8) continue;
    const d = p[0];
    const o = toNum(p[1]), h = toNum(p[2]), l = toNum(p[3]), c = toNum(p[4]);
    if (o == null || h == null || l == null || c == null) continue;
    rows.push({
      d: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      o, c, h, l,
      v: Math.round((toNum(p[5]) || 0) / 100),      // 股 → 手
      a: Math.round(toNum(p[6]) || 0),              // 元
      t: toNum(p[7]),                               // 换手率（%）
    });
  }
  return { name: j.name || '', rows, total: j.total || 0 };
}

async function thsDaily(it, need) {
  const pre = thsPrefix(it);
  const base = 'https://d.10jqka.com.cn/v6/line/' + pre + '/01/';
  const hdr = { Referer: 'http://stockpage.10jqka.com.cn/' };

  // last.js（历史 140 根）与 today.js（当日那一根）互不依赖，并行取，省一个往返。
  // 实测收盘后 19:30 last.js 仍停在 T-1，today.js 已经是当日收盘数据。
  const [lastTxt, todayTxt] = await Promise.all([
    requestRetry(base + 'last.js', { headers: hdr, timeout: 12000 }),
    requestRetry(base + 'today.js', { headers: hdr, timeout: 10000 }, 2).catch(() => null),
  ]);
  const last = parseThsBody(lastTxt);
  if (!last) return null;
  if (!last.rows.length && (!last.total || last.total < 1)) return null;

  const map = new Map();
  for (const r of last.rows) map.set(r.d, r);

  if (todayTxt) {
    try {
      const tm = todayTxt.match(/\{[\s\S]*\}/);
      if (tm) {
        const j = JSON.parse(tm[0]);
        const obj = j[Object.keys(j)[0]] || {};
        const rawDay = String(obj['1'] || '');
        if (/^\d{8}$/.test(rawDay)) {
          const d = fmtDay(rawDay);
          const o = toNum(obj['7']), h = toNum(obj['8']), l = toNum(obj['9']), c = toNum(obj['11']);
          // 未开盘时这几个字段全是 0
          if (o && h && l && c && !map.has(d)) {
            map.set(d, {
              d, o, c, h, l,
              v: Math.round((toNum(obj['13']) || 0) / 100),
              a: Math.round(toNum(obj['19']) || 0),
              t: toNum(obj['1968584']),
            });
          }
        }
      }
    } catch (e) { /* 当日数据取不到不影响历史 */ }
  }

  // last.js 只给最近 140 根，更长的历史按年拉取（每年约 242 个交易日）。
  // 多要一年做冗余：年份文件偶尔会被上游限流，少一年就是少 242 根，
  // 而「金坑」这类含历史统计的流派对根数敏感，缺一根就会算出不同评分。
  // 按同花顺返回的总根数封顶，避免为了 20 年历史去请求一堆不存在的年份文件
  const total = last.total || 3000;
  const needYears = Math.min(
    Math.ceil(Math.max(0, need - last.rows.length) / 242) + 1,
    Math.ceil(total / 242) + 1,
    26
  );
  const nowY = new Date().getFullYear();

  async function pullYear(y) {
    try {
      const txt = await requestRetry(base + y + '.js', { headers: hdr, timeout: 12000 }, 2);
      const g = parseThsBody(txt);
      if (!g) return 0;
      let added = 0;
      for (const r of g.rows) if (!map.has(r.d)) { map.set(r.d, r); added++; }
      return added;
    } catch (e) { return 0; }
  }

  if (needYears > 0) {
    const batch = [];
    // 必须含当年：last.js 只回溯 140 根（约半年），若当年文件不拉，
    // 年初到 last.js 起点之间的那段会整段消失，拼接处看起来像暴跌 20~40%。
    for (let i = 0; i < needYears; i++) batch.push(nowY - i);
    // 年份文件串行拉：每个约 150~250ms，串行 6 年也就多一秒多，
    // 而并发打过去会随机丢一两个年份文件，丢的是整整 242 根 K 线 ——
    // 后者造成的缺口会让所有依赖长周期的指标失真，代价远大于这一秒。
    for (const y of batch) await pullYear(y);
    // 补拉：根数还不够就一年一年往回找（串行，最多再补 4 年）
    let y = nowY - batch.length;
    for (let k = 0; k < 4 && map.size < need && y >= 1991; k++, y--) {
      await pullYear(y);
    }
  }

  /* 缺口自愈：整年缺失通常是年份文件被限流（返回空），补一次即可。
     判定「整年缺失」用相邻日期跨度，不依赖交易日历 —— 跨年且间隔 > 300 天，
     除了数据缺失没有别的解释。补拉必须串行：并发正是上一次丢年的原因。 */
  for (let pass = 0; pass < 3; pass++) {
    const ds = [...map.keys()].sort();
    const miss = new Set();
    for (let i = 1; i < ds.length; i++) {
      const a = ds[i - 1], b = ds[i];
      const ya = +a.slice(0, 4), yb = +b.slice(0, 4);
      if (yb - ya < 1) continue;
      const span = (Date.parse(b) - Date.parse(a)) / 864e5;
      if (span <= 300) continue;
      // a 与 b 之间跨过的每个整年都算缺失
      for (let y = ya + 1; y < yb; y++) miss.add(y);
      // b 所在年度的 1 月若整月无数据，也算缺
      if (b.slice(5, 7) >= '04') miss.add(yb);
    }
    if (!miss.size) break;
    for (const y of miss) {
      await pullYear(y);
      await sleep(120);
    }
  }

  const rows = [...map.values()].sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  return { name: last.name, rows };
}

/* ================================================================
 * 日线：新浪（备用，不复权）
 * ================================================================ */

async function sinaDaily(it, need) {
  const n = Math.min(1500, Math.max(60, need));
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
    + '?symbol=' + it.symbol + '&scale=240&ma=no&datalen=' + n;
  const txt = await requestRetry(url, { timeout: 12000 }, 2);
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr) || !arr.length) return null;
  const rows = arr.map((r) => ({
    d: r.day,
    o: toNum(r.open), c: toNum(r.close), h: toNum(r.high), l: toNum(r.low),
    v: Math.round((toNum(r.volume) || 0) / 100),
    a: 0,   // 新浪日线不给成交额
  })).filter((r) => r.o != null && r.c != null && r.h != null && r.l != null);
  return rows.length ? { name: '', rows } : null;
}

/* ================================================================
 * 周期聚合：日 → 周 / 月
 * ================================================================ */

function weekKey(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  // 归一到周一（getUTCDay: 周日=0）
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

function aggregate(rows, mode) {
  const out = [];
  let cur = null;
  let key = null;
  for (const r of rows) {
    const k = mode === 'month' ? r.d.slice(0, 7) : weekKey(r.d);
    if (k !== key) {
      if (cur) out.push(cur);
      cur = { d: r.d, o: r.o, c: r.c, h: r.h, l: r.l, v: r.v, a: r.a };
      key = k;
    } else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
      cur.v += r.v;
      cur.a += r.a;
      cur.d = r.d;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ================================================================
 * 对外：K 线
 * ================================================================ */

/**
 * @param {object} it normalize 后的标的
 * @param {number} bars 需要的根数
 * @param {string} period day|week|month
 * @returns {Promise<{name, rows:[date,o,c,h,l,vol,amount], source}>}
 */
async function klines(it, bars = 500, period = 'day') {
  // 周/月从日线聚合，需要更长的日线底料
  const need = period === 'week' ? Math.min(2600, bars * 5 + 20)
    : period === 'month' ? Math.min(2600, bars * 22 + 40)
      : Math.min(5000, bars);

  const daily = await getDaily(it, need);

  const rows = period === 'day' ? daily.rows : aggregate(daily.rows, period);
  const tail = rows.slice(Math.max(0, rows.length - Math.min(5000, Math.max(30, bars))));

  // 质量报告只保留落在本次返回区间内的缺口，免得「十五年前缺一年」也弹提示
  const q = daily.quality || {};
  const from = tail.length ? (Array.isArray(tail[0]) ? tail[0][0] : tail[0].d) : null;
  const gapsIn = (q.gaps || []).filter((g) => !from || g.to >= from);
  const jumpsIn = (q.jumps || []).filter((g) => !from || g.d >= from);
  // ok 也要按窗口重算：整段缺口若在返回区间之外（比如二十年前缺一年），
  // 本次这批 K 线是完好的，不该继续判成「不可用」。
  const fatalIn = gapsIn.some((g) => g.kind === 'year' || g.kind === 'block');
  const quality = Object.assign({}, q, {
    gaps: gapsIn,
    jumps: jumpsIn,
    bars: tail.length,
    ok: (!fatalIn && tail.length >= 30) || !!q.newListing,
    period,
  });

  return {
    name: daily.name,
    source: daily.source,
    rows: tail.map((r) => [r.d, r.o, r.c, r.h, r.l, r.v, r.a]),
    // 附带换手率，供个股页顶部指标使用（同花顺独有）
    turnover: period === 'day' ? (daily.turnover || []).slice(-tail.length) : null,
    quality,
  };
}

/* 日线缓存按 symbol 存「能拿到的最长一份」，短周期请求直接复用长的那份，
   避免同一只票被 day/week/month 各拉一遍（详情页原本一次要打 3 倍的上游请求）。 */
const dailyStore = new Map();
const pendingDaily = new Map();

async function fetchDaily(it, need) {
  let src = 'ths';
  let got = null;
  try {
    got = await thsDaily(it, need);
  } catch (e) { got = null; }
  // 同花顺对北交所/部分退市股没有数据，降级新浪（不复权，但没有成交额）
  if (!got || got.rows.length < Math.min(30, need)) {
    try {
      got = await sinaDaily(it, need);
      src = 'sina';
    } catch (e) {
      if (!got) throw Object.assign(new Error('未获取到该代码的行情数据'), { code: 404 });
    }
  }
  if (!got || !got.rows.length) {
    throw Object.assign(new Error('未获取到该代码的行情数据'), { code: 404 });
  }
  // 清洗在唯一入口处做一次：上游解析、多源拼接都可能带进脏行，
  // 下游（指标、形态、精算）一律只认这一份干净数据。
  const c = clean.sanitize(got.rows, { code: it.code, asset: it.asset, period: 'day' });
  // 清洗后的行是对象行 {d,o,c,h,l,v,a}（clean.sanitize 的对外契约），
  // 换手率不在里面，按日期重新对齐一份。取键必须用 r.d —— 用 r[0] 会拿到
  // undefined，整列静默变成 null（曾如此，因 /api/stock 未透出该字段而未显症）。
  const tmap = new Map();
  for (const r of got.rows) if (r.t != null) tmap.set(r.d, r.t);
  const turnover = c.rows.map((r) => (tmap.has(r.d) ? tmap.get(r.d) : null));
  return { name: got.name, rows: c.rows, turnover, quality: c.quality, source: src, asked: need };
}

async function getDaily(it, need) {
  const ttl = isTradingHours() ? 60000 : 600000;
  for (let guard = 0; guard < 4; guard++) {
    const hit = dailyStore.get(it.symbol);
    // rows.length >= need 是理想情况；asked >= need 说明「已经为这个长度尽力拉过」
    // （新股/退市股历史本来就短），此时接受，避免每次请求都重拉一遍
    if (hit && !staleDaily(hit, ttl) && (hit.rows.length >= need || hit.asked >= need)) return hit;

    const p = pendingDaily.get(it.symbol);
    if (p) { await p.catch(() => {}); continue; }   // 等同一只票正在进行的请求

    const task = fetchDaily(it, need);
    pendingDaily.set(it.symbol, task);
    try {
      const v = await task;
      const prevTries = hit ? (hit.tries || 0) : 0;
      const sameDay = hit && hit.rows.length && v.rows.length
        && hit.rows[hit.rows.length - 1].d === v.rows[v.rows.length - 1].d;
      const rec = Object.assign({}, v, {
        ts: Date.now(),
        // 当日数据没取到（上游 today.js 失败）时记一次，避免无限重拉
        tries: sameDay ? 0 : prevTries + 1,
      });
      dailyStore.set(it.symbol, rec);
      return rec;
    } finally {
      pendingDaily.delete(it.symbol);
    }
  }
  const hit = dailyStore.get(it.symbol);
  if (hit) return hit;
  throw Object.assign(new Error('未获取到该代码的行情数据'), { code: 404 });
}

/** 今天（北京时间）的 YYYY-MM-DD */
function todayStr() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 缓存是否已经「过期到需要重取」。
 * 除了 TTL，还要处理一种情况：上游当日数据下载失败，导致最后一根停在 T-1，
 * 这份残缺数据如果按 10 分钟 TTL 缓存，整个缓存期内所有分析都会少一根 K 线。
 * 所以「已开盘 + 最后一根不是今天」时，最多重试 3 次再认命（节假日会命中这里，成本可忽略）。
 */
function staleDaily(hit, ttl) {
  const age = Date.now() - hit.ts;
  if (age >= ttl) return true;
  if (!hit.rows.length) return true;
  if ((hit.tries || 0) >= 3) return false;
  const t = new Date(Date.now() + 8 * 3600e3);
  const wd = t.getUTCDay();
  const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  if (wd === 0 || wd === 6) return false;
  if (hm < 930) return false;
  const last = hit.rows[hit.rows.length - 1].d;
  return last < todayStr() && age > 20000;
}

function isTradingHours() {
  const t = new Date();
  const m = t.getHours() * 60 + t.getMinutes();
  const wd = t.getDay();
  if (wd === 0 || wd === 6) return false;
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
}

/* ================================================================
 * 实时快照：腾讯（批量，带量比）
 * ================================================================ */

function parseTencentLine(line) {
  // v_sh600000="1~浦发银行~600000~10.17~10.20~10.22~485046~..."
  const m = line.match(/^v_([a-z]{2}\d{6})="([\s\S]*)";?$/);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 50) return null;
  const price = toNum(f[3]);
  const prev = toNum(f[4]);
  const fcap = toNum(f[44]);
  const tcap = toNum(f[45]);
  const vol = toNum(f[36]);
  const amtWan = toNum(f[37]);
  return {
    symbol: m[1],
    code: f[2],
    name: f[1],
    price,
    prevClose: prev,
    open: toNum(f[5]),
    high: toNum(f[33]),
    low: toNum(f[34]),
    chg: toNum(f[31]),
    chgPct: toNum(f[32]),
    volume: vol,
    amount: amtWan == null ? null : Math.round(amtWan * 1e4),
    turnover: toNum(f[38]),
    pe: toNum(f[39]),
    amplitude: toNum(f[43]),
    floatCap: fcap == null ? null : Math.round(fcap * 1e8),
    totalCap: tcap == null ? null : Math.round(tcap * 1e8),
    pb: toNum(f[46]),
    upLimit: toNum(f[47]),
    downLimit: toNum(f[48]),
    volRatio: toNum(f[49]),
    floatShares: (fcap && price) ? Math.round(fcap * 1e8 / price) : null,
    totalShares: (tcap && price) ? Math.round(tcap * 1e8 / price) : null,
    time: f[30],
  };
}

async function tencentSnaps(items) {
  const out = {};
  const CHUNK = 50;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const q = slice.map((x) => x.symbol).join(',');
    let txt;
    try {
      txt = await requestRetry('https://qt.gtimg.cn/q=' + q, { encoding: 'gbk', timeout: 9000 }, 2);
    } catch (e) { continue; }
    for (const line of txt.split('\n')) {
      const s = parseTencentLine(line.trim().replace(/;$/, ''));
      if (s && s.price) out[s.symbol] = s;
    }
  }
  return out;
}

/** 腾讯对北交所返回一行 0，识别为无效 */
function tencentValid(s) {
  return s && s.price != null && s.price > 0;
}

/* ================================================================
 * 全市场快照：新浪排行
 * ================================================================ */

const SINA_NODE = {
  all: 'hs_a',
  sh: 'sh_a',
  sz: 'sz_a',
  cyb: 'cyb',
  kcb: 'kcb',
  bj: 'bj_a',
};

/** 上一次拿到的完整快照：上游降级时用来兜底，避免整页只剩几十只 */
const lastGood = new Map();

async function sinaMarketPage(page, num, node) {  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
    + '?page=' + page + '&num=' + num + '&sort=symbol&asc=1&node=' + (node || 'hs_a');
  const txt = await requestRetry(url, { timeout: 12000 }, 2);
  const arr = JSON.parse(txt);
  return Array.isArray(arr) ? arr : [];
}

/**
 * 全市场快照（约 5350 只）。分页并行拉取后合并，缓存 60 秒。
 * @param {string} node hs_a / sh_a / sz_a / cyb / kcb / bj_a
 */
async function marketList(node) {
  const nd = SINA_NODE[node] || 'hs_a';
  const ckey = 'market:' + nd;
  const hit = getCached(ckey);
  if (hit) return hit;

  const NUM = 100;
  const first = await sinaMarketPage(1, NUM, nd);
  if (!first.length) return [];
  const pages = [];
  // 先探到 60 页上限，实际按返回数量判断结束
  for (let p = 2; p <= 60; p++) pages.push(p);

  // 一页失败不代表后面都失败（并行返回顺序与页码一致，直接 break 会把后半市场整段丢掉）。
  // 分小批并行，既压住上游并发，也避免一次 60 个请求触发限流。
  let raw = first.slice();
  for (let i = 0; i < pages.length; i += 12) {
    const slice = pages.slice(i, i + 12);
    const arrs = await Promise.all(slice.map((p) => sinaMarketPage(p, NUM, nd).catch(() => [])));
    for (const arr of arrs) if (arr.length) raw = raw.concat(arr);
  }

  const out = raw.map((r) => {
    const trade = toNum(r.trade);
    const nmc = toNum(r.nmc);          // 流通市值（万元）
    const high = toNum(r.high);
    const low = toNum(r.low);
    const prev = toNum(r.settlement);
    // 盘前（9:00 之后、集合竞价成交前）新浪把 trade 清零，
    // 如果直接用 trade 过滤，整个市场会被判定成「无成交」只剩个位数几只，
    // 选股页看起来像数据源挂了 —— 这里回退到昨收价，并标记尚未成交。
    const price = trade && trade > 0 ? trade : prev;
    return {
      code: r.code,
      symbol: r.symbol,
      name: r.name,
      price,
      noTrade: !(trade && trade > 0),
      chgPct: toNum(r.changepercent),
      open: toNum(r.open),
      high,
      low,
      prevClose: prev,
      volume: Math.round((toNum(r.volume) || 0) / 100),      // 股 → 手
      amount: toNum(r.amount),
      turnover: toNum(r.turnoverratio),
      pe: toNum(r.per),
      pb: toNum(r.pb),
      floatCap: nmc == null ? null : Math.round(nmc * 1e4),
      amplitude: (high != null && low != null && prev) ? +(((high - low) / prev) * 100).toFixed(2) : null,
    };
  }).filter((x) => x.code && /^\d{6}$/.test(x.code) && x.price > 0);   // 停牌/无成交的票不进候选池

  // 去重（分页期间排序微调可能导致重复）
  const uniq = new Map();
  for (const x of out) if (!uniq.has(x.code)) uniq.set(x.code, x);
  const list = [...uniq.values()];

  // 上游偶发降级（限流时只回几页）：宁可沿用上一次完整快照，也不要让选股页只剩几十只。
  // 代价是价格旧几分钟，但列表结构完整，且下一次刷新会自动恢复。
  const prev = lastGood.get(ckey);
  if (list.length < 500 && prev && prev.length > list.length) {
    setCached(ckey, prev, 30000);
    return prev;
  }
  if (list.length >= 500) lastGood.set(ckey, list);

  setCached(ckey, list, isTradingHours() ? 60000 : 300000);
  return list;
}

/* ================================================================
 * 搜索
 * ================================================================ */

async function sinaSuggest(q) {
  const url = 'https://suggest3.sinajs.cn/suggest/type=11,12,15&key=' + encodeURIComponent(q);
  const txt = await requestRetry(url, { encoding: 'gbk', headers: { Referer: 'https://finance.sina.com.cn/' }, timeout: 8000 }, 2);
  const m = txt.match(/var suggestvalue="([\s\S]*)"/);
  if (!m) return [];
  const out = [];
  for (const row of m[1].split(';')) {
    if (!row) continue;
    const f = row.split(',');
    if (f.length < 5) continue;
    const sym = f[3];               // sh600986 / sz000001 / sh000001
    if (!/^[a-z]{2}\d{6}$/.test(sym)) continue;
    out.push({
      name: f[4] || f[0],
      symbol: sym,
      code: f[2],
      type: f[1],
    });
  }
  return out;
}

/* ================================================================
 * 探测：各源健康状况（选股页会展示数据来源与时间）
 * ================================================================ */

const health = {
  ths: { ok: null, at: 0, err: '' },
  sina: { ok: null, at: 0, err: '' },
  tencent: { ok: null, at: 0, err: '' },
  em: { ok: null, at: 0, err: '' },
};

async function probe() {
  const tasks = [
    probeOne('ths', 'https://d.10jqka.com.cn/v6/line/hs_600000/01/last.js', { Referer: 'http://stockpage.10jqka.com.cn/' }),
    probeOne('sina', 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=2'),
    probeOne('tencent', 'https://qt.gtimg.cn/q=sh600000', { encoding: 'gbk' }),
    probeOne('em', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&klt=101&fqt=1&lmt=1&fields1=f1&fields2=f51,f53'),
  ];
  await Promise.all(tasks);
  return health;
}

async function probeOne(name, url, opts) {
  const t0 = Date.now();
  try {
    const txt = await request(url, Object.assign({ timeout: 5000 }, opts || {}));
    // 东财挂了也返回 200，只是内容为空 —— 用「有没有实际数据」判断
    health[name] = { ok: txt.length > 30, at: Date.now(), ms: Date.now() - t0, err: txt.length > 30 ? '' : 'empty' };
  } catch (e) {
    health[name] = { ok: false, at: Date.now(), ms: Date.now() - t0, err: e.message };
  }
}

module.exports = {
  klines, marketList, tencentSnaps, sinaSuggest, probe, health,
  aggregate, request, requestRetry, getCached, setCached, toNum, isTradingHours,
};
