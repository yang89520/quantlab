/* ============================================================
 * QuantLab · Indicators
 * 纯函数指标库。全部返回与 data 等长的数组（无法计算处为 null）。
 * ============================================================ */
(function (global) {
  'use strict';

  const NA = (n) => new Array(n).fill(null);

  /* ---------- 基础均线 ---------- */
  function SMA(src, n) {
    const out = NA(src.length);
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i] || 0;
      if (i >= n) sum -= src[i - n] || 0;
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function EMA(src, n) {
    const out = NA(src.length);
    if (!src.length) return out;
    const k = 2 / (n + 1);
    let prev = src[0];
    out[0] = prev;
    for (let i = 1; i < src.length; i++) {
      prev = src[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder 平滑（RSI / ATR / DMI 使用）
  function wilder(src, n) {
    const out = NA(src.length);
    let sum = 0;
    for (let i = 0; i < n && i < src.length; i++) sum += src[i] || 0;
    if (src.length >= n) out[n - 1] = sum / n;
    for (let i = n; i < src.length; i++) {
      out[i] = (out[i - 1] * (n - 1) + (src[i] || 0)) / n;
    }
    return out;
  }

  function STD(src, n) {
    const out = NA(src.length);
    for (let i = n - 1; i < src.length; i++) {
      let m = 0;
      for (let j = i - n + 1; j <= i; j++) m += src[j];
      m /= n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (src[j] - m) ** 2;
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }

  /* ---------- 区间极值 ---------- */
  function HHV(src, n) {
    const out = NA(src.length);
    for (let i = 0; i < src.length; i++) {
      if (i < n - 1) continue;
      let m = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (src[j] > m) m = src[j];
      out[i] = m;
    }
    return out;
  }
  function LLV(src, n) {
    const out = NA(src.length);
    for (let i = 0; i < src.length; i++) {
      if (i < n - 1) continue;
      let m = Infinity;
      for (let j = i - n + 1; j <= i; j++) if (src[j] < m) m = src[j];
      out[i] = m;
    }
    return out;
  }

  /* ---------- 线性回归斜率（通达信 SLOPE 口径） ----------
   * 返回「每根 K 线变化多少元」。源码里有 null 时该点返回 null，
   * 所以可以安全地用在本身带预热空档的序列上（如 MX 的斜率）。
   */
  function SLOPE(src, n) {
    const out = NA(src.length);
    const xm = (n - 1) / 2;
    let sxx = 0;
    for (let k = 0; k < n; k++) sxx += (k - xm) * (k - xm);
    if (!sxx) return out;
    for (let i = n - 1; i < src.length; i++) {
      let sy = 0, sxy = 0, ok = true;
      for (let k = 0; k < n; k++) {
        const v = src[i - n + 1 + k];
        if (v == null) { ok = false; break; }
        sy += v;
        sxy += (k - xm) * v;
      }
      if (ok) out[i] = sxy / sxx;
    }
    return out;
  }

  /* ---------- 斜率均线 MX（「肉肉」体系的核心） ----------
   * 通达信原文：MX = EMA(SLOPE(C,21)*20 + C, 42)
   * 把 21 日回归斜率放大 20 倍当作「未来 20 根的线性外推价」，
   * 加到收盘价上再做 42 日 EMA。趋势一加速这条线就抬头，
   * 比普通均线反应更快——这就是它能提前识别拐点的原因。
   */
  function TFMA(close, n2 = 21, n1 = 42, mult = 20) {
    const sl = SLOPE(close, n2);
    const out = NA(close.length);
    const k = 2 / (n1 + 1);
    let prev = null;
    for (let i = 0; i < close.length; i++) {
      if (sl[i] == null) continue;
      const x = close[i] + sl[i] * mult;
      prev = prev == null ? x : x * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /* ---------- MACD ---------- */
  function MACD(close, fast = 12, slow = 26, sig = 9) {
    const e1 = EMA(close, fast), e2 = EMA(close, slow);
    const dif = close.map((_, i) => e1[i] - e2[i]);
    const dea = EMA(dif, sig);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  }

  /* ---------- KDJ ---------- */
  function KDJ(h, l, c, n = 9, m1 = 3, m2 = 3) {
    const len = c.length;
    const K = NA(len), D = NA(len), J = NA(len);
    let k = 50, d = 50;
    for (let i = 0; i < len; i++) {
      const s = Math.max(0, i - n + 1);
      let hi = -Infinity, lo = Infinity;
      for (let j = s; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
      const rsv = hi === lo ? 50 : ((c[i] - lo) / (hi - lo)) * 100;
      k = (2 * k + rsv) / 3;
      d = (2 * d + k) / 3;
      K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d;
    }
    return { k: K, d: D, j: J };
  }

  /* ---------- RSI ---------- */
  function RSI(close, n = 14) {
    const len = close.length;
    const out = NA(len);
    if (len < 2) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n && i < len; i++) {
      const ch = close[i] - close[i - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < len; i++) {
      const ch = close[i] - close[i - 1];
      const g = ch > 0 ? ch : 0, ls = ch < 0 ? -ch : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + ls) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /* ---------- BOLL ---------- */
  function BOLL(close, n = 20, k = 2) {
    const mid = SMA(close, n);
    const sd = STD(close, n);
    return {
      mid,
      up: mid.map((m, i) => (m == null ? null : m + k * sd[i])),
      dn: mid.map((m, i) => (m == null ? null : m - k * sd[i])),
    };
  }

  /* ---------- CCI ---------- */
  function CCI(h, l, c, n = 14) {
    const tp = c.map((v, i) => (h[i] + l[i] + c[i]) / 3);
    const ma = SMA(tp, n);
    const out = NA(c.length);
    for (let i = n - 1; i < c.length; i++) {
      let md = 0;
      for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md);
    }
    return out;
  }

  /* ---------- ATR / DMI ---------- */
  function TR(h, l, c) {
    const out = NA(c.length);
    out[0] = h[0] - l[0];
    for (let i = 1; i < c.length; i++) {
      out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    return out;
  }

  function DMI(h, l, c, n = 14) {
    const len = c.length;
    const tr = TR(h, l, c);
    const atr = wilder(tr, n);
    const pdm = NA(len), mdm = NA(len);
    for (let i = 1; i < len; i++) {
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      pdm[i] = up > dn && up > 0 ? up : 0;
      mdm[i] = dn > up && dn > 0 ? dn : 0;
    }
    const pdi = NA(len), mdi = NA(len), dx = NA(len), adx = NA(len);
    for (let i = n; i < len; i++) {
      // 简化：用 n 周期和
      let sp = 0, sm = 0, st = 0;
      for (let j = i - n + 1; j <= i; j++) { sp += pdm[j] || 0; sm += mdm[j] || 0; st += tr[j] || 0; }
      pdi[i] = st === 0 ? 0 : (sp / st) * 100;
      mdi[i] = st === 0 ? 0 : (sm / st) * 100;
      const sum = pdi[i] + mdi[i];
      dx[i] = sum === 0 ? 0 : (Math.abs(pdi[i] - mdi[i]) / sum) * 100;
    }
    // ADX = DX 的 n 周期 Wilder 平均
    let prev = null;
    for (let i = n * 2; i < len; i++) {
      if (prev === null) {
        let s = 0, cnt = 0;
        for (let j = i - n + 1; j <= i; j++) if (dx[j] != null) { s += dx[j]; cnt++; }
        prev = cnt ? s / cnt : 0;
      } else {
        prev = (prev * (n - 1) + dx[i]) / n;
      }
      adx[i] = prev;
    }
    return { pdi, mdi, adx, atr };
  }

  /* ---------- OBV / VR / BIAS ---------- */
  function OBV(c, v) {
    const out = NA(c.length);
    out[0] = 0;
    for (let i = 1; i < c.length; i++) {
      if (c[i] > c[i - 1]) out[i] = out[i - 1] + v[i];
      else if (c[i] < c[i - 1]) out[i] = out[i - 1] - v[i];
      else out[i] = out[i - 1];
    }
    return out;
  }

  function VR(c, v, n = 26) {
    const out = NA(c.length);
    for (let i = n; i < c.length; i++) {
      let up = 0, dn = 0, eq = 0;
      for (let j = i - n + 1; j <= i; j++) {
        if (c[j] > c[j - 1]) up += v[j];
        else if (c[j] < c[j - 1]) dn += v[j];
        else eq += v[j];
      }
      out[i] = dn + eq / 2 === 0 ? 999 : ((up + eq / 2) / (dn + eq / 2)) * 100;
    }
    return out;
  }

  function BIAS(c, n) {
    const ma = SMA(c, n);
    return c.map((v, i) => (ma[i] == null ? null : ((v - ma[i]) / ma[i]) * 100));
  }

  /* ---------- SAR ---------- */
  function SAR(h, l, step = 0.02, max = 0.2) {
    const len = h.length, out = NA(len);
    if (len < 3) return out;
    let bull = h[1] >= h[0];
    let af = step;
    let ep = bull ? h[1] : l[1];
    let sar = bull ? l[0] : h[0];
    out[0] = sar; out[1] = sar;
    for (let i = 2; i < len; i++) {
      sar = sar + af * (ep - sar);
      if (bull) {
        sar = Math.min(sar, l[i - 1], l[i - 2]);
        if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
        if (l[i] < sar) { bull = false; sar = ep; ep = l[i]; af = step; }
      } else {
        sar = Math.max(sar, h[i - 1], h[i - 2]);
        if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
        if (h[i] > sar) { bull = true; sar = ep; ep = h[i]; af = step; }
      }
      out[i] = sar;
    }
    return out;
  }

  /* ---------- ZigZag（摆动点识别，供形态/道氏/波浪/缠论复用） ---------- */
  function ZigZag(data, pct = 0.055) {
    const pts = [];
    const n = data.length;
    if (n < 3) return pts;

    let dir = data[1].c >= data[0].c ? 1 : -1;
    let hiI = 0, hiP = data[0].h;
    let loI = 0, loP = data[0].l;
    let lastI = -1;

    for (let i = 1; i < n; i++) {
      const h = data[i].h, l = data[i].l;
      if (dir === 1) {
        if (h > hiP) { hiP = h; hiI = i; }
        if (l < hiP * (1 - pct)) {
          if (hiI > lastI + 1) { pts.push({ i: hiI, p: hiP, t: 'H' }); lastI = hiI; }
          dir = -1; loP = l; loI = i;
        }
      } else {
        if (l < loP) { loP = l; loI = i; }
        if (h > loP * (1 + pct)) {
          if (loI > lastI + 1) { pts.push({ i: loI, p: loP, t: 'L' }); lastI = loI; }
          dir = 1; hiP = h; hiI = i;
        }
      }
    }
    if (dir === 1) pts.push({ i: hiI, p: hiP, t: 'H', live: true });
    else pts.push({ i: loI, p: loP, t: 'L', live: true });
    return pts;
  }

  /* ---------- 缺口识别 ---------- */
  function gaps(data, minPct = 0.004) {
    const out = [];
    for (let i = 1; i < data.length; i++) {
      const a = data[i - 1], b = data[i];
      if (b.l > a.h && (b.l - a.h) / a.h > minPct) {
        out.push({ i, from: a.h, to: b.l, dir: 1 });
      } else if (b.h < a.l && (a.l - b.h) / a.l > minPct) {
        out.push({ i, from: b.h, to: a.l, dir: -1 });
      }
    }
    return out;
  }

  /* ---------- 箱体 ---------- */
  function boxRange(data, from, to) {
    let hi = -Infinity, lo = Infinity, hiI = from, loI = from;
    for (let i = from; i <= to && i < data.length; i++) {
      if (data[i].h > hi) { hi = data[i].h; hiI = i; }
      if (data[i].l < lo) { lo = data[i].l; loI = i; }
    }
    return { hi, lo, hiI, loI, height: hi - lo };
  }

  /* ---------- 资金流 CMF（Chaikin Money Flow） ----------
   * 用「收盘在当日区间中的位置 × 成交量」衡量资金净流入强度，
   * 不需要 Level-2 数据，A 股日线可直接用，是主力资金流最稳的替代口径。
   */
  function CMF(h, l, c, v, n = 20) {
    const len = c.length, out = NA(len);
    for (let i = n - 1; i < len; i++) {
      let mfv = 0, vol = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const rng = h[j] - l[j];
        const m = rng === 0 ? 0 : ((c[j] - l[j]) - (h[j] - c[j])) / rng;
        mfv += m * (v[j] || 0);
        vol += (v[j] || 0);
      }
      out[i] = vol ? mfv / vol : 0;
    }
    return out;
  }

  /* ---------- 唐奇安通道 ---------- */
  function Donchian(h, l, n = 20) {
    const up = NA(h.length), dn = NA(h.length), mid = NA(h.length);
    for (let i = n - 1; i < h.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (h[j] > hi) hi = h[j];
        if (l[j] < lo) lo = l[j];
      }
      up[i] = hi; dn[i] = lo; mid[i] = (hi + lo) / 2;
    }
    return { up, dn, mid };
  }

  /* ---------- 一目均衡表 ---------- */
  function Ichimoku(h, l, c, t = 9, k = 26, b = 52) {
    const len = c.length;
    const mid = (n) => {
      const o = NA(len);
      for (let i = n - 1; i < len; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - n + 1; j <= i; j++) {
          if (h[j] > hi) hi = h[j];
          if (l[j] < lo) lo = l[j];
        }
        o[i] = (hi + lo) / 2;
      }
      return o;
    };
    const tenkan = mid(t), kijun = mid(k);
    const aRaw = tenkan.map((v, i) => (v == null || kijun[i] == null ? null : (v + kijun[i]) / 2));
    const bRaw = mid(b);
    // 先行带前移 k 根（右侧超出数据末尾的部分不画）
    const shift = (arr, n) => {
      const o = NA(len);
      for (let i = 0; i + n < len; i++) if (arr[i] != null) o[i + n] = arr[i];
      return o;
    };
    const spanA = shift(aRaw, k), spanB = shift(bRaw, k);
    return { tenkan, kijun, spanA, spanB };
  }

  /* ---------- 通达信口径 SMA(X,N,M) ----------
   * 递推式：(M*X + (N-M)*上一值) / N，等价 EMA 且 alpha = M/N。
   * 与上面的简单均线 SMA 完全不同 —— 金坑战法全部用这个口径。
   */
  function TSMA(src, n, m = 1) {
    const out = NA(src.length);
    let prev = null;
    for (let i = 0; i < src.length; i++) {
      const x = src[i] == null ? (prev == null ? 0 : prev) : src[i];
      prev = prev == null ? x : (m * x + (n - m) * prev) / n;
      out[i] = prev;
    }
    return out;
  }

  /* ---------- 通达信 DMA(X,A)：动态移动平均 ----------
   * A 为平滑系数，A 越大越贴近当期值。原文用它做「偏离越大越迟钝」的自适应均线。
   */
  function DMA(src, alpha) {
    const out = NA(src.length);
    let prev = null;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (x == null) { out[i] = prev; continue; }
      const a = Math.max(0, Math.min(1, alpha[i] == null ? 0.5 : alpha[i]));
      prev = prev == null ? x : a * x + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }

  /* ---------- 威廉指标：0 在区间最高，100 在区间最低 ---------- */
  function WILLR(h, l, c, n = 60) {
    const out = NA(c.length);
    for (let i = n - 1; i < c.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (h[j] > hi) hi = h[j];
        if (l[j] < lo) lo = l[j];
      }
      out[i] = hi === lo ? 50 : (hi - c[i]) / (hi - lo) * 100;
    }
    return out;
  }

  /* ---------- 通达信口径 RSI（SMA 平滑，非 Wilder） ---------- */
  function RSI_CN(close, n = 3) {
    const up = close.map((v, i) => (i ? Math.max(v - close[i - 1], 0) : 0));
    const ab = close.map((v, i) => (i ? Math.abs(v - close[i - 1]) : 0));
    const su = TSMA(up, n, 1), sa = TSMA(ab, n, 1);
    return su.map((v, i) => (sa[i] ? (v / sa[i]) * 100 : 50));
  }

  /* ---------- 双平滑动量 MOMI（三把锁第一把） ----------
   * 原文：MOMI:=100*EMA(EMA(MOM,6),6)/EMA(EMA(ABS(MOM),6),6);
   * 分子是涨跌额的双重 EMA，分母是同口径的绝对值，比值天然落在 -100~100，
   * 与 RSI 同类，但连做两次 EMA 后更钝：它不抢反弹的第一根，要等动量真的翻上来。
   * 这正是「低吸」需要的性格——早一步是接飞刀，晚一步才算拐点确认。
   */
  function MOMI(close, n = 6) {
    const mom = close.map((c, i) => (i ? c - close[i - 1] : 0));
    const num = EMA(EMA(mom, n), n);
    const den = EMA(EMA(mom.map((v) => Math.abs(v)), n), n);
    const v = num.map((x, i) => (den[i] > 0 ? (100 * x) / den[i] : 0));
    return { v, ma3: SMA(v, 3) };
  }

  /* ---------- 累计成交均价（自数据起点，近似市场平均成本） ---------- */
  /* 累计成交均价（VWAP）
   * win 省略/0 = 从上市起累计（通达信原口径）；
   * 指数历史长达数十年，累计值会收敛成一条几乎不动的直线，
   * 因此指数传入有限窗口，保持「长期均价」的含义又不会失效。 */
  function VWAP(c, v, win) {
    const out = NA(c.length);
    let pv = 0, vv = 0;
    const buf = [];
    for (let i = 0; i < c.length; i++) {
      const vol = v[i] || 0;
      pv += c[i] * vol;
      vv += vol;
      if (win > 0) {
        buf.push([c[i], vol]);
        if (buf.length > win) {
          const old = buf.shift();
          pv -= old[0] * old[1];
          vv -= old[1];
        }
      }
      out[i] = vv ? pv / vv : c[i];
    }
    return out;
  }

  /* ---------- 简谐振荡器（SHO / SHI） ---------- */
  // 跳过 null 的 EMA：SHO 的一阶/二阶差分前两项是空的，普通 EMA 会被 NaN 污染
  function emaSkipNull(src, n) {
    const out = NA(src.length);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null || !isFinite(v)) { out[i] = prev; continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /**
   * Simple Harmonic Oscillator — Akram El Sherbini, IFTA Journal 2018《Time Cycle Oscillators》
   * 把价格视作简谐运动：a = -ω²x  ⇒  周期 T ∝ √|位移/加速度|
   *   vt = ΔC（速度）      at = Δvt（加速度）      a = EMA(at, n)
   *   Tt = √|vt / a|        Ti = sign(vt) · Tt
   *   SHO = EMA(Ti, n) / EMA(Tt, n) × 100   →  -100 ~ +100
   * 0 轴 = 多空周期均衡；±40 常规超买超卖；±60 周期极端失衡。
   * SHI（简谐指数）= EMA(Ti, n)，未归一化，这里作为 vp 一并返回。
   */
  function SHO(C, n) {
    n = n || 14;
    const m = C.length;
    const vt = NA(m), at = NA(m);
    for (let i = 1; i < m; i++) {
      vt[i] = C[i] - C[i - 1];
      if (i >= 2) at[i] = vt[i] - vt[i - 1];
    }
    const ea = emaSkipNull(at, n);
    const Tt = NA(m), Ti = NA(m);
    for (let i = 1; i < m; i++) {
      const a = ea[i], d = vt[i];
      if (a == null || d == null) continue;
      if (Math.abs(a) < 1e-9) continue;
      const t = Math.sqrt(Math.abs(d / a));
      if (!isFinite(t)) continue;
      Tt[i] = t;
      Ti[i] = d > 0 ? t : -t;
    }
    const VP = emaSkipNull(Ti, n);          // 变量周期（带方向）
    const TP = emaSkipNull(Tt, n);          // 总周期（恒正）
    const sho = NA(m);
    for (let i = 0; i < m; i++) {
      if (VP[i] == null || TP[i] == null || !TP[i]) continue;
      sho[i] = Math.max(-100, Math.min(100, (VP[i] / TP[i]) * 100));
    }
    return { sho, vp: VP, tp: TP };
  }

  /* ---------- 涨停回踩 20 日线：振幅强度 / 涨幅加速（来源：桔子写指标 2026-11-10） ----------
   * 原文（通达信）：
   *   均价     := AMOUNT/VOL/100                      当日成交均价（VWAP）
   *   振幅幅度 := MAX(|HIGH-均价|, |均价-LOW|)
   *   价格偏离 := |(OPEN+CLOSE)/2 - 均价|
   *   振幅强度 := (振幅幅度+价格偏离)/均价*50          单位：偏离百分比的 2 倍
   *   当日振幅 := (HIGH-LOW)/LOW*100
   *   预期振幅 := 2*REF(振幅,1) - REF(振幅,2)          用前两日的振幅变化外推
   *   涨幅加速 := C/REF(C,1)-1 > 预期振幅 AND MA(C,20)>REF(MA(C,20),1)
   *
   * 原文这里左右量纲不一致：左边是小数（涨 5% 得 0.05），右边是百分数（5.0），
   * 0.05 > 5 永不成立 →「涨幅加速」恒假 → 选股结果永远为空。本实现统一成百分数。
   */
  function AMP(o, c, h, l, v, amount, ma20) {
    const n = c.length;
    const vwap = NA(n), ampStr = NA(n), ampPct = NA(n), expAmp = NA(n);
    const accel = new Array(n).fill(false);
    const fiveAccel = new Array(n).fill(false);
    const no3up = new Array(n).fill(true);       // REF(COUNT(C>O,3)>=3,1)=0
    const noGapHigh = new Array(n).fill(true);   // COUNT(O=H,5)=0
    for (let i = 0; i < n; i++) {
      const vol = v[i] || 0;
      const amt = amount ? (amount[i] || 0) : 0;
      // 原文 AMOUNT/VOL/100：VOL 单位是「手」，故 amount/(vol*100) 得到元/股
      vwap[i] = (amt > 0 && vol > 0) ? amt / (vol * 100) : (o[i] + c[i] + h[i] + l[i]) / 4;
      if (l[i] > 0) ampPct[i] = (h[i] - l[i]) / l[i] * 100;

      if (vwap[i] > 0) {
        const body = Math.max(Math.abs(h[i] - vwap[i]), Math.abs(vwap[i] - l[i]));
        const dev = Math.abs((o[i] + c[i]) / 2 - vwap[i]);
        ampStr[i] = (body + dev) / vwap[i] * 50;
      }
      if (i >= 2 && ampPct[i - 1] != null && ampPct[i - 2] != null) {
        expAmp[i] = ampPct[i - 1] + (ampPct[i - 1] - ampPct[i - 2]);
      }
      if (i >= 1 && c[i - 1] > 0 && expAmp[i] != null
        && ma20 && ma20[i] != null && ma20[i - 1] != null) {
        accel[i] = (c[i] / c[i - 1] - 1) * 100 > expAmp[i] && ma20[i] > ma20[i - 1];
      }
      if (i >= 4) {
        for (let k = i - 4; k <= i; k++) if (accel[k]) { fiveAccel[i] = true; break; }
        let up = 0;
        for (let k = i - 3; k <= i - 1; k++) if (c[k] > o[k]) up++;
        no3up[i] = up < 3;
        for (let k = i - 4; k <= i; k++) {
          // 「开盘即最高」按 0.005 元或 0.05%（取大）：指数上万点时绝对 5 分钱没有意义
          if (h[k] > 0 && (h[k] - o[k]) <= Math.max(0.005, h[k] * 0.0005)) { noGapHigh[i] = false; break; }
        }
      }
    }
    return { vwap, ampStr, ampPct, expAmp, accel, fiveAccel, no3up, noGapHigh };
  }

  /* ---------- 威科夫：努力 vs 结果 ----------
   * 努力（effort）= 当日成交量 / 20 日均量，横轴意义上的「投入」
   * 结果（result）= 当日价格进展 / ATR20，纵轴意义上的「产出」
   * 努力大而结果小 = 有人在吸收（吸筹）或在派发；努力小而结果大 = 趋势轻快。
   * 两者都是无量纲比值，可同轴对比。
   */
  function WY(v, c, atr) {
    const n = c.length;
    const vma = SMA(v, 20);
    const effort = NA(n), result = NA(n);
    for (let i = 0; i < n; i++) {
      if (vma[i] > 0) effort[i] = v[i] / vma[i];
      if (i > 0 && atr[i] > 0) result[i] = Math.abs(c[i] - c[i - 1]) / atr[i];
      else if (i > 0) result[i] = 0;
    }
    return { effort, result, vma };
  }

  /* ---------- 二买：五日急跌后的强势反击（公众号「桔子写指标」《把二买做稳做精》） ----------
   * 原文（通达信）逐行对应：
   *   WJRDS := (REF(C,5)-C)/REF(C,5)*100>5;                        五日急跌
   *   JDCHF := FILTER(WJRDS,10);                                   10 根内只认第一次
   *   JJD   := BARSLAST(JDCHF);                                    距急跌的根数
   *   JDQG  := MAX(MAX(REF(H,JJD+2),REF(H,JJD+1)),REF(H,JJD));     阶段前高（信号根及前两根）
   *   DRDZ  := (C-REF(C,1))/REF(C,1)*100>3;
   *   JDZ150:= JJD<150;                                            结构不能太旧
   *   KJQG  := (O-JDQG)/JDQG*100<10;                               开盘距前高 <10%
   *   FBWDG := (C-LLV(L,JJD))/LLV(L,JJD)*100<50;                   低点反弹 <50%
   *   WZZFSXZ:=(C-REF(O,5))/REF(O,5)*100<8;
   *   FL    := V>REF(V,1)*1.5;
   *   JXGZ  := CROSS(C,MA5) AND CROSS(C,MA10) AND CROSS(C,MA20) AND MA(C,20)>REF(MA(C,20),1);
   *   信号  := DRDZ AND JDZ150 AND KJQG AND FBWDG AND WZZFSXZ AND FL AND JXGZ;
   *
   * 两点实现说明：
   * ① BARSLAST 在「从未出现过」时通达信返回无效值，这里显式给 null；
   *    JJD=0（急跌当天）原文的 LLV(L,0) 会退化成全历史最低价，天然不成立，这里同样排除。
   * ② dropPct / jumpPct 可外部传入。指数日波动只有个股 1/3，绝对阈值需按 idxK 折算，
   *    个股走默认值，口径与原文完全一致。
   */
  function ERM(O, C, H, L, V, ma5, ma10, ma20, opt) {
    const n = C.length;
    const o = opt || {};
    const dropTh = o.dropPct != null ? o.dropPct : 5;
    const jumpTh = o.jumpPct != null ? o.jumpPct : 3;
    const bool = () => new Array(n).fill(false);

    const R = {
      drop: bool(), sig: bool(),                       // 急跌原始信号 / FILTER 后
      jjd: NA(n), qg: NA(n),                           // 距急跌根数 / 阶段前高
      gapPct: NA(n), fivePct: NA(n), rebound: NA(n),   // 距前高% / 5日涨幅% / 距低点反弹%
      chgPct: NA(n), volRatio: NA(n),
      cDr: bool(), cJd: bool(), cKj: bool(), cFb: bool(),
      cWz: bool(), cFl: bool(), cJx: bool(), hit: bool(),
    };

    for (let i = 1; i < n; i++) {
      R.chgPct[i] = C[i - 1] ? (C[i] / C[i - 1] - 1) * 100 : 0;
      R.volRatio[i] = V[i - 1] ? V[i] / V[i - 1] : null;
    }
    for (let i = 5; i < n; i++) {
      if (C[i - 5] > 0) R.drop[i] = (C[i - 5] - C[i]) / C[i - 5] * 100 > dropTh;
    }

    let lastSig = -1;
    let low = Infinity;                                // LLV(L, JJD)：信号根至今的最低
    for (let i = 0; i < n; i++) {
      // FILTER(WJRDS, 10)：同一个急跌结构 10 根内只报一次
      if (R.drop[i] && i - lastSig >= 10) { R.sig[i] = true; lastSig = i; }
      if (lastSig < 0) continue;

      if (R.sig[i] || L[i] < low) low = L[i];
      const jjd = i - lastSig;
      R.jjd[i] = jjd;

      // 阶段前高：急跌信号那根与之前两根的最高价（急跌起点）
      let qg = -Infinity;
      for (let k = Math.max(0, lastSig - 2); k <= lastSig; k++) if (H[k] > qg) qg = H[k];
      if (!(qg > 0)) continue;
      R.qg[i] = qg;

      if (i < 5) continue;
      R.gapPct[i] = (O[i] - qg) / qg * 100;
      R.fivePct[i] = O[i - 5] > 0 ? (C[i] - O[i - 5]) / O[i - 5] * 100 : null;
      R.rebound[i] = low > 0 ? (C[i] - low) / low * 100 : null;

      R.cDr[i] = R.chgPct[i] != null && R.chgPct[i] > jumpTh;
      R.cJd[i] = jjd >= 1 && jjd < 150;
      R.cKj[i] = R.gapPct[i] != null && R.gapPct[i] < 10;
      R.cFb[i] = R.rebound[i] != null && R.rebound[i] < 50;
      R.cWz[i] = R.fivePct[i] != null && R.fivePct[i] < 8;
      R.cFl[i] = R.volRatio[i] != null && R.volRatio[i] > 1.5;

      const m5 = ma5[i], m10 = ma10[i], m20 = ma20[i];
      const p5 = ma5[i - 1], p10 = ma10[i - 1], p20 = ma20[i - 1];
      R.cJx[i] = m5 != null && m10 != null && m20 != null
        && p5 != null && p10 != null && p20 != null
        && C[i] > m5 && C[i - 1] <= p5
        && C[i] > m10 && C[i - 1] <= p10
        && C[i] > m20 && C[i - 1] <= p20
        && m20 > p20;

      R.hit[i] = R.cDr[i] && R.cJd[i] && R.cKj[i] && R.cFb[i]
        && R.cWz[i] && R.cFl[i] && R.cJx[i];
    }
    return R;
  }

  /* ---------- SKDJ 慢速随机 · 超卖反弹强弱 ----------
   * 口径（通达信 SKDJ）：RSV(9) → SMA(·,3,1) 得 K1 → 再 SMA 一次得慢速 K → D 对慢速 K 再平滑。
   * 比 KDJ 慢一档，单根抖动被抹平，专门用来判断「这一波反弹到底有没有力度」。
   *
   * 事件模型：一次「K 跌破 20 的超卖段 → 低位金叉」记为一次反弹事件。
   * 对每个事件量化三件事：K 抬升了多少点、价格自低点反弹了多少、量能跟不跟得上。
   * 三样都够 = 有资金接手，底部大概率成立；只有 K 抬了一点、价格与量能没反应 = 弱反抽，
   * 按经验后面还有一跌 —— 这正是把它做成流派的理由，它同时能标「假底」。
   */
  function SKDJ(H, L, C, V, ma20, opt) {
    const n = C.length;
    const o = opt || {};
    const N1 = o.n || 9;
    const osTh = o.osTh != null ? o.osTh : 20;
    const win = o.win || 25;          // 一次反弹的观察窗口（根）
    // 价格百分比的周期折算：周线一根 ≈ 5 个交易日，月线 ≈ 21 个
    const pxScale = o.pxScale || 1;
    // 「波段窗口」也按周期折算：月线 40 根是三年多，那时候的反弹跟现在没关系了
    const ageMax = o.ageMax || 40;

    const rsv = NA(n), K = NA(n), D = NA(n);
    let p1 = 50, p2 = 50, p3 = 50;
    for (let i = 0; i < n; i++) {
      if (i < N1 - 1) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - N1 + 1; j <= i; j++) {
        if (H[j] > hi) hi = H[j];
        if (L[j] < lo) lo = L[j];
      }
      rsv[i] = hi === lo ? 50 : ((C[i] - lo) / (hi - lo)) * 100;
      p1 = (rsv[i] + 2 * p1) / 3;
      p2 = (p1 + 2 * p2) / 3;
      p3 = (p2 + 2 * p3) / 3;
      K[i] = p2; D[i] = p3;
    }

    /** 超卖段（谷底之前 10 根）的平均量：代表「下跌时的正常量」，用来衡量反弹放没放量 */
    function volBase(t) {
      let s = 0, c = 0;
      for (let j = Math.max(0, t - 9); j <= t; j++) if (V[j] != null) { s += V[j]; c++; }
      return c ? s / c : null;
    }

    /** 事件进行到 end 根时的状态快照 */
    function snap(e, end) {
      let kMax = -Infinity, pxMax = -Infinity, lowMin = Infinity, lowIdx = -1;
      let vSum = 0, vCnt = 0, hitMa20 = false;
      for (let j = e.s; j <= end; j++) {
        if (K[j] > kMax) kMax = K[j];
        if (C[j] > pxMax) pxMax = C[j];
        if (j > e.tIdx && L[j] < lowMin) { lowMin = L[j]; lowIdx = j; }
        if (V[j] != null) { vSum += V[j]; vCnt++; }
        if (ma20 && ma20[j] != null && C[j] > ma20[j]) hitMa20 = true;
      }
      const kn = K[end], dn = D[end];
      const volR = e.vb && vCnt ? (vSum / vCnt) / e.vb : null;
      const kJump = kMax - e.tK;
      const pxReb = e.tC > 0 ? (pxMax - e.tC) / e.tC * 100 : null;   // 这波的最大反弹幅度
      const pxNow = e.tC > 0 ? (C[end] - e.tC) / e.tC * 100 : null;  // 当前相对谷底的涨幅
      // 回吐比例：涨上去又还回来多少。0 = 仍在高点，1 = 全部还回去
      const giveBack = pxMax > e.tC ? (pxMax - C[end]) / (pxMax - e.tC) : 0;
      // 0.5% 容差：低价股上 0.1% 只有几分钱，正常回踩就会被判成破底
      const newLow = lowMin < e.tL * 0.995;

      /* 强度 0~100。权重分配的关键：K 抬升与 K 位置本质是同一件事（K 现在多高），
       * 合计只给 40 分；价格反弹与量能才是「资金有没有真进来」的直接证据，占 40 分。
       * 反弹没让价格涨、也没放量的，最后再整体乘一个折扣 —— 那是时间修复，不是资金推动。 */
      let st = 0;
      if (kJump >= 30) st += 24;
      else if (kJump >= 20) st += 19;
      else if (kJump >= 12) st += 12;
      else if (kJump >= 6) st += 6;

      if (kn >= 50) st += 16;
      else if (kn >= 40) st += 11;
      else if (kn >= 30) st += 6;
      else if (kn >= 20) st += 2;

      /* 用「当前涨幅」分档，不用历史峰值：涨到 +40% 又全跌回来，不代表现在是强势。
       * 阈值乘 pxScale 适配周期 —— 月线一根 K 线动 10% 是常态，套日线的 10% 门槛会全员满分。 */
      const pxs = pxNow == null ? null : pxNow / e.pxScale;
      if (pxs != null) {
        if (pxs >= 10 && pxs <= 20) st += 24;
        else if (pxs > 20 && pxs <= 26) st += 15;   // 已经走掉一大段，追进去的性价比在下降
        else if (pxs > 26) st += 8;                  // 波段涨幅透支
        else if (pxs >= 6) st += 17;
        else if (pxs >= 3) st += 10;
        else if (pxs >= 1) st += 4;
      }
      // 涨上去又还回来一半以上：这波反弹实质已经结束。
      // 只在「本来涨得够多」时才判（涨 3% 回吐 2% 不算，那只是日常波动）。
      if (giveBack >= 0.5 && pxReb != null && pxReb >= 8 * e.pxScale) st -= 10;

      if (volR != null) {
        if (volR >= 1.3) st += 16;
        else if (volR >= 1.0) st += 10;
        else if (volR >= 0.8) st += 4;
        else st -= 8;                                    // 缩量反弹：没有增量资金，持续性存疑
      }

      if (ma20 && ma20[end] != null && C[end] > ma20[end]) st += 14;
      else if (hitMa20) st += 7;

      if (D[end - 1] != null && dn > D[end - 1]) st += 6;

      // 价格确认：反弹期间价格几乎没动，整体降权
      if (pxs == null || pxs < 1.5) st *= 0.5;
      else if (pxs < 3) st *= 0.75;
      else if (pxs < 6) st *= 0.9;

      if (newLow) st -= 18;

      // 反弹熄火：K 从阶段高点回落 12 点以上且重新压到 D 之下
      const fade = kJump > 8 && (kMax - kn) > 12 && kn < dn;
      if (fade) st -= 8;

      // 「破底」分两个口径：
      //   broken     —— 评分用，宽口径。K 抬升 15 点以上（低位横盘时 K 会被时间修复推上去）
      //                 或价格涨过 2%，之后又跌破谷底，就算「弱反弹后继续破位」。
      //   brokenMark —— 画图用，严口径。必须价格真的反弹过 3% 再破，才值得在 K 线上标出来，
      //                 否则下跌趋势里几乎每波都标一次，图会被糊住。
      const broken = newLow && ((pxReb != null && pxReb >= 2 * e.pxScale) || kJump >= 15);
      const brokenMark = newLow && pxReb != null && pxReb >= 3 * e.pxScale && kJump >= 15;

      return {
        kMax, kn, dn, kJump, pxReb, pxNow, giveBack, volR, hitMa20, newLow, broken, brokenMark, fade, pxMax, lowMin, lowIdx,
        strength: Math.max(0, Math.min(100, Math.round(st))),
      };
    }

    /* ---- 超卖段 → 低位金叉 事件扫描 ---- */
    const ev = [];
    let inOS = false, osStart = -1, tK = 99, tIdx = -1, tC = 0, tL = 0;
    let lastS = -99;

    for (let i = N1; i < n; i++) {
      if (K[i] == null || D[i] == null) continue;

      if (K[i] < osTh) {
        if (!inOS) { inOS = true; osStart = i; tK = K[i]; tIdx = i; tC = C[i]; tL = L[i]; }
        else if (K[i] < tK) { tK = K[i]; tIdx = i; tC = C[i]; tL = L[i]; }
      } else if (inOS && i - osStart > 40) {
        inOS = false;                 // 超卖后 40 根都没走出金叉，这一段作废
      }

      const gold = K[i - 1] != null && D[i - 1] != null && K[i - 1] <= D[i - 1] && K[i] > D[i];
      // 谷底到金叉不超过 20 根：再远就说明 K 早已修复完，这次金叉是高位波动，不是超卖反弹
      if (gold && inOS && i - lastS >= 8 && i - tIdx <= 20) {
        ev.push({ s: i, tIdx, tK, tC, tL, vb: volBase(tIdx), pxScale: pxScale });
        lastS = i;
        inOS = false;                 // 本次超卖段结束，下一次跌破 20 重新计数
      }
    }

    /* ---- 每个事件按固定窗口定稿（给历史标记用） ---- */
    for (let q = 0; q < ev.length; q++) {
      const e = ev[q];
      e.prev = q > 0 ? ev[q - 1] : null;
      const end = Math.min(n - 1, e.s + win);
      const st = snap(e, end);
      e.end = end;
      Object.assign(e, st);
      e.broken = st.broken;            // 防守位是否还画，看宽口径
      e.brokenMark = st.brokenMark;    // 图上标不标「破底」，看严口径
      e.label = st.brokenMark ? '破底' : (st.strength >= 62 ? '强反' : '弱反');
      // 二次探底背离：价格底与 K 底同时抬高
      // 要求价格底抬高 2%、K 底抬高 3 点以上才算背离：0.3 点的差距是噪音，不是信号
      e.diverge = !!(e.prev && e.prev.tC > 0
        && e.tC > e.prev.tC * 1.02 && e.tK > e.prev.tK + 3);
    }

    const last = ev.length ? ev[ev.length - 1] : null;
    const cur = last ? Object.assign(snap(last, n - 1), { age: n - 1 - last.s }) : null;

    return { k: K, d: D, rsv, ev, last, cur, osTh, win, ageMax, pxScale };
  }

  /* ---------- SuperTrend · ATR 通道趋势跟踪 ----------
   * 原文规则：价格上下各挂一条 3 倍 ATR 的线，收盘升破上线翻多、跌破下线翻空，次日开盘执行。
   * 真正的机制不是那两条线，而是「只往持仓方向收」的棘轮（ratchet）：
   * 多头时下轨只上不下，价格回踩不破就继续拿着，所以趋势里拿得住；
   * 代价是窄幅来回时轨道贴着价格走，被反复穿越，小亏一串。
   *
   * 下面除了轨道本身，还算三件原文点明的副作用，评分直接用：
   *   age   当前趋势已经走了几根（太短 = 刚翻转，太长 = 末端）
   *   whip  假翻转率（翻转后 ≤3 根又翻回去的比例）—— 震荡市的直接证据
   *   dist  收盘价距趋势线几个 ATR（追高 / 超跌的尺子）
   */
  function SUPERTREND(H, L, C, opt) {
    const n = C.length;
    const o = opt || {};
    const N = o.period || 10;
    const mult = o.mult != null ? o.mult : 3;
    const atr = wilder(TR(H, L, C), N);
    const up = NA(n), dn = NA(n), st = NA(n), dir = NA(n), dist = NA(n);
    const flip = new Array(n).fill(0);
    let start = -1;
    for (let i = 0; i < n; i++) {
      if (atr[i] == null) continue;
      const hl2 = (H[i] + L[i]) / 2;
      const bl = hl2 - mult * atr[i];      // 本根「裸」下轨
      const bu = hl2 + mult * atr[i];      // 本根「裸」上轨
      if (start < 0) { start = i; up[i] = bl; dn[i] = bu; dir[i] = 1; st[i] = bl; continue; }
      // 棘轮：前一根收盘仍在下轨之上，下轨就取 max(裸下轨, 前值)；否则重置为裸下轨
      up[i] = C[i - 1] > up[i - 1] ? Math.max(bl, up[i - 1]) : bl;
      dn[i] = C[i - 1] < dn[i - 1] ? Math.min(bu, dn[i - 1]) : bu;
      // 方向切换用「上一根的轨道」判定，不能用本根：本根轨道已经跟着价格收缩，永远不会被破
      let d = dir[i - 1];
      if (d === -1 && C[i] > dn[i - 1]) d = 1;
      else if (d === 1 && C[i] < up[i - 1]) d = -1;
      dir[i] = d;
      st[i] = d === 1 ? up[i] : dn[i];
      if (d !== dir[i - 1]) flip[i] = d;
      dist[i] = atr[i] > 0 ? (C[i] - st[i]) / atr[i] : null;
    }

    // 趋势年龄（根）与假翻转统计
    const age = NA(n);
    const flipIdx = [];
    for (let i = start; i < n; i++) {
      if (i === start) { age[i] = 1; continue; }
      age[i] = flip[i] ? 1 : (age[i - 1] || 1) + 1;
      if (flip[i]) flipIdx.push(i);
    }
    const seg = flipIdx.map((f, k) => (k + 1 < flipIdx.length ? flipIdx[k + 1] : n) - f);
    const recent = flipIdx.filter(i => i >= n - 250);
    const recentSeg = recent.map(i => {
      let e = n;
      for (const f of flipIdx) if (f > i) { e = f; break; }
      return e - i;
    });
    const whip = recentSeg.length ? recentSeg.filter(x => x <= 3).length / recentSeg.length : 0;

    // 最近一次翻转（多头翻转=翻多）与并列的上一段
    const lastFlip = flipIdx.length ? flipIdx[flipIdx.length - 1] : -1;
    const prevFlip = flipIdx.length > 1 ? flipIdx[flipIdx.length - 2] : -1;

    return {
      atr, up, dn, st, dir, flip, dist, age,
      period: N, mult,
      cur: dir[n - 1],
      curAge: age[n - 1],
      lastFlip, prevFlip,
      flips: recent.length,          // 近 250 根翻转次数
      whip,                          // 假翻转率 0~1
      seg,                           // 每段趋势长度（全部历史）
    };
  }

  /* ---------- 三指标共振灯（MACD + KDJ + RSI）----------
   * 原文规则：
   *   MACD 红绿柱看趋势与动能；KDJ 里 J 最灵敏，J>100 超买、J<0 超卖，金叉偏多、死叉偏空；
   *   RSI >80 偏热、<20 偏冷。三灯同亮果断、两灯一致小试、三灯打架不动。
   *
   * 这里把「灯」统一成做多方向的票：+1 = 支持买，-1 = 支持卖，0 = 不表态。
   * 三个灯加起来 -3~+3，就是原文的「同亮 / 一致 / 打架」三种状态。
   *
   * 做 T 的语境下这套灯是「低吸高抛」而不是「追涨杀跌」：
   * 所以 KDJ 在 J>100 时给的是卖票（-1），哪怕 K 还在 D 上方 —— 原文的超买就是要减。
   *
   * stats 用本标的自己的历史算「三灯同亮之后 3 根涨没涨」，
   * 这是给用户看的唯一硬证据：同一套规则在这只票上到底灵不灵。
   */
  function TRILIGHT(macd, kdj, rsi6, rsi12, C) {
    const n = C.length;
    const L1 = NA(n), L2 = NA(n), L3 = NA(n), sum = NA(n);
    const agree = NA(n), conflict = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      /* ① MACD 灯：DIF 在 DEA 上方 → 多；反之空。
       * 只有柱相对 DIF 小到可以忽略（金叉/死叉的临界瞬间）才不表态。
       * 早先按「柱比前一根缩 70% 就灭灯」判定，会把单边趋势里正常的缩柱
       * 判成「没方向」—— 红柱变短仍然是红柱，动能减弱不等于趋势消失。 */
      const dif = macd.dif[i], dea = macd.dea[i], h0 = macd.hist[i];
      let a = 0;
      if (dif != null && dea != null) {
        a = dif > dea ? 1 : -1;
        if (h0 != null && Math.abs(h0) < C[i] * 0.0005) a = 0;
      }
      L1[i] = a;

      /* ② KDJ 灯：J 的极值优先（原文：J 最灵敏，>100 超买、<0 超卖），
       * 其次看金叉/死叉，最后才退回到 K、D 的相对位置。 */
      const k = kdj.k[i], d = kdj.d[i], j = kdj.j[i];
      let b = 0;
      if (k != null && d != null && j != null) {
        if (j < 0) b = 1;
        else if (j > 100) b = -1;
        else {
          let cross = null;
          for (let t = i; t > Math.max(0, i - 3); t--) {
            if (kdj.k[t - 1] == null || kdj.d[t - 1] == null) continue;
            if (kdj.k[t - 1] <= kdj.d[t - 1] && kdj.k[t] > kdj.d[t]) { cross = 1; break; }
            if (kdj.k[t - 1] >= kdj.d[t - 1] && kdj.k[t] < kdj.d[t]) { cross = -1; break; }
          }
          if (cross) b = cross;
          else if (Math.abs(k - d) < 1.5 && j > 35 && j < 65) b = 0;   // 缠绕区，不表态
          else b = k > d ? 1 : -1;
        }
      }
      L2[i] = b;

      /* ③ RSI 灯：>80 偏热（减）、<20 偏冷（吸），中间以 50 为界，
       * 40~60 是原文说的「不冷不热」，做 T 没有优势，直接不表态。 */
      const r = rsi6[i], r2 = rsi12[i];
      let c = 0;
      if (r != null) {
        if (r >= 80) c = -1;
        else if (r <= 20) c = 1;
        else if (r > 60) c = 1;
        else if (r < 40) c = -1;
        else c = 0;
        // 短/长 RSI 反向时降一级：6 日上、12 日下说明只是反抽
        if (c !== 0 && r2 != null && Math.sign(r - 50) !== Math.sign(r2 - 50)) c = 0;
      }
      L3[i] = c;

      sum[i] = (a || 0) + (b || 0) + (c || 0);
      if (dif == null || k == null || r == null) sum[i] = null;
      // 「打架」必须单独标出来：sum 只有 1 的时候，可能是「两多一空」（friction），
      // 也可能只是「一亮两哑」。原文说打架不动，所以这两种要分开。
      const vs = [a, b, c];
      agree[i] = vs.filter(x => x === 1).length - vs.filter(x => x === -1).length;
      conflict[i] = vs.some(x => x === 1) && vs.some(x => x === -1);
    }

    // 历史验证：三灯同亮之后 3 根的方向命中率（只统计已走完的样本）
    function hit(sign, hold) {
      let cnt = 0, win = 0;
      for (let i = 60; i < n - hold; i++) {
        if (sum[i] !== sign * 3) continue;
        // 同一段信号只算第一次，否则连涨三天会被记成三次成功
        let dup = false;
        for (let t = i - 1; t >= Math.max(0, i - hold); t--) if (sum[t] === sign * 3) { dup = true; break; }
        if (dup) continue;
        cnt++;
        if ((C[i + hold] - C[i]) * sign > 0) win++;
      }
      return { n: cnt, win: cnt ? win / cnt : null };
    }
    const stats = { up: hit(1, 3), dn: hit(-1, 3) };

    // 当前状态
    let lastStrong = -1;
    for (let i = n - 1; i >= Math.max(0, n - 40); i--) if (Math.abs(sum[i] || 0) === 3) { lastStrong = i; break; }

    return { macd: L1, kdj: L2, rsi: L3, sum, agree, conflict, stats, lastStrong };
  }

  /* ---------- 三周期共振（月定空间 / 周定趋势 / 日定买点） ----------
   * 原文（小红书 2026-11-02）四句话：
   *   ① 月线定空间，连续 2 月在 20 线上
   *   ② 周线看趋势，连续 2 周在 20 线上
   *   ③ 日线选买点，在周线趋势后选买点
   *   ④ 选前期周线有倍量堆量标的
   * 评论区那句「成交量还差一点点，下午收盘应该可以＞前三天」是正文没写的第 5 条，
   * 这里按「当日量 > 前 3 日均量」落地 —— 少了量能背书，前三条只是「位置对」，不是「买点」。
   *
   * 两个容易做错的地方，在这里一次性处理掉：
   *   1) 连续根数只数「已收官」的周期。11 月中的月线还没走完，拿它算「连续 2 月」，
   *      月中一根阴线就把条件打回 1 个月，信号会随行情来回跳。所以 streak 走已完成的，
   *      另外单独给 live（本周期至今在不在线上）—— 那才是原文「提前量」的来源。
   *   2) 固定用日线读数再映射到当前显示周期。若直接拿「当前周期」当输入，
   *      周线视图下就会用周线 ma20 去当日线用，月/周/日三层里两层是同一个东西。
   */
  function TRICYCLE(month, week, day, axis, opts) {
    const o = opts || {};
    const D = day || [];
    const AX = (axis && axis.length) ? axis : D;
    const gv = (r, k) => (r == null ? null : (Array.isArray(r) ? r[{ d: 0, o: 1, c: 2, h: 3, l: 4, v: 5 }[k]] : r[k]));

    if (D.length < 25 || !AX.length) {
      return { ok: false, reason: `日线仅 ${D.length} 根（<25），无法计算 20 日均线`, n: AX.length, series: {} };
    }

    const dC = D.map(r => gv(r, 'c'));
    const dV = D.map(r => gv(r, 'v'));
    const dMa = SMA(dC, 20);

    /* 某周期层的读数：连续几根收在 20 均线上 */
    function layerOf(S, minBars) {
      const empty = { ok: false, n: 0, streak: 0, live: false, above: false, ma: null, slope: null, pending: false, reason: '' };
      if (!S || !S.n || !S.ma20) return Object.assign(empty, { reason: '该周期数据缺失' });
      const nn = S.n;
      const lastDay = gv(D[D.length - 1], 'd');
      const pending = S.d[nn - 1] === lastDay;      // 最后一根就是今天 → 还没收官
      const doneN = pending ? nn - 1 : nn;
      const live = S.ma20[nn - 1] != null && S.c[nn - 1] > S.ma20[nn - 1];
      if (doneN < minBars) return Object.assign(empty, { n: doneN, pending, live, reason: `仅 ${doneN} 根已完成（<${minBars}）` });
      let streak = 0;
      for (let k = doneN - 1; k >= 0; k--) {
        if (S.ma20[k] == null) break;
        if (S.c[k] > S.ma20[k]) streak++; else break;
      }
      const ma = S.ma20[doneN - 1], prev = S.ma20[doneN - 5];
      return {
        ok: true, n: doneN, pending, streak, live, above: streak > 0,
        ma, maLive: S.ma20[nn - 1],
        slope: (ma != null && prev != null && prev > 0) ? (ma / prev - 1) * 100 : null,
        lastClose: S.c[doneN - 1],
        reason: '',
      };
    }

    /* 周线倍量堆量：近 12 周里有 ≥2 周的量超过前 4 周均量的 1.8 倍。
     * 原文第 4 条只是「选前期有倍量堆量的标的」，没给阈值；
     * 1.8 倍 + 至少 2 周，是为了把「单根脉冲」和「持续堆量」分开 —— 单根爆量经常是出货。 */
    function pileOf(S) {
      if (!S || !S.n || !S.v || !S.v.length) return { on: false, n: 0, last: -99, span: 0, doneN: 0 };
      const lastDay = gv(D[D.length - 1], 'd');
      const pending = S.d[S.n - 1] === lastDay;
      const doneN = pending ? S.n - 1 : S.n;
      const from = Math.max(4, doneN - 12);
      let cnt = 0, last = -99;
      for (let k = from; k < doneN; k++) {
        let s = 0;
        for (let j = k - 4; j < k; j++) s += (S.v[j] || 0);
        const base = s / 4;
        if (base > 0 && S.v[k] > base * 1.8) { cnt++; last = k; }
      }
      return { on: cnt >= 2, n: cnt, last, span: doneN - from, doneN };
    }

    /* ---------- 日线量能：当日量 / 前 3 日均量（不含当日，避免自己除自己） ---------- */
    const vma3 = NA(D.length), vR = NA(D.length);
    for (let i = 3; i < D.length; i++) {
      const a = dV[i - 1], b = dV[i - 2], c = dV[i - 3];
      if (a > 0 && b > 0 && c > 0) vma3[i] = (a + b + c) / 3;
    }
    for (let i = 0; i < D.length; i++) if (dV[i] > 0 && vma3[i]) vR[i] = dV[i] / vma3[i];

    /* ---------- 日线买点：原文只说「选买点」，三种形态是把它变成可执行条件 ----------
     * A 缩量回踩企稳：最低价摸到 20 线上方 2% 以内、收盘站回线上、且不放量
     *   —— 回踩放量说明是在杀，不是在洗。
     * B 放量启动：量超前 3 日均量 1.5 倍 + 收阳 + 站上 20 线
     * C 跳空倍量回踩：近 5 根出现「高开 0.5% + 量超 2 倍」，当下又回到 20 线上方 0~4%
     */
    const PULL = new Array(D.length).fill(false);
    const LAUNCH = new Array(D.length).fill(false);
    const GAPV = new Array(D.length).fill(false);
    const BUY = new Array(D.length).fill(false);
    const KIND = new Array(D.length).fill('');

    for (let i = 3; i < D.length; i++) {
      const ma = dMa[i]; if (ma == null) continue;
      const c = dC[i], oo = gv(D[i], 'o'), lo = gv(D[i], 'l'), r = vR[i];
      if (lo <= ma * 1.02 && c > ma && c >= oo * 0.998 && r != null && r <= 1.2) PULL[i] = true;
      if (c > oo && c > ma && r != null && r >= 1.5) LAUNCH[i] = true;
      if (oo > dC[i - 1] * 1.005 && r != null && r >= 2) GAPV[i] = true;
    }
    for (let i = 3; i < D.length; i++) {
      const ma = dMa[i]; if (ma == null) continue;
      const dev = (dC[i] - ma) / ma * 100;
      let g = -1;
      for (let k = Math.max(3, i - 5); k <= i; k++) if (GAPV[k]) { g = k; break; }
      const gapBack = g >= 0 && dev >= -1 && dev <= 4;
      let kind = '';
      if (LAUNCH[i]) kind = 'launch';
      else if (gapBack) kind = 'gapback';
      else if (PULL[i]) kind = 'pull';
      if (kind) { BUY[i] = true; KIND[i] = kind; }
    }

    /* ---------- 映射到当前显示周期（axis）----------
     * axis 的每一根取「日期 ≤ 它的最后一根日线」的状态。
     * 这样周/月视图下不会错位，也不需要第二套算法。 */
    const lastAtOrBefore = (S, d) => {
      if (!S || !S.n || !S.d) return -1;
      let lo = 0, hi = S.n - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (S.d[mid] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    const jIdx = new Array(AX.length).fill(-1);
    let ptr = -1;
    for (let i = 0; i < AX.length; i++) {
      const d = gv(AX[i], 'd');
      while (ptr + 1 < D.length && gv(D[ptr + 1], 'd') <= d) ptr++;
      jIdx[i] = ptr;
    }

    const lvl = NA(AX.length), devA = NA(AX.length), volA = NA(AX.length);
    const buyA = new Array(AX.length).fill(false), kindA = new Array(AX.length).fill('');
    for (let i = 0; i < AX.length; i++) {
      const d = gv(AX[i], 'd'), j = jIdx[i];
      const mi = lastAtOrBefore(month, d), wi = lastAtOrBefore(week, d);
      let s = 0, has = 0;
      if (mi >= 0 && month && month.ma20 && month.ma20[mi] != null) { has++; if (month.c[mi] > month.ma20[mi]) s++; }
      if (wi >= 0 && week && week.ma20 && week.ma20[wi] != null) { has++; if (week.c[wi] > week.ma20[wi]) s++; }
      if (j >= 0 && dMa[j] != null) {
        has++;
        if (dC[j] > dMa[j]) s++;
        devA[i] = (dC[j] - dMa[j]) / dMa[j] * 100;
      }
      if (j >= 0 && vR[j] != null) volA[i] = vR[j];
      lvl[i] = has === 3 ? s : null;
      if (j >= 0 && BUY[j]) { buyA[i] = true; kindA[i] = KIND[j]; }
    }

    /* 最近一次买点在第几根日线（新鲜度：5 根前的买点不能当今天的买点用） */
    let lastBuy = -1;
    for (let i = D.length - 1; i >= Math.max(0, D.length - 20); i--) if (BUY[i]) { lastBuy = i; break; }

    const L = D.length - 1;
    return {
      ok: true, period: o.period || 'day', n: AX.length,
      m: layerOf(month, 24), w: layerOf(week, 24), pile: pileOf(week),
      d: {
        ok: dMa[L] != null,
        ma: dMa[L], dev: devA[AX.length - 1], volR: vR[L], volMa3: vma3[L],
        pull: PULL[L], launch: LAUNCH[L], gapv: GAPV[L],
        buy: BUY[L], kind: KIND[L],
        lastBuy, buyAge: lastBuy >= 0 ? L - lastBuy : -1,
        lastKind: lastBuy >= 0 ? KIND[lastBuy] : '',
      },
      level: lvl[AX.length - 1],
      series: { level: lvl, dev: devA, volR: volA, buy: buyA, kind: kindA },
    };
  }

  /* ---------- 区间分位（0~100） ---------- */
  function rankPct(src, i, n) {    const from = Math.max(0, i - n + 1);
    const v = src[i];
    if (v == null) return null;
    let less = 0, total = 0;
    for (let j = from; j <= i; j++) {
      if (src[j] == null) continue;
      total++;
      if (src[j] < v) less++;
    }
    return total ? (less / total) * 100 : null;
  }

  const API = {
    SMA, EMA, wilder, STD, HHV, LLV, MACD, KDJ, RSI, BOLL, CCI,
    TR, DMI, OBV, VR, BIAS, SAR, ZigZag, gaps, boxRange,
    CMF, Donchian, Ichimoku, rankPct,
    TSMA, DMA, WILLR, RSI_CN, VWAP,
    SLOPE, TFMA, SHO, AMP, WY, ERM, SKDJ, SUPERTREND, TRILIGHT, TRICYCLE, MOMI,
  };

  global.QLInd = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
