'use strict';
/**
 * 二期归因 direction 集成测试（docs/dev/04 §7.2、07 §7 交叉组合表）。
 * 重点验证：direction 必须排在 candidate 之前；null 既不判错也不算通过。
 */
const assert = require('assert');
const { reconcile, attribute } = require('../../lib/reconcile');
const { rankInAll } = require('../../lib/sector');

const CFG = { integrity: { minSnapshotCount: 4000 } };

function bars(prevClose, todayClose) {
  return [
    ['2026-11-11', prevClose, prevClose, prevClose, prevClose, 1000, 0],
    ['2026-11-12', prevClose, prevClose, prevClose, prevClose, 1000, 0],
    ['2026-11-13', todayClose, todayClose, todayClose, todayClose, 1000, 0],
  ];
}
function pred(verdict, mainline, candidates) {
  return {
    date: '2026-11-12', targetDate: '2026-11-13',
    env: {
      verdict, score: 60,
      metrics: { close: 3400, ma20: 3380, ma60: 3300, volRatio: 1.1, breadth: 0.5 },
      invalidIf: [],
    },
    candidates: candidates === undefined ? [] : candidates,
    mainline: mainline || null,
  };
}
function snapMap(prices) {
  const m = new Map();
  for (const [code, price] of Object.entries(prices)) m.set(code, { code, price, amplitude: 2 });
  return m;
}
function summary(map) { return { map, breadth: 0.6, ztCount: 30, count: 5000 }; }
function board(aScore) {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push({ sector: `new_b${i}`, name: `板块${i}`, type: 'industry', grade: 'C', score: 100 - i * 5 });
  }
  rows.push({ sector: 'new_a', name: '昨日A档', type: 'industry', grade: 'D', score: aScore });
  return rows;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('二期 · 归因优先级交叉组合（07 §7）');

const CROSS = [
  { envHit: false, directionHit: false, candHitRatio: 0.9, hasSpikeFade: false, want: 'env' },
  { envHit: false, directionHit: true, candHitRatio: 0.1, hasSpikeFade: true, want: 'env' },
  { envHit: true, directionHit: false, candHitRatio: 0.9, hasSpikeFade: false, want: 'direction' },
  { envHit: true, directionHit: false, candHitRatio: 0.1, hasSpikeFade: true, want: 'direction' },
  { envHit: true, directionHit: true, candHitRatio: 0.2, hasSpikeFade: false, want: 'candidate' },
  { envHit: true, directionHit: true, candHitRatio: 0.8, hasSpikeFade: true, want: 'timing' },
  { envHit: true, directionHit: true, candHitRatio: 0.8, hasSpikeFade: false, want: 'hit' },
  { envHit: true, directionHit: null, candHitRatio: 0.8, hasSpikeFade: false, want: 'hit' },
];
for (const c of CROSS) {
  test(`env=${c.envHit} dir=${c.directionHit} cand=${c.candHitRatio} fade=${c.hasSpikeFade} → ${c.want}`, () => {
    assert.strictEqual(attribute(c), c.want);
  });
}

console.log('二期 · 板块对账（04 §7.2）');

test('A 档板块次日全部跌出前 30% → attribution=direction', () => {
  const p = pred('attack', { sectors: [{ code: 'new_a', name: '昨日A档', grade: 'A' }] });
  const r = reconcile(p, snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG,
    { sectorsToday: board(1) });
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(r.envResult.hit, true, '环境应判对');
  assert.strictEqual(r.directionResult.hit, false, JSON.stringify(r.directionResult));
  assert.strictEqual(r.attribution, 'direction');
});

test('env 错且 direction 也错 → attribution=env（优先级最高）', () => {
  const p = pred('defend', { sectors: [{ code: 'new_a', name: '昨日A档', grade: 'A' }] });
  const r = reconcile(p, snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG,
    { sectorsToday: board(1) });
  assert.strictEqual(r.envResult.hit, false);
  assert.strictEqual(r.directionResult.hit, false);
  assert.strictEqual(r.attribution, 'env');
});

test('direction 优先于 candidate：方向错且候选全跌仍是 direction', () => {
  const p = pred('attack', { sectors: [{ code: 'new_a' }] }, [{ code: '600986' }]);
  const r = reconcile(p, snapMap({ 600986: 7.4 }), summary(snapMap({ 600986: 7.0 })),
    bars(3400, 3440), CFG, { sectorsToday: board(1) });
  assert.strictEqual(r.candHitRatio, 0);
  assert.strictEqual(r.attribution, 'direction', '不能怪选股');
});

test('A 档次日仍在前 30% → directionHit=true，归因回落 candidate/timing/hit', () => {
  const p = pred('attack', { sectors: [{ code: 'new_a' }] });
  const r = reconcile(p, snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG,
    { sectorsToday: board(200) });
  assert.strictEqual(r.directionResult.hit, true);
  assert.strictEqual(r.attribution, 'hit');
});

test('二期未上线（无 mainline）→ directionResult.available=false，不判错', () => {
  const r = reconcile(pred('attack'), snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG,
    { sectorsToday: board(1) });
  assert.strictEqual(r.directionResult.hit, null);
  assert.strictEqual(r.directionResult.available, false);
  assert.strictEqual(r.attribution, 'hit');
});

test('目标日榜单缺失 → directionHit=null（无法判定，不造假）', () => {
  const p = pred('attack', { sectors: [{ code: 'new_a' }] });
  const r = reconcile(p, snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG, {});
  assert.strictEqual(r.directionResult.hit, null);
  assert.strictEqual(r.attribution, 'hit');
});

test('昨日 A 档板块今日不在榜 → 标 missing 且不判错', () => {
  const p = pred('attack', { sectors: [{ code: 'new_zzz' }] });
  const r = reconcile(p, snapMap({}), summary(snapMap({})), bars(3400, 3440), CFG,
    { sectorsToday: board(200) });
  assert.strictEqual(r.directionResult.hit, null);
  assert.ok(r.directionResult.missing.includes('new_zzz'));
});

test('rankInAll：最高分=1，最低分=0，找不到=null', () => {
  const rows = [{ sector: 'a', score: 10 }, { sector: 'b', score: 5 }, { sector: 'c', score: 1 }];
  assert.strictEqual(rankInAll(rows, 'a'), 1);
  assert.strictEqual(rankInAll(rows, 'c'), 0);
  assert.strictEqual(rankInAll(rows, 'zzz'), null);
});

console.log(`\n${fail ? '✗' : '✓'} 二期方向归因：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
