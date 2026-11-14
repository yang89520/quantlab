'use strict';
/**
 * 手动归档工具（docs/dev/02 附注「体积与清理策略」）。
 *
 * 这是**手动**工具，不调度、不进 cron：单文件 ql.duckdb 三年内 < 500MB，
 * 自动清理反而容易误删对账依据。
 *
 * 用法：
 *   node tools/archive.js --before 2025-01-01 --dry-run     # 先看会动多少行（默认 dry-run）
 *   node tools/archive.js --before 2025-01-01 --confirm     # 真归档
 *   node tools/archive.js --prune-cache                     # 只清过期二级缓存目录
 *
 * 归档动作：
 *   1. 按表把 date < before 的行 COPY 成 parquet 落到 data/archive/
 *   2. 校验 parquet 行数与预期一致（不一致就中止，不删任何行）
 *   3. 只有加了 --confirm 才 DELETE；**先落盘再删**，顺序不可反
 */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const log = require('../lib/log');
const cache = require('../lib/cache');

/** 带 date 列的表，按 02 §附注 的保留策略分组 */
const TABLES = [
  { name: 'snapshot', dateCol: 'date', keep: 'permanent' },
  { name: 'prediction', dateCol: 'date', keep: 'permanent' },
  { name: 'reconcile', dateCol: 'date', keep: 'permanent' },
  { name: 'sector_member', dateCol: 'date', keep: '2y' },
  { name: 'sector_strength', dateCol: 'date', keep: 'permanent' },
  { name: 'strategy_signal', dateCol: 'date', keep: '2y' },
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (n) => process.argv.includes('--' + n);

function ownDbPath() {
  const engine = (config.storage && config.storage.engine) || 'auto';
  if (engine === 'jsonl') throw new Error('当前 storage.engine=jsonl，没有可归档的 DuckDB 文件');
  return config.abs((config.storage && config.storage.ownDb) || 'data/ql.duckdb');
}

async function main() {
  const t0 = Date.now();

  if (has('prune-cache')) {
    const r = cache.prune();
    console.log(`二级缓存清理：删除 ${r.removed} 个过期目录，保留 ${r.kept} 个（config.cache.keepDays）`);
    return;
  }

  const before = arg('before', null);
  if (!before || before === true) {
    console.error('必须指定 --before YYYY-MM-DD（归档该日期之前的数据）');
    process.exitCode = 1;
    return;
  }
  const beforeStr = String(before).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeStr)) {
    console.error('--before 格式必须是 YYYY-MM-DD，实际：' + before);
    process.exitCode = 1;
    return;
  }

  const dbPath = ownDbPath();
  if (!fs.existsSync(dbPath)) throw new Error('自有库不存在：' + dbPath);

  const dryRun = !has('confirm');
  const outDir = path.join(config.__root, 'data', 'archive');
  fs.mkdirSync(outDir, { recursive: true });

  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();

  const plan = [];
  try {
    for (const t of TABLES) {
      const exists = await conn.runAndReadAll(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = ?", [t.name]
      );
      if (!Number(exists.getRowObjects()[0].n)) { plan.push({ table: t.name, rows: 0, note: '表不存在' }); continue; }
      const r = await conn.runAndReadAll(
        `SELECT COUNT(*) AS n FROM ${t.name} WHERE ${t.dateCol} < CAST(? AS DATE)`, [beforeStr]
      );
      plan.push({ table: t.name, rows: Number(r.getRowObjects()[0].n), keep: t.keep, dateCol: t.dateCol });
    }

    console.log(`归档计划（before=${beforeStr}${dryRun ? ' · dry-run' : ' · 将执行删除'}）`);
    let total = 0;
    for (const p of plan) { total += p.rows; console.log(`  ${p.table.padEnd(16)} ${String(p.rows).padStart(8)} 行${p.note ? '  (' + p.note + ')' : ''}`); }
    console.log(`  合计 ${total} 行；保留策略：${TABLES.map((t) => t.name + '=' + t.keep).join(', ')}`);

    if (dryRun) { console.log('\n这是 dry-run，没有改动任何数据。确认无误后加 --confirm 执行。'); return; }
    if (total === 0) { console.log('\n没有可归档的行，未做任何改动。'); return; }

    // 1. 先落盘（parquet），并校验行数
    for (const p of plan) {
      if (!p.rows) continue;
      const out = path.join(outDir, `${p.table}-before-${beforeStr}.parquet`);
      await conn.run(
        `COPY (SELECT * FROM ${p.table} WHERE ${p.dateCol} < CAST(? AS DATE)) TO '${out.replace(/'/g, "''")}' (FORMAT PARQUET)`,
        [beforeStr]
      );
      const chk = await conn.runAndReadAll(
        `SELECT COUNT(*) AS n FROM read_parquet('${out.replace(/'/g, "''")}')`
      );
      const n = Number(chk.getRowObjects()[0].n);
      if (n !== p.rows) {
        throw new Error(`${p.table} 归档校验失败：预期 ${p.rows} 行，parquet 里只有 ${n} 行，已中止（未删除任何行）`);
      }
      p.parquet = out;
      p.verified = n;
      log.info('archive.written', { table: p.table, rows: n, file: out });
      console.log(`  ✓ ${p.table} → ${path.relative(config.__root, out)}（校验 ${n} 行）`);
    }

    // 2. 校验全过才删
    for (const p of plan) {
      if (!p.verified) continue;
      await conn.run(`DELETE FROM ${p.table} WHERE ${p.dateCol} < CAST(? AS DATE)`, [beforeStr]);
      const left = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${p.table} WHERE ${p.dateCol} < CAST(? AS DATE)`, [beforeStr]);
      const remain = Number(left.getRowObjects()[0].n);
      if (remain !== 0) throw new Error(`${p.table} 删除后仍有 ${remain} 行早于 ${beforeStr}`);
      console.log(`  ✓ ${p.table} 已删除 ${p.verified} 行`);
    }
    console.log(`\n完成，耗时 ${Date.now() - t0}ms。parquet 在 ${path.relative(config.__root, outDir)}/，原库已瘦身。`);
  } finally {
    try { conn.closeSync(); } catch (e) { console.warn('关闭连接失败（不影响归档结果）：' + e.message); }
    try { inst.closeSync(); } catch (e) { console.warn('关闭实例失败（不影响归档结果）：' + e.message); }
  }
}

main().catch((e) => {
  log.error('archive.failed', { error: e.message, stack: e.stack });
  console.error('归档失败：' + e.message);
  process.exitCode = 1;
});
