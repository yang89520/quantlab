'use strict';
/**
 * QuantLab 服务端
 *  - /api/*  行情与分析数据
 *  - 静态前端
 */

const path = require('path');
const zlib = require('zlib');
const express = require('express');
const Q = require('./lib/quote');
const store = require('./lib/store');
const scan = require('./lib/scan');
const shapeLib = require('./public/js/shape');
const config = require('./lib/config');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

/**
 * gzip：全市场快照一个响应就有 1.7MB（5000 只 × 15 字段），
 * 不压缩在移动网络上要等好几秒。这里只压 JSON，且小响应不动。
 */
app.use((req, res, next) => {
  if (!/gzip/.test(req.headers['accept-encoding'] || '')) return next();
  const rawJson = res.json.bind(res);
  res.json = (obj) => {
    const buf = Buffer.from(JSON.stringify(obj));
    if (buf.length < 2048) return rawJson(obj);
    let gz;
    try { gz = zlib.gzipSync(buf, { level: 6 }); } catch (e) { return rawJson(obj); }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', gz.length);
    res.end(gz);
    return res;
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders(res, p) {
    if (/\.(js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

/* ---------------- 统一响应 ---------------- */
// DuckDB 的 COUNT / TIMESTAMP 这类列会以 BigInt 返回，而 Express 的 res.json 内部是裸
// JSON.stringify —— 碰到 BigInt 直接抛 "Do not know how to serialize a BigInt"，
// 接口变成 500 且看不出原因（health 就这么挂过一次）。在响应层统一兜住，不要每个接口各写一遍。
function bigintReplacer(k, v) {
  if (typeof v !== 'bigint') return v;
  return v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : v.toString();
}
const ok = (res, data) => res.type('application/json').send(
  JSON.stringify({ ok: true, data }, bigintReplacer),
);
function fail(res, e) {
  const code = e && e.code && Number.isInteger(e.code) ? e.code : 500;
  if (code >= 500) console.error('[api]', e);
  res.status(code).json({ ok: false, error: (e && e.message) || '服务器内部错误' });
}

/* ---------------- 行情 ---------------- */

// 单只标的：K 线 + 快照（个股与指数同一接口，用 asset 区分）
app.get('/api/stock/:code', async (req, res) => {
  try {
    const it = Q.normalize(req.params.code);
    if (!it) return res.status(400).json({ ok: false, error: '代码格式不正确' });
    const isIndex = it.asset === 'index';
    // 「全部」按标的类型给到各自可得的历史长度：指数 5000 根（约 20 年），个股 1500 根
    const isAll = req.query.all === '1';
    const bars = isAll
      ? (isIndex ? 5000 : 1500)
      : Math.min(1500, Math.max(80, parseInt(req.query.bars, 10) || 500));
    // 基准：个股比上证；指数比沪深300（看沪深300本身时退回上证），
    // 这样「创业板指 vs 沪深300」这类相对强弱才有意义。
    const benchCode = isIndex ? (it.code === '000300' ? 'sh000001' : 'sh000300') : 'sh000001';
    // 月线需要 2600 根日线，先把它拉满，后面 day/week 直接命中同一份日线缓存
    // （否则 day/week/month 会各自向上游要一遍，首次打开要慢 3 倍）
    const month = await Q.klines(it.key, 130, 'month').catch(() => null);
    const [k, snaps, week, bench] = await Promise.all([
      // 必须用 it.key（指数带市场前缀）：裸 6 位会在 normalize 里被当成深市个股
      Q.klines(it.key, bars),
      Q.snapshots([it.key]).catch(() => ({})),
      // 周线：多周期共振与周线 KD 用，取 5 年
      Q.klines(it.key, 260, 'week').catch(() => null),
      // 基准：多取一些，保证周/月线也能完整对齐
      Q.klines(benchCode, 1500).catch(() => null),
    ]);
    const snap = snaps[it.key] || snaps[it.code] || null;
    ok(res, {
      code: it.key,
      name: (snap && snap.name) || k.name,
      market: it.market,
      asset: it.asset,
      isIndex,
      display: it.display,
      bars: k.rows.length,
      klines: k.rows,
      week: week ? week.rows : null,
      month: month ? month.rows : null,
      bench: bench ? bench.rows : null,
      benchName: bench ? bench.name : null,
      snapshot: snap,
      quality: k.quality || null,
      floatShares: (snap && snap.floatShares) || null,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) { fail(res, e); }
});

// 主要指数行情（侧栏指数条用）
app.get('/api/indices', async (req, res) => {
  try {
    const codes = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    const list = codes.length
      ? codes.map(Q.normalize).filter((x) => x && x.asset === 'index')
        .map((x) => ({ key: x.key, name: x.display, short: x.code }))
      : Q.INDEX_LIST;
    let snaps = {};
    try { snaps = await Q.snapshots(list.map((x) => x.key)); } catch (e) { snaps = {}; }
    ok(res, list.map((x) => {
      const s = snaps[x.key] || {};
      return {
        code: x.key,
        name: s.name || x.name,
        short: x.short,
        price: s.price == null ? null : s.price,
        chg: s.chg == null ? null : s.chg,
        chgPct: s.chgPct == null ? null : s.chgPct,
        amount: s.amount == null ? null : s.amount,
      };
    }));
  } catch (e) { fail(res, e); }
});

// 批量快照（自选股列表用）
app.get('/api/snapshot', async (req, res) => {
  try {
    const codes = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!codes.length) return ok(res, {});
    ok(res, await Q.snapshots(codes));
  } catch (e) { fail(res, e); }
});

// 搜索
app.get('/api/search', async (req, res) => {
  try {
    ok(res, await Q.search(req.query.q || ''));
  } catch (e) { fail(res, e); }
});

/* ---------------- 自选股 / 分组 ---------------- */

// 完整列表：分组 + 股票 + 实时行情，一次拉全
app.get('/api/watchlist', async (req, res) => {
  try {
    const groups = store.listGroups();
    const items = store.listItems();
    let snaps = {};
    if (items.length) {
      try { snaps = await Q.snapshots(items.map((x) => x.code)); } catch (e) { snaps = {}; }
    }
    const view = groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: !!g.collapsed,
      items: items.filter((it) => it.groupId === g.id).map((it) => {
        const s = snaps[it.code] || {};
        const isIdx = it.asset === 'index' || /^(sh|sz|bj)\d{6}$/.test(it.code);
        return {
          code: it.code,
          name: s.name || it.name,
          market: it.market,
          asset: isIdx ? 'index' : 'stock',
          price: s.price == null ? null : s.price,
          chgPct: s.chgPct == null ? null : s.chgPct,
          chg: s.chg == null ? null : s.chg,
          amount: s.amount == null ? null : s.amount,
          turnover: s.turnover == null ? null : s.turnover,
          groupId: it.groupId,
          addedAt: it.addedAt,
        };
      }),
    }));
    ok(res, { groups: view, total: items.length });
  } catch (e) { fail(res, e); }
});

app.post('/api/groups', (req, res) => {
  try { ok(res, store.addGroup(req.body && req.body.name)); } catch (e) { fail(res, e); }
});

app.patch('/api/groups/:id', (req, res) => {
  try { ok(res, store.renameGroup(req.params.id, req.body && req.body.name)); } catch (e) { fail(res, e); }
});

app.delete('/api/groups/:id', (req, res) => {
  try { ok(res, store.removeGroup(req.params.id, req.query.moveTo)); } catch (e) { fail(res, e); }
});

app.put('/api/groups/order', (req, res) => {
  try { ok(res, store.reorderGroups(req.body && req.body.ids)); } catch (e) { fail(res, e); }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const body = req.body || {};
    const it = Q.normalize(body.code);
    if (!it) return res.status(400).json({ ok: false, error: '代码格式不正确' });
    // 名称缺失时补全
    let name = body.name;
    if (!name) {
      try {
        const s = await Q.snapshots([it.key]);
        name = (s[it.key] && s[it.key].name) || it.display;
      } catch (e) { name = it.display; }
    }
    const saved = store.addItem({ code: it.key, name, market: it.market, groupId: body.groupId, asset: it.asset });
    ok(res, saved);
  } catch (e) { fail(res, e); }
});

app.patch('/api/watchlist/:code', (req, res) => {
  try { ok(res, store.updateItem(req.params.code, req.body || {})); } catch (e) { fail(res, e); }
});

app.delete('/api/watchlist/:code', (req, res) => {
  try { ok(res, store.removeItem(req.params.code)); } catch (e) { fail(res, e); }
});

app.put('/api/watchlist/order', (req, res) => {
  try {
    const { groupId, codes } = req.body || {};
    ok(res, store.reorderItems(groupId, codes));
  } catch (e) { fail(res, e); }
});

/* ---------------- 选股 ---------------- */

/**
 * 全市场快照（真实行情，非模拟）。
 * 数据源：新浪排行接口，约 5350 只 A 股，服务端缓存（盘中 60s / 收盘后 5min）。
 * 只返回选股真正会用到的字段，控制响应体积。
 */
app.get('/api/screen/market', async (req, res) => {
  try {
    const node = String(req.query.node || 'all');
    const list = await Q.marketList(node);
    ok(res, {
      node,
      total: list.length,
      updatedAt: new Date().toISOString(),
      trading: Q.sources.isTradingHours(),
      source: 'sina-quote',
      list,
    });
  } catch (e) { fail(res, e); }
});

/**
 * 批量 K 线（候选池精算用）。
 * 每只走服务端已有的多源适配 + 缓存，前端不直接打上游。
 * 上限 300 只：再多人也看不过来，且会造成上游限速。
 */
app.post('/api/screen/klines', async (req, res) => {
  try {
    const body = req.body || {};
    const codes = (Array.isArray(body.codes) ? body.codes : [])
      .map((c) => String(c || '').trim())
      .filter((c) => /^(sh|sz|bj)?\d{6}$/.test(c))
      .slice(0, 300);
    if (!codes.length) return res.status(400).json({ ok: false, error: '缺少 codes' });
    const bars = Math.min(1500, Math.max(120, parseInt(body.bars, 10) || 1200));

    // 基准只取一次，所有标的共用（相对强弱 / 大盘环境判断）
    const bench = await Q.klines('sh000001', 1500).catch(() => null);

    const out = {};
    const CONC = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < codes.length) {
        const i = cursor++;
        const code = codes[i];
        try {
          // 与详情页完全相同的装载顺序：先把月线所需的 2600 根日线拉满，
          // 再取日线 / 周线（命中同一份缓存）。评分口径因此与详情页严格一致。
          const month = await Q.klines(code, 130, 'month');
          const [k, week, snaps] = await Promise.all([
            Q.klines(code, bars),
            Q.klines(code, 260, 'week').catch(() => null),
            Q.snapshots([code]).catch(() => ({})),
          ]);
          const snap = snaps[Q.normalize(code).key] || null;
          out[code] = {
            code,
            name: (snap && snap.name) || k.name,
            isIndex: k.asset === 'index',
            floatShares: (snap && snap.floatShares) || null,
            klines: k.rows,
            week: week ? week.rows : null,
            month: month ? month.rows : null,
            quality: k.quality || null,
            snapshot: snap,
          };
        } catch (e) {
          out[code] = { code, error: e.message };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, codes.length) }, worker));

    ok(res, {
      bars,
      bench: bench ? bench.rows : null,
      benchName: bench ? bench.name : null,
      data: out,
      fetched: Object.keys(out).filter((c) => out[c].klines).length,
    });
  } catch (e) { fail(res, e); }
});

