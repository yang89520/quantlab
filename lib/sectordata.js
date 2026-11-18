'use strict';
/**
 * 板块数据采集与强度计算编排（docs/dev/04 §2、10 §3）。
 *
 * 真实链路（不接任何 demo）：
 *   新浪列表 → 新浪成分股（分页）→ 上游 market.db 只读批量读成分日线
 *   → aggregate 等权指数 → 四因子横截面评分 → ql.duckdb 落盘
 *   → 东财 f62 只作可选增强，取不到就走降级口径并标 degraded
 *
 * 板块代码统一新浪体系（new_* / gn_*），东财 BK**** 只作增强关联键。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const store = require('./dao');
// 显式带 index.js：一期已有 lib/sources.js，require('./sources') 会优先命中文件而非目录
const src = require('./sources/index.js');
const sina = require('./sources/adapters/sina-sector');
const em = require('./sources/adapters/em');
const localdb = require('./sources/adapters/local-db');
const { aggregateSector } = require('./sources/adapters/aggregate');
const sectorLib = require('./sector');

const CONCURRENCY = 4;

/* ---------------- 通达信板块指数（可选增强） ----------------
 * 我们的板块来自新浪，通达信的板块指数是 880xxx，两套命名对不上。
 * tools/tdx-map.js 用「精确同名 / 去通用后缀同名」两种高置信规则生成映射，
 * 命中率约 45%——剩下的一半宁可没有，也不能靠模糊匹配猜：
 * 实测模糊匹配会把「锂电池」并到「钠电池」、「固废处理」并到「医废处理」，
 * 那会让主线判断静默出错，比缺数据严重得多。
 */
