'use strict';
/**
 * 三期 L1 纯函数单测（docs/dev/05 §9 / 07 §4.3）。
 * 无网络；Python 相关用例通过注入的确定性计算函数验证 Node 侧协议逻辑。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../lib/config');
const gates = require('../../lib/gates');
const py = require('../../lib/pyrunner');
const strategies = require('../../lib/strategy');

let pass = 0, fail = 0;
const pending = [];
function atest(name, fn) {
  return fn().then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  );
}
function test(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); return; }
  // async 用例统一挂起，末尾 await，避免断言落进未处理的 Promise
  if (r && typeof r.then === 'function') { pending.push(atest(name, () => r)); return; }
  pass++; console.log('  ✓ ' + name);
}

console.log('三期纯函数');

/* ---------- 五道闸三档 ---------- */
const allTrue = { a: { pass: true }, b: { pass: true }, c: { pass: true } };
test('五道全 pass=true → usable', () => {
  assert.strictEqual(gates.verdictOf(allTrue), 'usable');
});
test('任一 pass=false → unusable', () => {
  assert.strictEqual(gates.verdictOf({ a: { pass: true }, b: { pass: false }, c: { pass: null } }), 'unusable');
});
test('有 pass=null 且无 false → doubtful（null 绝不等于通过）', () => {
  assert.strictEqual(gates.verdictOf({ a: { pass: true }, b: { pass: null } }), 'doubtful');
});
test('aggregateGates：第 5 道无 Python 版 → doubtful，不是 usable', () => {
  const r = gates.aggregateGates({
    futurePass: true, isRet: 0.31, oosRet: 0.18, oosBars: 300,
    tested: 50, positive: 40,
    phases: { bull: { ret: 0.28, days: 120 }, bear: { ret: -0.01, days: 100 }, range: { ret: 0.09, days: 150 } },
    hasBoth: false, agreeRate: null,
  });
  assert.strictEqual(r.gates.dual.pass, null);
  assert.strictEqual(r.verdict, 'doubtful');
});
test('aggregateGates：第 2 道 false → unusable，且结论优先于 doubtful', () => {
  const r = gates.aggregateGates({
    futurePass: true, isRet: -0.1, oosRet: 0.1, oosBars: 300,
    tested: 50, positive: 40, phases: {}, hasBoth: false,
  });
  assert.strictEqual(r.gates.isOos.pass, false);
  assert.strictEqual(r.verdict, 'unusable');
});

/* ---------- 各闸边界 ---------- */
test('oos 段 < 100 根 → 第 2 道 pass=null', () => {
  const r = gates.evalIsOos(0.3, 0.2, 99);
  assert.strictEqual(r.pass, null);
});
test('is.ret <= 0 → 第 2 道直接不通过', () => {
  assert.strictEqual(gates.evalIsOos(0, 0.2, 200).pass, false);
});
test('衰减 decay=(is-oos)/|is|，超 maxDecay 不通过', () => {
  const r = gates.evalIsOos(0.4, 0.1, 200);
  assert.ok(Math.abs(r.decay - 0.75) < 0.001, String(r.decay));
  assert.strictEqual(r.pass, false);
});
test('有效标的 < 30 → 第 3 道 null', () => {
  assert.strictEqual(gates.evalUniverse(10, 8).pass, null);
});
test('正收益比例 0.5 → 第 3 道通过', () => {
  assert.strictEqual(gates.evalUniverse(50, 25).pass, true);
});
test('某段样本 < 60 日 → 第 4 道 doubtful', () => {
  const r = gates.evalPhase({
    bull: { ret: 0.3, days: 120 }, bear: { ret: 0.1, days: 20 }, range: { ret: 0.1, days: 120 },
  });
  assert.strictEqual(r.pass, null);
  assert.strictEqual(r.phases.bear, null);
});
test('三段收益均 >= -0.05 → 第 4 道通过', () => {
  const r = gates.evalPhase({
    bull: { ret: 0.3, days: 120 }, bear: { ret: -0.04, days: 100 }, range: { ret: 0.1, days: 120 },
  });
  assert.strictEqual(r.pass, true);
});
test('仅公式版 → 第 5 道 null（不是通过）', () => {
  assert.strictEqual(gates.evalDual(false, null).pass, null);
});
test('双轨一致率 0.99 通过 / 0.98 不通过', () => {
  assert.strictEqual(gates.evalDual(true, 0.99).pass, true);
  assert.strictEqual(gates.evalDual(true, 0.98).pass, false);
});

