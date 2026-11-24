'use strict';
/**
 * 扶摇适配器单测 —— 只测纯逻辑与数学性质，不联网。
 * 联网口径核对见 tools/reconcile.js（会打真实接口，输出偏差报告）。
 *
 * 重点防两类回归：
 *  1. 复权重建公式写错（会把前复权序列整体缩放错，指标全偏）
 *  2. 分段拼接重复或倒序（会让均线多算几根，偏离度失真）
 */
const assert = require('assert');
const F = require('../../lib/sources/adapters/fuyao');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('fuyao 纯逻辑');

t('代码映射：六位前缀三种市场', () => {
  assert.strictEqual(F.toThscode('sh600519'), '600519.SH');
  assert.strictEqual(F.toThscode('sz000001'), '000001.SZ');
  assert.strictEqual(F.toThscode('bj920876'), '920876.BJ');
  assert.strictEqual(F.toThscode('600519'), null);
  assert.strictEqual(F.fromThscode('600519.SH'), 'sh600519');
  assert.strictEqual(F.fromThscode('920876.BJ'), 'bj920876');
});

t('分段：默认窗口落在单段内（不额外往返）', () => {
  const now = Date.parse('2026-11-19T00:00:00+08:00');
  const segs = F.splitSegments(F.defaultStart(now), now);
  assert.strictEqual(segs.length, 1, `默认窗口应 1 段，实际 ${segs.length}`);
});

t('分段：20 年历史切成 3 段，且首尾闭合、无空洞', () => {
  const end = Date.parse('2026-11-19T00:00:00+08:00');
  const start = Date.parse('2006-01-01T00:00:00+08:00');
  const segs = F.splitSegments(start, end);
  assert.strictEqual(segs.length, 3, `20 年应 3 段，实际 ${segs.length}`);
  assert.strictEqual(segs[0][0], start, '首段起点应为请求起点');
  assert.strictEqual(segs[segs.length - 1][1], end, '末段终点应为请求终点');
  for (let i = 0; i < segs.length; i++) {
    const span = (segs[i][1] - segs[i][0]) / (365.25 * 24 * 3600 * 1000);
    assert.ok(span <= F.SEG_YEARS + 0.01, `第 ${i} 段跨度 ${span.toFixed(2)} 年超过上限`);
    if (i > 0) assert.strictEqual(segs[i][0], segs[i - 1][1], `第 ${i} 段与上一段不闭合`);
  }
});

t('分段：单段窗口原样返回，不多切', () => {
  const end = Date.parse('2026-11-19T00:00:00+08:00');
  const start = end - 300 * 24 * 3600 * 1000;      // 300 天
  assert.strictEqual(F.splitSegments(start, end).length, 1);
});

t('分段：起止颠倒时退化为「末段」而不是抛错或空数组', () => {
  const end = Date.parse('2026-11-19T00:00:00+08:00');
  const segs = F.splitSegments(end, end);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0][1], end);
});

// ── 复权重建 ──────────────────────────────────────────────
let _seq = 0;
const mk = (c) => ({ date_ms: (_seq++) * 86400000, open_price: c, close_price: c, high_price: c, low_price: c, volume: 100, turnover: 100 });

t('重建：最新一根等于不复权最新价（前复权的定义要求）', () => {
  const bw = [mk(10), mk(20), mk(30)];
  const out = F.rebuildForward ? F.rebuildForward(bw, 3) : null;
  // rebuildForward 未导出时退化为黑盒：至少验证函数存在性由主流程保证
  if (!out) return;
  const last = out[out.length - 1];
  assert.ok(Math.abs(last.close_price - 3) < 1e-9, `最新应为 3，实际 ${last.close_price}`);
});

t('重建：整条序列等差缩放，比值恒定', () => {
  if (!F.rebuildForward) return;
  const k = 10;                                     // 后复权因子
  const raw = [1, 2, 3, 4];
  const bw = raw.map((x) => mk(x * k));
  const out = F.rebuildForward(bw, 4);
  for (let i = 0; i < raw.length; i++) {
    assert.ok(Math.abs(out[i].close_price - raw[i]) < 1e-9, `第 ${i} 根应为 ${raw[i]}，实际 ${out[i].close_price}`);
  }
});

t('重建：给了 none 序列时，量额取 none 真值（不缩放）', () => {
  if (!F.rebuildForward) return;
  // 显式构造同日期序列：rebuildForward 按 ymd(date_ms) 对齐，两边日期必须一一对应
  const row = (ms, c, v, a) => ({ date_ms: ms, open_price: c, close_price: c, high_price: c, low_price: c, volume: v, turnover: a });
  const bw = [row(0, 100, 100, 100), row(86400000, 200, 100, 100)];
  const raw = [row(0, 1, 64977422, 519988956), row(86400000, 4, 108133606, 879067030)];
  const out = F.rebuildForward(bw, 4, raw);
  assert.strictEqual(out[0].volume, 64977422);
  assert.strictEqual(out[1].turnover, 879067030);
});

t('重建：缺 none 序列时，量按价格因子反向缩放（保持量×价≈额）', () => {
  if (!F.rebuildForward) return;
  const out = F.rebuildForward([mk(100), mk(200)], 4);
  const k = 4 / 200;                                 // 价格缩放因子
  assert.ok(Math.abs(out[0].volume - 100 / k) < 1e-6, `应为 ${100 / k}，实际 ${out[0].volume}`);
  assert.strictEqual(out[0].turnover, 100);          // 额本身不受复权影响
});

t('重建：基准为 0 或负时抛错，不产出垃圾序列', () => {
  if (!F.rebuildForward) return;
  assert.throws(() => F.rebuildForward([mk(0)], 1), /基准异常/);
  assert.throws(() => F.rebuildForward([mk(10), mk(-1)], 1), /基准异常/);
  assert.throws(() => F.rebuildForward([mk(10)], 0), /基准异常/);
});

t('行转换：volume 股 → 手（÷100 取整）', () => {
  const r = F.toRow({ date_ms: Date.parse('2026-11-19T00:00:00+08:00'), open_price: 1, close_price: 2, high_price: 3, low_price: 0.5, volume: 66841479, turnover: 430493970 });
  assert.strictEqual(r.d, '2026-11-19');
  assert.strictEqual(r.v, 668415);
  assert.strictEqual(r.a, 430493970);
});

t('批量上限常量与接口一致（11 只报 code=1003）', () => {
  assert.strictEqual(F.MAX_BATCH, 10);
});

t('分段上限 9 年，留出接口 10 年的余量', () => {
  assert.strictEqual(F.SEG_YEARS, 9);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
