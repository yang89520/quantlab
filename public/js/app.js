/* ============================================================
 * QuantLab · App
 * 数据装配 → 指标计算 → 流派调度 → 综合评分 → 盘面诊断 → UI
 * ============================================================ */
window.QLMount = function (RAW, meta) {
  'use strict';
  meta = meta || {};

  const QL = window.QuantLab;
  const I = window.QLInd;
  const FLOAT_SHARES = meta.floatShares || null; // 流通股（股），缺失时换手率类指标自动降级
  // 指数没有涨跌停、换手率、流通市值这些「个股制度」字段，相关流派与分析口径要分开处理
  const IS_INDEX = !!meta.isIndex;

  /* ---------------- 三周期原始数据 ---------------- */
  // a = 成交额（元），缺失时（旧缓存/降级数据）由指标层退回典型价估算均价
  const toRows = (arr) => (arr || []).map(r => ({ d: r[0], o: r[1], c: r[2], h: r[3], l: r[4], v: r[5], a: r[6] || 0 }));
  const RAW_BY = { day: toRows(RAW), week: toRows(meta.week), month: toRows(meta.month) };
  const PERIOD_NAME = { day: '日线', week: '周线', month: '月线' };
  // 依赖日线制度的流派（涨跌停幅度、连板、涨停家数）在周/月线上没有意义
  const DAY_ONLY = new Set(['limit', 'dragon', 'sentiment']);
  // 按「日线根数」定义结构的流派：5 日跌幅、150 根窗口、20 日均线在周/月线上含义完全不同
  const DAY_STRUCT = new Set(['ermai']);
  // 依赖个股制度/个股数据的流派：指数没有涨跌停，也没有流通股本与换手率
  const STOCK_ONLY = new Set(['limit', 'dragon', 'sentiment', 'zhangting20', 'turn']);

  let period = 'day';
  let data = [], N = 0, O = [], C = [], H = [], L = [], V = [], A = [], TURN = [];
  let ind = {}, zz = [], zzWave = [], jk = null, rou = null;
  let benchC = [], benchMa200 = null, rs = null, rsMa20 = null, benchOk = false;
  // 指数波动折算系数：指数的日振幅只有个股的 1/3 左右，
  // 「涨幅 5%」这类绝对阈值直接套在指数上几乎永不触发，需要按波动率折算。
  let idxK = 1;

  /* ---------------- 指标 ---------------- */
  function buildInd() {
    const ma20 = I.SMA(C, 20);
    const out = {
      ma5: I.SMA(C, 5), ma10: I.SMA(C, 10), ma20, ma30: I.SMA(C, 30),
      ma60: I.SMA(C, 60), ma120: I.SMA(C, 120), ma250: I.SMA(C, 250),
      volMa5: I.SMA(V, 5), volMa10: I.SMA(V, 10), volMa20: I.SMA(V, 20),
      macd: I.MACD(C), kdj: I.KDJ(H, L, C),
      rsi6: I.RSI(C, 6), rsi12: I.RSI(C, 12), rsi24: I.RSI(C, 24),
      boll: I.BOLL(C, 20, 2), cci: I.CCI(H, L, C, 14), dmi: I.DMI(H, L, C, 14),
      obv: I.OBV(C, V), vr: I.VR(C, V, 26),
      bias6: I.BIAS(C, 6), bias12: I.BIAS(C, 12), bias24: I.BIAS(C, 24),
      sar: I.SAR(H, L),
      cmf5: I.CMF(H, L, C, V, 5), cmf20: I.CMF(H, L, C, V, 20),
      ch20: I.Donchian(H, L, 20), ch55: I.Donchian(H, L, 55),
      ichi: I.Ichimoku(H, L, C),
      sho: I.SHO(C, 14), ema50: I.EMA(C, 50), ema20: I.EMA(C, 20),
      turn: TURN,
      turnMa5: safeSMA(TURN, 5), turnMa20: safeSMA(TURN, 20),
    };
    // 涨停回踩 20 日线：振幅强度 / 涨幅加速（依赖当日成交额还原 VWAP）
    // 指数的 成交额/成交量 得到的是「成分股平均股价」而不是指数点位（≈15 元 vs 3600 点），
    // 用它会算出上万的振幅强度，所以指数直接退回典型价口径。
    out.amp = I.AMP(O, C, H, L, V, IS_INDEX ? null : A, ma20);
    // 威科夫：努力(量比) vs 结果(价格进展/ATR)
    out.wy = I.WY(V, C, out.dmi.atr);
    // 二买：五日急跌后的强势反击。5% / 3% 是绝对涨幅阈值，指数需按波动率折算
    out.erm = I.ERM(O, C, H, L, V, out.ma5, out.ma10, out.ma20, {
      dropPct: 5 * idxK, jumpPct: 3 * idxK,
    });
    // SKDJ：超卖后的反弹强弱。K/D 是 0~100 归一化值，日/周/月同参数可比，
    // 不像「5% 涨幅」那样需要按波动率折算，指数与个股共用一套阈值。
    out.skdj = I.SKDJ(H, L, C, V, out.ma20, {
      osTh: 20,
      // 周/月线的价格百分比阈值按 √5 / √21 折算：月线一根动 10% 是常态，
      // 套日线的「反弹 10% 算强」会让所有股票都满分。
      // 波段窗口同理按根数收缩：月线 40 根是三年多，那时的反弹与现在无关。
      win: period === 'week' ? 18 : period === 'month' ? 12 : 25,
      ageMax: period === 'week' ? 25 : period === 'month' ? 16 : 40,
      pxScale: period === 'week' ? 2.2 : period === 'month' ? 4.6 : 1,
    });
    // SuperTrend：ATR 通道 + 棘轮。参数用笔记原文的 3 倍 ATR、周期 10。
    // 周/月线不另调参数：ATR 本身已按周期放大，倍数改小会让轨道贴住价格、
    // 改大会让翻转点严重滞后，两头都失真，统一 (10,3) 反而可比。
    out.st = I.SUPERTREND(H, L, C, { period: 10, mult: 3 });
    // 三指标共振：MACD / KDJ / RSI 三灯同亮。
    // 每个灯只输出 -1/0/+1，合成 -3~+3，与各指标量纲无关，日/周/月直接可比。
    out.tri = I.TRILIGHT(out.macd, out.kdj, out.rsi6, out.rsi12, C);
    // 三把锁：双平滑动量 MOMI。归一化到 -100~100，日/周/月同参数可比，
    // 不需要像「涨 1.5%」那样按周期折算。
    out.momi = I.MOMI(C, 6);
    return out;
  }

  /* ---------------- 金坑战法中间量（来源：通达信副图指标体系） ----------------
   * 原文由 6 个独立副图组成，这里统一成一套可解释的量化口径：
   *   黑夜之眼（周线KD低位金叉）→ 游资进场 → 财神来敲门 → 跃上金坑（金线王）
   *   → 金K底（底部放量反包）→ 金坑吸筹（复合超卖指标由负转正）
   */
  function buildJinKeng() {
    const rollSum = (arr, w) => {
      const o = new Array(arr.length).fill(null);
      let s = 0;
      for (let i = 0; i < arr.length; i++) {
        s += arr[i] || 0;
        if (i >= w) s -= arr[i - w] || 0;
        if (i >= w - 1) o[i] = s;
      }
      return o;
    };
    // 同一个信号在窗口内只保留第一次
    const dedupe = (raw, win) => {
      const o = raw.slice();
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        for (let j = Math.max(0, i - win); j < i; j++) if (raw[j]) { o[i] = false; break; }
      }
      return o;
    };

    // ---- 金线王：偏离度自适应的加权均线（原文权重 3.48 / 2.15）
    const ema10 = I.EMA(C, 10);
    const dev = C.map((c, i) => (ema10[i] ? Math.abs(((3.48 * c + H[i] + L[i]) / 4 - ema10[i]) / ema10[i]) : 0));
    const wsrc = C.map((c, i) => (2.15 * c + L[i] + H[i]) / 4);
    const goldLine = I.EMA(I.DMA(wsrc, dev), 5);

    // ---- 控盘度：双 9 日 EMA 的变化率放大 350 倍
    const e9 = I.EMA(I.EMA(C, 9), 9);
    const ctrl = e9.map((v, i) => (i && e9[i - 1] ? (v - e9[i - 1]) / e9[i - 1] * 350 : 0));

    // ---- 资金 MACD：对「累计成交均价乖离」做 MACD，不是价格 MACD
    // 指数取 500 根滚动窗口：从 1990 年累计到今天，均价早就不动了，副图会变成一条直线
    const vw = I.VWAP(C, V, IS_INDEX ? 500 : 0);
    const vb = I.EMA(vw, 17);
    const fundSrc2 = vw.map((v, i) => (v ? (v - vb[i]) / v * 100 : 0));
    const f12 = I.EMA(fundSrc2, 12), f26 = I.EMA(fundSrc2, 26);
    const fundDif = f12.map((v, i) => v - f26[i]);
    const fundDea = I.EMA(fundDif, 9);
    const fundHist = fundDif.map((v, i) => (v - fundDea[i]) * 2);

    // 柱子着色：OBV 动能上行 且 3 日价格均线上行 → 红（原文口径）
    const obv = I.OBV(C, V);
    const obvE3 = I.EMA(obv, 3), obvM9 = I.SMA(obv, 9);
    const obv7 = obvE3.map((v, i) => (obvM9[i] == null ? 0 : v - obvM9[i]));
    const obv8 = I.EMA(obv7.map(v => (v > 0 ? v : 0)), 3);
    const ma3c = I.SMA(C, 3);
    const barUp = obv8.map((v, i) => (i > 0 && ma3c[i] != null && ma3c[i - 1] != null && v > obv8[i - 1] && ma3c[i] > ma3c[i - 1]));

    // ---- 金坑买入 = 2*RSI5 + ADX - WR60（越接近底部，WR 越大，指标越低）
    const rsi5 = I.RSI_CN(C, 5);
    const tr = I.TR(H, L, C);
    const tr10 = rollSum(tr, 10);
    const hd = C.map((_, i) => (i ? Math.max(H[i] - H[i - 1], 0) : 0));
    const ld = C.map((_, i) => (i ? Math.max(L[i - 1] - L[i], 0) : 0));
    const dmp = rollSum(hd.map((v, i) => (i && v > ld[i] ? v : 0)), 10);
    const dmm = rollSum(ld.map((v, i) => (i && v > hd[i] ? v : 0)), 10);
    const pdi = dmp.map((v, i) => (tr10[i] ? v / tr10[i] * 100 : 0));
    const mdi = dmm.map((v, i) => (tr10[i] ? v / tr10[i] * 100 : 0));
    const adx5 = I.SMA(pdi.map((v, i) => {
      const s = v + mdi[i];
      return s ? (Math.abs(mdi[i] - v) / s) * 100 : 0;
    }), 5);
    const wr60 = I.WILLR(H, L, C, 60);
    const jkBuy = C.map((_, i) => {
      if (rsi5[i] == null || adx5[i] == null || wr60[i] == null) return null;
      return 2 * rsi5[i] + adx5[i] - wr60[i];
    });
    // 由负转正 = 金坑吸筹触发。必须「从真正的超卖区起来」才有效：
    // 前 10 根出现过 < -15，且当前价距 60 根低点不超过 25%（还在坑里），
    // 否则震荡市里这个指标会反复穿越 0，信号会烂大街。
    const jkCrossRaw = jkBuy.map((v, i) => {
      if (!(i > 0 && v != null && jkBuy[i - 1] != null && jkBuy[i - 1] <= 0 && v > 0)) return false;
      let deep = false;
      for (let k = Math.max(0, i - 10); k < i; k++) if (jkBuy[k] != null && jkBuy[k] < -15) { deep = true; break; }
      if (!deep) return false;
      let lo = Infinity;
      for (let k = Math.max(0, i - 59); k <= i; k++) if (L[k] < lo) lo = L[k];
      return lo > 0 && C[i] / lo - 1 < 0.25;
    });
    const jkCross = dedupe(jkCrossRaw, 20);

    // ---- 涨幅
    const chg = C.map((c, i) => (i ? (c / C[i - 1] - 1) * 100 : 0));
    // 指数波动只有个股的 1/3，原文「涨幅 >5%」在指数上几乎不出现，
    // 用波动折算系数 K 把绝对阈值平移到同一「异动强度」上（个股 K=1，口径不变）
    const K = idxK;

    // 游资进场：涨幅 >5% 且收盘距最高价 <1%（上影极短），34 日内首次
    const hot = dedupe(C.map((c, i) => i > 0 && chg[i] > 5 * K && H[i] / c < 1.01), 34);

    // 财神来敲门：涨幅 >4.8% 且收盘=最高，量能温和（4 日量 / 6 日量 在 0.2~2.1）
    const v4 = I.SMA(V, 4), v6 = I.SMA(V, 6);
    const knock = dedupe(C.map((c, i) => {
      if (i < 6 || v4[i] == null || v6[i] == null || !v6[i]) return false;
      const r = v4[i] / v6[i];
      // 「收盘 = 最高」改用相对口径（0.3%），否则指数上万点的绝对容差毫无意义
      const nearHigh = H[i] > 0 && (H[i] - c) / H[i] < 0.003;
      return chg[i] > 4.8 * K && nearHigh && r > 0.2 && r < 2.1;
    }), 10);

    // 跃上金坑：收盘上穿金线王 且 当日涨幅 >8%
    const goldK = C.map((c, i) => (i > 0 && goldLine[i] != null && goldLine[i - 1] != null
      && C[i - 1] <= goldLine[i - 1] && c > goldLine[i] && chg[i] > 8 * K));

    // 金K底：闭合的 75 日位置低于昨日开盘位置，同时量增价涨（底部放量反包）
    const lo75 = I.LLV(L, 75), hi75 = I.HHV(H, 75);
    const posOf = (p, i) => (hi75[i] == null || hi75[i] === lo75[i] ? 50 : (p - lo75[i]) / (hi75[i] - lo75[i]) * 100);
    const posC = C.map((c, i) => posOf(c, i));
    const posO = data.map((x, i) => posOf(x.o, i));
    const sm20c = I.TSMA(posC, 20, 1), sm15c = I.TSMA(sm20c, 15, 1);
    const sm20o = I.TSMA(posO, 20, 1), sm15o = I.TSMA(sm20o, 15, 1);
    const var6 = C.map((_, i) => 100 - 3 * sm20c[i] + 2 * sm15c[i]);
    const var7 = C.map((_, i) => 100 - 3 * sm20o[i] + 2 * sm15o[i]);
    const bottom = dedupe(C.map((c, i) => i > 0 && var6[i] < var7[i - 1] && V[i] > V[i - 1] && c > C[i - 1]), 18);

    // 高位滞涨卖出：昨日强势、今日转弱 且 RSI3 > 76
    const rsi3 = I.RSI_CN(C, 3);
    const strong = C.map((c, i) => i > 0 && c > Math.max(C[i - 1], data[i - 1].o) && c / Math.max(C[i - 1], data[i - 1].o) > 1.02);
    const sellSig = C.map((_, i) => i > 0 && strong[i - 1] && !strong[i] && rsi3[i] > 76);

    // 量能分档（量比 = 当日量 / 前一日 5 日均量）
    const vma5 = I.SMA(V, 5);
    const volRatio = V.map((v, i) => (i && vma5[i - 1] ? v / vma5[i - 1] : null));

    return {
      goldLine, ctrl, fundDif, fundDea, fundHist, barUp,
      jkBuy, jkCross, hot, knock, goldK, bottom, sellSig,
      volRatio, rsi3, rsi5, wr60, adx5, chg, strong,
    };
  }

  /* ---------------- 肉肉战法中间量（来源：通达信主图「均线斜率 + 肉肉大肉」） ----------------
   * 核心是一条斜率均线 MX = EMA(C + 20×SLOPE(C,21), 42)：
   *   把 21 日回归斜率放大 20 倍当「趋势外推价」，再做 42 日平滑。
   *   价格没动但趋势在加速时，MX 会先抬头 —— 这是它比普通均线早的地方。
   * 再用 MX 斜率 MR 的拐点序列，构造动态压力 MRR / MN3，
   * 配合相对位置的倍数阈值（<1.25、<1.35 买；>1.55 卖）形成完整买卖闭环。
   */
  function buildRou() {
    const N2 = 21, N1 = 42, N3 = 89, MULT = 20;
    // 指数波动折算（个股 = 1），用于把 3.5% / 4% 这类个股口径阈值平移到指数
    const K = idxK;
    const dedupe = (raw, win) => {
      const o = raw.slice();
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        for (let j = Math.max(0, i - win); j < i; j++) if (raw[j]) { o[i] = false; break; }
      }
      return o;
    };
    // 距最近一次满足条件过了多少根（BARSLAST）
    const barsLast = (cond) => {
      const o = new Array(cond.length).fill(-1);
      let last = -1;
      for (let i = 0; i < cond.length; i++) { if (cond[i]) last = i; o[i] = last < 0 ? -1 : i - last; }
      return o;
    };

    const MX = I.TFMA(C, N2, N1, MULT);
    const MR = I.SLOPE(MX, 2);                 // MX 的 2 日斜率

    // MR 上穿 0 = 斜率由降转升（趋势拐头向上）；下穿 0 反之
    const mrUp = MR.map((v, i) => (i > 0 && v != null && MR[i - 1] != null && v > 0 && MR[i - 1] <= 0));
    const mrDn = MR.map((v, i) => (i > 0 && v != null && MR[i - 1] != null && v < 0 && MR[i - 1] >= 0));
    const tmr = barsLast(mrUp), tmf = barsLast(mrDn);

    // 拐点基准：本次上升拐点那根 K 线的 MX 值 / 上次下降拐点那根的值
    const MRR = MX.map((v, i) => (tmr[i] < 0 ? null : MX[i - tmr[i]]));
    const MFT = MX.map((v, i) => (tmf[i] < 0 ? null : MX[i - tmf[i]]));

    // MN3 = HHV(MRR, 89)：近 89 根里所有向上拐点中最高的那个 = 上方动态压力
    const MN3 = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - (N3 - 1)); j <= i; j++) if (MRR[j] != null && MRR[j] > m) m = MRR[j];
      if (m > -Infinity) MN3[i] = m;
    }
    // 55 根内 MX 的最低值，用来判断「这波起来多少了」
    const LL55 = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      let m = Infinity;
      for (let j = Math.max(0, i - 54); j <= i; j++) if (MX[j] != null && MX[j] < m) m = MX[j];
      if (m < Infinity) LL55[i] = m;
    }

    const MXR = MX.map((v, i) => (i && MX[i - 1] ? v / MX[i - 1] : null));
    const C1 = C.map((v, i) => (i && C[i - 1] ? v / C[i - 1] : null));
    const lowRatio = MX.map((v, i) => (v != null && LL55[i] ? v / LL55[i] : null));   // MX / 55 根低点
    const topRatio = MX.map((v, i) => (v != null && MRR[i] ? v / MRR[i] : null));     // MX / 拐点基准
    const topRatio2 = MX.map((v, i) => (v != null && MFT[i] ? v / MFT[i] : null));    // MX / 上次顶部拐点

    // 底部首次突破：上穿 89 根压力，且离顶部拐点 <1.25、离 55 根低点 <1.35
    const ROU = MX.map((v, i) => (
      i > 0 && v != null && MN3[i] != null && MN3[i - 1] != null &&
      MX[i - 1] <= MN3[i - 1] && v > MN3[i] &&
      topRatio2[i] != null && topRatio2[i] < 1.25 &&
      lowRatio[i] != null && lowRatio[i] < 1.35
    ));

    // 有肉肉：MX 上穿本次拐点基准，且离 55 根低点不到 35%
    const yourou = MX.map((v, i) => (
      i > 0 && v != null && MRR[i] != null && MRR[i - 1] != null &&
      MX[i - 1] <= MRR[i - 1] && v > MRR[i] &&
      lowRatio[i] != null && lowRatio[i] < 1.35
    ));

    // 大肉：价格上穿 89 根压力 + 当日涨幅 >3.5% + MX 日涨 >0.4%
    // （原文写成 DRAWTEXT(...)&&MXR>1.004，是语法错误，本意是 AND）
    // 指数用波动折算系数 K 把 3.5% / 0.4% 平移到同一异动强度
    const darou = C.map((v, i) => (
      i > 0 && MN3[i] != null && MN3[i - 1] != null &&
      C[i - 1] <= MN3[i - 1] && v > MN3[i] &&
      C1[i] > 1 + 0.035 * K && MXR[i] != null && MXR[i] > 1 + 0.004 * K
    ));

    // 闪，不好吃：刚突破 5 根内斜率又重新拐头 —— 说明突破没延续，中间已经掉头一次
    const trr = barsLast(ROU);
    const flash = MR.map((v, i) => tmr[i] === 0 && trr[i] > 0 && trr[i] <= 5);

    // 当心大面：MX 已比拐点高出 55%，日涨 >3.4%，且斜率由升转降（最后一冲后动能衰竭）
    const bigFace = MR.map((v, i) => (
      i > 1 && MR[i] != null && MR[i - 1] != null && MR[i - 2] != null &&
      MRR[i] && MX[i] / MRR[i] >= 1.55 &&
      MXR[i] != null && MXR[i] > 1 + 0.034 * K &&
      MR[i - 1] > MR[i] && MR[i - 2] <= MR[i - 1]
    ));

    /* ---- 反包启动（原文 X_1 ~ X_29 的多重共振） ----
     * 缩量阴跌 5 根里 4 根阴线 → 突然爆量反包、上穿 6 日线、
     * MACD 柱缩短后重新放大、收在最高价附近。原文还要求流通盘 <6 亿股。
     */
    const ma6 = I.SMA(C, 6), vma5 = I.SMA(V, 5), vma12 = I.SMA(V, 12);
    const hist = ind.macd.hist;
    const reboundRaw = C.map((v, i) => {
      if (i < 116) return false;                       // 原文 REF(…,116)：上市不足 116 根不出信号
      const o = data[i].o, c = v;
      if (!(C1[i] > 1 + 0.04 * K)) return false;       // X_27 涨幅 >4%（指数按波动折算）
      if (!(C[i - 1] < data[i - 1].o && c > o)) return false;  // X_28 昨阴今阳
      // X_7 / X_13：不能是「高开 1.4% 后冲高回落」，且要收在最高价的 97.5% 以上
      const gapFade = C[i - 1] > data[i - 1].o && o > C[i - 1] * 1.014 && c < o * 1.02;
      if (gapFade || !(c > H[i] * 0.975)) return false;
      // X_11 上穿 6 日线
      if (!(ma6[i] != null && ma6[i - 1] != null && C[i - 1] <= ma6[i - 1] && c > ma6[i])) return false;
      // X_12 同时高于 5 日、12 日均量 20%
      if (!(vma5[i] && vma12[i] && V[i] > vma5[i] * 1.2 && V[i] > vma12[i] * 1.2)) return false;
      // X_16 / X_17 前 5 根里至少 4 根阴线
      let bear = 0;
      for (let k = i - 5; k < i; k++) if (C[k] <= data[k].o) bear++;
      if (bear < 4) return false;
      // X_19 / X_20 量创 20 根新高，且较昨日放大 1.5 倍
      let vmax = -Infinity;
      for (let k = Math.max(0, i - 19); k <= i; k++) if (V[k] > vmax) vmax = V[k];
      if (!(V[i] >= vmax) || !(V[i - 1] && V[i] / V[i - 1] > 1.5)) return false;
      // X_25 MACD 柱缩短后重新放大，且已回到 0 轴上方
      if (!(hist[i - 1] < hist[i - 2] && hist[i] >= 0 && hist[i] > hist[i - 1])) return false;
      return true;
    });
    const rebound = dedupe(reboundRaw, 12);

    return {
      MX, MR, MRR, MFT, MN3, LL55, MXR, lowRatio, topRatio, topRatio2,
      ROU, yourou, darou, flash, bigFace, rebound,
      mrUp, mrDn, tmr, tmf,
      mxrPct: MXR.map(v => (v == null ? null : (v - 1) * 100)),
    };
  }

  /* ---------------- 周线（多周期共振用，与当前显示周期无关） ---------------- */
  const wkRows = RAW_BY.week;
  const wkC = wkRows.map(x => x.c);
  const week = {
    n: wkRows.length, d: wkRows.map(x => x.d),
    c: wkC, o: wkRows.map(x => x.o), h: wkRows.map(x => x.h), l: wkRows.map(x => x.l),
    v: wkRows.map(x => x.v),
    ma5: I.SMA(wkC, 5), ma10: I.SMA(wkC, 10), ma20: I.SMA(wkC, 20), ma60: I.SMA(wkC, 60),
    kdj: I.KDJ(wkRows.map(x => x.h), wkRows.map(x => x.l), wkC, 9, 3, 3),
  };

  /* ---------------- 月线（周线视图下的「更大周期」） ----------------
   * 多周期流派需要「比当前显示周期更大的一档」：
   * 日线视图看周线，周线视图就得看月线，否则会拿周线和周线自己共振。
   */
  const moRows = RAW_BY.month;
  const moC = moRows.map(x => x.c);
  const month = {
    n: moRows.length, d: moRows.map(x => x.d),
    c: moC, o: moRows.map(x => x.o), h: moRows.map(x => x.h), l: moRows.map(x => x.l),
    v: moRows.map(x => x.v),
    ma5: I.SMA(moC, 5), ma10: I.SMA(moC, 10), ma20: I.SMA(moC, 20), ma60: I.SMA(moC, 60),
    kdj: I.KDJ(moRows.map(x => x.h), moRows.map(x => x.l), moC, 9, 3, 3),
  };

  /* ---------------- 基准（上证指数）与相对强弱 ---------------- */
  const benchRows = meta.bench || [];
  const benchDateCache = new Map();
  // 周/月线的日期是周期末，交易日历里可能不存在，取「不晚于该日的最近一个收盘」
  function nearestBench(d) {
    if (benchDateCache.has(d)) return benchDateCache.get(d);
    let lo = 0, hi = benchRows.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (benchRows[mid][0] <= d) { ans = benchRows[mid][2]; lo = mid + 1; } else hi = mid - 1;
    }
    benchDateCache.set(d, ans);
    return ans;
  }

  function buildBench() {
    let lb = null;
    benchC = data.map(x => {
      const v = nearestBench(x.d);
      if (v != null) lb = v;
      return lb;
    });
    const covered = benchC.filter(v => v != null).length;
    benchOk = N > 0 && covered / N > 0.8;
    benchMa200 = safeSMA(benchC, 200);
    rs = benchOk ? C.map((c, i) => (benchC[i] ? c / benchC[i] * 1000 : null)) : null;
    rsMa20 = rs ? safeSMA(rs, 20) : null;
  }

  function safeSMA(src, n) {
    const out = new Array(src.length).fill(null);
    for (let i = n - 1; i < src.length; i++) {
      let s = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) {
        if (src[j] == null) { ok = false; break; }
        s += src[j];
      }
      if (ok) out[i] = s / n;
    }
    return out;
  }

  /**
   * 指数波动折算：以个股典型日振幅 1.9% 为 1，
   * 上证约 0.5% → 0.26，创业板约 1.1% → 0.58。
   * 只用于把「涨幅 5% 算异动」这类个股口径的绝对阈值平移到指数上，
   * 其余价格结构类判据（均线、形态、量能比）都是无量纲的，不做调整。
   */
  function calcIdxK() {
    if (!IS_INDEX) return 1;
    const xs = [];
    for (let i = Math.max(1, N - 60); i < N; i++) {
      if (C[i - 1]) xs.push(Math.abs(C[i] / C[i - 1] - 1) * 100);
    }
    if (!xs.length) return 1;
    xs.sort((a, b) => a - b);
    const med = xs[xs.length >> 1];
    return Math.max(0.2, Math.min(1, med / 1.9));
  }

  /* ---------------- helpers ---------------- */
  const helpers = {
    box(from, to) { return I.boxRange(data, Math.max(0, from), Math.min(N - 1, to)); },

    /** 可视范围（信号只画在视野内，但覆盖视野的全部历史，不再只取最近 N 根） */
    vspan() {
      return { lo: Math.max(0, chart.viewStart), hi: Math.min(N, chart.viewStart + chart.viewCount) };
    },

    /** 每根 K 线的像素宽度（缩放后标签避让要按像素算）。
     * 以前钳到 0.35px，缩到全历史（几千根）时根宽只有 0.1~0.2px，
     * 间距仍按 0.35 算，标签就会挤成一坨 —— 这里保留真实宽度。 */
    bw() { return Math.max(chart.bw(), 0.02); },

    /**
     * 信号密度控制：从右往左按「最小像素间距」稀释，返回按 i 升序的数组。
     * 缩放时每根 K 线宽度变化，间距自动换算成根数，保证标签不会叠字。
     * items 每项至少要有 i 字段。
     */
    spread(items, minPx) {
      if (!items || !items.length) return [];
      const bw = Math.max(chart.bw(), 0.02);
      const gap = Math.max(1, Math.round((minPx || 58) / bw));
      const out = [];
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        if (!out.length || out[out.length - 1].i - it.i >= gap) out.push(it);
      }
      return out.reverse();
    },

    /**
     * 多类信号合并：同一位置附近（像素间距内）只保留一个标签，prio 小的优先。
     * 金坑 / 肉肉这类一个流派同时有 5~6 种标记，缩放后必须跨类避让，否则文字叠在一起。
     */
    mergeMarks(items, minPx) {
      if (!items || !items.length) return [];
      const bw = Math.max(chart.bw(), 0.02);
      const gap = Math.max(1, Math.round((minPx || 58) / bw));
      const sorted = items.slice().sort((a, b) => a.i - b.i || (a.prio || 9) - (b.prio || 9));
      const out = [];
      let cluster = [];
      const flush = () => {
        if (!cluster.length) return;
        let best = cluster[0];
        for (const c of cluster) if ((c.prio || 9) < (best.prio || 9)) best = c;
        out.push(best);
        cluster = [];
      };
      for (const it of sorted) {
        if (cluster.length && it.i - cluster[0].i >= gap) flush();
        cluster.push(it);
      }
      flush();
      return out;
    },

    /**
     * mergeMarks + 「最新一根的信号不被历史信号挤掉」。
     * lastIdx 传最新一根的下标（仅当它在可视范围内），它会独占右侧一格。
     */
    pickMarks(items, minPx, lastIdx) {
      if (!items || !items.length) return [];
      let tail = null;
      const rest = [];
      for (const c of items) {
        if (lastIdx != null && c.i >= lastIdx) {
          if (!tail || (c.prio || 9) < (tail.prio || 9)) tail = c;
        } else rest.push(c);
      }
      const out = this.mergeMarks(rest, minPx);
      if (!tail) return out;
      const bw = Math.max(chart.bw(), 0.02);
      const gap = Math.max(1, Math.round((minPx || 58) / bw));
      return out.filter(o => o.i <= tail.i - gap).concat([tail]);
    },

    /** 最近一个显著低点 L，以及 L 之后出现的最高点 H（保证 L 在前） */
    swing(zz) {
      if (!zz || zz.length < 2) return null;
      let li = -1;
      for (let i = zz.length - 1; i >= 0; i--) if (zz[i].t === 'L') { li = i; break; }
      if (li < 0) return null;
      const peakAfter = (fromIdx) => {
        let hp = data[fromIdx].h, hi = fromIdx;
        for (let i = fromIdx; i < N; i++) if (data[i].h > hp) { hp = data[i].h; hi = i; }
        return { i: hi, p: hp, t: 'H' };
      };
      let L = zz[li], H = peakAfter(L.i);
      if ((H.p - L.p) / L.p < 0.03 && li > 0) {
        for (let i = li - 1; i >= 0; i--) {
          if (zz[i].t === 'L') { L = zz[i]; H = peakAfter(L.i); break; }
        }
      }
      return H.p > L.p ? { L, H } : null;
    },
    gaps() { return I.gaps(data, 0.005); },
    chips() {
      const from = Math.max(0, N - 120);
      let lo = Infinity, hi = -Infinity;
      for (let i = from; i < N; i++) { if (data[i].l < lo) lo = data[i].l; if (data[i].h > hi) hi = data[i].h; }
      if (!isFinite(lo)) return null;
      const B = 44, step = (hi - lo) / B || 0.01;
      const vol = new Array(B).fill(0);
      let sumPV = 0, sumV = 0;
      for (let i = from; i < N; i++) {
        const mid = (data[i].h + data[i].l + data[i].c) / 3;
        let b = Math.floor((mid - lo) / step);
        b = Math.max(0, Math.min(B - 1, b));
        vol[b] += data[i].v;
        sumPV += mid * data[i].v;
        sumV += data[i].v;
      }
      // 轻度平滑
      const sm = vol.map((v, i) => (v * 2 + (vol[i - 1] || 0) + (vol[i + 1] || 0)) / 4);
      const tot = sm.reduce((a, b) => a + b, 0);
      let pocI = 0;
      for (let i = 1; i < B; i++) if (sm[i] > sm[pocI]) pocI = i;
      // 70% 区间：从 POC 向两侧扩展
      let acc = sm[pocI], lI = pocI, hI = pocI;
      while (acc < tot * 0.7 && (lI > 0 || hI < B - 1)) {
        const lv = lI > 0 ? sm[lI - 1] : -1;
        const hv = hI < B - 1 ? sm[hI + 1] : -1;
        if (hv >= lv) { hI++; acc += Math.max(0, hv); } else { lI--; acc += Math.max(0, lv); }
      }
      return {
        low: lo + lI * step, high: lo + (hI + 1) * step,
        poc: lo + (pocI + 0.5) * step,
        avg: sumPV / sumV,
      };
    },
  };

  /* ---------------- 周期切换 ---------------- */
  function applyPeriod(p) {
    const src = RAW_BY[p];
    // 门槛放到 5 根：新股/复牌股短期只有几根 K 线，仍要能画出图看结构，
    // 真正「不够算指标」的判断交给 analyzeOne（<30 根不评分）。
    if (!src || src.length < 5) return false;
    period = p;
    data = src;
    N = data.length;
    O = data.map(x => x.o);
    C = data.map(x => x.c);
    H = data.map(x => x.h);
    L = data.map(x => x.l);
    V = data.map(x => x.v);
    A = data.map(x => x.a || 0);
    // 成交量单位是「手」，换算成股后算换手率（%）。周/月线即周期内累计换手
    TURN = V.map(v => (FLOAT_SHARES ? (v * 100) / FLOAT_SHARES * 100 : null));
    idxK = calcIdxK();          // 金坑 / 肉肉 / 二买的涨幅阈值要用它折算，必须先算
    ind = buildInd();
    // 三周期共振：固定用日线读数，再映射到当前显示周期。
    // 不放在 buildInd 里，是因为那里只看得到当前周期的数组；而这里 week / month 都已就绪。
    // 一次算完，流派评分与副图共用同一份结果，不会再出现两套口径。
    ind.tri3 = I.TRICYCLE(month, week, RAW_BY.day, data, { period: p });
    zz = I.ZigZag(data, 0.10);
    zzWave = I.ZigZag(data, 0.072);
    jk = buildJinKeng();
    rou = buildRou();
    buildBench();
    window.__qlPeriod = p;      // 切换股票后沿用同一周期
    return true;
  }

  function buildCtx() {
    const last = data[N - 1] || { d: '', o: 0, c: 0, h: 0, l: 0, v: 0 };
    // 三周期共振结果：正常路径已在 setPeriod 里算好，这里兜底
    // （选股页 QLMount 的无头实例、以及任何绕过 setPeriod 的调用，都靠这一句拿到同一份读数）
    if (!ind.tri3) ind.tri3 = I.TRICYCLE(month, week, RAW_BY.day, data, { period });
    return {
      data, ind, n: N, last, zz, zzc: zz.filter(p => !p.live), zzWave, helpers, jk, rou,
      period, periodName: PERIOD_NAME[period],
      view: { start: chart.viewStart, end: Math.min(N, chart.viewStart + chart.viewCount), pMin: chart.pMin, pMax: chart.pMax },
      code: meta.code || '', name: meta.name || '',
      isIndex: IS_INDEX, asset: IS_INDEX ? 'index' : 'stock', idxK,
      week, month, bench: benchC, benchOk, benchMa200, rs, rsMa20,
      floatShares: FLOAT_SHARES,
    };
  }

  /* ---------------- 副图装配 ---------------- */
  function buildSub(type) {
    const none = { type: 'none', series: [], refs: [] };
    switch (type) {
      case 'macd':
        return {
          type, title: 'MACD(12,26,9)', series: [
            { data: ind.macd.dif, color: '#E8B84B', label: 'DIF' },
            { data: ind.macd.dea, color: '#4C8DFF', label: 'DEA' },
          ], bars: ind.macd.hist, refs: [{ v: 0, color: '#2E3A4D', label: '0' }],
        };
      case 'kdj':
        return {
          type, title: 'KDJ(9,3,3)', min: 0, max: 100, series: [
            { data: ind.kdj.k, color: '#E8B84B', label: 'K' },
            { data: ind.kdj.d, color: '#4C8DFF', label: 'D' },
            { data: ind.kdj.j, color: '#A882FF', label: 'J' },
          ], refs: [{ v: 20, color: '#2E3A4D' }, { v: 80, color: '#2E3A4D' }],
        };
      case 'skdj':
        // 慢速 K/D：20 以下为超卖区，50 是强弱分界。K 在 20~35 之间反复 =
        // 反弹力度不够的典型形态（价格横着、K 上不去），一眼能看出来。
        return {
          type, title: 'SKDJ(9,3,3)', min: 0, max: 100, series: [
            { data: ind.skdj.k, color: '#FFB020', width: 1.7, label: 'K' },
            { data: ind.skdj.d, color: '#4C8DFF', width: 1.4, label: 'D' },
          ],
          refs: [
            { v: 80, color: '#3A2E14', dash: [3, 3], label: '80' },
            { v: 50, color: '#22304A', dash: [2, 4], label: '50' },
            { v: 20, color: '#295A45', dash: [3, 3], label: '20' },
          ],
        };
      case 'rsi':
        return {
          type, title: 'RSI(6,12,24)', min: 0, max: 100, series: [
            { data: ind.rsi6, color: '#E8B84B', label: 'RSI6' },
            { data: ind.rsi12, color: '#4C8DFF', label: 'RSI12' },
            { data: ind.rsi24, color: '#A882FF', label: 'RSI24' },
          ], refs: [{ v: 30, color: '#2E3A4D' }, { v: 50, color: '#22304A' }, { v: 70, color: '#2E3A4D' }],
        };
      case 'bollb': {
        const pctB = C.map((c, i) => {
          const u = ind.boll.up[i], d = ind.boll.dn[i];
          return u == null || u === d ? null : (c - d) / (u - d) * 100;
        });
        return {
          type, title: '布林 %B', min: -20, max: 120, series: [{ data: pctB, color: '#7FB0FF', width: 1.6, label: '%B' }],
          refs: [{ v: 0, color: '#2E3A4D', label: '0' }, { v: 50, color: '#22304A' }, { v: 100, color: '#2E3A4D', label: '100' }],
        };
      }
      case 'obv':
        return { type, title: 'OBV 能量潮', series: [{ data: ind.obv, color: '#6FD3C7', width: 1.6, label: 'OBV' }], refs: [] };
      case 'cci':
        return { type, title: 'CCI(14)', series: [{ data: ind.cci, color: '#A882FF', width: 1.5, label: 'CCI' }], refs: [{ v: 100, color: '#2E3A4D' }, { v: -100, color: '#2E3A4D' }] };
      case 'adx':
        return {
          type, title: 'DMI / ADX(14)', min: 0, max: 60, series: [
            { data: ind.dmi.pdi, color: '#F6465D', label: '+DI' },
            { data: ind.dmi.mdi, color: '#2EBD85', label: '-DI' },
            { data: ind.dmi.adx, color: '#E8B84B', width: 1.6, label: 'ADX' },
          ], refs: [{ v: 25, color: '#2E3A4D' }],
        };
      case 'bias':
        return {
          type, title: '均线乖离 BIAS', series: [
            { data: ind.bias6, color: '#E8B84B', label: '6日' },
            { data: ind.bias12, color: '#4C8DFF', label: '12日' },
          ], refs: [{ v: 0, color: '#2E3A4D' }],
        };
      case 'vr':
        return { type, title: 'VR 量比比率(26)', series: [{ data: ind.vr, color: '#B48CFF', width: 1.5, label: 'VR' }], refs: [{ v: 160, color: '#2E3A4D' }, { v: 250, color: '#3A2E14' }] };
      case 'vol': {
        const ratio = V.map((v, i) => (ind.volMa5[i] ? v / ind.volMa5[i] : null));
        return { type, title: '量比（当日量/5日均量）', series: [{ data: ratio, color: '#6FD3C7', width: 1.5, label: '量比' }], refs: [{ v: 1, color: '#2E3A4D', label: '1.0' }, { v: 2, color: '#3A2E14' }] };
      }
      case 'cmf':
        return {
          type, title: 'CMF 资金流(20,5)', min: -0.45, max: 0.45, series: [
            { data: ind.cmf20, color: '#35C6A0', width: 1.6, label: 'CMF20' },
            { data: ind.cmf5, color: '#E8B84B', width: 1.0, label: 'CMF5' },
          ], refs: [{ v: 0, color: '#2E3A4D' }, { v: 0.15, color: '#295A45' }, { v: -0.15, color: '#5A2530' }],
        };
      case 'turn':
        return {
          type, title: '换手率(%)', series: [
            { data: ind.turn, color: '#5AC8FA', width: 1.5, label: '换手' },
            { data: ind.turnMa5, color: '#E8B84B', width: 1.0, label: '5日均' },
          ], refs: [{ v: 3, color: '#2E3A4D' }, { v: 7, color: '#3A2E14' }, { v: 15, color: '#5A2530', label: '15' }],
        };
      case 'rs':
        return {
          type, title: '相对强弱 RS（vs 上证指数）', series: [
            { data: rs || [], color: '#FF7EB6', width: 1.6, label: 'RS' },
            { data: rsMa20 || [], color: '#4C8DFF', width: 1.0, label: 'RS20' },
          ], refs: [],
        };
      case 'fundmacd':
        return {
          type, title: '资金 MACD（累计均价乖离）', digits: 3,
          series: [
            { data: jk.fundDif, color: '#E8B84B', label: 'DIF' },
            { data: jk.fundDea, color: '#4C8DFF', label: 'DEA' },
          ],
          bars: jk.fundHist,
          // 柱子：OBV 动能与 3 日均价同步上行才是红柱（原文口径，与普通 MACD 正负色不同）
          barColors: jk.fundHist.map((v, i) => (jk.barUp[i] ? 'rgba(246,70,93,.8)' : 'rgba(90,120,170,.55)')),
          refs: [{ v: 0, color: '#2E3A4D', label: '0' }],
        };
      case 'mxslope':
        return {
          type, title: 'MX 斜率（%／根）', digits: 2,
          series: [{ data: rou ? rou.mxrPct : [], color: '#FF9F43', width: 1.7, label: 'MX涨速' }],
          refs: [{ v: 0, color: '#2E3A4D', label: '0' }],
        };
      case 'sho':
        return {
          type, title: 'SHO 简谐振荡器(14)', min: -100, max: 100, digits: 1,
          series: [{ data: ind.sho.sho, color: '#FFD166', width: 1.8, label: 'SHO' }],
          refs: [
            { v: 60, color: '#5A2530', dash: [2, 3], label: '+60' },
            { v: 40, color: '#3A2E14', label: '+40' },
            { v: 0, color: '#4A5A73', label: '0' },
            { v: -40, color: '#3A2E14', label: '-40' },
            { v: -60, color: '#295A45', dash: [2, 3], label: '-60' },
          ],
        };
      case 'mom':
        // MOMI 是归一化动量（-100~100），0 轴多空分界，±40 以外算极端。
        // 第一把锁判的不是数值高低，而是「MOMI 从下往上穿过自己的 3 日线」，
        // 所以两条线的相对位置比绝对值更重要。
        return {
          type, title: 'MOMI 双平滑动量(6,6)', min: -100, max: 100, digits: 1,
          series: [
            { data: ind.momi.v, color: '#C0A16B', width: 1.7, label: 'MOMI' },
            { data: ind.momi.ma3, color: '#4C8DFF', width: 1.0, label: 'MA3' },
          ],
          refs: [
            { v: 40, color: '#5A2530', dash: [2, 3], label: '+40' },
            { v: 0, color: '#4A5A73', label: '0' },
            { v: -40, color: '#295A45', dash: [2, 3], label: '-40' },
          ],
        };
      case 'st': {
        // 价格距 SuperTrend 轨道几个 ATR。0 是翻向临界点，±3 是原文「离得太远」的量级。
        const d = ind.st && ind.st.dist ? ind.st.dist : [];
        return {
          type, title: 'SuperTrend 距轨（ATR 倍数）', digits: 2, min: -6, max: 6,
          series: [], bars: d,
          barColors: d.map((v, i) => {
            if (v == null) return 'rgba(90,120,170,.3)';
            const up = ind.st.dir[i] === 1;
            return up ? (v > 3 ? 'rgba(246,70,93,.35)' : 'rgba(246,70,93,.85)')
              : (v < -3 ? 'rgba(46,189,133,.35)' : 'rgba(46,189,133,.85)');
          }),
          refs: [
            { v: 3, color: '#5A2530', dash: [2, 3], label: '+3 追高' },
            { v: 0, color: '#4A5A73', label: '0 翻向' },
            { v: -3, color: '#295A45', dash: [2, 3], label: '-3 超跌' },
          ],
        };
      }
      case 'tri': {
        // 三灯合成：+3 三灯同亮多、-3 同亮空。柱子粗细比数值更重要，所以按档位调透明度。
        const t = ind.tri || {};
        const sum = t.sum || [];
        return {
          type, title: '三灯合成（MACD+KDJ+RSI）', min: -3, max: 3, digits: 0,
          series: [], bars: sum,
          barColors: sum.map(v => {
            if (v == null) return 'rgba(90,120,170,.3)';
            if (v === 3) return 'rgba(246,70,93,.95)';
            if (v === 2) return 'rgba(246,70,93,.7)';
            if (v === 1) return 'rgba(246,70,93,.35)';
            if (v === -1) return 'rgba(46,189,133,.35)';
            if (v === -2) return 'rgba(46,189,133,.7)';
            if (v === -3) return 'rgba(46,189,133,.95)';
            return 'rgba(120,132,150,.35)';
          }),
          refs: [
            { v: 3, color: '#5A2530', dash: [2, 3], label: '三多' },
            { v: 0, color: '#4A5A73', label: '0' },
            { v: -3, color: '#295A45', dash: [2, 3], label: '三空' },
          ],
        };
      }
      case 'tri3': {
        // 柱 = 三层里有几层站在 20 线上（0~3），线 = 当日量 / 前 3 日均量。
        // 原文的买点要求「三层齐 + 量能背书」，这两个维度画在一起，一眼能看出差在哪。
        const T = ind.tri3 || {};
        const lv = (T.series && T.series.level) || [];
        const vr = (T.series && T.series.volR) || [];
        return {
          // 量比固定是日线口径：周/月视图里也取「该周期最后一天的日线量比」，
          // 不是把周量比上去 —— 周量比与前 3 周均量比，量纲和判据都变了，不能混用。
          type, title: '三周期层级（月/周/日）+ 日线量比', min: 0, max: 4, digits: 2,
          series: [{ data: vr, color: '#E8B84B', width: 1.2, label: '日线量比/前3日' }],
          bars: lv,
          barColors: lv.map(v => v == null ? 'rgba(90,120,170,.25)'
            : v >= 3 ? 'rgba(246,70,93,.85)'
              : v === 2 ? 'rgba(246,70,93,.55)'
                : v === 1 ? 'rgba(246,70,93,.28)' : 'rgba(120,132,150,.35)'),
          refs: [
            { v: 3, color: '#5A2530', dash: [4, 3], label: '3 层齐' },
            { v: 2, color: '#3A2E14', dash: [2, 4], label: '2' },
            { v: 1.5, color: '#4A3A1A', dash: [1, 4], label: '放量1.5' },
            { v: 0, color: '#4A5A73', label: '0' },
          ],
        };
      }
      case 'ampstr':
        // 振幅强度 = K 线相对当日成交均价的偏离（元→占均价的百分比×50），
        // 3 是原文的突破阈值。只放这一条曲线，预期振幅量纲不同（可为负），同轴会把主曲线压扁。
        return {
          type, title: '振幅强度', digits: 2, min: 0,
          series: [{ data: ind.amp.ampStr, color: '#FF9F43', width: 1.7, label: '强度' }],
          refs: [
            { v: 3, color: '#F6465D', dash: [4, 3], label: '3 突破' },
            { v: 1.5, color: '#2E3A4D', label: '1.5' },
          ],
        };
      case 'wyckoff':
        // 威科夫第三定律：努力（成交量/20日均量）对结果（价格进展/ATR）。
        // 努力大而结果小 = 有人在吸收；努力小而结果大 = 趋势轻快。
        return {
          type, title: '努力 / 结果', digits: 2, min: 0,
          series: [
            { data: ind.wy.effort, color: '#FF9F43', width: 1.5, label: '努力' },
            { data: ind.wy.result, color: '#4C8DFF', width: 1.3, label: '结果' },
          ],
          refs: [
            { v: 1, color: '#4A5A73', dash: [3, 3], label: '均量' },
            { v: 2, color: '#5A2530', dash: [2, 3], label: '2×' },
          ],
        };
      case 'erm':
        // 二买的两个「不能过头」约束：开盘距前高 <10%、5 日涨幅 <8%。
        // 两条都是百分比量纲、同轴可比；量比 1.5 与反弹 50% 放在解读里，硬塞同轴会把曲线压扁。
        return {
          type, title: '二买位置', digits: 1,
          series: [
            { data: ind.erm.gapPct, color: '#45D1B8', width: 1.6, label: '距前高' },
            { data: ind.erm.fivePct, color: '#E8B84B', width: 1.1, label: '5日%' },
          ],
          refs: [
            { v: 10, color: '#5A2530', dash: [3, 3], label: '10' },
            { v: 8, color: '#3A2E14', dash: [2, 3], label: '8' },
            { v: 0, color: '#4A5A73', label: '0' },
          ],
        };
      case 'pabar': {
        // Al Brooks 读 K 线：实体占振幅比例（带方向）。>= 0.55 才算强趋势 K 线，
        // 绝对值越小越接近十字星/区间 K 线，这是「趋势 vs 震荡」的原始判据。
        const bs = C.map((c, i) => {
          const rng = H[i] - L[i];
          return rng > 0 ? (c - data[i].o) / rng : 0;
        });
        return {
          type, title: 'K线强度（实体／振幅）', min: -1, max: 1, digits: 2,
          series: [], bars: bs,
          barColors: bs.map(v => (v >= 0.55 ? 'rgba(246,70,93,.85)'
            : v <= -0.55 ? 'rgba(46,189,133,.85)'
              : v >= 0 ? 'rgba(246,70,93,.28)' : 'rgba(46,189,133,.28)')),
          refs: [
            { v: 0.55, color: '#5A2530', dash: [2, 3], label: '+0.55' },
            { v: 0, color: '#4A5A73', label: '0' },
            { v: -0.55, color: '#295A45', dash: [2, 3], label: '-0.55' },
          ],
        };
      }
      default:
        return none;
    }
  }

  /* ---------------- 图表 ---------------- */
  /**
   * 无头模式：选股页要在几百只标的上跑流派评分，但不需要画图。
   * 这里给一个「哑图表」，只有 helpers / buildCtx 真正用到的 4 个属性，
   * 这样同一份指标与流派代码可以在没有 DOM 的环境里逐只复用，
   * 保证选股结果与详情页的评分是同一套实现算出来的（不会出现两套口径）。
   */
  const HEADLESS = !!meta.headless;
  const chart = HEADLESS
    ? {
      viewStart: 0,
      get viewCount() { return N; },
      pMin: null,
      pMax: null,
      bw() { return 4; },
      setData() {}, setSub() {}, setOverlay() {}, render() {}, setRange() {},
    }
    : new window.QLChart(document.getElementById('chart'), document.getElementById('tip'));
  const initP = RAW_BY[window.__qlPeriod] && RAW_BY[window.__qlPeriod].length >= 5 ? window.__qlPeriod : 'day';
  applyPeriod(initP);
  chart.setData(data, ind);

  /* ---------------- 单流派分析（无头模式入口） ---------------- */
  function analyzeOne(sid) {
    const s = QL.strategies.find(x => x.id === sid);
    if (!s) return null;
    const off = offReason(s.id);
    const base = { id: sid, name: s.name, short: s.short, color: s.color, off: off || null };
    if (off) {
      return Object.assign(base, {
        score: null,
        verdict: off === 'index' ? '指数不适用' : '当前周期不适用',
        points: [],
      });
    }
    // 新股上市不足 30 个交易日：均线、形态、量比基准全都立不住，
    // 强行算出来的是噪音，不如明确说「数据不够」，也不给评分误导人。
    if (N < 30) {
      return Object.assign(base, {
        score: null,
        verdict: `上市仅 ${N} 个交易日，不足以计算${period === 'day' ? '日线' : PERIOD_NAME[period]}级别的均线与形态，暂不评分。`,
        points: [{ k: '可用数据', v: `${N} 根（至少需要 30 根）` }],
      });
    }
    const ctx = buildCtx();
    try {
      const r = s.analyze ? s.analyze(ctx) : { score: 0, verdict: '', points: [] };
      return Object.assign(base, r, { score: Math.max(-100, Math.min(100, r.score || 0)) });
    } catch (e) {
      return Object.assign(base, { score: 0, error: e.message, verdict: '分析异常：' + e.message, points: [] });
    }
  }

  if (HEADLESS) {
    return {
      analyzeOne,
      composite,
      ctx: buildCtx,
      setPeriod: applyPeriod,
      strategies: QL.strategies.map(s => ({ id: s.id, name: s.name, short: s.short, color: s.color, sub: s.sub })),
      get data() { return data; },
      get ind() { return ind; },
      get period() { return period; },
      meta,
    };
  }

  /* ---------------- Tab ---------------- */
  const tabsEl = document.getElementById('tabs');
  let current = QL.strategies[0];
  tabsEl.innerHTML = '';

  QL.strategies.forEach(s => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="sw" style="background:${s.color}"></span>${s.name}`;
    // hash 带上标的代码：刷新后能同时恢复「哪只标的 + 哪个流派」
    b.onclick = () => { select(s.id); setHash(s.id); };
    tabsEl.appendChild(b);
  });

  // 流派多了以后标签栏单行横向滚动：滚轮直接转成横向，选中的标签自动露出来
  tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = tabsEl.scrollWidth - tabsEl.clientWidth - 1;
    // 已经滚到两端就交还给页面滚动，避免劫持整页
    if (e.deltaY > 0 && tabsEl.scrollLeft >= max) return;
    if (e.deltaY < 0 && tabsEl.scrollLeft <= 0) return;
    tabsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  function setHash(sid) {
    const c = meta.code ? meta.code + '/' : '';
    history.replaceState(null, '', '#' + c + sid);
  }

  function revealTab(el) {
    if (!el) return;
    const l = el.offsetLeft, r = l + el.offsetWidth;
    if (l < tabsEl.scrollLeft + 6) tabsEl.scrollLeft = l - 8;
    else if (r > tabsEl.scrollLeft + tabsEl.clientWidth - 6) tabsEl.scrollLeft = r - tabsEl.clientWidth + 8;
  }

  let lastViewKey = '';

  /* 流派是否不适用于当前标的/周期：null 表示可用，否则是原因 */
  function offReason(id) {
    if (IS_INDEX && STOCK_ONLY.has(id)) return 'index';
    if (DAY_ONLY.has(id) && period !== 'day') return 'period';
    if (DAY_STRUCT.has(id) && period !== 'day') return 'period-struct';
    return null;
  }

  function select(id) {
    const s = QL.strategies.find(x => x.id === id) || QL.strategies[0];
    current = s;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.id === s.id));
    revealTab(document.querySelector('.tab.on'));
    const off = offReason(s.id);
    // 数据不足时既不算叠加层也不算评分：8 根 K 线画出来的「均线缠绕」是噪音，
    // 而叠上去的形态线会落在没有意义的位置上。
    const short = N < 30;
    const ctx = buildCtx();
    let ov = [], an = { score: 0, verdict: '—', points: [] };
    try { ov = (off || short) ? [] : (s.overlay ? s.overlay(ctx) : []); }
    catch (e) { console.error('overlay:' + s.id, e); ov = []; }
    if (short) {
      an = {
        score: null,
        verdict: `当前${PERIOD_NAME[period]}只有 ${N} 根 K 线，不足以计算均线、形态与量能基准，暂不评分。等上市满 30 个交易日再看。`,
        points: [{ k: '可用数据', v: `${N} 根（至少需要 30 根）` }],
      };
    } else if (off === 'index') {
      an = {
        score: 0,
        verdict: '指数没有涨跌停、换手率与流通股本，看资金与强弱请改用「量价理论」「资金流 CMF」「相对强弱 RS」。',
        points: [],
      };
    } else {
      try { if (s.analyze) an = s.analyze(ctx); }
      catch (e) { console.error('analyze:' + s.id, e); an = { score: 0, verdict: '分析异常：' + e.message, points: [] }; }
    }
    // 先渲染文字结论，再画图：新股只有几根 K 线时图表计算可能越界，
    // 不能因为画不出图就把解读卡一起丢掉。
    renderInsight(s, an, off);
    try {
      chart.setSub((off || short) ? { type: 'none', series: [], refs: [] } : buildSub(s.sub));
      chart.setOverlay((off || short) ? [] : ov);
      lastViewKey = chart.viewStart + ':' + chart.viewCount + ':' + period + ':' + s.id;
      chart.render();
    } catch (e) {
      console.error('chart:' + s.id, e);
    }
  }

  /* 视口变了就重算叠加层。
   * 以前只有「切换流派 / 换周期」会重算，缩放和拖动不会，导致把根数拉到全部后
   * 信号仍然停在 90 根视野算出来的位置，全部叠在右侧 —— 看起来像「历史没有信号」。 */
  chart.onViewChange = function () {
    if (!current) return;
    const key = chart.viewStart + ':' + chart.viewCount + ':' + period + ':' + current.id;
    if (key === lastViewKey) return;
    lastViewKey = key;
    if (offReason(current.id)) { chart.setOverlay([]); return; }
    const ctx = buildCtx();
    let ov = [];
    try { ov = current.overlay ? current.overlay(ctx) : []; }
    catch (e) { console.error('overlay:' + current.id, e); ov = []; }
    chart.setOverlay(ov);
  };

  /* ---------------- 流派解读 ---------------- */
  function scoreColor(v) {
    if (v >= 20) return '#F6465D';
    if (v <= -20) return '#2EBD85';
    return '#E8B84B';
  }

  function renderInsight(s, r, off) {
    const disabled = off === 'index';
    // score 为 null = 数据不足，不能直接 toFixed
    const noScore = r.score == null;
    const col = (disabled || noScore) ? '#5A6474' : scoreColor(r.score);
    const pts = (r.points || []).map(p =>
      `<div class="pt"><div class="k">${p.k}</div><div class="v">${p.v}</div></div>`).join('');
    const warn = disabled
      ? '该流派依赖个股制度（涨跌停幅度 / 连板 / 换手率 / 流通股本），指数不适用，已从综合评分中剔除。'
      : off === 'period'
        ? `该流派依赖日线制度（涨跌停幅度 / 连板 / 涨停家数），当前为${PERIOD_NAME[period]}，结论仅供参考。`
        : off === 'period-struct'
          ? `该流派的结构按日线根数定义（5 日跌幅 / 150 根窗口 / 20 日均线），当前为${PERIOD_NAME[period]}，条件已失去原意，仅作参考。`
          : '';
    const scoreTxt = (disabled || noScore) ? '—' : `${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}`;
    document.getElementById('insight').innerHTML = `
      <div class="ins-head">
        <div class="ins-badge" style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}44">${s.short}</div>
        <div>
          <div class="ins-title">${s.name}<span class="ins-period">${IS_INDEX ? '指数 · ' : ''}${PERIOD_NAME[period]}</span></div>
          <div class="ins-sub">${s.desc || ''}</div>
        </div>
        <div class="ins-score">
          <div class="n" style="color:${col}">${scoreTxt}</div>
          <div class="l">${disabled ? '不适用' : noScore ? '数据不足' : '流派评分'}</div>
        </div>
      </div>
      ${warn ? `<div class="ins-warn">${warn}</div>` : ''}
      <div class="ins-verdict" style="border-left-color:${col}">${r.verdict}</div>
      <div class="pts">${pts}</div>`;
  }

  /* ---------------- 综合评分 ---------------- */
  function composite() {
    const ctx = buildCtx();
    // 数据不足时不硬算综合分：40 个流派在 8 根 K 线上得出的加权平均没有意义
    if (N < 30) {
      return {
        rows: [], total: null, pos: 0, neg: 0, neutral: 0, conf: 0,
        activeCount: 0, short: true, bars: N,
      };
    }
    const rows = QL.strategies.map(s => {
      const off = offReason(s.id) === 'index';   // 个股专属流派不参与指数评分
      let r;
      if (off) r = { score: 0, verdict: '该流派依赖个股制度，指数不适用。', points: [] };
      else {
        try { r = s.analyze ? s.analyze(ctx) : { score: 0 }; } catch (e) { r = { score: 0, verdict: '', points: [] }; }
      }
      return { s, r, off, w: QL.WEIGHTS[s.id] != null ? QL.WEIGHTS[s.id] : 1 };
    });
    const active = rows.filter(x => !x.off);
    let sum = 0, wsum = 0;
    active.forEach(x => { sum += x.r.score * x.w; wsum += x.w; });
    let total = wsum ? sum / wsum : 0;

    // 位置修正：极端乖离与箱体位置做微调
    const n = N - 1;
    const bias = ind.bias24[n] || 0;
    if (bias > 8) total -= 6;
    if (bias < -8) total += 6;

    total = Math.max(-100, Math.min(100, total));

    const pos = active.filter(x => x.r.score > 15).length;
    const neg = active.filter(x => x.r.score < -15).length;
    const conf = active.length ? Math.round(Math.max(pos, neg) / active.length * 100) : 0;
    return { rows, total, pos, neg, neutral: active.length - pos - neg, conf, activeCount: active.length };
  }

  function verdictOf(score) {
    // 数据不足：不参与评级，也不假装配一个「中性震荡」
    if (score == null) return { t: '数据不足', c: '#8A93A6', d: 'K 线不足 30 根，暂不评级' };
    if (score >= 45) return { t: '强势看多', c: '#F6465D', d: '多流派共振向上' };
    if (score >= 18) return { t: '偏多', c: '#FF7A8A', d: '多头略占优势' };
    if (score > -18) return { t: '中性震荡', c: '#E8B84B', d: '多空分歧，方向待选' };
    if (score > -45) return { t: '偏空', c: '#3ED49A', d: '空头略占优势' };
    return { t: '弱势看空', c: '#2EBD85', d: '多流派共振向下' };
  }

  /* ---------------- 盘面诊断 ---------------- */
  /**
   * 当日已完成的「成交量进度」（近似，非交易时间/非日线返回 1）。
   * A 股日内成交是前高后低的：开盘半小时就占全天两成以上，
   * 若按纯时间线性折算（10:15 → 18.75%），上午会被系统性读成「巨量」。
   * 这里用一条经验累计曲线，把「当日累计量」折回可与日均量比较的全天口径。
   */
  const VOL_CURVE = [[0, 0], [15, 0.12], [30, 0.22], [60, 0.32], [90, 0.40],
    [120, 0.45], [180, 0.60], [210, 0.70], [240, 1]];

  function sessionFrac(dateStr) {
    if (period !== 'day') return 1;
    const t = new Date();
    const p2 = (x) => (x < 10 ? '0' + x : '' + x);
    if (dateStr !== `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`) return 1;
    const m = t.getHours() * 60 + t.getMinutes();
    let e;
    if (m <= 570) e = 0;                          // 09:30 前
    else if (m < 690) e = m - 570;                // 上午 120 分钟
    else if (m < 780) e = 120;                    // 午休
    else if (m < 900) e = 120 + (m - 780);        // 下午 120 分钟
    else e = 240;                                 // 15:00 后
    for (let i = 1; i < VOL_CURVE.length; i++) {
      const [x1, y1] = VOL_CURVE[i], [x0, y0] = VOL_CURVE[i - 1];
      if (e <= x1) return Math.max(0.05, Math.min(1, y0 + (y1 - y0) * (e - x0) / (x1 - x0)));
    }
    return 1;
  }

  function diagnosis() {
    const n = N - 1, d = data[n], c = d.c;
    const m20 = ind.ma20[n], m60 = ind.ma60[n], m20p = ind.ma20[n - 5];
    const out = {};
    const frac = sessionFrac(d.d);
    const volAdj = d.v / frac;                    // 折算到「全天」口径

    // 趋势
    if (c > m20 && m20 > m20p && c > m60) out.trend = ['上升（短中期共振）', '#F6465D'];
    else if (c < m20 && m20 < m20p && c < m60) out.trend = ['下降（短中期共振）', '#2EBD85'];
    else if (c > m20) out.trend = ['反弹中（中期未确认）', '#FF7A8A'];
    else out.trend = ['调整中（中期偏弱）', '#3ED49A'];

    // 量能（盘中按已走完的时间折算，否则每天上午都是「缩量」）
    const vr = ind.volMa5[n] ? volAdj / ind.volMa5[n] : 1;
    out.vol = vr > 1.8 ? [`显著放量 ${vr.toFixed(2)}×`, '#E8B84B']
      : vr > 1.15 ? [`温和放量 ${vr.toFixed(2)}×`, '#C6D0DE']
        : vr < 0.75 ? [`明显缩量 ${vr.toFixed(2)}×`, '#8C98AB']
          : [`量能平稳 ${vr.toFixed(2)}×`, '#C6D0DE'];

    // 位置
    const box = helpers.box(Math.max(0, n - 90), n);
    const pos = (c - box.lo) / (box.hi - box.lo) * 100;
    out.pos = [`${pos.toFixed(0)}%（${box.lo.toFixed(2)}–${box.hi.toFixed(2)}）`, pos > 80 ? '#F6465D' : pos < 20 ? '#2EBD85' : '#C6D0DE'];

    // 波动（按周期归一到日度量级，风险阈值才有可比性：波动率按时间平方根缩放）
    const atr = ind.dmi.atr[n] || 0;
    const scale = period === 'week' ? Math.sqrt(5) : period === 'month' ? Math.sqrt(21) : 1;
    const atrRaw = c ? atr / c * 100 : 0;
    const atrPct = atrRaw / scale;
    const hiAtr = IS_INDEX ? 2.4 : 6, midAtr = IS_INDEX ? 1.6 : 4;
    out.atr = [`ATR ${atr.toFixed(2)}（${atrRaw.toFixed(1)}%${period === 'day' ? '' : ' / ' + PERIOD_NAME[period]}）`, atrPct > hiAtr ? '#F6465D' : atrPct > midAtr ? '#E8B84B' : '#C6D0DE'];

    // 情绪：个股看换手率 + 涨停家数；指数没有换手率与涨跌停，
    // 改用「量能相对 20 日均量」与「当期涨跌幅」衡量温度
    let turn = 0, lim = 0, temp;
    if (IS_INDEX) {
      const vr20 = ind.volMa20[n] ? volAdj / ind.volMa20[n] : 1;
      const chg = n > 0 ? (d.c - data[n - 1].c) / data[n - 1].c * 100 : 0;
      temp = Math.max(0, Math.min(100, Math.round(50 + (vr20 - 1) * 32 + chg * 7)));
      out.sent = [`${temp}/100 · ${temp > 70 ? '亢奋' : temp > 45 ? '活跃' : '清淡'}（量能 ${vr20.toFixed(2)}×）`,
        temp > 70 ? '#F6465D' : temp > 45 ? '#E8B84B' : '#8C98AB'];
      out._temp = temp;
    } else {
      const turnRaw = FLOAT_SHARES ? volAdj * 100 / FLOAT_SHARES * 100 : 0;
      turn = turnRaw / (period === 'week' ? 5 : period === 'month' ? 21 : 1);
      if (period === 'day') {
        for (let i = Math.max(1, n - 120); i <= n; i++) if ((data[i].c - data[i - 1].c) / data[i - 1].c * 100 > 9.5) lim++;
      }
      temp = Math.max(0, Math.min(100, Math.round(turn * 4 + lim * 3 + (atrPct > 5 ? 15 : 0))));
      out.sent = [`${temp}/100 · ${temp > 70 ? '亢奋' : temp > 45 ? '活跃' : '冷淡'}`, temp > 70 ? '#F6465D' : temp > 45 ? '#E8B84B' : '#8C98AB'];
      out._temp = temp;
    }

    // 风险：指数的 ATR 天然比个股低一个量级，阈值按 2.4% / 1.6% 折算
    const atrBand = IS_INDEX ? (atrPct > 2.4 ? 2 : atrPct > 1.6 ? 1 : 0) : (atrPct > 6 ? 2 : atrPct > 4 ? 1 : 0);
    const riskScore = atrBand + (pos > 85 ? 2 : pos > 70 ? 1 : 0)
      + (IS_INDEX ? (temp > 82 ? 1 : 0) : (turn > 12 ? 1 : 0)) + (lim > 5 ? 1 : 0);
    out.risk = riskScore >= 5 ? ['高', '#F6465D'] : riskScore >= 3 ? ['中高', '#E8B84B'] : riskScore >= 1 ? ['中等', '#C6D0DE'] : ['较低', '#2EBD85'];
    out._raw = { pos, turn, lim, atrPct, temp, box };
    return out;
  }

  /* ---------------- 关键价位 ---------------- */
  function zones() {
    const n = N - 1, c = data[n].c;
    const box = helpers.box(Math.max(0, n - 90), n);
    const cands = [];
    const add = (p, label, prio, color) => {
      if (p == null || !isFinite(p) || p <= 0) return;
      if (Math.abs(p - c) / c < 0.004) return;            // 与现价重合的不重复展示
      if (cands.some(x => Math.abs(x.p - p) / p < 0.012)) return;
      const dist = Math.abs(p - c) / c * 100;
      cands.push({ p, label, color, score: prio - dist * 0.32 });
    };
    add(box.hi, '箱体上沿', 10, '#FF7A8A');
    add(box.lo, '箱体下沿', 10, '#3ED49A');
    add(ind.ma250[n], '年线 MA250', 7, '#8C98AB');
    add(ind.ma120[n], '半年线 MA120', 6, '#6B7787');
    add(ind.ma20[n], 'MA20 / 布林中轨', 7, '#4C8DFF');
    add(ind.ma60[n], 'MA60', 5, '#A882FF');
    zz.slice(-10).forEach(pt => add(pt.p, pt.t === 'H' ? '摆动高点' : '摆动低点', 3.5,
      pt.t === 'H' ? '#C97A85' : '#25A574'));

    const up = cands.filter(x => x.p > c * 1.004).sort((a, b) => b.score - a.score).slice(0, 3)
      .sort((a, b) => a.p - b.p);
    const dn = cands.filter(x => x.p < c * 0.996).sort((a, b) => b.score - a.score).slice(0, 3)
      .sort((a, b) => b.p - a.p);
    return { up, dn, c };
  }

  /* ---------------- 操作建议 ---------------- */
  function advice(total, dg) {
    const out = [];
    const n = N - 1, c = data[n].c;
    const z = zones();
    const res = z.dn[0] ? z.dn[0].p : c * 0.93;
    const res2 = z.dn[1] ? z.dn[1].p : c * 0.88;
    const tar = z.up[0] ? z.up[0].p : c * 1.07;
    const tar2 = z.up[1] ? z.up[1].p : c * 1.14;

    if (total >= 18) {
      out.push(`<b>方向偏多</b>：可沿 ${res.toFixed(2)} 一带逢低参与，跌破 ${res2.toFixed(2)} 止损。`);
      out.push(`<b>目标位</b>：第一目标 ${tar.toFixed(2)}，第二目标 ${tar2.toFixed(2)}，分批止盈。`);
    } else if (total > -18) {
      out.push(`<b>方向中性</b>：${dg._raw.pos > 70 ? '位置偏高，等回踩' : dg._raw.pos < 30 ? '位置偏低，可小仓试错' : '区间中部，不宜重仓'}。`);
      out.push(`<b>区间策略</b>：${res.toFixed(2)} 附近低吸，${tar.toFixed(2)} 附近高抛，破位则离场。`);
    } else {
      out.push(`<b>方向偏空</b>：反弹至 ${tar.toFixed(2)} 附近以减仓为主，不追高。`);
      out.push(`<b>防守位</b>：跌破 ${res.toFixed(2)} 确认弱势，下看 ${res2.toFixed(2)}。`);
    }
    if (IS_INDEX) {
      out.push(`<b>仓位建议</b>：指数波动率 ${dg._raw.atrPct.toFixed(1)}%、情绪温度 ${dg._raw.temp}，`
        + `对应 ETF / 期指仓位 ${dg._raw.atrPct > 2 ? '不超过 30%' : dg._raw.atrPct > 1.2 ? '不超过 50%' : '可到 60–70%'}，分两批建。`);
    } else {
      out.push(`<b>仓位建议</b>：波动率 ${dg._raw.atrPct.toFixed(1)}%、换手 ${dg._raw.turn.toFixed(1)}%，单票不超过总仓 ${dg._raw.atrPct > 5 ? '8–10%' : '12–15%'}。`);
    }
    out.push(`<b>失效条件</b>：收盘跌破 ${res2.toFixed(2)} 或放量跌破箱底 ${z.dn.length ? z.dn[z.dn.length - 1].p.toFixed(2) : '—'}，本轮技术判断作废。`);
    return out;
  }

  /* ---------------- 渲染左栏 ---------------- */
  function renderSide(comp, dg) {
    if (comp.short) {
      // 数据不足：侧栏整体降级为占位，不去算价位、多空力量与建议
      const dash = (id, txt) => { const el = document.getElementById(id); if (el) { el.textContent = txt || '—'; el.style.color = ''; } };
      dash('vBig', '数据不足'); dash('vSm', `${comp.bars} 根 K 线，先看图`);
      const vc = document.getElementById('vConf');
      if (vc) vc.innerHTML = '共振度 <b style="color:#C6D0DE">—</b> · 上市不足 30 个交易日';
      ['dTrend', 'dVol', 'dPos', 'dAtr', 'dSent', 'dRisk'].forEach((id) => dash(id));
      ['lgBull', 'lgBear'].forEach((id) => dash(id));
      const gb = document.getElementById('gBull'), gk = document.getElementById('gBear');
      if (gb) gb.style.width = '50%';
      if (gk) gk.style.width = '50%';
      const adv = document.getElementById('advice');
      if (adv) adv.innerHTML = '<div class="advice"><span class="n">1</span><div>K 线不足 30 根，均线与形态都立不住，等上市满一个月再看。</div></div>';
      const pct = 0;
      const arc = document.getElementById('ringArc');
      if (arc) { arc.style.strokeDashoffset = '144.5'; arc.style.stroke = '#8A93A6'; }
      const rv = document.getElementById('ringVal');
      if (rv) rv.textContent = '—';
      const sl = document.getElementById('scoreLabel');
      if (sl) { sl.textContent = '数据不足'; sl.style.color = '#8A93A6'; }
      const ss = document.getElementById('scoreSub');
      if (ss) ss.textContent = `${comp.bars} 根 K 线`;
      return;
    }
    const v = verdictOf(comp.total);
    document.getElementById('vBig').textContent = v.t;
    document.getElementById('vBig').style.color = v.c;
    document.getElementById('vSm').textContent = v.d;
    document.getElementById('vConf').innerHTML =
      `共振度 <b style="color:#C6D0DE">${comp.conf}%</b> · 多 ${comp.pos} / 空 ${comp.neg} / 平 ${comp.neutral}`;

    document.getElementById('dTrend').textContent = dg.trend[0];
    document.getElementById('dTrend').style.color = dg.trend[1];
    document.getElementById('dVol').textContent = dg.vol[0];
    document.getElementById('dVol').style.color = dg.vol[1];
    document.getElementById('dPos').textContent = dg.pos[0];
    document.getElementById('dPos').style.color = dg.pos[1];
    document.getElementById('dAtr').textContent = dg.atr[0];
    document.getElementById('dAtr').style.color = dg.atr[1];
    document.getElementById('dSent').textContent = dg.sent[0];
    document.getElementById('dSent').style.color = dg.sent[1];
    document.getElementById('dRisk').textContent = dg.risk[0];
    document.getElementById('dRisk').style.color = dg.risk[1];

    // 多空力量
    const b = comp.pos + comp.neg === 0 ? 50 : Math.max(8, Math.min(92, Math.round(comp.pos / (comp.pos + comp.neg) * 100)));
    document.getElementById('gBull').style.width = b + '%';
    document.getElementById('gBear').style.width = (100 - b) + '%';
    document.getElementById('lgBull').textContent = `多方 ${comp.pos} 票`;
    document.getElementById('lgBear').textContent = `空方 ${comp.neg} 票`;

    // 价位
    const z = zones();
    const rows = [];
    z.up.slice().reverse().forEach(x => rows.push(`<div class="zone r"><span class="p">${x.p.toFixed(2)}</span><span class="d">${x.label}</span></div>`));
    rows.push(`<div class="zone n"><span class="p">${z.c.toFixed(2)}</span><span class="d">当前价</span></div>`);
    z.dn.forEach(x => rows.push(`<div class="zone s"><span class="p">${x.p.toFixed(2)}</span><span class="d">${x.label}</span></div>`));
    document.getElementById('zones').innerHTML = rows.join('');

    // 建议
    document.getElementById('advice').innerHTML = advice(comp.total, dg)
      .map((t, i) => `<div class="advice"><span class="n">${i + 1}</span><div>${t}</div></div>`).join('');

    // 顶部
    const short = comp.total == null;
    const pct = short ? 0 : (comp.total + 100) / 200;
    const arc = document.getElementById('ringArc');
    arc.style.strokeDashoffset = (144.5 * (1 - pct)).toFixed(1);
    arc.style.stroke = v.c;
    document.getElementById('ringVal').textContent = short ? '—' : Math.round(pct * 100);
    document.getElementById('scoreLabel').textContent = v.t;
    document.getElementById('scoreLabel').style.color = v.c;
    document.getElementById('scoreSub').textContent = short
      ? `${comp.bars} 根 K 线`
      : `综合分 ${comp.total > 0 ? '+' : ''}${comp.total.toFixed(1)}`;
  }

  /* ---------------- 评分总览 ---------------- */
  function renderOverview(comp) {
    const el = document.getElementById('scoreOverview');
    const rows = comp.rows.slice().sort((a, b) => (a.off ? 1 : 0) - (b.off ? 1 : 0) || b.r.score - a.r.score);
    el.innerHTML = rows.map(({ s, r, off }) => {
      if (off) {
        return `<div class="srow off">
          <span class="nm" style="color:#4E596B">${s.name}</span>
          <span class="track" style="background:transparent;border:1px dashed #1E2939"></span>
          <span class="num" style="color:#4E596B;font-size:10px">不适用</span>
        </div>`;
      }
      const v = Math.max(-100, Math.min(100, r.score));
      const w = Math.abs(v) / 2;
      const left = v >= 0 ? 50 : 50 - w;
      const col = scoreColor(v);
      return `<div class="srow">
        <span class="nm" style="color:${s.color}">${s.name}</span>
        <span class="track"><i class="fill" style="left:${left}%;width:${w}%;background:${col};opacity:.85"></i></span>
        <span class="num" style="color:${col}">${v > 0 ? '+' : ''}${v.toFixed(0)}</span>
      </div>`;
    }).join('');
  }

  /* ---------------- 顶部行情 ---------------- */
  function renderHeader() {
    if (N < 2) {
      // 只有一根或没有数据：能显示名字与代码，价格与涨跌留空，不要让整页崩掉
      document.getElementById('sName').textContent = meta.name || '—';
      document.getElementById('sCode').textContent = meta.display || meta.code || '';
      const tag = document.getElementById('sIdxTag');
      if (tag) tag.hidden = !IS_INDEX;
      document.getElementById('sPrice').textContent = N ? data[N - 1].c.toFixed(2) : '—';
      document.getElementById('sPrice').style.color = '';
      document.getElementById('sChg').textContent = '—';
      return;
    }
    const n = N - 1, d = data[n], prev = data[n - 1].c;
    const chg = (d.c - prev) / prev * 100;
    const col = chg >= 0 ? '#F6465D' : '#2EBD85';

    document.getElementById('sName').textContent = meta.name || '—';
    document.getElementById('sCode').textContent = meta.display || meta.code || '';
    const tag = document.getElementById('sIdxTag');
    if (tag) tag.hidden = !IS_INDEX;
    document.getElementById('sPrice').textContent = d.c.toFixed(2);
    document.getElementById('sPrice').style.color = col;
    document.getElementById('sChg').innerHTML =
      `${chg >= 0 ? '+' : ''}${(d.c - prev).toFixed(2)} &nbsp;${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
      + `<small>${period === 'day' ? '' : PERIOD_NAME[period] + ' · '}${d.d}</small>`;
    document.getElementById('sChg').style.color = col;

    // 年内振幅（按当前周期取样：日线 250 根 / 周线 52 根 / 月线 12 根）
    const span = period === 'week' ? 52 : period === 'month' ? 12 : 250;
    let hi = -Infinity, lo = Infinity;
    data.slice(-span).forEach(x => { hi = Math.max(hi, x.h); lo = Math.min(lo, x.l); });
    document.getElementById('mAmp').textContent = lo ? ((hi - lo) / lo * 100).toFixed(0) + '%' : '—';

    // 换手率同样按当日已走完的时间折算，盘中不会显示成「换手极低」
    const turn = FLOAT_SHARES ? (d.v / sessionFrac(d.d)) * 100 / FLOAT_SHARES * 100 : 0;
    if (IS_INDEX) {
      // 指数没有换手率与流通市值：成交额看资金体量，振幅看当日情绪
      document.getElementById('mTurnK').textContent = '成交额';
      document.getElementById('mTurn').textContent = d.a ? (d.a / 1e8).toFixed(0) + '亿' : '—';
      document.getElementById('mCapK').textContent = '当日振幅';
      const amp = prev ? (d.h - d.l) / prev * 100 : 0;
      document.getElementById('mCap').textContent = amp.toFixed(2) + '%';
    } else {
      document.getElementById('mTurnK').textContent = '换手率';
      document.getElementById('mTurn').textContent = turn.toFixed(2) + '%';
      document.getElementById('mCapK').textContent = '流通市值';
      document.getElementById('mCap').textContent = FLOAT_SHARES ? (d.c * FLOAT_SHARES / 1e8).toFixed(1) + '亿' : '—';
    }
  }

  /* ---------------- 周期切换 ---------------- */
  // 用户手动选过根数就沿用，没选过按 90 根；切换周期不重置，避免按钮高亮与实际不符
  let userBars = null;

  document.querySelectorAll('[data-bars]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('[data-bars]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      userBars = parseInt(b.dataset.bars, 10);
      // 「全部」= 当前标的所有可得 K 线（指数可能上千根，个股 1200）
      if (userBars >= 1200) userBars = data.length;
      chart.setRange(userBars);
      select(current.id);
    };
  });

  document.querySelectorAll('[data-period]').forEach(b => {
    b.onclick = () => switchPeriod(b.dataset.period);
  });

  /* ---------------- 加入观察池（02 §0：S7 写入方 = Web） ----------------
     评分复用本页已挂载的 composite()，不另算一套（04 §4.2）。
     composite.total 取值 -100~100，入池门槛 minScore=70 是 0~100 口径，
     所以这里做线性归一化，并把原始值一并写入 entryReason，保证可追溯（D4）。 */
  const btnPool = document.getElementById('btnPool');
  if (btnPool) {
    btnPool.onclick = async () => {
      const old = btnPool.textContent;
      btnPool.disabled = true;
      btnPool.textContent = '提交中…';
      try {
        if (!meta || !meta.code) throw new Error('当前没有选中标的');
        const comp = composite();
        if (comp.total == null) throw new Error(`K 线仅 ${comp.bars} 根，综合评分不足 30 根门槛，暂不能入池`);
        const poolScore = Math.round((Number(comp.total) + 100) / 2);
        const r = await fetch('/api/watchpool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: meta.code,
            name: meta.name,
            score: poolScore,
            entryReason: `分析台入池 · 综合评分 ${Number(comp.total).toFixed(1)}（归一 ${poolScore}/100）· 置信 ${comp.conf}%`,
          }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || '入池失败');
        btnPool.classList.add('on');
        btnPool.textContent = '★ 已在观察池';
        btnPool.title = `已入池 ${j.data.code}｜板块 ${j.data.sector || '—'}（${j.data.state}）`;
      } catch (e) {
        btnPool.textContent = old;
        btnPool.title = '入池失败：' + e.message;
        alert('入池失败：' + e.message);
      } finally {
        btnPool.disabled = false;
      }
    };
  }

  // 依赖日线制度 / 个股制度的流派：在周月线或指数上置灰并说明原因
  function syncDayOnlyTabs() {
    document.querySelectorAll('.tab').forEach(t => {
      const off = offReason(t.dataset.id);
      t.classList.toggle('off', !!off);
      t.title = off === 'index'
        ? '该流派依赖个股制度（涨跌停 / 换手率 / 流通股本），指数不适用'
        : off === 'period' ? '该流派依赖日线制度（涨跌停 / 连板 / 涨停家数），周月线不适用'
          : off === 'period-struct' ? '该流派按日线根数定义结构（5 日跌幅 / 150 根窗口 / 20 日均线），周月线不适用' : '';
    });
  }

  function switchPeriod(p) {
    if (p === period) return;
    if (!applyPeriod(p)) return;          // 数据不足（如新股缺月线），保持原周期
    chart.setData(data, ind);
    chart.setRange(Math.min(userBars || 90, data.length));
    document.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('on', x.dataset.period === period));
    syncDayOnlyTabs();
    rerenderAll();
  }

  function rerenderAll() {
    renderHeader();
    const comp = composite();
    const dg = diagnosis();
    renderSide(comp, dg);
    renderOverview(comp);
    select(current.id);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    document.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('on', x.dataset.period === period));
    syncDayOnlyTabs();
    renderHeader();
    const comp = composite();
    const dg = diagnosis();
    renderSide(comp, dg);
    renderOverview(comp);
    // hash 形如 #600986/ma 或 #sh000001/wyckoff：取斜杠后的流派 id
    const h = (location.hash || '').replace('#', '');
    const sid = h.split('/')[1] || h;
    const ok = QL.strategies.some(s2 => s2.id === sid);
    select(ok ? sid : QL.strategies[0].id);
  }

  boot();

  // 暴露给外部调试 / 扩展
  window.QuantLab.app = {
    chart, composite, diagnosis, select, refresh: boot, meta, ctx: buildCtx,
    setPeriod: switchPeriod,
    get data() { return data; },
    get ind() { return ind; },
    get period() { return period; },
    get periodName() { return PERIOD_NAME[period]; },
    get jk() { return jk; },
    get current() { return current; },
    get currentId() { return current.id; },
  };

  if (!window.__qlBound) {
    window.__qlBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const app = window.QuantLab.app;
      if (!app) return;
      const list = window.QuantLab.strategies;
      const i = list.findIndex((x) => x.id === app.currentId);
      const n2 = (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      app.select(list[n2].id);
      setHash(list[n2].id);
    });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const app = window.QuantLab.app;
        if (!app) return;
        app.chart.render();
        app.select(app.currentId);
      }, 120);
    });
  }
};
