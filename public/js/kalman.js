/* ============================================================
 * QuantLab · Kalman Trend
 * 局部线性趋势模型（Local Linear Trend, LLT）的滤波 / 平滑 / 信号
 *
 * 状态  x = [level, slope]ᵀ        观测  z = ln(Close) × 100
 *   xₜ = F xₜ₋₁ + w,  F = [[1,1],[0,1]],  w ~ N(0, Q)
 *   zₜ = H xₜ + v,    H = [1,0],          v ~ N(0, R)
 *
 * 为什么用 LLT 而不是 EMA / 线性回归：
 *   1) EMA 只有一个「平滑度」旋钮，无法区分「趋势停了」和「价格偶然偏离」；
 *      LLT 用斜率状态显式建模趋势，趋势是否还在由 slope 与它的方差直接给出。
 *   2) 线性回归（滚动 OLS）每根 K 线的斜率估计互不相关，端点抖动极大；
 *      LLT 的 slope 带递推先验，端点是「收缩估计」，稳定性高一个量级。
 *   3) 卡尔曼天然输出 slope 的方差 P₁₁，于是有 t = slope/√P₁₁ ——
 *      这是「趋势显著不为 0」的统计量，跨标的、跨周期可比，无需另设阈值经验值。
 *
 * 三个必须分清的东西（混淆会产生前视偏差）：
 *   filter  —— 只用 t 及之前的数据，实盘信号只能用它
 *   smooth  —— RTS 平滑，用到 t 之后的全部数据，只能画历史图，不可用于信号
 *   band    —— 预测区间 √(P₀₀+R)，画给用户看的「趋势通道」
 *
 * Q 的结构取连续时间白噪声加速度（WHITE NOISE ACCELERATION）模型：
 *   Q = q · [[1/4, 1/2],[1/2, 1]]
 * 不取 diag(q₁,q₂)：那样 slope 的随机游走与 level 的积分关系不自洽，
 * 趋势线会在拐点处出现阶梯状折角。q 单一尺度，物理含义是「加速度方差」。
 * ============================================================ */
