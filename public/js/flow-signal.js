'use strict';
/**
 * 资金量价信号核心库（无 L2 依赖）
 *
 * 背景：A 股日线拿不到逐笔主动买卖，只能用「收盘在当日区间的位置」推断资金方向。
 * 本库把这套推断拆成三层，每层都可被独立检验与替换：
 *
 *   ① 方向层 mf ∈ [-1,1]：单日多空方向
 *        body  (C-O)/(H-L)           —— 通达信常见写法，只看实体
 *        clv   (2C-H-L)/(H-L)        —— Chaikin，含上下影
 *        vwap  (C-VWAP)/VWAP 标准化   —— 用成交额反推当日均价，最接近「资金成本」
 *   ② 强度层 s = mf × V / MA(V,20)：把「方向」乘上「相对量能」，得到无量纲的净流入强度
 *        除以流通股本的通达信写法会随股本漂移，跨标的不可比；除以自身均量则可比
 *   ③ 累积层 cum = λ·cum₋₁ + s：带衰减的累积，λ=0.98 约 34 根半衰期
 *        全历史 SUM 的绝对水平取决于上市起点，且越走越偏，无法跨标的比较
 *
 * 所有函数都是纯函数，输入 rows = [[date, o, h, l, c, v, a], ...]（a 为成交额，元）。
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (x) => (Number.isFinite(x) ? x : null);

/* ---------------- 基础工具 ---------------- */

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) { sum += v; cnt++; }
    if (i >= n) {
      const old = arr[i - n];
      if (old != null && Number.isFinite(old)) { sum -= old; cnt--; }
    }
    if (i >= n - 1 && cnt > 0) out[i] = sum / cnt;
  }
  return out;
}

function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || !Number.isFinite(v)) { out[i] = prev; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function maxOf(arr, from, to) {
  let m = -Infinity;
  for (let i = from; i <= to; i++) {
    const v = arr[i];
    if (v != null && Number.isFinite(v) && v > m) m = v;
  }
  return m === -Infinity ? null : m;
}

/* ---------------- ① 方向层 ---------------- */

/** 实体占比：通达信原式 (C-O)/(H-L) */
function dirBody(rows) {
  return rows.map((r) => {
    const [, o, h, l, c] = r;
    const rng = h - l;
    return rng > 0 ? clamp((c - o) / rng, -1, 1) : 0;
  });
}

/** CLV：(2C-H-L)/(H-L)，等价于把收盘价在区间中的位置线性映射到 [-1,1] */
function dirClv(rows) {
  return rows.map((r) => {
    const [, , h, l, c] = r;
    const rng = h - l;
    return rng > 0 ? clamp(((c - l) - (h - c)) / rng, -1, 1) : 0;
  });
}

/**
 * VWAP 偏离：成交额/成交量 = 当日均价，收盘高于均价说明尾盘承接强。
 * 偏离幅度用自身 60 日滚动中位数做单位，再 tanh 压缩到 [-1,1]，
 * 这样高波动股与低波动股的方向强度可比。
 */
function dirVwap(rows) {
  const dev = rows.map((r) => {
    const [, , , , c, v, a] = r;
    if (!(v > 0) || !(a > 0) || !(c > 0)) return 0;
    const vwap = a / (v * 100);          // v 单位为手
    return vwap > 0 ? c / vwap - 1 : 0;
  });
  const scale = new Array(dev.length).fill(null);
  for (let i = 0; i < dev.length; i++) {
    const from = Math.max(0, i - 59);
    const win = [];
    for (let j = from; j <= i; j++) win.push(Math.abs(dev[j]));
    win.sort((x, y) => x - y);
    const med = win.length ? win[Math.floor(win.length / 2)] : 0;
    scale[i] = med > 1e-6 ? med : 0.01;
  }
  return dev.map((d, i) => Math.tanh(d / scale[i]));
}

/** 合成方向：CLV 为主体，VWAP 偏离做同向加权（两者都为正才取强值） */
function dirBlend(rows) {
  const a = dirClv(rows);
  const b = dirVwap(rows);
  return a.map((x, i) => clamp(0.6 * x + 0.4 * b[i], -1, 1));
}

/* ---------------- ② 强度层 ---------------- */

/**
 * 净流入强度：mf × V / MA(V,20)
 * 量纲 = 「相当于几倍常规成交量的净流入」，跨标的可直接比较。
 *
 * 注意：分母必须是固定的 20 日均量，不能再取 max(均量, 0.5V)。
 * 早期版本为了避免缩量日噪声加了 max 下限，副作用是 v=1.5×均量 与 v=10×均量
 * 被压成同一个值（都等于 2×mf），「异常放量」这个最关键的信号被抹平了。
 * 实测参数网格里 s>2 永远 0 笔，就是被这个下限卡死的。
 */
function intensity(mf, rows, n = 20) {
  const vol = rows.map((r) => r[5]);
  const ma = sma(vol, n);
  return mf.map((m, i) => {
    const v = vol[i];
    // 分母用「前 n 日均量」（不含当日）：当日算进均量会把自己的强度稀释掉，
    // 5 倍量只能算出 4.17 倍，阈值也就失去直观含义。
    const base = i > 0 ? ma[i - 1] : null;
    if (!(v > 0) || !(base > 0)) return 0;
    return clamp((m * v) / base, -8, 8);
  });
}

/* ---------------- ③ 累积层 ---------------- */

/** 指数衰减累积，λ=0.98 ≈ 34 根半衰期；避免全历史累计的无界漂移 */
function cumulative(s, lambda = 0.98) {
  const out = new Array(s.length).fill(0);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc = acc * lambda + s[i];
    out[i] = acc;
  }
  return out;
}

