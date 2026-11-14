'use strict';
/**
 * 一期纯函数单测（docs/dev/03 §7.1）
 * 运行：npm run test:unit
 *
 * 原则：每条断言都要能被打坏（变异验证）。改坏实现必须变红。
 */
const assert = require('assert');
const { judgeEnv, buildInvalidIf } = require('../../lib/predict');
const { evalInvalidIf, attribute, scoreOf } = require('../../lib/reconcile');
const { isLimitUp } = require('../../lib/snapshot');
const { nextTradingDay } = require('../../lib/predict');

let pass = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, msg: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/** 造一段指数日线：trend=1 上行 / -1 下行 / 0 横盘；volRatio 控制末段量能 */
function bars({ n = 120, trend = 1, volRatio = 1 } = {}) {
  const out = [];
  let price = 3000;
  for (let i = 0; i < n; i++) {
    const drift = trend * 0.002;
    price = price * (1 + drift);
    const vol = i >= n - 5 ? 1000000 * volRatio : 1000000;
    out.push([`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, price, price, price * 1.01, price * 0.99, vol, 0]);
  }
  return out;
}

const CFG = {
  predict: { verdict: { attack: 65, defend: 35 } },
};

console.log('judgeEnv');

test('全强：上行 + 宽带 + 放量 → attack 且 100 分', () => {
  const env = judgeEnv(bars({ trend: 1, volRatio: 1.5 }), { breadth: 0.80 }, CFG);
  assert.strictEqual(env.verdict, 'attack');
  assert.strictEqual(env.score, 100);
});

test('全弱：下行 + 窄带 + 缩量 → defend 且 0 分', () => {
  const env = judgeEnv(bars({ trend: -1, volRatio: 0.5 }), { breadth: 0.20 }, CFG);
  assert.strictEqual(env.verdict, 'defend');
  assert.strictEqual(env.score, 0);
});

test('居中 → wait（站上 MA20 但 MA20<MA60，趋势分项只拿一半）', () => {
  // 横盘 60 根 → 急跌 10 根 → 反弹 15 根：
  // close 已站回 ma20（+20 分），但 ma20 仍低于 ma60（0 分）→ trend=20
  const b = [];
  let price = 3400;
  for (let i = 0; i < 60; i++) b.push([`d${i}`, price, price, price, price, 1000000, 0]);
  for (let i = 0; i < 10; i++) { price *= 0.98; b.push([`d${i}`, price, price, price, price, 1000000, 0]); }
  for (let i = 0; i < 15; i++) { price *= 1.02; b.push([`d${i}`, price, price, price, price, 1000000, 0]); }
  const env = judgeEnv(b, { breadth: 0.50 }, CFG);
  assert.strictEqual(env.parts.trend, 20, `trend 应为 20，实际 ${env.parts.trend}`);
  assert.strictEqual(env.verdict, 'wait', `score=${env.score}`);
});

test('横盘（close==MA20）不算站上，trend 只能拿 0', () => {
  const env = judgeEnv(bars({ trend: 0, volRatio: 1.0 }), { breadth: 0.50 }, CFG);
  assert.strictEqual(env.parts.trend, 0);
  assert.strictEqual(env.verdict, 'defend');   // 26 分 → 防守，不是观望
});

test('parts 与 score 自洽（±1 取整误差）', () => {
  const env = judgeEnv(bars({ trend: 1, volRatio: 1.1 }), { breadth: 0.55 }, CFG);
  const sum = env.parts.trend + env.parts.breadth + env.parts.vol;
  assert.ok(Math.abs(sum - env.score) <= 1, `sum=${sum} score=${env.score}`);
});

test('confidence 必须是 null（没算就不许编）', () => {
  const env = judgeEnv(bars(), { breadth: 0.5 }, CFG);
  assert.strictEqual(env.confidence, null);
});

test('K 线不足 60 根必须抛错，不许给结论', () => {
  assert.throws(() => judgeEnv(bars({ n: 30 }), { breadth: 0.5 }, CFG), /MA60/);
});

console.log('\nbuildInvalidIf');

test('固定三条失效条件', () => {
  const env = judgeEnv(bars(), { breadth: 0.5 }, CFG);
  const list = buildInvalidIf(env, CFG);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((x) => x.id), ['E1', 'E2', 'E3']);
});

console.log('\nevalInvalidIf');

test('close 跌破 ma20 → 命中 E1', () => {
  const hits = evalInvalidIf(
    [{ id: 'E1', metric: 'close', op: '<', ref: 'ma20' }],
    { close: 3300, ma20: 3380 }
  );
  assert.deepStrictEqual(hits, ['E1']);
});

test('close 站上 ma20 → 不命中', () => {
  const hits = evalInvalidIf(
    [{ id: 'E1', metric: 'close', op: '<', ref: 'ma20' }],
    { close: 3421, ma20: 3380 }
  );
  assert.deepStrictEqual(hits, []);
});

test('缺失值不判命中（不许把 null 当 0）', () => {
  const hits = evalInvalidIf(
    [{ id: 'E2', metric: 'breadth', op: '<', value: 0.4 }],
    { breadth: null }
  );
  assert.deepStrictEqual(hits, []);
});

console.log('\nattribute（优先级必须固定）');

test('环境错 → env（不管选股多好）', () => {
  assert.strictEqual(attribute({ envHit: false, candHitRatio: 0.9, hasSpikeFade: false }), 'env');
});

test('环境对 + 候选差 → candidate', () => {
  assert.strictEqual(attribute({ envHit: true, candHitRatio: 0.2, hasSpikeFade: false }), 'candidate');
});

test('环境对 + 候选好 + 冲高回落 → timing', () => {
  assert.strictEqual(attribute({ envHit: true, candHitRatio: 0.8, hasSpikeFade: true }), 'timing');
});

test('环境对 + 候选好 + 无回落 → hit', () => {
  assert.strictEqual(attribute({ envHit: true, candHitRatio: 0.8, hasSpikeFade: false }), 'hit');
});

test('无候选时只看环境 → hit', () => {
  assert.strictEqual(attribute({ envHit: true, candHitRatio: null, hasSpikeFade: false }), 'hit');
});

test('得分：env 错时上限 50', () => {
  assert.strictEqual(scoreOf(false, 1), 50);
  assert.strictEqual(scoreOf(true, 1), 100);
});

console.log('\nisLimitUp（分板块阈值）');

test('创业板 19.8% 是涨停', () => {
  assert.strictEqual(isLimitUp('300750', 19.8), true);
});

test('创业板 10.5% 不是涨停（统一 9.8 会误判）', () => {
  assert.strictEqual(isLimitUp('300750', 10.5), false);
});

test('主板 9.9% 是涨停', () => {
  assert.strictEqual(isLimitUp('600986', 9.9), true);
});

test('北交所 29.8% 是涨停', () => {
  assert.strictEqual(isLimitUp('920000', 29.8), true);
});

console.log('\nnextTradingDay');

test('周五 → 下周一', () => {
  assert.strictEqual(nextTradingDay('2026-11-13'), '2026-11-16');
});

test('周四 → 周五', () => {
  assert.strictEqual(nextTradingDay('2026-11-12'), '2026-11-13');
});

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部通过（${pass} 项）`);
}
