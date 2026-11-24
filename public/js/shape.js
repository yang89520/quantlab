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

    /* 威科夫 v2 结构：与选股筛选用同一份判定，260 根与 1200 根结果一致。
       放在这里而不是单独一个接口，是为了让「扫描形态」一次取数就能同时判定
       均线类与结构类条件，不额外拉一遍 K 线。 */
    const wy = wyckoff2Of(rows);

    return {
      maBull, above20, ma20Up, volUp, new60,
      gain5, pos, volRatio, tags,
      ma20: ma20[i], ma60: ma60[i],
      wy,
      last: rows[i][0],
      bars: n,
    };
  }

  /* ============================================================
   * 威科夫 v2 · 三律合参（Wyckoff v2）
   *
   * 与 v1（strategies.js 里的 wyckoff 流派）的分工：
   *   v1 用「自适应区间 + 事件时间线」定性，回答「现在像哪一段」；
   *   v2 在同一坐标系上补三样 v1 没有的东西：
   *     ① 摆动序列 —— 低点是否逐级抬高、高点是否逐级下移。这是判断
   *        「吸筹」与「下跌中继」最硬的证据，v1 只有区间边界，没有序列；
   *     ② 因果测度 —— 区间磨了多久、边界被测试多少次、波动是否收敛，
   *        合成一个 0~100 的「建仓充分度」，而不是直接外推目标价；
   *     ③ 证据投票 —— 阶段结论必须附带一致性票数与反证条件，
   *        不许只丢一个标签就完事。
   *
   * 硬约束：只用尾部 250 根，因此 260 根（全池扫描）与 1200 根（详情页精算）
   * 算出的结果完全相同。这是 shape.js 存在的意义，也是扫描与精算不打架的前提。
   * ============================================================ */
  const WY_MIN = 120;          // 少于此根数，摆动序列与区间都凑不出来
  const WY_WIN = 250;          // 统一窗口：一年交易日
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;

  /** 威科夫 v2 阶段码 → 中文名（前端展示与选股下拉共用同一份） */
  const WY_PHASE = {
    accumB: { name: '吸筹 B 段 · 区间内反复', side: 1 },
    accumC0: { name: '吸筹 C 段 · 弹簧待确认', side: 1 },
    accumC: { name: '吸筹 C 段 · 弹簧已测试', side: 1 },
    accumD0: { name: '吸筹 D 段 · SOS 待回踩', side: 1 },
    accumD: { name: '吸筹 D 段 · 突破前', side: 1 },
    markup: { name: '上升 E 段', side: 1 },
    range: { name: '区间中性', side: 0 },
    transition: { name: '过渡（趋势未定）', side: 0 },
    weak: { name: '区间内走弱', side: -1 },
    distrib: { name: '派发', side: -1 },
    markdown: { name: '下跌（markdown）', side: -1 },
  };

  /** 事件码 → 中文短名与标记方向（below = 画在 K 线下方） */
  const WY_EVENT = {
    SP: { name: '弹簧', below: true },
    TEST: { name: '测试', below: true },
    SOS: { name: 'SOS', below: false },
    LPS: { name: 'LPS', below: true },
    JAC: { name: '突破', below: false },
    BUEC: { name: '回踩', below: true },
    SC: { name: '抛售潮', below: true },
    ST: { name: '二测', below: true },
    NS: { name: '无供给', below: true },
    BC: { name: '买入潮', below: false },
    UT: { name: '假突破', below: false },
    SOW: { name: '破位', below: true },
    SHK: { name: '震仓', below: true },
    ND: { name: '无需求', below: false },
  };

  /**
   * 威科夫 v2 结构扫描。纯函数，只用尾部 250 根，无外部依赖。
   * @param {Array} rows [d,o,c,h,l,v,a] 升序
   * @returns {Object|null} null = 数据不足
   */
  function wyckoff2Of(rows) {
    const n = (rows || []).length;
    if (n < WY_MIN) return null;

    const m = Math.min(WY_WIN, n);
    const off = n - m;                       // 局部索引 → 全局索引的偏移
    const C = new Array(m), H = new Array(m), L = new Array(m), V = new Array(m);
    for (let k = 0; k < m; k++) {
      const r = rows[off + k];
      C[k] = r[2]; H[k] = r[3]; L[k] = r[4]; V[k] = r[5];
    }
    const i = m - 1;
    const px = C[i];
    if (!(px > 0)) return null;

    /* ---- ATR14（Wilder 平滑）：衡量「结果」的标尺 ---- */
    const ATR = new Array(m);
    let a14 = 0;
    for (let k = 0; k < m; k++) {
      const pc = k > 0 ? C[k - 1] : C[k];
      const tr = Math.max(H[k] - L[k], Math.abs(H[k] - pc), Math.abs(L[k] - pc));
      a14 = k === 0 ? tr : (a14 * 13 + tr) / 14;
      ATR[k] = a14;
    }

    /* ---- 量比基准：前 20 日均量，不含当日 ----
     * v1 的 volMa20 含当日，放量日会把自己算进分母，1.6 倍的真实放量显示成 1.5 倍，
     * 阈值被系统性稀释。v2 改用不含当日的前 20 日均量，与量比指标的通用口径一致。 */
    const VMA = new Array(m).fill(null);
    let vs = 0;
    for (let k = 0; k < 20 && k < m; k++) vs += V[k];
    for (let k = 20; k < m; k++) { VMA[k] = vs / 20; vs += V[k] - V[k - 20]; }
    const vrAt = (k) => (VMA[k] > 0 ? V[k] / VMA[k] : 1);

    /* ---- ① 摆动序列（2 左 2 右分形）---- */
    const SWK = 2;
    const rawHi = [], rawLo = [];
    for (let t = SWK; t < m - SWK; t++) {
      let isH = true, isL = true;
      for (let d = 1; d <= SWK; d++) {
        if (!(H[t] >= H[t - d] && H[t] >= H[t + d])) isH = false;
        if (!(L[t] <= L[t - d] && L[t] <= L[t + d])) isL = false;
      }
      if (isH) rawHi.push(t);
      if (isL) rawLo.push(t);
    }
    /** 平台去重：相邻 <3 根且价差 <0.4% 视为同一次触碰，保留靠后那根 */
    const dedupe = (arr, P) => {
      const out = [];
      for (const t of arr) {
        const last = out[out.length - 1];
        if (last != null && t - last < 3 && Math.abs(P[t] / P[last] - 1) < 0.004) out[out.length - 1] = t;
        else out.push(t);
      }
      return out;
    };
    const hiIdx = dedupe(rawHi, H);
    const loIdx = dedupe(rawLo, L);

    /** 最近 6 个摆动点的方向统计：rise = 抬高次数，fall = 下移次数（阈值 0.5%）
     * 取 6 而不是 5：下跌结构常常是「连续三个高点下移，然后反弹出一个新高」，
     * 只留 5 个会把前面那段下移截掉，只剩「一涨一跌」，读出来是走平 —— 假中性。 */
    const seqStat = (idx, P) => {
      const arr = idx.slice(-6);
      let rise = 0, fall = 0;
      for (let t = 1; t < arr.length; t++) {
        const d = P[arr[t]] / P[arr[t - 1]] - 1;
        if (d > 0.005) rise++; else if (d < -0.005) fall++;
      }
      return { rise, fall, n: arr.length, idx: arr, last: arr.length ? P[arr[arr.length - 1]] : null };
    };
    const lowSeq = seqStat(loIdx, L);
    const hiSeq = seqStat(hiIdx, H);

    /* ---- ② 交易区间（成交量密集区）----
     * 边界不用分位数，用「筹码真正换手过的价格带」：
     * 把窗口内价格分 24 档，按成交量寻峰，再从峰值向两侧扩展到 70% 量能为止。
     *
     * 为什么不用分位数：自适应窗口永远从最新往回看，下跌时当前价必然落在
     * 10% 分位附近 —— posInRange 于是恒为个位数，这个指标就废了
     * （实测全池 60% 的标的落在区间 15% 分位以下，不是市场都跌成这样，
     *  是区间定义本身把当前价钉在了底部）。
     * 用密集区定义之后，价格跌出筹码带 = posInRange < 0，语义才和威科夫对得上。
     *
     * 窗口从 60 根起逐段放大，一旦结构被破坏就停（取最长连续成立段）。
     * 下限 60 而不是 40：40 根里塞进「急跌 + 反弹」照样能凑出「净位移小、
     * 穿越中轴 4 次」的假区间，600986 那种下跌后反抽就是这么被误判成横盘的。 */
    const profRange = (st, w) => {
      let lo = Infinity, hi = -Infinity;
      for (let t = st; t < st + w; t++) { if (L[t] < lo) lo = L[t]; if (H[t] > hi) hi = H[t]; }
      const B = 24, step = (hi - lo) / B;
      if (!(step > 0)) return null;
      const bins = new Array(B).fill(0);
      for (let t = st; t < st + w; t++) {
        const a = Math.max(0, Math.floor((L[t] - lo) / step));
        const b = Math.min(B - 1, Math.floor((H[t] - lo) / step));
        const share = V[t] / (b - a + 1);          // 单根 K 线的量按覆盖档数均摊
        for (let k = a; k <= b; k++) bins[k] += share;
      }
      const total = bins.reduce((x, y) => x + y, 0);
      if (!(total > 0)) return null;
      let pk = 0;
      for (let k = 1; k < B; k++) if (bins[k] > bins[pk]) pk = k;
      let a = pk, b = pk, acc = bins[pk];
      // 覆盖 80% 量能：70% 太窄，会把「带内正常回撤」误判成跌破（实测 54% 的标的被判跌破筹码带）
      while (acc < total * 0.8 && (a > 0 || b < B - 1)) {
        const lv = a > 0 ? bins[a - 1] : -1;
        const rv = b < B - 1 ? bins[b + 1] : -1;
        if (rv >= lv) { b++; acc += Math.max(0, rv); } else { a--; acc += Math.max(0, lv); }
      }
      // 分档会把边界向外取整，clamp 回真实最高/最低价，否则会出现「上沿 8.12 高于窗口最高价 8.02」
      return { sup: Math.max(lo, lo + a * step), res: Math.min(hi, lo + (b + 1) * step) };
    };

    let R = null;
    for (let w = 60; w <= Math.min(200, m); w += 20) {
      const st = m - w;
      const pr = profRange(st, w);
      if (!pr || !(pr.sup > 0 && pr.res > pr.sup)) break;
      const s2 = pr.sup, r0 = pr.res;
      const mid0 = (s2 + r0) / 2, rh0 = r0 - s2;
      if (!(rh0 / mid0 > 0.06 && rh0 / mid0 < 0.35)) { if (R) break; continue; }
      // 净位移超过区间高度的 60% 就是趋势，不是横盘
      if (Math.abs(C[i] - C[st]) / rh0 >= 0.6) { if (R) break; continue; }
      let cr = 0;
      for (let t = st + 1; t < m; t++) if ((C[t - 1] - mid0) * (C[t] - mid0) < 0) cr++;
      if (cr < 4) { if (R) break; continue; }
      // 七成以上的 K 线要待在带内，否则这条带只是「路过的一个价格」
      let inside = 0;
      for (let t = st; t < m; t++) if (C[t] >= s2 && C[t] <= r0) inside++;
      if (inside / w < 0.55) { if (R) break; continue; }
      // 边界被反复触及：这是「带」能被叫「区间」的前提
      let supT = 0, resT = 0;
      for (let t = st; t < m; t++) {
        if (L[t] <= s2 * 1.005) supT++;      // 真正触到下沿，不是「离下沿 2% 以内」
        if (H[t] >= r0 * 0.995) resT++;
      }
      if (supT < 3 || resT < 3) { if (R) break; continue; }
      R = { w, st, sup: s2, res: r0, mid: mid0, rh: rh0, cr, supT, resT };
    }

    /** 无有效区间时仍需要一个参考边界，否则事件判定的坐标都没了 */
    let refSup, refRes;
    if (R) { refSup = R.sup; refRes = R.res; }
    else {
      const pr = profRange(Math.max(0, m - 120), Math.min(120, m));
      if (pr) { refSup = pr.sup; refRes = pr.res; }
      else {
        let lo = Infinity, hi = -Infinity;
        for (let t = 0; t < m; t++) { if (L[t] < lo) lo = L[t]; if (H[t] > hi) hi = H[t]; }
        refSup = lo; refRes = hi;
      }
    }
    const isRange = !!R;
    const sup = refSup, res = refRes;
    const mid = (sup + res) / 2;
    const rh = Math.max(res - sup, px * 0.01);
    const st0 = R ? R.st : Math.max(1, m - 120);

    /* ---- ③ 事件识别 ---- */
    const EV = {
      SC: [], BC: [], ST: [], SP: [], TEST: [], SOS: [], LPS: [],
      UT: [], SOW: [], SHK: [], JAC: [], BUEC: [], ND: [], NS: [],
    };

    // 抛售高潮 / 买入高潮：宽幅 + 巨量 + 收盘反向脱离极值
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc) continue;
      const chg = C[t] / pc - 1;
      const cp = H[t] > L[t] ? (C[t] - L[t]) / (H[t] - L[t]) : 0.5;
      const vr = vrAt(t);
      if (chg <= -0.045 && vr >= 1.6 && cp >= 0.35) EV.SC.push(t);
      if (chg >= 0.045 && vr >= 1.6 && cp <= 0.65) EV.BC.push(t);
    }
    // 二次测试：回到抛售高潮低点附近但量明显萎缩
    for (const s of EV.SC) {
      for (let t = s + 4; t < Math.min(m, s + 45); t++) {
        const gap = L[t] / L[s] - 1;
        if (gap > 0.035 || gap < -0.02) continue;
        if (V[t] < V[s] * 0.75) { EV.ST.push(t); break; }
      }
    }
    // 弹簧：盘中破区间下沿、收盘收回，且这条下沿此前已被反复验证
    for (let t = Math.max(st0 + 5, 3); t < m; t++) {
      if (!(L[t] < sup * 0.995 && C[t] > sup * 1.001)) continue;
      let inside = 0;
      for (let k = t - 3; k < t; k++) if (C[k] > sup * 0.99) inside++;
      if (inside < 2) continue;
      if (vrAt(t) > 2.4) continue;                 // 巨量破位更像真破位
      let prior = 0;
      for (let k = st0; k < t - 1; k++) if (L[k] <= sup * 1.02 && C[k] > sup * 0.995) prior++;
      if (prior < 2) continue;
      if (R && t < R.st + R.w * 0.5) continue;     // 弹簧属于区间后段
      if (EV.SP.length && t - EV.SP[EV.SP.length - 1] < 10) EV.SP[EV.SP.length - 1] = t;
      else EV.SP.push(t);
    }
    // 弹簧测试：缩量回踩且低点抬高
    for (const s of EV.SP) {
      for (let t = s + 2; t < Math.min(m, s + 15); t++) {
        if (L[t] > L[s] * 1.002 && C[t] > sup * 0.99 && V[t] < V[s] * 0.85) { EV.TEST.push(t); break; }
      }
    }
    // SOS：放量向上，穿越中轴或创 20 根收盘新高
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc) continue;
      const chg = C[t] / pc - 1;
      const crossed = pc <= mid * 1.005 && C[t] > mid;
      let hh20 = 0;
      for (let k = Math.max(st0, t - 20); k < t; k++) if (C[k] > hh20) hh20 = C[k];
      if (chg >= 0.025 && vrAt(t) >= 1.6 && (crossed || C[t] > hh20)) EV.SOS.push(t);
    }
    // LPS：SOS 后缩量回踩，守住区间上半部
    for (const s of EV.SOS) {
      for (let t = s + 2; t < Math.min(m, s + 20); t++) {
        if (L[t] > sup + rh * 0.45 && C[t] > mid && V[t] < V[s] * 0.9) { EV.LPS.push(t); break; }
      }
    }
    // 上冲回落 / 弱势跌破
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc) continue;
      if (H[t] > res * 1.005 && pc < res && C[t] < res * 0.995
        && vrAt(t) >= 1.2 && (H[t] - C[t]) > ATR[t] * 0.5) {
        let prior = 0;
        for (let k = st0; k < t - 1; k++) if (H[k] >= res * 0.98 && C[k] < res * 1.005) prior++;
        if (prior >= 2 && !(EV.UT.length && t - EV.UT[EV.UT.length - 1] < 10)) EV.UT.push(t);
      }
      if (pc >= mid * 0.995 && C[t] < mid && C[t] / pc - 1 <= -0.025 && vrAt(t) >= 1.4) EV.SOW.push(t);
    }
    /* v2 新增四个事件：震仓 / 跳过小溪 / 回踩溪边 / 无需求·无供给 */
    // 震仓：3 日内急跌 7% 以上、有放量，且 5 日内收复跌幅的 40%
    for (let t = st0 + 3; t < m; t++) {
      const base = C[t - 3];
      if (!base) continue;
      const drop = C[t] / base - 1;
      if (drop > -0.07) continue;
      let vmax = 0;
      for (let k = t - 2; k <= t; k++) vmax = Math.max(vmax, vrAt(k));
      if (vmax < 1.8) continue;
      const need = base * (1 + drop * 0.4);
      let ok = false;
      for (let k = t + 1; k <= Math.min(m - 1, t + 5); k++) if (C[k] >= need) { ok = true; break; }
      if (!ok) continue;
      if (EV.SHK.length && t - EV.SHK[EV.SHK.length - 1] < 8) continue;
      EV.SHK.push(t);
    }
    // JAC：放量收在区间上沿之上
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc) continue;
      if (C[t] > res * 1.005 && pc <= res && vrAt(t) >= 1.5) EV.JAC.push(t);
    }
    // BUEC：突破后回踩上沿不破，且量能萎缩
    for (const s of EV.JAC) {
      for (let t = s + 2; t < Math.min(m, s + 15); t++) {
        if (L[t] <= res * 1.03 && L[t] >= res * 0.97 && C[t] > res * 0.99 && V[t] < V[s] * 0.8) {
          EV.BUEC.push(t); break;
        }
      }
    }
    // 无需求：涨到阻力附近却没人跟量
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc || C[t] <= pc) continue;
      if (vrAt(t) >= 0.6) continue;
      if (C[t] < res * 0.95) continue;
      EV.ND.push(t);
    }
    // 无供给：跌到支撑附近却没量出
    for (let t = st0 + 1; t < m; t++) {
      const pc = C[t - 1];
      if (!pc || C[t] >= pc) continue;
      if (vrAt(t) >= 0.6) continue;
      if (C[t] > sup * 1.05) continue;
      EV.NS.push(t);
    }

    /* ---- ④ 位置与量价度量 ---- */
    const wY = Math.min(250, m);
    let loY = Infinity, hiY = -Infinity;
    for (let t = m - wY; t < m; t++) { if (L[t] < loY) loY = L[t]; if (H[t] > hiY) hiY = H[t]; }
    const pos250 = hiY > loY ? (px - loY) / (hiY - loY) * 100 : 50;
    const posInRange = rh > 0 ? (px - sup) / rh : 0.5;

    let uv = 0, un = 0, dv = 0, dn = 0;
    for (let t = Math.max(1, m - 20); t < m; t++) {
      if (C[t] >= C[t - 1]) { uv += V[t]; un++; } else { dv += V[t]; dn++; }
    }
    const upV = un ? uv / un : 0, dnV = dn ? dv / dn : 0;
    const sr = dnV > 0 ? upV / dnV : 1;          // >1 = 上涨日更放量，需求主导

    let path = 0;
    for (let t = Math.max(1, m - 20); t < m; t++) path += Math.abs(C[t] - C[t - 1]) / C[t - 1] * 100;
    const base20 = C[Math.max(0, i - 20)];
    const net = base20 ? (px / base20 - 1) * 100 : 0;
    const eff = path > 0.01 ? net / path : 0;    // 净位移 / 累计路径：接近 ±1 是单边

    /* 60 根净涨跌：摆动点只能看到「最近几个拐点」，样本太少，
     * 单独用它判下跌会把横盘里一次正常回撤也算成下移。
     * 加一条中期净方向做交叉约束 —— 两条同时指向下才认。 */
    const base60 = C[Math.max(0, i - 60)];
    const ret60 = base60 ? (px / base60 - 1) * 100 : 0;

    /* 量价背离：努力大、结果小 —— 威科夫第三定律的核心度量。
     * 单看「量比 2 倍却只涨 1%」还不够，得跟这只票自己的波动幅度比：
     * 用 ATR 归一化后，4 倍量推出 0.3 个 ATR 才算真的「推不动」。
     * 600986 的 11-06 就是这样：220.6 万手（4.24 倍）只涨 1.44%，
     * 换成 ATR 口径只有 0.29，是全样本最典型的一次背离。 */
    let stall = 0, stallUp = 0, thinUp = 0, thinDn = 0;
    for (let t = Math.max(1, m - 20); t < m; t++) {
      const cg = (C[t] / C[t - 1] - 1) * 100, vr = vrAt(t);
      const atrPct = C[t] > 0 ? ATR[t] / C[t] * 100 : 0;
      if (vr >= 2 && atrPct > 0 && Math.abs(cg) < atrPct * 0.6) {
        stall++;
        if (cg > 0) stallUp++;
      }
      if (vr < 0.7 && cg > 1) thinUp++;
      if (vr < 0.7 && cg < -1) thinDn++;
    }

    /* ---- ⑤ 阶段判定 + 证据投票 ---- */
    const recent = (arr, k) => {
      for (let t = arr.length - 1; t >= 0; t--) if (arr[t] >= m - k) return arr[t];
      return -1;
    };
    /* 弹簧与测试的时效窗口只有 25 根：C 段的定义是「弹簧刚被确认」，
     * 放到 45 根会让「一个多月前测过、之后涨了 20%」的票仍然挂在 C 段上
     * （华胜天成 600410 就是这么被判成「吸C + 5日+21%」的）。 */
    const rSP = recent(EV.SP, 30), rTEST = recent(EV.TEST, 25);
    const rSOS = recent(EV.SOS, 45), rLPS = recent(EV.LPS, 45);
    const rUT = recent(EV.UT, 45), rSOW = recent(EV.SOW, 45);
    const rSC = recent(EV.SC, 60), rBC = recent(EV.BC, 60);
    const rST = recent(EV.ST, 60), rSHK = recent(EV.SHK, 45);
    const rJAC = recent(EV.JAC, 45), rBUEC = recent(EV.BUEC, 45);
    const rND = recent(EV.ND, 20), rNS = recent(EV.NS, 20);

    /* 判定顺序按「证据的具体程度」排，不按时间排：
     *   具体的形态（弹簧被测试、SOS 回踩）比宽泛的趋势标签更可信，优先级更高；
     *   宽泛标签（年内低位 + 高点下移 = 下跌段）只在没有具体形态时兜底。
     * 另一条硬规则：**弹簧之后价格必须真的回到区间中部**才算 C 段。
     * 只破低不回升，那是「又跌回去了」，不是吸筹 —— 600986 就栽在这一点上。 */
    let phase;
    if (!isRange) {
      // 区间不成立时事件体系部分定义失效，只能按趋势结构定性。
      // markdown 额外要求 60 根净跌 —— 否则「从底部反弹上来的票」只要
      // 近期有个更低的摆动高点就会被判成下跌段（603278 就是：60 日 +25%）。
      if (hiSeq.rise >= 1 && pos250 >= 55) phase = 'markup';
      else if (hiSeq.fall > hiSeq.rise && pos250 <= 45 && ret60 <= 0) phase = 'markdown';
      else phase = 'transition';
    } else if ((rTEST >= 0) && posInRange >= 0.3 && posInRange <= 0.8) {
      phase = 'accumC';                                  // 弹簧 + 缩量测试 + 已回到中部
    } else if (rSP >= 0 && posInRange >= 0.25 && posInRange <= 0.75) {
      phase = 'accumC0';                                 // 弹簧出现但还没测试
    } else if (rLPS >= 0 && rSOS >= 0 && posInRange > 0.6 && posInRange <= 1.1 && i - rSOS <= 30) {
      phase = 'accumD';                                  // SOS 后缩量回踩，仍守在区间上部
    } else if (rSOS >= 0 && posInRange > 0.65 && posInRange <= 1.1 && i - rSOS <= 20) {
      phase = 'accumD0';                                 // 只有 SOS，还没回踩
    } else if (px > res * 1.005) {
      phase = 'markup';                                  // 站上区间上沿
    } else if ((rUT >= 0 || rBC >= 0) && posInRange > 0.55
      && hiSeq.rise <= hiSeq.fall && Math.min(i - (rUT < 0 ? m : rUT), i - (rBC < 0 ? m : rBC)) <= 25) {
      // 三个条件缺一不可：位置上沿、高点不再抬高、诱多事件发生在近 25 根内。
      // 少了「高点不抬高」就会出现「最近一个 LPS（看多事件）却判派发」的自相矛盾。
      phase = 'distrib';
    } else if (pos250 < 25 && posInRange < 0 && ret60 <= -6
      && (hiSeq.fall > hiSeq.rise || lowSeq.fall > lowSeq.rise)) {
      phase = 'markdown';                                // 年内低位 + 中期净跌 + 摆点下移 = 下跌段
    } else if (posInRange < 0.35) {
      phase = 'weak';                                    // 区间内走弱，但还没破位
    } else if (lowSeq.rise >= 2 && (rSOW < 0 || i - rSOW > 20)) {
      // B 段要求低点净抬高，且近期没有放量跌破中轴 —— 民生银行 600016 就是
      // SOW 才 11 根前、却因为低点计数够而判成 B 段，属于自相矛盾。
      phase = 'accumB';
    } else {
      phase = 'range';
    }
    /** 证据投票：阶段方向与四项独立证据是否一致，一致比例即置信度 */
    const side = WY_PHASE[phase].side;
    const evid = [];
    let votes = 0, total = 0;
    const vote = (ok, txt) => { total++; if (ok) { votes++; evid.push(txt); } return ok; };
    if (side !== 0) {
      const bull = side > 0;
      vote(bull ? lowSeq.rise >= 1 : lowSeq.fall >= 1,
        bull ? `低点抬高 ${lowSeq.rise} 次` : `低点下移 ${lowSeq.fall} 次`);
      vote(bull ? hiSeq.fall === 0 : hiSeq.fall >= 1,
        bull ? `高点未再下移` : `高点下移 ${hiSeq.fall} 次`);
      vote(bull ? sr >= 1.05 : sr <= 0.95,
        bull ? `上涨日量能是下跌日 ${sr.toFixed(2)} 倍` : `上涨日量能只有下跌日 ${sr.toFixed(2)} 倍`);
      vote(bull ? eff >= 0.1 : eff <= -0.1,
        `20 根路径效率 ${(eff * 100).toFixed(0)}%`);
    }
    const confPct = total ? votes / total : 0;
    const conf = confPct >= 0.75 ? 'high' : confPct >= 0.5 ? 'mid' : 'low';

    /* ---- ⑥ 因果充分度：区间磨得够不够厚 ---- */
    let cause = 0;
    if (isRange) {
      let mu = 0;
      for (let t = R.st; t < m; t++) mu += C[t];
      mu /= R.w;
      let sd = 0;
      for (let t = R.st; t < m; t++) sd += (C[t] - mu) * (C[t] - mu);
      sd = Math.sqrt(sd / R.w);
      const conv = Math.max(0, 1 - sd / rh);              // 越收敛，换手越充分
      const bt = Math.min(R.supT + R.resT, 20);   // 边界测试封顶 20 次，超出不再加分
      // 权重下调过一次：原系数（0.4 / 1.5 / 25）算出来全池中位数 78，
      // 「充分度 ≥ 70」这个筛选条件一半以上的票都满足，等于没筛。
      cause = Math.round(Math.min(100, R.w * 0.3 + bt * 1.0 + conv * 20));
    }

    /* ---- ⑦ 综合因子 ---- */
    const stagePts = {
      accumC: 34, accumD: 30, accumD0: 16, accumC0: 14, accumB: 8, markup: 18,
      range: 0, transition: 0, weak: -12, distrib: -26, markdown: -22,
    }[phase] || 0;
    const evPts = {
      SP: 8, TEST: 6, SOS: 7, LPS: 6, JAC: 6, BUEC: 5, NS: 4, SC: 5, ST: 4, SHK: 5,
      UT: -9, SOW: -8, BC: -7, ND: -6,
    };
    const lastMap = {
      SP: rSP, TEST: rTEST, SOS: rSOS, LPS: rLPS, UT: rUT, SOW: rSOW,
      SC: rSC, BC: rBC, ST: rST, SHK: rSHK, JAC: rJAC, BUEC: rBUEC, ND: rND, NS: rNS,
    };
    let evScore = 0;
    for (const k of Object.keys(lastMap)) {
      const t = lastMap[k];
      if (t < 0) continue;
      evScore += (evPts[k] || 0) * Math.max(0, 1 - (i - t) / 45);   // 越旧越不值钱
    }
    /* 事件分与阶段方向冲突时打五折：下跌段里的 SOS 多半是失败反弹，
     * 不能因为「最近有个强信号」就把一只破位股的分数拉回中性。
     * 600986 就是这种情形 —— 11-05/11-06 两根放量长阳把它拉到 -5 分，
     * 而结构上高点已经下移、价格贴在年内 5% 分位。 */
    if (side !== 0 && evScore * side < 0) evScore *= 0.5;
    let s = stagePts
      + (lowSeq.rise - lowSeq.fall) * 3
      + (hiSeq.rise - hiSeq.fall) * 2
      + (sr - 1) * 14
      + eff * 10
      + (pos250 < 20 ? -4 : pos250 > 88 ? -6 : 0)
      + (conf === 'high' ? 6 : conf === 'low' ? -6 : 0)
      + Math.max(-18, Math.min(18, evScore));
    /* 放量滞涨：位置决定性质。低位（区间 35% 分位以下）且阶段方向不偏空，
     * 才算「吸收筹码」；其余一律按供给涌出扣分 —— 下跌途中也会有放量小反弹，
     * 那不是承接，是有人趁反弹往外倒。 */
    if (stall > 0) {
      const absorb = posInRange < 0.35 && side >= 0;
      s += absorb ? Math.min(stall, 3) * 2 : -Math.min(stall, 3) * 3;
    }
    s = Math.max(-100, Math.min(100, Math.round(s)));

    /* ---- ⑧ 事件标记（转全局索引，供图表直接画）---- */
    // 同一个 SOS 可能被多根 K 线重复推导出同一个回踩点，按「类型 + 索引」去重
    const seen = new Set();
    const marks = [];
    for (const k of Object.keys(EV)) {
      for (const t of EV[k]) {
        const key = k + '@' + t;
        if (seen.has(key)) continue;
        seen.add(key);
        marks.push({
          i: t + off, type: k,
          p: WY_EVENT[k].below ? L[t] : H[t],
          above: !WY_EVENT[k].below,
          age: i - t,
        });
      }
    }
    marks.sort((a, b) => a.i - b.i);
    /** 局部索引 → 全局索引；-1 表示「窗口内没有该事件」 */
    const G = (t) => (t >= 0 ? t + off : -1);

    /* ---- ⑨ 反证条件：这个阶段判断会被什么推翻 ---- */
    const against = [];
    if (phase === 'accumC' || phase === 'accumC0') {
      if (rSP >= 0) against.push(`收盘跌回弹簧低点 ${L[rSP].toFixed(2)} 下方且量比 >1.5，C 段作废`);
      against.push(`跌回 ${sup.toFixed(2)} 下方连续 3 根收不回来，弹簧变成真破位`);
    } else if (phase === 'accumD' || phase === 'accumD0') {
      against.push(`回踩跌回中轴 ${mid.toFixed(2)} 下方，D 段的「前阻力转支撑」不成立`);
      against.push(`突破后无法站稳 ${res.toFixed(2)} 且量能萎缩，突破失败`);
    } else if (phase === 'accumB') {
      against.push(`低点序列重新转为下移，B 段退化为下跌中继`);
      against.push(`放量跌破 ${sup.toFixed(2)}，区间下沿失守`);
    } else if (phase === 'markup') {
      against.push(`跌回 ${res.toFixed(2)} 下方，突破变成上冲回落`);
    } else if (phase === 'markdown') {
      against.push(`缩量收回 ${sup.toFixed(2)} 上方并连续 2 根站稳，抛压开始衰竭，单边下跌的判断要降级`);
      against.push(`出现放量止跌（量比 >1.6 且收盘明显脱离当日低点），对标抛售高潮，仍需后面的缩量二次测试才算数`);
      if (rSP >= 0) against.push(`已出现的弹簧 ${L[rSP].toFixed(2)} 若被重新收复且站回中轴 ${mid.toFixed(2)}，c 段假设重新成立`);
    } else if (phase === 'distrib') {
      against.push(`放量收复 ${res.toFixed(2)} 并站住，派发判断被推翻`);
    } else {
      against.push(`向上放量突破 ${res.toFixed(2)} 或向下跌破 ${sup.toFixed(2)}，方向即定`);
    }

    return {
      phase,
      phaseName: WY_PHASE[phase].name,
      side,
      conf, confPct: Math.round(confPct * 100),
      score: s,
      pos250: r1(pos250),
      posInRange: r1(posInRange * 100),
      inRange: posInRange >= 0 && posInRange <= 1,   // 现价是否仍落在区间内（>1 = 已突破，<0 = 已跌破）
      isRange,
      w: isRange ? R.w : 0,
      sup: r2(sup), res: r2(res), mid: r2(mid), rh: r2(rh), tests: R ? R.supT + R.resT : 0,
      rangeStart: R ? R.st + off : null,
      lowRise: lowSeq.rise, lowFall: lowSeq.fall, lowLast: lowSeq.last != null ? r2(lowSeq.last) : null,
      hiRise: hiSeq.rise, hiFall: hiSeq.fall, hiLast: hiSeq.last != null ? r2(hiSeq.last) : null,
      sr: r2(sr), eff: r2(eff), cause, ret60: r1(ret60),
      stall, stallUp, thinUp, thinDn,
      lastEv: (() => {
        let best = null;
        for (const k of Object.keys(lastMap)) {
          const t = lastMap[k];
          if (t < 0) continue;
          if (!best || t > best.t) best = { t, k };
        }
        return best ? { type: best.k, i: best.t + off, age: i - best.t } : null;
      })(),
      marks,
      ev: {
        SP: G(rSP), TEST: G(rTEST), SOS: G(rSOS), LPS: G(rLPS),
        UT: G(rUT), SOW: G(rSOW), SC: G(rSC), BC: G(rBC), ST: G(rST),
        SHK: G(rSHK), JAC: G(rJAC), BUEC: G(rBUEC), ND: G(rND), NS: G(rNS),
      },
      evid,
      against,
      // 摆动点（全局索引），overlay 用来画低点连线
      swings: {
        hi: hiIdx.slice(-6).map((t) => ({ i: t + off, p: r2(H[t]) })),
        lo: loIdx.slice(-6).map((t) => ({ i: t + off, p: r2(L[t]) })),
      },
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

  return { shapeOf, sma, inPool, POOLS, MIN_BARS, wyckoff2Of, WY_PHASE, WY_EVENT };
});
