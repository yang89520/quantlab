'use strict';
/**
 * 板块等权指数的两个真实事故回归（docs/dev/10 §3.3 / 09 §D5）。
 *
 * 事故 1 · 跨市场同号串行
 *   上游 kline_daily 里同一个 6 位代码可能同时存在两个市场：000001 有
 *   sh（上证指数 ≈3700 点）与 sz（平安银行 ≈11 元）。取数只按 code 过滤时，
 *   两条序列按日期交错进同一个数组，aggregate 的 prevClose 被来回覆盖，
 *   单日涨跌幅算出 ±30000%，金融行业板块 ret20 变成 28502%。
 *   全库共 5 个这样的 code：000001 / 000016 / 000688 / 000852 / 000905。
 *
 * 事故 2 · upsert 同批重复主键
 *   duckdao.upsert 是「先 DELETE 后 INSERT」。同一批里若出现重复主键，
 *   DELETE 时库里还没有这些键（删不到），INSERT 一次塞两行同主键 → 约束报错。
 *   上游成分股列表确实会重复返回同一只票（new_qtxy 的 000795 出现两次）。
 *
 * 夹具库现造现删，不进仓库。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++; console.log('  ✓ ' + name);
  } catch (e) {
    failed++; console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-sector-'));
const FIXTURE = path.join(TMP, 'market.db');

/** 夹具库：000001 同时存在 sh（指数价位）与 sz（个股价位）两条序列 */
async function buildFixtureDb() {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(FIXTURE);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE kline_daily (
    market VARCHAR, code VARCHAR, date INTEGER,
    open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
    volume DOUBLE, amount DOUBLE, factor DOUBLE)`);
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i));
    const n = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    // sh000001 = 指数：3600 点量级
    await conn.run('INSERT INTO kline_daily VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['sh', '000001', n, 3600, 3620, 3580, 3600 + i, 1e8, 1e10, null]);
    // sz000001 = 平安银行：11 元量级
    await conn.run('INSERT INTO kline_daily VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['sz', '000001', n, 11, 11.3, 10.9, 11 + i * 0.01, 2e7, 2e8, null]);
  }
  conn.closeSync();
  inst.closeSync();
}

/** 造一段只有「某只票单日暴涨 300 倍」的脏数据，用于验证边界剔除 */
function dirtyKlines() {
  const dates = [];
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i));
    const p = (x) => String(x).padStart(2, '0');
    dates.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
  }
  const clean = (base) => dates.map((d, i) => [d, base, base + i * 0.01, base + 0.2, base - 0.1, 1e6, 1e7]);
  const out = {};
  for (let k = 0; k < 6; k++) out['sz00000' + k] = clean(10 + k);
  // 第 7 只票：第 12 天直接从 12 元跳到 3600 元（除权未复权/脏数据的典型形态）
  const bad = dates.map((d, i) => [d, 12, i === 11 ? 3600 : 12 + i * 0.01, 12.2, 11.9, 1e6, 1e7]);
  out.sz000006 = bad;
  return out;
}

(async () => {
  console.log('板块指数回归（10 §3.3 / 09 §D5）');

  const config = require(path.join(ROOT, 'lib', 'config'));
  const originalLocalDb = JSON.parse(JSON.stringify(config.localDb));
  await buildFixtureDb();
  config.localDb.enabled = true;
  config.localDb.marketDb = FIXTURE;

  const localdb = require(path.join(ROOT, 'lib', 'sources', 'adapters', 'local-db'));
  const { aggregateSector } = require(path.join(ROOT, 'lib', 'sources', 'adapters', 'aggregate'));

  // ---------------- 事故 1 ----------------
  await check('取数按 (market, code) 分离：000001 不会把上证指数和平安银行串成一条', async () => {
    const out = await localdb.readMemberKlines(['000001'], 250);
    const rows = out['000001'] || [];
    assert.ok(rows.length > 0, '没取到任何 K 线');
    assert.strictEqual(rows.length, 30, '两条序列被合并了，实际 ' + rows.length + ' 根（应为 30 根单序列）');
    const closes = rows.map((r) => Number(r[2]));
    const max = Math.max.apply(null, closes);
    const min = Math.min.apply(null, closes);
    assert.ok(max < 100, '取到的是 sh000001（上证指数，3600 点），说明市场判错：max=' + max);
    assert.ok(min >= 11, '取到的收盘价低于 11 元，序列可能混了两个市场：min=' + min);
    return true;
  });

  await check('显式带市场前缀时以调用方为准（sh000001 取指数那条）', async () => {
    const out = await localdb.readMemberKlines(['sh000001'], 250);
    const rows = out['000001'] || [];
    assert.ok(rows.length > 0, '没取到任何 K 线');
    const max = Math.max.apply(null, rows.map((r) => Number(r[2])));
    assert.ok(max > 1000, '显式要 sh 却取到了个股序列：max=' + max);
    return true;
  });

  await check('分离后等权指数不会算出天文数字', async () => {
    const out = await localdb.readMemberKlines(['000001'], 250);
    const agg = aggregateSector({ 'sz000001': out['000001'] }, {});
    const last = agg.meta[agg.meta.length - 1];
    assert.ok(Number.isFinite(last.index), '指数不是有限数：' + last.index);
    assert.ok(last.index > 500 && last.index < 2000, '指数严重偏移基准 1000：' + last.index);
    const worst = agg.meta.reduce((a, b) => Math.max(a, Math.abs(b.chg || 0)), 0);
    assert.ok(worst < 0.11, '单日涨跌幅超出合理范围：' + (worst * 100).toFixed(2) + '%');
    return true;
  });

  // ---------------- 边界剔除 ----------------
  await check('单只成分股单日 +300 倍被视为非交易性变动，剔除该样本', async () => {
    const agg = aggregateSector(dirtyKlines(), { config: { base: 1000, minMembers: 5, maxDailyChg: 0.31 } });
    // 跳变的两端都要剔：暴涨日（12→3600）与回落日（3600→12.13）都不是交易性涨跌。
    // 只剔一端的话，另一端会把 -99.67% 留在均值里，指数照样被打穿。
    const dropped = agg.meta.filter((m) => m.droppedCount > 0);
    assert.strictEqual(dropped.length, 2, '跳变的两个端点都应剔除，实际 ' + dropped.length + ' 天');
    const total = agg.meta.reduce((a, b) => a + b.droppedCount, 0);
    assert.strictEqual(total, 2, '应当共剔除 2 个样本，实际 ' + total);
    const worst = agg.meta.reduce((a, b) => Math.max(a, Math.abs(b.chg || 0)), 0);
    assert.ok(worst < 0.31, '剔除后仍有超限日涨跌幅：' + (worst * 100).toFixed(2) + '%');
    const last = agg.meta[agg.meta.length - 1];
    assert.ok(last.index > 500 && last.index < 2000, '指数被单只票带飞：' + last.index);
    return true;
  });

  await check('正常样本不被误剔（±10% 以内的日涨跌幅必须保留）', async () => {
    const dates = [];
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.UTC(2026, 9, 1 + i));
      const p = (x) => String(x).padStart(2, '0');
      dates.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
    }
    const out = {};
    for (let k = 0; k < 6; k++) {
      out['sz00000' + k] = dates.map((d, i) => [d, 10, i === 10 ? 10.9 : 10, 10.2, 9.9, 1e6, 1e7]);
    }
    const agg = aggregateSector(out, {});
    assert.strictEqual(agg.meta.reduce((a, b) => a + b.droppedCount, 0), 0, '正常涨跌被误剔了');
    const d10 = agg.meta.find((m) => m.chg != null && Math.abs(m.chg - 0.09) < 1e-9);
    assert.ok(d10, '9% 的单日涨幅没被算进等权涨跌幅');
    return true;
  });

  // ---------------- 事故 2 ----------------
  await check('dupkey: upsert 同一批内主键重复不再抛约束错误', async () => {
    config.storage.ownDb = path.join(TMP, 'own.duckdb');
    const duckdao = require(path.join(ROOT, 'lib', 'dao', 'duckdao'));
    const store = duckdao.create(path.join(TMP, 'own.duckdb'), {});
    await store.migrate();
    const date = '2026-11-13';
    const rows = [
      { date, sector: 'new_qtxy', code: '000795' },
      { date, sector: 'new_qtxy', code: '000795' },   // 上游列表重复返回
      { date, sector: 'new_qtxy', code: '000796' },
    ];
    const n = await store.upsert('sector_member', rows);
    assert.strictEqual(n, 2, '去重后应写入 2 行，实际 ' + n);
    const back = await store.query('sector_member', { where: { date, sector: 'new_qtxy' } });
    assert.strictEqual(back.length, 2, '库里应只有 2 行，实际 ' + back.length);
    const codes = back.map((r) => String(r.code)).sort();
    assert.deepStrictEqual(codes, ['000795', '000796'], '数据不对：' + codes.join(','));
    return true;
  });

  config.localDb = originalLocalDb;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' 板块指数回归：'
    + pass + ' 通过 / ' + failed + ' 失败');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error('用例自身崩了：' + e.stack);
  process.exitCode = 1;
});
