'use strict';
/**
 * 二期 L1 纯函数单测（docs/dev/04 §7.1 + 10 §6）。
 * 无网络、无数据库；每条断言都对应文档里的一条具名用例。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../lib/config');
const { aggregateSector } = require('../../lib/sources/adapters/aggregate');
const sector = require('../../lib/sector');
const wp = require('../../lib/watchpool');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function bars(n, closeAt, volTail, volHead, highAt) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const isTail = i >= n - 5;
    const c = i === n - 1 ? (closeAt == null ? 10 : closeAt) : 10;
    rows.push([
      `2026-01-${String(i + 1).padStart(2, '0')}`,
      c, c,
      i === n - 1 ? (highAt == null ? c : highAt) : c,
      c,
      isTail ? (volTail == null ? 100 : volTail) : (volHead == null ? 100 : volHead),
      100000 + i,
    ]);
  }
  return rows;
}
function feat(over) {
  return Object.assign({
    insufficient: false,
    ret5: 0.01, ret20: 0.02, ma20: 10, close: 10.2,
    volRatio: 1.2, upRatio: 0.6, ztCount: 1,
    daysAboveMa20: 12, amountPctile: 0.5, netInflowPctile: null,
  }, over || {});
}
function batch(n, fn) {
  return Array.from({ length: n }, (_, i) => ({
    sector: `new_t${i}`, name: `板块${i}`, type: 'industry',
    feat: fn ? fn(i) : feat({ ret5: 0.001 * i, ret20: 0.002 * i }),
  }));
}

console.log('二期纯函数');

/* ---------- 板块 K 线聚合（10 §6） ---------- */

test('聚合：3 只成分股日涨跌 [1%,2%,3%] → 板块日涨跌 2%', () => {
  const mk = (last) => {
    const d0 = ['2026-01-01', 100, 100, 100, 100, 100, 1000];
    const d1 = ['2026-01-02', last, last, last, last, 100, 1000];
    return [d0, d1];
  };
  const r = aggregateSector({ a: mk(101), b: mk(102), c: mk(103) });
  assert.ok(Math.abs(r.meta[1].chg - 0.02) < 1e-9, `chg=${r.meta[1].chg}`);
  assert.strictEqual(r.meta[1].validCount, 3);
});

test('聚合：某日 2 只停牌只剩 3 只有效 → 分母 3 且 <5 标 insufficient', () => {
  const full = (last) => [
    ['2026-01-01', 100, 100, 100, 100, 100, 1000],
    ['2026-01-02', last, last, last, last, 100, 1000],
  ];
  const suspended = [['2026-01-01', 100, 100, 100, 100, 100, 1000]];
  const r = aggregateSector({
    a: full(101), b: full(102), c: full(103), d: suspended, e: suspended,
  });
  assert.strictEqual(r.meta[1].validCount, 3, '停牌股不计入分母');
  assert.strictEqual(r.meta[1].insufficient, true, '有效成分 3 < 5 应标记');
  assert.ok(Math.abs(r.meta[1].chg - 0.02) < 1e-9);
});

test('聚合：首日指数 = 1000', () => {
  const r = aggregateSector({ a: [['2026-01-01', 100, 100, 100, 100, 100, 1000]] });
  assert.strictEqual(r.bars[0][2], 1000);
  assert.strictEqual(r.bars[0][0], '2026-01-01');
});

/* ---------- 四因子与 ABCD（04 §7.1） ---------- */