/* ---------- 动态未来函数检测 ---------- */
test('signalsDiffer：相同序列 false，任一不同 true', () => {
  assert.strictEqual(gates.signalsDiffer([0, 1, 0], [0, 1, 0]), false);
  assert.strictEqual(gates.signalsDiffer([0, 1, 0], [0, 0, 0]), true);
  assert.strictEqual(gates.signalsDiffer([0, 1], [0, 1, 0]), true);
});
test('detectFuture：加数据后历史信号变了 → pass=false（中间变量藏未来也抓得到）', async () => {
  const n = 80, k = config.gates.dynamicK, m = n - k;
  const dates = Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const ohlcv = { datetime: dates, close: dates.map(() => 10), open: [], high: [], low: [], vol: [], amount: [] };
  // 模拟「前 M 根时第 3 根有信号；多给 K 根数据后第 3 根信号消失」= 未来函数的定义
  const call = async (req) => {
    const len = req.ohlcv.datetime.length;
    const s = new Array(len).fill(0);
    if (len <= m) s[2] = 1;
    return { ok: true, outputs: { BUY: s } };
  };
  const r = await gates.detectFuture('X:=REF(C,-1); BUY:X>C;', 'BUY', ohlcv, { call });
  assert.strictEqual(r.pass, false, JSON.stringify(r));
  assert.strictEqual(r.compared, m);
});
test('detectFuture：两段信号一致 → pass=true', async () => {
  const n = 80, k = config.gates.dynamicK;
  const dates = Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const ohlcv = { datetime: dates, close: dates.map(() => 10), open: [], high: [], low: [], vol: [], amount: [] };
  const call = async (req) => ({ ok: true, outputs: { BUY: new Array(req.ohlcv.datetime.length).fill(0) } });
  const r = await gates.detectFuture('BUY:CROSS(C,MA(C,20));', 'BUY', ohlcv, { call });
  assert.strictEqual(r.pass, true);
  void k;
});
test('detectFuture：数据不足 → pass=null（不假判）', async () => {
  const ohlcv = { datetime: Array.from({ length: 20 }, (_, i) => `d${i}`) };
  const r = await gates.detectFuture('BUY:C>O;', 'BUY', ohlcv, { call: async () => ({ ok: true }) });
  assert.strictEqual(r.pass, null);
});

/* ---------- runner 协议 ---------- */
test('parseLastJson：Python 输出前有 print 仍能解析最后一行', () => {
  const out = '{"ok": false, "junk": true}\ndebug line\n{"ok":true,"task":"run"}';
  const r = py.parseLastJson(out);
  assert.ok(r && r.ok === true && r.task === 'run');
});
test('parseLastJson：stdout 空或非 JSON → null', () => {
  assert.strictEqual(py.parseLastJson(''), null);
  assert.strictEqual(py.parseLastJson('not json'), null);
});
test('parseLastJson 导出可用（变异目标）', () => {
  assert.strictEqual(typeof py.parseLastJson, 'function');
});

/* ---------- 自动降级 ---------- */
test('实盘低于回测 0.15 以上 → 触发 suspect', () => {
  assert.strictEqual(gates.shouldDegrade(0.30, 0.50), true);
  assert.strictEqual(gates.shouldDegrade(0.36, 0.50), false);
  assert.strictEqual(gates.shouldDegrade(null, 0.5), false);
});

/* ---------- 策略版本与高危禁存（异步） ---------- */
(async () => {
  await Promise.all(pending);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-st-'));
  const old = config.__root;
  config.__root = root;
  try {
    await atest('策略保存版本从 1 递增到 2，旧版进 archives', async () => {
      const a = await strategies.save({ name: '均线突破', type: 'formula', source: 'BUY:CROSS(C,MA(C,20));', outputLine: 'BUY' });
      assert.strictEqual(a.version, 1);
      const b = await strategies.save({ id: a.id, name: a.name, type: 'formula', source: 'BUY:CROSS(C,MA(C,10));', outputLine: 'BUY' });
      assert.strictEqual(b.version, 2);
      assert.strictEqual(strategies.list().length, 1);
      assert.strictEqual(strategies.archives(a.id).length, 1);
    });
    await atest('含高危未来函数 → 拒绝保存', async () => {
      let err = null;
      try {
        await strategies.save({ name: '未来', type: 'formula', source: 'BUY:ZIG(3,5);', outputLine: 'BUY', scanLevel: 'high' });
      } catch (e) { err = e; }
      assert.ok(err && /禁止保存/.test(err.message), err && err.message);
    });
    await atest('outputLine 缺失 → 报错（不许自动猜）', async () => {
      let err = null;
      try { await strategies.save({ name: '缺输出线', source: 'BUY:C>O;' }); }
      catch (e) { err = e; }
      assert.ok(err && /outputLine/.test(err.message));
    });
  } finally {
    config.__root = old;
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${fail ? '✗' : '✓'} 三期纯函数：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
