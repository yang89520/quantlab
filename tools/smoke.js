#!/usr/bin/env node
'use strict';
/**
 * QuantLab 回归冒烟
 *
 * 这个项目原本没有任何自动化测试，所有验证都是「打开浏览器看一眼」。
 * 这里补一套能被变异打掉的断言，分两组：
 *
 *   [纯函数] 完全离线，只依赖 lib/ 与 public/js/shape.js。
 *            改坏清洗规则、形态判定、代码空间、周期聚合，这里必须红。
 *   [接口]   真起一个服务进程打真实上游，验证前后端契约没断。
 *            上游挂了会红，此时看提示里的分组名区分「代码问题」还是「网络问题」。
 *
 * 用法：
 *   node tools/smoke.js            # 全跑
 *   node tools/smoke.js --offline  # 只跑纯函数组（无网络环境）
 *
 * 退出码 0 = 全绿，1 = 有失败项。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OFFLINE = process.argv.includes('--offline');

let pass = 0;
const fails = [];

function group(name) { console.log('\n' + name); }

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails.push(name + ' \u2192 ' + e.message);
    console.log('  \u2717 ' + name + ' \u2192 ' + e.message);
  }
}

function eq(actual, expect, hint) {
  if (actual !== expect) {
    throw new Error((hint ? hint + ' ' : '') + '期望 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(actual));
  }
}
function ok(v, hint) { if (!v) throw new Error(hint || '期望为真，实际为假'); }
function has(arr, v, hint) {
  if (!Array.isArray(arr) || arr.indexOf(v) < 0) {
    throw new Error((hint || '') + ' 期望包含 ' + JSON.stringify(v) + '，实际 ' + JSON.stringify(arr));
  }
}

/* ============================================================
 * 一、纯函数组
 * ============================================================ */

const clean = require('../lib/clean');
const shape = require('../public/js/shape');
const quote = require('../lib/quote');
const S = require('../lib/sources');

group('[纯函数] 代码空间：指数与个股不互相顶掉');
check('裸 6 位按首位判市场', () => {
  eq(quote.normalize('600519').market, 'sh');
  eq(quote.normalize('000001').market, 'sz');
  eq(quote.normalize('430047').market, 'bj');
});
check('个股用裸码做键，指数带前缀', () => {
  eq(quote.normalize('600519').key, '600519');
  eq(quote.normalize('600519').asset, 'stock');
  // 000001 裸码是平安银行（深市个股），加 sh 前缀才是上证指数
  eq(quote.normalize('000001').asset, 'stock');
  eq(quote.normalize('sh000001').asset, 'index');
  eq(quote.normalize('sh000001').key, 'sh000001');
});
check('后缀写法与非法输入', () => {
  eq(quote.normalize('600519.SH').market, 'sh');
  eq(quote.normalize('sz000001').market, 'sz');
  eq(quote.normalize('abc'), null);
  eq(quote.normalize('60051'), null);
});

group('[纯函数] K 线清洗：只修确定的，不补缺的');
check('非正价格被丢弃', () => {
  const r = clean.sanitize([
    { d: '2026-01-05', o: 0, c: 10, h: 10, l: 10, v: 1, a: 1 },
    { d: '2026-01-06', o: 10, c: 11, h: 11, l: 10, v: 1, a: 1 },
  ], { code: '600519' });
  eq(r.rows.length, 1, '只应留下合法那根');
  ok(r.quality.droppedN >= 1, '丢弃数应被记录');
});
check('OHLC 包络被收敛，收盘价不动', () => {
  const r = clean.sanitize([
    { d: '2026-01-05', o: 10, c: 12, h: 11, l: 9, v: 1, a: 1 }, // high < close
  ], { code: '600519' });
  // sanitize 对外返回对象行 {d,o,c,h,l,v,a}，不是数组行
  eq(r.rows[0].h, 12, 'high 应抬到 max(open,close)');
  eq(r.rows[0].c, 12, 'close 不应被改动');
  ok(r.quality.fixedN >= 1, '修正数应被记录');
});
check('重复日期只留一根，乱序被排好', () => {
  const r = clean.sanitize([
    { d: '2026-01-06', o: 10, c: 11, h: 11, l: 10, v: 1, a: 1 },
    { d: '2026-01-05', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 },
    { d: '2026-01-06', o: 10, c: 11, h: 11, l: 10, v: 1, a: 1 },
  ], { code: '600519' });
  eq(r.rows.length, 2);
  eq(r.rows[0].d, '2026-01-05');
  eq(r.rows[1].d, '2026-01-06');
});
check('不插值：输出根数 === 输入合法根数', () => {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    const d = '2026-01-' + String(i).padStart(2, '0');
    rows.push({ d, o: 10, c: 10 + i * 0.1, h: 11 + i * 0.1, l: 9, v: 100, a: 1000 });
  }
  const r = clean.sanitize(rows, { code: '600519' });
  eq(r.rows.length, 40, '一根都不许凭空生成');
});
check('跨年整段缺失被判为 year 且整体不可用', () => {
  const r = clean.sanitize([
    { d: '2024-12-31', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 },
    { d: '2026-04-17', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 },
  ], { code: '600519' });
  ok(r.quality.gaps.length >= 1, '应报出缺口');
  eq(r.quality.gaps[0].kind, 'year');
  eq(r.quality.ok, false, '含整年缺口的数据不可用');
});
check('短期停牌不误报成数据缺失', () => {
  // 20 天间隔 = 停牌/长假，属于行情本身，不该判 block
  const r = clean.sanitize([
    { d: '2026-01-05', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 },
    { d: '2026-01-25', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 },
  ], { code: '600519' });
  const g = r.quality.gaps[0];
  eq(g && g.kind, 'suspend', '20 天只算停牌');
});