(function (global) {
  'use strict';

  const DEF = {
    // R = (obsScale × 日波动)²  —— 观测噪声按标的自身波动标定，避免大盘股过平滑
    obsScale: 1.0,
    // 信噪比 λ = q/R 的 MLE 搜索网格。λ 大 → 信观测（跟随快、噪声大）
    //                              λ 小 → 信模型（平滑强、转折慢）
    // 网格必须覆盖到 1：λ 太小时模型过度自信（标准化创新方差远大于 1），
    // 算出的 t 值虚高，阈值失去意义。λ≈0.3 处 logLik 与「创新方差≈1」同时最优。
    snrGrid: [3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1],
    snr: 0.3,           // 默认全市场统一值，保证横截面可比；传 null 则逐股 MLE
    robustC: 3.5,       // 标准化创新超过 c 倍时按 Huber 降权（抗涨跌停/跳空）
    band: 1.96,         // 置信带倍数
    warmup: 30,         // 前 N 根不产信号（滤波未收敛）
    // 状态机：slopeZ 上穿 enterZ 建仓，下穿 exitZ 平仓
    enterZ: 1.0,
    exitZ: -0.5,
  };

  /* ---------------- 数值工具 ---------------- */

  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  // 稳健标准差：1.4826 × MAD。用 MAD 而非标准差，
  // 是因为涨跌停、资产重组这类单日巨幅跳空会把普通标准差抬高数倍，
  // 进而把 R 标定得过大，趋势线被压平到看不出转折。
  function robustSd(a) {
    if (a.length < 3) return 0;
    const m = median(a);
    const dev = a.map((x) => Math.abs(x - m));
    return 1.4826 * median(dev);
  }

  function finite(x) { return typeof x === 'number' && isFinite(x); }

  /* ---------------- 参数标定 ---------------- */

  /**
   * 由对数价格序列估计观测噪声 R。
   * 用一阶差分的稳健标准差当「日波动」，再乘 obsScale。
   * 注意 R 在这里不是「测量误差」——收盘价本身几乎无误差。
   * R 代表「价格围绕趋势的短期偏离幅度」，这才是我们想让它吸收的部分。
   */
  function calibrate(z, obsScale) {
    const d = [];
    for (let i = 1; i < z.length; i++) {
      const v = z[i] - z[i - 1];
      if (finite(v)) d.push(v);
    }
    let sd = robustSd(d);
    // 下限不是为了「看起来合理」，是防数学退化：
    // 一字板、长期停牌、或完全平滑的序列，一阶差分全相同 → MAD=0（仅剩浮点残差 1e-14），
    // R 变成 1e-27 后 K→1、P→0，slope 被永久冻结在 0，趋势线变成水平线。
    // 0.02（即 0.02% 日波动）远低于 A 股任何真实标的，正常数据不受影响。
    const FLOOR = 0.02;
    if (!finite(sd) || sd < FLOOR) sd = FLOOR;
    const R = (obsScale * sd) * (obsScale * sd);
    return { sigma: sd, R };
  }

  /* ---------------- 滤波核心 ---------------- */

  /**
   * 单次卡尔曼滤波（前向）。
   * z: 已缩放的观测序列（ln(price)×100），p: {R, q, robustC}
   * 返回逐根 state 与协方差，以及对数似然（供 MLE 用）。
   */
  function filterCore(z, p) {
    const n = z.length;
    const R = p.R, q = p.q, c = p.robustC == null ? DEF.robustC : p.robustC;
    const q00 = 0.25 * q, q01 = 0.5 * q, q11 = q;

    const level = new Float64Array(n);
    const slope = new Float64Array(n);
    const p00 = new Float64Array(n), p01 = new Float64Array(n), p11 = new Float64Array(n);
    const innov = new Float64Array(n);      // 原始创新 z - Hx⁻
    const sdev = new Float64Array(n);       // 创新标准差 √S
    const predL = new Float64Array(n), predS = new Float64Array(n);
    const pp00 = new Float64Array(n), pp01 = new Float64Array(n), pp11 = new Float64Array(n);
    let logLik = 0;

    let l = z[0], s = 0;
    let P00 = R, P01 = 0, P11 = R;
    level[0] = l; slope[0] = s; p00[0] = P00; p01[0] = P01; p11[0] = P11;
    predL[0] = l; predS[0] = s; pp00[0] = P00; pp01[0] = P01; pp11[0] = P11;

    for (let i = 1; i < n; i++) {
      // ---- 预测 ----
      const l_ = l + s;
      const s_ = s;
      const A00 = P00 + 2 * P01 + P11 + q00;
      const A01 = P01 + P11 + q01;
      const A11 = P11 + q11;
      predL[i] = l_; predS[i] = s_;
      pp00[i] = A00; pp01[i] = A01; pp11[i] = A11;

      // ---- 更新 ----
      const v = z[i] - l_;
      let S = A00 + R;
      if (!(S > 0)) S = 1e-12;

      // 鲁棒化：标准化创新过大时放大 R（等价降低该观测的权重）。
      // 涨跌停当日的收盘价是被交易所截断的，不服从高斯；直接吃进去会让
      // 斜率瞬间翻转，形成「假转折」。Huber 降权比直接丢弃更好：
      // 丢掉会留下数据空洞，降权仍保留方向信息。
      let Ruse = R;
      const nv = Math.abs(v) / Math.sqrt(S);
      if (nv > c) Ruse = R * (nv / c) * (nv / c);
      S = A00 + Ruse;
      if (!(S > 0)) S = 1e-12;

      const K0 = A00 / S, K1 = A01 / S;
      l = l_ + K0 * v;
      s = s_ + K1 * v;
      P00 = A00 * (1 - K0);
      P01 = A01 * (1 - K0);
      P11 = A11 - K1 * A01;
      if (P11 < 0) P11 = 0;   // 数值兜底，理论上不会发生

      level[i] = l; slope[i] = s;
      p00[i] = P00; p01[i] = P01; p11[i] = P11;
      innov[i] = v; sdev[i] = Math.sqrt(S);
      logLik += -0.5 * (Math.log(2 * Math.PI * S) + (v * v) / S);
    }

    return { level, slope, p00, p01, p11, innov, sdev, predL, predS, pp00, pp01, pp11, logLik, R, q };
  }

  /**
   * RTS 平滑（后向递推）。只用于历史展示，带前视，绝不可用于信号。
   * J_k = P_k Fᵀ (P⁻_{k+1})⁻¹
   */
  function rtsSmooth(z, f) {
    const n = z.length;
    const smL = new Float64Array(n), smS = new Float64Array(n);
    smL[n - 1] = f.level[n - 1];
    smS[n - 1] = f.slope[n - 1];
    for (let k = n - 2; k >= 0; k--) {
      // P_k Fᵀ
      const a00 = f.p00[k] + f.p01[k], a01 = f.p01[k];
      const a10 = f.p01[k] + f.p11[k], a11 = f.p11[k];
      // (P⁻_{k+1})⁻¹
      const b00 = f.pp00[k + 1], b01 = f.pp01[k + 1], b11 = f.pp11[k + 1];
      let det = b00 * b11 - b01 * b01;
      if (!(Math.abs(det) > 1e-18)) det = 1e-18;
      const i00 = b11 / det, i01 = -b01 / det, i11 = b00 / det;
      // J = (P Fᵀ)(P⁻)⁻¹
      const j00 = a00 * i00 + a01 * i01, j01 = a00 * i01 + a01 * i11;
      const j10 = a10 * i00 + a11 * i01, j11 = a10 * i01 + a11 * i11;
      const dL = smL[k + 1] - f.predL[k + 1];
      const dS = smS[k + 1] - f.predS[k + 1];
      smL[k] = f.level[k] + j00 * dL + j01 * dS;
      smS[k] = f.slope[k] + j10 * dL + j11 * dS;
    }
    return { level: smL, slope: smS };
  }

  /* ---------------- MLE 选参 ---------------- */

  /**
   * 在 SNR 网格上取对数似然最大者。
   * 注意：似然比较的前提是 R 固定（同一只票、同一段数据），
   * 跨标的的 logLik 绝对值不可比，只用于「这只票自己内部的 λ 选择」。
   */
  function fit(z, opt) {
    const R = opt.R;
    const grid = opt.grid || DEF.snrGrid;
    let best = null, bestLL = -Infinity;
    for (const lam of grid) {
      const r = filterCore(z, { R, q: lam * R, robustC: opt.robustC });
      if (r.logLik > bestLL) { bestLL = r.logLik; best = lam; }
    }
    return { snr: best, logLik: bestLL };
  }

  /* ---------------- 高层：一次算完 ---------------- */

  /**
   * analyze(rows, opts)
   * rows: [[d, o, h, l, c, v, a], ...]（与项目内 K 线数组同构）
   * 返回逐根派生序列 + 状态机 + 信号。
   */
  function analyze(rows, opts) {
    const o = Object.assign({}, DEF, opts || {});
    const n = rows.length;
    const empty = {
      n: 0, price: [], level: [], slope: [], slopeZ: [], band: [],
      upper: [], lower: [], innovZ: [], dev: [], smoothLevel: [], smoothSlope: [],
      state: [], pos: [], signals: [], snr: null, sigma: null, turned: null,
    };
    if (n < 5) return empty;

    const price = rows.map((r) => r[4]);
    const z = new Float64Array(n);
    let bad = false;
    for (let i = 0; i < n; i++) {
      const p = price[i];
      if (!finite(p) || p <= 0) { bad = true; break; }
      z[i] = Math.log(p) * 100;
    }
    if (bad) return empty;

    const cal = calibrate(z, o.obsScale);
    let snr = o.snr;
    if (snr == null) {
      snr = fit(z, { R: cal.R, grid: o.snrGrid, robustC: o.robustC }).snr;
    }
    const f = filterCore(z, { R: cal.R, q: snr * cal.R, robustC: o.robustC });
    const sm = rtsSmooth(z, f);

    // level 一律用「价格」单位对外暴露。内部状态是对数价×100，忘记换算会让
    // 「close >= level」这类比较恒为假（9.58 vs 226.57），信号静默消失。
    const level = [], slope = [], slopeZ = [], band = [], dev = [];
    const upper = [], lower = [], innovZ = [];
    const smoothLevel = [], smoothSlope = [], state = [], pos = [];
    let cur = 0;

    for (let i = 0; i < n; i++) {
      const lv = f.level[i], sl = f.slope[i];
      // slope 的标准误：P₁₁ 是斜率的后验方差
      const se = Math.sqrt(Math.max(f.p11[i], 1e-12));
      const zt = sl / se;
      // 预测区间：level 的不确定 + 观测噪声。只取后验方差会让带子窄到贴线，
      // 看不出「价格偏离趋势多少算多」。
      const sd = Math.sqrt(Math.max(f.p00[i] + f.R, 1e-12));
      const bw = o.band * sd;

      const lpx = Math.exp(lv / 100);
      level[i] = lpx; slope[i] = sl; slopeZ[i] = zt;
      upper[i] = Math.exp((lv + bw) / 100);
      lower[i] = Math.exp((lv - bw) / 100);
      // band 取上侧宽度（价格单位）；dev 是标准化偏离，±1 即触及通道边沿
      band[i] = upper[i] - lpx;
      dev[i] = band[i] > 0 ? (price[i] - lpx) / band[i] : 0;
      innovZ[i] = f.sdev[i] > 0 ? f.innov[i] / f.sdev[i] : 0;
      smoothLevel[i] = Math.exp(sm.level[i] / 100);   // 价格单位，仅用于画历史
      smoothSlope[i] = sm.slope[i];

      // 状态机：进入/退出用各自的阈值（滞回），避免 slope 在 0 附近来回穿越
      // 导致每日进出、被手续费磨死。
      if (i >= o.warmup) {
        if (cur === 0 && zt > o.enterZ) cur = 1;
        else if (cur === 1 && zt < o.exitZ) cur = 0;
      } else {
        cur = 0;
      }
      state[i] = zt > o.enterZ ? 1 : zt < o.exitZ ? -1 : 0;
      pos[i] = cur;
    }

    // 最新一次状态翻转（供图表标注）
    let turned = null;
    for (let i = n - 1; i > 0; i--) {
      if (pos[i] !== pos[i - 1]) { turned = { i, on: pos[i] === 1, d: rows[i][0] }; break; }
    }

    const signals = buildSignals(rows, { level, slope, slopeZ, upper, lower, band, dev, innovZ, price, pos }, o);

    return {
      n, price, level, slope, slopeZ, band, dev, upper, lower, innovZ,
      smoothLevel, smoothSlope, state, pos, signals, turned,
      snr, sigma: cal.sigma, R: cal.R,
    };
  }

  /* ---------------- 信号分级 ---------------- */

  /**
   * 四类信号（每类阈值都集中在 GRADES，便于回测调参与验收检查）：
   *   B3 趋势启动：slopeZ 上穿 enterZ，且收盘在趋势线上方
   *   B2 趋势回调：已处于上升趋势，价格回落到带下沿附近（创新显著为负）
   *   B1 趋势确认：slopeZ 高位持续，价格站稳上轨
   *   S3 趋势破位：sloopeZ 下穿 0，或收盘跌破带下沿
   *   S2 趋势衰竭：slopeZ 由高位快速回落
   *   S1 过热：价格突破上轨且创新 > +2σ（追高警告，非做空）
   */
  const GRADES = {
    b3Cross: 1.0,      // slopeZ 上穿
    b2Inno: -1.2,      // 回调时创新 Z 阈值
    b2SlopeZ: 0.8,     // 回调前提：趋势仍确认
    b1SlopeZ: 2.0,     // 强趋势
    s3SlopeZ: 0.0,     // slopeZ 下穿
    s2Drop: 2.0,       // slopeZ 5 根内回落幅度
    s1Inno: 2.0,
  };

  function buildSignals(rows, s, o) {
    const n = rows.length;
    const out = [];
    const w = Math.max(1, o.warmup);
    for (let i = w; i < n; i++) {
      const zt = s.slopeZ[i], zt1 = s.slopeZ[i - 1];
      const iv = s.innovZ[i], c = s.price[i];
      const up = s.upper[i], lo = s.lower[i];
      if (!finite(zt) || !finite(zt1) || !finite(c)) continue;

      // B3：趋势由不显著转为显著，且价格站在趋势线之上
      if (zt1 <= GRADES.b3Cross && zt > GRADES.b3Cross && c >= s.level[i]) {
        out.push({ i, d: rows[i][0], side: 'B', grade: 3, kind: 'start', at: c, slopeZ: zt });
        continue;
      }
      // B2：趋势已确立，价格回落到带下沿附近 —— 逆着短期波动、顺着中期趋势
      if (zt > GRADES.b2SlopeZ && iv < GRADES.b2Inno && c <= s.level[i]) {
        out.push({ i, d: rows[i][0], side: 'B', grade: 2, kind: 'pullback', at: c, slopeZ: zt });
        continue;
      }
      // B1：强趋势中站上通道上沿
      if (zt > GRADES.b1SlopeZ && c >= up) {
        out.push({ i, d: rows[i][0], side: 'B', grade: 1, kind: 'breakout', at: c, slopeZ: zt });
        continue;
      }
      // S3：趋势失效
      if (zt1 >= GRADES.s3SlopeZ && zt < GRADES.s3SlopeZ && c < s.level[i]) {
        out.push({ i, d: rows[i][0], side: 'S', grade: 3, kind: 'break', at: c, slopeZ: zt });
        continue;
      }
      // S2：强趋势快速衰竭
      if (i >= 5 && zt < GRADES.b3Cross && s.slopeZ[i - 5] - zt > GRADES.s2Drop) {
        out.push({ i, d: rows[i][0], side: 'S', grade: 2, kind: 'fade', at: c, slopeZ: zt });
        continue;
      }
      // S1：突破上轨且创新过热 —— 提示不要在此加仓
      if (c >= up && iv > GRADES.s1Inno) {
        out.push({ i, d: rows[i][0], side: 'S', grade: 1, kind: 'hot', at: c, slopeZ: zt });
      }
    }
    // 同侧相邻 3 根内只留最高级别，避免图上标签堆叠
    const out2 = [];
    for (const sg of out) {
      const last = out2[out2.length - 1];
      if (last && last.side === sg.side && sg.i - last.i <= 3) {
        if (sg.grade > last.grade) out2[out2.length - 1] = sg;
      } else out2.push(sg);
    }
    return out2;
  }

  /* ---------------- 横截面打分（选股用） ---------------- */

  /**
   * 把一个标的的卡尔曼结果压成几个可跨标的比较的标量。
   * 关键点：所有指标都做了自身波动归一化，否则「贵州茅台 slope=0.3%」
   * 与「某 ST 股 slope=0.3%」会被当成同一回事，实际风险差十倍。
   */
  function score(a) {
    const n = a.n;
    if (!n) return null;
    const i = n - 1;
    const zt = a.slopeZ[i];
    // 价格相对趋势的偏离（以通道宽度为单位），clip 到 ±3 防止极端值主导排序
    const dev = Math.max(-3, Math.min(3, a.dev[i] || 0));
    // 趋势年化收益：slope 是「每根 log 收益 ×100」，日线约 244 根
    const annual = a.slope[i] / 100 * 244 * 100;
    // 趋势自身的信噪比（相当于趋势的 Sharpe）
    const tSharpe = a.slope[i] / Math.max(a.sigma || 1, 1e-9);
    // 近 20 根斜率变化：判断趋势在加速还是衰减
    const j = Math.max(0, i - 20);
    const accel = a.slopeZ[i] - a.slopeZ[j];
    // 趋势解释度：价格波动里有多少被趋势吸收（1 - 残差方差/总方差 的近似）
    let sse = 0, sst = 0, mean = 0;
    const from = Math.max(0, i - 119);
    for (let k = from; k <= i; k++) mean += a.price[k];
    mean /= (i - from + 1);
    for (let k = from; k <= i; k++) {
      const e = Math.log(a.price[k] / a.level[k]) * 100;
      sse += e * e;
      const d = Math.log(a.price[k]) * 100 - Math.log(mean) * 100;
      sst += d * d;
    }
    const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
    return { slopeZ: zt, dev, annual, tSharpe, accel, r2, slope: a.slope[i], snr: a.snr };
  }

  const API = {
    analyze, filterCore, rtsSmooth, fit, calibrate, score,
    median, robustSd, GRADES, DEF,
    // 供回测/工具直接调用
    _internals: { median, robustSd, finite },
  };

  global.QLKalman = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
