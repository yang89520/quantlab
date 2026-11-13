'use strict';
/**
 * 全池形态扫描
 *
 * 选股页的「形态」判定原本跟着流派精算一起做，只能覆盖 TopN 一百多只，
 * 主板三千多只里绝大多数根本没被看过一眼。这里把形态层单独拆出来：
 *
 *   · 每只只取 260 根日线（形态全用尾部窗口：MA60 / 60 日新高 / 5 日涨幅 / 250 日位置），
 *     成本约为精算（1200 日线 + 周线 + 月线）的 1/5，整块主板一轮约 2 分钟；
 *   · 结果落盘，当天有效 —— 第二次打开、换行情条件、换流派都不用重扫；
 *   · 形态算法来自 public/js/shape.js，与前端精算共用同一份代码，
 *     不会出现「扫描说多头、精算说不是」这种两套口径。
 *
 * 所有数值都来自真实 K 线，拿不到数据的标的进 failed 列表，不参与任何统计。
 */

const fs = require('fs');
const path = require('path');
const Q = require('./quote');
const { shapeOf } = require('../public/js/shape');

const FILE = path.join(__dirname, '..', 'data', 'shape-cache.json');
const KEEP_DAYS = 3;        // 只保留最近 3 个交易日的桶，文件不会无限膨胀
const BARS = 260;           // 形态需要 250 根，多取 10 根防停牌/新股边界
/* 数据口径版本。K 线清洗层上线时补进了「当年缺失的年初段」，
   之前算出的形态全部基于残缺序列（2025-12-31 直接接 2026-04-17），
   必须整体作废重扫，否则缓存里留着一批错的判定。 */
const DATA_VER = 2;

/* ---------------- 磁盘缓存 ---------------- */
let db = null;
let saveTimer = null;

function load() {
  if (db) return db;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = j && j.buckets ? j : { v: 1, buckets: {} };
  } catch (e) {
    db = { v: 1, buckets: {} };
  }
  return db;
}

/** 原子写：先写临时文件再 rename，避免进程被杀时留下半个 JSON */
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const d = load();
  const days = Object.keys(d.buckets).sort();
  while (days.length > KEEP_DAYS) delete d.buckets[days.shift()];
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[scan] 缓存写入失败', e.message);
  }
}

function saveLater() {
  if (saveTimer) return;
  saveTimer = setTimeout(save, 800);
}

/* ---------------- 时间与新鲜度 ---------------- */
const bjt = () => new Date(Date.now() + 8 * 3600e3);
const dayStr = (t) => t.toISOString().slice(0, 10);

function isTradingMinute(t) {
  const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  const wd = t.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return (hm >= 565 && hm <= 690) || (hm >= 780 && hm <= 900);
}

/**
 * 缓存是否还代表「最新一根 K 线」。
 * 判断基准是 rec.d（最后一次扫描拿到的 K 线日期），不是缓存写入时间：
 *   · 已含今日 K 线 → 收盘后一直有效；盘中 10 分钟（扫描本身要 2 分钟，太短会反复重扫）；
 *   · 不含今日 → 开盘前与周末「昨收」就是最新，直接沿用；
 *     开盘后可能是当日还没出数据，也可能是个停牌股，1 小时内不重复拉。
 */
function fresh(rec) {
  if (!rec || !rec.d) return false;
  if (rec.v !== DATA_VER) return false;          // 口径变了，旧结果一律不认
  const t = bjt();
  const today = dayStr(t);
  const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  const wd = t.getUTCDay();
  const age = Date.now() - rec.at;

  if (rec.d === today) {
    if (wd === 0 || wd === 6) return true;
    if (hm >= 1505) return true;
    return age < (isTradingMinute(t) ? 600000 : 1800000);
  }
  if (wd === 0 || wd === 6) return true;
  if (hm < 930) return true;
  return age < 3600000;
}

/* ---------------- 扫描 ---------------- */
/**
 * @param {string[]} codes 6 位代码
 * @param {{force?:boolean}} opt
 * @returns {Promise<{data:Object, scanned:number, cached:number, failed:string[]}>}
 */
async function scan(codes, opt = {}) {
  const d = load();
  const t = bjt();
  const today = dayStr(t);
  const out = {};
  const todo = [];

  for (const c of codes) {
    let hit = null;
    for (const day of Object.keys(d.buckets)) {
      const r = d.buckets[day][c];
      if (r && fresh(r)) { hit = r; break; }
    }
    if (hit && !opt.force) out[c] = hit;
    else todo.push(c);
  }

  const failed = [];
  let cursor = 0;
  const CONC = 6;

  async function worker() {
    while (cursor < todo.length) {
      const code = todo[cursor++];
      let rows = null;
      try {
        const k = await Q.klines(code, BARS);
        rows = k.rows;
      } catch (e) {
        failed.push(code);
        continue;
      }
      const feat = shapeOf(rows);
      if (!feat) { failed.push(code); continue; }
      const rec = Object.assign({}, feat, { at: Date.now(), d: rows[rows.length - 1][0], v: DATA_VER });
      delete rec.bars;
      if (!d.buckets[today]) d.buckets[today] = {};
      d.buckets[today][code] = rec;
      out[code] = rec;
      saveLater();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length || 1) }, worker));
  if (todo.length) save();

  return { data: out, scanned: todo.length - failed.length, cached: codes.length - todo.length, failed };
}

/** 统计：当天桶里已经覆盖了多少只（前端展示覆盖率用） */
function coverage(codes) {
  const d = load();
  const today = dayStr(bjt());
  let n = 0;
  for (const c of codes) {
    const r = d.buckets[today] && d.buckets[today][c];
    if (r && r.v === DATA_VER) n++;
  }
  return { covered: n, total: codes.length };
}

module.exports = { scan, coverage, FILE };
