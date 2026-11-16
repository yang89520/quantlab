'use strict';
/**
 * 历史快照合成 + 历史日护栏回归（docs/dev/09 §D3 / 10 §3.3）。
 *
 * 两件事必须钉死：
 *   1. capture(date) 绝不能把「此刻的网络快照」标成历史日期。
 *      以前 implementation 就是用调用方传的 date 给行打标签，于是
 *      `daily-close --date 2026-11-13` 会把今天的行情写进 11-13 —— 库里凭空
 *      多出一份标错日期的假历史，而且看起来完全正常（D3 最危险的形态）。
 *   2. captureFromLocal(date) 从上游日线合成历史快照时：
 *      · 只取 A 股个股，不把指数混进来（000001 在 sh 是指数、在 sz 是平安银行）
 *      · 上游没有的字段（换手率/流通市值）落 null，不猜
 *      · 非交易日直接报错，不退到别的日期
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-snap-'));

// 必须先改 config 再 require lib —— lib/dao 首次 open 后会把 store 缓存住，
// 之后再改 ownDb 不生效（实测踩过：改成临时路径后写入的还是正式库）。
const config = require(path.join(ROOT, 'lib', 'config'));
const FIXTURE = path.join(TMP, 'market.db');
config.localDb.enabled = true;
config.localDb.marketDb = FIXTURE;
config.storage.ownDb = path.join(TMP, 'own.duckdb');

/** 造夹具：3 个交易日，含个股、创业板、北交所，以及一个 sh 指数（必须被排除） */
async function buildFixtureDb() {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(FIXTURE);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE kline_daily (
    market VARCHAR, code VARCHAR, date INTEGER,
    open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
    volume DOUBLE, amount DOUBLE, factor DOUBLE)`);
  const days = [20261001, 20261002, 20261003];
  const ins = async (market, code, base) => {
    for (let i = 0; i < days.length; i++) {
      const open = base + i;
      const close = base + i + 0.5;
      const high = base + i + 1;
      const low = base + i - 1;
      await conn.run('INSERT INTO kline_daily VALUES (?,?,?,?,?,?,?,?,?,?)',
        [market, code, days[i], open, high, low, close, 1e6, 1e7, null]);
    }
  };
  await ins('sh', '600000', 10);     // 浦发银行（个股，保留）
  await ins('sz', '000001', 11);     // 平安银行（个股，保留）
  await ins('sz', '300750', 100);    // 宁德时代（创业板，保留）
  await ins('bj', '830799', 20);     // 北交所，保留
  await ins('sh', '000001', 3600);   // 上证指数（不是个股，必须被排除）
  conn.closeSync();
  inst.closeSync();
}

(async () => {
  console.log('历史快照合成 + 历史日护栏（09 §D3 / 10 §3.3）');

  await buildFixtureDb();
  const snapLib = require(path.join(ROOT, 'lib', 'snapshot'));
  const ds = require(path.join(ROOT, 'lib', 'datasource'));

  // ---------------- 合成 ----------------
  await check('合成只取 A 股个股：sh000001（指数）不进快照', async () => {
    const rec = await snapLib.captureFromLocal('2026-10-02');
    assert.strictEqual(rec.synthesized, true, '没标 synthesized');
    assert.strictEqual(rec.count, 4, '应有 4 只个股，实际 ' + rec.count);
    const m = await snapLib.readMap('2026-10-02');
    assert.ok(m.has('600000'), '缺 600000');
    assert.ok(m.has('000001'), '缺 000001（平安银行）');
    assert.ok(m.has('300750'), '缺 300750');
    assert.ok(m.has('830799'), '缺 830799');
    // 关键：sh000001 与 sz000001 同号，白名单必须留下 sz 那条、扔掉 sh 指数
    assert.strictEqual(String(m.get('000001').market), 'sz',
      '000001 取到了 sh（指数），市场判错');
    assert.ok(Number(m.get('000001').price) < 100, '000001 价格是指数量级，说明取错了市场');
    return true;
  });

  await check('涨跌幅与振幅按上游日线正确推导（口径与网络源一致）', async () => {
    const m = await snapLib.readMap('2026-10-02');
    const r = m.get('600000');
    // 10-01 收 10.5，10-02 收 11.5 → (11.5/10.5-1)*100 = 9.5238%
    assert.ok(Math.abs(Number(r.chg_pct) - 9.5238) < 0.01,
      'chg_pct 不对：' + r.chg_pct + '（期望 9.5238）');
    // amplitude = (high-low)/prev_close*100 = (12-10)/10.5*100 = 19.05
    assert.ok(Math.abs(Number(r.amplitude) - 19.05) < 0.02,
      'amplitude 不对：' + r.amplitude + '（期望 19.05）');
    return true;
  });

  await check('上游没有的字段落 null，不猜（换手率 / 流通市值）', async () => {
    const m = await snapLib.readMap('2026-10-02');
    const r = m.get('600000');
    assert.strictEqual(r.turnover, null, 'turnover 应为 null，实际 ' + r.turnover);
    assert.strictEqual(r.float_cap, null, 'float_cap 应为 null，实际 ' + r.float_cap);
    return true;
  });

  await check('非交易日直接报错，不退到别的日期', async () => {
    let err = null;
    try { await snapLib.captureFromLocal('2026-10-04'); } catch (e) { err = e; }
    assert.ok(err, '非交易日居然成功了（这是伪造历史）');
    assert.ok(/不是上游库里的交易日/.test(err.message), '报错不明确：' + err.message);
    return true;
  });

  await check('同日重复合成幂等（行数不变）', async () => {
    const a = await snapLib.captureFromLocal('2026-10-02');
    const b = await snapLib.captureFromLocal('2026-10-02');
    assert.strictEqual(a.count, b.count, '两次合成行数不一致');
    const m = await snapLib.readMap('2026-10-02');
    assert.strictEqual(m.size, 4, '重复合成后行数变了：' + m.size);
    return true;
  });

  // ---------------- 护栏 ----------------
  await check('capture(历史日) 必须拒绝：不许把此刻的行情标成历史日期', async () => {
    // 网络层用替身：模拟「此刻的实时快照实际属于 2026-10-03」
    const real = ds.resolve;
    ds.resolve = async () => ({
      data: [{ code: '600000', symbol: 'sh600000', price: 12, chgPct: 1.1, amount: 1e7 }],
      source: 'stub-network', level: 'B', asOf: '2026-10-03', stale: true, degraded: false, missing: [],
    });
    let err = null;
    try { await snapLib.capture('2026-10-01'); } catch (e) { err = e; }
    ds.resolve = real;
    assert.ok(err, '历史日居然写成功了（D3 违规）');
    assert.ok(/标错日期/.test(err.message), '报错没说清原因：' + err.message);
    assert.ok(/--from-local/.test(err.message), '报错没指向正确做法：' + err.message);
    return true;
  });

  await check('capture(数据真实所属日) 正常写入，不误拦', async () => {
    const real = ds.resolve;
    ds.resolve = async () => ({
      data: [{ code: '600000', symbol: 'sh600000', price: 12, chgPct: 1.1, amount: 1e7 }],
      source: 'stub-network', level: 'B', asOf: '2026-10-03', stale: false, degraded: false, missing: [],
    });
    let rec = null;
    let err = null;
    try { rec = await snapLib.capture('2026-10-03'); } catch (e) { err = e; }
    ds.resolve = real;
    assert.ok(!err, '请求日与 asOf 一致却被拦了：' + (err && err.message));
    assert.strictEqual(rec.date, '2026-10-03');
    assert.strictEqual(rec.count, 1);
    return true;
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' 历史快照：' + pass + ' 通过 / ' + failed + ' 失败');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error('用例自身崩了：' + e.stack);
  process.exitCode = 1;
});
