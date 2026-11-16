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
 * @param {{date:string, skipMembers?:boolean}} opt
 * @returns {Promise<{date, rows, provenance, insufficient:string[]}>}
 */
async function capture(opt) {
  const o = opt || {};
  const date = o.date || null;
  if (!date) throw new Error('capture 需要 date');
  const t0 = Date.now();

  const { dict, ind, con, inflowSource, inflowPctile } = await collectDict();
  const sectors = dict.sectors;
  const membersMap = await collectMembers(sectors);

  // 汇总所有成分股代码，一次批量读上游日线（只读）
  const allCodes = new Set();
  for (const list of membersMap.values()) {
    if (!list) continue;
    for (const m of list) if (/^\d{6}$/.test(String(m.code))) allCodes.add(String(m.code));
  }
  let klines = {};
  let localErr = null;
  try {
    klines = await localdb.readMemberKlines(Array.from(allCodes), config.sector.amountLookback);
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

  for (const s of sectors) {
    const list = membersMap.get(s.code);
    if (!list || !list.length) { insufficient.push(`${s.code}:no_members`); continue; }
    const sub = {};
    let n = 0;
    for (const m of list) {
      const code = String(m.code);
      if (klines[code] && klines[code].length) { sub[sina.withMarket(code)] = klines[code]; n++; }
    }
    if (!n) { insufficient.push(`${s.code}:no_klines`); continue; }
    const agg = aggregateSector(sub, { config: config.sector.aggregate });
    if (agg.bars.length < 21) { insufficient.push(`${s.code}:bars<21`); continue; }
    const feat = sectorLib.extractFeat(agg.bars, list.map((m) => String(m.code)), snapshot, {
      netInflowPctile: inflowPctile.has(s.code) ? inflowPctile.get(s.code) : null,
    });
    if (feat.insufficient) { insufficient.push(`${s.code}:${feat.reason}`); continue; }
    feats.push({ sector: s.code, name: s.name, type: s.type, feat, memberRows: list, agg });
  }

  const rows = sectorLib.scoreBatch(feats, { config: config.sector });
  for (const r of rows) {
    const f = feats.find((x) => x.sector === r.sector);
    r.bars = f ? f.agg.bars.length : 0;
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
    members: { source: 'sina-node', ok: sectors.length - insufficient.length, failed: insufficient.length },
    klines: { source: localErr ? 'unavailable' : 'local-aggregate', level: localErr ? null : 'A', error: localErr },
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

module.exports = { capture, readStrength, readHistory, latestStrengthDate, sectorsOfCode, collectDict, collectMembers };
