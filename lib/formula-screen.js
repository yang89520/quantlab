'use strict';
/**
 * 公式选股（全市场批量跑通达信公式）。
 *
 * 为什么要这一层：lab.backtest 是「一只票、一个周期」的回测协议，
 * 全市场几千只挨个 spawn Python 光进程开销就要几分钟。这里做三件事：
 *   1) 取数：并发拉月线 + 当日缓存（同一天重复跑不再打上游）；
 *   2) 计算：一次 spawn 处理一批（复用 py/tdx_engine/screen.py）；
 *   3) 判读：把命中数换算成「拥挤度」，这是该指标真正的用法（见 docs/月线三重底-研究.md）。
 *
 * 硬规矩与 pyrunner 一致：不静默失败、单只失败不拖垮整批、超时强杀。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const Q = require('./quote');
const fuyao = require('./sources/adapters/fuyao');
const py = require('./pyrunner');

const BARS = 130;              // 月线根数：MA60(60) + 箱体(34) + 量位(30) 至少 94 根，130 留余量
const BATCH = 80;              // 每批送进 Python 的只数（80×130 根 ≈ 800KB JSON）
const CONC = 6;                // 取数并发：实测 6 路稳定，再高上游开始返回慢响应

/* ---------------- 缓存 ---------------- */

function cacheDir() { return path.join(config.__root, 'data', 'cache'); }
function cachePath(asOf) { return path.join(cacheDir(), `month-${asOf}.json`); }

function loadCache(asOf) {
  try {
    const raw = fs.readFileSync(cachePath(asOf), 'utf8');
    const d = JSON.parse(raw);
    if (d && d.asOf === asOf && d.data) return d;
  } catch (e) {
    // 没有缓存是常态（第一次跑），但要留一条痕：缓存文件损坏与「还没生成」必须能区分开
    if (e.code !== 'ENOENT') log.warn('formula-screen.cache_read_failed', { error: e.message });
  }
  return { asOf, savedAt: null, data: {} };
}

function saveCache(c) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const p = cachePath(c.asOf);
    const tmp = `${p}.tmp`;
    c.savedAt = new Date().toISOString();
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, p);
  } catch (e) {
    log.warn('formula-screen.cache_write_failed', { error: e.message });
  }
}

/* ---------------- 股票池 ---------------- */

/**
 * 池子落盘：行情列表被上游限流时（实测能只回 2 只）用它顶上。
 * 月线选股对「今天是哪 5580 只」不敏感，过期几天的池子完全够用；
 * 而没有它，冷启动撞上并发就只能给出「命中 0 只」的假结果。
 */
function universeCachePath() { return path.join(config.__root, 'data', 'cache', 'universe.json'); }
function readUniverseCache() {
  try {
    const c = JSON.parse(fs.readFileSync(universeCachePath(), 'utf8'));
    return Array.isArray(c.list) && c.list.length >= 500 ? c : null;
  } catch (e) { return null; }
}
function writeUniverseCache(list) {
  if (!Array.isArray(list) || list.length < 500) return;
  try {
    fs.mkdirSync(path.dirname(universeCachePath()), { recursive: true });
    // 只存选股用得到的字段；noTrade 不落盘 —— 缓存是盘前写的话会把整个池子标成「未成交」，
    // 下次读出来就成了空池，这个坑比缓存过期严重得多。
    const slim = list.map((x) => ({
      symbol: x.symbol, code: x.code, name: x.name, amount: x.amount || 0, noTrade: false,
    }));
    fs.writeFileSync(universeCachePath(), JSON.stringify({ at: new Date().toISOString(), list: slim }));
  } catch (e) { log.warn('formula-screen.universe_cache_write_failed', { error: e.message }); }
}

/**
 * 板块口径。沪市 688/689 是科创板、深市 30x 是创业板，这两类涨跌幅 20cm、
 * 与主板的 10cm 不是同一套规律，混在一个名单里会让「月涨 9.5%」这种阈值失真。
 * 深市 000/001/002/003 全部属主板（中小板 2021 年已并入）。
 */
const BOARDS = {
  main: (s) => /^sh6(?!8[89])/.test(s) || /^sz00/.test(s),
  gem: (s) => /^sz30/.test(s),
  star: (s) => /^sh68[89]/.test(s),
  bj: (s) => /^bj/.test(s),
};