test('四因子合成：动量 80 / 资金 70 → grade=A', () => {
  assert.strictEqual(sector.grade(80, 70, 10, 9), 'A');
});
test('动量 80 / 资金 69 → grade=B', () => {
  assert.strictEqual(sector.grade(80, 69, 10, 9), 'B');
});
test('动量 30 且 close<ma20 → grade=D', () => {
  assert.strictEqual(sector.grade(30, 50, 9, 10), 'D');
});
test('动量 30 但 close>ma20 → grade=C', () => {
  assert.strictEqual(sector.grade(30, 50, 11, 10), 'C');
});
test('A/B 判定必须在 D 之前（动量高但跌破 MA20 仍是 A）', () => {
  assert.strictEqual(sector.grade(85, 75, 9, 10), 'A', 'D 条件挪前会误判');
});
test('板块分位：3 个板块 mixRet=[1,2,3] → ≈33/66/100', () => {
  const p = [1, 2, 3].map((v) => sector.pctile([1, 2, 3], v) * 100);
  assert.ok(Math.abs(p[0] - 33.33) < 1, p.join(','));
  assert.ok(Math.abs(p[1] - 66.67) < 1, p.join(','));
  assert.ok(Math.abs(p[2] - 100) < 1, p.join(','));
});
test('参评板块 8 个 → 抛错（不足 10）', () => {
  assert.throws(() => sector.scoreBatch(batch(8)), /不足 10/);
});
test('净流入缺失 → degraded=true，funds 用降级口径', () => {
  const rows = sector.scoreBatch(batch(10));
  assert.ok(rows.every((r) => r.degraded), '所有板块都应标降级');
  assert.ok(rows.some((r) => /net_inflow_missing/.test(r.degradeReason)));
  const r = rows[0];
  const c = config.sector;
  const expected = c.funds.degradedAmount * (r.metrics.amountPctile * 100)
    + c.funds.degradedVol * ((r.metrics.volRatio - c.volScore.base) / c.volScore.span * 100);
  assert.ok(Math.abs(r.parts.funds - expected) < 0.1,
    `funds=${r.parts.funds} expected=${expected}`);
});
test('净流入可用 → 不标降级，走 0.45/0.25/0.30 口径', () => {
  const rows = sector.scoreBatch(batch(10, () => feat({ netInflowPctile: 0.5 })));
  assert.ok(rows.every((r) => !r.degraded), rows[0].degradeReason || '');
});
test('行业榜与概念榜分开算分位，榜内 type 唯一', () => {
  const ind = batch(10, (i) => feat({ ret5: 0.05 + i * 0.001, ret20: 0.08 + i * 0.001 }));
  const con = batch(10, (i) => feat({ ret5: -0.05 + i * 0.001, ret20: -0.08 + i * 0.001 }))
    .map((x, i) => Object.assign(x, { sector: `gn_t${i}`, type: 'concept' }));
  const rows = sector.scoreBatch(ind.concat(con));
  const indRows = rows.filter((r) => r.type === 'industry');
  const conRows = rows.filter((r) => r.type === 'concept');
  assert.strictEqual(indRows.length, 10);
  assert.strictEqual(conRows.length, 10);
  assert.ok(indRows.every((r) => r.pctileScope === 'industry'));
  assert.ok(conRows.every((r) => r.pctileScope === 'concept'));
  // 概念整体收益更差，但分榜后概念内部仍应出现 100 分位
  assert.ok(Math.max.apply(null, conRows.map((r) => r.parts.momentum)) > 90,
    '概念榜被行业榜压下去说明混排了');
});
test('score 权重合计为 1，且等于四因子加权和', () => {
  const c = config.sector;
  assert.ok(Math.abs(c.weights.momentum + c.weights.funds + c.weights.breadth + c.weights.continuity - 1) < 1e-9);
  const r = sector.scoreBatch(batch(10))[0];
  const expect = c.weights.momentum * r.parts.momentum + c.weights.funds * r.parts.funds
    + c.weights.breadth * r.parts.breadth + c.weights.continuity * r.parts.continuity;
  assert.ok(Math.abs(r.score - expect) < 0.05, `${r.score} vs ${expect}`);
});

/* ---------- 观察池状态机（04 §7.1） ---------- */