/* ---------------- 组合：完整指标 ---------------- */

/**
 * 计算一套完整资金量价指标。
 * @param {Array} rows [[date,o,h,l,c,v,a], ...]
 * @param {Object} opt { dir: 'body'|'clv'|'vwap'|'blend', fast, slow, lambda }
 * @returns {Object} { dir, mf, s, cum, fast, slow, hist, signal }
 */
function compute(rows, opt) {
  const o = opt || {};
  const dirName = o.dir || 'clv';
  const mf = dirName === 'body' ? dirBody(rows)
    : dirName === 'vwap' ? dirVwap(rows)
      : dirName === 'blend' ? dirBlend(rows)
        : dirClv(rows);

  const s = o.intensityMode === 'raw'
    // 复现通达信原式：直接用「方向 × 成交量」，不除均量；除以流通股本只是个常数因子，不改交叉时点
    ? mf.map((m, i) => m * (rows[i][5] || 0))
    : intensity(mf, rows, o.volWindow || 20);
  const cum = cumulative(s, o.lambda == null ? 0.98 : o.lambda);
  const fast = (o.fast || 5) === 1 ? cum.slice() : ema(cum, o.fast || 5);
  // 通达信原式用的是 MA(累计,10) 而非 EMA，回测复现时必须区分
  const slow = o.slowType === 'sma' ? sma(cum, o.slow || 20) : ema(cum, o.slow || 20);

  // 柱高用「强度」的绝对值，方向由 sign 表达；与通达信把换手率当柱高不同，
  // 这里柱高就是净流入强度本身，视觉与数值一致。
  return { dir: dirName, mf, s, cum, fast, slow };
}

/**
 * 从指标序列派生 BS 信号。
 * 全部在 t 日收盘后确定，t 日之前的信息只到 t，无未来函数。
 * @returns {Array} [{ i, side: 'B'|'S', kind, strength }]
 */
