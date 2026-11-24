'use strict';
/**
 * 资金量价指标单测
 *
 * 重点守三件事：
 *   1. 强度不被「分母下限」压平 —— 曾经 max(均量, 0.5V) 让放量 10 倍与 1.5 倍同值，
 *      参数网格里 s>2 永远 0 笔，是真实踩过的坑；
 *   2. 方向代理的符号与量级正确（收盘在最高 → +1，在最底 → -1）；
 *   3. BS 分级阈值与回测口径一致，改阈值必须同步改测试。
 */

const assert = require('assert');
const F = require('../../lib/flow-signal');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fails.push(name + ' → ' + e.message); console.log('  \u2717 ' + name); }
}

/** 造一行：日期递增，便于 Map/排序 */
function mk(i, o, h, l, c, v, a) {
  return [`2026-01-${String(i % 28 + 1).padStart(2, '0')}`, o, h, l, c, v, a || v * 100 * c];
}

function flat(n, price = 10, vol = 100) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mk(i, price, price + 0.2, price - 0.2, price, vol));
  return out;
}

console.log('\n[方向层]');

t('收盘在最高价 → CLV = +1', () => {
  const rows = [mk(0, 10, 11, 9, 11, 100)];
  assert.strictEqual(F.dirClv(rows)[0], 1);
});

t('收盘在最低价 → CLV = -1', () => {
  const rows = [mk(0, 10, 11, 9, 9, 100)];
  assert.strictEqual(F.dirClv(rows)[0], -1);
});

t('一字板（H=L）方向记 0，不产生 NaN', () => {
  const rows = [mk(0, 10, 10, 10, 10, 100)];
  assert.strictEqual(F.dirClv(rows)[0], 0);
  assert.ok(Number.isFinite(F.dirBody(rows)[0]));
});

t('实体方向只看实体：长上影大阳线的实体方向仍为正', () => {
  // O=10 C=10.5 H=11 L=10 → 实体 +0.5，区间 1 → body=+0.5；但 CLV=(10.5-10)-(11-10.5)=0
  const rows = [mk(0, 10, 11, 10, 10.5, 100)];
  assert.strictEqual(F.dirBody(rows)[0], 0.5);
  assert.strictEqual(F.dirClv(rows)[0], 0);
});

t('VWAP 偏离：收盘高于均价为正', () => {
  // v=100 手=10000 股，a=1e5 元 → vwap=10；c=10.5 → 偏离 +5%
  const rows = [mk(0, 10, 10.6, 9.9, 10.5, 100, 1e5)];
  const d = F.dirVwap(rows);
  assert.ok(d[0] > 0, `期望为正，实际 ${d[0]}`);
});

console.log('\n[强度层]');

t('放量 5 倍应得到约 5×方向 的强度（不被下限压平）', () => {
  const rows = flat(20, 10, 100);
  // 第 21 根：收盘在最高，量 500（5 倍均量）
  rows.push(mk(20, 10, 11, 10, 11, 500));
  const mf = F.dirClv(rows);
  const s = F.intensity(mf, rows, 20);
  const last = s[s.length - 1];
  assert.ok(last > 4.5, `期望接近 5，实际 ${last.toFixed(2)}`);
});

t('缩量日强度不会被放大到失真', () => {
  const rows = flat(20, 10, 100);
  rows.push(mk(20, 10, 11, 10, 11, 10));     // 量只有均量的 1/10
  const s = F.intensity(F.dirClv(rows), rows, 20);
  const last = s[s.length - 1];
  assert.ok(last > 0 && last < 0.3, `期望接近 0.1，实际 ${last.toFixed(2)}`);
});

t('强度有上下限，不会因极端放量爆表', () => {
  const rows = flat(20, 10, 100);
  rows.push(mk(20, 10, 11, 10, 11, 100000));
  const s = F.intensity(F.dirClv(rows), rows, 20);
  assert.ok(Math.abs(s[s.length - 1]) <= 8);
});

console.log('\n[累积层]');

t('衰减累计：持续同向流入应稳定抬升且有界', () => {
  const s = new Array(500).fill(1);
  const cum = F.cumulative(s, 0.98);
  assert.ok(cum[499] > 40 && cum[499] < 50, `期望约 50，实际 ${cum[499].toFixed(1)}`);
  assert.ok(cum[499] > cum[400]);
});

t('正负交替的累积应回到 0 附近', () => {
  const s = [];
  for (let i = 0; i < 400; i++) s.push(i % 2 ? 1 : -1);
  const cum = F.cumulative(s, 0.9);
  assert.ok(Math.abs(cum[399]) < 1);
});

console.log('\n[位置与分级]');

t('位置分位：区间最高记 1，最低记 0', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(mk(i, 10, 12, 8, 10, 100));
  rows[59] = mk(59, 10, 12, 8, 12, 100);
  assert.strictEqual(F.positionSeries(rows, 60)[59], 1);
  rows[59] = mk(59, 10, 12, 8, 8, 100);
  assert.strictEqual(F.positionSeries(rows, 60)[59], 0);
});

t('分级：低位 + 强流入 → B3', () => {
  const g = F.gradeAt(0.1, 2.5);
  assert.deepStrictEqual(g, { side: 'B', grade: 3 });
});

t('分级：低位但流入不够猛 → 不入级', () => {
  assert.strictEqual(F.gradeAt(0.1, 0.5), null);
});

t('分级：高位 + 强流出 → S3', () => {
  const g = F.gradeAt(0.9, -2);
  assert.deepStrictEqual(g, { side: 'S', grade: 3 });
});

t('分级：中位不强不给信号（避免噪声）', () => {
  assert.strictEqual(F.gradeAt(0.5, 0.3), null);
});

t('BS 序列：信号间隔不小于 minGap', () => {
  const rows = flat(80, 10, 100);
  const ind = F.compute(rows, { dir: 'clv' });
  const pos = F.positionSeries(rows, 60);
  const bs = F.bsSignals(rows, ind, pos, 3);
  for (let i = 1; i < bs.length; i++) assert.ok(bs[i].i - bs[i - 1].i >= 3);
});

console.log('\n[完整性]');

t('compute 输出长度与输入一致，且无 NaN', () => {
  const rows = flat(120, 10, 100);
  const ind = F.compute(rows, { dir: 'vwap' });
  for (const k of ['s', 'cum', 'fast', 'slow']) {
    assert.strictEqual(ind[k].length, rows.length, k);
    assert.ok(ind[k].every(Number.isFinite), k);
  }
});

t('三种方向代理在同一份数据上都能算，不抛异常', () => {
  const rows = flat(100, 10, 100);
  for (const dir of ['body', 'clv', 'vwap', 'blend']) {
    const ind = F.compute(rows, { dir });
    assert.ok(ind.s.every(Number.isFinite), dir);
  }
});

console.log('\n' + '-'.repeat(52));
console.log(`结果：${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