/**
 * 默认池：沪深主板 + 创业板 + 科创板，按当日成交额降序取前 limit 只。
 * 北交所默认排除：上市历史短（凑不出 94 根月线），且流动性差异太大，
 * 混在同一份命中列表里会误导判读。需要时传 includeBj。
 *
 * board 传 'main' 时只保留沪深主板，范围仍按 limit 截断 —— 想要「全部主板」
 * 就把 limit 拉到 6000（主板共 3100 余只，自然全取）。
 */
async function buildUniverse({ limit = 1200, includeBj = false, board = null } = {}) {
  let list = [];
  try {
    list = await Q.marketList();
  } catch (e) {
    log.warn('formula-screen.market_list_failed', { error: e.message });
  }
  let fromCache = false;
  if (!Array.isArray(list) || list.length < 500) {
    const c = readUniverseCache();
    if (c) {
      list = c.list;
      fromCache = true;
      log.warn('formula-screen.universe_from_cache', { count: list.length, at: c.at });
    }
  } else {
    writeUniverseCache(list);
  }
  const boardFn = board && BOARDS[board];
  const pool = list.filter((x) => {
    if (!x || !x.symbol) return false;
    if (!/^(sh6|sz0|sz3|bj)/.test(x.symbol)) return false;
    if (!includeBj && x.symbol.startsWith('bj')) return false;
    if (boardFn && !boardFn(x.symbol)) return false;
    // 不再按 noTrade 过滤：盘前（集合竞价前）新浪会把所有票的 trade 清零，
    // noTrade 全体为 true —— 9:15~9:25 跑选股会只剩个位数票，看起来像数据源挂了。
    // 「没有价格」的票在 marketList 里已按 price>0 挡掉，这里无需重复。
    return true;
  });
  pool.sort((a, b) => (b.amount || 0) - (a.amount || 0));
  // 池子异常小几乎都是上游限流只回了首页（实测冷启动撞并发时能只剩 2 只）。
  // 这种情况必须报错：静静地扫 2 只然后返回「命中 0 只」，比失败更误导。
  if (pool.length < 50) {
    throw Object.assign(
      new Error(`行情列表不完整（仅 ${pool.length} 只），上游可能限流，请稍后重试`),
      { code: 503 }
    );
  }
  const picked = pool.slice(0, Math.max(1, Math.min(limit, pool.length)));
  return { total: pool.length, list: picked, board: board || null, fromCache };
}

/* ---------------- 取数（并发 + 缓存） ---------------- */

async function fetchOne(sym, cache) {
  if (cache.data[sym] && Array.isArray(cache.data[sym].rows) && cache.data[sym].rows.length) {
    const c = cache.data[sym];
    return { sym, rows: c.rows, name: c.name, fromCache: true, src: c.src || 'unknown' };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await Q.klines(sym, BARS, 'month');
      if (r && r.rows && r.rows.length) {
        cache.data[sym] = { name: r.name, rows: r.rows, src: r.source || 'unknown' };
        return { sym, rows: r.rows, name: r.name, fromCache: false, src: r.source || 'unknown' };
      }
    } catch (e) {
      if (attempt === 1) return { sym, rows: null, error: e.message };
      await new Promise((r2) => setTimeout(r2, 350));
    }
  }
  return { sym, rows: null, error: 'empty' };
}

/**
 * 批量补数：扶摇一次 10 只、并发 8，实测 153 只/秒。
 * 全市场五千余只从「逐只秒级拉取、并发 6」压到几十秒。
 * 只在缓存未命中时出手；失败的票仍回落到逐只链路，不改变原有兜底语义。
 */
async function fillViaFuyao(list, cache, onProgress) {
  if (!fuyao.enabled()) return 0;
  const todo = list.filter((it) => !(cache.data[it.symbol] && Array.isArray(cache.data[it.symbol].rows) && cache.data[it.symbol].rows.length));
  if (!todo.length) return 0;

  const chunks = [];
  for (let i = 0; i < todo.length; i += fuyao.MAX_BATCH) chunks.push(todo.slice(i, i + fuyao.MAX_BATCH));

  let cursor = 0;
  let filled = 0;
  let done = 0;
  const CONC_FY = 8;
  async function worker() {
    while (cursor < chunks.length) {
      const c = chunks[cursor++];
      try {
        const r = await fuyao.historicalBatch(c.map((x) => x.symbol), { interval: '1mo' });
        for (const [sym, rows] of r.rows) {
          const hit = c.find((x) => x.symbol === sym);
          cache.data[sym] = {
            name: hit ? hit.name : '',
            rows: rows.map((x) => [x.d, x.o, x.c, x.h, x.l, x.v, x.a]),
            src: 'fuyao',
          };
          filled++;
        }
      } catch (e) {
        // 整批失败不致命：这些票留给后面的逐只链路
        log.warn('formula-screen.fuyao_batch_failed', { count: c.length, error: e.message });
      }
      done += c.length;
      if (onProgress) onProgress(done, todo.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC_FY, chunks.length) }, worker));
  saveCache(cache);
  log.info('formula-screen.fuyao_filled', { asked: todo.length, filled });
  return filled;
}

