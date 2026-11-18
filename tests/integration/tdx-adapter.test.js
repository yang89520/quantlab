'use strict';
/**
 * 通达信网关适配器（docs/dev/10 §3.1）。
 *
 * 用 fetch 替身，**不打真实网关** —— 单测不能依赖外部服务是否在跑，
 * 否则换台机器跑测试就红绿不定。真实连通性由 `npm run tdx:probe` 覆盖。
 *
 * 重点验证三件事：
 *   1. 开关关掉时立刻不可用（不能被上次探活缓存拖住 60 秒）
 *   2. `until` 必须原样透传给网关 —— 回补历史日靠它防前视偏差
 *   3. 网关 5xx / 超时不把异常往上抛成崩溃，只返回失败
 */
const assert = require('assert');
const path = require('path');

let pass = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++; console.log('  ✓ ' + name);
  } catch (e) {
    failed++; console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const config = require(path.join(ROOT, 'lib', 'config'));
const tdx = require(path.join(ROOT, 'lib', 'sources', 'adapters', 'tdx'));

const originalCfg = JSON.parse(JSON.stringify(config.sources.tdx || {}));
const realFetch = global.fetch;
let lastUrl = null;

/** 装一个假网关：handler 返回 {status, body} */
function stubGateway(handler) {
  global.fetch = async (url, opts) => {
    lastUrl = String(url);
    const r = handler(String(url), opts);
    if (r instanceof Error) throw r;
    return {
      status: r.status || 200,
      json: async () => r.body,
    };
  };
}

(async () => {
  console.log('通达信网关适配器');

  await check('health 通 → available()=true，且第二次走缓存不重复请求', async () => {
    let hits = 0;
    stubGateway(() => { hits++; return { body: { ok: true, data: { server: 'x' } } }; });
    config.sources.tdx = Object.assign({}, originalCfg, { enabled: true, baseUrl: 'http://stub:7710' });
    assert.strictEqual(await tdx.available(true), true);
    assert.strictEqual(await tdx.available(), true);
    assert.strictEqual(hits, 1, '第二次应命中 60s 缓存，实际请求了 ' + hits + ' 次');
    return true;
  });

  await check('开关关掉时立刻不可用（不被探活缓存拖住）', async () => {
    stubGateway(() => ({ body: { ok: true, data: {} } }));
    await tdx.available(true);                        // 先让它缓存成「可用」
    config.sources.tdx.enabled = false;
    assert.strictEqual(await tdx.available(), false,
      'enabled=false 时必须立刻 false，否则关掉网关还会被调用');
    return true;
  });

  await check("kline 把 until 原样传给网关（回补历史日靠它防前视）", async () => {
    stubGateway((url) => {
      assert.ok(/until=2026-11-16/.test(url), 'URL 里没有 until：' + url);
      assert.ok(/code=880301/.test(url), 'URL 里没有 code：' + url);
      return {
        body: {
          ok: true,
          data: {
            code: '880301', asOf: '2026-11-16', upCount: 16, downCount: 12,
            rows: [['2026-11-16', 1, 2, 3, 0.5, 100, 1000]],
            source: 'tdx', level: 'B', ms: 50,
          },
        },
      };
    });
    config.sources.tdx = Object.assign({}, originalCfg, { enabled: true, baseUrl: 'http://stub:7710' });
    const r = await tdx.kline('880301', { bars: 5, until: '2026-11-16' });
    assert.strictEqual(r.asOf, '2026-11-16');
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.upCount, 16);
    assert.strictEqual(r.level, 'B', '网络源必须是 level=B');
    return true;
  });

  await check('网关返回 ok:false → 抛错，由调用方降级（不是静默返回空）', async () => {
    stubGateway(() => ({ status: 502, body: { ok: false, error: '通达信服务器全部不可用' } }));
    let err = null;
    try { await tdx.kline('sh600000', { bars: 5 }); } catch (e) { err = e; }
    assert.ok(err, '网关报错却当成成功返回了');
    assert.ok(/全部不可用/.test(err.message), '错误信息丢了：' + err.message);
    return true;
  });

  await check('网关连不上 → available()=false 且不抛异常', async () => {
    stubGateway(() => new Error('ECONNREFUSED'));
    config.sources.tdx = Object.assign({}, originalCfg, { enabled: true, baseUrl: 'http://stub:7710' });
    const ok = await tdx.available(true);
    assert.strictEqual(ok, false);
    return true;
  });

  await check('板块指数代码识别：880xxx 是，sh000001 / 600000 不是', async () => {
    assert.strictEqual(tdx.isBlockIndex('880301'), true);
    assert.strictEqual(tdx.isBlockIndex('880081'), true);
    assert.strictEqual(tdx.isBlockIndex('sh000001'), false);
    assert.strictEqual(tdx.isBlockIndex('600000'), false);
    assert.strictEqual(tdx.isBlockIndex(''), false);
    return true;
  });

  global.fetch = realFetch;
  config.sources.tdx = originalCfg;

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' 通达信适配器：' + pass + ' 通过 / ' + failed + ' 失败');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error('用例自身崩了：' + e.stack);
  process.exitCode = 1;
});
