'use strict';
/**
 * 卡尔曼趋势 · 单元测试
 *
 * 重点守四件事：
 *   1. **无前视**：filter 只依赖 t 及之前的数据。改写序列尾部不得影响头部结果 ——
 *      这是回测可信度的地基，一旦破了，所有历史统计都是假的。
 *   2. **量纲正确**：level 必须是「价格」而不是对数。曾经把对数价当价格比较，
 *      导致 close >= level 恒为假，B3 信号静默消失（5 万根里只有 22 次）。
 *   3. **已知信号可还原**：斜率已知的直线序列，估计值应接近真值。
 *   4. **模型自洽**：λ=0.3 时标准化创新方差不远离 1，否则 t 值虚高、阈值失去意义。
 */

const assert = require('assert');
const K = require('../../public/js/kalman.js');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fails.push(name + ' → ' + e.message); console.log('  \u2717 ' + name); }
}

let seq = 0;
function mk(o, h, l, c, v) {
  seq++;
  const d = `2026-${String(Math.floor(seq / 28) + 1).padStart(2, '0')}-${String(seq % 28 + 1).padStart(2, '0')}`;
  return [d, o, h, l, c, v || 1000, (v || 1000) * 100 * c];
}

/** 生成一条指数增长的可控序列，返回 rows */
function ramp(n, start, dailyRet, noise) {
  const rows = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const r = dailyRet + (noise ? (Math.sin(i * 7.3) * noise) : 0);
    const c = px * (1 + r);
    rows.push([`2026-01-01`, px, Math.max(px, c) * 1.004, Math.min(px, c) * 0.996, c, 1000, 1000 * c]);
    px = c;
  }
  return rows;
}

console.log('\n卡尔曼趋势 · 单测');

/* ---------- 1. 基本契约 ---------- */
t('输出长度与输入一致，派生序列无 undefined', () => {
  const rows = ramp(200, 10, 0.001, 0.01);
  const a = K.analyze(rows, { snr: 0.3 });
  assert.strictEqual(a.n, 200);
  for (const k of ['level', 'slope', 'slopeZ', 'upper', 'lower', 'dev', 'band']) {
    assert.strictEqual(a[k].length, 200, k + ' 长度不对');
    assert.ok(a[k].every(Number.isFinite), k + ' 含非有限值');
  }
});

t('K 线不足 5 根时返回空结果而不抛错', () => {
  const a = K.analyze(ramp(3, 10, 0.01, 0));
  assert.strictEqual(a.n, 0);
  assert.deepStrictEqual(a.signals, []);
});

/* ---------- 2. 量纲 ---------- */
t('level 是价格量级（与收盘价同量级）', () => {
  const rows = ramp(300, 20, 0.002, 0.008);
  const a = K.analyze(rows, { snr: 0.3 });
  const n = a.n - 1;
  const px = a.price[n], lv = a.level[n];
  assert.ok(Math.abs(lv / px - 1) < 0.15, `趋势线 ${lv} 与价格 ${px} 量级不符`);
});

t('upper > level > lower，且 dev = (price-level)/band', () => {
  const rows = ramp(300, 20, 0.002, 0.01);
  const a = K.analyze(rows, { snr: 0.3 });
  for (let i = 100; i < a.n; i++) {
    assert.ok(a.upper[i] > a.level[i], '上轨应高于趋势线');
    assert.ok(a.level[i] > a.lower[i], '趋势线应高于下轨');
    const expect = (a.price[i] - a.level[i]) / (a.upper[i] - a.level[i]);
    assert.ok(Math.abs(a.dev[i] - expect) < 1e-9, 'dev 定义不一致');
  }
});