async function fetchAll(list, cache, onProgress) {
  const out = [];
  let done = 0;
  let cursor = 0;
  await fillViaFuyao(list, cache, (d, total) => {
    if (onProgress) onProgress(Math.round((d / total) * 40), 40 + list.length);
  });
  async function worker() {
    while (cursor < list.length) {
      const it = list[cursor++];
      const r = await fetchOne(it.symbol, cache);
      out.push(Object.assign({ name: it.name }, r));
      done++;
      if (onProgress && done % 20 === 0) onProgress(40 + Math.round((done / list.length) * 5), 45 + list.length);
      if (done % 200 === 0) saveCache(cache);      // 长任务中途落盘，断了不用重来
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
  saveCache(cache);
  if (onProgress) onProgress(list.length, list.length);
  const miss = out.filter((x) => !x.rows || !x.rows.length);
  if (miss.length) log.warn('formula-screen.fetch_miss', { count: miss.length, sample: miss.slice(0, 5).map((x) => x.sym) });
  return { ok: out.filter((x) => x.rows && x.rows.length), miss };
}

/* ---------------- 计算（分批 spawn） ---------------- */

function runBatch(batch, formula, outputLine, period, asOf, months, dropTail = true) {
  const items = batch.map((x) => ({ sym: x.sym, name: x.name, rows: x.rows }));
  return py.callPython({
    task: 'screen', formula, outputLine, period, asOf, months,
    dropIncompleteTail: dropTail, lookback: 3, items,
  }, { timeout: 60000, script: 'screen.py' })
    .catch((e) => ({ ok: false, error: e.message, kind: 'spawn' }));
}

async function compute(rowsList, formula, outputLine, period, asOf, months, onProgress, dropTail = true) {
  const hits = [];
  const tails = {};
  const errors = [];
  let scanned = 0;
  for (let i = 0; i < rowsList.length; i += BATCH) {
    const batch = rowsList.slice(i, i + BATCH);
    const r = await runBatch(batch, formula, outputLine, period, asOf, months, dropTail);
    if (!r.ok) {
      // 整批失败一般是公式本身有问题（语法/未定义标识符），必须让用户看见
      const e = new Error(r.error || '批量计算失败');
      e.kind = r.kind;
      e.detail = r.detail;
      throw e;
    }
    scanned += r.scanned || batch.length;
    hits.push(...(r.hits || []));
    Object.assign(tails, r.tails || {});
    errors.push(...(r.errors || []));
    if (onProgress) onProgress(Math.min(rowsList.length, i + BATCH), rowsList.length, hits.length);
  }
  return { hits, tails, errors, scanned };
}

/* ---------------- 拥挤度判读 ----------------
 * 关键：不能按「命中几只」的绝对数判读 —— 扫 400 只和扫 5000 只，同一个月份能差十倍。
 * 历史统计（715 只样本）换算成命中率：
 *   2022-04  59 只 / 715 = 8.3%   12 个月后中位 +25.4%
 *   2024-01  99 只 / 715 = 13.8%  12 个月后中位 +15.3%
 *   2024-06  60 只 / 715 = 8.4%   12 个月后中位 +44.0%
 *   常态月份多在 0.5%~2%
 * 所以分档按「本月命中 / 本次扫描只数」：
 *   < 0.5% 或 <=2 只 → 个股级；0.5~2% → 零散；2~8% → 扩散；>= 8% → 市场级。
 * 结论仍然是：它的价值在择时（全市场同时超跌），不在挑个股。
 */
/** 公式是否输出了三重底的三条中间量（决定能否套用那套历史基准）。 */
function hasTripleOutputs(tails) {
  for (const sym of Object.keys(tails || {})) {
    const t = tails[sym];
    if (Array.isArray(t) && t.some((x) => x && (x.dev != null || x.box != null || x.vpos != null))) return true;
  }
  return false;
}

function crowding(n, scanned, opts) {
  const share = scanned ? (n / scanned) * 100 : 0;
  // 历史基准（715 只 / 2020-11~2026-10 的 12 个月持有收益）只对「月线三重底」成立：
  // 那套公式找的是全市场同时超跌，收益分布与「起龙」这类追突破的信号不是一回事。
  // 调用方按公式是否输出 偏离/箱位/量位 判断，非三重底就不展示这些数字，
  // 否则用户会把 +22.9% 当成当前公式的成绩。
  const showHist = !(opts && opts.showHist === false);
  const H = {
    single: { n: 14, mean: 25.6, med: 8.8, win: 57.1 },
    sparse: { n: 138, mean: 12.5, med: 2.1, win: 56.5 },
    broad: { n: 228, mean: 19.4, med: 12.6, win: 69.7 },
    market: { n: 218, mean: 32.9, med: 25.4, win: 87.6 },
  };
  const pick = (k) => (showHist ? H[k] : null);

  if (!n) {
    return {
      level: 'none', label: '无命中', share,
      desc: '本月没有标的满足所选条件。月线级别的形态本就不常触发，空月份是常态，不必强行找票。',
      hist: null,
    };
  }
  if (n <= 2 || share < 0.5) {
    return {
      level: 'single', label: '个股级（1~2 只）', share,
      desc: showHist
        ? '孤立命中。历史这一档 12 个月中位只有 +8.8%、胜率 57%，样本也少 —— '
          + '更大可能是这只票自身出了问题（基本面恶化、行业逆风），不要仅凭信号买入。'
        : '孤立命中。单只票触发月线形态，更多反映个股自身状态而非板块效应；'
          + '这类信号历史上分化极大，不要仅凭一个信号买入。',
      hist: pick('single'),
    };
  }
  if (share < 2) {
    return {
      level: 'sparse', label: '零散（命中率 <2%）', share,
      desc: showHist
        ? '历史上这一档最差：中位 +2.1%、胜率 56.5%。信号零散说明超跌还没形成面，'
          + '通常还要再跌一段。建议只进观察池，等命中率扩散再动手。'
        : '信号零散，说明同类形态还没成面。建议先放观察池，等同类信号增多再动手。',
      hist: pick('sparse'),
    };
  }
  if (share < 8) {
    return {
      level: 'broad', label: '扩散（命中率 2~8%）', share,
      desc: showHist
        ? '超跌开始成面：历史中位 +12.6%、胜率 69.7%。可以分批建仓，'
          + '但真正的底部往往还在后面，别一次打完。'
        : '同类信号开始成面，说明不是个别票的行为。可以分批参与，但别一次打完。',
      hist: pick('broad'),
    };
  }
  return {
    level: 'market', label: '市场级（命中率 ≥8%）', share,
    desc: showHist
      ? '历史上这一档才是真正的底部信号：12 个月中位 +25.4%、胜率 87.6%。'
        + '2022-04、2024-01、2024-06 三次都在这一档，之后一年中位分别为 +25.4% / +15.3% / +44.0%。'
        + '注意它说的是「全市场都在超跌」，不是「这只票特别好」。'
      : '全市场同时出现同类信号，通常是极端行情的产物。这种时候择时的意义大于选股，'
        + '名单里的个票质地差异很大，需要另做基本面筛选。',
    hist: pick('market'),
  };
}

/* ---------------- 主流程 ---------------- */

/**
 * @param {object} req { formula, outputLine, period, asOf, limit, includeBj, onProgress }
 */
async function screen(req) {
  const b = req || {};
  const formula = String(b.formula || '');
  const outputLine = String(b.outputLine || '');
  if (!formula.trim()) throw Object.assign(new Error('formula 必填'), { code: 400 });
  if (!outputLine.trim()) throw Object.assign(new Error('outputLine 必填'), { code: 400 });
  const period = b.period === 'week' ? 'week' : 'month';
  const asOf = String(b.asOf || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
  const limit = Math.max(20, Math.min(6000, Number(b.limit) || 1200));
  const onProgress = typeof b.onProgress === 'function' ? b.onProgress : null;

  const t0 = Date.now();
  // 先静态扫一遍：含高危未来函数直接拒绝，别浪费 20 分钟取数
  const sc = await py.callPython({ task: 'scan', formula }, { timeout: 20000 })
    .catch((e) => ({ ok: false, error: e.message }));
  if (sc && sc.ok && sc.hasCritical) {
    throw Object.assign(new Error('公式含高危未来函数，拒绝用于选股'), {
      code: 400, findings: sc.findings,
    });
  }

  const uni = await buildUniverse({ limit, includeBj: !!b.includeBj, board: b.board || null });
  if (onProgress) onProgress(0, uni.list.length, 0, `取数中：池 ${uni.total} 只，本次扫 ${uni.list.length} 只`);

  const cache = loadCache(asOf);
  const cachedBefore = Object.keys(cache.data).length;
  const f = await fetchAll(uni.list, cache, (d, t) => {
    // 取数占进度前 45%（首次全市场这一步是大头，必须让进度条真的在动）
    if (onProgress) onProgress(Math.round((d / t) * 45), t, 0, `取月线 ${d}/${t}`);
  });

  const months = Math.max(0, Math.min(120, Number(b.months) || 12));
  // 默认剔除未走完的当期 K 线（半根月线算量位是错的）。
  // includeIncomplete=true 时保留，用于「本月至今是否已触发」的观察名单，
  // 调用方必须自行标注「未收月、收盘还可能变」。
  const c = await compute(f.ok, formula, outputLine, period, asOf, months, (d, t, h) => {
    if (onProgress) onProgress(45 + Math.round((d / t) * 50), t, h, `计算 ${d}/${t}`);
  }, b.includeIncomplete !== true);

  // 按月统计命中（月线选股要看「哪个月扎堆」而不是只看最新一根）
  const byMonth = {};
  for (const h of c.hits) {
    const m = String(h.date).slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }

  // 「最新一根」是哪个月：从实际数据里取，不能拿 asOf 顶替。
  // 月线在月中跑时最后一根被剔除，数据末月是上个月 —— 写成 asOf 的月份会凭空造出一个空月份。
  let dataLast = '';
  for (const sym of Object.keys(c.tails)) {
    const t = c.tails[sym];
    const d = t && t.length ? String(t[t.length - 1].date) : '';
    if (d > dataLast) dataLast = d;
  }
  const latestMonth = dataLast ? dataLast.slice(0, 7) : (Object.keys(byMonth).sort().pop() || asOf.slice(0, 7));
  const latestCount = byMonth[latestMonth] || 0;

  hitsSort(c.hits);

  /*
   * 口径自检：同一份池子必须来自同一个源。
   * ths 与 fuyao 的分红处理不同，同一只票的「偏离 60 月均线」会差 0.7%~2.7%，
   * 混用会让边界票翻转（实测 219 只 vs 222 只）。所以这里把源的构成显性化：
   * 主源占比不足 95% 时标 degraded，前端可以据此提示「名单跨源，慎用边界票」。
   */
  const srcDist = {};
  for (const x of f.ok) {
    const k = String(x.src || 'unknown');
    srcDist[k] = (srcDist[k] || 0) + 1;
  }
  const srcTotal = Object.values(srcDist).reduce((a, b) => a + b, 0);
  const srcMax = Object.entries(srcDist).sort((a, b) => b[1] - a[1])[0] || ['none', 0];
  const sourceMix = {
    dist: srcDist,
    primary: srcMax[0],
    primaryShare: srcTotal ? +(srcMax[1] / srcTotal).toFixed(4) : 0,
    mixed: Object.keys(srcDist).length > 1,
    degraded: srcTotal > 0 && srcMax[1] / srcTotal < 0.95,
  };
  if (sourceMix.mixed) log.info('formula-screen.source_mix', sourceMix);

  return {
    asOf, period, outputLine,
    board: uni.board || 'all',
    includeIncomplete: b.includeIncomplete === true,
    pool: { total: uni.total, scanned: uni.list.length, fromCache: !!uni.fromCache },
    scanned: c.scanned,
    failed: f.miss.length + c.errors.length,
    hitCount: c.hits.length,
    hits: c.hits,
    byMonth,
    latestMonth,
    latestCount,
    months,
    dataLast,
    crowding: crowding(latestCount, c.scanned || uni.list.length, { showHist: hasTripleOutputs(c.tails) }),
    crowdBaseline: hasTripleOutputs(c.tails),
    sourceMix,
    tails: c.tails,
    errors: c.errors.slice(0, 20),
    cache: { reused: cachedBefore, total: Object.keys(cache.data).length },
    elapsedMs: Date.now() - t0,
  };
}

/** 命中列表排序：本月在前，再按偏离度从深到浅（越超跌越靠前） */
function hitsSort(hits) {
  hits.sort((a, b) => {
    if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
    return (a.dev || 0) - (b.dev || 0);
  });
}

module.exports = { screen, buildUniverse, crowding, cachePath, cacheDir, BARS, BATCH };
