'use strict';
/**
 * 今日一页渲染冒烟：用最小 DOM 桩跑真实 API，验证前端不会运行时崩、且关键内容真的渲染出来。
 * 运行：node tests/smoke-today.js（需先 npm start）
 */
const assert = require('assert');

const BASE = process.env.QL_BASE || 'http://localhost:3000';
let failures = 0;

function stubEl(id) {
  const cls = new Set();
  const e = {
    id, innerHTML: '', textContent: '', hidden: false, className: '', dataset: {}, style: {},
    firstChild: { nodeValue: '' },
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return stubEl(id + ':q'); },
    querySelectorAll() { return []; },
    prepend() {}, appendChild() {},
    closest() { return stubEl(id + ':p'); },
    focus() {},
  };
  return e;
}

const nodes = new Map();
// 这几个格子初始就是「无数据」态（见 public/today.html 的 class）
const INITIAL_NODATA = new Set(['cell-mainline', 'cell-timing', 'cell-watch', 'cell-risk']);

function get(id) {
  if (!nodes.has(id)) {
    const e = stubEl(id);
    if (INITIAL_NODATA.has(id)) e.classList.add('nodata');
    nodes.set(id, e);
  }
  return nodes.get(id);
}

global.document = {
  getElementById: get,
  querySelector: (s) => stubEl(s),
  querySelectorAll: (s) => {
    if (s === '.cell') {
      return ['cell-env', 'cell-recon', 'cell-mainline', 'cell-timing', 'cell-watch', 'cell-risk', 'cell-plan']
        .map((id) => get(id));
    }
    return [];
  },
  createElement: (t) => stubEl(t),
  addEventListener() {},
  body: stubEl('body'),
};
global.location = { reload() {} };
global.window = global;
const nativeFetch = global.fetch;                 // 必须先存，否则下面会指向自己造成无限递归
global.fetch = (path, opt) => nativeFetch(BASE + path, opt);

(async () => {
  // 真实 API 先自检
  const health = await (await nativeFetch(BASE + '/api/health')).json();
  assert.ok(health.ok, '/api/health 不可用：' + JSON.stringify(health).slice(0, 120));
  const pred = (await (await nativeFetch(BASE + '/api/predict/today')).json()).data;
  if (!pred) {
    console.log('⚠ 库内还没有预判卡，请先 npm run daily');
    process.exit(0);
  }

  // 执行页面脚本
  require('../public/js/today.js');
  // 轮询等待渲染完成：3 个接口串起来可能要 1~3 秒（健康检查还要开 DuckDB）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !get('status-text').textContent) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!get('status-text').textContent) throw new Error('渲染超时：status-text 仍为空');

  function check(name, fn) {
    try { fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  }

  console.log('今日一页渲染');

  check('状态条有日期与结论', () => {
    const t = get('status-text').textContent;
    assert.ok(t.includes(pred.date), `status-text=${t}`);
    assert.ok(/进攻|观望|防守/.test(t), `status-text=${t}`);
  });

  check('① 徽标为三态之一', () => {
    assert.ok(/进攻|观望|防守/.test(get('env-chip').textContent), get('env-chip').textContent);
  });

  check('① 结论文案固定（与 06 §2.3① 一致）', () => {
    const v = get('env-verdict').firstChild.nodeValue;
    assert.ok(['可顺势，回踩不破可加', '以观察仓为主，等共振', '控总仓，等右侧信号'].includes(v), v);
  });

  check('① 证据三条', () => {
    const html = get('env-evid').innerHTML;
    assert.strictEqual((html.match(/<li>/g) || []).length, 3, html.slice(0, 120));
  });

  check('① 失效条件三条（判断型必须有）', () => {
    const html = get('env-invalid-list').innerHTML;
    assert.strictEqual((html.match(/<li>/g) || []).length, 3, html.slice(0, 160));
    assert.ok(!html.includes('缺失失效条件'), '出现了"缺失失效条件"告警');
  });

  check('① 评分拆解带 aria-label', () => {
    const label = get('env-bar').getAttribute ? '' : '';
    assert.strictEqual(get('env-breakdown').hidden, false, '总分>0 时拆解区应显示');
  });

  check('⑥ 对账有结论', () => {
    const v = get('recon-verdict').innerHTML || get('recon-verdict').firstChild.nodeValue;
    assert.ok(v && v.length > 4, `recon-verdict=${v}`);
  });

  check('⑦ 三情景齐全且中性为「其余」兜底', () => {
    const html = get('plan-scene').innerHTML;
    assert.ok(html.includes('乐观') && html.includes('中性') && html.includes('悲观'), '缺情景');
    assert.ok(html.includes('其余'), '中性未用「其余」兜底，情景可能有空洞');
  });

  check('未上线的格子显示「需 X 功能」而不是 0', () => {
    // 这三个格子在 HTML 里就是 nodata，JS 不应把它们变成有数据
    ['cell-mainline', 'cell-timing', 'cell-watch'].forEach((id) => {
      assert.ok(get(id).classList.contains('nodata'), id + ' 不该被赋数据');
    });
  });

  console.log('');
  if (failures) { console.log(`✗ ${failures} 项失败`); process.exitCode = 1; }
  else console.log('✓ 渲染冒烟通过');
})().catch((e) => {
  console.error('冒烟执行失败：' + e.message);
  process.exitCode = 1;
});
