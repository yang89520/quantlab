'use strict';
/**
 * 表结构注册表：DuckDB 与 JSONL 两个后端共用同一份定义。
 * 依据 docs/dev/02-data-model.md §7.3。
 *
 * 设计原则：结构化列用于查询/聚合，完整原文放 payload。
 * 这样 schema 演进时只加列、不改历史行。
 */

const TABLES = {
  // 一期：日快照（长表，每只标的每天一行）
  snapshot: {
    keys: ['date', 'market', 'code'],
    cols: {
      date: 'DATE',
      market: 'VARCHAR',
      code: 'VARCHAR',
      price: 'DOUBLE',
      chg_pct: 'DOUBLE',
      amount: 'DOUBLE',
      turnover: 'DOUBLE',
      float_cap: 'DOUBLE',
      amplitude: 'DOUBLE',
    },
    // 数值精度：涨跌幅保留 4 位，避免对账时因浮点误差判错方向
    round: { price: 4, chg_pct: 4, amount: 2, turnover: 4, float_cap: 2, amplitude: 2 },
  },

  // 一期：预判卡
  prediction: {
    keys: ['date'],
    cols: {
      date: 'DATE',
      target_date: 'DATE',
      verdict: 'VARCHAR',
      score: 'INTEGER',
      data_complete: 'BOOLEAN',
      created_at: 'TIMESTAMP',
      payload: 'JSON',
    },
  },

  // 一期：对账（prediction.payload 的投影，便于统计）
  reconcile: {
    keys: ['date'],
    cols: {
      date: 'DATE',
      env_hit: 'BOOLEAN',
      cand_hit_ratio: 'DOUBLE',
      attribution: 'VARCHAR',
      judgment_score: 'INTEGER',
      skipped: 'BOOLEAN',
      payload: 'JSON',
    },
  },

  // 二期：板块成分与强度（先建表，二期写入）
  sector_member: {
    keys: ['date', 'sector', 'code'],
    cols: { date: 'DATE', sector: 'VARCHAR', code: 'VARCHAR' },
  },
  sector_strength: {
    keys: ['date', 'sector'],
    cols: {
      date: 'DATE',
      sector: 'VARCHAR',
      name: 'VARCHAR',
      type: 'VARCHAR',
      score: 'DOUBLE',
      grade: 'VARCHAR',
      payload: 'JSON',
    },
  },

  // 三期：策略信号与验证档案
  strategy_signal: {
    keys: ['date', 'strategy_id', 'code'],
    cols: {
      date: 'DATE',
      strategy_id: 'VARCHAR',
      version: 'INTEGER',
      code: 'VARCHAR',
      action: 'VARCHAR',
      price: 'DOUBLE',
      payload: 'JSON',
    },
  },
  strategy_gate: {
    keys: ['strategy_id', 'version', 'date'],
    cols: {
      strategy_id: 'VARCHAR',
      version: 'INTEGER',
      date: 'DATE',
      verdict: 'VARCHAR',
      payload: 'JSON',
    },
  },

  // 元信息：引擎版本、上次运行、熔断状态等
  meta: {
    keys: ['k'],
    cols: { k: 'VARCHAR', v: 'JSON' },
  },
};

/** 日期归一：'2026-11-13' 或 Date → 'YYYY-MM-DD'；空值返回 null（不伪造今天） */
function toDateStr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // 20261113
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

/** 按表定义做类型归一与精度裁剪 */
function normalizeRow(table, row) {
  const def = TABLES[table];
  if (!def) throw new Error(`未知表：${table}`);
  const out = {};
  for (const [col, type] of Object.entries(def.cols)) {
    let v = row[col];
    if (type === 'DATE') v = toDateStr(v);
    else if (type === 'TIMESTAMP') v = v instanceof Date ? v.toISOString() : (v == null ? null : String(v));
    else if (type === 'INTEGER') v = v == null || v === '' ? null : Math.round(Number(v));
    else if (type === 'DOUBLE') {
      if (v == null || v === '' || Number.isNaN(Number(v))) v = null;
      else {
        const r = def.round && def.round[col];
        v = Number(v);
        if (r !== undefined) v = Number(v.toFixed(r));
      }
    } else if (type === 'BOOLEAN') v = v == null ? null : Boolean(v);
    else if (type === 'JSON') v = v === undefined ? null : v;
    else v = v == null ? null : String(v);
    out[col] = v;
  }
  return out;
}

/** 取主键值数组，用于 upsert 去重 */
function keyTuple(table, row) {
  const def = TABLES[table];
  return def.keys.map((k) => {
    const v = row[k];
    if (v instanceof Date) return toDateStr(v);
    return v == null ? '' : String(v);
  }).join('\u0001');
}

module.exports = { TABLES, normalizeRow, keyTuple, toDateStr };
