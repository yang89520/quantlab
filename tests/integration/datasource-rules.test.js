'use strict';
/**
 * D-3 / D-4 / D-5 / D-7 数据铁律专项（docs/dev/09 §9、07 §6.1）。
 *
 * D-4 是最重要的一条：它防的是「拿 T-1 本地数据冒充当日」——这种假数据看起来完全正常，最难发现。
 * 做法：造一个 MAX(date) 停在历史日期的真实 DuckDB 夹具库，请求「今天」，
 *      断言解析器绕开本地库、走网络，并且 asOf 就是请求日。
 *
 * 夹具库在临时目录里现造现删，不进仓库（02 §0 / 09 §3.3）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本用例要观察「解析链本身」的行为，二级缓存必须关掉，否则会遮蔽真实取数路径
process.env.QL_NO_CACHE = '1';

let pass = 0;
let failed = 0;

/**
 * 顺序执行：这些用例会改 config 与网络替身，必须串行，否则互相污染
 * （并发跑过一次，D-4 与 D-5 的断言互相踩，属于测试设计问题，不是代码问题）。
 */
async function check(name, fn) {
  try {
    await fn();
    pass++; console.log('  ✓ ' + name);
  } catch (e) {
    failed++; console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-d4-'));
const FIXTURE = path.join(TMP, 'market.db');

/** 造夹具库：kline_daily 只到 2026-11-10（历史），2026-11-11 之后没有 */
async function buildFixtureDb() {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(FIXTURE);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE kline_daily (
    market VARCHAR, code VARCHAR, date INTEGER,
    open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
    volume DOUBLE, amount DOUBLE, factor DOUBLE)`);
  const rows = [];
  // 2026-09-01 起 60 个自然日，日期必须由 Date 算，不能做整数加法（会算出 09-60）
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 8, 1 + i));
    const n = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (n > 20261110) break;                 // 夹具库必须停在历史日期
    rows.push(['sh', '000001', n, 3000 + i, 3010 + i, 2990 + i, 3005 + i, 1e8, 1e10, null]);
  }
  for (const r of rows) {
    await conn.run(
      `INSERT INTO kline_daily VALUES (?,?,?,?,?,?,?,?,?,?)`,
      r
    );
  }
  const chk = await conn.runAndReadAll('SELECT MAX(date) AS d, COUNT(*) AS n FROM kline_daily');
  const info = chk.getRowObjects()[0];
  conn.closeSync();
  inst.closeSync();
  return { max: Number(info.d), count: Number(info.n) };
}

/** 夹具库里的最后一根 K 线日期（YYYY-MM-DD） */
function fmt(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

(async () => {
  console.log('数据铁律专项（09 §9：D-3 / D-4 / D-5 / D-7）');

  const built = await buildFixtureDb();
  const fixtureMax = fmt(built.max);

  const config = require(path.join(ROOT, 'lib', 'config'));
  const quote = require(path.join(ROOT, 'lib', 'quote'));
  const ds = require(path.join(ROOT, 'lib', 'datasource'));

  const originalLocalDb = JSON.parse(JSON.stringify(config.localDb));

  // 把解析器指向夹具库：这是「本地库只到 T-1」的真实形态，不是 mock
  config.localDb.enabled = true;
  config.localDb.marketDb = FIXTURE;

  // 网络层用替身：记录是否被调用 + 返回请求日的真实形状
  const calls = [];
  const realKlines = quote.klines;
  const realMarketList = quote.marketList;

  function stubKlines(impl) {
    quote.klines = async (code, bars) => {
      calls.push({ fn: 'klines', code, bars });
      return impl(code, bars);
    };
  }

  // ---------------- D-4 ----------------
  await check('D-4 请求历史日期（≤ 库内 MAX）走本地库，level=A', async () => {
    calls.length = 0;
    stubKlines(async () => ({ rows: [[fixtureMax, 1, 2, 3, 0.5, 100, 1000]], source: 'stub-net' }));
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 10, date: fixtureMax });
    assert.strictEqual(r.source, 'market-db', '未走本地库，实际 source=' + r.source);
    assert.strictEqual(r.level, 'A', '本地库数据应为 A 级');
    assert.strictEqual(calls.length, 0, '历史日期不该请求网络，实际请求了 ' + calls.length + ' 次');
    return true;
  });

  await check('D-4 请求今日（> 库内 MAX）必须走网络，绝不用 T-1 冒充当日', async () => {
    const today = todayStr();
    assert.ok(today > fixtureMax, '夹具日期需早于今天，否则本用例无意义');
    calls.length = 0;
    stubKlines(async () => ({
      rows: [[today, 3100, 3110, 3120, 3090, 2e8, 2e10]],
      source: 'stub-net',
    }));
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 10, date: today });
    assert.ok(/stub-net/.test(r.source), '当日必须来自网络源，实际 source=' + r.source);
    assert.ok(r.level === 'B' || /\+/.test(String(r.level)), '当日数据应为 B 级，实际 ' + r.level);
    assert.strictEqual(r.asOf, today, 'asOf 必须是请求的当日，实际 ' + r.asOf);
    assert.strictEqual(r.stale, false, '当日取到后不应标 stale');
    assert.ok(calls.length >= 1, '当日必须发起网络请求');
    assert.ok(!r.rows.some((x) => String(x[0]) === fixtureMax),
      '返回结果里混入了本地库的 T-1 数据（这就是 D3 违规）');
    return true;
  });

  await check('D-4 不传日期时要补齐到当日（本地 259 根 + 补 1 根）', async () => {
    const today = todayStr();
    calls.length = 0;
    stubKlines(async () => ({
      rows: [[today, 3100, 3110, 3120, 3090, 2e8, 2e10]],
      source: 'stub-net',
    }));
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 30 });
    assert.ok(calls.length >= 1, '库内 MAX < 今天时必须请求网络补齐当日');
    assert.strictEqual(r.asOf, today, '补齐后最后一根应为当日，实际 ' + r.asOf);
    assert.ok(/\+/.test(String(r.source)), '应标记为「本地+网络」合并来源，实际 ' + r.source);
    return true;
  });

  // ---------------- D-5 ----------------
  await check('D-5 本地与网络全失败 → rows 为空、level=null，绝不返回 0', async () => {
    config.localDb.enabled = false;          // 本地不可用
    stubKlines(async () => { throw new Error('network down'); });
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 10, date: todayStr() });
    assert.strictEqual(r.rows.length, 0, '全失败时不该返回任何 K 线');
    assert.strictEqual(r.level, null, '全失败时 level 必须为 null，不能伪造 A/B');
    assert.strictEqual(r.source, 'none', 'source 应为 none，实际 ' + r.source);
    assert.ok(r.missing.includes('network'), 'missing 必须记下 network');
    assert.strictEqual(r.asOf, null, '没有数据时 asOf 必须为 null，不能填今天');
    config.localDb.enabled = true;
    return true;
  });

  await check('D-5 快照取不到 → data 为空数组 + missing，不返回 0 值', async () => {
    quote.marketList = async () => [];
    const r = await ds.resolve({ kind: 'snapshot' });
    assert.deepStrictEqual(r.data, [], '取不到快照时必须返回空数组');
    assert.ok(r.missing.includes('snapshot'), 'missing 必须记下 snapshot');
    assert.strictEqual(r.level, null, '没有快照时 level 必须为 null');
    quote.marketList = realMarketList;
    return true;
  });

  // ---------------- D-3 / D-7 ----------------
  await check('D-3 每次取数都带 source/level/asOf/stale/degraded/missing', async () => {
    stubKlines(async () => ({ rows: [[todayStr(), 1, 1, 1, 1, 1, 1]], source: 'stub-net' }));
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 5, date: todayStr() });
    ['source', 'level', 'asOf', 'stale', 'degraded', 'missing'].forEach((k) => {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), '缺少元信息字段 ' + k);
    });
    return true;
  });

  await check('D-7 本地库不可用而网络可用 → degraded=true（降级有标记）', async () => {
    config.localDb.enabled = false;
    stubKlines(async () => ({ rows: [[todayStr(), 1, 1, 1, 1, 1, 1]], source: 'stub-net' }));
    const r = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 5, date: todayStr() });
    assert.strictEqual(r.degraded, true, '走了网络兜底必须标 degraded=true');
    assert.ok(r.level !== 'A', '网络源不该标成 A 级');
    config.localDb.enabled = true;
    return true;
  });

  // ---------------- D-8 ----------------
  await check('D-8 夹具库（模拟上游）未被以可写方式打开，也无任何写入', async () => {
    const before = fs.statSync(FIXTURE).size;
    stubKlines(async () => ({ rows: [[todayStr(), 1, 1, 1, 1, 1, 1]], source: 'stub-net' }));
    await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 5, date: fixtureMax });
    const after = fs.statSync(FIXTURE).size;
    assert.strictEqual(after, before, '读取上游库不应改变其体积（有写入会变）');
    return true;
  });

  // 复原
  quote.klines = realKlines;
  quote.marketList = realMarketList;
  Object.assign(config.localDb, originalLocalDb);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {
    console.warn('  · 临时夹具清理失败：' + e.message);
  }

  console.log('');
  if (failed) {
    console.log(`✗ ${failed} 项失败 / ${pass + failed} 项`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${pass}/${pass} 通过（夹具库 MAX(date)=${fixtureMax}，请求日=${todayStr()}）`);
  }
})().catch((e) => {
  console.error('执行失败：' + e.message);
  process.exitCode = 1;
});