/* ---------- 3. 无前视（最关键） ---------- */
t('filter 无前视：改写尾部不影响头部结果', () => {
  const rows = ramp(240, 10, 0.001, 0.02);
  const a1 = K.analyze(rows, { snr: 0.3 });
  // 把第 160 根之后的收盘价整体抬高 30%
  const rows2 = rows.map((r, i) => (i >= 160 ? [r[0], r[1], r[2] * 1.3, r[3] * 1.3, r[4] * 1.3, r[5], r[6]] : r));
  const a2 = K.analyze(rows2, { snr: 0.3 });
  for (let i = 0; i < 160; i++) {
    assert.ok(Math.abs(a1.level[i] - a2.level[i]) < 1e-9, `第 ${i} 根 level 被未来数据影响`);
    assert.ok(Math.abs(a1.slope[i] - a2.slope[i]) < 1e-12, `第 ${i} 根 slope 被未来数据影响`);
  }
});

t('filterCore 的单根预测值只用到 t-1 的信息', () => {
  const z = new Float64Array(120);
  for (let i = 0; i < 120; i++) z[i] = 100 + Math.sin(i / 5) * 2;
  const f = K.filterCore(z, { R: 1, q: 0.3 });
  // 预测值 predL[i] 必须等于 level[i-1] + slope[i-1]
  for (let i = 1; i < 120; i++) {
    assert.ok(Math.abs(f.predL[i] - (f.level[i - 1] + f.slope[i - 1])) < 1e-9, `第 ${i} 根预测值构造错误`);
  }
});

/* ---------- 4. 已知信号可还原 ---------- */
t('纯上升直线：斜率估计为正且接近真值', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const c = 100 * Math.exp(0.002 * i);      // 每日 0.2% 的 log 增长
    rows.push(mk(c, c * 1.001, c * 0.999, c));
  }
  const a = K.analyze(rows, { snr: 0.3 });
  const n = a.n - 1;
  const expect = 0.2;                          // 单位：log 收益 × 100
  assert.ok(Math.abs(a.slope[n] - expect) < 0.08, `斜率 ${a.slope[n].toFixed(3)} 偏离真值 ${expect}`);
  assert.ok(a.slopeZ[n] > 1, '上升趋势的 slopeZ 应为正');
});

t('纯下跌直线：斜率为负、slopeZ 为负', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const c = 100 * Math.exp(-0.002 * i);
    rows.push(mk(c, c * 1.001, c * 0.999, c));
  }
  const a = K.analyze(rows, { snr: 0.3 });
  const n = a.n - 1;
  assert.ok(a.slope[n] < 0, '下跌趋势斜率应为负');
  assert.ok(a.slopeZ[n] < 0, '下跌趋势 slopeZ 应为负');
});

t('横盘无噪声：斜率接近 0', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(mk(50, 50, 50, 50));
  const a = K.analyze(rows, { snr: 0.3 });
  const n = a.n - 1;
  assert.ok(Math.abs(a.slope[n]) < 0.02, '横盘斜率应接近 0，实际 ' + a.slope[n]);
});

/* ---------- 5. 模型自洽 ---------- */
t('λ=0.3 时标准化创新方差不远离 1（否则 t 值虚高）', () => {
  const rows = ramp(600, 30, 0.0005, 0.015);
  const a = K.analyze(rows, { snr: 0.3 });
  let z2 = 0, cnt = 0;
  for (let i = 40; i < a.n; i++) {
    if (!isFinite(a.innovZ[i])) continue;
    z2 += a.innovZ[i] ** 2; cnt++;
  }
  const v = z2 / cnt;
  assert.ok(v > 0.35 && v < 2.5, '标准化创新方差 ' + v.toFixed(2) + ' 偏离 1 太远，模型失衡');
});

t('λ 越小斜率越「固执」：slope 的一阶变化显著更小', () => {
  const rows = ramp(600, 30, 0.0005, 0.02);
  const lo = K.analyze(rows, { snr: 0.003 });
  const ok = K.analyze(rows, { snr: 0.3 });
  const rough = (a) => {
    let s = 0, n = 0;
    for (let i = 61; i < a.n; i++) { s += Math.abs(a.slope[i] - a.slope[i - 1]); n++; }
    return s / n;
  };
  assert.ok(rough(lo) < rough(ok) * 0.6, `λ=0.003 的斜率变化 ${rough(lo).toFixed(5)} 未显著小于 λ=0.3 的 ${rough(ok).toFixed(5)}`);
});