/**
 * 形态覆盖率：前端打开页面时先问一句「服务端今天已经扫过多少」。
 * 服务端当天已经扫满时，前端可以直接静默把结果取回来（几十个请求、一两秒），
 * 不必让用户干等一轮重扫；没扫过就显示「未扫描」，由用户决定什么时候扫。
 */
app.get('/api/screen/shape/coverage', async (req, res) => {
  try {
    const pool = String(req.query.pool || 'main');
    const list = await Q.marketList('all');
    const codes = list.filter((x) => shapeLib.inPool(x.code, pool)).map((x) => x.code);
    const c = scan.coverage(codes);
    ok(res, Object.assign({ pool }, c));
  } catch (e) { fail(res, e); }
});

/**
 * 全池形态扫描（覆盖整块主板，不只 TopN）。
 * 每只只取 260 根日线即可判定形态（指标全用尾部窗口），结果当天落盘复用。
 * 前端按 120 只一批循环调用，进度条按批次推进；单批控制在数秒内，
 * 避免整轮扫描压在一个长请求上被网关掐断。
 */
app.post('/api/screen/shape', async (req, res) => {
  try {
    const body = req.body || {};
    const codes = (Array.isArray(body.codes) ? body.codes : [])
      .map((c) => String(c || '').trim())
      .filter((c) => /^\d{6}$/.test(c))
      .slice(0, 200);
    if (!codes.length) return res.status(400).json({ ok: false, error: '缺少 codes' });
    const r = await scan.scan(codes, { force: !!body.force });
    ok(res, {
      total: codes.length,
      scanned: r.scanned,
      cached: r.cached,
      failed: r.failed,
      data: r.data,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) { fail(res, e); }
});

// 数据源健康度（选股页顶部展示「数据来自哪里、是否实时」，不含任何模拟数据）
app.get('/api/screen/meta', async (req, res) => {
  try {    const h = await Q.probe();
    ok(res, {
      trading: Q.sources.isTradingHours(),
      now: new Date().toISOString(),
      sources: h,
    });
  } catch (e) { fail(res, e); }
});

/* ---------------- 兜底 ---------------- */
/* ============================================================
   一期闭环 API（docs/dev/03 §5）
   ============================================================ */
const storeDao = require('./lib/dao');
const judgment = require('./lib/judgment');
const ds = require('./lib/datasource');
const snapLib = require('./lib/snapshot');
const pkg = require('./package.json');

/** 最近一张预判卡（含对账结果） */
app.get('/api/predict/today', async (req, res) => {
  try {
    const st = await storeDao.open({ readOnly: true });
    const rows = await st.query('prediction', { order: 'date', desc: true, limit: 1 });
    if (!rows.length) return ok(res, null);
    ok(res, rows[0].payload);
  } catch (e) { fail(res, e); }
});

/** 预判卡列表（精简字段，不含 payload） */
app.get('/api/predict/list', async (req, res) => {
  try {
    const st = await storeDao.open({ readOnly: true });
    const preds = await st.query('prediction', { order: 'date', desc: true, limit: 200 });
    const recs = await st.query('reconcile', { order: 'date', desc: true, limit: 200 });
    const byDate = new Map(recs.map((r) => [r.date, r]));
    const from = req.query.from, to = req.query.to;
    const list = preds
      .filter((p) => (!from || p.date >= from) && (!to || p.date <= to))
      .map((p) => {
        const r = byDate.get(p.date);
        return {
          date: p.date,
          targetDate: (p.payload && p.payload.targetDate) || p.target_date,
          verdict: p.verdict,
          score: p.score,
          dataComplete: p.data_complete,
          reconciled: !!r && !r.skipped,
          attribution: r ? r.attribution : null,
          judgmentScore: r ? r.judgment_score : null,
        };
      });
    ok(res, { total: list.length, list });
  } catch (e) { fail(res, e); }
});

/** 指定日期的预判卡（必须放在 /list 之后，否则 'list' 会被当成日期） */
app.get('/api/predict/:date', async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
    }
    const st = await storeDao.open({ readOnly: true });
    const rows = await st.query('prediction', { where: { date: req.params.date } });
    ok(res, rows.length ? rows[0].payload : null);
  } catch (e) { fail(res, e); }
});

