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
const ok = (res, data) => res.json({ ok: true, data });
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
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('QuantLab 已启动: http://localhost:' + PORT);
});
