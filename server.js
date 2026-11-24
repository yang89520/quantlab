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
const wyckoff = require('./lib/wyckoff');
const config = require('./lib/config');
const log = require('./lib/log');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

/**
 * 公网访问的基本认证（config.auth）。
 *
 * 为什么要按来源区分：本机直连是日常开发和验收脚本在跑，加了密码只会到处报 401；
 * 但一旦挂到 Cloudflare 隧道上，任何人都能改自选股、跑回测、触发五道闸——
 * 这个服务有 16 个写接口且原本零认证。
 *
 * 判据：隧道/反代会在请求上带 cf-connecting-ip（Cloudflare）或 x-forwarded-for，
 * 本机直连没有。所以「有代理头 = 从公网来的」这一条足够用，不需要维护白名单。
 * protectLocal 打开则本机也要密码，用于验证认证链路本身。
 *
 * 密码从环境变量读，不落配置文件——config.json 是要入库的。
 */
app.use((req, res, next) => {
  const a = config.auth || {};
  if (!a.enabled) return next();
  const pass = process.env[a.passEnv || 'QL_AUTH_PASS'] || '';
  if (!pass) {
    // 开了认证却没给密码：只允许本机，避免把没保护的端口暴露出去
    const fromProxy = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    if (fromProxy) {
      res.set('www-authenticate', 'Basic realm="quantlab"');
      return res.status(503).json({ ok: false, error: '服务未配置访问密码（QL_AUTH_PASS），拒绝公网访问' });
    }
    return next();
  }
  const fromProxy = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
  if (!fromProxy && !a.protectLocal) return next();

  const hdr = String(req.headers.authorization || '');
  const m = hdr.match(/^Basic\s+(.+)$/i);
  if (m) {
    let user = '', given = '';
    try {
      const raw = Buffer.from(m[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      user = i >= 0 ? raw.slice(0, i) : raw;
      given = i >= 0 ? raw.slice(i + 1) : '';
    } catch (e) {
      log.warn('auth.bad_header', { error: e.message });
    }
    if (user === (a.user || 'quantlab') && given === pass) return next();
  }
  res.set('www-authenticate', 'Basic realm="quantlab", charset="UTF-8"');
  return res.status(401).json({ ok: false, error: '需要访问密码' });
});

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

/* ---------------- 静态前端：给资源引用打内容指纹 ---------------- */
// 手机浏览器（微信内置 / iOS WKWebView）对 Cache-Control: no-cache 的子资源仍可能
// 直接复用旧副本 —— 表现就是「代码明明改了，页面上还是老样子」。这里在 HTML 出口处
// 把 /js/x.js、/css/x.css 重写成带内容指纹的 URL：文件一变 URL 就变，缓存必然失效。
// HTML 本身改为 no-store，避免页面骨架被缓存。
const fs = require('fs');
const crypto = require('crypto');

const PUB = path.join(__dirname, 'public');
const _verCache = new Map();

function assetVer(urlPath) {
  const hit = _verCache.get(urlPath);
  const now = Date.now();
  if (hit && now - hit.at < 5000) return hit.v;
  let v = null;
  try {
    const st = fs.statSync(path.join(PUB, urlPath));
    v = crypto.createHash('md5').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 8);
  } catch (e) { v = null; }
  _verCache.set(urlPath, { v, at: now });
  return v;
}

function sendHtml(req, res, file) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(404).type('text/plain').send('Not Found');
    const out = html.replace(
      /(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\/[^"?#]+\.(?:js|css))(")/g,
      (m, pre, url, post) => {
        const v = assetVer(url.slice(1));
        return v ? `${pre}${url}?v=${v}${post}` : m;
      },
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.end(out);
  });
}

/* 前端资金指标与回测共用 lib/flow-signal.js 这一份实现。
 * 启动时同步到 public/js，避免出现「回测一套、页面另一套」的口径漂移。
 * 只在源文件更新时覆盖，不会每次重启都改动 mtime 拖累缓存。 */
try {
  const _src = path.join(__dirname, 'lib', 'flow-signal.js');
  const _dst = path.join(PUB, 'js', 'flow-signal.js');
  const _s = fs.statSync(_src);
  const _d = fs.existsSync(_dst) ? fs.statSync(_dst) : null;
  if (!_d || _s.mtimeMs > _d.mtimeMs) fs.copyFileSync(_src, _dst);
} catch (e) {
  log.warn('flow.sync_failed', { error: e.message });
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/') return sendHtml(req, res, path.join(PUB, 'index.html'));
  if (!/\.html$/.test(req.path)) return next();
  const file = path.join(PUB, req.path);
  if (!file.startsWith(PUB + path.sep)) return next();   // 挡住 ../ 越界
  return sendHtml(req, res, file);
});