/* ---------- 6. 鲁棒性 ---------- */
t('单日异常跳空不会让斜率瞬间翻转（Huber 降权生效）', () => {
  const rows = ramp(300, 40, 0.002, 0.008);
  const base = K.analyze(rows, { snr: 0.3 });
  const n0 = base.n - 1;
  // 在倒数第 6 根插入 +40% 的异常跳空
  const rows2 = rows.map((r, i) => (i === rows.length - 6 ? [r[0], r[1], r[2] * 1.4, r[3], r[4] * 1.4, r[5], r[6]] : r));
  const a2 = K.analyze(rows2, { snr: 0.3 });
  // 跳空之前的历史不应改变
  for (let i = 0; i < rows.length - 8; i++) {
    assert.ok(Math.abs(base.level[i] - a2.level[i]) < 1e-9, '历史被未来跳空改写');
  }
  assert.ok(Math.abs(a2.slope[a2.n - 1]) < 5, '异常跳空把斜率推到离谱量级');
});

t('参数标定：R 随波动放大，稳健于单日极值', () => {
  const calm = new Float64Array(200);
  const wild = new Float64Array(200);
  for (let i = 0; i < 200; i++) { calm[i] = 100 + Math.sin(i / 9) * 0.3; wild[i] = 100 + Math.sin(i / 9) * 3; }
  const c = K.calibrate(calm, 1), w = K.calibrate(wild, 1);
  assert.ok(w.R > c.R * 4, '波动放大 10 倍时 R 应显著变大');
});

/* ---------- 7. 状态与信号 ---------- */
t('pos 状态机滞回：不会在阈值附近来回翻', () => {
  const rows = ramp(400, 20, 0.0004, 0.03);   // 噪声较大的震荡上行
  const a = K.analyze(rows, { snr: 0.3, enterZ: 1, exitZ: -0.5 });
  let flips = 0;
  for (let i = 61; i < a.n; i++) if (a.pos[i] !== a.pos[i - 1]) flips++;
  assert.ok(flips < a.n * 0.25, `翻转 ${flips} 次过于频繁，滞回没起作用`);
});

t('signal 的 grade 在 1..3，side 只能是 B/S', () => {
  const rows = ramp(600, 20, 0.0008, 0.025);
  const a = K.analyze(rows, { snr: 0.3 });
  for (const s of a.signals) {
    assert.ok(s.side === 'B' || s.side === 'S', 'side 非法：' + s.side);
    assert.ok(s.grade >= 1 && s.grade <= 3, 'grade 越界：' + s.grade);
    assert.ok(s.i >= 0 && s.i < a.n, 'i 越界');
  }
});

t('score 的字段齐全且 r2 在 0..1', () => {
  const a = K.analyze(ramp(400, 20, 0.001, 0.01), { snr: 0.3 });
  const s = K.score(a);
  for (const k of ['slopeZ', 'dev', 'annual', 'tSharpe', 'accel', 'r2', 'slope', 'snr']) {
    assert.ok(Number.isFinite(s[k]), k + ' 非有限值');
  }
  assert.ok(s.r2 >= 0 && s.r2 <= 1, 'r2 越界：' + s.r2);
});

t('RTS 平滑与滤波不同（平滑用了未来，只能画历史）', () => {
  const rows = ramp(240, 20, 0.001, 0.02);
  const a = K.analyze(rows, { snr: 0.3 });
  let diff = 0;
  for (let i = 0; i < a.n; i++) diff += Math.abs(a.smoothLevel[i] - a.level[i]);
  assert.ok(diff / a.n > 1e-6, '平滑线与滤波线完全一致，说明没有真的做平滑');
});

console.log('\n' + '-'.repeat(52));
console.log(`结果：${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