/** 判断力画像 */
app.get('/api/judgment/stats', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 20));
    const to = ds.todayStr();
    const from = new Date(new Date(to + 'T00:00:00').getTime() - days * 86400000);
    const p2 = (n) => String(n).padStart(2, '0');
    const fromStr = `${from.getFullYear()}-${p2(from.getMonth() + 1)}-${p2(from.getDate())}`;
    ok(res, await judgment.stats({ from: fromStr, to }));
  } catch (e) { fail(res, e); }
});

/** 某个交易日的快照概要（宽度/涨停数） */
app.get('/api/snapshot/summary', async (req, res) => {
  try {
    const date = req.query.date || (await ds.latestTradingDay()).date;
    const s = await snapLib.readSummary(date);
    if (!s) return ok(res, null);
    ok(res, {
      date: s.date, count: s.count, valid: s.valid,
      breadth: s.breadth, strongRatioProxy: s.strongRatioProxy, ztCount: s.ztCount,
    });
  } catch (e) { fail(res, e); }
});

/* ============================================================
   二期闭环 API（docs/dev/04 §5）：板块强度 + 观察池
   ============================================================ */
const sectordata = require('./lib/sectordata');
const watchpool = require('./lib/watchpool');
const sourceHub = require('./lib/sources/index.js');