const SESSIONS = Array.from({ length: 30 }, (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}`);
function entry(over) {
  return Object.assign({
    code: '600986', name: '测试标的', state: 'watching',
    enteredAt: SESSIONS[0], stateSince: SESSIONS[0], daysInState: 0,
    snapshots: [], note: '',
  }, over || {});
}
function ctxOf(over) {
  return Object.assign({
    bars: bars(25, 10.1, 70, 110),
    date: SESSIONS[1], sessionDates: SESSIONS,
    sectorGrade: 'A', stockScore: 75,
  }, over || {});
}

test('观察池 watching→ambush：close≈ma20*1.01、量比 0.7 → 迁移', () => {
  const r = wp.evaluate(entry(), ctxOf());
  assert.strictEqual(r.nextState, 'ambush', JSON.stringify(r));
  assert.strictEqual(r.trigger, 'shrink_pullback_ma20');
  assert.ok(r.evidences.length >= 2, '迁移日志至少 2 条原始值');
});
test('观察池 watching→ambush：量比 0.9 → 不迁移', () => {
  const r = wp.evaluate(entry(), ctxOf({ bars: bars(25, 10.1, 90, 103) }));
  assert.strictEqual(r.nextState, 'watching');
  assert.strictEqual(r.trigger, null);
});
test('一次跳两档：条件全满足也只前进一档', () => {
  // 突破前高 + 放量，watching 也只应到 ambush（甚至不迁移），绝不能到 confirmed
  const r = wp.evaluate(entry(), ctxOf({ bars: bars(25, 12, 200, 100, 12) }));
  assert.notStrictEqual(r.nextState, 'confirmed');
  const r2 = wp.evaluate(entry({ state: 'ambush' }), ctxOf({ bars: bars(25, 12, 200, 100, 12) }));
  assert.strictEqual(r2.nextState, 'confirmed', 'ambush 应到 confirmed');
  assert.notStrictEqual(r2.nextState, 'holding', '不许连跳到 holding');
});
test('超期：daysInState=11 (max=10) → removed, reason=too_slow', () => {
  const c = ctxOf({ date: SESSIONS[11] });
  const r = wp.evaluate(entry(), c);
  assert.strictEqual(r.nextState, 'removed');
  assert.strictEqual(r.reason, 'too_slow');
  assert.strictEqual(r.trigger, 'max_stay');
});
test('放量跌破 MA20 → removed, reason=logic_broken', () => {
  const r = wp.evaluate(entry({ state: 'ambush' }), ctxOf({ bars: bars(25, 8, 200, 100) }));
  assert.strictEqual(r.nextState, 'removed');
  assert.strictEqual(r.reason, 'logic_broken');
});
test('板块降 D 档 → removed', () => {
  const r = wp.evaluate(entry(), ctxOf({ sectorGrade: 'D' }));
  assert.strictEqual(r.nextState, 'removed');
  assert.strictEqual(r.reason, 'logic_broken');
});
test('降级只允许直接到 removed，不回退 ambush→watching', () => {
  const r = wp.evaluate(entry({ state: 'ambush' }), ctxOf({ bars: bars(25, 9, 200, 100) }));
  assert.strictEqual(r.nextState, 'removed');
});
test('K 线不足 21 根 → 不推进、不假判', () => {
  const r = wp.evaluate(entry(), ctxOf({ bars: bars(10) }));
  assert.strictEqual(r.nextState, 'watching');
  assert.strictEqual(r.trigger, null);
});
/* ---------- 异步用例 ---------- */
async function atest(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
  await atest('池满 30 再加 → 拒绝，不踢人', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-wp-full-'));
    const old = config.__root;
    config.__root = root;
    try {
      const dir = path.join(root, 'data', 'watchpool');
      fs.mkdirSync(dir, { recursive: true });
      const rows = Array.from({ length: config.watchpool.maxSize }, (_, i) => ({
        schema: 1, code: String(600000 + i), state: 'watching',
        enteredAt: SESSIONS[0], stateSince: SESSIONS[0], snapshots: [],
      }));
      fs.writeFileSync(path.join(dir, 'pool.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      let rejected = false;
      try {
        await wp.add({ code: '600986', score: 90, grade: 'A', date: SESSIONS[1] });
      } catch (e) {
        rejected = /池已满/.test(e.message);
      }
      assert.ok(rejected, '池满应拒绝');
      assert.strictEqual(wp.list().length, config.watchpool.maxSize, '不许自动踢人');
    } finally {
      config.__root = old;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await atest('移出必须选原因（异步校验）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-wp-rm-'));
    const old = config.__root;
    config.__root = root;
    try {
      const dir = path.join(root, 'data', 'watchpool');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pool.jsonl'), JSON.stringify({
        schema: 1, code: '600986', state: 'watching', enteredAt: SESSIONS[0], stateSince: SESSIONS[0],
      }) + '\n');
      let err = null;
      try { await wp.remove('600986', undefined); } catch (e) { err = e; }
      assert.ok(err && /必须选择原因/.test(err.message), err && err.message);
      const ok = await wp.remove('600986', 'wrong', { wrongDetail: '方向判错', date: SESSIONS[2] });
      assert.strictEqual(ok.state, 'removed');
      assert.strictEqual(ok.removeReason, 'wrong');
      assert.strictEqual(ok.wrongDetail, '方向判错');
      assert.ok(wp.transitions('600986').length >= 1, '每次迁移必须写 S8 日志');
    } finally {
      config.__root = old;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${fail ? '✗' : '✓'} 二期纯函数：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