app.use(express.static(PUB, {
  maxAge: 0,
  setHeaders(res, p) {
    if (!/\.(js|css)$/.test(p)) return;
    // 带了指纹的请求可以长期缓存，没带的（直接访问 /js/app.js）仍每次校验
    const hasVer = !!(res.req && res.req.query && res.req.query.v);
    res.setHeader('Cache-Control', hasVer ? 'public, max-age=31536000, immutable' : 'no-cache');
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
/* 威科夫结构识别：只输出客观特征与规则化形态，不含买卖建议（见 lib/wyckoff.js 的边界说明） */
app.get('/api/wyckoff/:code', async (req, res) => {
  try {
    const it = Q.normalize(req.params.code);
    if (!it) return res.status(400).json({ ok: false, error: '代码格式不正确' });
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    const bars = Math.min(5000, Math.max(80, parseInt(req.query.bars, 10) || 250));
    const k = await Q.klines(it.key, bars, period);
    ok(res, wyckoff.analyze(k.rows, { code: it.code, name: k.name, period }));
  } catch (e) { fail(res, e); }
});

// 卡尔曼市场状态：只回答「现在该承担多少风险」，不回答「买哪只」。
// 个股层面的卡尔曼趋势在 A 股是负 alpha（已回测证否），别把这个当买卖信号用。
app.get('/api/kalman/market', async (req, res) => {
  try {
    const d = await kalmanMarket.getMarketState({ force: req.query.force === '1' });
    if (!d.ok) return res.status(503).json({ ok: false, error: d.error, detail: d.detail });
    ok(res, d);
  } catch (e) { fail(res, e); }
});

app.get('/api/stock/:code', async (req, res) => {
  try {
    const it = Q.normalize(req.params.code);
    if (!it) return res.status(400).json({ ok: false, error: '代码格式不正确' });
    const isIndex = it.asset === 'index';
    // 「全部」按标的类型给到各自可得的历史长度：指数 5000 根（约 20 年），个股 3000 根。
    // 个股实际拿不满 3000 —— 同花顺年份文件只回溯约 10 年（2512 根左右），
    // 这里给到 3000 是为了让上游决定上限，而不是我们自己先砍一刀。
    const isAll = req.query.all === '1';
    const bars = isAll
      ? (isIndex ? 5000 : 3000)
      : Math.min(3000, Math.max(80, parseInt(req.query.bars, 10) || 500));
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
      // 周线：多周期共振与周线 KD 用。日线已经有 10 年，周线跟着给满，
      // 否则切到周线视图点「全部」只能看到 5 年，和日线对不上。
      Q.klines(it.key, 520, 'week').catch(() => null),
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
    const bars = Math.min(3000, Math.max(120, parseInt(body.bars, 10) || 1200));

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
            Q.klines(code, 520, 'week').catch(() => null),
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

/**
 * 上一交易日的预判卡（06 §2.3①「对比：昨日 → 今日」的数据源）。
 *
 * 为什么不让前端自己「今天减一天」：周五的上一交易日是周四，周一的上一交易日
 * 是上周五，节假日还会更远。日期减法在前端做必然错，必须由库里真实的
 * prediction.date 序列说了算。
 *
 * @query before YYYY-MM-DD（不含），默认取库里最新一条
 */
app.get('/api/predict/prev', async (req, res) => {
  try {
    const before = req.query.before;
    if (before && !/^\d{4}-\d{2}-\d{2}$/.test(String(before))) {
      return res.status(400).json({ ok: false, error: 'before 格式应为 YYYY-MM-DD' });
    }
    const st = await storeDao.open({ readOnly: true });
    const rows = await st.query('prediction', { order: 'date', desc: true, limit: 400 });
    const hit = rows.find((p) => !before || String(p.date).slice(0, 10) < String(before));
    if (!hit) return ok(res, null);
    // 顺带把这一天的对账结果带上：① 的对比要显示「昨日判 X，实际 Y」
    const recs = await st.query('reconcile', { where: { date: hit.date } });
    const payload = hit.payload || {};
    if (recs.length && !payload.reconcile) payload.reconcile = recs[0].payload || null;
    ok(res, payload);
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
/**
 * 把字典里的资金流挂到强度行上。
 *
 * 为什么不在强度计算里做：强度依赖上游行情库（localDb.marketDb），
 * 缺库时整表降级、netInflowPctile 全为 null，但资金流本身已经取到了，
 * 不该跟着一起消失。这里按板块代码合并，与强度计算解耦。
 */
function attachInflow(rows) {
  const flow = sectordata.inflowMap();
  if (!flow.size) return rows;
  return rows.map((r) => {
    const f = flow.get(r.sector);
    if (!f) return r;
    return Object.assign({}, r, {
      netInflow: f.netInflow,
      netRatio: f.netRatio,
      leadName: f.leadName,
      leadChgPct: f.leadChgPct,
      // 同时塞进 metrics：详情页的指标表统一读 metrics，不必为资金流开特例
      metrics: Object.assign({}, r.metrics, { netInflow: f.netInflow, netRatio: f.netRatio }),
    });
  });
}

app.get('/api/sector/strength', async (req, res) => {
  try {
    const { date, stale, askedFor } = await resolveSectorDate(req.query.date);
    const t = req.query.type;
    const type = (t === 'industry' || t === 'concept') ? t : null;
    const rows = await sectordata.readStrength(date, type, { readOnly: true });
    const withFlow = attachInflow(rows);
    ok(res, {
      date, type: type || 'all', total: withFlow.length, footnote: FOOTNOTE,
      // stale=true 表示「今天还没跑，给的是库内最新一天」；前端据此标「非当日」
      stale, askedFor,
      inflowCount: withFlow.filter((r) => r.netInflow != null).length,
      industry: withFlow.filter((r) => r.type === 'industry'),
      concept: withFlow.filter((r) => r.type === 'concept'),
      degradedCount: withFlow.filter((r) => r.degraded).length,
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
    const rows = attachInflow(await sectordata.readStrength(date, null, { readOnly: true }));
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
const formulaScreen = require('./lib/formula-screen');
const kalmanMarket = require('./lib/kalman-market');

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

/** 公式选股：全市场批量跑一条公式（月线/周线），返回本次命中 + 拥挤度判读。
 *  这是长任务（首次全市场要十几分钟，之后走当日缓存），所以同样走 taskId + 轮询。
 *  同时只允许一个在跑：两个并发任务会把上游取数打到限流，谁都跑不完。 */
let screenRunning = false;

app.post('/api/lab/screen', async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.formula || '').trim()) return res.status(400).json({ ok: false, error: 'formula 必填' });
    if (!String(b.outputLine || '').trim()) return res.status(400).json({ ok: false, error: 'outputLine 必填' });
    if (screenRunning) return res.status(429).json({ ok: false, error: '已有选股任务在跑，请等它结束' });

    const task = await lab.createTask('screen', {
      formula: b.formula, outputLine: b.outputLine,
      period: b.period || 'month', board: b.board || null, limit: b.limit, months: b.months,
    });
    screenRunning = true;
    const taskId = task.id;

    // 立即返回；后台跑。进度按 5% 节流写盘，避免每 20 只就重写一遍任务文件。
    setImmediate(async () => {
      let lastPct = -10;
      try {
        await lab.updateTask(taskId, { status: 'running', progress: 1 });
        const r = await formulaScreen.screen(Object.assign({}, b, {
          onProgress: (pct, total, hits, msg) => {
            if (pct - lastPct < 3 && pct < 100) return;
            lastPct = pct;
            lab.updateTask(taskId, { progress: Math.max(1, Math.min(99, pct)), note: msg || '' })
              .catch((e) => log.warn('lab.screen_progress_failed', { taskId, progress: pct, error: e.message }));
          },
        }));
        await lab.updateTask(taskId, { status: 'done', progress: 100, result: r, note: '' });
        log.info('lab.screen_done', {
          taskId, scanned: r.scanned, hits: r.hitCount,
          latest: `${r.latestMonth}:${r.latestCount}`, elapsedMs: r.elapsedMs,
        });
      } catch (e) {
        await lab.updateTask(taskId, { status: 'failed', error: e.message, note: '' })
          .catch((e2) => log.error('lab.screen_fail_update', { taskId, error: e2.message }));
        log.error('lab.screen_failed', { taskId, error: e.message, kind: e.kind || null });
      } finally {
        screenRunning = false;
      }
    });

    ok(res, { taskId, status: 'pending' });
  } catch (e) { fail(res, e); }
});

/** 选股任务轮询 */
app.get('/api/lab/screen/:taskId', async (req, res) => {
  try {
    const t = lab.getTask(req.params.taskId);
    if (!t) return res.status(404).json({ ok: false, error: '任务不存在' });
    ok(res, {
      taskId: t.id, status: t.status, progress: t.progress, note: t.note || '',
      result: t.result, error: t.error, createdAt: t.createdAt,
    });
  } catch (e) { fail(res, e); }
});

/** 策略列表（附该版本最近一次五道闸结论） */
app.get('/api/lab/strategies', async (req, res) => {  try {
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

/** 累计命中率曲线：实盘逐日累计 vs 回测基准（06 §4.4 要求两条线） */
app.get('/api/lab/track-curve', async (req, res) => {
  try {
    const id = req.query.strategyId;
    if (!id) return res.status(400).json({ ok: false, error: 'strategyId 必填' });
    const s = strategies.get(id);
    if (!s) return res.status(404).json({ ok: false, error: '策略不存在' });
    const c = await track.curve(id, { readOnly: true });
    ok(res, {
      strategyId: id,
      points: c.points,
      total: c.total,
      backtestWinRate: s.params && s.params.backtestWinRate != null ? s.params.backtestWinRate : null,
      degraded: s.status === 'suspect',
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
      // 通达信网关（10 §3.1）：板块指数日线的唯一来源，也是云端无本地库时的主力取数通道。
      // 这里只看缓存态，不主动探活——health 被前端轮询，每次探活会占住网关的串行队列。
      tdx: await (async () => {
        const c = (config.sources || {}).tdx || {};
        const a = require('./lib/sources/adapters/tdx');
        // 探活有 60s 缓存，所以这里可以直接 await：首次访问探一次，
        // 之后一分钟内都读缓存，不会把网关的串行队列打满。
        // 不探的话新起的服务会一直显示 available=null，看的人不知道是「没探」还是「挂了」。
        const up = await a.available();
        const det = a.probeDetail();
        return {
          enabled: c.enabled !== false,
          prefer: c.prefer !== false,
          baseUrl: a.base(),
          available: up,
          server: up && det && typeof det === 'object' ? (det.server || null) : null,
          error: !up && typeof det === 'string' ? det : null,
        };
      })(),
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

/* ---------------- 收盘看门狗（兜底，不是首选） ----------------
 *
 * 首选仍然是系统调度：`sh tools/install-schedule.sh` 装 launchd，
 * 或 `--print` 拿到等价的 cron 行。但这两条路都有装不上的情况
 * （实测本机 macOS 的 TCC 把 `crontab` 挡成 "operation not permitted"，
 *  `launchctl bootstrap` 在受限环境里报 Input/output error）。
 * 一旦没有任何调度，库里就永远是那一天的数据 —— 闭环直接停摆。
 *
 * 所以再加一层：只要服务在跑，每天 16:35 之后检查「今天有没有预判卡」，
 * 没有就补跑一次 daily-close。
 *
 * 为什么可以这么兜：daily-close 是幂等的（全 upsert），多跑一次不会产生
 * 重复数据；而漏跑一天，那一天的对账就永久缺失（02 §519）。
 * 与 cron 共存也安全 —— 已有当天预判卡时这里直接返回，不会重复执行。
 */
const { spawn } = require('child_process');
let catchUpRunning = false;

async function catchUpTick() {
  const cfg = (config.schedule || {}).catchUp || {};
  if (cfg.enabled !== true) return;
  if (catchUpRunning) return;

  // 只在「今天是交易日且已过收盘时间」时才考虑补跑。
  // 用 latestTradingDay() 而不是 todayStr()：节假日它不是今天，自然跳过。
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  if (mins < (Number(cfg.afterHour) || 16) * 60 + (Number(cfg.afterMinute) || 35)) return;

  const today = ds.todayStr();
  let trading = null;
  try {
    trading = (await ds.latestTradingDay()).date;
  } catch (e) {
    log.warn('catchup.date_failed', { error: e.message });
    return;
  }
  if (trading !== today) return;          // 今天不是交易日（或上游还没今天的数据）

  try {
    const db = await storeDao.open({ readOnly: true });
    const rows = await db.query('prediction', { where: { date: today } });
    if (rows.length) return;              // 今天已有预判卡，无需补跑
  } catch (e) {
    // 读不到就不猜：宁可下一轮再试，也不要在状态不明时启动任务
    log.warn('catchup.check_failed', { error: e.message });
    return;
  }

  catchUpRunning = true;
  log.warn('catchup.start', { date: today, note: '当天还没有预判卡，补跑 daily-close' });
  const child = spawn(process.execPath, [path.join(__dirname, 'tools', 'daily-close.js')], {
    cwd: __dirname, stdio: 'ignore',
  });
  child.on('close', (code) => {
    catchUpRunning = false;
    if (code === 0) log.info('catchup.done', { code });
    else log.error('catchup.failed', { code });
  });
  child.on('error', (e) => {
    catchUpRunning = false;
    log.error('catchup.spawn_failed', { error: e.message });
  });
}

if ((config.schedule || {}).catchUp && config.schedule.catchUp.enabled === true) {
  const every = Math.max(1, Number(config.schedule.catchUp.checkEveryMin) || 10) * 60 * 1000;
  setInterval(() => { catchUpTick().catch(() => {}); }, every).unref();
  // 启动 10s 后先查一次：服务重启（比如刚补跑完回来）时能立刻收敛
  setTimeout(() => { catchUpTick().catch(() => {}); }, 10000).unref();
  log.info('catchup.armed', { everyMin: every / 60000 });
}