const FOOTNOTE = '历史强度基于当前成分回算，长周期仅供参考（幸存者偏差）';

/**
 * 板块榜该取哪一天。
 *
 * 只写 `q || latestTradingDay().date` 是不够的：交易日 15:00 前（daily-close 还没跑）
 * `latestTradingDay()` 返回的是「今天」，而今天没有强度数据 —— 板块页会整页
 * 「未找到该板块」，② 主线点进去也是空的（实测 11-16 上午如此）。
 *
 * 因此：显式传日期就照用；不传则「先今天，取不到退到库内最新一天」，
 * 并把 stale 标出来 —— 是旧数据就说旧数据，绝不冒充当日（D3）。
 */
async function resolveSectorDate(q) {
  if (q) return { date: q, stale: false, askedFor: q };
  const today = (await ds.latestTradingDay()).date;
  const rows = await sectordata.readStrength(today, null, { readOnly: true });
  if (rows.length) return { date: today, stale: false, askedFor: today };
  const latest = await sectordata.latestStrengthDate({ readOnly: true });
  if (latest) return { date: latest, stale: latest !== today, askedFor: today };
  return { date: today, stale: false, askedFor: today };
}

/** 板块强度榜：行业/概念分两张榜返回，绝不混排 */
app.get('/api/sector/strength', async (req, res) => {
  try {
    const { date, stale, askedFor } = await resolveSectorDate(req.query.date);
    const t = req.query.type;
    const type = (t === 'industry' || t === 'concept') ? t : null;
    const rows = await sectordata.readStrength(date, type, { readOnly: true });
    ok(res, {
      date, type: type || 'all', total: rows.length, footnote: FOOTNOTE,
      // stale=true 表示「今天还没跑，给的是库内最新一天」；前端据此标「非当日」
      stale, askedFor,
      industry: rows.filter((r) => r.type === 'industry'),
      concept: rows.filter((r) => r.type === 'concept'),
      degradedCount: rows.filter((r) => r.degraded).length,
    });
  } catch (e) { fail(res, e); }
});