function signals(ind, rows, opt) {
  const o = opt || {};
  const { fast, slow, cum, s } = ind;
  const out = [];
  const minGap = o.minGap == null ? 3 : o.minGap;
  let lastIdx = -999;

  for (let i = 1; i < rows.length; i++) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue;
    const upCross = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const dnCross = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

    if (upCross && s[i] > 0 && i - lastIdx >= minGap) {
      out.push({ i, side: 'B', kind: 'cross', strength: +(fast[i] - slow[i]).toFixed(3) });
      lastIdx = i;
    } else if (dnCross && s[i] < 0 && i - lastIdx >= minGap) {
      out.push({ i, side: 'S', kind: 'cross', strength: +(slow[i] - fast[i]).toFixed(3) });
      lastIdx = i;
    }
  }
  return out;
}

/* ---------------- 位置与信号分级 ---------------- */

/** 收盘价在最近 n 日 [最低, 最高] 中的位置，0=最低 1=最高 */
function positionSeries(rows, n = 60) {
  const out = new Array(rows.length).fill(null);
  for (let i = n - 1; i < rows.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (rows[j][2] > hi) hi = rows[j][2];
      if (rows[j][3] < lo) lo = rows[j][3];
    }
    out[i] = hi > lo ? (rows[i][4] - lo) / (hi - lo) : 0.5;
  }
  return out;
}

/**
 * BS 信号分级（实证得出的阈值，见 docs/资金量价-实证.md）
 *
 *   买入：低位 + 强流入，位置越低、流入越猛，级别越高
 *   卖出：高位 + 强流出
 *
 * 阈值不是拍脑袋：476 只 / 2022-2026 / 55 万根日线上做参数网格，
 * 邻域平滑且分段检验为正的那一档才写进来。
 */
const GRADES = [
  // 买入：5 日胜率/均值分别为 71.6%/7.6%、59.1%/3.5%、54.7%/1.9%（476 只，2022-2026）
  { side: 'B', grade: 3, posMax: 0.20, sMin: 2.0 },
  { side: 'B', grade: 2, posMax: 0.30, sMin: 1.5 },
  { side: 'B', grade: 1, posMax: 0.40, sMin: 1.0 },
  // 卖出：高位 + 强流出后 5 日均值 -0.69%，下跌率 60.1%，t=-4.2
  { side: 'S', grade: 3, posMin: 0.85, sMax: -1.5 },
  { side: 'S', grade: 2, posMin: 0.75, sMax: -1.5 },
  { side: 'S', grade: 1, posMin: 0.60, sMax: -1.0 },
];

function gradeAt(pos, s) {
  if (pos == null) return null;
  let best = null;
  for (const g of GRADES) {
    if (g.side === 'B' && pos <= g.posMax && s >= g.sMin) {
      if (!best || g.grade > best.grade) best = g;
    } else if (g.side === 'S' && pos >= g.posMin && s <= g.sMax) {
      if (!best || g.grade > best.grade) best = g;
    }
  }
  return best ? { side: best.side, grade: best.grade } : null;
}

/** 逐日出信号，附带强度，供前端打点 */
function bsSignals(rows, ind, pos, minGap = 3) {
  const out = [];
  let lastIdx = -999;
  for (let i = 0; i < rows.length; i++) {
    if (i - lastIdx < minGap) continue;
    const g = gradeAt(pos[i], ind.s[i]);
    if (!g) continue;
    out.push({ i, side: g.side, grade: g.grade, s: +ind.s[i].toFixed(2), pos: +pos[i].toFixed(2) });
    lastIdx = i;
  }
  return out;
}

const API = {
  sma, ema, dirBody, dirClv, dirVwap, dirBlend,
  intensity, cumulative, compute, signals, maxOf, clamp,
  positionSeries, gradeAt, bsSignals, GRADES,
};

/* 浏览器与 Node 共用同一份实现：前端通过 /js/flow-signal.js 直接加载，
 * 服务端 require 本文件。绝不能各写一份，否则回测结论与页面读数会对不上。 */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.QLFlow = API;
