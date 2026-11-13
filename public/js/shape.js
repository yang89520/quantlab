/* ============================================================
 * QuantLab · 形态特征（前后端共用）
 *
 * 同一份实现被两边加载：
 *   · 浏览器：window.QLShape.shapeOf(rows)  —— 选股页过滤与打标
 *   · Node  ：require('./public/js/shape')  —— 服务端全池扫描
 * 之所以抽出来，是因为「服务端批量扫主板 3000+ 只」和「前端精算」
 * 必须给出同一个形态判定，否则同一只票在扫描结果和精算结果里会互相打架。
 *
 * 入参 rows：[日期, 开, 收, 高, 低, 成交量(手), 成交额(元)]（升序）
 * 全部指标只用尾部窗口，因此 260 根与 1200 根算出的结果完全相同。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QLShape = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 判定形态需要的最少 K 线根数：MA60(60) / 年内位置(250) 取大者 */
  const MIN_BARS = 250;

  function sma(arr, m) {
    const out = new Array(arr.length).fill(null);
    for (let i = m - 1; i < arr.length; i++) {
      let s = 0;
      for (let j = i - m + 1; j <= i; j++) s += arr[j];
      out[i] = s / m;
    }
    return out;
  }

  /**
   * 形态特征：全部由真实 K 线算出，不含任何推断值。
   * @param {Array} rows [d,o,c,h,l,v,a] 升序
   */
  function shapeOf(rows) {
    const n = (rows || []).length;
    if (n < 60) return null;              // 不足 60 根连 MA60 都算不出来，直接判为不可判定

    const c = rows.map((r) => r[2]);
    const h = rows.map((r) => r[3]);
    const l = rows.map((r) => r[4]);
    const v = rows.map((r) => r[5]);

    const ma5 = sma(c, 5), ma10 = sma(c, 10), ma20 = sma(c, 20), ma60 = sma(c, 60);
    const i = n - 1;
    const cl = c[i];

    const maBull = ma5[i] != null && ma60[i] != null && ma5[i] > ma10[i] && ma10[i] > ma20[i] && ma20[i] > ma60[i];
    const above20 = ma20[i] != null && cl > ma20[i];
    const ma20Up = ma20[i] != null && ma20[i - 3] != null && ma20[i] > ma20[i - 3];

    let vs = 0, vn = 0;
    for (let k = i - 5; k < i; k++) { if (k >= 0) { vs += v[k]; vn++; } }
    const volRatio = vn ? v[i] / (vs / vn) : null;
    const volUp = volRatio != null && volRatio > 1.5;

    const w = Math.min(60, n);
    let hi60 = -Infinity;
    for (let k = i - w + 1; k <= i; k++) hi60 = Math.max(hi60, h[k]);
    const new60 = h[i] >= hi60 - 1e-9;

    const gain5 = i >= 5 && c[i - 5] ? (cl / c[i - 5] - 1) * 100 : null;

    const w2 = Math.min(250, n);
    let loY = Infinity, hiY = -Infinity;
    for (let k = i - w2 + 1; k <= i; k++) { loY = Math.min(loY, l[k]); hiY = Math.max(hiY, h[k]); }
    const pos = hiY > loY ? (cl - loY) / (hiY - loY) * 100 : null;

    const tags = [];
    if (maBull) tags.push('多头');
    if (new60) tags.push('60日新高');
    if (volUp) tags.push('放量' + volRatio.toFixed(1) + '×');
    if (gain5 != null && gain5 >= 15) tags.push('5日+' + gain5.toFixed(0) + '%');
    if (pos != null && pos >= 95) tags.push('年内高位');
    if (pos != null && pos <= 10) tags.push('年内低位');

    return {
      maBull, above20, ma20Up, volUp, new60,
      gain5, pos, volRatio, tags,
      ma20: ma20[i], ma60: ma60[i],
      last: rows[i][0],
      bars: n,
    };
  }

  /** 股池规则（与选股页面板上的分段一一对应） */
  const POOLS = {
    all: null,
    main: (c) => /^(600|601|603|605|000|001|002|003)/.test(c),   // 沪深主板（含原中小板 002/003）
    sh: (c) => /^6/.test(c),
    sz: (c) => /^(0|3)/.test(c),
    cyb: (c) => /^30/.test(c),
    kcb: (c) => /^688/.test(c),
    bj: (c) => /^(4|8|9)/.test(c),
  };

  function inPool(code, pool) {
    const f = POOLS[pool];
    return f ? f(code) : true;
  }

  return { shapeOf, sma, inPool, POOLS, MIN_BARS };
});