/** 板块强度历史（看轮动） */
app.get('/api/sector/history', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(120, Number(req.query.days) || 20));
    const rows = await sectordata.readHistory(days, { readOnly: true });
    ok(res, { days, total: rows.length, footnote: FOOTNOTE, rows });
  } catch (e) { fail(res, e); }
});

/** 单板块详情：因子拆解 + 当日成分（成分来自落盘，不是现场抓的） */
app.get('/api/sector/:code', async (req, res) => {
  try {
    const { date, stale, askedFor } = await resolveSectorDate(req.query.date);
    const rows = await sectordata.readStrength(date, null, { readOnly: true });
    const one = rows.find((r) => r.sector === req.params.code);
    if (!one) return ok(res, null);
    const st = await storeDao.open({ readOnly: true });
    const members = await st.query('sector_member', {
      where: { date, sector: req.params.code }, order: 'code', limit: 1000,
    });
    ok(res, Object.assign({}, one, {
      date, stale, askedFor,
      members: members.map((m) => m.code),
      memberCount: members.length,
      footnote: FOOTNOTE,
    }));
  } catch (e) { fail(res, e); }
});

/** 观察池全量，按 state 分组 */
app.get('/api/watchpool', async (req, res) => {
  try {
    const all = watchpool.list();
    const groups = {};
    for (const s of watchpool.STATES) groups[s] = [];
    for (const e of all) (groups[e.state] || (groups[e.state] = [])).push(e);
    ok(res, {
      total: all.length,
      maxSize: config.watchpool.maxSize,
      groups,
      list: all,
      reasons: watchpool.REASON_CN,
    });
  } catch (e) { fail(res, e); }
});