group('[纯函数] 形态判定');
check('不足 60 根直接判不可判定', () => {
  eq(shape.shapeOf([]), null);
  eq(shape.shapeOf(new Array(59).fill([0, 1, 1, 1, 1, 1, 1])), null);
});
check('严格多头 + 放量 + 新高能识别出来', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const c = 10 + i * 0.1;
    rows.push(['2025-' + '01-01', c - 0.05, c, c + 0.1, c - 0.1, i === 299 ? 5000 : 1000, 1e6]);
  }
  // 日期必须单调，这里只关心数值，shape 不看日期先后
  const f = shape.shapeOf(rows);
  ok(f, '应返回特征');
  eq(f.maBull, true, '均线应多头排列');
  has(f.tags, '多头');
  eq(f.new60, true, '应为 60 日新高');
  eq(f.volUp, true, '放量应被识别');
});
check('下跌序列不应被判多头', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const c = 50 - i * 0.1;
    rows.push(['2025-01-01', c + 0.05, c, c + 0.1, c - 0.1, 1000, 1e6]);
  }
  const f = shape.shapeOf(rows);
  eq(f.maBull, false, '空头排列不能报多头');
  ok(f.tags.indexOf('多头') < 0);
});
check('股池规则与选股页分段一致', () => {
  eq(shape.inPool('600519', 'main'), true);
  eq(shape.inPool('300750', 'main'), false, '创业板不属于主板');
  eq(shape.inPool('300750', 'cyb'), true);
  eq(shape.inPool('688981', 'kcb'), true);
  eq(shape.inPool('430047', 'bj'), true);
  eq(shape.inPool('600519', 'all'), true);
});

group('[纯函数] 日线聚合周/月');
check('一周 5 根合成 1 根，量额求和、高点取最大', () => {
  // 2026-01-05 是周一
  const days = [];
  for (let i = 0; i < 5; i++) {
    days.push({
      d: '2026-01-0' + (5 + i),
      o: 10 + i, c: 10.5 + i, h: 12 + i, l: 9 - i * 0.1,
      v: 100, a: 1000,
    });
  }
  const w = S.aggregate(days, 'week');
  eq(w.length, 1, '同一周应合成一根');
  eq(w[0].v, 500, '成交量应求和');
  eq(w[0].a, 5000, '成交额应求和');
  eq(w[0].h, 16, '最高价取最大');
  eq(w[0].c, 14.5, '收盘价取最后一根');
  eq(w[0].d, '2026-01-09', '日期取区间最后一天');
});
check('跨周应分成两根', () => {
  const days = [
    { d: '2026-01-09', o: 10, c: 10, h: 10, l: 10, v: 1, a: 1 }, // 周五
    { d: '2026-01-12', o: 11, c: 11, h: 11, l: 11, v: 1, a: 1 }, // 下周一
  ];
  eq(S.aggregate(days, 'week').length, 2);
  eq(S.aggregate(days, 'month').length, 1, '同月应合成一根');
});

/* ============================================================
 * 二、接口组（真起服务）
 * ============================================================ */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function get(port, p, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeout || 45000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非 JSON 走原始 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + p + '）')));
    req.on('error', reject);
  });
}

async function waitUp(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { await get(port, '/', 1500); return true; } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
}

