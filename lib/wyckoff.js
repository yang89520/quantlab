'use strict';
/**
 * 威科夫结构识别（纯函数，无 IO）
 *
 * 目的：把「量价体检」里可计算的部分固化下来，让平台能对任意标的、任意时点
 * 复现同一套读数 —— 而不是每次靠人肉看盘或让模型即兴解释。
 *
 * 三层的边界必须说清楚：
 *   1. 特征层（features）：全部客观可算，无歧义（相关系数、天数、位置、倍数）
 *   2. 事件层（events）：基于阈值规则的结构形态（spring / upthrust / SOS / SOW / test）
 *   3. 判读层（phase）：四阶段的启发式标签，**永远带 confidence，不许当结论用**
 *
 * 这里刻意不做的事：
 *   - 不推断「主力意图」「庄家在吸筹」。量价只能显示「谁在成交」，显示不了「谁是谁」。
 *   - 不给买卖点、目标价、止损位。结构标签是观察线索，不是交易信号。
 *   - 不猜缺失数据。K 线不够就返回 insufficient_data，不补齐、不外推。
 *
 * 阈值全部集中在 RULES 里，改了要同步 tests/unit/wyckoff.test.js 的用例。
 */

/** 经验阈值。来源：威科夫原著的形态定义 + 本平台 6 年样本的分布校准，属于「可调参数」而非定律。 */
const RULES = {
  swingLeft: 2,             // 摆动点：左侧 2 根
  swingRight: 2,            // 右侧 2 根（必须等右侧走完才算确认，因此最新 2 根不出摆动点）
  swingLookback: 60,        // 只在近 60 根里找，避免十年前的极值干扰
  breakoutPct: 0.3,         // 突破/跌破的确认幅度（%），滤掉一分钱插针
  springWindow: 3,          // spring 后几根内收回算有效
  testWindow: [3, 10],      // test 出现在 spring 之后第 3~10 根
  testVolRatio: 0.75,       // test 当天量 / spring 当天量 低于此值 = 抛压枯竭
  sosPct: 3.0,              // SOS 单日涨幅下限（%）
  sosVolRatio: 1.5,         // SOS 当日量 / 前 20 日均量 下限
  sowPct: -3.0,
  sowVolRatio: 1.5,
  volExpand: 1.3,           // 「放量」判定：5 日均量 / 60 日均量
  volContract: 0.85,        // 「缩量」判定
  posHigh: 75,              // 120 日区间位置高分位
  posLow: 25,
};

const DISCLAIMER = '以上为公开行情的客观统计与规则化标注，属概率性结构描述，不构成投资建议，不含买卖点、目标价与仓位建议。';

/* ---------------- 基础工具 ---------------- */