/** 迁移历史（放在 /:code 路由之前，避免被当成 code） */
app.get('/api/watchpool/transitions', async (req, res) => {
  try {
    const code = req.query.code || null;
    const date = req.query.date ? String(req.query.date).slice(0, 10) : null;
    let list = watchpool.transitions(code);
    // date 过滤按 id 里的交易日（tr_YYYYMMDD_...），不受 cron 时区影响
    if (date) list = list.filter((t) => String(t.id || '').slice(3, 11) === date.replace(/-/g, ''));
    ok(res, { code, date, list });
  } catch (e) { fail(res, e); }
});

/** 持仓风险扫描（06 §2.3 ⑤：只报事实，不设失效条件） */
app.get('/api/watchpool/risk', async (req, res) => {
  try {
    const date = req.query.date
      ? String(req.query.date).slice(0, 10)
      : (await ds.latestTradingDay()).date;
    const r = await watchpool.riskScan({ date });
    let prev = null;
    try {
      prev = await watchpool.prevRisk(date);
    } catch (e) {
      log.warn('watchpool.prev_risk_failed', { error: e.message });
    }
    ok(res, Object.assign({}, r, { prev: prev ? { date: prev.date, ...prev.v } : null }));
  } catch (e) { fail(res, e); }
});

/** 入池：板块档位由后端查当日榜单判定，不信前端传值 */
app.post('/api/watchpool', async (req, res) => {
  try {
    const b = req.body || {};
    const date = b.date || (await ds.latestTradingDay()).date;
    let sector = b.sector || null;
    let grade = null;
    let candidates = [];
    if (sector) {
      const rows = await sectordata.readStrength(date, null, { readOnly: true });
      const s = rows.find((r) => r.sector === sector);
      grade = s ? s.grade : null;
    } else if (b.code) {
      // 前端没指定板块 → 后端按当日成分反查，取档位最强的那个
      candidates = await sectordata.sectorsOfCode(date, b.code);
      if (candidates.length) {
        sector = candidates[0].sector;
        grade = candidates[0].grade;
      }
    }
    if (!sector) {
      return res.status(400).json({
        ok: false,
        error: `未找到 ${b.code || ''} 当日所属板块（成分数据缺失），无法判定 A/B 档，拒绝入池`,
      });
    }
    const entry = await watchpool.add({
      code: b.code, name: b.name, sector, grade,
      score: b.score, entryReason: b.entryReason, date,
    });
    ok(res, Object.assign({}, entry, { sectorCandidates: candidates.slice(0, 3) }));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 改状态 / 加备注 */
app.patch('/api/watchpool/:code', async (req, res) => {
  try {
    const b = req.body || {};
    const e = await watchpool.update(req.params.code, {
      note: b.note, state: b.state, date: b.date,
    });
    ok(res, e);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 移出：reason 必填且必须是四选一，跳过直接 400 */
app.delete('/api/watchpool/:code', async (req, res) => {
  try {
    const b = req.body || {};
    const e = await watchpool.remove(req.params.code, b.reason, {
      date: b.date, chg: b.chg, wrongDetail: b.wrongDetail,
    });
    ok(res, e);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ============================================================
   页面用配置投影（阈值来自 config.json，前端不许写死数字）
   ============================================================ */
app.get('/api/ui/config', (req, res) => {
  try {
    const ui = config.ui || {};
    const strip = (o) => {
      const out = {};
      for (const [k, v] of Object.entries(o || {})) if (!k.startsWith('_')) out[k] = v;
      return out;
    };
    ok(res, {
      timing: strip(ui.timing),
      candidate: strip(ui.candidate),
      risk: strip(ui.risk),
      watchpool: {
        maxSize: config.watchpool.maxSize,
        minScore: config.watchpool.minScore,
        maxStay: config.watchpool.maxStay,
      },
      gates: { trackDays: config.gates.trackDays },
    });
  } catch (e) { fail(res, e); }
});

/* ============================================================
   三期实验室 API（docs/dev/05 §8）
   ============================================================ */
const lab = require('./lib/lab');
const strategies = require('./lib/strategy');
const track = require('./lib/track');
const py = require('./lib/pyrunner');
const gatesLib = require('./lib/gates');

/** 解析公式输出线（必须手选，不自动猜） */
app.post('/api/lab/formula/lines', async (req, res) => {
  try { ok(res, await lab.lines((req.body || {}).formula || '')); }
  catch (e) { fail(res, e); }
});

/** 未来函数静态扫描；level=high 时前端必须禁用保存 */
app.post('/api/lab/formula/scan', async (req, res) => {
  try { ok(res, await lab.scan((req.body || {}).formula || '')); }
  catch (e) { fail(res, e); }
});

/** 单次回测（真实 K 线） */
app.post('/api/lab/backtest', async (req, res) => {
  try { ok(res, await lab.backtest(req.body || {})); }
  catch (e) { fail(res, e); }
});

/** 跑五道闸：耗时任务，立即返回 taskId */
app.post('/api/lab/gates', async (req, res) => {
  try {
    const id = (req.body || {}).strategyId;
    if (!id || !strategies.get(id)) return res.status(400).json({ ok: false, error: '策略不存在' });
    const taskId = await lab.startGates(id);
    ok(res, { taskId, status: 'pending' });
  } catch (e) { fail(res, e); }
});

/** 轮询闸结果 */
app.get('/api/lab/gates/:taskId', async (req, res) => {
  try {
    const t = lab.getTask(req.params.taskId);
    if (!t) return res.status(404).json({ ok: false, error: '任务不存在' });
    ok(res, {
      taskId: t.id, status: t.status, progress: t.progress,
      result: t.result, error: t.error, createdAt: t.createdAt,
    });
  } catch (e) { fail(res, e); }
});

/** 策略列表（附该版本最近一次五道闸结论） */
app.get('/api/lab/strategies', async (req, res) => {
  try {
    const st = await storeDao.open({ readOnly: true });
    const gr = await st.query('strategy_gate', { order: 'date', desc: true, limit: 1000 });
    const byKey = new Map();
    for (const g of gr) {
      const k = `${g.strategy_id}@${g.version}`;
      if (!byKey.has(k)) {
        byKey.set(k, {
          verdict: g.verdict, date: g.date,
          gates: (g.payload && g.payload.gates) || null,
        });
      }
    }
    const list = strategies.list().map((s) => Object.assign({}, s, {
      gate: byKey.get(`${s.id}@${s.version}`) || null,
    }));
    ok(res, { total: list.length, list });
  } catch (e) { fail(res, e); }
});

/** 新建/更新策略；含高危未来函数直接 400 拒绝 */
app.post('/api/lab/strategies', async (req, res) => {
  try {
    const b = req.body || {};
    const sc = await lab.scan(b.source || '');
    if (sc.level === 'high') {
      return res.status(400).json({
        ok: false, error: '含未来函数，禁止保存', findings: sc.findings,
      });
    }
    const s = await strategies.save(Object.assign({}, b, { scanLevel: sc.level }));
    ok(res, s);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 某日信号 */
app.get('/api/lab/signals', async (req, res) => {
  try {
    const date = req.query.date || (await ds.latestTradingDay()).date;
    ok(res, { date, list: await track.listSignals(date, { readOnly: true }) });
  } catch (e) { fail(res, e); }
});

/** 跟踪曲线：实盘 vs 回测 */
app.get('/api/lab/track', async (req, res) => {
  try {
    const id = req.query.strategyId;
    if (!id) return res.status(400).json({ ok: false, error: 'strategyId 必填' });
    const w = await track.winRate(id, { readOnly: true });
    const s = strategies.get(id);
    ok(res, {
      strategyId: id,
      list: await track.listByStrategy(id, { readOnly: true }),
      liveWinRate: w.liveWinRate,
      sample: w.sample,
      backtestWinRate: s && s.params && s.params.backtestWinRate != null ? s.params.backtestWinRate : null,
      degraded: !!s && s.status === 'suspect',
    });
  } catch (e) { fail(res, e); }
});

let _pyCache = { at: 0, value: null };
async function pythonHealth() {
  if (_pyCache.value && Date.now() - _pyCache.at < 5 * 60 * 1000) return _pyCache.value;
  const v = await py.probePython();
  _pyCache = { at: Date.now(), value: v };
  return v;
}

/** 健康检查：数据源 + 存储 + 待对账数 + 资产健康/熔断 + Python 环境 */
app.get('/api/health', async (req, res) => {
  try {
    const storeInfo = await storeDao.info({ readOnly: true });
    const dsHealth = await ds.health();
    let pending = 0;
    // 最近一次预判：cron 漏跑时这里会停在旧日期，比 pendingReconcile 更早暴露问题（03 §8）
    let lastPrediction = null;
    try {
      const st = await storeDao.open({ readOnly: true });
      const preds = await st.query('prediction', { order: 'date', desc: true, limit: 30 });
      const recs = await st.query('reconcile', { order: 'date', desc: true, limit: 30 });
      const done = new Set(recs.map((r) => r.date));
      pending = preds.filter((p) => !done.has(p.date)).length;
      if (preds.length) {
        const p = preds[0];
        // DuckDB 的 TIMESTAMP 不是 JS Date（是 { micros: BigInt } 这类对象），
        // 直接透传会让前端拿到 {"micros":...}，这里统一折成 ISO 字符串。
        const plain = (v) => {
          if (v === null || v === undefined) return null;
          if (typeof v === 'bigint') return Number(v);
          if (v instanceof Date) return v.toISOString();
          if (typeof v === 'object' && typeof v.micros === 'bigint') {
            return new Date(Number(v.micros / 1000n)).toISOString();
          }
          if (typeof v === 'object' && typeof v.micros === 'number') {
            return new Date(v.micros / 1000).toISOString();
          }
          return v;
        };
        lastPrediction = {
          date: plain(p.date),
          targetDate: plain(p.target_date !== undefined ? p.target_date : p.targetDate),
          verdict: plain(p.verdict),
          score: plain(p.score),
          dataComplete: p.data_complete === undefined ? null : !!p.data_complete,
          createdAt: plain(p.created_at !== undefined ? p.created_at : p.createdAt),
        };
      }
    } catch (e) {
      // 读不到就报 null，不编 0（D1）
      log.warn('health.pending_reconcile_failed', { error: e.message });
      pending = null;
      lastPrediction = null;
    }

    ok(res, {
      version: pkg.version,
      storage: storeInfo,
      // 上游库健康 + 板块资产注册表健康/熔断（10 §4.3），tripped 非空时前端要提示降级
      sources: Object.assign({}, dsHealth, { assets: sourceHub.snapshot() }),
      python: await pythonHealth(),
      pendingReconcile: pending,
      lastPrediction,
      // 五道闸异步队列（05 §8）：running/queued 持续不降说明卡住了
      gates: lab.gatesQueue(),
      uptimeSec: Math.round(process.uptime()),
    });
  } catch (e) { fail(res, e); }
});

/* 页面路由：/today 为新的默认入口，/ 保留原分析台（书签兼容，06 §1） */
app.get('/today', (req, res) => res.sendFile(path.join(__dirname, 'public', 'today.html')));
app.get('/watch', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/lab', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lab.html')));
// 板块详情下钻（06 §2.3②），必须注册在 catch-all 之前
app.get('/sector/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sector.html')));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('QuantLab 已启动: http://localhost:' + PORT);
});

// 数据源探活（10 §4.3）：Web 常驻进程每 5 分钟一次，不单设 cron；
// unref 保证不阻止进程退出；熔断冷却期内的源会被 probe 自动跳过。
setInterval(() => {
  sourceHub.probe().catch((e) => console.warn('[probe] ' + e.message));
}, config.sources.probeIntervalMin * 60 * 1000).unref();