async function apiGroup() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } };

  try {
    const up = await waitUp(port, 10000);
    if (!up) {
      fails.push('[接口] 服务启动 \u2192 10 秒内未监听，日志：' + log.trim().slice(0, 400));
      console.log('\n[接口] 服务启动\n  \u2717 10 秒内未监听\n' + log);
      return;
    }
    console.log('\n[接口] 服务已在端口 ' + port + ' 启动');

    let r = await get(port, '/');
    check('首页 200 且是 HTML', () => {
      eq(r.status, 200);
      ok(/text\/html/.test(r.headers['content-type'] || ''), 'content-type 应为 html');
      ok(r.body.indexOf('QuantLab') >= 0, '页面应含 QuantLab');
    });

    r = await get(port, '/screen');
    check('选股页 200', () => eq(r.status, 200));

    r = await get(port, '/api/nope');
    check('未知接口返回 404 JSON 而不是 HTML', () => {
      eq(r.status, 404);
      ok(r.json && r.json.ok === false, '应为 {ok:false}');
    });

    r = await get(port, '/api/watchlist');
    check('自选股接口结构完整', () => {
      eq(r.status, 200);
      ok(r.json && r.json.ok === true, 'ok 应为 true');
      ok(Array.isArray(r.json.data.groups), 'groups 应为数组');
      ok(typeof r.json.data.total === 'number', 'total 应为数字');
    });

    r = await get(port, '/api/stock/600519?bars=120');
    check('个股 K 线：行格式与升序', () => {
      eq(r.status, 200);
      const d = r.json && r.json.data;
      ok(d, '应有 data');
      eq(d.asset, 'stock');
      ok(d.bars >= 100, '至少拿到 100 根，实际 ' + d.bars);
      const k = d.klines;
      eq(k[0].length, 7, '每行应为 [日期,开,收,高,低,量,额]');
      ok(k[k.length - 1][0] > k[0][0], '日期应升序');
      ok(d.quality && d.quality.ok === true, '质量标记应为可用');
    });

    r = await get(port, '/api/stock/sh000001?bars=60');    check('指数走同一接口且 isIndex 为真', () => {
      eq(r.status, 200);
      const d = r.json.data;
      eq(d.isIndex, true);
      eq(d.code, 'sh000001');
    });

    r = await get(port, '/api/stock/999999?bars=60');
    check('不存在的代码返回错误而不是假数据', () => {
      ok(r.status === 404 || (r.json && r.json.ok === false), '应为 404 或 ok:false，实际 ' + r.status);
    });

    r = await get(port, '/api/indices');
    check('指数条返回 9 个主要指数', () => {
      eq(r.status, 200);
      eq(r.json.data.length, 9);
    });

    r = await get(port, '/api/search?q=' + encodeURIComponent('茅台'));
    check('搜索能命中', () => {
      eq(r.status, 200);
      ok(Array.isArray(r.json.data) && r.json.data.length > 0, '应至少命中一条');
    });

    r = await get(port, '/api/screen/meta');
    check('数据源健康度探测有结果', () => {
      eq(r.status, 200);
      const s = r.json.data.sources;
      ok(s && s.ths && s.sina, '应含 ths/sina 等源');
    });

    // 换手率不经过 API，直接打数据层：清洗后行是对象行，
    // 对齐键若写成 r[0] 会整列静默变 null（历史 bug，已修）。
    let tk = null;
    try { tk = await require('../lib/sources').klines(quote.normalize('600519'), 60, 'day'); } catch (e) { tk = null; }
    check('换手率按日期对齐', () => {
      ok(tk, '未取到 K 线');
      if (tk.source !== 'ths') { console.log('    （本次源为 ' + tk.source + '，该源不提供换手率，跳过）'); return; }
      const n = (tk.turnover || []).filter((x) => x != null).length;
      ok(n > 0, '换手率全为 null，说明对齐键取错（应为 r.d）');
    });
  } catch (e) {
    fails.push('[接口] 未捕获异常 \u2192 ' + e.message);
    console.log('\n[接口] 未捕获异常：' + e.message);
  } finally {
    cleanup();
  }
}

/* ============================================================
 * 主流程
 * ============================================================ */

(async () => {
  if (OFFLINE) {
    console.log('\n[接口] 已按 --offline 跳过');
  } else {
    await apiGroup();
  }

  console.log('\n' + '-'.repeat(52));
  const total = pass + fails.length;
  console.log('结果：' + pass + '/' + total + ' 通过' + (fails.length ? '，' + fails.length + ' 失败' : ''));
  if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f, i) => console.log('  ' + (i + 1) + ') ' + f));
    process.exit(1);
  }
})();
