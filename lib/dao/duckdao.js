'use strict';
/**
 * DuckDB 后端（主）：写 data/ql.duckdb。
 *
 * 三条铁律（docs/dev/09-data-access.md §8.3）：
 *  1. 只短连接：每次操作 open → query → close。**绝不持有长连接**——
 *     DuckDB 单文件同时只允许一个写进程，Web 持着读连接，cron 就永远写不进去。
 *  2. 只写自有库：本模块只接收 ownDb 路径，上游 market.db 由 datasource 只读打开。
 *  3. 失败要抛错：不许静默降级，由上层 store/index 决定要不要换后端。
 */
const fs = require('fs');
const path = require('path');
const { TABLES, normalizeRow, keyTuple } = require('./schema');
const log = require('../log');

let duckdb = null;
function lib() {
  if (!duckdb) {
    // 延迟加载：没装驱动时这里抛错，由 store/index 捕获并降级
    duckdb = require('@duckdb/node-api');
  }
  return duckdb;
}

/** 探测驱动是否可用（不打开任何库） */
function probe() {
  try {
    lib();
    return { available: true, version: require('@duckdb/node-api/package.json').version };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

function toJs(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) return v;
  return v;
}

/** DuckDB 的 DATE 取出是 { days: 从 1970-01-01 起的天数 }，转成 'YYYY-MM-DD' */
function daysToDate(days) {
  const d = new Date(Date.UTC(1970, 0, 1) + Number(days) * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function mapRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // DATE 列
    if (v && typeof v === 'object' && typeof v.days === 'number' && Object.keys(v).length === 1) {
      out[k] = daysToDate(v.days);
      continue;
    }
    out[k] = toJs(v);
    // JSON 列在 DuckDB 里取回是字符串
    if (typeof out[k] === 'string' && (out[k].startsWith('{') || out[k].startsWith('['))) {
      try { out[k] = JSON.parse(out[k]); } catch (_) { /* 保留原字符串 */ }
    }
  }
  return out;
}

function ddl(table) {
  const def = TABLES[table];
  const cols = Object.entries(def.cols).map(([c, t]) => `${c} ${t}`);
  const pk = def.keys.join(', ');
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')}, PRIMARY KEY (${pk}))`;
}

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

const BATCH = 200;   // 每批行数：太大触发参数上限，太小又回到逐条

/** 把 rows 切成多行 VALUES 片段 + 扁平参数 */
function buildValuesChunk(table, rows) {
  const def = TABLES[table];
  const cols = Object.keys(def.cols);
  const one = `(${cols.map((c) => (def.cols[c] === 'JSON' ? 'CAST(? AS JSON)' : `CAST(? AS ${def.cols[c]})`)).join(', ')})`;
  const params = [];
  for (const raw of rows) {
    const r = normalizeRow(table, raw);
    for (const c of cols) params.push(toParam(r[c]));
  }
  return { sql: new Array(rows.length).fill(one).join(', '), params, cols };
}

/** 参数归一：对象/数组按 JSON 序列化，其余转字符串，null 保持 null */
function toParam(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v;
  return String(v);
}

/**
 * @param {string} dbPath data/ql.duckdb 的绝对路径
 */
function isLockError(e) {
  const m = String(e && e.message || '');
  return /Conflicting lock|Could not set lock|being used by another|No more data remaining|MetadataReader/i.test(m);
}

function create(dbPath, opt) {
  if (!dbPath) throw new Error('DuckDB 后端缺少库路径');
  const own = path.resolve(dbPath);
  const readOnly = !!(opt && opt.readOnly);

  // 每进程复用一个 instance：反复 create 会累积文件句柄，
  // 之前就是因此把库写到 MetadataReader 损坏。
  let instPromise = null;
  function instance() {
    if (!instPromise) {
      const { DuckDBInstance } = lib();
      if (!fs.existsSync(path.dirname(own))) fs.mkdirSync(path.dirname(own), { recursive: true });
      instPromise = DuckDBInstance.create(own, readOnly ? { access_mode: 'READ_ONLY' } : undefined)
        .catch((e) => { instPromise = null; throw e; });
    }
    return instPromise;
  }

  /** 连接即用即关；遇到锁冲突退避重试（cron 跑批时 Web 读会短暂拿不到库） */
  async function withConn(fn, retries) {
    const max = retries === undefined ? 6 : retries;
    let attempt = 0;
    for (;;) {
      try {
        const inst = await instance();
        const conn = await inst.connect();
        try {
          return await fn(conn);
        } finally {
          if (conn.closeSync) conn.closeSync(); else conn.close();
        }
      } catch (e) {
        attempt++;
        if (!isLockError(e) || attempt >= max) throw e;
        instPromise = null;                        // 实例可能已失效，下次重建
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }

  async function ensure(table) {
    await withConn(async (c) => { await c.run(ddl(table)); });
  }

  /** 批量插入（不查重，调用方保证不重复） */
  async function insert(table, rows) {
    if (!rows || !rows.length) return 0;
    const def = TABLES[table];
    const cols = Object.keys(def.cols);
    let n = 0;
    await withConn(async (c) => {
      await c.run('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          const { sql, params } = buildValuesChunk(table, chunk);
          await c.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${sql}`, params);
          n += chunk.length;
        }
        await c.run('COMMIT');
      } catch (err) {
        await c.run('ROLLBACK');
        throw err;
      }
    });
    return n;
  }

  /** 按主键覆盖写：分批 DELETE 再批量 INSERT，同一事务内完成 */
  async function upsert(table, rows) {
    if (!rows || !rows.length) return 0;
    const def = TABLES[table];
    const cols = Object.keys(def.cols);
    const keyCond = def.keys.map((k) => `${k} = CAST(? AS ${def.cols[k]})`).join(' AND ');

    let n = 0;
    await withConn(async (c) => {
      await c.run('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          // DELETE：把 N 条主键条件 OR 起来，一次删完
          const orParts = [];
          const delParams = [];
          for (const raw of chunk) {
            const r = normalizeRow(table, raw);
            orParts.push(`(${keyCond})`);
            for (const k of def.keys) delParams.push(toParam(r[k]));
          }
          await c.run(`DELETE FROM ${table} WHERE ${orParts.join(' OR ')}`, delParams);

          const { sql, params } = buildValuesChunk(table, chunk);
          await c.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${sql}`, params);
          n += chunk.length;
        }
        await c.run('COMMIT');
      } catch (err) {
        await c.run('ROLLBACK');
        throw err;
      }
    });
    return n;
  }

  /**
   * @param {object} opt { where, order, limit, desc }
   */
  async function query(table, opt) {
    opt = opt || {};
    const def = TABLES[table];
    const where = opt.where || {};
    const conds = [];
    const params = [];
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      conds.push(`${k} = CAST(? AS ${def.cols[k] || 'VARCHAR'})`);
      params.push(String(v));
    }
    let sql = `SELECT * FROM ${table}`;
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    if (opt.order) sql += ` ORDER BY ${opt.order} ${opt.desc === false ? 'ASC' : 'DESC'}`;
    if (opt.limit) sql += ` LIMIT ${Number(opt.limit)}`;
    const rows = await withConn(async (c) => {
      const r = await c.runAndReadAll(sql, params);
      return r.getRowObjects().map(mapRow);
    });
    return rows;
  }

  async function count(table, where) {
    const def = TABLES[table];
    const conds = [];
    const params = [];
    for (const [k, v] of Object.entries(where || {})) {
      if (v === undefined) continue;
      conds.push(`${k} = CAST(? AS ${def.cols[k] || 'VARCHAR'})`);
      params.push(String(v));
    }
    let sql = `SELECT COUNT(*) AS n FROM ${table}`;
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    const n = await withConn(async (c) => {
      const r = await c.runAndReadAll(sql, params);
      return Number(r.getRowObjects()[0].n);
    });
    return n;
  }

  /**
   * 建齐所有表并补齐缺失列（幂等）。
   * 只加列、不改列语义 —— 02 §0.2 的迁移约定；
   * CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，所以这里显式比对。
   */
  async function migrate() {
    const added = [];
    await withConn(async (c) => {
      for (const t of Object.keys(TABLES)) {
        await c.run(ddl(t));
      }
      // 逐表比对现有列
      for (const [t, def] of Object.entries(TABLES)) {
        const r = await c.runAndReadAll(
          `SELECT column_name FROM information_schema.columns WHERE table_name = ?`, [t]
        );
        const have = new Set(r.getRowObjects().map((x) => x.column_name));
        for (const [col, type] of Object.entries(def.cols)) {
          if (!have.has(col)) {
            await c.run(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`);
            added.push(`${t}.${col}`);
          }
        }
      }
    });
    if (added.length) log.info('dao.columns_added', { added });
  }

  return { engine: 'duckdb', path: own, insert, upsert, query, count, migrate, close: async () => {} };
}

module.exports = { create, probe };
