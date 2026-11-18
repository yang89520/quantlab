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

  await check('snapshot 转换正确：市场前缀、涨跌幅、振幅、缺字段落 null', async () => {
    stubGateway(() => ({
      body: {
        ok: true,
        data: {
          count: 3, aShareCodes: 3, ms: 100, source: 'tdx',
          list: [
            // 平安银行：涨 1.2%，振幅 (12.31-12.03)/12.25 = 2.29%
            { code: 'sz000001', price: 12.20, preClose: 12.25, open: 12.24, high: 12.31, low: 12.03, volume: 1362498, amount: 1660573184 },
            // 停牌/无报价：price=0 必须被剔除，不能进快照（否则 breadth 分母被污染）
            { code: 'sz000002', price: 0, preClose: 8, open: 0, high: 0, low: 0, volume: 0, amount: 0 },
            // 缺前收：chgPct 必须是 null，不能算成 0
            { code: 'sh600000', price: 10.72, preClose: 0, open: 10.76, high: 10.89, low: 10.68, volume: 65527000, amount: 705135680 },
          ],
        },
      },
    }));
    config.sources.tdx = Object.assign({}, originalCfg, { enabled: true, baseUrl: 'http://stub:7710' });
    const s = await tdx.snapshot();
    assert.strictEqual(s.count, 2, 'price=0 的应被剔除，实际 ' + s.count);
    assert.strictEqual(s.invalid, 1);
    const p = s.data.find((x) => x.code === '000001');
    assert.ok(p, '缺 000001');
    assert.strictEqual(p.symbol, 'sz000001', 'symbol 必须带市场前缀（000001 沪深同号）');
    assert.strictEqual(p.code, '000001', 'code 必须是 6 位');
    assert.ok(Math.abs(p.chgPct - (-0.4082)) < 0.01, 'chgPct 不对：' + p.chgPct);
    assert.ok(Math.abs(p.amplitude - 2.29) < 0.02, 'amplitude 不对：' + p.amplitude);
    assert.strictEqual(p.amount, 1660573184);
    // 通达信协议没有这两个字段，必须落 null（D1：缺就是缺，不拿别的估算）
    assert.strictEqual(p.turnover, null);
    assert.strictEqual(p.floatCap, null);
    assert.deepStrictEqual(s.nullFields, ['turnover', 'floatCap']);
    const noPre = s.data.find((x) => x.code === '600000');
    assert.strictEqual(noPre.chgPct, null, '缺前收时 chgPct 必须是 null');
    assert.strictEqual(noPre.amplitude, null);
    return true;
  });

  await check('全市场代码必须带市场前缀（跨市场同号不能混）', async () => {
    // 直接验证适配器不会把 sh600000 和 sz000001 的 6 位尾号当成同一只
    stubGateway(() => ({
      body: {
        ok: true, data: {
          list: [
            { code: 'sh600000', price: 10, preClose: 9, high: 10, low: 9, volume: 1, amount: 1 },
            { code: 'sz000001', price: 12, preClose: 11, high: 12, low: 11, volume: 1, amount: 1 },
            { code: 'sh000001', price: 3500, preClose: 3490, high: 3510, low: 3480, volume: 1, amount: 1 },
          ],
        },
      },
    }));
    config.sources.tdx = Object.assign({}, originalCfg, { enabled: true, baseUrl: 'http://stub:7710' });
    const s = await tdx.snapshot();
    const syms = s.data.map((x) => x.symbol);
    assert.deepStrictEqual(syms, ['sh600000', 'sz000001', 'sh000001']);
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
