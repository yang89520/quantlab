'use strict';
/**
 * 对账集成测试（docs/dev/03 §7.2）
 * 真实历史需要连续两天的快照，这里用夹具构造「昨日预判 + 今日快照」的四种情形。
 * 运行：npm run test:unit
 */
const assert = require('assert');
const { reconcile } = require('../../lib/reconcile');

const CFG = {
  integrity: { minSnapshotCount: 4000 },
};

function bars(prevClose, todayClose, n = 3) {
  const out = [];
  let p = prevClose;
  for (let i = 0; i < n - 1; i++) out.push([`2026-11-0${i + 1}`, p, p, p, p, 1000, 0]);
  out.push(['2026-11-12', prevClose, prevClose, prevClose, prevClose, 1000, 0]);
  out.push(['2026-11-13', todayClose, todayClose, todayClose, todayClose, 1000, 0]);
  return out;
}

function pred(verdict, candidates, invalidIf) {
  return {
    date: '2026-11-12',
    targetDate: '2026-11-13',
    env: {
      verdict,
      score: 60,
      metrics: { close: 3400, ma20: 3380, ma60: 3300, volRatio: 1.1, breadth: 0.5 },
      invalidIf: invalidIf || [{ id: 'E2', metric: 'breadth', op: '<', value: 0.4 }],
    },
    candidates: candidates || [],
  };
}

function snapMap(prices, amplitude) {
  const m = new Map();
  for (const [code, price] of Object.entries(prices)) {
    m.set(code, { code, price, amplitude: amplitude == null ? 2 : amplitude });
  }
  return m;
}

function summary(map, breadth, count) {
  return { map, breadth, ztCount: 30, count: count === undefined ? 5000 : count };
}

let pass = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('对账五情形');

test('A. 判进攻 + 指数涨 + 候选多数上涨 → hit', () => {
  const r = reconcile(
    pred('attack', [{ code: '600986' }, { code: '000001' }]),
    snapMap({ 600986: 7.4, '000001': 11.2 }),
    summary(snapMap({ 600986: 7.6, '000001': 11.5 }), 0.6),
    bars(3400, 3440), CFG
  );
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(r.envResult.hit, true);
  assert.strictEqual(r.attribution, 'hit');
  assert.strictEqual(r.judgmentScore, 100);
});

test('B. 判进攻但指数下跌 → env（优先级最高）', () => {
  const r = reconcile(
    pred('attack', [{ code: '600986' }]),
    snapMap({ 600986: 7.4 }),
    summary(snapMap({ 600986: 7.5 }), 0.34),   // 宽度跌破 40% → 命中 E2
    bars(3400, 3378), CFG
  );
  assert.strictEqual(r.envResult.hit, false);
  assert.strictEqual(r.attribution, 'env');
  assert.ok(r.envResult.invalidHits.includes('E2'), '应命中 E2');
  assert.ok(r.judgmentScore <= 50);
});

test('C. 环境判对但候选全跌 → candidate', () => {
  const r = reconcile(
    pred('attack', [{ code: '600986' }, { code: '000001' }]),
    snapMap({ 600986: 7.4, '000001': 11.2 }),
    summary(snapMap({ 600986: 7.2, '000001': 11.0 }), 0.6),
    bars(3400, 3440), CFG
  );
  assert.strictEqual(r.envResult.hit, true);
  assert.strictEqual(r.candHitRatio, 0);
  assert.strictEqual(r.attribution, 'candidate');
});

test('D. 候选上涨但冲高回落（振幅>3% 且收跌）→ timing', () => {
  // 4 只里 3 只涨，1 只冲高回落 → 比例 0.75 不低于 0.4，再看 spikeFade
  const before = { A: 10, B: 10, C: 10, D: 10 };
  const after = { A: 10.2, B: 10.3, C: 10.1, D: 9.8 };
  const r = reconcile(
    pred('attack', [{ code: 'A' }, { code: 'B' }, { code: 'C' }, { code: 'D' }]),
    snapMap(before),
    summary(snapMap(after, 5.0), 0.6),          // 振幅 5% > 3
    bars(3400, 3440), CFG
  );
  assert.strictEqual(r.envResult.hit, true);
  assert.ok(r.candHitRatio >= 0.4, `candHitRatio=${r.candHitRatio}`);
  assert.strictEqual(r.attribution, 'timing');
});

test('E. 快照不完整 → skipped，不进统计', () => {
  const r = reconcile(
    pred('attack', [{ code: '600986' }]),
    snapMap({ 600986: 7.4 }),
    summary(snapMap({ 600986: 7.6 }), 0.6, 1200),   // 1200 < 4000
    bars(3400, 3440), CFG
  );
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.skipReason, 'incomplete');
  assert.strictEqual(r.judgmentScore, null);        // 不给出分数
});

test('F. 无快照 → skipped(no_snapshot)', () => {
  const r = reconcile(pred('attack', []), new Map(), null, bars(3400, 3440), CFG);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.skipReason, 'no_snapshot');
});

test('G. 候选缺数据时不拉低命中率（不计入分母）', () => {
  const r = reconcile(
    pred('attack', [{ code: '600986' }, { code: 'MISSING' }]),
    snapMap({ 600986: 7.4 }),                       // MISSING 昨日就没有
    summary(snapMap({ 600986: 7.6 }), 0.6),
    bars(3400, 3440), CFG
  );
  assert.strictEqual(r.candHitRatio, 1, '分母应只含有效候选');
  assert.strictEqual(r.candResults.find((c) => c.code === 'MISSING').reason, 'no_data');
});

console.log('');
if (fails.length) { console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`); process.exitCode = 1; }
else console.log(`✓ 全部通过（${pass} 项）`);