/** 数组行 [d,o,c,h,l,v,a] → 对象行。兼容两种输入，调用方不必关心。 */
function normalizeBars(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    if (Array.isArray(r)) {
      const [d, o, c, h, l, v, a] = r;
      if (!d || ![o, c, h, l, v].every((x) => Number.isFinite(Number(x)))) continue;
      out.push({ d: String(d), o: +o, c: +c, h: +h, l: +l, v: +v, a: +a || 0 });
    } else if (r.d) {
      out.push({ d: String(r.d), o: +r.o, c: +r.c, h: +r.h, l: +r.l, v: +r.v, a: +r.a || 0 });
    }
  }
  // 升序 + 去重（同一天只保留最后一条，上游拼接时偶发重复）
  out.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  const uniq = [];
  for (const b of out) {
    if (uniq.length && uniq[uniq.length - 1].d === b.d) uniq[uniq.length - 1] = b;
    else uniq.push(b);
  }
  return uniq;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(-n));
  const my = mean(ys.slice(-n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[xs.length - n + i] - mx;
    const b = ys[ys.length - n + i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!dx || !dy) return null;
  return Math.round((num / Math.sqrt(dx * dy)) * 1000) / 1000;
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/* ---------------- 1. 特征层 ---------------- */

function features(bars) {
  const n = bars.length;
  if (n < 30) {
    return { ok: false, reason: `有效 K 线仅 ${n} 根，少于 30 根无法做量价统计`, bars: n };
  }
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);
  const pcts = bars.map((b, i) => {
    if (b.o > 0) return ((b.c / b.o) - 1) * 100;
    return i ? ((b.c / bars[i - 1].c) - 1) * 100 : 0;
  });

  const w20 = Math.min(20, n);
  const w60 = Math.min(60, n);
  const avg20 = (i) => mean(vols.slice(Math.max(0, i - 20), i));   // 前 20 日均量（不含当日）
  const ratios = bars.map((b, i) => {
    const m = avg20(i);
    return m ? b.v / m : null;
  });

  // 放量上涨 / 放量下跌：当日涨跌 ≥1% 且量比 ≥1.5
  const countDays = (from) => {
    let up = 0, down = 0, shrinkPull = 0;
    for (let i = Math.max(0, from); i < n; i++) {
      const p = pcts[i], ratio = ratios[i];
      if (p == null || ratio == null) continue;
      if (p >= 1 && ratio >= 1.5) up++;
      if (p <= -1 && ratio >= 1.5) down++;
      if (p < 0 && ratio <= 0.8) shrinkPull++;
    }
    return { up, down, shrinkPull };
  };
  const d20 = countDays(n - w20);
  const d60 = countDays(n - w60);

  const win120 = bars.slice(-Math.min(120, n));
  const high120 = Math.max(...win120.map((b) => b.h));
  const low120 = Math.min(...win120.map((b) => b.l));
  const last = bars[n - 1];
  const position = high120 > low120
    ? Math.round(((last.c - low120) / (high120 - low120)) * 1000) / 10
    : null;

  const volMa5 = mean(vols.slice(-5));
  const volMa60 = mean(vols.slice(-w60));
  const volRatio = volMa60 ? Math.round((volMa5 / volMa60) * 100) / 100 : null;

  const retBack = (k) => {
    const i = n - 1 - Math.min(k, n - 1);
    return bars[i] && bars[i].c > 0 ? Math.round((last.c / bars[i].c - 1) * 10000) / 100 : null;
  };

  return {
    ok: true,
    bars: n,
    lastDate: last.d,
    lastClose: r2(last.c),
    ret5: retBack(5),
    ret20: retBack(20),
    ret60: retBack(60),
    corrCloseVol20: pearson(closes.slice(-w20), vols.slice(-w20)),
    corrCloseVol60: pearson(closes.slice(-w60), vols.slice(-w60)),
    corrRetVol20: pearson(pcts.slice(-w20), ratios.slice(-w20).map((x) => (x == null ? 1 : x))),
    upVolDays20: d20.up, downVolDays20: d20.down, shrinkPullDays20: d20.shrinkPull,
    upVolDays60: d60.up, downVolDays60: d60.down, shrinkPullDays60: d60.shrinkPull,
    high120: r2(high120), low120: r2(low120), position120: position,
    volMa5: r2(volMa5 / 1e4), volMa60: r2(volMa60 / 1e4),   // 万手
    volRatio,
    volState: volRatio == null ? 'unknown'
      : volRatio >= RULES.volExpand ? 'heavy_expansion'
        : volRatio >= 1.1 ? 'mild_expansion'
          : volRatio >= 0.9 ? 'neutral'
            : volRatio >= RULES.volContract ? 'mild_contraction' : 'contraction',
  };
}

/* ---------------- 2. 事件层 ---------------- */

/** 2 左 2 右分形，返回已确认的摆动高低点（不含最后 2 根，右侧还没走完） */
function swings(bars) {
  const n = bars.length;
  const start = Math.max(0, n - RULES.swingLookback);
  const highs = [], lows = [];
  for (let i = start + RULES.swingLeft; i < n - RULES.swingRight; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isHigh = true, isLow = true;
    for (let j = i - RULES.swingLeft; j <= i + RULES.swingRight; j++) {
      if (j === i) continue;
      if (bars[j].h > h) isHigh = false;
      if (bars[j].l < l) isLow = false;
    }
    if (isHigh) highs.push({ i, d: bars[i].d, price: r2(h), barsAgo: n - 1 - i });
    if (isLow) lows.push({ i, d: bars[i].d, price: r2(l), barsAgo: n - 1 - i });
  }
  const close = bars[n - 1].c;
  const above = highs.filter((x) => x.price > close).sort((a, b) => a.price - b.price);
  const below = lows.filter((x) => x.price < close).sort((a, b) => b.price - a.price);
  return { highs, lows, nearestResistance: above[0] || null, nearestSupport: below[0] || null };
}

/**
 * 结构事件识别。
 * 每个事件都给出「在哪根、什么价、凭什么」，便于前端标图与人工复核。
 */
function events(bars, sw) {
  const n = bars.length;
  const out = { spring: [], upthrust: [], test: [], sos: [], sow: [], notes: [] };
  if (n < 30) { out.notes.push('K 线不足 30 根，事件识别跳过'); return out; }

  const avg20 = (i) => mean(bars.slice(Math.max(0, i - 20), i).map((b) => b.v));
  const volRatioAt = (i) => {
    const m = avg20(i);
    return m ? bars[i].v / m : null;
  };
  const priorLow = (i, k = 20) => Math.min(...bars.slice(Math.max(0, i - k), i).map((b) => b.l));
  const priorHigh = (i, k = 20) => Math.max(...bars.slice(Math.max(0, i - k), i).map((b) => b.h));

  for (let i = 20; i < n; i++) {
    const b = bars[i];
    const pl = priorLow(i);
    const ph = priorHigh(i);
    const vr = volRatioAt(i);

    // Spring：盘中跌破 20 日支撑，收盘收回，且不是放量破位
    const brokeLow = b.l < pl * (1 - RULES.breakoutPct / 100);
    const closedBack = b.c > pl;
    if (brokeLow && closedBack && (vr == null || vr < 1.2)) {
      // 3 根内是否守住（不破 spring 当根低点）
      const holdEnd = Math.min(n - 1, i + RULES.springWindow);
      let held = true;
      for (let j = i + 1; j <= holdEnd; j++) if (bars[j].c < pl) held = false;
      if (held) {
        out.spring.push({
          date: b.d, i, low: r2(b.l), support: r2(pl), volRatio: vr == null ? null : r2(vr),
          barsAgo: n - 1 - i,
          note: vr != null && vr < 0.9 ? '缩量假跌破，抛压不足' : '跌破后当日收回',
        });
      }
    }

    // Upthrust：盘中突破 20 日阻力，收盘跌回，且伴随放量
    const brokeHigh = b.h > ph * (1 + RULES.breakoutPct / 100);
    const closedDown = b.c < ph;
    if (brokeHigh && closedDown && vr != null && vr >= 1.2) {
      const holdEnd = Math.min(n - 1, i + RULES.springWindow);
      let failed = true;
      for (let j = i + 1; j <= holdEnd; j++) if (bars[j].c > ph) failed = false;
      if (failed) {
        out.upthrust.push({
          date: b.d, i, high: r2(b.h), resistance: r2(ph), volRatio: r2(vr),
          barsAgo: n - 1 - i,
          note: '放量突破后收回阻力下方',
        });
      }
    }

    // SOS / SOW：放量长阳/长阴，且收盘处在区间端部
    const pct = b.o > 0 ? ((b.c / b.o) - 1) * 100 : 0;
    if (pct >= RULES.sosPct && vr != null && vr >= RULES.sosVolRatio) {
      out.sos.push({ date: b.d, i, pct: r2(pct), volRatio: r2(vr), close: r2(b.c), barsAgo: n - 1 - i });
    }
    if (pct <= RULES.sowPct && vr != null && vr >= RULES.sowVolRatio) {
      out.sow.push({ date: b.d, i, pct: r2(pct), volRatio: r2(vr), close: r2(b.c), barsAgo: n - 1 - i });
    }
  }

  // Test：spring 之后第 3~10 根，回踩不破 spring 低点，且量能明显萎缩
  for (const sp of out.spring) {
    for (let k = RULES.testWindow[0]; k <= RULES.testWindow[1]; k++) {
      const j = sp.i + k;
      if (j >= n) break;
      const b = bars[j];
      if (b.l > sp.low && b.c > sp.low) {
        const ratio = bars[sp.i].v ? b.v / bars[sp.i].v : null;
        if (ratio != null && ratio <= RULES.testVolRatio) {
          out.test.push({
            date: b.d, i: j, springDate: sp.date, barsAfterSpring: k,
            volVsSpring: r2(ratio), low: r2(b.l), barsAgo: n - 1 - j,
            note: '回踩不破且量能萎缩，抛压测试通过',
          });
          break;
        }
      }
    }
  }

  // 只留近 60 根的，避免历史事件淹没当下
  const cut = (arr) => arr.filter((x) => x.barsAgo <= 60);
  return {
    spring: cut(out.spring), upthrust: cut(out.upthrust), test: cut(out.test),
    sos: cut(out.sos), sow: cut(out.sow), notes: out.notes,
  };
}

/* ---------------- 3. 判读层（启发式） ---------------- */

function phase(f, pos) {
  if (!f || !f.ok) return { value: 'insufficient_data', label: '数据不足', confidence: 'low', basis: ['K 线长度不足'] };
  const basis = [];
  let trend = f.ret60;
  let window = 60;
  if (f.ret60 != null && Math.abs(f.ret60) < 5 && f.ret20 != null && Math.abs(f.ret20) >= 8) {
    trend = f.ret20; window = 20;
    basis.push(`近 60 日仅变动 ${f.ret60.toFixed(1)}%，但近 20 日已${f.ret20 > 0 ? '上涨' : '下跌'} ${Math.abs(f.ret20).toFixed(1)}%`);
  } else if (f.ret60 != null) {
    basis.push(`近 60 日${f.ret60 >= 0 ? '上涨' : '下跌'} ${Math.abs(f.ret60).toFixed(1)}%`);
  }

  const vr = f.volRatio;
  let value, label, conf = 'medium';
  if (trend == null || vr == null) {
    return { value: 'insufficient_data', label: '数据不足', confidence: 'low', basis: ['量能或价格数据不足'] };
  }
  if (trend >= 5) {
    value = 'markup'; label = '上升期（markup）';
    conf = vr >= 1.05 ? (Math.abs(trend) >= 8 ? 'high' : 'medium') : 'medium';
    basis.push(vr >= 1.05 ? `量能同步放大（${vr} 倍）` : `上涨未获量能确认（${vr} 倍）`);
  } else if (trend <= -5) {
    value = 'markdown'; label = '下跌期（markdown）';
    conf = Math.abs(trend) >= 8 ? 'high' : 'medium';
    basis.push(vr >= 1.05 ? `下跌伴随放量（${vr} 倍），卖压释放` : `下跌但量能收缩（${vr} 倍），卖压或趋于衰竭`);
  } else {
    basis.push(`近 60 日变动仅 ${f.ret60 == null ? '—' : f.ret60.toFixed(1)}%，横向震荡`);
    if (vr >= 1.1) { value = 'distribution'; label = '派发期（distribution）'; basis.push(`震荡中放量（${vr} 倍），价滞量增`); }
    else { value = 'accumulation'; label = '吸筹期（accumulation）'; basis.push(`震荡中缩量（${vr} 倍），价横量缩`); }
    if (pos != null && ((value === 'accumulation' && pos >= RULES.posHigh) || (value === 'distribution' && pos <= RULES.posLow))) {
      conf = 'low';
      basis.push('价格位置与阶段标签存在张力');
    }
  }
  if (f.bars < 45) { conf = 'low'; basis.push('样本不足 45 根'); }
  basis.push(`60 日内放量上涨 ${f.upVolDays60} 天 / 放量下跌 ${f.downVolDays60} 天`);
  return { value, label, confidence: conf, basis, trendWindowDays: window, note: '启发式判定，需结合结构事件复核' };
}

/* ---------------- 组装 ---------------- */

/**
 * @param {Array} rows  [d,o,c,h,l,v,a] 或对象行，升序
 * @param {object} opt  { code, name, period }
 */
function analyze(rows, opt) {
  const o = opt || {};
  const bars = normalizeBars(rows);

  if (!bars.length) {
    return { ok: false, code: o.code || null, error: '没有可用 K 线', disclaimer: DISCLAIMER };
  }

  const f = features(bars);
  if (!f.ok) {
    return { ok: false, code: o.code || null, name: o.name || '', error: f.reason, bars: f.bars, disclaimer: DISCLAIMER };
  }

  const sw = swings(bars);
  const ev = events(bars, sw);
  const ph = phase(f, f.position120);

  // 结构摘要：把事件与位置拼成一句可复核的话，不做因果推断
  const bits = [];
  if (ev.spring.length) bits.push(`近 60 根出现 ${ev.spring.length} 次 spring（最近 ${ev.spring[ev.spring.length - 1].date}）`);
  if (ev.upthrust.length) bits.push(`${ev.upthrust.length} 次 upthrust（最近 ${ev.upthrust[ev.upthrust.length - 1].date}）`);
  if (ev.test.length) bits.push(`${ev.test.length} 次 test 通过`);
  if (ev.sos.length) bits.push(`${ev.sos.length} 次 SOS`);
  if (ev.sow.length) bits.push(`${ev.sow.length} 次 SOW`);
  if (!bits.length) bits.push('近 60 根无 spring / upthrust / test 形态');

  return {
    ok: true,
    code: o.code || null,
    name: o.name || '',
    period: o.period || 'day',
    features: f,
    swings: {
      highs: sw.highs.slice(-4),
      lows: sw.lows.slice(-4),
      nearestResistance: sw.nearestResistance,
      nearestSupport: sw.nearestSupport,
    },
    events: ev,
    phase: ph,
    summary: bits.join('；'),
    disclaimer: DISCLAIMER,
  };
}

module.exports = { analyze, features, events, swings, phase, normalizeBars, RULES, DISCLAIMER };
