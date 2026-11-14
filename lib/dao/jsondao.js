'use strict';
/**
 * JSONL 兜底后端：engine=jsonl 时全量功能仍可跑通（一期验收硬指标）。
 *
 * 写入约定（docs/dev/01-architecture.md §3.2）：
 *  - 追加 + 读全量 → 替换 → 写 .tmp → rename，禁止先删后写
 *  - 单行损坏跳过并记日志，不许整文件失败
 *  - 同进程内写操作串行（Promise 队列）
 */
const fs = require('fs');
const path = require('path');
const { TABLES, normalizeRow, keyTuple } = require('./schema');
const log = require('../log');

function create(dataDir) {
  const dir = path.resolve(dataDir || 'data/jsonl');
  fs.mkdirSync(dir, { recursive: true });

  let chain = Promise.resolve();
  function serialize(fn) {
    const p = chain.then(fn, fn);
    // 队列不断链：把异常吞进当前任务，避免影响后续
    chain = p.catch(() => {});
    return p;
  }

  function fileOf(table) {
    return path.join(dir, `${table}.jsonl`);
  }

  function readAll(table) {
    const f = fileOf(table);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const out = [];
    let skipped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        skipped++;
      }
    }
    if (skipped) log.warn('jsonl.line_skipped', { table, skipped });
    return out;
  }

  function rewrite(table, rows) {
    const f = fileOf(table);
    const tmp = f + '.tmp';
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmp, body ? body + '\n' : '');
    fs.renameSync(tmp, f);
  }

  async function insert(table, rows) {
    if (!rows || !rows.length) return 0;
    return serialize(async () => {
      const norm = rows.map((r) => normalizeRow(table, r));
      const f = fileOf(table);
      fs.appendFileSync(f, norm.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return norm.length;
    });
  }

  async function upsert(table, rows) {
    if (!rows || !rows.length) return 0;
    return serialize(async () => {
      const norm = rows.map((r) => normalizeRow(table, r));
      const keySet = new Map(norm.map((r) => [keyTuple(table, r), r]));
      const existing = readAll(table);
      // 保留原顺序，命中主键的用新值替换，未命中的追加
      const merged = [];
      const used = new Set();
      for (const row of existing) {
        const k = keyTuple(table, row);
        if (keySet.has(k)) {
          merged.push(keySet.get(k));
          used.add(k);
        } else {
          merged.push(row);
        }
      }
      for (const [k, row] of keySet) if (!used.has(k)) merged.push(row);
      rewrite(table, merged);
      return norm.length;
    });
  }

  function cmp(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    return a < b ? -1 : 1;
  }

  async function query(table, opt) {
    opt = opt || {};
    let rows = readAll(table);
    const where = opt.where || {};
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      rows = rows.filter((r) => String(r[k]) === String(v));
    }
    if (opt.order) {
      const cols = String(opt.order).split(',').map((s) => s.trim()).filter(Boolean);
      const dir = opt.desc === false ? 1 : -1;
      rows = rows.slice().sort((a, b) => {
        for (const c of cols) {
          const d = cmp(a[c], b[c]) * dir;
          if (d) return d;
        }
        return 0;
      });
    }
    if (opt.limit) rows = rows.slice(0, Number(opt.limit));
    return rows;
  }

  async function count(table, where) {
    const rows = await query(table, { where });
    return rows.length;
  }

  /** JSONL 无需建表，只做目录准备 */
  async function migrate() {
    for (const t of Object.keys(TABLES)) {
      const f = fileOf(t);
      if (!fs.existsSync(f)) fs.writeFileSync(f, '');
    }
  }

  return { engine: 'jsonl', path: dir, insert, upsert, query, count, migrate, close: async () => {} };
}

module.exports = { create };
