'use strict';
/**
 * 二级缓存单测（docs/dev/01 §7.5）。
 * 重点不是「能读能写」，而是三条硬约束：跨日必失效、命中带 fetchedAt、能整体关掉。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../lib/config');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cache-'));
const oldRoot = config.__root;
const oldCache = JSON.parse(JSON.stringify(config.cache || {}));
config.__root = root;
config.cache = Object.assign({}, oldCache, { enabled: true, dir: 'data/cache', keepDays: 3 });

delete require.cache[require.resolve('../../lib/cache')];
const cache = require('../../lib/cache');

console.log('二级缓存（01 §7.5）');

test('写当日 → 读得到，且带 day/fetchedAt', () => {
  assert.strictEqual(cache.set('market-all', { data: [1, 2], asOf: '2026-11-13' }), true);
  const hit = cache.get('market-all');
  assert.ok(hit, '未命中');
  assert.deepStrictEqual(hit.value.data, [1, 2]);
  assert.strictEqual(hit.day, cache.todayStr());
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(hit.fetchedAt || ''), 'fetchedAt 缺失：' + hit.fetchedAt);
});

test('文件名含非法字符会被净化（防路径穿越）', () => {
  cache.set('klines-../../etc/passwd', { rows: [] });
  const dir = cache.dayDir();
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.indexOf('..') < 0 && f.indexOf('/') < 0), '文件名未净化：' + files.join(','));
  assert.ok(!fs.existsSync(path.join(root, 'etc')), '发生了路径穿越');
});

test('跨日必失效：昨天目录里的文件今天读不到（D3）', () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  const yday = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
  const dir = cache.dayDir(yday);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'market-all.json'), JSON.stringify({
    day: yday, fetchedAt: new Date().toISOString(), value: { data: ['旧值'] },
  }));
  const hit = cache.get('market-all');
  assert.ok(hit, '当日缓存应仍可用');
  assert.notDeepStrictEqual(hit.value.data, ['旧值'], '读到了昨天的旧值，等于拿 T-1 冒充当日');
});

test('内容损坏 → 返回 null，不抛异常', () => {
  const p = path.join(cache.dayDir(), 'broken.json');
  fs.writeFileSync(p, '{not json');
  assert.strictEqual(cache.get('broken'), null);
});

test('day 字段与目录不一致 → 当未命中（防手改旧值）', () => {
  const p = path.join(cache.dayDir(), 'tampered.json');
  fs.writeFileSync(p, JSON.stringify({ day: '2000-01-01', value: { a: 1 } }));
  assert.strictEqual(cache.get('tampered'), null);
});

test('enabled=false 时既不写也不读', () => {
  config.cache.enabled = false;
  assert.strictEqual(cache.set('off', { a: 1 }), false);
  assert.strictEqual(cache.get('off'), null);
  config.cache.enabled = true;
});

test('QL_NO_CACHE=1 时整体关闭（测试用开关）', () => {
  process.env.QL_NO_CACHE = '1';
  assert.strictEqual(cache.get('market-all'), null);
  delete process.env.QL_NO_CACHE;
  assert.ok(cache.get('market-all'), '关掉开关后应恢复可用');
});

test('prune 只保留最近 keepDays 天目录', () => {
  const dir = cache.baseDir();
  ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05'].forEach((d) => {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  });
  const r = cache.prune(2);
  const left = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  assert.strictEqual(left.length, 2, '应只留 2 个日期目录，实际 ' + left.join(','));
  assert.ok(r.removed >= 3, 'removed 统计不对：' + JSON.stringify(r));
});

// 复原
config.__root = oldRoot;
config.cache = oldCache;
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} 二级缓存：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