let _tdxMap = null;
// 惰性 require：网关没部署时不该让 sectordata 加载失败
let _tdxAdapter = null;
function tdxSrc() {
  if (!_tdxAdapter) _tdxAdapter = require('./sources/adapters/tdx');
  return _tdxAdapter;
}
function loadTdxMap() {
  if (_tdxMap) return _tdxMap;
  const p = path.join(config.__root, 'data', 'sectors', 'tdx-map.json');
  if (!fs.existsSync(p)) { _tdxMap = { map: {} }; return _tdxMap; }
  try {
    _tdxMap = JSON.parse(fs.readFileSync(p, 'utf8'));
    log.info('sectordata.tdx_map_loaded', {
      matched: Object.keys(_tdxMap.map || {}).length, total: _tdxMap.total || null,
    });
  } catch (e) {
    log.warn('sectordata.tdx_map_bad', { error: e.message });
    _tdxMap = { map: {} };
  }
  return _tdxMap;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 采集板块字典（行业 + 概念分榜，绝不混排） */
async function collectDict() {
  const t0 = Date.now();
  const ind = await src.fetchAsset('sector-list-industry');
  const con = await src.fetchAsset('sector-list-concept');
  const base = ind.data.concat(con.data);
  let inflowSource = null;
  let sectors = base.map((s) => Object.assign({}, s, { netInflow: null, emCode: null }));
  const inflow = await src.tryAsset('net-inflow');
  if (inflow && Array.isArray(inflow.data) && inflow.data.length) {
    inflowSource = inflow.source;
    const merged = em.mergeByName(base, inflow.data);
    sectors = merged.rows;
    log.info('sectordata.inflow_merged', {
      emRows: inflow.data.length, matched: merged.matched, unmatched: merged.unmatched,
    });
  }

  // 板块代码必须是新浪体系（10 §6 断言 2）
  const bad = sectors.filter((s) => /^BK/i.test(s.code));
  if (bad.length) throw new Error(`板块代码混入东财 BK 体系：${bad[0].code}`);

  const dict = {
    schema: 1,
    updatedAt: new Date().toISOString(),
    source: 'sina-hy + sina-fljk',
    enhancedBy: inflowSource,
    sectors,
  };
  const p = path.join(config.__root, 'data', 'sectors', 'dict.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dict));
  fs.renameSync(tmp, p);

  // 净流入横截面分位（增强字段，缺失时全部为 null）
  const vals = sectors.map((s) => s.netInflow).filter((v) => Number.isFinite(v));
  const inflowPctile = new Map();
  for (const s of sectors) {
    if (!Number.isFinite(s.netInflow)) continue;
    inflowPctile.set(s.code, sectorLib.pctile(vals, s.netInflow));
  }

  log.info('sectordata.dict', {
    industry: ind.data.length, concept: con.data.length,
    enhanced: inflowSource || null,
    inflowCount: sectors.filter((s) => Number.isFinite(s.netInflow)).length,
    ms: Date.now() - t0,
  });
  return { dict, ind, con, inflowSource, inflowPctile };
}

/** 采集全部板块成分股，返回 { sector -> members[] } */
async function collectMembers(sectors) {
  const t0 = Date.now();
  const result = new Map();
  let failed = 0;
  await mapLimit(sectors, CONCURRENCY, async (s) => {
    try {
      const r = await src.fetchAsset('sector-members', { node: s.code });
      // 上游分页偶尔会重复返回同一只票（实测 new_qtxy 里 000795 出现两次）。
      // 不去重的话：memberCount 偏大、upRatio / ztCount 被同一只票重复加权、
      // 落 sector_member 还会撞主键（见 dao/duckdao.upsert 的注释）。
      const seen = new Set();
      const list = [];
      for (const m of r.data || []) {
        const code = String((m && m.code) != null ? m.code : '');
        if (!code || seen.has(code)) continue;
        seen.add(code);
        list.push(m);
      }
      result.set(s.code, list);
    } catch (e) {
      failed++;
      log.warn('sectordata.members_failed', { sector: s.code, error: e.message });
      result.set(s.code, null);   // null = 拿不到，不是空数组
    }
  });
  log.info('sectordata.members', {
    total: sectors.length, ok: sectors.length - failed, failed, ms: Date.now() - t0,
  });
  return result;
}

/**
 * 完整采集 + 聚合 + 评分 + 落盘。
 *
 * @param {{date:string, skipMembers?:boolean, reuse?:boolean}} opt
 *   reuse=true 时把「板块字典 + 成分股」缓存在进程内复用 —— 回补 20 个交易日时
 *   没必要对同一份成分列表打 20×(221 次) 网络请求（会被限流，也慢 5 分钟）。
 *   成分仍用「当日成分」（幸存者偏差见 10 §3.4），这点不因复用而改变。
 * @returns {Promise<{date, rows, provenance, insufficient:string[]}>}
 */
let _reuseCache = null;

/**
 * 从磁盘读板块字典（collectDict 每次都落这个文件）。
 * 回补历史日时没必要为「份量固定」的字典再打一次新浪列表接口。
 */
function readDictFile() {
  const p = path.join(config.__root, 'data', 'sectors', 'dict.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !Array.isArray(j.sectors) || !j.sectors.length) return null;
    return j;
  } catch (e) {
    log.warn('sectordata.dict_file_bad', { error: e.message });
    return null;
  }
}

/** 库内最近一次落盘的成分日期（没有则 null） */
async function latestMemberDate(opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('sector_member', { order: 'date', desc: true, limit: 1 });
  if (!rows.length) return null;
  const d = rows[0].date;
  if (!d) return null;
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}

/**
 * 从自有库读已落盘的成分股，返回 { sector -> [{code}] }。
 * 回补历史日用：成分是「当前成分」这件事本来就有幸存者偏差（10 §3.4），
 * 用最近一次落盘的成分与它同一口径，但省掉 221 次网络请求（会被限流）。
 */
async function membersFromStore(date, opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('sector_member', { where: { date }, limit: 300000 });
  if (!rows.length) return null;
  const map = new Map();
  for (const r of rows) {
    const s = String(r.sector);
    if (!map.has(s)) map.set(s, []);
    map.get(s).push({ code: String(r.code) });
  }
  return map;
}

async function capture(opt) {
  const o = opt || {};
  const date = o.date || null;
  if (!date) throw new Error('capture 需要 date');
  const t0 = Date.now();

  let dict, ind, con, inflowSource, inflowPctile, membersMap, sectors;
  const offline = o.membersFrom === 'store';

  if (o.reuse && _reuseCache) {
    ({ dict, ind, con, inflowSource, inflowPctile, membersMap, sectors } = _reuseCache);
    log.info('sectordata.reuse', { sectors: sectors.length, members: membersMap.size });
  } else if (offline) {
    // ---- 离线路径：字典读盘、成分读库，一次网络都不打 ----
    const dj = readDictFile();
    if (!dj) throw new Error('板块字典文件缺失（data/sectors/dict.json），无法离线采集');
    dict = dj;
    sectors = dj.sectors;
    // 净流入分位按字典里现存的 netInflow 重算（没有就全空，降级口径）
    const vals = sectors.map((s) => s.netInflow).filter((v) => Number.isFinite(v));
    inflowPctile = new Map();
    for (const s of sectors) {
      if (!Number.isFinite(s.netInflow)) continue;
      inflowPctile.set(s.code, sectorLib.pctile(vals, s.netInflow));
    }
    inflowSource = vals.length ? (dj.enhancedBy || 'dict-file') : null;
    ind = { data: sectors.filter((s) => s.type === 'industry'), meta: { source: 'dict-file' } };
    con = { data: sectors.filter((s) => s.type === 'concept'), meta: { source: 'dict-file' } };

    const md = await latestMemberDate({ readOnly: true });
    if (!md) throw new Error('库里没有已落盘的板块成分（sector_member 为空），无法离线采集');
    membersMap = await membersFromStore(md);
    if (!membersMap) throw new Error(`库里 ${md} 没有板块成分，无法离线采集`);
    log.info('sectordata.offline_members', { date, membersDate: md, sectors: sectors.length });
    if (o.reuse) _reuseCache = { dict, ind, con, inflowSource, inflowPctile, membersMap, sectors };
  } else {
    const c = await collectDict();
    dict = c.dict; ind = c.ind; con = c.con;
    inflowSource = c.inflowSource; inflowPctile = c.inflowPctile;
    sectors = dict.sectors;
    membersMap = await collectMembers(sectors);
    if (o.reuse) _reuseCache = { dict, ind, con, inflowSource, inflowPctile, membersMap, sectors };
  }

  // 汇总所有成分股代码，一次批量读上游日线（只读）。
  // until=date：回补历史日时必须只取到当日为止，否则拿今天的 K 线算历史榜单（前视偏差）
  const allCodes = new Set();
  for (const list of membersMap.values()) {
    if (!list) continue;
    for (const m of list) if (/^\d{6}$/.test(String(m.code))) allCodes.add(String(m.code));
  }
  let klines = {};
  let localErr = null;
  try {
    klines = await localdb.readMemberKlines(Array.from(allCodes), config.sector.amountLookback, date);
  } catch (e) {
    localErr = e.message;
    log.warn('sectordata.local_db_failed', { error: e.message });
  }

  const feats = [];
  const insufficient = [];
  const snapshotStocks = {};
  for (const list of membersMap.values()) {
    if (!list) continue;
    for (const m of list) {
      if (Number.isFinite(m.chgPct)) snapshotStocks[String(m.code)] = { c: m.chgPct };
    }
  }
  const snapshot = { stocks: snapshotStocks };

  // 板块 K 线有两种来源，按优先级：
  //   ① 通达信板块指数（880xxx）—— 真实指数，比等权聚合更准，且**完全不依赖本地库**
  //   ② 成分股等权聚合 —— 老办法，需要本地 38.5GB 上游库
  // 有映射就用 ①，所以云端（无本地库）也能算出这些板块的强度。
  // 映射表由 tools/tdx-map.js 生成，只收高置信匹配（不做模糊匹配，防错配）。
  const tmap = loadTdxMap().map || {};
  const tdxReady = o.blockIndex !== false && await tdxSrc().available();
  let idxUsed = 0;

  for (const s of sectors) {
    const list = membersMap.get(s.code);
    if (!list || !list.length) { insufficient.push(`${s.code}:no_members`); continue; }

    let bars = null;
    let idxMeta = null;
    const mapped = tmap[s.code];
    if (tdxReady && mapped && mapped.tdxCode) {
      try {
        const t = await tdxSrc().kline(mapped.tdxCode, {
          bars: Math.max(60, config.sector.amountLookback + 10),
          until: date,
        });
        if (t.rows && t.rows.length >= 21) {
          bars = t.rows;
          idxMeta = { code: mapped.tdxCode, name: mapped.tdxName, up: t.upCount, down: t.downCount };
          idxUsed++;
        }
      } catch (e) {
        // 单个板块指数失败不该让整轮采集失败，退回聚合
        log.warn('sectordata.block_index_failed', { sector: s.code, tdx: mapped.tdxCode, error: e.message });
      }
    }

    if (!bars) {
      const sub = {};
      let n = 0;
      for (const m of list) {
        const code = String(m.code);
        if (klines[code] && klines[code].length) { sub[sina.withMarket(code)] = klines[code]; n++; }
      }
      if (!n) { insufficient.push(`${s.code}:no_klines`); continue; }
      const agg = aggregateSector(sub, { config: config.sector.aggregate });
      bars = agg.bars;
    }
    if (bars.length < 21) { insufficient.push(`${s.code}:bars<21`); continue; }

    const feat = sectorLib.extractFeat(bars, list.map((m) => String(m.code)), snapshot, {
      netInflowPctile: inflowPctile.has(s.code) ? inflowPctile.get(s.code) : null,
    });
    if (feat.insufficient) { insufficient.push(`${s.code}:${feat.reason}`); continue; }
    feats.push({
      sector: s.code, name: s.name, type: s.type, feat, memberRows: list,
      barCount: bars.length,
      source: idxMeta ? 'tdx-index' : 'aggregate',
      tdxIndex: idxMeta,
    });
  }

  const rows = sectorLib.scoreBatch(feats, { config: config.sector });
  for (const r of rows) {
    const f = feats.find((x) => x.sector === r.sector);
    r.bars = f ? f.barCount : 0;
    r.memberCount = f ? f.memberRows.length : 0;
    r.survivorBiasFootnote = '历史强度基于当前成分回算，长周期仅供参考';
  }

  // 落盘（自有库，可写）
  const st = await store.open();
  // 上游成分股列表会重复返回同一只票（实测 new_qtxy 里 000795 出现两次），
  // 直接落库会撞 sector_member 主键，也会让 memberCount 偏大 —— 按 (sector, code) 收敛
  const memberRows = [];
  const seenMember = new Set();
  for (const f of feats) {
    for (const m of f.memberRows) {
      const code = String(m.code);
      if (!/^\d{6}$/.test(code)) continue;
      const k = `${f.sector}\u0000${code}`;
      if (seenMember.has(k)) continue;
      seenMember.add(k);
      memberRows.push({ date, sector: f.sector, code });
    }
  }
  if (memberRows.length) await st.upsert('sector_member', memberRows);
  if (rows.length) {
    await st.upsert('sector_strength', rows.map((r) => ({
      date, sector: r.sector, name: r.name, type: r.type,
      score: r.score, grade: r.grade, payload: r,
    })));
  }

  const provenance = {
    dict: { source: dict.source, enhancedBy: inflowSource, industry: ind.data.length, concept: con.data.length },
    members: {
      // 离线回补时成分来自库里已落盘的那一份，必须如实标出来（D4）
      source: offline ? 'store:sector_member' : 'sina-node',
      ok: sectors.length - insufficient.length,
      failed: insufficient.length,
    },
    // upTo 记清「这条榜单只用了截至哪天的 K 线」—— 回补历史日时它是防前视偏差的凭据
    klines: {
      source: localErr ? 'unavailable' : 'local-aggregate',
      level: localErr ? null : 'A',
      error: localErr,
      upTo: date,
      // 多少板块用了通达信板块指数（真实指数）代替成分聚合
      blockIndex: { used: idxUsed, mapped: Object.keys(loadTdxMap().map || {}).length, ready: tdxReady },
    },
    netInflow: { source: inflowSource || null, degraded: !inflowSource },
    fetchedAt: new Date().toISOString(),
  };
  log.info('sectordata.captured', {
    date, sectors: sectors.length, scored: rows.length,
    insufficient: insufficient.length, degraded: rows.filter((r) => r.degraded).length,
    grades: ['A', 'B', 'C', 'D'].map((g) => `${g}:${rows.filter((r) => r.grade === g).length}`).join(' '),
    ms: Date.now() - t0,
  });

  return { date, rows, provenance, insufficient };
}

/** 读某日强度榜；type 可选 industry/concept */
async function readStrength(date, type, opts) {
  const st = await store.open(opts || { readOnly: true });
  const where = { date };
  if (type) where.type = type;
  const rows = await st.query('sector_strength', { where, order: 'score', desc: true, limit: 1000 });
  return rows.map((r) => (r.payload && typeof r.payload === 'object' ? r.payload : r));
}

/**
 * 库内最新一天的强度榜日期（没有则 null）。
 *
 * 用途：交易日 15:00 前 daily-close 还没跑，`latestTradingDay()` 会给出「今天」，
 * 但今天根本没有强度数据 —— 直接按今天查，板块页整页都是「未找到该板块」。
 * 此时退到库内最新一天，并由调用方标 stale（是旧数据就说旧数据，不冒充当日）。
 */
async function latestStrengthDate(opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('sector_strength', { order: 'date', desc: true, limit: 1 });
  if (!rows.length) return null;
  const d = rows[0].date;
  if (!d) return null;
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}

/** 板块历史（轮动） */
async function readHistory(days, opts) {
  const st = await store.open(opts || { readOnly: true });
  const rows = await st.query('sector_strength', { order: 'date', desc: true, limit: 100000 });
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (Number(days) || 20));
  const from = cutoff.toISOString().slice(0, 10);
  return rows.filter((r) => String(r.date) >= from);
}

/**
 * 某只标的当日所属板块（按 grade 从强到弱），供入池时判定档位用。
 * 板块档位必须由后端查当日榜单判定，不能信前端传值（server.js POST /api/watchpool）。
 *
 * @returns {Promise<Array<{sector, name, type, grade, score}>>}
 */
async function sectorsOfCode(date, code, opts) {
  const c = String(code || '').replace(/^(sh|sz|bj)/, '');
  if (!/^\d{6}$/.test(c)) return [];
  const st = await store.open(opts || { readOnly: true });
  const members = await st.query('sector_member', { where: { date, code: c }, limit: 5000 });
  if (!members.length) return [];
  const codes = new Set(members.map((m) => String(m.sector)));
  const strength = await readStrength(date, null, opts || { readOnly: true });
  const RANK = { A: 0, B: 1, C: 2, D: 3 };
  return strength
    .filter((s) => codes.has(String(s.sector)))
    .map((s) => ({ sector: s.sector, name: s.name, type: s.type, grade: s.grade, score: s.score }))
    .sort((a, b) => (RANK[a.grade] == null ? 9 : RANK[a.grade]) - (RANK[b.grade] == null ? 9 : RANK[b.grade]));
}

module.exports = {
  capture, readStrength, readHistory, latestStrengthDate, sectorsOfCode,
  collectDict, collectMembers,
  readDictFile, latestMemberDate, membersFromStore,
};
