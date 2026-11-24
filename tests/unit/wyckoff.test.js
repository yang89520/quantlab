'use strict';
/**
 * 威科夫结构识别的规则测试。
 *
 * 为什么必须用「人造 K 线」而不是真实行情：
 *   真实行情里 spring 与普通下跌、upthrust 与普通冲高在数值上混在一起，
 *   拿它做断言，规则错一个阈值也照样"通过"。这里每个用例只造出**一条**规则
 *   需要的最小结构，其余全部平坦，规则不生效就必然失败。
 */
const assert = require('assert');
const W = require('../../lib/wyckoff');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

/** 造一根 K 线：[日期, 开, 收, 高, 低, 量(手), 额] */
let daySeq = 0;
function bar(o, c, h, l, v) {
  daySeq++;
  const d = new Date(Date.UTC(2024, 0, 1) + daySeq * 86400000).toISOString().slice(0, 10);
  return [d, o, c, h, l, v, v * 100 * c];
}

/** 平坦底料：n 根都在 [p0, p1] 之间小幅波动，量恒定 */
function flat(n, p0 = 10, p1 = 10.5, vol = 10000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p0 + 0.2;
    const c = i % 2 ? p0 + 0.1 : p0 + 0.3;
    out.push(bar(o, c, p1, p0, vol));
  }
  return out;
}

console.log('威科夫规则测试');

ok('数据不足时明确返回不可用，不给半成品结论', () => {
  const r = W.analyze(flat(10));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('少于 30 根'));
  assert.ok(r.disclaimer.includes('不构成投资建议'));
});

ok('缩量假跌破并收回 → 识别为 spring', () => {
  daySeq = 0;
  const bars = flat(30);                       // 26 根，20 日支撑 = 10.0
  // 第 27 根：盘中跌破 10.0 到 9.70，收盘拉回 10.20，量只有平时的 0.7
  bars.push(bar(10.1, 10.2, 10.25, 9.7, 7000));
  bars.push(bar(10.2, 10.25, 10.3, 10.15, 10000));
  bars.push(bar(10.25, 10.3, 10.35, 10.2, 10000));
  const r = W.analyze(bars);
  assert.strictEqual(r.ok, true);
  assert.ok(r.events.spring.length >= 1, '应识别出 spring');
  const sp = r.events.spring[r.events.spring.length - 1];
  assert.strictEqual(sp.low, 9.7);
  assert.strictEqual(sp.support, 10);
  assert.ok(sp.volRatio < 0.9, `量比应低于 0.9，实际 ${sp.volRatio}`);
  assert.ok(sp.note.includes('缩量'));
});

ok('放量突破前高后收回 → 识别为 upthrust', () => {
  daySeq = 0;
  const bars = flat(30);                       // 20 日阻力 = 10.5
  bars.push(bar(10.4, 10.3, 10.8, 10.2, 25000));   // 放量 2.5 倍，冲高 10.8 收 10.3
  bars.push(bar(10.3, 10.2, 10.4, 10.1, 10000));
  bars.push(bar(10.2, 10.1, 10.3, 10.0, 10000));
  const r = W.analyze(bars);
  assert.ok(r.events.upthrust.length >= 1, '应识别出 upthrust');
  const u = r.events.upthrust[0];
  assert.strictEqual(u.high, 10.8);
  assert.strictEqual(u.resistance, 10.5);
  assert.ok(u.volRatio >= 1.2);
});

ok('放量长阳 → SOS；放量长阴 → SOW', () => {
  daySeq = 0;
  const bars = flat(30);
  bars.push(bar(10.2, 10.8, 10.85, 10.15, 40000));  // +5.9%，4 倍量
  bars.push(bar(10.8, 10.1, 10.85, 10.05, 40000));  // -6.5%，4 倍量
  const r = W.analyze(bars);
  assert.strictEqual(r.events.sos.length, 1, '应识别 1 次 SOS');
  assert.strictEqual(r.events.sow.length, 1, '应识别 1 次 SOW');
  assert.ok(r.events.sos[0].pct >= 3);
  assert.ok(r.events.sow[0].pct <= -3);
});

ok('spring 后缩量回踩不破 → 追加 test 确认', () => {
  daySeq = 0;
  const bars = flat(30);
  bars.push(bar(10.1, 10.2, 10.25, 9.7, 7000));    // spring，量 7000
  bars.push(bar(10.2, 10.3, 10.35, 10.2, 10000));
  bars.push(bar(10.3, 10.35, 10.4, 10.25, 10000));
  bars.push(bar(10.35, 10.40, 10.45, 10.3, 4000)); // 第 3 根：量 4000 = spring 的 0.57
  const r = W.analyze(bars);
  assert.ok(r.events.test.length >= 1, '应识别出 test');
  const t = r.events.test[0];
  assert.strictEqual(t.barsAfterSpring, 3);
  assert.ok(t.volVsSpring <= 0.75, `量能比 ${t.volVsSpring} 应 ≤ 0.75`);
});

ok('纯横盘不得凭空产生 spring / upthrust', () => {
  daySeq = 0;
  const r = W.analyze(flat(60));
  assert.strictEqual(r.events.spring.length, 0);
  assert.strictEqual(r.events.upthrust.length, 0);
  assert.ok(r.summary.includes('无 spring'));
});

ok('阶段判定：横盘缩量 → accumulation，且必须带置信度', () => {
  daySeq = 0;
  const bars = flat(80, 10, 10.2, 10000);
  // 近 5 日量降到 6000，制造缩量
  for (let i = bars.length - 5; i < bars.length; i++) bars[i][5] = 6000;
  const r = W.analyze(bars);
  assert.strictEqual(r.phase.value, 'accumulation');
  assert.ok(['high', 'medium', 'low'].includes(r.phase.confidence));
  assert.ok(r.phase.note.includes('启发式'));
});

ok('120 日区间位置与摆动点结构自洽', () => {
  daySeq = 0;
  const bars = flat(120, 10, 11);
  const r = W.analyze(bars);
  assert.ok(r.features.position120 >= 0 && r.features.position120 <= 100);
  assert.ok(r.features.high120 >= r.features.low120);
  for (const h of r.swings.highs) assert.ok(h.price <= r.features.high120 + 1e-6);
});

ok('输出永远带免责声明（红线）', () => {
  daySeq = 0;
  const r = W.analyze(flat(60));
  assert.ok(r.disclaimer.includes('不构成投资建议'));
});

console.log(`\n结果：${pass} 通过 / 0 失败`);
