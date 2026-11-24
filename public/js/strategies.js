/* ============================================================
 * QuantLab · Strategy Registry
 * 技术流派插件层。每个流派 = 一个声明式配置对象。
 * 渲染、Tab、评分、解读全部由引擎自动接管，新增流派无需改引擎。
 * ============================================================ */
(function (global) {
  'use strict';

  const QL = global.QuantLab = global.QuantLab || { strategies: [], WEIGHTS: {} };

  QL.registerStrategy = function (cfg) {
    if (!cfg || !cfg.id) throw new Error('strategy.id required');
    const i = QL.strategies.findIndex(s => s.id === cfg.id);
    if (i >= 0) QL.strategies[i] = cfg; else QL.strategies.push(cfg);
    return cfg;
  };

  /* ---------------- 通用工具 ---------------- */
  const A = (arr, i) => (arr && arr[i] != null ? arr[i] : null);
  const N = (arr, i, d = 0) => (arr && arr[i] != null ? arr[i] : d);

  function lastVal(arr) {
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }
  function cross(a, b, n) {
    for (let i = n - 1; i > Math.max(0, n - 60); i--) {
      if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return { i, t: 'gold' };
      if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return { i, t: 'dead' };
    }
    return null;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r2 = (v) => Math.round(v * 100) / 100;

  /** 用四条 line 表达矩形（兼容性最好），可选标签 */
  function box4(x1, x2, p1, p2, color, dash, label) {
    const d = dash || [4, 3];
    const out = [
      { type: 'line', pts: [[x1, p1], [x2, p1]], color, width: 1.1, dash: d, alpha: .9 },
      { type: 'line', pts: [[x1, p2], [x2, p2]], color, width: 1.1, dash: d, alpha: .9 },
      { type: 'line', pts: [[x1, p1], [x1, p2]], color, width: 1.1, dash: d, alpha: .55 },
      { type: 'line', pts: [[x2, p1], [x2, p2]], color, width: 1.1, dash: d, alpha: .55 },
    ];
    if (label) out.push({ type: 'label', i: x1 + 1, p: p2, text: label, color, align: 'left', dy: -9, size: 10 });
    return out;
  }

  function levelOf(score) {
    if (score >= 55) return '强势看多';
    if (score >= 20) return '偏多';
    if (score > -20) return '中性';
    if (score > -55) return '偏空';
    return '弱势看空';
  }
  QL.levelOf = levelOf;

  /* ============================================================
   * 01 · 均线系统
   * ============================================================ */
  QL.registerStrategy({
    id: 'ma', name: '均线系统', short: 'MA', color: '#4C8DFF', sub: 'bias',
    desc: '葛兰碧八大法则 · 多空排列与乖离',
    overlay(ctx) {
      const { ind, data } = ctx;
      const out = [];
      const sets = [
        ['ma5', '#E8B84B', 1.4], ['ma10', '#4C8DFF', 1.3],
        ['ma20', '#F6465D', 1.5], ['ma60', '#A882FF', 1.3],
      ];
      for (const [k, c, w] of sets) {
        const pts = [];
        for (let i = ctx.view.start; i < ctx.view.end; i++) {
          if (ind[k][i] != null) pts.push([i, ind[k][i]]);
        }
        if (pts.length > 1) out.push({ type: 'line', pts, color: c, width: w, alpha: .92 });
      }
      const n = ctx.n - 1;
      const m20 = ind.ma20[n];
      if (m20) out.push({ type: 'hline', p: m20, color: 'rgba(246,70,93,.45)', dash: [4, 4], label: 'MA20 ' + m20.toFixed(2) });
      return out;
    },
    analyze(ctx) {
      const { ind, last } = ctx;
      const n = ctx.n - 1;
      const m5 = N(ind.ma5, n), m10 = N(ind.ma10, n), m20 = N(ind.ma20, n),
            m30 = N(ind.ma30, n), m60 = N(ind.ma60, n), m120 = N(ind.ma120, n), m250 = N(ind.ma250, n);
      const c = last.c;
      let s = 0;
      const pts = [];

      const above = [m5, m10, m20, m30, m60].filter(v => c > v).length;
      s += (above - 2.5) * 9;
      pts.push({ k: '价格站位', v: `收盘 ${c.toFixed(2)}，站上 ${above}/5 条短中期均线` });

      const bullOrder = m5 > m10 && m10 > m20 && m20 > m30 && m30 > m60;
      const bearOrder = m5 < m10 && m10 < m20 && m20 < m30 && m30 < m60;
      if (bullOrder) s += 22;
      if (bearOrder) s -= 22;
      pts.push({ k: '均线排列', v: bullOrder ? '5>10>20>30>60 完全多头排列' : bearOrder ? '完全空头排列' : '均线缠绕，方向不明' });

      const gc = cross(ind.ma5, ind.ma20, n);
      if (gc) {
        const days = n - gc.i;
        pts.push({ k: '最近交叉', v: gc.t === 'gold' ? `MA5 金叉 MA20，已 ${days} 日` : `MA5 死叉 MA20，已 ${days} 日` });
        s += gc.t === 'gold' ? Math.max(3, 12 - days * 0.25) : -Math.max(3, 12 - days * 0.25);
      }

      if (m250) {
        const gap = ((c - m250) / m250) * 100;
        s += gap > 0 ? 12 : -12;
        pts.push({ k: '年线（MA250）', v: `${m250.toFixed(2)}，价格${gap > 0 ? '站上' : '低于'}年线 ${Math.abs(gap).toFixed(1)}%` });
      }
      if (m120) {
        const g2 = ((c - m120) / m120) * 100;
        s += g2 > 0 ? 7 : -7;
        pts.push({ k: '半年线（MA120）', v: `${m120.toFixed(2)}，偏离 ${g2 > 0 ? '+' : ''}${g2.toFixed(1)}%` });
      }

      const bias5 = N(ind.bias6, n);
      if (bias5 > 6) { s -= 8; pts.push({ k: '短线乖离', v: `6日乖离 +${bias5.toFixed(2)}%，偏离偏大` }); }
      else if (bias5 < -6) { s += 8; pts.push({ k: '短线乖离', v: `6日乖离 ${bias5.toFixed(2)}%，超跌` }); }

      return {
        score: clamp(s, -100, 100),
        verdict: bullOrder
          ? '五线多头排列，趋势向上，回踩均线即支撑。'
          : bearOrder
            ? '五线空头排列，反弹属逆势，均线为压力。'
            : `均线缠绕于 ${Math.min(m5, m20, m60).toFixed(2)}–${Math.max(m5, m20, m60).toFixed(2)} 区间，方向待选择。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 02 · MACD 趋势
   * ============================================================ */
  QL.registerStrategy({
    id: 'macd', name: 'MACD', short: 'MACD', color: '#E8B84B', sub: 'macd',
    desc: '指数平滑异同 · 零轴与背离',
    overlay(ctx) {
      const { ind } = ctx;
      const out = [];
      // 视野内所有金叉/死叉都标（原来只标最近 60 根里的最后一次）
      const dif = ind.macd.dif, dea = ind.macd.dea;
      const vs = ctx.helpers.vspan();
      const cands = [];
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (dif[i] == null || dea[i] == null || dif[i - 1] == null || dea[i - 1] == null) continue;
        if (dif[i - 1] <= dea[i - 1] && dif[i] > dea[i]) cands.push({ i, t: 'gold' });
        else if (dif[i - 1] >= dea[i - 1] && dif[i] < dea[i]) cands.push({ i, t: 'dead' });
      }
      for (const { i, t } of ctx.helpers.spread(cands, 46)) {
        out.push({
          type: 'marker', i, p: ctx.data[i].l, r: 3.6,
          color: t === 'gold' ? '#F6465D' : '#2EBD85',
          text: t === 'gold' ? '金叉' : '死叉', pos: 'below', bold: true,
        });
      }
      return out;
    },
    analyze(ctx) {
      const { ind } = ctx;
      const n = ctx.n - 1;
      const dif = N(ind.macd.dif, n), dea = N(ind.macd.dea, n), hist = N(ind.macd.hist, n);
      let s = 0;
      const pts = [];

      pts.push({ k: 'DIF / DEA', v: `${dif.toFixed(3)} / ${dea.toFixed(3)}，柱 ${hist >= 0 ? '+' : ''}${hist.toFixed(3)}` });
      if (dif > 0 && dea > 0) { s += 26; pts.push({ k: '零轴位置', v: '双线在零轴上方，多头市场' }); }
      else if (dif < 0 && dea < 0) { s -= 26; pts.push({ k: '零轴位置', v: '双线在零轴下方，空头市场' }); }
      else { s += dif > dea ? 10 : -10; pts.push({ k: '零轴位置', v: '双线跨越零轴，多空转换期' }); }

      if (dif > dea) { s += 14; pts.push({ k: '交叉状态', v: 'DIF 在 DEA 之上，红柱运行' }); }
      else { s -= 14; pts.push({ k: '交叉状态', v: 'DIF 在 DEA 之下，绿柱运行' }); }

      // 柱状动能变化
      const h1 = N(ind.macd.hist, n), h2 = N(ind.macd.hist, n - 1), h3 = N(ind.macd.hist, n - 2);
      if (h1 > h2 && h2 > h3) { s += 8; pts.push({ k: '动能', v: '红柱连续放大，上涨动能增强' }); }
      else if (h1 < h2 && h2 < h3) { s -= 8; pts.push({ k: '动能', v: '绿柱连续放大，下跌动能增强' }); }
      else { pts.push({ k: '动能', v: h1 > h2 ? '柱体缩短，动能衰减' : '柱体变化，方向待确认' }); }

      // 价格新高 vs DIF 未新高 → 顶背离（近 40 根）
      const look = 40, s0 = Math.max(0, n - look);
      let hiP = -Infinity, hiPd = -Infinity, hiI = s0;
      for (let i = s0; i <= n; i++) if (ctx.data[i].h > hiP) { hiP = ctx.data[i].h; hiI = i; }
      for (let i = s0; i <= n; i++) if (ind.macd.dif[i] > hiPd) hiPd = ind.macd.dif[i];
      if (hiI >= n - 3 && dif < hiPd * 0.92 && dif > 0) {
        s -= 10;
        pts.push({ k: '背离检测', v: '价格创近 40 日新高但 DIF 未同步，存在顶背离迹象' });
      }

      return {
        score: clamp(s, -100, 100),
        verdict: dif > 0 && dea > 0
          ? (dif > dea ? '零轴上方金叉，中期多头趋势延续。' : '零轴上方死叉，多头趋势中的回调。')
          : dif < 0 && dea < 0
            ? (dif > dea ? '零轴下方金叉，空头趋势中的反弹。' : '零轴下方死叉，空头趋势延续。')
            : '零轴附近反复，方向尚未确立。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 03 · KDJ 摆动
   * ============================================================ */
  QL.registerStrategy({
    id: 'kdj', name: 'KDJ', short: 'KDJ', color: '#A882FF', sub: 'kdj',
    desc: '随机指标 · 超买超卖与钝化',
    overlay(ctx) {
      const n = ctx.n - 1;
      const j = N(ctx.ind.kdj.j, n);
      const out = [];
      if (j > 100) out.push({ type: 'marker', i: n, p: ctx.data[n].h, color: '#F6465D', text: `J=${j.toFixed(0)} 超买`, pos: 'above' });
      if (j < 0) out.push({ type: 'marker', i: n, p: ctx.data[n].l, color: '#2EBD85', text: `J=${j.toFixed(0)} 超卖`, pos: 'below' });
      return out;
    },
    analyze(ctx) {
      const { ind } = ctx;
      const n = ctx.n - 1;
      const k = N(ind.kdj.k, n), d = N(ind.kdj.d, n), j = N(ind.kdj.j, n);
      let s = 0;
      const pts = [{ k: 'K / D / J', v: `${k.toFixed(1)} / ${d.toFixed(1)} / ${j.toFixed(1)}` }];

      if (k > d) { s += 14; pts.push({ k: '交叉', v: 'K 在 D 之上，短线多头掌控' }); }
      else { s -= 14; pts.push({ k: '交叉', v: 'K 在 D 之下，短线空头掌控' }); }

      if (j > 100) { s -= 18; pts.push({ k: '状态', v: 'J 值超过 100，严重超买，随时回落' }); }
      else if (j > 80) { s -= 10; pts.push({ k: '状态', v: 'J 值进入 80 以上超买区' }); }
      else if (j < 0) { s += 18; pts.push({ k: '状态', v: 'J 值跌破 0，严重超卖，随时反弹' }); }
      else if (j < 20) { s += 10; pts.push({ k: '状态', v: 'J 值进入 20 以下超卖区' }); }
      else { pts.push({ k: '状态', v: '位于中性区间，无极端信号' }); }

      if (k > 80 && d > 80) { s -= 6; pts.push({ k: '钝化', v: 'K、D 高位钝化，强势但脆弱' }); }
      if (k < 20 && d < 20) { s += 6; pts.push({ k: '钝化', v: 'K、D 低位钝化，弱势但接近转折' }); }

      // K 拐头
      const k2 = N(ind.kdj.k, n - 1);
      if (k > k2 && d > N(ind.kdj.d, n - 1)) { s += 6; pts.push({ k: '拐点', v: 'K、D 同步向上拐头' }); }
      else if (k < k2 && d < N(ind.kdj.d, n - 1)) { s -= 6; pts.push({ k: '拐点', v: 'K、D 同步向下拐头' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: j > 80
          ? 'KDJ 高位钝化，短线过热，追高风险大于收益。'
          : j < 20
            ? 'KDJ 低位钝化，短线超跌，具备反弹条件。'
            : 'KDJ 处于中性区，跟随趋势方向操作。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 04 · RSI 强弱
   * ============================================================ */
  QL.registerStrategy({
    id: 'rsi', name: 'RSI 强弱', short: 'RSI', color: '#35D0D0', sub: 'rsi',
    desc: '相对强弱 · 多空力度对比',
    overlay() { return []; },
    analyze(ctx) {
      const { ind } = ctx;
      const n = ctx.n - 1;
      const a = N(ind.rsi6, n), b = N(ind.rsi12, n), c2 = N(ind.rsi24, n);
      let s = 0;
      const pts = [{ k: 'RSI 6/12/24', v: `${a.toFixed(1)} / ${b.toFixed(1)} / ${c2.toFixed(1)}` }];

      if (a > b && b > c2) { s += 16; pts.push({ k: '排列', v: '短中长期多头排列，买盘占优' }); }
      else if (a < b && b < c2) { s -= 16; pts.push({ k: '排列', v: '空头排列，卖压主导' }); }
      else pts.push({ k: '排列', v: '交叉缠绕，力度均衡' });

      if (a > 80) { s -= 14; pts.push({ k: '超买', v: 'RSI6 超过 80，短线严重超买' }); }
      else if (a > 70) { s -= 7; pts.push({ k: '超买', v: 'RSI6 进入 70 以上超买区' }); }
      else if (a < 20) { s += 14; pts.push({ k: '超卖', v: 'RSI6 低于 20，短线严重超卖' }); }
      else if (a < 30) { s += 7; pts.push({ k: '超卖', v: 'RSI6 进入 30 以下超卖区' }); }
      else pts.push({ k: '区间', v: 'RSI6 处于 30–70 常态区间' });

      if (b > 50) { s += 10; pts.push({ k: '中轴', v: 'RSI12 位于 50 上方，中期偏强' }); }
      else { s -= 10; pts.push({ k: '中轴', v: 'RSI12 位于 50 下方，中期偏弱' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: a > 70 ? '短线过热，回撤概率上升。' : a < 30 ? '短线超卖，存在修复反弹。' : (b > 50 ? '多空力量偏多，回撤可承接。' : '多空力量偏空，反弹需谨慎。'),
        points: pts,
      };
    },
  });

  /* ============================================================
   * 05 · 布林带
   * ============================================================ */
  QL.registerStrategy({
    id: 'boll', name: '布林带', short: 'BOLL', color: '#7FB0FF', sub: 'bollb',
    desc: '波动率通道 · 开口与位置',
    overlay(ctx) {
      const { ind } = ctx;
      const out = [];
      const cfg = [['up', 'rgba(127,176,255,.75)', '上轨'], ['mid', 'rgba(232,184,75,.7)', '中轨'], ['dn', 'rgba(127,176,255,.75)', '下轨']];
      for (const [k, c, nm] of cfg) {
        const pts = [];
        for (let i = ctx.view.start; i < ctx.view.end; i++) if (ind.boll[k][i] != null) pts.push([i, ind.boll[k][i]]);
        if (pts.length > 1) out.push({ type: 'line', pts, color: c, width: k === 'mid' ? 1.3 : 1.1, dash: k === 'mid' ? [4, 3] : [] });
      }
      // 带宽填充
      const up = [], dn = [];
      for (let i = ctx.view.start; i < ctx.view.end; i++) {
        if (ind.boll.up[i] != null) { up.push([i, ind.boll.up[i]]); }
      }
      for (let i = ctx.view.end - 1; i >= ctx.view.start; i--) {
        if (ind.boll.dn[i] != null) dn.push([i, ind.boll.dn[i]]);
      }
      if (up.length && dn.length) out.push({ type: 'area', pts: up.concat(dn), fill: 'rgba(76,141,255,.05)' });
      return out;
    },
    analyze(ctx) {
      const { ind, last } = ctx;
      const n = ctx.n - 1;
      const up = N(ind.boll.up, n), mid = N(ind.boll.mid, n), dn = N(ind.boll.dn, n);
      const c = last.c;
      const width = (up - dn) / mid * 100;
      const pctB = (c - dn) / (up - dn) * 100;
      let s = 0;
      const pts = [];

      pts.push({ k: '轨道', v: `上 ${up.toFixed(2)} / 中 ${mid.toFixed(2)} / 下 ${dn.toFixed(2)}` });
      pts.push({ k: '位置 %B', v: `${pctB.toFixed(1)}%（0=下轨，100=上轨）` });

      if (c > up) { s += 6; pts.push({ k: '突破', v: '收盘突破上轨，强势但需防回归' }); }
      else if (c > mid) { s += 16; pts.push({ k: '位置', v: '运行于中轨与上轨之间，多头区' }); }
      else if (c > dn) { s -= 16; pts.push({ k: '位置', v: '运行于中轨与下轨之间，空头区' }); }
      else { s -= 6; pts.push({ k: '跌破', v: '收盘跌破下轨，弱势但接近超跌' }); }

      const w2 = (N(ind.boll.up, n - 5) - N(ind.boll.dn, n - 5)) / N(ind.boll.mid, n - 5) * 100;
      if (width > w2 * 1.15) pts.push({ k: '开口', v: `带宽 ${width.toFixed(1)}%，正在扩张，波动加剧` });
      else if (width < w2 * 0.85) pts.push({ k: '开口', v: `带宽 ${width.toFixed(1)}%，正在收窄，酝酿变盘` });
      else pts.push({ k: '开口', v: `带宽 ${width.toFixed(1)}%，保持稳定` });

      // 中轨方向
      if (mid > N(ind.boll.mid, n - 5)) { s += 8; pts.push({ k: '中轨方向', v: '中轨向上，趋势偏多' }); }
      else { s -= 8; pts.push({ k: '中轨方向', v: '中轨向下，趋势偏空' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: c > mid
          ? `价格位于布林中轨上方，%B=${pctB.toFixed(0)}，${pctB > 90 ? '贴近上轨，短线过热' : '通道内偏强运行'}。`
          : `价格位于布林中轨下方，%B=${pctB.toFixed(0)}，${pctB < 10 ? '贴近下轨，超跌待修复' : '通道内偏弱运行'}。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 06 · 道氏理论
   * ============================================================ */
  QL.registerStrategy({
    id: 'dow', name: '道氏理论', short: 'DOW', color: '#FF9F6B', sub: 'none',
    desc: '趋势结构 · 高低点序列',
    overlay(ctx) {
      const zz = ctx.zz;
      const out = [];
      if (zz.length < 2) return out;
      // 摆动连线
      const pts = zz.map(p => [p.i, p.p]);
      out.push({ type: 'line', pts, color: 'rgba(255,159,107,.55)', width: 1.3, dash: [4, 3] });

      // 标注 HH/HL/LH/LL（同类摆动点比较）
      let lastH = null, lastL = null;
      const tags = [];
      for (let k = 0; k < zz.length; k++) {
        const cur = zz[k];
        let tag = '';
        if (cur.t === 'H') { tag = lastH == null ? 'H' : (cur.p > lastH ? 'HH' : 'LH'); lastH = cur.p; }
        else { tag = lastL == null ? 'L' : (cur.p > lastL ? 'HL' : 'LL'); lastL = cur.p; }
        const col = (tag === 'HH' || tag === 'HL') ? '#F6465D' : '#2EBD85';
        tags.push({ cur, tag, col });
      }
      // 视野内的摆动点全部标注（原来只标最近 10 个），密度用像素间距控制
      const vs = ctx.helpers.vspan();
      const picked = ctx.helpers.spread(
        tags.filter(x => x.cur.i >= vs.lo && x.cur.i < vs.hi).map(x => ({ i: x.cur.i, x })),
        40
      );
      picked.forEach(({ x }) => {
        out.push({
          type: 'marker', i: x.cur.i, p: x.cur.p, r: 2.8, color: x.col,
          text: x.tag, pos: x.cur.t === 'H' ? 'above' : 'below',
        });
      });

      // 主要趋势线：连接最后两个同向点
      const hs = zz.filter(p => p.t === 'H').slice(-2);
      const ls = zz.filter(p => p.t === 'L').slice(-2);
      if (hs.length === 2) out.push({ type: 'trend', a: [hs[0].i, hs[0].p], b: [hs[1].i, hs[1].p], color: 'rgba(246,70,93,.5)', dash: [5, 4], width: 1.1 });
      if (ls.length === 2) out.push({ type: 'trend', a: [ls[0].i, ls[0].p], b: [ls[1].i, ls[1].p], color: 'rgba(46,189,133,.5)', dash: [5, 4], width: 1.1 });
      return out;
    },
    analyze(ctx) {
      const zz = ctx.zzc;
      const pts = [];
      if (zz.length < 4) return { score: 0, verdict: '摆动点不足，无法判定趋势结构。', points: [{ k: '样本', v: `仅 ${zz.length} 个摆动点` }] };

      const H = zz.filter(p => p.t === 'H').slice(-3);
      const L = zz.filter(p => p.t === 'L').slice(-3);
      let s = 0;

      const hUp = H.length >= 2 && H[H.length - 1].p > H[H.length - 2].p;
      const lUp = L.length >= 2 && L[L.length - 1].p > L[L.length - 2].p;

      pts.push({ k: '近期高点', v: H.map(p => p.p.toFixed(2)).join(' → ') });
      pts.push({ k: '近期低点', v: L.map(p => p.p.toFixed(2)).join(' → ') });

      if (hUp && lUp) { s += 55; pts.push({ k: '结构', v: '高点抬高 + 低点抬高，上升趋势成立' }); }
      else if (!hUp && !lUp) { s -= 55; pts.push({ k: '结构', v: '高点降低 + 低点降低，下降趋势成立' }); }
      else if (hUp && !lUp) { s += 10; pts.push({ k: '结构', v: '高点抬高但低点下移，扩张形态，分歧加大' }); }
      else { s -= 5; pts.push({ k: '结构', v: '高点降低但低点抬高，收敛形态，等待方向' }); }

      // 量能确认
      const n = ctx.n - 1;
      const vma = N(ctx.ind.volMa5, n);
      const vr = ctx.data[n].v / vma;
      if (hUp && vr > 1.1) { s += 12; pts.push({ k: '量能确认', v: '上涨伴随放量，趋势可信度高' }); }
      else if (!hUp && vr > 1.1) { s -= 12; pts.push({ k: '量能确认', v: '下跌伴随放量，趋势可信度高' }); }
      else pts.push({ k: '量能确认', v: '量能未明显配合，趋势强度待验证' });

      return {
        score: clamp(s, -100, 100),
        verdict: hUp && lUp ? '道氏结构确认上升趋势：高低点同步抬高，回撤可参与。'
          : (!hUp && !lUp) ? '道氏结构确认下降趋势：高低点同步下移，反弹属逆势。'
            : '趋势结构不一致，处于转折或震荡阶段，等确认再动。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 07 · 艾略特波浪
   * ============================================================ */
  QL.registerStrategy({
    id: 'wave', name: '波浪理论', short: 'WAVE', color: '#FF8FB1', sub: 'none',
    desc: '五浪推进 · 三浪调整',
    overlay(ctx) {
      const zz = ctx.zzWave;
      if (zz.length < 3) return [];
      const vs = ctx.helpers.vspan();
      // 折线覆盖整个可视范围（原来只画最后 8 个摆动点，左侧一大片空白）
      let tail = zz.filter(p => p.i >= vs.lo - 6 && p.i < vs.hi + 6);
      if (tail.length < 4) tail = zz.slice(-6);
      const out = [];
      const pts = tail.map(p => [p.i, p.p]);
      out.push({ type: 'line', pts, color: 'rgba(255,143,177,.5)', width: 1.2, dash: [3, 3] });

      // 浪型编号只标最近这一段：在最后 9 个点里找最近的低点当起点（1-5 与 A-C，再往前语义已失效）
      let startK = Math.max(0, tail.length - 9);
      for (let k = startK; k < tail.length; k++) if (tail[k].t === 'L') { startK = k; break; }
      // 根数拉得很宽时（每根不足 2.2px）编号会挤成一个墨点，此时只保留折线
      const showNums = ctx.helpers.bw() >= 2.2;
      const labels = ['起点', '1', '2', '3', '4', '5', 'A', 'B', 'C'];
      let li = 0;
      for (let k = startK; k < tail.length; k++) {
        const p = tail[k];
        if (showNums) out.push({
          type: 'marker', i: p.i, p: p.p, r: 3, color: '#FF8FB1',
          text: labels[li] || '', pos: p.t === 'H' ? 'above' : 'below', bold: true,
        });
        li++;
      }
      // 斐波那契目标（一浪等长）
      const wave1 = tail[startK + 1] ? Math.abs(tail[startK + 1].p - tail[startK].p) : 0;
      if (wave1 && tail[startK]) {
        const tgt = tail[startK].p + wave1 * 1.618;
        out.push({ type: 'hline', p: tgt, color: 'rgba(255,143,177,.45)', dash: [6, 4], label: '1.618目标 ' + tgt.toFixed(2), side: 'right' });
      }
      return out;
    },
    analyze(ctx) {
      const zz = ctx.zzWave;
      if (zz.length < 5) return { score: 0, verdict: '摆动点不足，浪型无法划分。', points: [] };
      const tail = zz.slice(-6);
      let si = 0;
      for (let k = tail.length - 1; k >= 0; k--) if (tail[k].t === 'L') { si = k; break; }
      const seq = tail.slice(si);
      const waves = seq.length - 1;
      const n = ctx.n - 1;
      const c = ctx.data[n].c;
      const pts = [];

      pts.push({ k: '已识别', v: `${waves} 段摆动，起点 ${seq[0].p.toFixed(2)}` });
      let s = 0;

      if (waves >= 5) {
        pts.push({ k: '浪型判断', v: '五浪结构接近完成，进入调整或反转概率上升' });
        s -= 26;
      } else if (waves === 4) {
        pts.push({ k: '浪型判断', v: '处于第 5 浪推进中，尚有上行空间但接近尾声' });
        s += 8;
      } else if (waves === 3) {
        pts.push({ k: '浪型判断', v: '第 3 浪主升段，通常最具爆发力' });
        s += 34;
      } else if (waves === 2) {
        pts.push({ k: '浪型判断', v: '第 2 浪调整中，回撤后有望开启主升' });
        s += 6;
      } else {
        pts.push({ k: '浪型判断', v: '推进浪初期，结构尚未清晰' });
        s += 4;
      }

      // 当前是否回撤过深（>61.8% 说明浪型可能失败）
      if (seq.length >= 3) {
        const lastLeg = Math.abs(seq[seq.length - 1].p - seq[seq.length - 2].p);
        const prevLeg = Math.abs(seq[seq.length - 2].p - seq[seq.length - 3].p);
        if (prevLeg > 0) {
          const ratio = lastLeg / prevLeg;
          pts.push({ k: '浪长比例', v: `最近一浪 / 前一浪 = ${ratio.toFixed(2)}` });
          if (ratio < 0.382) { s -= 8; pts.push({ k: '强度', v: '推动力明显衰减，警惕浪型失败' }); }
        }
      }

      // 目标位
      if (seq.length >= 2) {
        const w1 = Math.abs(seq[1].p - seq[0].p);
        pts.push({ k: '测算目标', v: `1.618 延伸位约 ${(seq[0].p + w1 * 1.618).toFixed(2)}，2.618 位约 ${(seq[0].p + w1 * 2.618).toFixed(2)}` });
      }

      return {
        score: clamp(s, -100, 100),
        verdict: waves >= 5 ? '五浪推进已近完成，接下来大概率进入 ABC 调整，不宜追高。'
          : waves === 3 ? '处于主升第 3 浪，理论上是最具爆发力的一段。'
            : '推进浪仍在延续，但需以通道与量能验证。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 08 · 江恩理论
   * ============================================================ */
  QL.registerStrategy({
    id: 'gann', name: '江恩理论', short: 'GANN', color: '#E8B84B', sub: 'none',
    desc: '角度线 · 价格带 · 时间窗',
    overlay(ctx) {
      const out = [];
      const n = ctx.n - 1;
      const box = ctx.helpers.box(Math.max(0, n - 90), n);
      const span = box.hi - box.lo;
      if (span <= 0) return out;

      // 箱体
      out.push({
        type: 'rect', x1: box.loI, x2: n, p1: box.lo, p2: box.hi,
        fill: 'rgba(232,184,75,.05)', stroke: 'rgba(232,184,75,.4)', width: 1.2,
        label: `江恩区间 ${box.lo.toFixed(2)}–${box.hi.toFixed(2)}`, color: '#E8B84B',
      });

      // 价格带
      const mid = (box.hi + box.lo) / 2;
      const levels = [
        [box.hi, '区间顶 ' + box.hi.toFixed(2), 'rgba(246,70,93,.65)', [2, 3], 'right'],
        [box.lo + span * 0.618, '61.8% ' + (box.lo + span * 0.618).toFixed(2), 'rgba(232,184,75,.4)', [3, 4], 'left'],
        [mid, '50% 分水岭 ' + mid.toFixed(2), 'rgba(232,184,75,.85)', [6, 3], 'left'],
        [box.lo + span * 0.382, '38.2% ' + (box.lo + span * 0.382).toFixed(2), 'rgba(232,184,75,.4)', [3, 4], 'left'],
        [box.lo, '区间底 ' + box.lo.toFixed(2), 'rgba(46,189,133,.65)', [2, 3], 'right'],
      ];
      levels.forEach(([p, label, color, dash, side]) =>
        out.push({ type: 'hline', p, color, dash, label, side }));

      // 时间窗：从区间低点起斐波那契交易日
      [13, 21, 34, 55, 89].forEach(k => {
        const idx = box.loI + k;
        if (idx < ctx.n) out.push({ type: 'vline', i: idx, color: 'rgba(168,130,255,.28)', dash: [2, 5] });
      });

      // 当前价格在区间中的位置
      out.push({ type: 'marker', i: n, p: ctx.data[n].c, r: 4, color: '#fff', text: '', pos: 'above' });
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1, c = ctx.data[n].c;
      const box = ctx.helpers.box(Math.max(0, n - 90), n);
      const span = box.hi - box.lo;
      if (span <= 0) return { score: 0, verdict: '缺乏有效区间。', points: [] };
      const mid = (box.hi + box.lo) / 2;
      const pts = [];
      let s = 0;

      pts.push({ k: '江恩区间', v: `${box.lo.toFixed(2)} – ${box.hi.toFixed(2)}，振幅 ${(span / box.lo * 100).toFixed(1)}%` });
      pts.push({ k: '50% 分水岭', v: `${mid.toFixed(2)}，现价 ${c.toFixed(2)} ${c > mid ? '位于上方' : '位于下方'}` });

      if (c > mid) { s += 24; pts.push({ k: '多空能量', v: '价格在 50% 位上方，多方掌控主动权' }); }
      else { s -= 24; pts.push({ k: '多空能量', v: '价格在 50% 位下方，空方掌控主动权' }); }

      const ratio = (c - box.lo) / span;
      pts.push({ k: '区间位置', v: `${(ratio * 100).toFixed(1)}% 分位` });
      if (ratio > 0.618) { s += 12; pts.push({ k: '强弱', v: '位于 61.8% 强势区，上攻结构 intact' }); }
      else if (ratio < 0.382) { s -= 12; pts.push({ k: '强弱', v: '位于 38.2% 弱势区，下方支撑受考验' }); }
      else pts.push({ k: '强弱', v: '处于中间地带，多空均衡' });

      // 时间窗
      const days = n - box.loI;
      const next = [13, 21, 34, 55, 89].find(k => k > days);
      if (next) {
        const left = next - days;
        pts.push({ k: '时间窗口', v: `距 ${next} 日周期窗 ${left} 个交易日${left <= 3 ? '（临近，波动或放大）' : ''}` });
        if (left <= 3) s -= 4;
      }

      // 到上下沿的空间
      pts.push({ k: '空间测算', v: `上行至区间顶 ${((box.hi - c) / c * 100).toFixed(1)}%，下行至区间底 ${((c - box.lo) / c * 100).toFixed(1)}%` });

      return {
        score: clamp(s, -100, 100),
        verdict: c > mid
          ? `站稳 50% 分水岭 ${mid.toFixed(2)}，上方目标 ${box.hi.toFixed(2)}，失守则回落 ${box.lo.toFixed(2)}。`
          : `受压于 50% 分水岭 ${mid.toFixed(2)}，下方支撑 ${box.lo.toFixed(2)}，站上才能重获主动。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 09 · 缠论
   * ============================================================ */
  QL.registerStrategy({
    id: 'chan', name: '缠论', short: 'CHAN', color: '#8CD9A0', sub: 'macd',
    desc: '笔 · 线段 · 中枢 · 背驰',
    overlay(ctx) {
      const zz = ctx.zz;
      if (zz.length < 4) return [];
      const out = [];
      // 笔（相邻摆动点）
      const pts = zz.map(p => [p.i, p.p]);
      out.push({ type: 'line', pts, color: 'rgba(140,217,160,.65)', width: 1.5 });

      // 中枢：连续 3 笔（4 个摆动点）的重叠区间
      let drawn = 0;
      for (let k = zz.length - 1; k >= 3 && drawn < 1; k--) {
        const seg = zz.slice(k - 3, k + 1);
        const his = seg.filter(p => p.t === 'H').map(p => p.p);
        const los = seg.filter(p => p.t === 'L').map(p => p.p);
        if (his.length < 1 || los.length < 1) continue;
        const zg = Math.min(...his), zd = Math.max(...los);
        if (zg > zd) {
          out.push({
            type: 'rect', x1: seg[0].i, x2: seg[seg.length - 1].i, p1: zd, p2: zg,
            fill: 'rgba(140,217,160,.12)', stroke: 'rgba(140,217,160,.75)', width: 1.2,
            label: `中枢 ${zd.toFixed(2)}–${zg.toFixed(2)}`, color: '#8CD9A0',
          });
          drawn++;
        }
      }
      return out;
    },
    analyze(ctx) {
      const zz = ctx.zzc;
      if (zz.length < 4) return { score: 0, verdict: '笔段不足，尚未形成有效中枢。', points: [] };
      const n = ctx.n - 1, c = ctx.data[n].c;
      const pts = [];
      let s = 0;

      // 找最近中枢
      let zone = null;
      for (let k = zz.length - 1; k >= 3; k--) {
        const seg = zz.slice(k - 3, k + 1);
        const his = seg.filter(p => p.t === 'H').map(p => p.p);
        const los = seg.filter(p => p.t === 'L').map(p => p.p);
        if (!his.length || !los.length) continue;
        const zg = Math.min(...his), zd = Math.max(...los);
        if (zg > zd) { zone = { zg, zd, s: seg[0].i, e: seg[seg.length - 1].i }; break; }
      }

      if (zone) {
        pts.push({ k: '最近中枢', v: `${zone.zd.toFixed(2)} – ${zone.zg.toFixed(2)}（区间 ${((zone.zg - zone.zd) / zone.zd * 100).toFixed(1)}%）` });
        if (c > zone.zg) { s += 28; pts.push({ k: '相对位置', v: '价格在中枢上方，属三买后的离开段' }); }
        else if (c < zone.zd) { s -= 28; pts.push({ k: '相对位置', v: '价格跌破中枢下沿，结构转弱' }); }
        else { s += (c - zone.zd) / (zone.zg - zone.zd) * 16 - 8; pts.push({ k: '相对位置', v: '价格在中枢内部震荡，等第三类买卖点' }); }
      }

      // 背驰：价格新高但 MACD 柱面积缩小
      const seg = zz.slice(-3);
      if (seg.length === 3 && seg[2].t === 'H') {
        const dif = ctx.ind.macd.dif;
        const d1 = Math.max(...dif.slice(Math.max(0, seg[0].i), seg[1].i).map(Math.abs));
        const d2 = Math.max(...dif.slice(Math.max(0, seg[1].i), seg[2].i).map(Math.abs));
        if (seg[2].p > seg[0].p && d2 < d1 * 0.85) {
          s -= 16;
          pts.push({ k: '背驰', v: '价格创新高但 MACD 力度减弱，顶背驰成立' });
        }
      }

      // 笔的方向
      const lastSeg = zz.slice(-2);
      if (lastSeg.length === 2) {
        const dir = lastSeg[1].p > lastSeg[0].p ? '向上笔' : '向下笔';
        pts.push({ k: '当前笔', v: `${dir}，自 ${lastSeg[0].p.toFixed(2)} 至 ${lastSeg[1].p.toFixed(2)}` });
        s += dir === '向上笔' ? 8 : -8;
      }

      return {
        score: clamp(s, -100, 100),
        verdict: zone
          ? (c > zone.zg ? '已离开中枢上沿，回踩不破 ZG 即构成第三类买点。'
            : c < zone.zd ? '跌破中枢下沿，反弹不回中枢即构成第三类卖点。'
              : `中枢震荡区间 ${zone.zd.toFixed(2)}–${zone.zg.toFixed(2)}，高抛低吸，等三类买卖点。`)
          : '尚未形成有效中枢，按笔的方向跟随。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 10 · 形态学
   * ============================================================ */
  QL.registerStrategy({
    id: 'pattern', name: '形态学', short: 'PAT', color: '#F0A45B', sub: 'vol',
    desc: '箱体 · 双底 · 缺口 · 颈线',
    overlay(ctx) {
      const out = [];
      const from = Math.max(0, ctx.n - 90);
      const box = ctx.helpers.box(from, ctx.n - 1);
      out.push({
        type: 'rect', x1: box.loI, x2: ctx.n - 1, p1: box.lo, p2: box.hi,
        fill: 'rgba(240,164,91,.055)', stroke: 'rgba(240,164,91,.45)', width: 1.2,
        label: `箱体 ${box.lo.toFixed(2)}–${box.hi.toFixed(2)}`, color: '#F0A45B',
      });
      out.push({ type: 'hline', p: box.hi, color: 'rgba(246,70,93,.5)', dash: [6, 4], label: '箱顶 ' + box.hi.toFixed(2), side: 'right' });
      out.push({ type: 'hline', p: box.lo, color: 'rgba(46,189,133,.5)', dash: [6, 4], label: '箱底 ' + box.lo.toFixed(2) });

      // 双底识别
      const Ls = ctx.zzc.filter(p => p.t === 'L').slice(-2);
      if (Ls.length === 2) {
        const diff = Math.abs(Ls[0].p - Ls[1].p) / Ls[0].p;
        if (diff < 0.04) {
          const neck = ctx.zzc.filter(p => p.t === 'H' && p.i > Ls[0].i && p.i < Ls[1].i).map(p => p.p);
          if (neck.length) {
            const nh = Math.max(...neck);
            out.push({ type: 'hline', p: nh, color: 'rgba(232,184,75,.75)', dash: [3, 3], label: '双底颈线 ' + nh.toFixed(2) });
            out.push({ type: 'marker', i: Ls[0].i, p: Ls[0].p, color: '#2EBD85', text: '底1', pos: 'below', r: 3.4 });
            out.push({ type: 'marker', i: Ls[1].i, p: Ls[1].p, color: '#2EBD85', text: '底2', pos: 'below', r: 3.4 });
          }
        }
      }

      // 缺口
      const gs = ctx.helpers.gaps().slice(-2);
      for (const g of gs) {
        out.push({
          type: 'rect', x1: g.i - 1, x2: g.i, p1: g.from, p2: g.to,
          fill: g.dir > 0 ? 'rgba(246,70,93,.22)' : 'rgba(46,189,133,.22)',
          stroke: g.dir > 0 ? 'rgba(246,70,93,.7)' : 'rgba(46,189,133,.7)',
          label: (g.dir > 0 ? '上跳缺口 ' : '下跳缺口 ') + g.from.toFixed(2) + '–' + g.to.toFixed(2),
          color: '#9AA6B8',
        });
      }
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1, c = ctx.data[n].c;
      const from = Math.max(0, n - 90);
      const box = ctx.helpers.box(from, n);
      const pos = (c - box.lo) / (box.hi - box.lo) * 100;
      const pts = [];
      let s = 0;

      pts.push({ k: '箱体区间', v: `${box.lo.toFixed(2)} – ${box.hi.toFixed(2)}，高度 ${(box.height / box.lo * 100).toFixed(1)}%` });
      pts.push({ k: '当前分位', v: `${pos.toFixed(1)}%（0=箱底，100=箱顶）` });

      if (pos > 85) { s -= 12; pts.push({ k: '位置', v: '贴近箱顶，上沿压力临近，突破需放量' }); }
      else if (pos < 15) { s += 12; pts.push({ k: '位置', v: '贴近箱底，下沿支撑临近' }); }
      else if (pos > 50) { s += 6; pts.push({ k: '位置', v: '箱体上半区运行，略偏多' }); }
      else { s -= 6; pts.push({ k: '位置', v: '箱体下半区运行，略偏空' }); }

      // 双底
      const Ls = ctx.zzc.filter(p => p.t === 'L').slice(-2);
      let hasDouble = false;
      if (Ls.length === 2 && Math.abs(Ls[0].p - Ls[1].p) / Ls[0].p < 0.04) {
        hasDouble = true;
        s += 14;
        pts.push({ k: '底部形态', v: `双底雏形：${Ls[0].p.toFixed(2)} 与 ${Ls[1].p.toFixed(2)} 两次探底` });
      }

      // 缺口回补状态
      const gs = ctx.helpers.gaps().slice(-1);
      if (gs.length) {
        const g = gs[0];
        pts.push({ k: '最近缺口', v: `${g.from.toFixed(2)}–${g.to.toFixed(2)}（${g.dir > 0 ? '向上' : '向下'}），距今 ${n - g.i} 日` });
        if (g.dir > 0 && c < g.from) { s -= 10; pts.push({ k: '缺口状态', v: '向上缺口已被回补，短线攻势失败' }); }
      }

      // 突破
      if (c > box.hi) { s += 20; pts.push({ k: '突破', v: `已突破箱顶，量度目标 ${(box.hi + box.height).toFixed(2)}` }); }
      if (c < box.lo) { s -= 20; pts.push({ k: '破位', v: `已跌破箱底，量度目标 ${(box.lo - box.height).toFixed(2)}` }); }

      return {
        score: clamp(s, -100, 100),
        verdict: c > box.hi ? `箱体上破，理论量度目标 ${(box.hi + box.height).toFixed(2)}。`
          : c < box.lo ? `箱体下破，理论量度目标 ${(box.lo - box.height).toFixed(2)}。`
            : `在 ${box.lo.toFixed(2)}–${box.hi.toFixed(2)} 箱体内运行（分位 ${pos.toFixed(0)}%），${hasDouble ? '双底结构提供下方支撑，' : ''}等突破方向。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 11 · 斐波那契
   * ============================================================ */
  QL.registerStrategy({
    id: 'fib', name: '斐波那契', short: 'FIB', color: '#C9A227', sub: 'none',
    desc: '黄金分割回撤与延伸',
    overlay(ctx) {
      const zz = ctx.zz;
      if (zz.length < 2) return [];
      const out = [];
      const a = zz[zz.length - 2], b = zz[zz.length - 1];
      const lo = Math.min(a.p, b.p), hi = Math.max(a.p, b.p);
      const span = hi - lo;
      const up = b.p > a.p; // 上涨段则回撤看支撑
      const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
      const colors = ['rgba(201,162,39,.35)', 'rgba(201,162,39,.55)', 'rgba(201,162,39,.8)', 'rgba(201,162,39,.55)', 'rgba(201,162,39,.35)'];

      out.push({ type: 'line', pts: [[a.i, a.p], [b.i, b.p]], color: 'rgba(201,162,39,.8)', width: 1.6 });
      ratios.forEach((r, k) => {
        const p = up ? hi - span * r : lo + span * r;
        out.push({
          type: 'hline', p, color: colors[k], dash: [4, 4],
          label: `${(r * 100).toFixed(1)}%  ${p.toFixed(2)}`,
        });
      });
      out.push({ type: 'marker', i: a.i, p: a.p, color: '#C9A227', text: '起点', pos: a.t === 'H' ? 'above' : 'below', r: 3 });
      out.push({ type: 'marker', i: b.i, p: b.p, color: '#C9A227', text: '终点', pos: b.t === 'H' ? 'above' : 'below', r: 3 });
      return out;
    },
    analyze(ctx) {
      const zz = ctx.zzc;
      if (zz.length < 2) return { score: 0, verdict: '缺乏有效波段。', points: [] };
      const a = zz[zz.length - 2], b = zz[zz.length - 1];
      const n = ctx.n - 1, c = ctx.data[n].c;
      const lo = Math.min(a.p, b.p), hi = Math.max(a.p, b.p);
      const span = hi - lo;
      const up = b.p > a.p;
      const retr = up ? (hi - c) / span : (c - lo) / span;
      const pts = [];
      let s = 0;

      pts.push({ k: '测算波段', v: `${a.p.toFixed(2)} → ${b.p.toFixed(2)}（${up ? '上涨' : '下跌'} ${(span / lo * 100).toFixed(1)}%）` });
      pts.push({ k: '当前回撤', v: `${(retr * 100).toFixed(1)}%` });

      if (retr < 0.236) { s += up ? 20 : -20; pts.push({ k: '位置', v: '回撤极浅，趋势极强' }); }
      else if (retr < 0.382) { s += up ? 14 : -14; pts.push({ k: '位置', v: '回撤在 23.6%–38.2%，强势整理区' }); }
      else if (retr < 0.5) { s += up ? 6 : -6; pts.push({ k: '位置', v: '回撤至 38.2%–50%，正常调整' }); }
      else if (retr < 0.618) { s -= up ? 6 : -6; pts.push({ k: '位置', v: '回撤至 50%–61.8%，关键抉择区' }); }
      else { s -= up ? 18 : -18; pts.push({ k: '位置', v: '回撤超过 61.8%，原趋势大概率失效' }); }

      const sup = [0.382, 0.5, 0.618].map(r => up ? hi - span * r : lo + span * r);
      pts.push({ k: '关键支撑', v: sup.map(v => v.toFixed(2)).join(' / ') });

      return {
        score: clamp(s, -100, 100),
        verdict: retr < 0.382 ? '回撤浅、趋势强，属强势整理。'
          : retr < 0.618 ? '处于黄金分割关键区，方向选择临近。'
            : '回撤过深，原趋势结构已遭破坏，需重新评估。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 12 · 量价理论
   * ============================================================ */
  QL.registerStrategy({
    id: 'volume', name: '量价理论', short: 'VOL', color: '#6FD3C7', sub: 'obv',
    desc: '量能配合 · OBV · 天量地量',
    overlay(ctx) {
      const out = [];
      const vma = ctx.ind.volMa5;
      // 天量标记：覆盖整个可视范围（原来只扫最近 60 根）
      const vs = ctx.helpers.vspan();
      const cands = [];
      for (let i = Math.max(0, vs.lo); i < vs.hi; i++) {
        if (vma[i] && ctx.data[i].v > vma[i] * 2.1) cands.push({ i });
      }
      for (const { i } of ctx.helpers.spread(cands, 40)) {
        out.push({ type: 'marker', i, p: ctx.data[i].h, color: '#E8B84B', text: '天量', pos: 'above', r: 3 });
      }
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const d = ctx.data[n];
      const vma5 = N(ctx.ind.volMa5, n), vma10 = N(ctx.ind.volMa10, n);
      const vr = vma5 ? d.v / vma5 : 1;
      const pts = [];
      let s = 0;

      pts.push({ k: '当日量', v: `${(d.v / 1e4).toFixed(0)} 万手，为 5 日均量 ${vr.toFixed(2)} 倍` });

      if (vr > 2) { pts.push({ k: '量能状态', v: '显著放量，资金活跃度骤升' }); }
      else if (vr > 1.3) { pts.push({ k: '量能状态', v: '温和放量' }); }
      else if (vr < 0.7) { pts.push({ k: '量能状态', v: '明显缩量，观望情绪浓' }); }
      else { pts.push({ k: '量能状态', v: '量能平稳' }); }

      // 量价配合
      const chg = (d.c - ctx.data[n - 1].c) / ctx.data[n - 1].c * 100;
      if (chg > 0 && vr > 1.2) { s += 20; pts.push({ k: '量价配合', v: '价涨量增，健康上攻' }); }
      else if (chg > 0 && vr < 0.8) { s -= 10; pts.push({ k: '量价配合', v: '价涨量缩，上攻乏力，警惕背离' }); }
      else if (chg < 0 && vr > 1.2) { s -= 20; pts.push({ k: '量价配合', v: '价跌量增，抛压沉重' }); }
      else if (chg < 0 && vr < 0.8) { s += 6; pts.push({ k: '量价配合', v: '价跌量缩，抛压衰减，缩量回调' }); }

      // OBV 趋势
      const obv = ctx.ind.obv;
      const obvNow = N(obv, n), obvPrev = N(obv, Math.max(0, n - 10));
      if (obvNow > obvPrev) { s += 12; pts.push({ k: 'OBV 能量潮', v: '近 10 日 OBV 上行，资金净流入' }); }
      else { s -= 12; pts.push({ k: 'OBV 能量潮', v: '近 10 日 OBV 下行，资金净流出' }); }

      // 天量检测 + 位置
      if (vma5 && d.v > vma5 * 2.1) {
        const nearHigh = d.h > Math.max(...ctx.data.slice(Math.max(0, n - 40), n).map(x => x.h)) * 0.97;
        if (nearHigh) { s -= 14; pts.push({ k: '天量警示', v: '天量出现在阶段高位，谨防天量见天价' }); }
        else { s += 6; pts.push({ k: '天量', v: '天量出现在低位，可能是资金进场' }); }
      }

      // 换手（流通股本取自行情快照，缺失时本条降级，不影响其他维度）
      const fs = ctx.floatShares;
      if (fs && fs > 0) {
        const turn = d.v * 100 / fs * 100;
        pts.push({ k: '换手率', v: `${turn.toFixed(2)}%（流通股 ${(fs / 1e8).toFixed(2)} 亿）` });
        if (turn > 12) pts.push({ k: '筹码', v: '换手极高，短线博弈激烈，波动将放大' });
      } else {
        pts.push({ k: '换手率', v: '行情快照未返回流通股本，换手率一项已跳过' });
      }

      return {
        score: clamp(s, -100, 100),
        verdict: chg > 0 && vr > 1.2 ? '放量上攻，量价配合良好。'
          : chg < 0 && vr > 1.2 ? '放量下跌，资金出逃迹象明显。'
            : vr < 0.8 ? '缩量整理，多空暂时观望。'
              : '量价关系中性，跟随价格方向。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 13 · 筹码分布
   * ============================================================ */
  QL.registerStrategy({
    id: 'chip', name: '筹码分布', short: 'CHIP', color: '#B48CFF', sub: 'vr',
    desc: '成本密集区 · 获利盘 · 套牢区',
    overlay(ctx) {
      const out = [];
      const ch = ctx.helpers.chips();
      if (!ch) return out;
      // 密集区
      out.push({
        type: 'rect', x1: ctx.view.start, x2: ctx.n - 1, p1: ch.low, p2: ch.high,
        fill: 'rgba(180,140,255,.09)', stroke: 'rgba(180,140,255,.45)', width: 1.2,
        label: `70%筹码区 ${ch.low.toFixed(2)}–${ch.high.toFixed(2)}`, color: '#B48CFF',
      });
      out.push({ type: 'hline', p: ch.poc, color: 'rgba(180,140,255,.8)', dash: [5, 3], label: '成本峰 ' + ch.poc.toFixed(2), side: 'right' });
      out.push({ type: 'hline', p: ch.avg, color: 'rgba(180,140,255,.4)', dash: [2, 4], label: '均价 ' + ch.avg.toFixed(2) });
      return out;
    },
    analyze(ctx) {
      const ch = ctx.helpers.chips();
      const n = ctx.n - 1, c = ctx.data[n].c;
      if (!ch) return { score: 0, verdict: '样本不足。', points: [] };
      const pts = [];
      let s = 0;

      const profit = c > ch.avg;
      pts.push({ k: '平均成本', v: `${ch.avg.toFixed(2)}，现价${profit ? '高于' : '低于'}成本 ${Math.abs((c / ch.avg - 1) * 100).toFixed(1)}%` });
      pts.push({ k: '成本峰（POC）', v: `${ch.poc.toFixed(2)}，最密集成交价位` });
      pts.push({ k: '70% 筹码区', v: `${ch.low.toFixed(2)} – ${ch.high.toFixed(2)}` });

      if (c > ch.high) { s += 20; pts.push({ k: '获利状态', v: '价格在 70% 筹码区上方，绝大多数持仓获利，抛压轻' }); }
      else if (c > ch.avg) { s += 10; pts.push({ k: '获利状态', v: '价格高于平均成本，获利盘占比过半' }); }
      else if (c > ch.low) { s -= 8; pts.push({ k: '获利状态', v: '价格低于平均成本，多数持仓亏损' }); }
      else { s -= 18; pts.push({ k: '获利状态', v: '跌破 70% 筹码区，套牢盘密集，反弹遇阻' }); }

      // 上方套牢
      const above = ch.high > c ? (ch.high - c) / c * 100 : 0;
      if (above > 0) pts.push({ k: '上方压力', v: `筹码区上沿距现价 ${above.toFixed(1)}%，为解套抛压区` });

      return {
        score: clamp(s, -100, 100),
        verdict: c > ch.high ? '站上筹码密集区，上方无套牢盘，拉升阻力小。'
          : c > ch.avg ? '成本区上方运行，获利盘为主，注意兑现压力。'
            : '处于成本区下方，套牢盘构成反弹压力。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 14 · 情绪 / 游资
   * ============================================================ */
  QL.registerStrategy({
    id: 'sentiment', name: '情绪博弈', short: 'SENT', color: '#FF6B9D', sub: 'vr',
    desc: '涨停基因 · 换手 · 波动率',
    overlay(ctx) {
      const out = [];
      const rate = limitRate(ctx);
      // 标记涨停日（按板块涨跌幅限制判定，双创 20%、ST 5%），覆盖整个可视范围
      const vs = ctx.helpers.vspan();
      const cands = [];
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) if (isLimitUp(ctx, i, rate)) cands.push({ i });
      for (const { i } of ctx.helpers.spread(cands, 34)) {
        out.push({ type: 'marker', i, p: ctx.data[i].h, color: '#FF6B9D', text: '涨停', pos: 'above', r: 3.4, bold: true });
      }
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const pts = [];
      let s = 0;

      // 近 120 日涨停次数
      let lim = 0;
      const rate = limitRate(ctx);
      for (let i = Math.max(1, n - 120); i <= n; i++) if (isLimitUp(ctx, i, rate)) lim++;
      pts.push({ k: '涨停次数', v: `近 120 个交易日 ${lim} 次涨停` });

      // 波动率 ATR
      const atr = N(ctx.ind.dmi.atr, n);
      const atrPct = atr / ctx.data[n].c * 100;
      pts.push({ k: 'ATR 波动', v: `${atr.toFixed(2)} 元，占股价 ${atrPct.toFixed(1)}%` });
      if (atrPct > 6) { pts.push({ k: '波动等级', v: '极高波动，单日振幅常超 6%' }); }
      else if (atrPct > 4) { pts.push({ k: '波动等级', v: '高波动，适合短线不适合长持' }); }

      // 换手（流通股本取自行情快照，缺失时降级为中性 3% 参与温度计算）
      const fs = ctx.floatShares;
      const turn = (fs && fs > 0) ? ctx.data[n].v * 100 / fs * 100 : null;
      if (turn !== null) {
        pts.push({ k: '当日换手', v: `${turn.toFixed(2)}%（流通股 ${(fs / 1e8).toFixed(2)} 亿）` });
        if (turn > 10) { s -= 8; pts.push({ k: '筹码稳定性', v: '换手过高，筹码松动，游资主导' }); }
        else if (turn < 3) { pts.push({ k: '筹码稳定性', v: '换手低迷，关注度不足' }); }
      } else {
        pts.push({ k: '当日换手', v: '行情快照未返回流通股本，换手率一项已跳过' });
      }

      // 距高点回撤
      let hh = -Infinity, hhI = 0;
      for (let i = Math.max(0, n - 250); i <= n; i++) if (ctx.data[i].h > hh) { hh = ctx.data[i].h; hhI = i; }
      const dd = (ctx.data[n].c - hh) / hh * 100;
      pts.push({ k: '距年内高点', v: `${dd.toFixed(1)}%（高点 ${hh.toFixed(2)}）` });
      if (dd < -40) s += 4;

      // 情绪温度：量比 + 涨停 + 换手（换手缺失时取 3% 中性值）
      const temp = clamp(Math.round((turn === null ? 3 : turn) * 4 + lim * 3 + (atrPct > 5 ? 15 : 0)), 0, 100);
      pts.push({ k: '情绪温度', v: `${temp}/100 ${temp > 70 ? '（亢奋）' : temp > 45 ? '（活跃）' : '（冷淡）'}` });
      s += (temp - 50) * 0.25;

      return {
        score: clamp(s, -100, 100),
        verdict: temp > 70 ? '情绪处于亢奋区，短线机会与风险同时放大，不宜追高。'
          : temp > 45 ? '情绪活跃，适合跟随板块节奏做波段。'
            : '情绪偏冷，缺乏催化，等待放量信号。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 15 · 涨停板（A 股制度特有）
   * 涨跌停 + 连板梯队。晋级概率取自全市场样本回测：
   * 1→2 约 15%、2→3 约 33%、3→4 约 41%、4→5 约 38%，
   * 5 板以上断板后 T+20 中位数约 -20%，所以高位必须反向计分。
   * ============================================================ */
  const IND = global.QLInd;

  function limitRate(ctx) {
    const code = String(ctx.code || '');
    const name = String(ctx.name || '');
    if (/\*?ST/i.test(name)) return 0.05;
    if (/^(30|68)/.test(code)) return 0.20;   // 创业板 / 科创板
    if (/^(4|8|9)/.test(code)) return 0.30;   // 北交所
    return 0.10;
  }
  const boardName = (r) => (r === 0.05 ? 'ST 5%' : r === 0.2 ? '双创 20%' : r === 0.3 ? '北交所 30%' : '主板 10%');

  function isLimitUp(ctx, i, rate) {
    if (i < 1) return false;
    const a = ctx.data[i], b = ctx.data[i - 1];
    if (!b.c) return false;
    if ((a.c - b.c) / b.c >= rate - 0.003) return true;
    // 低价股涨停价四舍五入后涨幅可能不足限制值，用涨停价兜底
    const lim = Math.round(b.c * (1 + rate) * 100) / 100;
    return Math.abs(a.c - lim) < 0.005;
  }
  function limitStreak(ctx, rate) {
    let k = 0;
    for (let i = ctx.n - 1; i >= 1; i--) {
      if (isLimitUp(ctx, i, rate)) k++;
      else break;
    }
    return k;
  }

  QL.registerStrategy({
    id: 'limit', name: '涨停板', short: '涨停', color: '#FF5A5F', sub: 'vol',
    desc: '涨跌停制度 · 连板梯队与晋级概率',
    overlay(ctx) {
      const rate = limitRate(ctx), out = [];
      for (let i = Math.max(1, ctx.view.start); i < ctx.view.end; i++) {
        if (!isLimitUp(ctx, i, rate)) continue;
        const d = ctx.data[i];
        const oneWord = Math.abs(d.h - d.c) < 1e-6 && Math.abs(d.l - d.c) < 1e-6;
        out.push({
          type: 'marker', i, p: d.l, r: 2.4, color: oneWord ? '#FFD166' : '#FF5A5F',
          pos: 'below', text: '板', bold: true,
        });
      }
      return out;
    },
    analyze(ctx) {
      const rate = limitRate(ctx);
      const n = ctx.n - 1;
      const streak = limitStreak(ctx, rate);
      let cnt20 = 0, cnt60 = 0, lastI = -1;
      for (let i = Math.max(1, n - 59); i <= n; i++) {
        if (isLimitUp(ctx, i, rate)) {
          cnt60++;
          if (i >= n - 19) cnt20++;
          lastI = i;
        }
      }
      const c = ctx.last.c;
      let s = 0;
      const pts = [{ k: '涨停阈值', v: `${(rate * 100).toFixed(0)}% · ${boardName(rate)}` }];

      if (streak >= 1) {
        const win = [0, 15, 33, 41, 38][Math.min(streak, 4)];
        s += [0, 10, 18, 20, 8][Math.min(streak, 4)];
        pts.push({ k: '连板状态', v: `${streak} 连板，次日晋级历史概率约 ${win}%` });
      } else if (lastI >= 0) {
        const days = n - lastI;
        pts.push({ k: '连板状态', v: `今日未涨停，距上次涨停 ${days} 个交易日` });
        if (days <= 5) s += 6;
      } else {
        pts.push({ k: '连板状态', v: '近 60 日无涨停' });
      }

      if (streak >= 5) {
        s -= 18;
        pts.push({ k: '断板风险', v: '5 板以上属高位博弈，断板后 20 日收益中位数约 -20%' });
      }

      const low120 = Math.min(...ctx.data.slice(Math.max(0, n - 119), n + 1).map(x => x.l));
      const gain = low120 ? (c - low120) / low120 * 100 : 0;
      if (gain > 70 && streak >= 2) {
        s -= 8;
        pts.push({ k: '累计涨幅', v: `距 120 日低点 +${gain.toFixed(0)}%，加速末端` });
      }

      pts.push({ k: '涨停密度', v: `近 20 日 ${cnt20} 次 / 近 60 日 ${cnt60} 次` });
      if (streak === 0 && cnt20 >= 3) s += 6;

      const verdict = streak >= 5 ? '高位连板，博弈价值下降，断板即撤。'
        : streak >= 3 ? `${streak} 连板处于龙头争夺区，晋级概率最高但波动最大，须设断板止损。`
          : streak === 2 ? '二板确认板，资金开始淘汰赛，看能否分歧转一致。'
            : streak === 1 ? '首板试错区，1→2 历史成功率仅约 15%，不宜重仓。'
              : '当前无连板，缺乏情绪溢价，按普通趋势处理。';

      return { score: clamp(s, -100, 100), verdict, points: pts };
    },
  });

  /* ============================================================
   * 16 · 龙头战法（分歧转一致）
   * 龙头三条件里「时间领先 / 高度领先」需要板块全景，
   * 单票能做的是第三条——分歧验证：开板回封、次日承接、首阴缩量。
   * ============================================================ */
  QL.registerStrategy({
    id: 'dragon', name: '龙头战法', short: '龙头', color: '#FF7A45', sub: 'vol',
    desc: '打板接力 · 分歧转一致与首阴洗盘',
    overlay(ctx) {
      const rate = limitRate(ctx), out = [];
      const n = ctx.n - 1;
      for (let i = n; i >= 1 && i >= n - 45; i--) {
        if (!isLimitUp(ctx, i, rate)) continue;
        const d = ctx.data[i];
        const openBoard = d.l < d.c * (1 - rate * 0.35);
        out.push({
          type: 'label', i, p: d.h, text: openBoard ? '分歧板' : '一致板', dy: -12,
          color: openBoard ? '#FF9F6B' : '#FF5A5F', align: 'center', size: 10,
        });
        break;
      }
      return out;
    },
    analyze(ctx) {
      const rate = limitRate(ctx);
      const n = ctx.n - 1;
      const pts = [];
      let s = 0;
      let lastI = -1;
      for (let i = n; i >= 1 && i >= n - 60; i--) if (isLimitUp(ctx, i, rate)) { lastI = i; break; }
      if (lastI < 0) {
        return { score: 0, verdict: '近 60 日无涨停，不具备龙头属性，按趋势票处理。', points: [{ k: '状态', v: '无涨停记录' }] };
      }

      const d = ctx.data[lastI];
      const openBoard = d.l < d.c * (1 - rate * 0.35);
      s += openBoard ? 12 : 6;
      pts.push({ k: '封板质量', v: openBoard ? `盘中最低 ${d.l.toFixed(2)}，开板后回封（分歧验证通过）` : '全天封死，未经分歧检验' });

      // 首次涨停是否领先（近 60 日最早的一次）
      let firstI = lastI;
      for (let i = Math.max(1, n - 59); i <= lastI; i++) if (isLimitUp(ctx, i, rate)) { firstI = i; break; }
      if (firstI === lastI) { s += 5; pts.push({ k: '时间领先', v: '本轮唯一涨停，属启动日首板' }); }

      const nxt = lastI + 1;
      if (nxt <= n) {
        const up = (ctx.data[nxt].c - d.c) / d.c * 100;
        const vr = d.v ? ctx.data[nxt].v / d.v : 1;
        if (isLimitUp(ctx, nxt, rate)) { s += 16; pts.push({ k: '次日表现', v: '继续涨停，一致加速' }); }
        else if (up > 0) { s += 10; pts.push({ k: '次日表现', v: `收涨 ${up.toFixed(1)}%，量能 ${vr.toFixed(1)}×，承接有效` }); }
        else if (vr > 1.2) { s -= 22; pts.push({ k: '次日表现', v: `放量 ${vr.toFixed(1)}× 收阴 ${up.toFixed(1)}%，分歧失败` }); }
        else { s -= 8; pts.push({ k: '次日表现', v: `缩量收阴 ${up.toFixed(1)}%，观察是否回封` }); }
      } else {
        pts.push({ k: '次日表现', v: '今日即涨停日，待次日验证承接' });
      }

      // 首阴战法：涨停后第一根阴线，缩量且守住 5 日线 → 洗盘
      let firstYin = -1;
      for (let i = lastI + 1; i <= n; i++) if (ctx.data[i].c < ctx.data[i].o) { firstYin = i; break; }
      if (firstYin > 0 && firstYin === n) {
        const volPrev = ctx.data[n - 1].v || 1;
        const shrink = ctx.data[n].v < volPrev * 0.75;
        const holdMa5 = ctx.ind.ma5[n] && ctx.data[n].c > ctx.ind.ma5[n];
        if (shrink && holdMa5) { s += 12; pts.push({ k: '首阴战法', v: '缩量首阴且守住 MA5，多为洗盘' }); }
        else if (!holdMa5) { s -= 8; pts.push({ k: '首阴战法', v: '首阴跌破 MA5，承接转弱' }); }
      }

      return {
        score: clamp(s, -100, 100),
        verdict: s >= 25 ? '分歧后有资金回封，具备龙头相，回踩不破 5 日线可跟。'
          : s <= -15 ? '涨停后承接失败，接力资金撤退，规避反抽。'
            : '涨停效应一般，等待二次分歧验证。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 17 · 资金流 CMF
   * 无 Level-2 数据时，用「收盘在当日区间的位置 × 成交量」衡量净流入，
   * 是主力资金流最稳定的日线替代口径。
   * ============================================================ */
  QL.registerStrategy({
    id: 'cmf', name: '资金流 CMF', short: 'CMF', color: '#35C6A0', sub: 'cmf',
    desc: '收盘位置加权量能 · 主力净流入强度',
    overlay(ctx) {
      const out = [];
      const n = ctx.n - 1;
      const v = ctx.ind.cmf20[n];
      if (v != null && Math.abs(v) > 0.2) {
        out.push({
          type: 'label', i: n, p: ctx.last.c, dy: v > 0 ? -26 : 26,
          text: v > 0 ? '资金强流入' : '资金强流出', color: v > 0 ? '#35C6A0' : '#E4687A', align: 'right', size: 10,
        });
      }
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const c20 = N(ctx.ind.cmf20, n), c5 = N(ctx.ind.cmf5, n), c20p = N(ctx.ind.cmf20, n - 5);
      let s = 0;
      const pts = [{ k: 'CMF(20)', v: `${c20.toFixed(3)}（${c20 > 0.1 ? '净流入' : c20 < -0.1 ? '净流出' : '多空平衡'}）` }];

      if (c20 > 0.15) s += 22;
      else if (c20 > 0.05) s += 10;
      else if (c20 < -0.15) s -= 22;
      else if (c20 < -0.05) s -= 10;

      let days = 0;
      for (let i = n; i >= Math.max(0, n - 20); i--) { if (N(ctx.ind.cmf20, i) > 0) days++; else break; }
      if (days >= 3) { s += Math.min(12, days * 3); pts.push({ k: '连续性', v: `连续 ${days} 日净流入` }); }
      else pts.push({ k: '连续性', v: days ? `连续 ${days} 日净流入` : '今日无净流入' });

      pts.push({ k: '短期动能', v: `CMF(5) ${c5.toFixed(3)}，较 5 日前 ${(c20 - c20p >= 0 ? '+' : '') + (c20 - c20p).toFixed(3)}` });

      // 量价背离：价格 20 日新高但资金流未同步
      let hiP = -Infinity, hiI = n;
      for (let i = Math.max(0, n - 20); i <= n; i++) if (ctx.data[i].h > hiP) { hiP = ctx.data[i].h; hiI = i; }
      const cmfAtHi = N(ctx.ind.cmf20, hiI);
      if (hiI >= n - 2 && c20 < cmfAtHi * 0.6 && c20 > 0) {
        s -= 10;
        pts.push({ k: '背离', v: '价格创新高但资金流强度衰减，警惕量价背离' });
      }

      return {
        score: clamp(s, -100, 100),
        verdict: c20 > 0.12 ? '资金持续净流入，回调属洗盘性质。'
          : c20 < -0.12 ? '资金持续净流出，反弹缺乏承接。'
            : '资金多空均衡，等待方向选择。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 18 · 换手率
   * 换手率是 A 股情绪温度计：低位放量换手＝吸筹，高位巨换手＝派发。
   * ============================================================ */
  QL.registerStrategy({
    id: 'turn', name: '换手率', short: '换手', color: '#5AC8FA', sub: 'turn',
    desc: '筹码交换速度 · 活跃度与位置匹配',
    overlay(ctx) { return []; },
    analyze(ctx) {
      const n = ctx.n - 1;
      if (!ctx.floatShares) {
        return { score: 0, verdict: '缺少流通股本数据，换手率分析已跳过（不影响其他流派评分）。', points: [{ k: '数据', v: '行情快照未返回流通股本（floatShares）' }] };
      }
      const t = N(ctx.ind.turn, n), ma5 = N(ctx.ind.turnMa5, n), ma20 = N(ctx.ind.turnMa20, n);
      const dev = ma20 ? t / ma20 : 1;
      const pos = IND.rankPct(ctx.data.map(x => x.c), n, 250) || 50;
      let s = 0;
      const pts = [
        { k: '今日换手', v: `${t.toFixed(2)}%` },
        { k: '5 / 20 日均', v: `${ma5.toFixed(2)}% / ${ma20.toFixed(2)}%` },
        { k: '换手乖离', v: `${dev.toFixed(2)}×（20 日均量口径）` },
        { k: '价格分位', v: `${pos.toFixed(0)}%（近 250 日）` },
      ];

      if (t < 1) { s += pos < 40 ? 8 : -4; pts.push({ k: '活跃度', v: '换手低于 1%，交投清淡' }); }
      else if (t <= 3) { s += 4; pts.push({ k: '活跃度', v: '换手 1–3%，温和' }); }
      else if (t <= 8) { s += pos < 70 ? 8 : -2; pts.push({ k: '活跃度', v: '换手 3–8%，资金关注度良好' }); }
      else if (t <= 15) { s += pos < 50 ? 6 : -6; pts.push({ k: '活跃度', v: '换手 8–15%，偏热' }); }
      else { s -= 12; pts.push({ k: '活跃度', v: '换手超 15%，分歧剧烈' }); }

      if (pos < 35 && t >= 3 && dev > 1.4) {
        const stable = (ctx.ind.ma20[n] && ctx.last.c > ctx.ind.ma20[n]) || ctx.last.c > ctx.data[n - 1].c;
        if (stable) { s += 14; pts.push({ k: '量价位置', v: '低位放量换手且价格企稳，吸筹特征' }); }
        else { s += 2; pts.push({ k: '量价位置', v: '低位高换手但仍在下跌，警惕恐慌抛售' }); }
      }
      if (pos > 80 && t >= 15) { s -= 14; pts.push({ k: '量价位置', v: '高位巨换手，派发风险' }); }
      if (pos > 85 && t > 25) { s -= 8; }

      return {
        score: clamp(s, -100, 100),
        verdict: pos < 40 && t >= 3 ? '低位换手抬升，典型吸筹形态。'
          : pos > 80 && t >= 15 ? '高位巨量换手，警惕主力派发。'
            : '换手处于常态区间，跟随趋势即可。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 19 · 缺口理论
   * 12 年 A 股 45 万次缺口样本：整体方向正确率仅 51%，
   * 唯一显著跑赢的是「放量突破 + 三日不补」（胜率约 60%）。
   * ============================================================ */
  QL.registerStrategy({
    id: 'gap', name: '缺口理论', short: '缺口', color: '#FFC53D', sub: 'vol',
    desc: '四类缺口分类 · 三日不补确认',
    overlay(ctx) {
      const out = [];
      const gs = ctx.helpers.gaps().filter(g => g.i >= ctx.n - 90);
      const right = Math.max(ctx.view.end - 1, ctx.n - 1);
      for (const g of gs) {
        let filled = false;
        for (let j = g.i + 1; j < ctx.n; j++) {
          if (g.dir === 1 ? ctx.data[j].l <= g.from : ctx.data[j].h >= g.from) { filled = true; break; }
        }
        if (filled) continue;
        const up = g.dir === 1;
        // 未回补缺口向右延伸成一条「支撑/压力带」
        out.push({
          type: 'rect', x1: g.i, x2: right, p1: g.from, p2: g.to,
          fill: up ? 'rgba(246,70,93,.07)' : 'rgba(46,189,133,.07)',
          stroke: up ? 'rgba(246,70,93,.28)' : 'rgba(46,189,133,.28)',
          width: 1, dash: [3, 3],
        });
        out.push({
          type: 'label', i: right, p: (g.from + g.to) / 2, text: '未补缺口',
          color: up ? '#E4687A' : '#3ED49A', align: 'right', size: 9.5,
        });
      }
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const gs = ctx.helpers.gaps().filter(g => g.i >= n - 60);
      const pts = [];
      let s = 0;
      if (!gs.length) {
        return { score: 0, verdict: '近 60 日无有效缺口，价格连续，无跳空筹码真空。', points: [{ k: '缺口', v: '无' }] };
      }
      const g = gs[gs.length - 1];
      const d = ctx.data[g.i];
      const prev = ctx.data[g.i - 1];
      const vr = prev.v ? d.v / (ctx.ind.volMa5[g.i - 1] || prev.v) : 1;
      let filled = false, fillDay = -1, fillWithin3 = false;
      for (let j = g.i + 1; j <= n; j++) {
        const hit = g.dir === 1 ? ctx.data[j].l <= g.from : ctx.data[j].h >= g.from;
        if (hit) {
          filled = true; fillDay = j - g.i;
          if (fillDay <= 3) fillWithin3 = true;
          break;
        }
      }
      // 三日确认：先看前 3 日有没有回补，再看观察窗口是否走完
      const threeHold = fillWithin3 ? false : (n < g.i + 3 ? null : true);
      const hh20 = IND.HHV(ctx.data.map(x => x.h), 20);
      const breakaway = g.dir === 1 && hh20[g.i - 1] != null && g.to > hh20[g.i - 1] && vr >= 1.5;
      const pos = IND.rankPct(ctx.data.map(x => x.c), g.i, 250) || 50;
      const type = breakaway ? '突破缺口' : pos > 80 ? '高位缺口' : '普通缺口';

      pts.push({ k: '最近缺口', v: `${g.dir === 1 ? '向上' : '向下'} ${g.from.toFixed(2)}–${g.to.toFixed(2)}（${(Math.abs(g.to - g.from) / g.from * 100).toFixed(2)}%），${n - g.i} 日前` });
      pts.push({ k: '量能确认', v: `${vr.toFixed(2)}× 5 日均量${vr >= 1.5 ? '，放量' : '，未放量'}` });
      pts.push({ k: '缺口性质', v: `${type}｜${threeHold === null ? '形成不足 3 日，确认中' : threeHold ? '三日未回补' : '三日内已回补'}${filled ? `，第 ${fillDay} 日回补` : '，目前仍未回补'}` });

      if (g.dir === 1) {
        if (breakaway && threeHold === true) { s += 24; pts.push({ k: '结论', v: '放量突破 + 三日不补，历史胜率约 60%' }); }
        else if (breakaway && threeHold === null) { s += 10; pts.push({ k: '结论', v: '放量突破缺口刚形成，等三日确认' }); }
        else if (breakaway) { s += 6; pts.push({ k: '结论', v: '突破缺口但已被回补，强度打折' }); }
        else if (!filled) { s += 8; pts.push({ k: '结论', v: '缺口未回补，构成下方支撑' }); }
        else { s -= 4; pts.push({ k: '结论', v: '普通缺口已回补，参考价值有限' }); }
      } else {
        if (!filled) { s -= 14; pts.push({ k: '结论', v: '向下缺口未回补，构成上方压力' }); }
        else { s += 4; pts.push({ k: '结论', v: '向下缺口已回补，压力解除' }); }
      }

      return {
        score: clamp(s, -100, 100),
        verdict: g.dir === 1 && breakaway && threeHold ? '放量突破缺口三日未补，缺口下沿即止损位，回踩不破可跟。'
          : g.dir === 1 ? '缺口强度一般，等回踩缺口上沿确认支撑。'
            : '上方存在未补向下缺口，反弹到缺口区间注意压力。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 20 · 周线共振
   * 日线易被骗线，周线量能造假成本极高；
   * 大周期定方向、小周期找买点，是 A 股胜率最稳的多周期框架。
   * ============================================================ */
  QL.registerStrategy({
    id: 'weekly', name: '周线共振', short: '周线', color: '#8BC34A', sub: 'none',
    desc: '周线定方向 · 日线定买点',
    overlay(ctx) {
      const W = ctx.week;
      if (!W || W.n < 25) return [];
      const m20 = W.ma20[W.n - 1], m60 = W.ma60[W.n - 1];
      const out = [];
      if (m20) out.push({ type: 'hline', p: m20, color: 'rgba(139,195,74,.55)', dash: [6, 4], label: '20 周线 ' + m20.toFixed(2) });
      if (m60) out.push({ type: 'hline', p: m60, color: 'rgba(139,195,74,.28)', dash: [3, 5], label: '60 周线 ' + m60.toFixed(2) });
      return out;
    },
    analyze(ctx) {
      const W = ctx.week;
      const n = ctx.n - 1;
      if (!W || W.n < 30) {
        return { score: 0, verdict: '周线数据不足，无法做多周期共振判断。', points: [{ k: '数据', v: `仅 ${W ? W.n : 0} 根周线` }] };
      }
      const i = W.n - 1;
      const cW = W.c[i], m5 = W.ma5[i], m10 = W.ma10[i], m20 = W.ma20[i], m60 = W.ma60[i];
      const slope = W.ma20[i - 4] != null ? (m20 - W.ma20[i - 4]) / W.ma20[i - 4] * 100 : 0;
      const bull = cW > m20 && m20 > m60 && m5 > m10;
      const bear = cW < m20 && m20 < m60;
      let s = 0;
      const pts = [
        { k: '周线收盘', v: `${cW.toFixed(2)}，20 周线 ${m20.toFixed(2)}（${cW > m20 ? '站上' : '跌破'}）` },
        { k: '周线排列', v: bull ? '5>10>20>60，多头排列' : bear ? '空头排列' : '均线交织' },
        { k: '20 周线斜率', v: `${slope >= 0 ? '+' : ''}${slope.toFixed(2)}%（近 4 周）` },
      ];
      if (bull) s += 22;
      if (bear) s -= 24;
      if (slope > 0.5) s += 8;
      if (slope < -0.5) s -= 8;

      const c = ctx.last.c, m20d = ctx.ind.ma20[n], m10d = ctx.ind.ma10[n];
      if (c > m20d) s += 8;
      else s -= 8;
      pts.push({ k: '日线站位', v: `收盘 ${c.toFixed(2)}，MA20 ${m20d ? m20d.toFixed(2) : '—'}` });

      // 日线缩量回踩周线支撑
      const near = m10d && m20d && Math.abs(c - m20d) / m20d < 0.02;
      const shrink = ctx.ind.volMa5[n] && ctx.last.v < ctx.ind.volMa5[n] * 0.85;
      if (near && shrink && c > m20d) { s += 10; pts.push({ k: '买点结构', v: '日线缩量回踩 MA20 不破，符合周线共振买点' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: bull ? '周线多头成立，日线回踩即是低吸窗口。'
          : bear ? '周线空头，日线金叉多为反弹，不宜逆势。'
            : '周线方向未明，等待 20 周线走平上翘。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 21 · 唐奇安通道（海龟）
   * A 股个股实证：55 日突破弱于 20 日，且必须叠加 ADX 过滤，
   * 否则震荡市假突破极多。
   * ============================================================ */
  QL.registerStrategy({
    id: 'donchian', name: '唐奇安通道', short: '海龟', color: '#4DD0E1', sub: 'dmi',
    desc: '20/55 日通道突破 · ATR 止损',
    overlay(ctx) {
      const { ch20, dmi } = ctx.ind;
      const out = [];
      const ptsU = [], ptsD = [];
      for (let i = ctx.view.start; i < ctx.view.end; i++) {
        if (ch20.up[i] != null) ptsU.push([i, ch20.up[i]]);
        if (ch20.dn[i] != null) ptsD.push([i, ch20.dn[i]]);
      }
      if (ptsU.length > 1) {
        out.push({ type: 'line', pts: ptsU, color: 'rgba(77,208,225,.85)', width: 1.3 });
        out.push({ type: 'line', pts: ptsD, color: 'rgba(77,208,225,.85)', width: 1.3 });
      }
      const n = ctx.n - 1;
      const atr = dmi.atr[n];
      if (atr) out.push({ type: 'hline', p: ctx.last.c - 2 * atr, color: 'rgba(228,104,122,.6)', dash: [4, 4], label: '2N 止损 ' + (ctx.last.c - 2 * atr).toFixed(2) });
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const { ch20, ch55, dmi } = ctx.ind;
      const up = N(ch20.up, n), dn = N(ch20.dn, n), mid = N(ch20.mid, n);
      const upPrev = N(ch20.up, n - 1);
      const up55 = N(ch55.up, n), dn55 = N(ch55.dn, n);
      const c = ctx.last.c;
      if (!up || !dn || up <= dn) {
        return { score: 0, verdict: '上市时间不足 20 个交易日，通道尚未形成。', points: [{ k: '数据', v: '历史数据不足' }] };
      }
      const pos = (c - dn) / (up - dn);
      const width = (up - dn) / c * 100;
      const adx = N(dmi.adx, n), pdi = N(dmi.pdi, n), mdi = N(dmi.mdi, n);
      const atr = N(dmi.atr, n);
      let s = 0;
      const pts = [
        { k: '通道位置', v: `${(pos * 100).toFixed(0)}%（下轨 ${dn.toFixed(2)} / 上轨 ${up.toFixed(2)}）` },
        { k: '通道宽度', v: `${width.toFixed(1)}%（20 日波动区间）` },
        { k: 'ADX / DI', v: `${adx.toFixed(1)}，+DI ${pdi.toFixed(1)} / -DI ${mdi.toFixed(1)}` },
      ];

      const broke = upPrev != null && c > upPrev;
      if (broke && adx > 20 && pdi > mdi) { s += 22; pts.push({ k: '突破', v: '收盘突破 20 日上轨且趋势强度达标' }); }
      else if (broke) { s += 4; pts.push({ k: '突破', v: '突破上轨但 ADX 不足，假突破概率高' }); }
      else if (c < dn) { s -= 25; pts.push({ k: '破位', v: '跌破 20 日下轨，趋势转弱' }); }

      if (c > up55) { s += 8; pts.push({ k: '55 日通道', v: '站上 55 日上轨，中长期趋势确认' }); }
      if (c < dn55) { s -= 10; pts.push({ k: '55 日通道', v: '跌破 55 日下轨' }); }
      if (width < 12) { s += 3; pts.push({ k: '波动压缩', v: '通道收窄，变盘临近' }); }
      if (pos > 0.85 && adx < 18) { s -= 5; pts.push({ k: '假突破风险', v: '贴近上轨但 ADX 低，易冲高回落' }); }
      if (atr) pts.push({ k: 'ATR 止损', v: `${(2 * atr).toFixed(2)} 元（${(2 * atr / c * 100).toFixed(1)}%）` });

      return {
        score: clamp(s, -100, 100),
        verdict: broke && adx > 20 ? '通道突破 + 趋势强度确认，回踩上轨可加仓，止损 2N。'
          : c < dn ? '跌破通道下轨，趋势跟踪系统应离场。'
            : `通道内运行（${(pos * 100).toFixed(0)}% 位置），等突破再做。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 22 · 一目均衡表
   * 云层＝多空分界，转换/基准线提供短中期节奏，适合判断「站在云上还是云下」。
   * ============================================================ */
  QL.registerStrategy({
    id: 'ichimoku', name: '一目均衡表', short: '云图', color: '#C6A8FF', sub: 'none',
    desc: '云层支撑压力 · 转换线与基准线',
    overlay(ctx) {
      const { ichi } = ctx.ind;
      const out = [];
      // 云层：逐根竖条填充，A/B 交叉时不会出现多边形自交
      let lo = Infinity, hi = -Infinity;
      for (let i = ctx.view.start; i < ctx.view.end; i++) {
        if (ctx.data[i].l < lo) lo = ctx.data[i].l;
        if (ctx.data[i].h > hi) hi = ctx.data[i].h;
      }
      for (let i = Math.max(0, ctx.view.start); i < ctx.view.end; i++) {
        const A = ichi.spanA[i], B = ichi.spanB[i];
        if (A == null || B == null) continue;
        const top = Math.max(A, B), bot = Math.min(A, B);
        // 远离价格区的云层不画，避免把主图纵轴压扁
        if (bot > hi * 1.12 || top < lo * 0.88) continue;
        out.push({
          type: 'rect', x1: i, x2: i + 1, p1: bot, p2: top, noRange: true,
          fill: A >= B ? 'rgba(246,70,93,.10)' : 'rgba(46,189,133,.10)',
        });
      }
      const t = [], k = [], sa = [], sb = [];
      for (let i = ctx.view.start; i < ctx.view.end; i++) {
        if (ichi.tenkan[i] != null) t.push([i, ichi.tenkan[i]]);
        if (ichi.kijun[i] != null) k.push([i, ichi.kijun[i]]);
        if (ichi.spanA[i] != null) sa.push([i, ichi.spanA[i]]);
        if (ichi.spanB[i] != null) sb.push([i, ichi.spanB[i]]);
      }
      if (sa.length > 1) out.push({ type: 'line', pts: sa, color: 'rgba(255,143,177,.55)', width: 1, dash: [4, 3] });
      if (sb.length > 1) out.push({ type: 'line', pts: sb, color: 'rgba(111,211,199,.55)', width: 1, dash: [4, 3] });
      if (t.length > 1) out.push({ type: 'line', pts: t, color: '#C6A8FF', width: 1.3 });
      if (k.length > 1) out.push({ type: 'line', pts: k, color: '#7FB0FF', width: 1.3 });
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const { tenkan, kijun, spanA, spanB } = ctx.ind.ichi;
      const c = ctx.last.c;
      const T = N(tenkan, n), K = N(kijun, n), A = N(spanA, n), B = N(spanB, n);
      if (T == null || K == null || A == null || B == null) {
        return { score: 0, verdict: '数据不足以形成完整云层（需 52 根以上）。', points: [] };
      }
      const top = Math.max(A, B), bot = Math.min(A, B);
      let s = 0;
      const pts = [
        { k: '转换 / 基准', v: `${T.toFixed(2)} / ${K.toFixed(2)}` },
        { k: '云层区间', v: `${bot.toFixed(2)} – ${top.toFixed(2)}（${A >= B ? '红云' : '绿云'}）` },
      ];
      if (c > top) { s += 20; pts.push({ k: '价格位置', v: '价格在云层之上，多头结构' }); }
      else if (c < bot) { s -= 20; pts.push({ k: '价格位置', v: '价格在云层之下，空头结构' }); }
      else { pts.push({ k: '价格位置', v: '价格陷入云层，方向不明' }); }

      if (T > K) { s += 8; pts.push({ k: '转换线', v: '转换线在基准线上方（短期强于中期）' }); }
      else { s -= 8; pts.push({ k: '转换线', v: '转换线在基准线下方' }); }
      if (A > B) s += 4; else s -= 4;

      const thick = (top - bot) / c * 100;
      if (c > top && thick > 3) { s += 6; pts.push({ k: '云层厚度', v: `${thick.toFixed(1)}%，厚云支撑强` }); }

      return {
        score: clamp(s, -100, 100),
        verdict: c > top ? '站上云层，回踩云顶是买点，跌破云底转空。'
          : c < bot ? '跌破云层，反弹到云底即压力。'
            : '价格在云中，等突破云顶或跌破云底。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 23 · 相对强弱 RS（对比上证指数）
   * 欧奈尔 CANSLIM 的 RPS>80 思路：买「比别人强」而不是「涨得好」。
   * ============================================================ */
  QL.registerStrategy({
    id: 'rs', name: '相对强弱 RS', short: 'RS', color: '#FF7EB6', sub: 'rs',
    desc: '个股 / 上证指数 · 超额收益曲线',
    overlay(ctx) {
      if (!ctx.rs) return [];
      const n = ctx.n - 1;
      let hi = -Infinity, hiI = n;
      for (let i = Math.max(0, n - 60); i <= n; i++) if (ctx.rs[i] > hi) { hi = ctx.rs[i]; hiI = i; }
      if (hiI >= n - 2) {
        return [{ type: 'marker', i: hiI, p: ctx.data[hiI].h, r: 3, color: '#FF7EB6', text: 'RS 新高', pos: 'above', bold: true }];
      }
      return [];
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      if (!ctx.rs) {
        return { score: 0, verdict: '基准指数数据缺失，相对强弱暂不可用。', points: [{ k: '数据', v: '未取到上证指数' }] };
      }
      const r = N(ctx.rs, n);
      if (r == null) {
        return { score: 0, verdict: '基准指数与个股日期未对齐，相对强弱暂不可用。', points: [{ k: '数据', v: '日期对齐失败' }] };
      }
      const rMa = N(ctx.rsMa20, n, r), r20 = N(ctx.rs, n - 20, r);
      let hi = -Infinity;
      for (let i = Math.max(0, n - 59); i <= n; i++) if (ctx.rs[i] > hi) hi = ctx.rs[i];
      let s = 0;
      const pts = [
        { k: 'RS 值', v: r.toFixed(2) },
        { k: 'RS vs 20 日', v: `${(r / rMa * 100 - 100 >= 0 ? '+' : '')}${(r / rMa * 100 - 100).toFixed(2)}%` },
      ];
      if (r >= hi * 0.999) { s += 20; pts.push({ k: '强度', v: 'RS 创 60 日新高，跑赢大盘' }); }
      if (r > rMa) s += 10; else s -= 8;
      const chg20 = r20 ? (r / r20 - 1) * 100 : 0;
      if (chg20 > 3) { s += 8; pts.push({ k: '20 日强度', v: `RS ${chg20 >= 0 ? '+' : ''}${chg20.toFixed(2)}%，超额收益扩张` }); }
      if (chg20 < -3) { s -= 8; pts.push({ k: '20 日强度', v: `RS ${chg20.toFixed(2)}%，跑输大盘` }); }

      const bi = ctx.bench[n], bma = N(ctx.benchMa200, n);
      const idxUp = bma && bi > bma;
      if (ctx.benchOk && bma) {
        s += idxUp ? 6 : -6;
        pts.push({ k: '大盘环境', v: `上证 ${bi ? bi.toFixed(0) : '—'}，${idxUp ? '在 200 日线上方' : '在 200 日线下方'}` });
      }

      return {
        score: clamp(s, -100, 100),
        verdict: r >= hi * 0.999 ? '相对强度创新高，属于市场领涨梯队。'
          : r > rMa ? '跑赢大盘但未创新高，保持关注。'
            : '弱于大盘，反弹时优先换股。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 24 · 量能周期
   * 地量见地价、天量见天价：成交量分位比绝对量更可靠。
   * ============================================================ */
  QL.registerStrategy({
    id: 'volcycle', name: '量能周期', short: '量能', color: '#7ED957', sub: 'vol',
    desc: '地量 / 天量分位 · 变盘窗口',
    overlay(ctx) { return []; },
    analyze(ctx) {
      const n = ctx.n - 1;
      const vr = ctx.ind.volMa5[n] ? ctx.last.v / ctx.ind.volMa5[n] : 1;
      const vp = IND.rankPct(ctx.data.map(x => x.v), n, 120) || 50;
      const pp = IND.rankPct(ctx.data.map(x => x.c), n, 250) || 50;
      const chg = ctx.data[n - 1].c ? (ctx.last.c / ctx.data[n - 1].c - 1) * 100 : 0;
      let s = 0;
      const pts = [
        { k: '量能分位', v: `${vp.toFixed(0)}%（近 120 日）` },
        { k: '量比', v: `${vr.toFixed(2)}× 5 日均量` },
        { k: '价格分位', v: `${pp.toFixed(0)}%（近 250 日）` },
        { k: '今日涨跌', v: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` },
      ];

      // 光看分位不够：地量要同时「缩量」，天量要同时「放量」，否则只是基数效应
      const dry = vp < 12 && vr < 0.9;
      const huge = vp > 90 && vr > 1.2;
      if (dry) { s += pp < 45 ? 10 : 2; pts.push({ k: '量能状态', v: '地量，卖压衰竭' }); }
      if (huge) pts.push({ k: '量能状态', v: '天量，分歧极大' });

      if (dry && vr > 1.6 && chg > 1) { s += 18; pts.push({ k: '转向信号', v: '地量后放量收阳，底部确认' }); }
      if (huge && pp > 80 && chg < 0.5) { s -= 20; pts.push({ k: '风险信号', v: '高位天量滞涨，主力派发' }); }
      else if (huge && pp > 80) { s -= 8; pts.push({ k: '风险信号', v: '高位放量，注意兑现' }); }
      if (vr > 1.2 && vr < 2.2 && chg > 0) { s += 8; pts.push({ k: '健康放量', v: '温和放量上涨' }); }
      if (vr < 0.6 && pp > 75) { s -= 6; pts.push({ k: '缩量滞涨', v: '高位缩量，接力不足' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: dry ? '量能枯竭，等待放量阳线确认方向，不提前埋伏。'
          : huge && pp > 80 ? '高位天量，分歧最大处，优先减仓。'
            : '量能温和，趋势延续概率较高。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 25 · ADX 趋势强度
   * 券商金工把 20 日 ADX 列为有效择时指标：先判断「有没有趋势」，
   * 再决定用趋势策略还是震荡策略。
   * ============================================================ */
  QL.registerStrategy({
    id: 'adx', name: 'ADX 趋势强度', short: 'ADX', color: '#F2A65A', sub: 'dmi',
    desc: '趋势有无 · +DI/-DI 方向',
    overlay(ctx) { return []; },
    analyze(ctx) {
      const n = ctx.n - 1;
      const { pdi, mdi, adx } = ctx.ind.dmi;
      const a = N(adx, n), p = N(pdi, n), m = N(mdi, n), a5 = N(adx, n - 5);
      let s = 0;
      const pts = [
        { k: 'ADX', v: `${a.toFixed(1)}（${a > 25 ? '趋势明确' : a > 18 ? '趋势形成中' : '无趋势/震荡'}）` },
        { k: '+DI / -DI', v: `${p.toFixed(1)} / ${m.toFixed(1)}` },
        { k: 'ADX 变化', v: `${a5 != null ? (a - a5 >= 0 ? '+' : '') + (a - a5).toFixed(1) + '（5 日）' : '—'}` },
      ];
      if (a > 25 && p > m) { s += 20; pts.push({ k: '方向', v: '强上升趋势' }); }
      else if (a > 25 && m > p) { s -= 20; pts.push({ k: '方向', v: '强下降趋势' }); }
      else if (a > 18) { s += p > m ? 8 : -8; pts.push({ k: '方向', v: p > m ? '趋势初步向上' : '趋势初步向下' }); }
      else { pts.push({ k: '方向', v: '震荡市，趋势策略失效' }); }
      if (a5 != null && a > a5 && p > m) s += 5;
      if (a5 != null && a > a5 && m > p) s -= 5;

      return {
        score: clamp(s, -100, 100),
        verdict: a < 18 ? 'ADX 低于 18，典型震荡，均线金叉多为噪音。'
          : p > m ? `ADX ${a.toFixed(0)}，上升趋势成立，顺势持有。`
            : `ADX ${a.toFixed(0)}，下降趋势成立，反弹减仓。`,
        points: pts,
      };
    },
  });

  /* ============================================================
   * 26 · 乖离率 BIAS
   * 券商金工择时体系里 20 日乖离率是有效因子：
   * 偏离均线太远必然回归，极端值反而是反向信号。
   * ============================================================ */
  QL.registerStrategy({
    id: 'bias', name: '乖离率 BIAS', short: 'BIAS', color: '#63C7FF', sub: 'bias',
    desc: '均线回归 · 超买超卖分位',
    overlay(ctx) {
      const out = [];
      const m = ctx.ind.ma20[ctx.n - 1];
      if (m) out.push({ type: 'hline', p: m * 1.1, color: 'rgba(246,70,93,.35)', dash: [3, 4], label: '+10% 超买' });
      if (m) out.push({ type: 'hline', p: m * 0.9, color: 'rgba(46,189,133,.35)', dash: [3, 4], label: '-10% 超跌' });
      return out;
    },
    analyze(ctx) {
      const n = ctx.n - 1;
      const b6 = N(ctx.ind.bias6, n), b12 = N(ctx.ind.bias12, n), b24 = N(ctx.ind.bias24, n);
      const rank = IND.rankPct(ctx.ind.bias24, n, 250) || 50;
      let s = 0;
      const pts = [
        { k: 'BIAS 6/12/24', v: `${b6.toFixed(2)}% / ${b12.toFixed(2)}% / ${b24.toFixed(2)}%` },
        { k: '24 日乖离分位', v: `${rank.toFixed(0)}%（近 250 日）` },
      ];
      if (b6 < -10) { s += 16; pts.push({ k: '短线', v: '6 日乖离低于 -10%，超跌反弹概率上升' }); }
      else if (b6 > 12) { s -= 14; pts.push({ k: '短线', v: '6 日乖离高于 +12%，追高风险大' }); }
      else if (b6 > 6) { s -= 4; }
      else if (b6 < -6) { s += 4; }

      if (rank > 92) { s -= 10; pts.push({ k: '中期', v: '24 日乖离处于历史高位，均值回归压力' }); }
      if (rank < 8) { s += 10; pts.push({ k: '中期', v: '24 日乖离处于历史低位，向下空间有限' }); }

      return {
        score: clamp(s, -100, 100),
        verdict: rank > 90 ? '偏离均线过远，短期回调压力大。'
          : rank < 10 ? '负乖离极端，具备技术性反弹条件。'
            : '乖离处于正常区间，跟随趋势。',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 27 · K 线形态（单根/组合）
   * 只看最近三根，识别锤子、吞没、射击之星、红三兵等 A 股常见短线信号。
   * ============================================================ */
  QL.registerStrategy({
    id: 'candle', name: 'K 线形态', short: 'K线', color: '#E6B980', sub: 'vol',
    desc: '锤子 / 吞没 / 射击之星 / 红三兵',
    overlay(ctx) {
      const out = [];
      const n = ctx.n - 1;
      const sig = candleSignals(ctx);
      if (sig.length) {
        out.push({ type: 'marker', i: n, p: ctx.last.h, r: 3, color: sig[0].bull ? '#F6465D' : '#2EBD85', text: sig[0].name, pos: 'above', bold: true });
      }
      return out;
    },
    analyze(ctx) {
      const sig = candleSignals(ctx);
      let s = 0;
      const pts = sig.map(x => ({ k: x.name, v: x.note }));
      for (const x of sig) s += x.score;
      if (!sig.length) pts.push({ k: '形态', v: '近 3 根无典型形态' });

      return {
        score: clamp(s, -100, 100),
        verdict: !sig.length ? 'K 线无明确信号，等形态与量能共振。'
          : s > 0 ? '出现偏多 K 线组合，可结合量能择机。'
            : '出现偏空 K 线组合，注意短线回撤。',
        points: pts,
      };
    },
  });

  function candleSignals(ctx) {
    const n = ctx.n - 1, out = [];
    const d = ctx.data[n], p = ctx.data[n - 1], p2 = ctx.data[n - 2];
    if (!d || !p || !p2) return out;
    const body = Math.abs(d.c - d.o), rng = d.h - d.l || 1e-6;
    const upS = d.h - Math.max(d.c, d.o), dnS = Math.min(d.c, d.o) - d.l;
    const bull = d.c >= d.o;
    const chg = p.c ? (d.c / p.c - 1) * 100 : 0;
    const vr = ctx.ind.volMa5[n] ? d.v / ctx.ind.volMa5[n] : 1;

    if (dnS > body * 2 && upS < body * 0.8 && chg < 1) {
      out.push({ name: '锤子线', note: `下影 ${dnS.toFixed(2)} 为实体 ${body.toFixed(2)} 的 ${(dnS / (body || 1)).toFixed(1)} 倍，下方有承接`, score: 8, bull: true });
    }
    if (upS > body * 2 && dnS < body * 0.6) {
      out.push({ name: '射击之星', note: '长上影且实体小，上方抛压明显', score: -8, bull: false });
    }
    if (p.c < p.o && bull && d.o <= p.c && d.c >= p.o && body > Math.abs(p.c - p.o)) {
      out.push({ name: '看涨吞没', note: '阳线完全吞没前一根阴线，反转信号', score: 10, bull: true });
    }
    if (p.c > p.o && !bull && d.o >= p.c && d.c <= p.o && body > Math.abs(p.c - p.o)) {
      out.push({ name: '看跌吞没', note: '阴线吞没前一根阳线', score: -10, bull: false });
    }
    if (body / rng < 0.12) {
      out.push({ name: '十字星', note: '多空平衡，等待方向选择', score: 0, bull: true });
    }
    const threeBull = p2.c > p2.o && p.c > p.o && d.c > d.o && d.c > p.c && p.c > p2.c;
    if (threeBull) out.push({ name: '红三兵', note: '三连阳且重心抬升，多头延续', score: 8, bull: true });
    const threeBear = p2.c < p2.o && p.c < p.o && d.c < d.o && d.c < p.c && p.c < p2.c;
    if (threeBear) out.push({ name: '三只乌鸦', note: '三连阴重心下移', score: -8, bull: false });
    if (chg > 4 && vr > 1.5 && (d.c - d.l) / rng > 0.7) {
      out.push({ name: '放量长阳', note: `涨 ${chg.toFixed(1)}%，量能 ${vr.toFixed(1)}×，收在高位`, score: 10, bull: true });
    }
    return out;
  }

  /* ============================================================
   * 28 · 金坑战法（低位共振 · 通达信副图体系）
   *
   * 原文是一组高密度副图指标，核心不是单个信号，而是一条链路：
   *   ① 黑夜之眼：周线 KD 金叉且 D < 60 —— 先定"这是低位"
   *   ② 游资进场：涨幅 >5% 且上影 <1% —— 有大资金当日拉高不回落
   *   ③ 财神来敲门：涨幅 >4.8% 收盘=最高、量能温和 —— 光头阳但没爆量
   *   ④ 跃上金坑：收盘上穿「金线王」且涨幅 >8%
   *   ⑤ 金K底：75 日位置下移 + 量增价涨 —— 底部放量反包
   *   ⑥ 金坑吸筹：2×RSI5 + ADX − WR60 由负转正
   *
   * 「金线王」是这套体系的关键：DMA 的平滑系数取价格对 10 日 EMA 的偏离度，
   * 偏离越大均线越迟钝 —— 效果是坑底走平时它贴得紧、拉升时它跟得慢，
   * 价格上穿它的那一刻，等价于「离开坑沿」。
   *
   * 原文用 SMA(0/1 脉冲,8,1) 平滑后再判 "<40"，该条件对脉冲序列恒成立，
   * 这里改为直接用复合指标上穿 0 判断，保留拐点语义、去掉形同虚设的阈值。
   * ============================================================ */
  function dayIdxOfWeek(ctx, wi) {
    const wd = ctx.week && ctx.week.d && ctx.week.d[wi];
    if (!wd) return -1;
    let idx = -1;
    for (let i = 0; i < ctx.n; i++) {
      if (ctx.data[i].d <= wd) idx = i; else break;
    }
    return idx;
  }
  function daysAgo(arr, i, w) {
    for (let k = i; k > Math.max(-1, i - w); k--) if (arr[k]) return i - k;
    return -1;
  }

  QL.registerStrategy({
    id: 'jinkeng', name: '金坑战法', short: '金坑', color: '#FFD166', sub: 'fundmacd',
    desc: '周线KD低位金叉 · 光头阳启动 · 跃上金线王 · 金坑吸筹',

    overlay(ctx) {
      const jk = ctx.jk;
      if (!jk) return [];
      const n = ctx.n;
      const out = [];

      // 金线王：坑沿。价格在它上面 = 已出坑
      const line = [];
      for (let i = Math.max(0, ctx.view.start); i < ctx.view.end; i++) {
        if (jk.goldLine[i] != null) line.push([i, jk.goldLine[i]]);
      }
      if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(255,209,102,.92)', width: 1.7 });

      // 游资/敲门/跃坑/金K底 都是日线口径（涨幅阈值 5%~8%、上影 <1%），
      // 搬到周/月线上语义完全变了，所以非日线周期只保留与位置相关的「金坑」拐点。
      const isDay = ctx.period === 'day';
      const marks = [
        { arr: jk.jkCross, text: '金坑', color: '#FFD166', r: 4.2, bold: true, above: true, prio: 1 },
      ];
      if (isDay) {
        marks.push(
          { arr: jk.goldK, text: '跃坑', color: '#F6465D', r: 3.4, above: true, prio: 2 },
          { arr: jk.bottom, text: '金K底', color: '#4C8DFF', r: 3.2, above: true, prio: 3 },
          { arr: jk.knock, text: '敲门', color: '#FF7EB6', r: 3.0, above: false, prio: 4 },
          { arr: jk.hot, text: '游资', color: '#E6EDF7', r: 2.8, above: false, prio: 5 },
        );
      }

      // 视野内全部信号都标（不再只保留最近 2~3 个），同一位置附近跨类避让
      const vs = ctx.helpers.vspan();
      const cands = [];
      for (const m of marks) {
        for (let i = vs.lo; i < vs.hi; i++) if (m.arr[i]) cands.push({ i, prio: m.prio, m });
      }

      // 黑夜之眼：周线 KD 低位金叉，映射到日线对应位置（周期本身就是周线时不重复标）
      if (isDay && ctx.week && ctx.week.kdj) {
        const W = ctx.week;
        for (let w = 1; w < W.n; w++) {
          const K0 = W.kdj.k[w], D0 = W.kdj.d[w], K1 = W.kdj.k[w - 1], D1 = W.kdj.d[w - 1];
          if (K0 == null || D0 == null || K1 == null || D1 == null) continue;
          if (K1 <= D1 && K0 > D0 && D1 < 60) {
            const di = dayIdxOfWeek(ctx, w);
            if (di >= vs.lo && di < vs.hi) {
              cands.push({ i: di, prio: 6, m: { text: '黑夜之眼', color: '#8BC34A', r: 3.6, bold: true, above: false } });
            }
          }
        }
      }

      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 48, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? ctx.data[i].h : ctx.data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below', r: m.r, bold: m.bold,
        // 靠右边缘时文字左展，避免被画布裁掉
        align: i > n - 12 ? 'right' : 'center',
      });
      return out;
    },

    analyze(ctx) {
      const jk = ctx.jk;
      const n = ctx.n, i = n - 1, d = ctx.data[i];
      if (!jk || n < 40 || !d) {
        return { score: 0, verdict: '历史数据不足 40 根，金坑形态无法确认。', points: [{ k: '数据', v: `仅 ${n} 根` }] };
      }
      const pts = [];
      let s = 0;

      /* ① 周线方向 */
      const W = ctx.week;
      if (W && W.kdj && W.n > 12) {
        const wi = W.n - 1;
        let night = -1;
        for (let w = wi; w >= Math.max(1, wi - 2); w--) {
          const K0 = W.kdj.k[w], D0 = W.kdj.d[w], K1 = W.kdj.k[w - 1], D1 = W.kdj.d[w - 1];
          if (K0 == null || D0 == null || K1 == null || D1 == null) continue;
          if (K1 <= D1 && K0 > D0 && D1 < 60) { night = wi - w; break; }
        }
        const Kw = W.kdj.k[wi], Dw = W.kdj.d[wi];
        if (night === 0) { s += 26; pts.push({ k: '周线方向', v: '本周 KD 低位金叉（D<60），黑夜之眼成立' }); }
        else if (night > 0) { s += 16; pts.push({ k: '周线方向', v: `${night + 1} 周前低位金叉，周线多头仍在` }); }
        else if (Kw != null && Dw != null && Kw > Dw && Kw < 40) { s += 10; pts.push({ k: '周线方向', v: `周线 K${Kw.toFixed(0)} > D${Dw.toFixed(0)}，低位多头` }); }
        else if (Kw != null && Dw != null && Kw > Dw) { s += 4; pts.push({ k: '周线方向', v: `周线 K${Kw.toFixed(0)} > D${Dw.toFixed(0)}，多头但不在低位` }); }
        else if (Kw != null && Dw != null) { s -= 18; pts.push({ k: '周线方向', v: `周线 K${Kw.toFixed(0)} < D${Dw.toFixed(0)}，死叉向下` }); }
      } else {
        pts.push({ k: '周线方向', v: '周线数据不足，跳过周期确认' });
      }

      /* ② 坑底位置 */
      let lo60 = Infinity;
      for (let k = Math.max(0, i - 59); k <= i; k++) lo60 = Math.min(lo60, ctx.data[k].l);
      const distLow = lo60 > 0 && isFinite(lo60) ? (d.c / lo60 - 1) * 100 : 0;
      if (distLow < 8) { s += 14; pts.push({ k: '坑底位置', v: `距 60 周期低点 ${distLow.toFixed(1)}%，仍在坑内` }); }
      else if (distLow < 18) { s += 6; pts.push({ k: '坑底位置', v: `距 60 周期低点 ${distLow.toFixed(1)}%，刚出坑沿` }); }
      else if (distLow > 45) { s -= 12; pts.push({ k: '坑底位置', v: `已高出低点 ${distLow.toFixed(1)}%，位置偏高` }); }
      else pts.push({ k: '坑底位置', v: `距 60 周期低点 ${distLow.toFixed(1)}%` });

      /* ③ 金线王 */
      const gl = jk.goldLine[i];
      if (gl != null) {
        const slope = jk.goldLine[i - 5] ? (gl / jk.goldLine[i - 5] - 1) * 100 : 0;
        const gap = (d.c / gl - 1) * 100;
        if (gap > 1) { s += 12; pts.push({ k: '金线王', v: `收盘 ${d.c.toFixed(2)} 高于 ${gl.toFixed(2)} 约 ${gap.toFixed(1)}%，已出坑沿` }); }
        else if (gap >= 0) { s += 5; pts.push({ k: '金线王', v: `收盘 ${d.c.toFixed(2)} 刚触及 ${gl.toFixed(2)}（+${gap.toFixed(2)}%），尚未走远` }); }
        else { s -= 10; pts.push({ k: '金线王', v: `收盘 ${d.c.toFixed(2)} 低于 ${gl.toFixed(2)}（${gap.toFixed(1)}%），仍在坑内` }); }
        if (slope > 0.3) s += 5;
        pts.push({ k: '金线王斜率', v: `${slope >= 0 ? '+' : ''}${slope.toFixed(2)}%（近 5 根）` });
      }

      /* ④ 启动信号 */
      const sig = [];
      let bonus = 0;
      const c1 = daysAgo(jk.jkCross, i, 10);
      const c2 = daysAgo(jk.goldK, i, 8);
      const c3 = daysAgo(jk.knock, i, 6);
      const c4 = daysAgo(jk.hot, i, 6);
      const c5 = daysAgo(jk.bottom, i, 6);
      const tag = (v) => (v === 0 ? '今日' : v + ' 根前');
      if (c1 >= 0) { bonus += 18; sig.push(`金坑吸筹 ${tag(c1)}`); }
      if (c2 >= 0) { bonus += 14; sig.push(`跃上金线王 ${tag(c2)}`); }
      if (c3 >= 0) { bonus += 8; sig.push(`财神来敲门 ${tag(c3)}`); }
      if (c4 >= 0) { bonus += 6; sig.push(`游资进场 ${tag(c4)}`); }
      if (c5 >= 0) { bonus += 8; sig.push(`金K底 ${tag(c5)}`); }
      if (bonus) {
        // 非日线周期阈值口径不同，只折算参考分，不能按日线强度计满
        s += Math.min(26, Math.round(bonus * (ctx.period === 'day' ? 1 : 0.4)));
        pts.push({ k: '启动信号', v: sig.join(' · ') });
      }
      else pts.push({ k: '启动信号', v: '近 10 根内无启动信号' });
      if (ctx.period !== 'day') {
        pts.push({ k: '周期提示', v: `游资 / 敲门 / 跃坑 / 金K底 是日线口径（涨幅 5%~8%、上影 <1%），在${ctx.periodName}上仅作位置参考` });
      }

      /* ⑤ 金坑指标：2×RSI5 + ADX − WR60，值域约 −100 ~ 300 */
      const jb = jk.jkBuy[i];
      if (jb != null) {
        const prev = jk.jkBuy[i - 5];
        const trend = prev != null ? jb - prev : 0;
        const zone = jb < 0 ? '超卖区' : jb < 60 ? '修复初期' : jb < 120 ? '中性偏强' : '高位区';
        pts.push({ k: '金坑指标', v: `2×RSI5 + ADX − WR60 = ${jb.toFixed(0)}（${zone}）` });
        if (jb > 0 && jb < 60 && trend > 0) { s += 8; pts.push({ k: '指标拐点', v: '刚从超卖区转正且继续上行，是体系内最干净的位置' }); }
        else if (jb >= 120) { s -= 4; pts.push({ k: '指标拐点', v: `已在${zone}，追高的性价比下降` }); }
        else if (jb < -30) { s -= 6; pts.push({ k: '指标拐点', v: '仍在超卖区，尚未出现吸筹拐点' }); }
      }

      /* ⑥ 控盘度 */
      const ctrl = jk.ctrl[i], ctrlP = jk.ctrl[i - 1];
      if (ctrl != null && ctrlP != null) {
        if (ctrl > 0 && ctrl > ctrlP) { s += 8; pts.push({ k: '控盘度', v: `${ctrl.toFixed(1)}，红柱放大（有庄控盘）` }); }
        else if (ctrl > 0) { s += 2; pts.push({ k: '控盘度', v: `${ctrl.toFixed(1)}，红柱缩短（控盘减弱）` }); }
        else pts.push({ k: '控盘度', v: `${ctrl.toFixed(1)}，处于无庄控盘区` });
      }

      /* ⑦ 量能分档 */
      const vr = jk.volRatio[i];
      if (vr != null) {
        const up = jk.chg[i] > 0;
        const lv = vr < 0.5 ? '地量' : vr < 0.8 ? '缩量' : vr < 1.5 ? '平量'
          : vr < 2.3 ? '温和放量' : vr < 5 ? '明显放量' : vr < 10 ? '大量' : '天量';
        pts.push({ k: '量能', v: `量比 ${vr.toFixed(2)}×（${lv}）` });
        if (vr >= 1.5 && vr <= 5 && up) s += 6;
        else if (vr > 8 && up) s -= 5;
        else if (vr < 0.8 && !up) s += 3;
      }

      /* ⑧ 卖出条件 */
      const sl = daysAgo(jk.sellSig, i, 5);
      if (sl >= 0) { s -= 15; pts.push({ k: '卖出信号', v: `高位滞涨：RSI3>76 且次日转弱，${tag(sl)}触发` }); }
      const sar = ctx.ind.sar[i];
      if (sar != null && sar > d.h) { s -= 6; pts.push({ k: 'SAR', v: 'SAR 翻到 K 线上方，趋势止损' }); }

      /* 止损参考 */
      pts.push({
        k: '失效条件',
        v: `跌破金线王 ${gl != null ? gl.toFixed(2) : '—'} 下方 2%，或破坑底 ${isFinite(lo60) ? lo60.toFixed(2) : '—'}，本轮金坑作废`,
      });

      // 位置否决：金坑的前提是「还在坑里」。已高出低点 35% 以上，再好也不能算坑底买点
      if (distLow > 35) s = Math.min(s, 30);

      s = clamp(Math.round(s), -100, 100);
      let verdict;
      if (s >= 62) verdict = '金坑共振成立：周线在低位、价格站上金线王、吸筹指标转正，属于体系内的标准买点。';
      else if (s >= 30) verdict = '金坑初步成型，尚缺部分确认条件，可小仓试探，回踩金线王不破再加。';
      else if (s > -10) verdict = '仍在坑内震荡，未见启动信号，等放量光头阳或上穿金线王再动手。';
      else if (s > -40) verdict = '坑内偏弱、金线王压制，反弹到坑沿遇阻先减仓。';
      else verdict = '周线死叉叠加跌破金线王，金坑已破，按体系应当放弃。';

      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 肉肉战法（来源：通达信主图「均线斜率买卖信号 + 肉肉大肉」）
   * 核心不是价格均线，而是「斜率均线」MX = EMA(C + 20×SLOPE(C,21), 42)。
   * 它把回归斜率当趋势外推价，价格还在横盘时就能先抬头，
   * 再用 MX 斜率 MR 的拐点序列生成动态压力位 MN3，形成「底部突破 → 有肉肉 → 大肉 → 当心大面」的闭环。
   * ============================================================ */
  QL.registerStrategy({
    id: 'rou', name: '肉肉战法', short: '肉肉', color: '#FF9F43', sub: 'mxslope',
    desc: '斜率均线 · 拐点压力 · 有肉肉 / 大肉 / 当心大面',

    overlay(ctx) {
      const r = ctx.rou;
      if (!r) return [];
      const n = ctx.n, v = ctx.view;
      const out = [];
      const seg = (arr, color, width, dash) => {
        const pts = [];
        for (let i = Math.max(0, v.start); i < v.end; i++) if (arr[i] != null) pts.push([i, arr[i]]);
        if (pts.length > 1) out.push({ type: 'line', pts, color, width, dash });
      };

      seg(r.MX, 'rgba(255,159,67,.95)', 2.0);              // 斜率均线
      seg(r.MN3, 'rgba(150,168,196,.55)', 1.3, [6, 4]);    // 89 根动态压力（长划）
      seg(r.MRR, 'rgba(168,130,255,.55)', 1.1, [1, 4]);    // 本次拐点基准（点线）

      // MN3 常常远在上方（跌幅大的票压力位甚至高出 50%+），画出来也看不见，
      // 这时在左上角补一条图外提示，否则用户只看到满屏的说“突破/压力”却找不到线。
      const mn3Now = r.MN3[v.end - 1];
      if (v.pMax && mn3Now != null && mn3Now > v.pMax * 1.01) {
        out.push({
          type: 'label', i: v.start + 2, p: v.pMax * 0.965,
          text: `压力 ${mn3Now.toFixed(2)}（图外 ↑${((mn3Now / v.pMax - 1) * 100).toFixed(0)}%）`,
          color: 'rgba(150,168,196,.85)', align: 'left', size: 9.5,
        });
      }

      const marks = [
        { arr: r.darou, text: '大肉', color: '#F6465D', r: 4.0, bold: true, above: true, prio: 1 },
        { arr: r.yourou, text: '有肉肉', color: '#FFD166', r: 3.4, above: true, prio: 2 },
        { arr: r.bigFace, text: '大面', color: '#2EBD85', r: 3.2, bold: true, above: true, prio: 4 },
        { arr: r.flash, text: '闪', color: '#6FD3C7', r: 3.0, above: false, prio: 5 },
      ];
      // 反包启动是日线口径（涨幅 >4%、量创 20 根新高、前 5 根 4 阴），周/月线上不画
      if (ctx.period === 'day') {
        // 反包发生在低位，标在 K 线下方会被主图底边裁掉，改标在上方
        marks.push({ arr: r.rebound, text: '反包', color: '#4C8DFF', r: 3.4, above: true, prio: 3 });
      }
      // 视野内全部信号都标，同一位置附近跨类避让
      const vs = ctx.helpers.vspan();
      const cands = [];
      for (const m of marks) {
        for (let i = vs.lo; i < vs.hi; i++) if (m.arr[i]) cands.push({ i, prio: m.prio, m });
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 48, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? ctx.data[i].h : ctx.data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below', r: m.r, bold: m.bold,
        align: i > n - 12 ? 'right' : 'center',
      });
      return out;
    },

    analyze(ctx) {
      const r = ctx.rou;
      const n = ctx.n, i = n - 1, d = ctx.data[i];
      if (!r || n < 120 || r.MX[i] == null || r.MN3[i] == null) {
        return {
          score: 0,
          verdict: '历史数据不足 120 根，斜率均线 MX 与拐点压力位还没走完预热（需 21+42+89 根），本战法暂不可用。',
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }
      const pts = [];
      let s = 0;
      const mx = r.MX[i], mr = r.MR[i], mn3 = r.MN3[i], mrr = r.MRR[i];
      const lowR = r.lowRatio[i], topR = r.topRatio[i];
      const tag = (k) => (k === 0 ? '今日' : `${k} 根前`);

      /* ① 趋势加速度：MX 斜率方向 */
      const upAgo = r.tmr[i], dnAgo = r.tmf[i];
      if (mr == null) {
        pts.push({ k: '斜率', v: 'MX 斜率不可用' });
      } else if (mr > 0 && upAgo >= 0 && upAgo <= 3) {
        s += 12;
        pts.push({ k: '斜率', v: `MX 斜率 ${tag(upAgo)}刚由降转升，趋势加速度翻正` });
      } else if (mr > 0) {
        s += 7;
        pts.push({ k: '斜率', v: `MX 斜率为正（已持续 ${upAgo} 根）` });
      } else {
        s -= 8;
        pts.push({ k: '斜率', v: `MX 斜率为负（已持续 ${dnAgo} 根），趋势仍向下` });
      }

      /* ② 位置：MX 相对 55 根低点 */
      if (lowR != null) {
        const pct = (lowR - 1) * 100;
        if (lowR < 1.12) { s += 14; pts.push({ k: '位置', v: `MX 仅高出 55 根低点 ${pct.toFixed(1)}%，贴着底部` }); }
        else if (lowR < 1.35) { s += 8; pts.push({ k: '位置', v: `MX 高出 55 根低点 ${pct.toFixed(1)}%，在体系允许的底部区域（<35%）` }); }
        else if (lowR < 1.55) { s += 0; pts.push({ k: '位置', v: `MX 已高出 55 根低点 ${pct.toFixed(1)}%，启动段走完一半` }); }
        else { s -= 14; pts.push({ k: '位置', v: `MX 已高出 55 根低点 ${pct.toFixed(1)}%，超出体系买点区（>55%）` }); }
      }

      /* ③ 突破：MX 是否站上 89 根拐点压力 */
      const top2 = r.topRatio2[i];
      if (mx > mn3) {
        if (top2 != null && top2 < 1.25) {
          s += 14;
          pts.push({ k: '突破', v: `MX ${mx.toFixed(2)} 站上压力 ${mn3.toFixed(2)}，且离顶部拐点仅 ${((top2 - 1) * 100).toFixed(1)}%（<25%）` });
        } else if (top2 != null) {
          s += 3;
          pts.push({ k: '突破', v: `MX 已站上压力 ${mn3.toFixed(2)}，但离顶部拐点 ${((top2 - 1) * 100).toFixed(1)}%（>25%），偏离已大` });
        } else {
          s += 3;
          pts.push({ k: '突破', v: `MX 已站上压力 ${mn3.toFixed(2)}（历史尚无顶部拐点可比）` });
        }
      } else {
        s -= 6;
        pts.push({ k: '突破', v: `MX ${mx.toFixed(2)} 仍在压力 ${mn3.toFixed(2)} 下方（差 ${((mn3 / mx - 1) * 100).toFixed(1)}%）` });
      }

      /* ③b MX 动能：原文以「MX 日涨 >0.4%」为强势门槛，这里做成连续项，避免所有股票挤在同一个整数分上 */
      const mp = r.mxrPct[i];
      if (mp != null) {
        s += clamp(Math.round(mp * 4), -8, 8);
        pts.push({ k: 'MX 动能', v: `MX 日涨速 ${mp >= 0 ? '+' : ''}${mp.toFixed(2)}%（原文强势门槛 +0.40%）` });
      }

      /* ④ 体系内信号 */
      const sig = [];
      let bonus = 0;
      const d1 = daysAgo(r.darou, i, 6), d2 = daysAgo(r.yourou, i, 6), d3 = daysAgo(r.ROU, i, 10);
      if (d1 >= 0) { bonus += 16; sig.push(`大肉 ${tag(d1)}`); }
      if (d2 >= 0) { bonus += 10; sig.push(`有肉肉 ${tag(d2)}`); }
      if (d3 >= 0) { bonus += 10; sig.push(`底部首破 ${tag(d3)}`); }
      if (ctx.period === 'day') {
        const d4 = daysAgo(r.rebound, i, 5);
        if (d4 >= 0) { bonus += 12; sig.push(`缩量反包 ${tag(d4)}`); }
      }
      if (bonus) {
        s += Math.min(28, Math.round(bonus * (ctx.period === 'day' ? 1 : 0.45)));
        pts.push({ k: '买点信号', v: sig.join(' · ') });
      } else {
        pts.push({ k: '买点信号', v: '近 10 根内无体系买点' });
      }

      /* ⑤ 卖出信号 */
      const w1 = daysAgo(r.flash, i, 6), w2 = daysAgo(r.bigFace, i, 6);
      if (w2 >= 0) {
        s -= 20;
        pts.push({ k: '卖出信号', v: `当心大面 ${tag(w2)}：MX 高于拐点 ${((topR - 1) * 100).toFixed(0)}% 且斜率见顶回落，最后一冲已过` });
      }
      if (w1 >= 0) {
        s -= 12;
        pts.push({ k: '卖出信号', v: `闪，不好吃 ${tag(w1)}：突破后 5 根内斜率重新拐头，突破没延续` });
      }
      if (w1 < 0 && w2 < 0) pts.push({ k: '卖出信号', v: '无' });

      /* ⑥ 60/120 均线带（原文主图的 DRAWBAND） */
      const m60 = ctx.ind.ma60[i], m120 = ctx.ind.ma120[i];
      if (m60 != null && m120 != null) {
        if (m60 > m120) { s += 6; pts.push({ k: '均线带', v: `MA60 ${m60.toFixed(2)} > MA120 ${m120.toFixed(2)}，中期多头` }); }
        else { s -= 4; pts.push({ k: '均线带', v: `MA60 ${m60.toFixed(2)} < MA120 ${m120.toFixed(2)}，中期空头` }); }
        if (d.c > m60) s += 4;
      }

      /* 止损参考 */
      pts.push({
        k: '失效条件',
        v: `MX 跌破拐点基准 ${mrr != null ? mrr.toFixed(2) : '—'}，或斜率连续 3 根为负，本轮趋势作废`,
      });

      // 位置否决：涨过头之后，再漂亮的突破也不是这套体系的买点
      if (topR != null && topR >= 1.8) s = Math.min(s, 8);
      if (w2 >= 0 && w2 <= 3) s = Math.min(s, 18);

      s = clamp(Math.round(s), -100, 100);
      let verdict;
      if (s >= 60) verdict = '肉肉体系完整：斜率翻正、位置在底部、MX 刚站上拐点压力，属于原文定义的「大肉」起爆区。';
      else if (s >= 30) verdict = '有肉可吃，但还差一到两个条件；回踩拐点基准不破是加仓点。';
      else if (s > -5) verdict = '斜率与位置都不算差，但还没突破动态压力，属于埋伏区，等 MX 站上拐点基准再动。';
      else if (s > -35) verdict = 'MX 斜率向下或刚被压力压回，趋势尚未转强，观望。';
      else verdict = '斜率转负且位置偏高，属于原文的「当心大面」区域，反弹减仓。';

      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 30 · 简谐振荡（Simple Harmony · SHO）
   * 来源：Akram El Sherbini《Time Cycle Oscillators》IFTA Journal 2018
   * 把价格视作简谐运动，用「周期」的伸缩衡量多空动量：
   *   SHO = EMA(sign(ΔC)·√|ΔC/EMA(ΔΔC)|, 14) / EMA(√|ΔC/EMA(ΔΔC)|, 14) × 100
   * 0 轴 = 均衡；±40 = 常规超买超卖；±60 = 周期极端失衡（动能衰竭）。
   * 原文过滤器：50EMA + ADX 18 判定趋势/震荡，两种环境用不同阈值解读。
   * ============================================================ */
  QL.registerStrategy({
    id: 'sho', name: '简谐振荡', short: 'SHO', color: '#8FE388', sub: 'sho',
    desc: '简谐周期 · 0轴穿越 · 50EMA/ADX 环境过滤',

    overlay(ctx) {
      const out = [];
      const sho = ctx.ind.sho.sho;
      const ema50 = ctx.ind.ema50;
      const n = ctx.n;
      const vs = ctx.helpers.vspan();

      // 50EMA：原文的结构分水岭
      const line = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (ema50[i] != null) line.push([i, ema50[i]]);
      }
      if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(90,200,250,.55)', width: 1.3, dash: [7, 5] });

      // 0 轴穿越（周期换手）+ ±60 极端（动能衰竭）
      const cands = [];
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        const a = sho[i - 1], b = sho[i], c2 = sho[i + 1];
        if (a == null || b == null) continue;
        // 穿越要「站住」：下一根仍留在同侧才算换手，滤掉 0 轴附近的锯齿
        if (a <= 0 && b > 0 && (c2 == null || c2 > 0)) {
          cands.push({ i, prio: 1, m: { text: '周期多', color: '#F6465D', r: 3.6, bold: true, above: false } });
        } else if (a >= 0 && b < 0 && (c2 == null || c2 < 0)) {
          cands.push({ i, prio: 1, m: { text: '周期空', color: '#2EBD85', r: 3.6, bold: true, above: true } });
        } else if (Math.abs(b) >= 60 && Math.abs(a) < 45) {
          // 原文：±60 是「很少触及」的极端，只认从常规区间快速冲出的那一次
          cands.push({ i, prio: 1, m: { text: '动能衰竭', color: '#A882FF', r: 3.2, bold: true, above: b > 0 } });
        }
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 62, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? ctx.data[i].h : ctx.data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
        r: m.r, bold: m.bold, align: i > n - 12 ? 'right' : 'center',
      });

      // 原文风控：保护位放在信号 K 线极值外侧 1~2 倍 ATR
      let lastCross = -1;
      for (let i = cands.length - 1; i >= 0; i--) {
        if (cands[i].m.text !== '动能衰竭') { lastCross = cands[i].i; break; }
      }
      if (lastCross >= 0) {
        const atr = N(ctx.ind.dmi.atr, lastCross);
        const k = ctx.data[lastCross];
        const isLong = (sho[lastCross] || 0) > 0;
        const p = isLong ? k.l - atr * 1.5 : k.h + atr * 1.5;
        out.push({
          type: 'hline', p,
          color: isLong ? 'rgba(246,70,93,.45)' : 'rgba(46,189,133,.45)',
          dash: [5, 4], label: (isLong ? '多单保护 ' : '空单保护 ') + p.toFixed(2), side: 'right',
        });
      }
      return out;
    },

    analyze(ctx) {
      const n = ctx.n, i = n - 1;
      const sho = ctx.ind.sho.sho;
      const ema50 = ctx.ind.ema50;
      const adx = ctx.ind.dmi.adx;
      const s0 = A(sho, i), s1 = A(sho, i - 1);
      if (s0 == null || n < 60) {
        return { score: 0, verdict: `历史数据不足 60 根（当前 ${n} 根），简谐周期尚未完成预热。`, points: [{ k: '数据', v: `仅 ${n} 根` }] };
      }
      const pts = [];
      let s = 0;

      const c = ctx.data[i].c;
      const e50 = A(ema50, i);
      const ad = N(adx, i);

      /* ① 环境判定：50EMA + ADX 18（原文的过滤器） */
      let env = 'range';
      if (ad >= 18) env = e50 != null && c > e50 ? 'up' : 'down';
      const envName = env === 'up' ? '上行趋势' : env === 'down' ? '下行趋势' : '震荡';
      pts.push({ k: '环境', v: `${envName}（收盘 ${c.toFixed(2)} / 50EMA ${e50 == null ? '—' : e50.toFixed(2)}，ADX ${ad.toFixed(1)}）` });

      /* ② 0 轴穿越：原文的主信号 */
      const up = s1 != null && s1 <= 0 && s0 > 0;
      const dn = s1 != null && s1 >= 0 && s0 < 0;
      if (up) {
        s += env === 'up' ? 40 : env === 'range' ? 18 : 10;
        pts.push({ k: '中心穿越', v: 'SHO 自下向上穿越 0 轴，多头周期动量抬升' + (env === 'up' ? '，且趋势环境配合' : '') });
      } else if (dn) {
        s -= env === 'down' ? 40 : env === 'range' ? 18 : 10;
        pts.push({ k: '中心穿越', v: 'SHO 自上向下跌破 0 轴，空头周期动量抬升' + (env === 'down' ? '，且趋势环境配合' : '') });
      } else {
        if (s0 > 0) { s += env === 'up' ? 12 : 4; pts.push({ k: '中心穿越', v: `SHO ${s0.toFixed(1)}，位于 0 轴上方，多头周期占优` }); }
        else { s -= env === 'down' ? 12 : 4; pts.push({ k: '中心穿越', v: `SHO ${s0.toFixed(1)}，位于 0 轴下方，空头周期占优` }); }
      }

      /* ③ 阈值：趋势里用 ±60 看衰竭，震荡里用 ±40 做反转 */
      if (env === 'range') {
        if (s0 <= -40) { s += 16; pts.push({ k: '边界', v: `震荡环境触及 −40 超卖，按原文做周期反转观察（需回到 0 轴上方确认）` }); }
        else if (s0 >= 40) { s -= 16; pts.push({ k: '边界', v: '震荡环境触及 +40 超买，反抽动能有限，注意回落' }); }
      } else if (env === 'up') {
        if (s0 >= 60) { s -= 14; pts.push({ k: '边界', v: '上行趋势中触及 +60，原文视作多头动能消耗殆尽，兑现部分利润' }); }
        else if (s0 <= -60) { s -= 10; pts.push({ k: '边界', v: '上行趋势中出现 −60，属趋势内部失衡，原文视为走弱警示' }); }
      } else {
        if (s0 <= -60) { s += 14; pts.push({ k: '边界', v: '下行趋势中触及 −60，空头动能衰竭，空仓者可留意反抽' }); }
        else if (s0 >= 60) { s += 10; pts.push({ k: '边界', v: '下行趋势中出现 +60，属原文所说的「下跌中的强度」，反弹可期' }); }
      }

      /* ④ 背离：价格新高/新低而 SHO 未同步 */
      const from = Math.max(0, i - 39);
      let hiP = -Infinity, hiI = i, hiS = -Infinity;
      let loP = Infinity, loI = i, loS = Infinity;
      for (let k = from; k <= i; k++) {
        if (ctx.data[k].h > hiP) { hiP = ctx.data[k].h; hiI = k; }
        if (ctx.data[k].l < loP) { loP = ctx.data[k].l; loI = k; }
        if (sho[k] != null) { hiS = Math.max(hiS, sho[k]); loS = Math.min(loS, sho[k]); }
      }
      if (hiI >= i - 3 && s0 > 0 && hiS !== -Infinity && s0 < hiS * 0.75) {
        s -= 12;
        pts.push({ k: '背离', v: `价格创近 40 根新高，SHO 峰值 ${hiS.toFixed(0)} 未同步，顶背离预警` });
      } else if (loI >= i - 3 && s0 < 0 && loS !== Infinity && s0 > loS * 0.75) {
        s += 12;
        pts.push({ k: '背离', v: `价格创近 40 根新低，SHO 谷值 ${loS.toFixed(0)} 抬高，底背离迹象` });
      }

      /* ⑤ 离场条件（原文四条），只做提示不计分 */
      const exits = [];
      if (dn) exits.push('反向跌破 0 轴');
      if (env === 'up' && s0 >= 60) exits.push('触及 +60 极端');
      if (e50 != null && c < e50) exits.push('收盘跌破 50EMA');
      if (exits.length) pts.push({ k: '离场参考', v: exits.join('、') + '（原文的了结条件）' });

      s = clamp(s, -100, 100);
      let verdict;
      if (up && env === 'up') verdict = '简谐周期刚穿越 0 轴，且价格在 50EMA 上方、ADX 确认趋势 —— 顺势持仓，回踩 50EMA 不破可加。';
      else if (dn && env === 'down') verdict = '简谐周期跌破 0 轴，50EMA 下方且 ADX 显示下行趋势成立 —— 反弹减仓，不做逆势抄底。';
      else if (env === 'range' && s0 <= -40) verdict = 'ADX 低于 18，属震荡环境，SHO 已触及 −40 超卖边界；按原文只做周期反转观察，等回到 0 轴上方再确认。';
      else if (env === 'range' && s0 >= 40) verdict = '震荡环境触及 +40 超买边界，周期动量接近上沿，追高性价比低，等回落至 0 轴附近。';
      else if (env === 'up') {
        verdict = s0 > 0
          ? `上行趋势中 SHO 为 ${s0.toFixed(0)}，多头周期仍占优；跌破 0 轴或收盘失守 50EMA 才考虑离场。`
          : `上行趋势中 SHO 回落到 ${s0.toFixed(0)}（0 轴下方），属趋势内的周期回调；重新站上 0 轴才是二次加速。`;
      } else if (env === 'down') {
        verdict = s0 < 0
          ? `下行趋势中 SHO 为 ${s0.toFixed(0)}，空头周期占优；站回 0 轴上方且收复 50EMA 才谈反转。`
          : `下行趋势中 SHO 反弹到 ${s0.toFixed(0)}（0 轴上方），属下跌中的反抽；未收复 50EMA 前不改弱势判断。`;
      } else verdict = `震荡格局，SHO ${s0.toFixed(0)} 在 ±40 区间内，方向未明，等 0 轴穿越给出周期方向。`;

      pts.push({ k: 'SHO', v: `${s0.toFixed(1)}（前值 ${s1 == null ? '—' : s1.toFixed(1)}）` });
      const shi = A(ctx.ind.sho.vp, i);
      if (shi != null) {
        pts.push({ k: 'SHI', v: `${shi.toFixed(2)}（简谐指数，无量纲相对周期；抬升代表当前波段周期变长、趋势更持久）` });
      }
      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * Al Brooks 价格行为 · 共用扫描
   * 原文三步：向左看定环境 → 中间找架构 → 向右等信号 K 线。
   * 「数 K 线」（H1/H2/L1/L2）在原书里靠肉眼数，这里固定成状态机口径，
   * 保证同一根 K 线不会一会儿算 L1、一会儿算 L2。
   * ============================================================ */
  function paScan(ctx) {
    const data = ctx.data, n = ctx.n;
    const e20 = ctx.ind.ema20, atr = ctx.ind.dmi.atr;
    const AV = i => (atr[i] != null && atr[i] > 0 ? atr[i] : ((data[i].h - data[i].l) || 0.01));

    /* K 线解剖：实体占振幅比例、收盘落在区间的位置 */
    const body = new Array(n), cpos = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = data[i], rng = k.h - k.l;
      body[i] = rng > 0 ? Math.abs(k.c - k.o) / rng : 0;
      cpos[i] = rng > 0 ? (k.c - k.l) / rng : 0.5;
    }
    const isStrong = i => body[i] >= 0.55 && cpos[i] >= 0.65;     // 强多头趋势K线
    const isStrongDn = i => body[i] >= 0.55 && cpos[i] <= 0.35;   // 强空头趋势K线

    /* ---------- ① 环境：趋势 or 交易区间 ---------- */
    let above = 0, ovSum = 0, m = 0;
    for (let k = Math.max(1, n - 20); k < n; k++) {
      if (e20[k] != null && data[k].c > e20[k]) above++;
      const a = data[k - 1], b = data[k];
      const hi = Math.min(a.h, b.h), lo = Math.max(a.l, b.l);
      const den = Math.min(a.h - a.l, b.h - b.l);
      ovSum += den > 0 ? Math.max(0, hi - lo) / den : 0;
      m++;
    }
    above = m ? above / m : 0.5;
    const ov = m ? ovSum / m : 0.5;
    const slope = (e20[n - 1] != null && e20[n - 11] != null) ? (e20[n - 1] - e20[n - 11]) / AV(n - 1) : 0;
    let env = 'range';
    if (above >= 0.62 && slope > 0.25) env = 'up';
    else if (above <= 0.38 && slope < -0.25) env = 'down';

    /* ---------- ② Always In：最近 3 根里 2 根以上同向强趋势K线 ---------- */
    let upBars = 0, dnBars = 0;
    for (let k = Math.max(0, n - 3); k < n; k++) {
      if (isStrong(k)) upBars++;
      if (isStrongDn(k)) dnBars++;
    }
    const last = data[n - 1];
    let ai = 0;
    if (e20[n - 1] != null) {
      if (upBars >= 2 && last.c > e20[n - 1]) ai = 1;
      else if (dnBars >= 2 && last.c < e20[n - 1]) ai = -1;
    }

    /* ---------- ③ 20 缺口 K 线：连续多少根不触碰 20EMA ---------- */
    let gapUp = 0, gapDn = 0;
    for (let k = n - 1; k >= 1; k--) { if (e20[k] == null || data[k].l <= e20[k]) break; gapUp++; }
    for (let k = n - 1; k >= 1; k--) { if (e20[k] == null || data[k].h >= e20[k]) break; gapDn++; }

    /* ---------- ④ 最近 20 根区间 ---------- */
    let rngHi = -Infinity, rngLo = Infinity;
    for (let k = Math.max(0, n - 20); k < n; k++) {
      if (data[k].h > rngHi) rngHi = data[k].h;
      if (data[k].l < rngLo) rngLo = data[k].l;
    }

    /* ---------- ⑤ 数 K 线：L1/L2/L3、H1/H2/H3 ---------- */
    // dir=+1 数上升趋势里的回调（L），dir=-1 数下降趋势里的反弹（H）。
    // 一推 = 回调中出现新的低点，且中间必须有过反弹（高点抬高），
    // 否则连续阴线会被误数成 L3、L4。
    const walk = (dir) => {
      const res = [];
      let inPB = false, cnt = 0, lastPiv = -99, sig = -1, start = 0, bounced = false;
      for (let i = 2; i < n; i++) {
        const a = data[i - 1], c = data[i];
        if (!inPB) {
          // 回调起点：低点与收盘同时下移。只看低点下移会把「低开高走的大阳线」
          // 也当成回调开始，最后一根强阳线就永远显示成「刚砸出低点」。
          const begin = dir > 0
            ? (c.l < a.l && c.c < a.c && e20[i - 1] != null && a.c > e20[i - 1])
            : (c.h > a.h && c.c > a.c && e20[i - 1] != null && a.c < e20[i - 1]);
          if (begin) {
            inPB = true; cnt = 1; lastPiv = i; bounced = false; start = i;
            sig = dir > 0 ? (c.c < c.o ? i : -1) : (c.c > c.o ? i : -1);
            res.push({ i, n: 1, kind: 'piv' });
          }
          continue;
        }
        if (i - start > 34) { inPB = false; cnt = 0; sig = -1; continue; }
        if (dir > 0) {
          if (c.c < c.o && cpos[i] <= 0.45) sig = i;          // 候选信号K线（阴线收在下半部）
          if (c.h > a.h) bounced = true;
          if (c.l < a.l && c.c < a.c && bounced && i - lastPiv >= 2) {
            cnt++; lastPiv = i; bounced = false;
            res.push({ i, n: Math.min(cnt, 3), kind: 'piv' });
          }
          if (sig >= 0 && i > sig && c.h > data[sig].h && c.c > data[sig].c) {
            res.push({ i, n: Math.min(Math.max(cnt, 1), 3), kind: 'end' });
            inPB = false; cnt = 0; sig = -1;
          }
        } else {
          if (c.c > c.o && cpos[i] >= 0.55) sig = i;
          if (c.l < a.l) bounced = true;
          if (c.h > a.h && c.c > a.c && bounced && i - lastPiv >= 2) {
            cnt++; lastPiv = i; bounced = false;
            res.push({ i, n: Math.min(cnt, 3), kind: 'piv' });
          }
          if (sig >= 0 && i > sig && c.l < data[sig].l && c.c < data[sig].c) {
            res.push({ i, n: Math.min(Math.max(cnt, 1), 3), kind: 'end' });
            inPB = false; cnt = 0; sig = -1;
          }
        }
      }
      return res;
    };
    const pullsUp = walk(1), pullsDn = walk(-1);

    /* ---------- ⑥ 局部极值 → 双顶双底 / 楔形三推 ---------- */
    const pivHi = [], pivLo = [];
    for (let i = 2; i < n - 1; i++) {
      if (data[i].h >= data[i - 1].h && data[i].h > data[i + 1].h) pivHi.push(i);
      if (data[i].l <= data[i - 1].l && data[i].l < data[i + 1].l) pivLo.push(i);
    }

    const dts = [];
    for (let k = 1; k < pivHi.length; k++) {
      const p = pivHi[k - 1], q = pivHi[k];
      if (q - p < 5 || q - p > 30) continue;
      const h = AV(q);
      if (Math.abs(data[q].h - data[p].h) > h * 0.4) continue;
      let midLo = Infinity;
      for (let j = p; j <= q; j++) if (data[j].l < midLo) midLo = data[j].l;
      if (data[q].h - midLo < h * 0.7) continue;
      dts.push({ i: q, kind: 'DT' });
    }
    for (let k = 1; k < pivLo.length; k++) {
      const p = pivLo[k - 1], q = pivLo[k];
      if (q - p < 5 || q - p > 30) continue;
      const h = AV(q);
      if (Math.abs(data[q].l - data[p].l) > h * 0.4) continue;
      let midHi = -Infinity;
      for (let j = p; j <= q; j++) if (data[j].h > midHi) midHi = data[j].h;
      if (midHi - data[q].l < h * 0.7) continue;
      dts.push({ i: q, kind: 'DB' });
    }

    const wedges = [];
    for (let k = 2; k < pivHi.length; k++) {
      const a = pivHi[k - 2], b = pivHi[k - 1], c = pivHi[k];
      if (c - a > 60) continue;
      const h1 = data[a].h, h2 = data[b].h, h3 = data[c].h;
      if (h1 < h2 && h2 < h3 && (h3 - h2) < (h2 - h1) * 0.75) wedges.push({ i: c, kind: 'WT' });
    }
    for (let k = 2; k < pivLo.length; k++) {
      const a = pivLo[k - 2], b = pivLo[k - 1], c = pivLo[k];
      if (c - a > 60) continue;
      const l1 = data[a].l, l2 = data[b].l, l3 = data[c].l;
      if (l1 > l2 && l2 > l3 && (l2 - l3) < (l1 - l2) * 0.75) wedges.push({ i: c, kind: 'WB' });
    }

    /* ---------- ⑦ 失败突破（原文的 80% 规则） ---------- */
    const fbo = [];
    for (let i = 21; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - 20; k < i; k++) {
        if (data[k].h > hi) hi = data[k].h;
        if (data[k].l < lo) lo = data[k].l;
      }
      if (data[i].h > hi) {
        for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
          if (data[j].c < hi) { fbo.push({ i: j, kind: 'FBO↑' }); i = j; break; }
        }
      } else if (data[i].l < lo) {
        for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
          if (data[j].c > lo) { fbo.push({ i: j, kind: 'FBO↓' }); i = j; break; }
        }
      }
    }

    return {
      body, cpos, env, above, ov, slope, ai, upBars, dnBars,
      gapUp, gapDn, rngHi, rngLo, pullsUp, pullsDn, pivHi, pivLo, dts, wedges, fbo, AV,
    };
  }

  /* ============================================================
   * 31 · 价格行为（Price Action · Al Brooks）
   * 来源：Al Brooks《Trading Price Action》三部曲
   * 体系不看指标（20EMA 只作基准线），只看三件事：
   *   ① 环境：趋势里追、区间里高抛低吸、区间中部不动
   *   ② 架构：H1/H2/L1/L2 数 K 线、双顶双底、楔形三推、失败突破
   *   ③ 信号：信号 K 线的实体与收盘位置，决定这一枪要不要开
   * A 股适配：T+1 不能做空，H 系列只提示减仓/回避；涨停当天视为不可买。
   * ============================================================ */
  QL.registerStrategy({
    id: 'albrooks', name: '价格行为', short: 'PA', color: '#F0B429', sub: 'pabar',
    desc: 'Al Brooks · 趋势/区间 · H1H2L1L2 · 20EMA 缺口',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, e20 = ind.ema20;
      const vs = ctx.helpers.vspan();
      const out = [];
      const S = paScan(ctx);

      /* 20EMA：原文唯一的「指标」，趋势基准 + 回调深浅的尺子 */
      const line = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (e20[i] != null) line.push([i, e20[i]]);
      }
      if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(240,180,41,.8)', width: 1.6 });

      /* 交易区间上下沿：原文说边缘做单、中部观望，所以边界必须画出来 */
      if (S.env === 'range' && isFinite(S.rngHi)) {
        const x1 = Math.max(vs.lo, n - 20), x2 = Math.min(n - 1, vs.hi);
        if (x2 > x1) out.push(...box4(x1, x2, S.rngLo, S.rngHi, 'rgba(240,180,41,.38)', [5, 4]));
      }

      /* 信号标记：L1/L2/L3 与 H1/H2/H3 优先，其余形态次之 */
      const cands = [];
      for (const p of S.pullsUp) {
        if (p.i < vs.lo || p.i >= vs.hi || p.kind !== 'piv') continue;
        cands.push({ i: p.i, prio: p.n === 2 ? 1 : 2, m: { text: 'L' + p.n, color: '#F6465D', r: 3.4, bold: p.n === 2, above: false } });
      }
      for (const p of S.pullsDn) {
        if (p.i < vs.lo || p.i >= vs.hi || p.kind !== 'piv') continue;
        cands.push({ i: p.i, prio: p.n === 2 ? 1 : 2, m: { text: 'H' + p.n, color: '#2EBD85', r: 3.4, bold: p.n === 2, above: true } });
      }
      for (const d of S.dts) {
        if (d.i < vs.lo || d.i >= vs.hi) continue;
        cands.push({ i: d.i, prio: 3, m: { text: d.kind === 'DT' ? '双顶' : '双底', color: '#F0B429', r: 3.2, above: d.kind === 'DT' } });
      }
      for (const w of S.wedges) {
        if (w.i < vs.lo || w.i >= vs.hi) continue;
        cands.push({ i: w.i, prio: 4, m: { text: '楔形三推', color: '#FF9F43', r: 3.0, above: w.kind === 'WT' } });
      }
      for (const f of S.fbo) {
        if (f.i < vs.lo || f.i >= vs.hi) continue;
        cands.push({ i: f.i, prio: 3, m: { text: '突破失败', color: '#A882FF', r: 3.0, above: f.kind === 'FBO↑' } });
      }

      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 56, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? data[i].h : data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
        r: m.r, bold: m.bold, align: i > n - 12 ? 'right' : 'center',
      });

      return out;
    },

    analyze(ctx) {
      const data = ctx.data, n = ctx.n, i = n - 1;
      const e20 = ctx.ind.ema20;
      const S = paScan(ctx);
      const c = data[i].c, e = A(e20, i);
      if (n < 40 || e == null) {
        return { score: 0, verdict: `历史数据不足 40 根（当前 ${n} 根），20EMA 与区间结构尚未成形。`, points: [{ k: '数据', v: `仅 ${n} 根` }] };
      }
      const pts = [];
      let s = 0;
      const atr = S.AV(i);
      const rangeH = S.rngHi - S.rngLo;
      const inRange = c >= S.rngLo && c <= S.rngHi;
      const posInRange = rangeH > 0 ? (c - S.rngLo) / rangeH : 0.5;   // 0=下沿 1=上沿

      /* ① 环境：这一层决定后面所有操作是「追」还是「挂」 */
      const envName = S.env === 'up' ? '上升趋势' : S.env === 'down' ? '下降趋势' : '交易区间';
      pts.push({
        k: '环境',
        v: `${envName}（20EMA 上方 K 线 ${(S.above * 100).toFixed(0)}%，10 根斜率 ${S.slope >= 0 ? '+' : ''}${S.slope.toFixed(2)} ATR，相邻K线重叠度 ${(S.ov * 100).toFixed(0)}%）`,
      });
      if (S.env === 'up') s += 22;
      else if (S.env === 'down') s -= 22;
      else {
        // 区间里位置决定一切：下沿是买点、上沿是卖点、中部什么都不做
        if (posInRange > 0.75) {
          s -= 10;
          pts.push({ k: '位置', v: `区间上沿（${(posInRange * 100).toFixed(0)}% 分位），这里是减仓位置，不是追涨位置` });
        } else if (posInRange > 0.5) {
          s -= 6;
          pts.push({ k: '位置', v: `区间中上部（${(posInRange * 100).toFixed(0)}% 分位），向上空间被上沿压着，不追` });
        } else if (posInRange > 0.25) {
          s -= 4;
          pts.push({ k: '位置', v: `区间中下部（${(posInRange * 100).toFixed(0)}% 分位），离下沿还有距离，等回踩到位` });
        } else {
          s += 10;
          pts.push({ k: '位置', v: `区间下沿（${(posInRange * 100).toFixed(0)}% 分位），原文的做多位置，等强多头信号K线确认` });
        }
      }

      /* ② Always In：必须持仓时只能选一个方向 */
      if (S.ai > 0) { s += 12; pts.push({ k: 'Always In', v: `多头（最近 3 根里 ${S.upBars} 根强多头趋势K线，收在 20EMA 上方）` }); }
      else if (S.ai < 0) { s -= 12; pts.push({ k: 'Always In', v: `空头（最近 3 根里 ${S.dnBars} 根强空头趋势K线，收在 20EMA 下方）` }); }
      else pts.push({ k: 'Always In', v: '不明确 —— 最近 3 根没有连续同向的强趋势K线，属原文的「看不清」状态' });

      /* ③ 20 缺口 K 线：连续 20 根不碰 20EMA 是极端强势 */
      if (S.gapUp >= 20) { s += 10; pts.push({ k: '20缺口', v: `连续 ${S.gapUp} 根最低价都在 20EMA 之上，原文的极端强势信号，只做多` }); }
      else if (S.gapDn >= 20) { s -= 10; pts.push({ k: '20缺口', v: `连续 ${S.gapDn} 根最高价都在 20EMA 之下，极端弱势，反弹即减仓` }); }
      else pts.push({ k: '20缺口', v: `上方 ${S.gapUp} 根 / 下方 ${S.gapDn} 根（满 20 根才算缺口行情）` });

      /* ④ 数 K 线：最近一次回调走到第几推 */
      const lastEnd = (arr) => {
        for (let k = arr.length - 1; k >= 0; k--) if (arr[k].kind === 'end') return arr[k];
        return null;
      };
      const lastPiv = (arr) => {
        for (let k = arr.length - 1; k >= 0; k--) if (arr[k].kind === 'piv') return arr[k];
        return null;
      };
      const lu = lastEnd(S.pullsUp), ld = lastEnd(S.pullsDn);
      const pu = lastPiv(S.pullsUp), pd = lastPiv(S.pullsDn);
      const fresh = (o) => o && i - o.i <= 5;
      // 数 K 线与环境解耦：区间里也会有「反弹几推」，措辞必须跟着环境走，
      // 否则会出现「环境=交易区间，架构=下降趋势里第 2 次反弹失败」的自相矛盾。
      const upWord = S.env === 'up' ? '上行趋势里的回调' : '区间内的回调';
      const dnWord = S.env === 'down' ? '下降趋势里的反弹' : '区间内的反弹';
      if (fresh(lu)) {
        s += lu.n === 2 ? 18 : lu.n === 1 ? 8 : 4;
        pts.push({ k: '架构', v: `L${lu.n} 已触发（${lu.i === i ? '就在最新一根' : (i - lu.i) + ' 根前'}）：${upWord}第 ${lu.n} 次被买盘接管${lu.n === 2 ? '，双底牛旗，原文的首选入场点' : ''}` });
      } else if (fresh(ld)) {
        s -= ld.n === 2 ? 18 : ld.n === 1 ? 8 : 4;
        pts.push({ k: '架构', v: `H${ld.n} 已触发（${ld.i === i ? '就在最新一根' : (i - ld.i) + ' 根前'}）：${dnWord}第 ${ld.n} 次失败${ld.n === 2 ? '，双顶熊旗，原文视作多头最后离场机会' : ''}` });
      } else if (fresh(pu)) {
        s += pu.n >= 2 ? 8 : 3;
        pts.push({ k: '架构', v: `L${pu.n} 正在形成（${i - pu.i} 根前）：第 ${pu.n} 次回调刚砸出低点，还没突破信号K线高点，属观察位；按原文在信号K线高点上方挂单等确认` });
      } else if (fresh(pd)) {
        s -= pd.n >= 2 ? 8 : 3;
        pts.push({ k: '架构', v: `H${pd.n} 正在形成（${i - pd.i} 根前）：第 ${pd.n} 次反弹刚冒头，未跌破信号K线低点，反弹随时可能结束` });
      } else {
        pts.push({ k: '架构', v: '最近 5 根没有新的 H/L 触发信号，处在两腿之间的空窗期' });
      }

      /* ⑤ 信号 K 线质量：原文「十字星不要下单」 */
      const bd = S.body[i];
      const cp = S.cpos[i];
      if (bd >= 0.55 && cp >= 0.65) { s += 8; pts.push({ k: '信号K线', v: `强多头（实体占 ${(bd * 100).toFixed(0)}%，收在最高 ${(cp * 100).toFixed(0)}% 处）` }); }
      else if (bd >= 0.55 && cp <= 0.35) { s -= 8; pts.push({ k: '信号K线', v: `强空头（实体占 ${(bd * 100).toFixed(0)}%，收在最低 ${(cp * 100).toFixed(0)}% 处）` }); }
      else if (bd <= 0.25) { pts.push({ k: '信号K线', v: `十字星 / 小实体（实体仅 ${(bd * 100).toFixed(0)}%），原文：力量不足，不要据此下单` }); }
      else pts.push({ k: '信号K线', v: `中性（实体 ${(bd * 100).toFixed(0)}%，收盘位置 ${(cp * 100).toFixed(0)}%）` });

      /* ⑥ 距离 20EMA：趋势里回踩越浅越强，乖离过大则是追高 */
      const dist = (c - e) / atr;
      pts.push({ k: '距20EMA', v: `${dist >= 0 ? '+' : ''}${dist.toFixed(2)} ATR（20EMA ${e.toFixed(2)}）` });
      if (S.env === 'up' && dist > 2.5) { s -= 6; pts.push({ k: '乖离', v: '离 20EMA 超过 2.5 ATR，此时追高等于在趋势末端接货' }); }
      else if (S.env === 'down' && dist < -2.5) { s += 4; pts.push({ k: '乖离', v: '已跌破 20EMA 2.5 ATR，超跌反抽概率上升，但不构成反转' }); }
      else if (S.env === 'up' && dist >= 0 && dist <= 1) { s += 6; }

      /* ⑦ 形态：双顶双底 / 楔形 / 失败突破 */
      const latestForm = (arr, win) => {
        for (let k = arr.length - 1; k >= 0; k--) if (i - arr[k].i <= win) return arr[k];
        return null;
      };
      const dt = latestForm(S.dts, 8);
      if (dt) {
        const nearEdge = dt.kind === 'DT' ? posInRange > 0.7 : posInRange < 0.3;
        if (dt.kind === 'DT') {
          s -= nearEdge ? 10 : 3;
          pts.push({ k: '形态', v: `双顶${nearEdge ? '，且位于区间上沿 —— 原文的高胜率做空结构' : '（位置不在上沿，力度打折）'}` });
        } else {
          s += nearEdge ? 10 : 3;
          pts.push({ k: '形态', v: `双底${nearEdge ? '，且位于区间下沿 —— 原文的高胜率做多结构' : '（位置不在下沿，力度打折）'}` });
        }
      }
      const wg = latestForm(S.wedges, 8);
      if (wg) {
        if (wg.kind === 'WT') { s -= 8; pts.push({ k: '形态', v: '楔形三推向上，第三推力度递减，多头动能衰竭' }); }
        else { s += 8; pts.push({ k: '形态', v: '楔形三推向下，第三推力度递减，空头动能衰竭' }); }
      }
      const fb = latestForm(S.fbo, 8);
      if (fb) {
        if (fb.kind === 'FBO↑') { s -= 6; pts.push({ k: '形态', v: '向上假突破：一度破 20 根新高但 3 根内收回，追高盘被套' }); }
        else { s += 8; pts.push({ k: '形态', v: '向下假突破：破 20 根新低后迅速收回，原文视为高胜率的反转做多' }); }
      }

      /* ⑧ 目标位与盈亏比
       * 原文的两条尺子要分开用：区间内目标是对侧沿，突破之后才用箱体高度做测量移动。
       * A 股不能做空，所以只给多头算 R，H 系列只给「若持仓的减仓参考位」。 */
      if (rangeH > 0) {
        const wide = rangeH / c > 0.15;   // 区间过宽时量度目标会把价格投到很远，参考价值低
        if (inRange) {
          pts.push({
            k: '目标位',
            v: `区间上沿 ${S.rngHi.toFixed(2)} / 下沿 ${S.rngLo.toFixed(2)}，箱体高 ${rangeH.toFixed(2)}（占股价 ${(rangeH / c * 100).toFixed(0)}%）` +
              (wide ? ' —— 属宽幅震荡，按结构做、别死盯目标位' : ''),
          });
        } else {
          const mmUp = S.rngHi + rangeH, mmDn = S.rngLo - rangeH;
          pts.push({ k: '目标位', v: `已突破区间，按箱体高度测量：上看 ${mmUp.toFixed(2)}（+${((mmUp / c - 1) * 100).toFixed(1)}%），下看 ${mmDn.toFixed(2)}（${((mmDn / c - 1) * 100).toFixed(1)}%）` });
        }

        if (fresh(lu) && !wide) {
          // 多头：止损在信号K线下方，第一目标为区间上沿（区间内）或量度目标（已突破）
          const stop = data[lu.i].l - atr * 0.25;
          const tgt = inRange ? S.rngHi : S.rngHi + rangeH;
          const rr = (tgt - c) / Math.max(c - stop, 0.01);
          pts.push({
            k: '盈亏比',
            v: `止损 ${stop.toFixed(2)}（信号K线外侧 0.25 ATR），第一目标 ${tgt.toFixed(2)}，约 ${rr.toFixed(1)}R` +
              (rr < 2 ? ' —— 不足原文要求的 2R，这单该放弃' : ''),
          });
        } else if (fresh(ld)) {
          const stop = data[ld.i].h + atr * 0.25;
          pts.push({ k: '减仓参考', v: `A 股不能做空，H${ld.n} 只作离场信号：持仓者把止损上移到 ${stop.toFixed(2)}（反弹高点外侧 0.25 ATR）` });
        }
      }

      /* ⑨ A 股适配 */
      const lim = ctx.period === 'day' ? 0.095 : 0.2;
      if (ctx.period === 'day' && i > 0 && (data[i].c / data[i - 1].c - 1) >= lim) {
        s -= 4;
        pts.push({ k: 'A股', v: '当日接近涨停，追买实际成交困难，信号只作次日观察' });
      }

      s = clamp(s, -100, 100);

      let verdict;
      if (S.env === 'range' && posInRange > 0.3 && posInRange < 0.65) {
        verdict = `现在是交易区间，价格在 ${(posInRange * 100).toFixed(0)}% 的中部位置。原文对这里的唯一建议是空仓等待 —— 区间中部多空双杀，等价格摸到下沿做多、摸到上沿减仓再动手。`;
      } else if (S.env === 'up' && fresh(lu) && lu.n >= 2) {
        verdict = `上升趋势中的 L${lu.n} 已触发：第 ${lu.n} 次回调被买盘吃掉，这正是原文最推崇的双底牛旗买点。止损放这根信号K线下方 1 个 ATR 内侧，第一目标看区间上沿 ${S.rngHi.toFixed(2)}。`;
      } else if (S.env === 'up') {
        verdict = `上升趋势成立（20EMA 上行、K 线重叠度低），回调是买点不是卖点。等价格回到 20EMA 附近出现 L1/L2 再进，现在追高的盈亏比不划算。`;
      } else if (S.env === 'down' && fresh(ld) && ld.n >= 2) {
        verdict = `下降趋势中的 H${ld.n} 出现：第 ${ld.n} 次反弹失败，是原文的多头最后离场点。A 股不能做空，对应动作是减仓或彻底回避，不要在这里接飞刀。`;
      } else if (S.env === 'down') {
        verdict = `下降趋势成立，20EMA 下方且反弹无力。原文的做法是只找 H1/H2 卖点，不抄底；等价格重新站上 20EMA 并出现连续强多头趋势K线，再谈趋势反转。`;
      } else if (posInRange <= 0.3) {
        verdict = `价格回到区间下沿附近。原文的区间策略是在这里做多、止损放区间下方，但必须等一根强多头信号K线确认，不能直接挂限价单硬接。`;
      } else {
        verdict = `价格来到区间上沿。这里是减仓位置而不是追涨位置 —— 原文统计约 80% 的区间突破会失败，除非出现放量强趋势K线并跟随，否则先减。`;
      }

      const aiTxt = S.ai > 0 ? '多头' : S.ai < 0 ? '空头' : '未定';
      pts.push({ k: '结论', v: `${envName} · Always In ${aiTxt} · 区间分位 ${(posInRange * 100).toFixed(0)}%` });
      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 涨停回踩 20 日线（来源：桔子写指标 2026-11-10）
   * 六重条件：近期涨停 → 振幅突破 3 → 近 5 日涨幅加速 → 回踩 20EMA
   *          → 当日涨超 3% → 非三连阳 / 无「开盘即最高」
   * ============================================================ */
  function hzScan(ctx) {
    const { data, ind } = ctx;
    const n = ctx.n;
    const amp = ind.amp;
    const rate = limitRate(ctx);

    // 涨停：按板块涨跌幅限制判定（原文写死 >1.09，双创 20% 时会漏、涨 11% 时会误判），
    // 且要求收盘=最高（封住），这才是原文 C=H 的语义
    const limitUp = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      if (isLimitUp(ctx, i, rate) && data[i].c >= data[i].h - 0.005) limitUp[i] = true;
    }
    // 近期有涨停：过去 15 日内出现过，不含当日（原文 REF(涨停,1)）
    const recentLimit = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      for (let k = Math.max(1, i - 15); k < i; k++) if (limitUp[k]) { recentLimit[i] = true; break; }
    }
    // 振幅突破：振幅强度由下向上穿过 3
    const ampCross = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      const a = amp.ampStr[i], b = amp.ampStr[i - 1];
      if (a != null && b != null && a > 3 && b <= 3) ampCross[i] = true;
    }
    // 六重条件同时成立
    const sig = new Array(n).fill(false);
    for (let i = 20; i < n; i++) {
      const e = ind.ema20[i], prev = data[i - 1].c;
      if (e == null || !prev) continue;
      if (!recentLimit[i] || !ampCross[i] || !amp.fiveAccel[i]) continue;
      if (!amp.no3up[i] || !amp.noGapHigh[i]) continue;
      if (!(data[i].l <= e)) continue;                 // 回踩到 20EMA
      if (!(data[i].c / prev - 1 > 0.03)) continue;        // 当日涨超 3%
      if (!(data[i].c > data[i].o)) continue;             // 收阳
      sig[i] = true;
    }
    return { limitUp, recentLimit, ampCross, sig };
  }

  QL.registerStrategy({
    id: 'zhangting20',
    name: '涨停回踩20',
    short: '回踩20',
    color: '#FF6B35',
    sub: 'ampstr',
    desc: '涨停基因 · 振幅突破 · 涨幅加速 · 回踩 20EMA 二次启动',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const e20 = ind.ema20;
      const out = [];

      /* 20EMA：这套战法唯一的基准线，所谓「回踩」就是踩它 */
      const line = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (e20[i] != null) line.push([i, e20[i]]);
      }
      if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(255,107,53,.85)', width: 1.7 });

      // 涨停、5 日加速、当日涨 3% 全是日线口径，周/月线上只留均线作参考
      if (ctx.period !== 'day') return out;

      const S = hzScan(ctx);
      const cands = [];
      // 涨停基因：淡标记，一眼看出这股有资金活跃痕迹
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (S.limitUp[i]) cands.push({ i, prio: 2, m: { text: '停', color: 'rgba(255,107,107,.5)', r: 2.4, above: false } });
      }
      // 振幅强度上穿 3：只在「近 15 日有涨停」的窗口内标，否则五年里上百次上穿会淹没主图
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (S.ampCross[i] && S.recentLimit[i]) cands.push({ i, prio: 4, m: { text: '振幅破3', color: '#FF9F43', r: 2.8, above: true } });
      }
      // 六重条件同时成立的「二次启动」点（必须从视野下界开始收集，
      // 否则视野外的历史信号会占掉 pickMarks 的像素配额，画面上什么都看不到）
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (S.sig[i]) cands.push({ i, prio: 1, m: { text: '回踩启动', color: '#F6465D', r: 4.2, bold: true, above: false } });
      }

      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 62, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? data[i].h : data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
        r: m.r, bold: m.bold, align: i > n - 12 ? 'right' : 'center',
      });
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1;
      const amp = ind.amp, e20 = ind.ema20;
      const A = (arr, k) => (arr && arr[k] != null ? arr[k] : null);
      const pts = [];
      let s = 0;

      const c = data[i].c, e = A(e20, i);
      if (n < 30 || e == null) {
        return {
          score: 0,
          verdict: `历史数据不足 30 根（当前 ${n} 根），20EMA 与涨停回踩结构还没成形。`,
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }
      const S = hzScan(ctx);
      const isDay = ctx.period === 'day';
      const rate = limitRate(ctx);

      /* ① 涨停基因：原文第一道门槛，先确认资金来过 */
      let limCnt = 0, lastLim = -1;
      for (let k = Math.max(1, i - 15); k <= i; k++) if (S.limitUp[k]) { limCnt++; lastLim = k; }
      if (!isDay) {
        pts.push({
          k: '周期',
          v: `${ctx.periodName}视图：涨停、5 日涨幅加速、当日涨 3% 都是日线口径，本周期只保留「回踩 20EMA」这一层，信号会少很多`,
        });
      } else if (limCnt === 0) {
        s -= 15;
        pts.push({
          k: '涨停基因',
          v: `近 15 个交易日没有涨停（本板块涨停线 ${(rate * 100).toFixed(0)}%），不满足原文第一道门槛 —— 这套战法只做强势股的二次启动，冷门股回踩 20 线不适用`,
        });
      } else {
        s += 10;
        pts.push({
          k: '涨停基因',
          v: `近 15 个交易日 ${limCnt} 次涨停，最近一次在 ${i - lastLim} 根前（${data[lastLim].d}），资金活跃痕迹成立`,
        });
        if (i - lastLim <= 5) s += 4;
      }

      /* ② 振幅强度：K 线相对当日成交均价的偏离，3 是原文的突破阈值 */
      const a0 = A(amp.ampStr, i), a1 = A(amp.ampStr, i - 1);
      const vw = A(amp.vwap, i);
      if (a0 != null) {
        if (a0 > 3) {
          s += 8;
          pts.push({ k: '振幅强度', v: `${a0.toFixed(2)}，已在 3 上方 —— 3 大约等于 K 线偏离成交均价 6%，说明盘中波动确实放大，不是缩量沉寂` });
        } else if (a0 > 2) {
          s += 3;
          pts.push({ k: '振幅强度', v: `${a0.toFixed(2)}，正向 3 靠拢，波动刚开始放大但还没确认` });
        } else {
          pts.push({ k: '振幅强度', v: `${a0.toFixed(2)}，低于 3，缩量沉寂状态，离开启还差一口气` });
        }
        if (S.ampCross[i]) {
          s += 6;
          pts.push({ k: '突破时点', v: '就在今天上穿 3，原文的「振幅突破」条件当日成立，信号新鲜' });
        } else if (a0 > 3 && a1 != null && a1 > 3) {
          pts.push({ k: '突破时点', v: '已在 3 上方停留不止一根，属持续放量而非刚突破，新鲜度下降' });
        }
        if (vw != null) pts.push({ k: '成交均价', v: `${vw.toFixed(2)} 元（成交额÷成交量），收盘 ${c.toFixed(2)}，偏离 ${((c / vw - 1) * 100).toFixed(2)}%` });
      }

      /* ③ 涨幅加速：单日脉冲 vs 动能持续增强 */
      let accN = 0, accLast = -1;
      for (let k = Math.max(0, i - 4); k <= i; k++) if (amp.accel[k]) { accN++; accLast = k; }
      const expA = A(amp.expAmp, i);
      if (accN > 0) {
        s += 8;
        pts.push({
          k: '涨幅加速',
          v: `近 5 日 ${accN} 次加速${accLast === i ? '（含今日）' : `（最近一次 ${i - accLast} 根前）`}，判据是当日涨幅超过「前两日振幅外推的预期振幅」且 20 日均线向上`,
        });
      } else {
        pts.push({
          k: '涨幅加速',
          v: `近 5 日 0 次加速${expA != null ? `，今日预期振幅 ${expA.toFixed(1)}%、实际涨幅 ${((c / data[i - 1].c - 1) * 100).toFixed(1)}%` : ''}，动能还没起来`,
        });
      }

      /* ④ 回踩 20EMA：原文的核心买点，但要区分「回踩」和「破位」 */
      const dist = (c / e - 1) * 100;
      const touched = data[i].l <= e;
      if (touched && c >= e) {
        s += 12;
        pts.push({
          k: '回踩',
          v: `最低 ${data[i].l.toFixed(2)} 已踩到 20EMA（${e.toFixed(2)}），收盘 ${c.toFixed(2)} 收回线上 —— 这就是原文说的「主力洗盘后的二次承接区」`,
        });
      } else if (c < e) {
        if (dist > -3) {
          s += 2;
          pts.push({ k: '回踩', v: `收盘在 20EMA 下方 ${Math.abs(dist).toFixed(1)}%，贴线但没收回，等一根收复均线再确认` });
        } else {
          s -= 12;
          pts.push({ k: '回踩', v: `收盘低于 20EMA ${Math.abs(dist).toFixed(1)}%，20EMA 已失守，这是走坏不是回踩` });
        }
      } else if (dist > 15) {
        s -= 10;
        pts.push({ k: '位置', v: `高于 20EMA ${dist.toFixed(1)}%，原文要求回到线附近才买，这个位置追进去止损太远、盈亏比不划算` });
      } else {
        pts.push({ k: '位置', v: `高于 20EMA ${dist.toFixed(1)}%，还没回到线附近，等回踩再谈` });
      }

      /* ⑤ 均线方向：20EMA 向上是原文的隐含前提（涨幅加速条件里带） */
      const ePrev = A(e20, i - 5);
      if (ePrev != null) {
        const sl = (e / ePrev - 1) * 100;
        if (sl > 0.5) { s += 5; pts.push({ k: '均线方向', v: `20EMA 近 5 根上行 ${sl.toFixed(2)}%，中期趋势向上，回踩才有支撑意义` }); }
        else if (sl < -0.5) { s -= 8; pts.push({ k: '均线方向', v: `20EMA 近 5 根下行 ${Math.abs(sl).toFixed(2)}%，均线向下时的回踩是反抽不是支撑` }); }
        else pts.push({ k: '均线方向', v: `20EMA 走平（5 根 ${sl.toFixed(2)}%），支撑力度一般` });
      }

      /* ⑥ 当日确认：涨超 3% + 收阳 */
      const chg = (c / data[i - 1].c - 1) * 100;
      if (isDay) {
        if (chg > 3) {
          s += 8;
          pts.push({ k: '当日确认', v: `涨幅 ${chg.toFixed(2)}%，达到原文的 3% 门槛，资金重新进攻` });
        } else if (chg > 0) {
          s += 2;
          pts.push({ k: '当日确认', v: `涨幅 ${chg.toFixed(2)}%，红盘但没到 3%，确认力度不足` });
        } else {
          s -= 6;
          pts.push({ k: '当日确认', v: `跌幅 ${chg.toFixed(2)}%，回踩当天还在跌，说明承接盘没出现` });
        }
        const rng = data[i].h - data[i].l;
        if (rng > 0) {
          const body = (c - data[i].o) / rng;
          pts.push({ k: 'K线形态', v: `实体占振幅 ${(body * 100).toFixed(0)}%，收盘在当日 ${(((c - data[i].l) / rng) * 100).toFixed(0)}% 分位${body > 0.5 ? '，实体饱满' : '，上下影偏长'}` });
        }
      }

      /* ⑦ 过热过滤：原文的两个反条件 */
      if (!amp.no3up[i]) {
        s -= 10;
        pts.push({ k: '过热过滤', v: '此前已连续三根收阳，原文的「非三连阳」不通过 —— 追在过热末端的胜率明显偏低' });
      }
      if (!amp.noGapHigh[i]) {
        s -= 8;
        pts.push({ k: '形态过滤', v: '近 5 日出现「开盘价=最高价」（高开即最高、全天走低），原文明确排除这种出货形态' });
      }

      /* ⑧ 信号新鲜度：六重条件是否当日同时成立 */
      let sigAge = -1;
      if (isDay) {
        for (let k = i; k >= Math.max(0, i - 3); k--) if (S.sig[k]) { sigAge = i - k; break; }
      }
      if (sigAge === 0) {
        s += 35;
        pts.push({ k: '信号', v: '六重条件今天同时成立：涨停基因 + 振幅破 3 + 5 日加速 + 回踩 20EMA + 涨超 3% + 非过热，这就是原文的「二次启动」买点' });
      } else if (sigAge > 0) {
        s += 22;
        pts.push({ k: '信号', v: `${sigAge} 根前出现过完整的「回踩启动」信号，仍在有效期内，但已经不是最优入场位` });
      } else if (isDay) {
        pts.push({ k: '信号', v: '近 4 根没有六重条件全部成立的点，当前是「条件在凑、还没扣扳机」的状态' });
      }

      // 与 sig 完全同口径，避免出现「6/6 成立却没有信号」
      const okN = [S.recentLimit[i], S.ampCross[i], accN > 0, touched, chg > 3, amp.no3up[i] && amp.noGapHigh[i]]
        .filter(Boolean).length;
      pts.push({ k: '条件计数', v: `${okN}/6 项成立（涨停基因 / 振幅破3 / 5日加速 / 回踩20EMA / 当日涨3% / 形态不过热）` });

      // 没有涨停基因时，这套战法的前提不成立，评分封顶中性，不给正向推荐
      if (limCnt === 0) s = Math.min(s, 0);
      s = Math.max(-100, Math.min(100, Math.round(s)));

      let verdict;
      if (!isDay) {
        verdict = `${ctx.periodName}视图下涨停制度不成立，只能看 20EMA 这一层：当前价 ${c.toFixed(2)}、20EMA ${e.toFixed(2)}，偏离 ${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%。要看完整信号请切回日线。`;
      } else if (sigAge === 0) {
        verdict = `六重条件今天全部成立 —— 涨停基因、振幅破 3、5 日加速、回踩 20EMA 后收阳涨 ${chg.toFixed(1)}%，正是原文要找的二次启动点。止损放这根 K 线最低价下方，跌破 20EMA 收盘价即失效。`;
      } else if (sigAge > 0) {
        verdict = `${sigAge} 根前触发过完整信号，现在价 ${c.toFixed(2)}、距 20EMA ${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%。信号仍在有效期，但已经不是最佳位置，回踩 20EMA 不破可继续持有，追高要等新的回踩。`;
      } else if (c < e && dist < -3) {
        // 破位比「有没有涨停」更紧急，先说
        verdict = `已经跌破 20EMA ${Math.abs(dist).toFixed(1)}%（现价 ${c.toFixed(2)}、均线 ${e.toFixed(2)}），这不是洗盘回踩而是趋势走坏。原文的做法是等重新站上 20EMA 再看，不要在均线下方接。`;
      } else if (limCnt === 0) {
        verdict = `近 15 日没有涨停，这套战法的前提（资金强势介入过）不成立。当前价 ${c.toFixed(2)}、20EMA ${e.toFixed(2)}，均线形态可以参考，但不要按「涨停回踩」的逻辑进场。`;
      } else if (touched && c >= e && chg <= 3) {
        verdict = `已经回踩到 20EMA 并收回线上，就差「当日涨超 3%」这一下确认。这种位置是观察位：次日放量收阳、涨幅过 3% 就是原文的扣扳机时刻；再破 20EMA 则条件作废。`;
      } else if (dist > 10) {
        verdict = `当前价高出 20EMA ${dist.toFixed(1)}%，离回踩位还远。原文只做回踩，不追高 —— 挂等价格回到 ${(e * 1.01).toFixed(2)} 附近再看信号。`;
      } else {
        verdict = `涨停基因在，但六项条件只满足 ${okN} 项，还没凑齐。当前价 ${c.toFixed(2)}、20EMA ${e.toFixed(2)}，等振幅重新放大到 3 以上、并且回踩均线收阳，才是原文的入场时机。`;
      }

      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 二买：五日急跌后的强势反击
   * 来源：公众号「桔子写指标」《把二买做稳做精，一个指标可以帮你》
   *
   * 原文要解决的是二买的两个典型误判：把弱势反弹当二买、把高位加速当二买。
   * 所以它用 7 个条件把「抛压释放 → 反弹没透支 → 重新贴近压力 → 放量共振」串起来：
   *   ① 5 日内跌超 5%          抛压集中释放（FILTER 10 根内只认第一次）
   *   ② 距急跌 < 150 根        结构不能太旧
   *   ③ 开盘距阶段前高 < 10%   回到压力区附近
   *   ④ 距急跌低点反弹 < 50%   没透支空间
   *   ⑤ 5 日涨幅 < 8%          短期没涨过头
   *   ⑥ 当日量 > 前日 1.5 倍   放量确认
   *   ⑦ 同时上穿 5/10/20 日线 + 20 日线向上   均线共振
   *   ⑧ 当日涨幅 > 3%          最后一道确认
   * ============================================================ */
  QL.registerStrategy({
    id: 'ermai',
    name: '二买强势反击',
    short: '二买',
    color: '#45D1B8',
    sub: 'erm',
    desc: '五日急跌释放抛压 · 反弹未透支 · 三线共振收复',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const E = ind.erm;
      const out = [];

      /* 三线：原文要求「同时上穿 5/10/20 日线」，不画出来看不出在共振什么 */
      const lines = [
        ['ma5', 'rgba(232,184,75,.55)', 1.0],
        ['ma10', 'rgba(76,141,255,.55)', 1.0],
        ['ma20', 'rgba(246,70,93,.7)', 1.2],
      ];
      for (const [key, col, w] of lines) {
        const pts = [];
        for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
          if (ind[key][i] != null) pts.push([i, ind[key][i]]);
        }
        if (pts.length > 1) out.push({ type: 'line', pts, color: col, width: w });
      }

      // 5 日跌幅、150 根窗口、20 日均线全是日线口径，周/月线只留均线作参考
      if (ctx.period !== 'day') return out;

      const last = n - 1;
      const jjd = E.jjd[last];
      const qg = E.qg[last];
      /* 阶段前高：急跌起点那三根的最高价。它是这套战法的压力参照，
       * 原文用「开盘距它 <10%」来判断「是不是重新回到了关键压力区」。 */
      if (jjd != null && jjd >= 1 && jjd < 150 && qg != null) {
        const from = Math.max(vs.lo, last - jjd - 6);
        out.push({
          type: 'line', pts: [[from, qg], [last, qg]],
          color: 'rgba(255,159,67,.55)', width: 1.1, dash: [5, 4],
        });
        out.push({
          type: 'label', i: Math.max(from + 1, vs.lo + 1), p: qg,
          text: '前高 ' + qg.toFixed(2), color: 'rgba(255,159,67,.9)', align: 'left', dy: -12, size: 9.5,
        });
      }

      /* 信号：急跌结构起点（只标当前这一段，历史上每 10 根就有一个，全画会糊住 K 线）
       * + 七条同时成立（全历史，这是真正的买点） */
      const cands = [];
      if (jjd != null && jjd >= 1 && jjd < 150) {
        const si = last - jjd;
        if (si >= vs.lo && si < vs.hi) {
          cands.push({ i: si, prio: 2, m: { text: '急跌', color: 'rgba(160,172,190,.9)', r: 2.8, above: true } });
        }
      }
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (E.hit[i]) cands.push({ i, prio: 1, m: { text: '☆强势出击', color: '#F6465D', r: 4.4, bold: true, above: false } });
      }
      const lastIdx = vs.hi >= n ? last : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 74, lastIdx)) {
        out.push({
          type: 'marker', i, p: m.above ? data[i].h : data[i].l,
          color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
          r: m.r, bold: m.bold, align: i > n - 10 ? 'right' : 'center',
        });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1;
      const E = ind.erm;
      const c = data[i].c;
      const pts = [];
      const ik = ctx.idxK || 1;
      const dropTh = 5 * ik, jumpTh = 3 * ik;

      if (ctx.period !== 'day') {
        const m20 = ind.ma20[i];
        return {
          score: 0,
          verdict: `这套战法的每个条件都按日线根数定义（5 日跌幅 ${dropTh.toFixed(1)}%、单日 ${jumpTh.toFixed(1)}%、150 根有效期、20 日均线），${ctx.periodName}上这些数字的含义已经变了。当前价 ${c.toFixed(2)}、20 日均线 ${m20 != null ? m20.toFixed(2) : '—'}，看完整信号请切回日线。`,
          points: [{ k: '周期', v: `${ctx.periodName}不适用（5 日 / 150 根都是日线口径）` }],
        };
      }
      if (n < 60) {
        return {
          score: 0,
          verdict: `历史数据只有 ${n} 根，「急跌 → 休整 → 再攻」这三段还没走完，无法判断。`,
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }

      const jjd = E.jjd[i];
      let sigAge = -1;
      for (let m = i; m >= Math.max(0, i - 8); m--) if (E.hit[m]) { sigAge = i - m; break; }

      if (jjd == null) {
        return {
          score: 0,
          verdict: `全历史没有出现过「5 日内跌超 ${dropTh.toFixed(1)}%」的急跌，这套战法的前提（抛压集中释放）不成立。现价 ${c.toFixed(2)}，走势平稳，不适合用二买逻辑去套。`,
          points: [{ k: '急跌背景', v: `全历史无 5 日跌超 ${dropTh.toFixed(1)}% 的记录` }],
        };
      }
      if (jjd >= 150) {
        return {
          score: 0,
          verdict: `最近一次急跌在 ${jjd} 根之前，已超出原文的 150 根有效期 —— 结构过期，之后的上涨不再算「二买」，要等下一次急跌重建结构。现价 ${c.toFixed(2)}。`,
          points: [{ k: '急跌背景', v: `距急跌 ${jjd} 根，超过 150 根窗口` }],
        };
      }

      /* ---------- 结构分：急跌在窗口内，逐条核对「反弹有没有走样」 ---------- */
      let base = 0;
      const sigI = i - jjd;
      const chg = E.chgPct[i];
      const gap = E.gapPct[i];                       // 原文口径：开盘价距前高
      const qg = E.qg[i];
      const gapC = qg ? (c - qg) / qg * 100 : null;   // 收盘价距前高（更贴近当下）
      const reb = E.rebound[i];
      const five = E.fivePct[i];
      const vr = E.volRatio[i];
      const m20 = ind.ma20[i], m20p = ind.ma20[i - 1];

      // ① 急跌结构
      let dropPct = null;
      if (sigI >= 5 && data[sigI - 5].c) {
        dropPct = (data[sigI - 5].c - data[sigI].c) / data[sigI - 5].c * 100;
      }
      base += 6;
      pts.push({
        k: '急跌背景',
        v: `${data[sigI].d} 那根 5 日累计跌 ${dropPct != null ? dropPct.toFixed(1) : '—'}%（阈值 ${dropTh.toFixed(1)}%），距今 ${jjd} 根，抛压已经释放`,
      });

      // ② 距阶段前高：原文要求「重新回到关键压力区附近」
      if (gap != null && qg != null) {
        if (gap >= -10 && gap <= 5) {
          base += 8;
          pts.push({ k: '距前高', v: `开盘 ${data[i].o.toFixed(2)} 对前高 ${qg.toFixed(2)} 为 ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}%，正在原文要求的 10% 压力区内（收盘 ${gapC >= 0 ? '+' : ''}${gapC.toFixed(1)}%）` });
        } else if (gap > 5 && gap <= 10) {
          base += 3;
          pts.push({ k: '距前高', v: `开盘已高于前高 ${gap.toFixed(1)}%，虽然仍满足「<10%」，但已经在突破区里，不是回踩位` });
        } else if (gap < -10 && gap >= -20) {
          base += 2;
          pts.push({ k: '距前高', v: `开盘距前高 ${gap.toFixed(1)}%，还没真正回到压力区，差最后一段` });
        } else if (gap < -20) {
          base -= 2;
          pts.push({ k: '距前高', v: `开盘距前高 ${gap.toFixed(1)}%，离压力区太远 —— 这是弱势反弹，不是原文说的「重新靠近前高」` });
        } else {
          base -= 4;
          pts.push({ k: '距前高', v: `开盘已高出前高 ${gap.toFixed(1)}%，原文要求不超过 10%，这个位置已属突破追高` });
        }
      }

      // ③ 从急跌低点的反弹幅度：50% 是上限，过了就是透支
      if (reb != null) {
        if (reb < 30) {
          base += 6;
          pts.push({ k: '反弹幅度', v: `距急跌后的最低点只反弹 ${reb.toFixed(1)}%（上限 50%），空间没被吃掉，后面还有余量` });
        } else if (reb < 50) {
          base += 3;
          pts.push({ k: '反弹幅度', v: `已反弹 ${reb.toFixed(1)}%，逼近 50% 上限 —— 还能做，但盈亏比在变差` });
        } else {
          base -= 8;
          pts.push({ k: '反弹幅度', v: `已反弹 ${reb.toFixed(1)}%，超过 50% 上限 —— 原文明确排除，此时进场是在给别人抬轿` });
        }
      }

      // ④ 5 日涨幅：8% 是上限，对应「不要追在加速段」
      if (five != null) {
        if (five <= 0) {
          base += 4;
          pts.push({ k: '5日涨幅', v: `${five.toFixed(1)}%，五日还是跌的，今天才算第一根反击，位置不高` });
        } else if (five <= 8) {
          base += 4;
          pts.push({ k: '5日涨幅', v: `${five.toFixed(1)}%，在 8% 上限内，没有提前透支` });
        } else {
          base -= 6;
          pts.push({ k: '5日涨幅', v: `${five.toFixed(1)}%，已超 8% 上限 —— 这是高位加速，正是原文要过滤掉的第二种误判` });
        }
      }

      // ⑤ 量能：1.5 倍是「资金真回来了」的门槛
      if (vr != null) {
        if (vr > 1.5) {
          base += 6;
          pts.push({ k: '量能', v: `${vr.toFixed(2)}× 前一日，过 1.5 倍门槛，反弹有量能背书` });
        } else if (vr > 1) {
          base += 1;
          pts.push({ k: '量能', v: `${vr.toFixed(2)}× 前一日，温和放量但没到 1.5 倍 —— 承接力度还差一档` });
        } else {
          base -= 4;
          pts.push({ k: '量能', v: `${vr.toFixed(2)}× 前一日，缩量反弹，没有增量资金进场` });
        }
      }

      // ⑥ 均线共振：三线同时上穿才是原文的核心动作
      const above = ['ma5', 'ma10', 'ma20'].filter(key => ind[key][i] != null && c > ind[key][i]).length;
      const up20 = m20 != null && m20p != null && m20 > m20p;
      if (E.cJx[i]) {
        base += 12;
        pts.push({ k: '均线共振', v: `今天同时上穿 5/10/20 日线，且 20 日线向上 —— 三条线粘合后被一根阳线一起收复，这是原文最强的那个动作` });
      } else if (above === 3 && up20) {
        base += 6;
        pts.push({ k: '均线共振', v: `收盘站上全部三线、20 日线向上，但「同时上穿」发生在更早的某根，今天不是那个时点` });
      } else if (above === 3) {
        base += 3;
        pts.push({ k: '均线共振', v: `站上三线，但 20 日线仍向下 —— 均线方向不配合，反弹容易夭折` });
      } else {
        base -= 2;
        pts.push({ k: '均线共振', v: `只站上 ${above}/3 条均线，${above < 2 ? '还没形成多头结构' : '差一口气'}` });
      }

      // ⑦ 当日确认
      if (chg > jumpTh) {
        base += 5;
        pts.push({ k: '当日确认', v: `涨 ${chg.toFixed(2)}%，过 ${jumpTh.toFixed(1)}% 门槛，最后一道确认到位` });
      } else if (chg > 0) {
        base += 1;
        pts.push({ k: '当日确认', v: `涨 ${chg.toFixed(2)}%，红盘但没到 ${jumpTh.toFixed(1)}%，确认力度不足` });
      } else {
        base -= 3;
        pts.push({ k: '当日确认', v: `跌 ${Math.abs(chg).toFixed(2)}%，反击当天还在跌，说明买盘没接住` });
      }

      /* 结构分封顶：没有信号时最多 +22，避免「有急跌背景」就等于偏多；
       * 有信号时放开到 +45，让「八项全中」和「勉强凑齐」在分数上能分开 */
      base = Math.max(-25, Math.min(sigAge >= 0 ? 50 : 22, base));
      let s = base;

      // 信号之后已经涨了多少 —— 二买的利润空间就是「急跌低点 → 前高」，涨过 12% 就没有性价比了
      const gainSince = sigAge > 0 ? (c / data[i - sigAge].c - 1) * 100 : 0;

      // ⑧ 信号本身
      if (sigAge === 0) {
        s += 40;
        pts.push({ k: '信号', v: '八项条件今天同时成立 —— 这就是原文的「☆强势出击」买点' });
      } else if (sigAge > 0 && gainSince > 12) {
        pts.push({ k: '信号', v: `${sigAge} 根前触发过信号，但此后已涨 ${gainSince.toFixed(1)}%，超过 12%，这一段行情基本走完了` });
      } else if (sigAge > 0 && sigAge <= 3) {
        s += 26;
        pts.push({ k: '信号', v: `${sigAge} 根前触发过完整信号（此后再涨 ${gainSince.toFixed(1)}%），仍在有效期内，但已经不是最优入场位` });
      } else if (sigAge > 0 && sigAge <= 8) {
        s += 12;
        pts.push({ k: '信号', v: `${sigAge} 根前出现过信号（此后再涨 ${gainSince.toFixed(1)}%），新鲜度下降，只剩持有参考价值` });
      }

      // 信号后的失效检查：跌破信号那根的最低价，原文这套就作废了
      let broken = false;
      if (sigAge >= 0 && sigAge <= 6) {
        const sigLow = data[i - sigAge].l;
        if (c < sigLow) broken = true;
      }

      const okN = [E.cDr[i], E.cJd[i], E.cKj[i], E.cFb[i], E.cWz[i], E.cFl[i], E.cJx[i]].filter(Boolean).length;
      pts.push({
        k: '条件计数',
        v: `${okN}/7 项成立（当日涨${jumpTh.toFixed(1)}% / 150根内 / 距前高<10% / 反弹<50% / 5日涨<8% / 量>1.5× / 三线共振）`,
      });

      if (broken) {
        s = Math.min(s, -12);
        pts.push({ k: '失效', v: `收盘 ${c.toFixed(2)} 已跌破信号那根的最低价 ${data[i - sigAge].l.toFixed(2)}，这次二买失败，按原文该止损离场` });
      }

      s = Math.max(-100, Math.min(100, Math.round(s)));

      let verdict;
      if (broken) {
        verdict = `信号发出后已经跌破信号 K 线的最低价 ${data[i - sigAge].l.toFixed(2)}（现价 ${c.toFixed(2)}），这次二买失败 —— 原文的止损位就在那里，破了就认，不要摊平。`;
      } else if (sigAge === 0) {
        verdict = `八项条件今天全部成立：${data[sigI].d} 起的急跌 ${dropPct != null ? dropPct.toFixed(1) : '—'}% 已完成洗盘，今天放量 ${vr != null ? vr.toFixed(2) : '—'}× 涨 ${chg.toFixed(2)}%，一根阳线同时收复 5/10/20 日线。止损放这根 K 线最低价 ${data[i].l.toFixed(2)} 下方，上方压力看前高 ${qg != null ? qg.toFixed(2) : '—'}。`;
      } else if (sigAge > 0 && gainSince > 12) {
        verdict = `${sigAge} 根前发出信号时收 ${data[i - sigAge].c.toFixed(2)}，现在 ${c.toFixed(2)}，已经走了 ${gainSince.toFixed(1)}% —— 二买的利润空间是「急跌低点 → 前高」这一段，走到这里性价比已经很低了。没上车的别追，已在车上的按 5 日线推移止盈。`;
      } else if (reb != null && reb >= 50) {
        verdict = `从这个急跌低点已经反弹 ${reb.toFixed(1)}%，超过原文 50% 的上限 —— 空间被吃掉大半，现在不是二买而是追反弹。等下一次急跌重建结构再看。`;
      } else if (five != null && five > 8) {
        verdict = `五日涨了 ${five.toFixed(1)}%，超过 8% 上限，属于「高位加速」—— 原文专门要过滤这种，看似突破其实已在压力区末端。现价 ${c.toFixed(2)}，前高 ${qg != null ? qg.toFixed(2) : '—'}。`;
      } else if (gap != null && gap < -20) {
        verdict = `距阶段前高还有 ${Math.abs(gap).toFixed(1)}%，股价根本没回到压力区，这只是弱势反弹。原文的条件是「开盘距前高 <10%」，差得远，等它爬回来再说。`;
      } else if (sigAge > 0) {
        verdict = `${sigAge} 根前触发过「☆强势出击」（当时涨 ${(E.chgPct[i - sigAge] || 0).toFixed(1)}%），此后涨 ${gainSince.toFixed(1)}%。现价 ${c.toFixed(2)}、前高 ${qg != null ? qg.toFixed(2) : '—'}（距 ${gapC != null ? (gapC >= 0 ? '+' : '') + gapC.toFixed(1) : '—'}%），只要不破信号 K 线最低价 ${data[i - sigAge].l.toFixed(2)}，结构仍有效；跌破就是失败。`;
      } else {
        verdict = `急跌结构在（${jjd} 根前，${dropPct != null ? dropPct.toFixed(1) : '—'}%），但七项只满足 ${okN} 项，还没凑齐。当前价 ${c.toFixed(2)}、前高 ${qg != null ? qg.toFixed(2) : '—'}、20 日线 ${m20 != null ? m20.toFixed(2) : '—'}${up20 ? '（向上）' : '（向下）'} —— 差的主要是「放量 + 三线同时上穿」这个动作。`;
      }

      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 威科夫操盘法（Wyckoff Method）
   * 三大定律：供需 / 因果 / 努力与结果
   * 吸筹事件序列：PS→SC→AR→ST→Spring→Test→SOS→LPS→BU
   * 派发序列：PSY→BC→AR→ST→UT/UTAD→SOW→LPSY
   * ============================================================ */
  function wyScan(ctx) {
    const { data, ind } = ctx;
    const n = ctx.n;
    const vma = ind.volMa20;
    const atr = ind.dmi.atr;
    const E = { SC: [], BC: [], ST: [], SP: [], TEST: [], SOS: [], LPS: [], UT: [], SOW: [] };

    /* ---- 交易区间：自适应窗口 ----
     * 从最近 40 根起逐步扩大，直到横盘结构被破坏为止。
     * A 股吸筹常压 1~3 个月（20~60 根），美股能拖 6 个月以上，固定窗口两头不讨好。
     * 上下沿用「最低价的 10% 分位 / 最高价的 90% 分位」，比 min/max 抗单根插针。
     */
    // 60 根（约 3 个月）起步：更短的窗口噪音太大，随便一段回调都能凑成「区间」。
    // 上限 120 根（半年）：再长就会把一整轮上涨+回落包进来，那不是横盘。
    const minW = Math.min(60, n - 1);
    const maxW = Math.min(120, n - 1);
    let W = 0, lo = Math.max(1, n - minW);
    let sup = 0, res = 0, mid = 0, rangeH = 0, crosses = 0, isRange = false;
    let lastCalc = null;
    for (let w = minW; w <= maxW; w += 8) {
      const l2 = n - w;
      const L = [], Hh = [];
      for (let i = l2; i < n; i++) { L.push(data[i].l); Hh.push(data[i].h); }
      L.sort((a, b) => a - b); Hh.sort((a, b) => a - b);
      const s2 = L[Math.floor(L.length * 0.10)] || 0;
      const r2 = Hh[Math.floor(Hh.length * 0.90)] || 0;
      const m2 = (s2 + r2) / 2, h2 = r2 - s2;
      if (!(h2 > 0 && m2 > 0)) break;
      // 穿越中轴次数：单边趋势很少来回穿，横盘才会反复穿。
      // 这比只看净位移本质 —— 跌 30% 再反弹 20% 也是「净位移小」，但不是横盘。
      let cr = 0;
      for (let i = l2 + 1; i < n; i++) if ((data[i - 1].c - m2) * (data[i].c - m2) < 0) cr++;
      // 支撑/阻力必须被反复触及而未有效突破，才算「结构性边界」。
      // 只取分位数的话，任何股票都能凑出一个价位 —— 那是统计噪音，不是威科夫说的支撑。
      let supTests = 0, resTests = 0;
      for (let i = l2; i < n; i++) {
        if (data[i].l <= s2 * 1.02 && data[i].c > s2 * 0.995) supTests++;
        if (data[i].h >= r2 * 0.98 && data[i].c < r2 * 1.005) resTests++;
      }
      lastCalc = { w, l2, s2, r2, m2, h2, cr, supTests, resTests };
      const ok = Math.abs(data[n - 1].c - data[l2].c) / h2 < 0.6 && cr >= 4
        && h2 / m2 > 0.08 && h2 / m2 < 0.35
        && supTests >= 3 && resTests >= 3;
      if (ok) {
        W = w; lo = l2; sup = s2; res = r2; mid = m2; rangeH = h2; crosses = cr; isRange = true;
      } else if (isRange) {
        break;                       // 已经找到横盘段，再往前结构破坏了，停
      }
    }
    if (!W && lastCalc) {
      // 全窗口都不满足：仍保留最长窗口的数值作「参考区间」，但明确标记不成立
      W = lastCalc.w; lo = lastCalc.l2;
      sup = lastCalc.s2; res = lastCalc.r2; mid = lastCalc.m2;
      rangeH = lastCalc.h2; crosses = lastCalc.cr;
    }
    const c0 = data[lo].c, cLast = data[n - 1].c;

    const cp = (d) => { const r = d.h - d.l; return r > 0 ? (d.c - d.l) / r : 0.5; };
    const vrAt = (i) => (vma[i] ? data[i].v / vma[i] : 1);

    /* ---- ①② 抛售高潮 / 买入高潮：宽幅 + 巨量 + 收盘反向脱离极值 ----
     * 收盘位置条件天然排除了涨跌停（一字板 h=l，涨跌停收盘贴边），
     * 所以不需要额外判断「是不是一字板」 */
    for (let i = lo + 1; i < n; i++) {
      const d = data[i], p = data[i - 1];
      if (!p.c) continue;
      const chg = d.c / p.c - 1;
      const vr = vrAt(i);
      if (d.h <= d.l) continue;
      if (chg <= -0.045 && vr >= 1.6 && cp(d) >= 0.35) E.SC.push(i);
      if (chg >= 0.045 && vr >= 1.6 && cp(d) <= 0.65) E.BC.push(i);
    }

    /* ---- ③ 二次测试：回到 SC 低点附近，量显著萎缩，且不深破 SC 低点 ---- */
    for (const s of E.SC) {
      for (let j = s + 4; j < Math.min(n, s + 45); j++) {
        const d = data[j];
        const gap = (d.l - data[s].l) / data[s].l;
        if (gap > 0.035 || gap < -0.02) continue;
        if (data[j].v < data[s].v * 0.75) { E.ST.push(j); break; }
      }
    }

    /* ---- ④ Spring：盘中跌破区间下沿、收盘收回 ---- */
    for (let i = Math.max(lo + 5, 6); i < n; i++) {
      const d = data[i];
      if (!(d.l < sup * 0.995 && d.c > sup * 1.001)) continue;
      // 前 3 根至少 2 根在区间内，排除「趋势下跌途中」被误判成弹簧
      let inside = 0;
      for (let k = i - 3; k < i; k++) if (data[k].c > sup * 0.99) inside++;
      if (inside < 2) continue;
      // 巨量破位更像真破位（>2.4× 均量），不接受
      if (vrAt(i) > 2.4) continue;
      // 关键：这条支撑必须此前被至少 2 次触及而未跌破。
      // 威科夫的 Spring 是「对已被验证的支撑做最后一次假破」，不是随便哪天盘中新低。
      let prior = 0;
      for (let k = lo; k < i - 1; k++) if (data[k].l <= sup * 1.02 && data[k].c > sup * 0.995) prior++;
      if (prior < 2) continue;
      // Spring 是 Phase C，只发生在区间后段；前段的「破位又收回」只是区间内的正常波动
      if (i < lo + W * 0.5) continue;
      // 同一次震仓连续几根都满足时只留最后一根
      if (E.SP.length && i - E.SP[E.SP.length - 1] < 10) E.SP[E.SP.length - 1] = i;
      else E.SP.push(i);
    }

    /* ---- ⑤ Test：Spring 后缩量回踩，且低点抬高 ---- */
    for (const s of E.SP) {
      for (let j = s + 2; j < Math.min(n, s + 15); j++) {
        const d = data[j];
        if (d.l > data[s].l * 1.002 && d.c > sup * 0.99 && d.v < data[s].v * 0.85) { E.TEST.push(j); break; }
      }
    }

    /* ---- ⑥ SOS：放量上攻。站上中轴，或单日大涨 5% 以上（放量长阳本身就是强势信号） ---- */
    for (let i = lo + 1; i < n; i++) {
      const d = data[i], p = data[i - 1];
      if (!p.c) continue;
      const chg = d.c / p.c - 1;
      // 「从下方向上穿越中轴」或「收盘创 20 根新高」才是 SOS 的动作
      const crossed = p.c <= mid * 1.005 && d.c > mid;
      let hh20 = 0;
      for (let k = Math.max(lo, i - 20); k < i; k++) if (data[k].c > hh20) hh20 = data[k].c;
      if (chg >= 0.025 && vrAt(i) >= 1.6 && (crossed || d.c > hh20)) E.SOS.push(i);
    }

    /* ---- ⑦ LPS：SOS 后缩量回踩，守住区间上半部（前阻力转支撑） ---- */
    for (const s of E.SOS) {
      for (let j = s + 2; j < Math.min(n, s + 20); j++) {
        const d = data[j];
        if (d.l > sup + rangeH * 0.45 && d.c > mid && d.v < data[s].v * 0.9) { E.LPS.push(j); break; }
      }
    }

    /* ---- ⑧ UT 上冲回落 / ⑨ SOW 弱势跌破 ---- */
    for (let i = lo + 1; i < n; i++) {
      const d = data[i], p = data[i - 1];
      if (!p.c) continue;
      // UT 必须是「从阻力下方上冲、收盘又回落」，回落要有幅度（影线 > 0.5 ATR），
      // 且这条阻力此前已被至少 2 次冲击未破 —— 否则只是上涨途中一次普通的冲高
      if (d.h > res * 1.005 && p.c < res && d.c < res * 0.995
        && vrAt(i) >= 1.2 && (d.h - d.c) > (atr[i] || 0) * 0.5) {
        let prior = 0;
        for (let k = lo; k < i - 1; k++) if (data[k].h >= res * 0.98 && data[k].c < res * 1.005) prior++;
        if (prior >= 2 && !(E.UT.length && i - E.UT[E.UT.length - 1] < 10)) E.UT.push(i);
      }
      // 必须「从中轴上方跌破中轴」，否则价格本来就在中轴下方时，
      // 每一根阴线都会被判成 SOW（11-09 那次就是这么误报的）
      if (p.c >= mid * 0.995 && d.c < mid && d.c / p.c - 1 <= -0.025 && vrAt(i) >= 1.4) E.SOW.push(i);
    }

    /* ---- 阶段判定 ----
     * 关键原则：威科夫的事件体系全部是「相对交易区间」定义的。
     * 区间不成立（净位移超过区间高度 60%）就是趋势行情，此时硬套「吸筹 C 段」是错的。
     * 区间成立时，再看事件时间线：谁最后发生，谁决定当前状态。
     */
    const lastIn = (arr, k) => {
      for (let t = arr.length - 1; t >= 0; t--) if (arr[t] >= n - k) return arr[t];
      return -1;
    };
    const EVW = 45;   // 与下方事件展示窗口保持一致
    const rSP = lastIn(E.SP, EVW), rTEST = lastIn(E.TEST, EVW), rSOS = lastIn(E.SOS, EVW);
    const rLPS = lastIn(E.LPS, EVW), rUT = lastIn(E.UT, EVW), rSOW = lastIn(E.SOW, EVW);
    const rBC = lastIn(E.BC, 90), rSC = lastIn(E.SC, 120), rST = lastIn(E.ST, 120);

    // 近 60 根的事件时间线
    const evOrder = [];
    for (const k of ['SP', 'TEST', 'SOS', 'LPS', 'UT', 'SOW', 'SC', 'BC', 'ST']) {
      const idx = lastIn(E[k], EVW);
      if (idx >= 0) evOrder.push({ k, i: idx });
    }
    evOrder.sort((a, b) => b.i - a.i);
    const lastEv = evOrder[0] || null;

    const ma20 = ind.ma20;
    const e20 = ma20[n - 1], e20p = ma20[n - 6];
    const trendUp = e20 != null && e20p != null && e20 > e20p && cLast > e20;

    let pk;
    if (!isRange) {
      // 趋势行情：事件体系失效，只按趋势方向定性
      pk = trendUp ? 'markup' : (cLast < sup * 0.99 ? 'markdown' : 'trendDown');
    } else if (cLast < sup * 0.99 && rSOW >= 0) {
      pk = 'markdown';
    } else if (cLast > res * 1.005 && (rSOS >= 0 || rLPS >= 0)) {
      pk = 'markup';
    } else if (lastEv && lastEv.k === 'UT' && cLast > mid) {
      pk = 'distribution';
    } else if (lastEv && lastEv.k === 'SOW' && cLast < mid) {
      pk = 'weak';                                    // 区间内走弱，还没破位
    } else if (lastEv && (lastEv.k === 'SP' || lastEv.k === 'TEST') && cLast > mid * 0.95) {
      // 弹簧之后价格必须真的回到区间中部，否则只是「又跌回去了」，不构成 C 段
      pk = lastEv.k === 'TEST' ? 'phaseC' : 'phaseC0';
    } else if (rSOS >= 0 && rLPS >= 0 && cLast > mid * 0.98) {
      // D 段 = SOS 之后还有 LPS（缩量回踩守住）。只有 SOS 没有回踩，说明还没验证过支撑
      pk = 'phaseD';
    } else if (lastEv && lastEv.k === 'SOS' && cLast > mid * 0.98) {
      pk = 'phaseD0';
    } else if (rSC >= 0 || rST >= 0) {
      pk = 'phaseB';
    } else {
      pk = 'phaseB';
    }

    const PHASE = {
      markup: { name: '上涨（E 段）', bias: 1 },
      phaseD: { name: '吸筹 D 段 · 突破前', bias: 0.85 },
      phaseD0: { name: '吸筹 D 段 · 强势待回踩', bias: 0.6 },
      phaseC: { name: '吸筹 C 段 · 弹簧已确认', bias: 1 },
      phaseC0: { name: '吸筹 C 段 · 弹簧待确认', bias: 0.6 },
      phaseB: { name: '吸筹 B 段 · 建仓中', bias: 0.4 },
      weak: { name: '区间内走弱（中轴下方）', bias: -0.5 },
      trendDown: { name: '下降趋势（区间不成立）', bias: -0.6 },
      range: { name: '区间未定', bias: 0 },
      distribution: { name: '派发（出货）', bias: -0.85 },
      markdown: { name: '下跌（Markdown）', bias: -1 },
    };

    /* ---- 努力 / 结果：近 20 根上涨日均量 ÷ 下跌日均量 ---- */
    let upV = 0, upN = 0, dnV = 0, dnN = 0;
    for (let i = Math.max(1, n - 20); i < n; i++) {
      if (data[i].c >= data[i - 1].c) { upV += data[i].v; upN++; }
      else { dnV += data[i].v; dnN++; }
    }
    const upAvg = upN ? upV / upN : 0;
    const dnAvg = dnN ? dnV / dnN : 0;
    const volumeRatio = dnAvg > 0 ? upAvg / dnAvg : 1;

    return {
      W, lo, sup, res, mid, rangeH, isRange, crosses,
      ev: E, phase: pk,
      // 区间不成立时 E 段/Markdown 的措辞要换掉，否则「E 段」读起来像吸筹已经完成
      phaseName: !isRange && pk === 'markup' ? '上升趋势（区间不成立）'
        : !isRange && pk === 'markdown' ? '下跌趋势（区间不成立）'
        : PHASE[pk].name,
      bias: PHASE[pk].bias,
      recent: { SP: rSP, TEST: rTEST, SOS: rSOS, LPS: rLPS, UT: rUT, SOW: rSOW, BC: rBC, SC: rSC, ST: rST },
      lastEv,
      upAvg, dnAvg, volumeRatio,
      targetUp: res + rangeH,          // 因果定律：横向计数用区间高度投影
      targetDn: sup - rangeH,
      posInRange: rangeH > 0 ? (cLast - sup) / rangeH : 0.5,
    };
  }

  /* ============================================================
   * 36 · SKDJ 超卖反弹（弱反弹不是底）
   * 核心：超卖之后那次反弹的「力度」，决定这是底还是下跌中继。
   *   · 强反弹 —— K 抬升够、价格反弹够、量能跟上、收复 MA20 → 做波段
   *   · 弱反弹 —— K 上不去、价格趴着、缩量、连 MA20 都摸不到 → 还没见底
   * 所以这个流派是双向的：既能标买点，也能明确标「假底」。
   * ============================================================ */
  QL.registerStrategy({
    id: 'skdj',
    name: 'SKDJ 超卖反弹',
    short: 'SKDJ',
    color: '#FFB020',
    sub: 'skdj',
    desc: '超卖反弹力度定真假底 · 弱反弹看空 · 强反弹做波段',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const E = ind.skdj;
      const out = [];

      /* MA20 = 波段生死线。反弹连它都收复不了，就是弱反抽。 */
      const m20 = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (ind.ma20[i] != null) m20.push([i, ind.ma20[i]]);
      }
      if (m20.length > 1) out.push({ type: 'line', pts: m20, color: 'rgba(255,176,32,.42)', width: 1.1, dash: [6, 4] });

      /* 事件标记：超卖谷（绿点）、金叉判定的强/弱（下方）、破底（上方） */
      const cands = [];
      for (const e of E.ev) {
        if (e.tIdx >= vs.lo && e.tIdx < vs.hi) {
          // 超卖谷只画一个绿点：金叉那根已经写了「强反 / 弱反」，再写一遍「超卖」纯属重复
          cands.push({ i: e.tIdx, prio: 7, m: { text: '', color: 'rgba(46,189,133,.75)', r: 2.5, above: false } });
        }
        if (e.s >= vs.lo && e.s < vs.hi) {
          const strong = e.label === '强反';
          cands.push({
            i: e.s, prio: strong ? 1 : 4,
            m: strong
              ? { text: '★强反', color: '#F6465D', r: 4.2, bold: true, above: false }
              : { text: '弱反', color: 'rgba(160,172,190,.9)', r: 2.9, above: false },
          });
        }
        if (e.brokenMark && e.lowIdx >= vs.lo && e.lowIdx < vs.hi) {
          cands.push({ i: e.lowIdx, prio: 1, m: { text: '破底', color: '#2EBD85', r: 3.6, bold: true, above: true } });
        }
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 46, lastIdx)) {
        out.push({
          type: 'marker', i, p: m.above ? data[i].h : data[i].l,
          color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
          r: m.r, bold: m.bold,
          align: i > n - 10 ? 'right' : (i < vs.lo + 5 ? 'left' : 'center'),
        });
      }

      /* 当前这次反弹的防守位：没破底才画，破了就没意义了 */
      const e = E.last;
      if (e && !e.broken && n - 1 - e.s <= 40 && e.tL > 0) {
        const x1 = Math.max(vs.lo, e.tIdx);
        out.push({
          type: 'line', pts: [[x1, e.tL], [n - 1, e.tL]],
          color: 'rgba(46,189,133,.55)', width: 1.1, dash: [5, 4],
        });
        out.push({
          type: 'label', i: Math.min(n - 1, vs.hi - 1), p: e.tL,
          text: '防守 ' + e.tL.toFixed(2), color: 'rgba(46,189,133,.85)',
          align: 'right', dy: 12, size: 9.5,
        });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1;
      const E = ind.skdj;
      const c = data[i].c;
      const k = E.k[i], d = E.d[i];
      const ma20 = ind.ma20[i];
      const osTh = E.osTh;
      const P = ctx.periodName;
      const pts = [];

      if (n < 40 || k == null) {
        return {
          score: 0,
          verdict: `历史数据只有 ${n} 根，SKDJ 连一次完整的超卖—反弹循环都还没走完，无法判断。`,
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }

      if (!E.last) {
        const deep = k < osTh ? '当前正在超卖区，' : '';
        return {
          score: 0,
          verdict: `全历史没有出现过「K 跌破 ${osTh} 后低位金叉」的结构。${deep}当前 K=${k.toFixed(1)}、D=${d.toFixed(1)}（${P}）。这套战法的前提是一次真正的超卖，没有前提就不硬套 —— 宁可空仓等，也不把中性区当成超卖。`,
          points: [
            { k: 'SKDJ', v: `K ${k.toFixed(1)} / D ${d.toFixed(1)}` },
            { k: '超卖结构', v: `历史无「K < ${osTh} 后金叉」记录` },
          ],
        };
      }

      const e = E.last, cur = E.cur;
      const age = cur.age;

      if (age > E.ageMax) {
        const nowOs = k < osTh;
        return {
          score: 0,
          verdict: `上一次超卖反弹在 ${age} 根前（${data[e.s].d} 金叉），已经超出 ${E.ageMax} 根的波段窗口，那次反弹和现在的位置没有关系了。当前 K=${k.toFixed(1)}、D=${d.toFixed(1)}。`
            + (nowOs ? ' 现在 K 又跌回超卖区，新一轮超卖正在形成，但还没金叉 —— 等金叉再谈买点。' : ' 要等下一次「跌破 20 → 低位金叉」重新建立结构。'),
          points: [
            { k: 'SKDJ', v: `K ${k.toFixed(1)} / D ${d.toFixed(1)}` },
            { k: '上次反弹', v: `${data[e.s].d}，距今 ${age} 根（窗口 ${E.ageMax} 根）` },
            { k: '当前状态', v: nowOs ? '超卖区，等待金叉' : '中性区，无有效结构' },
          ],
        };
      }

      /* ---------- 分数：强度线性映射，再按结构打补丁 ---------- */
      const mapSt = (x) => {
        // 上端刻意压住：这个流派回答的是「现在能不能买」，不是「这股强不强」。
        // 力度再大，位置不对也不该给高分。
        const tab = [[0, -45], [28, -15], [45, 8], [62, 38], [75, 55], [100, 68]];
        for (let q = 1; q < tab.length; q++) {
          const x0 = tab[q - 1][0], y0 = tab[q - 1][1], x1 = tab[q][0], y1 = tab[q][1];
          if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
        return 92;
      };

      const st = cur.strength;
      let score = mapSt(st);

      // 破底的严重程度也分档：只擦破 1~2% 和直接跌掉 10% 不是一回事
      if (cur.broken) {
        const depth = cur.lowMin / e.tL - 1;
        score = depth <= -0.08 ? -65 : depth <= -0.03 ? -58 : -50;
      }
      else if (cur.kn < osTh) score = -45;               // 反弹熄火，重新超卖
      else if (cur.kn > 80) score -= 20;                 // 推到超买，波段尾声

      /* 波段位置衰减：同一个强度，第 5 根看到和第 35 根看到，买点价值完全不同。
       * 反弹走了 30 根以上再进场，赚的是最后一截，赔的是整段回撤。 */
      // 破底 / 熄火已经是最坏结论，不再叠加位置衰减（否则会掉到 -80 以下，过度惩罚）
      if (!cur.broken && cur.kn >= osTh) {
        if (age >= 30) score -= 28;
        else if (age >= 22) score -= 18;
        else if (age >= 15) score -= 8;
      }
      // 底背离是「这次探底比上次高」的证据，一旦跌破本次谷底就不再成立
      if (e.diverge && !cur.newLow && st >= 45 && score > -30) score += 8;

      score = clamp(score, -100, 100);

      /* ---------- 数据表 ---------- */
      const onMa20 = ma20 != null && c > ma20;
      const flat = cur.pxReb != null && cur.pxReb < 2;
      const zone = cur.broken ? '破底后的反抽'
        : cur.kn < osTh ? '超卖区'
          : cur.kn > 80 ? (flat ? '高位但价格没跟上' : '超买区')
            : cur.kn >= 50 ? (flat ? '高位但价格没跟上' : '强势半区')
              : '弱势半区';

      pts.push({ k: 'SKDJ', v: `K ${cur.kn.toFixed(1)} / D ${cur.dn.toFixed(1)}（${zone}）` });
      pts.push({ k: '反弹起点', v: `${data[e.s].d} 低位金叉（谷底 K ${e.tK.toFixed(1)}），至今 ${age} 根` });
      pts.push({ k: 'K 抬升', v: `+${cur.kJump.toFixed(1)} 点（${e.tK.toFixed(1)} → 最高 ${cur.kMax.toFixed(1)}）` });
      if (cur.pxReb != null) {
        pts.push({
          k: '价格反弹',
          v: `最高 +${cur.pxReb.toFixed(1)}%（低点 ${e.tL.toFixed(2)} → 最高收盘 ${cur.pxMax.toFixed(2)}），`
            + `当前 ${cur.pxNow >= 0 ? '+' : ''}${cur.pxNow.toFixed(1)}%`
            + (cur.giveBack >= 0.3 ? `，已回吐 ${(cur.giveBack * 100).toFixed(0)}%` : ''),
        });
      }
      if (cur.volR != null) {
        pts.push({ k: '量能', v: `${cur.volR.toFixed(2)}×（反弹段均量 ÷ 下跌段均量）` });
      }
      pts.push({
        k: '均线',
        v: ma20 == null ? '数据不足'
          : onMa20 ? `收盘 ${c.toFixed(2)} 站上 MA20 ${ma20.toFixed(2)}`
            : `收盘 ${c.toFixed(2)} 未收复 MA20 ${ma20.toFixed(2)}`,
      });
      pts.push({
        k: '结构',
        v: cur.newLow
          ? `已跌破超卖谷低点 ${e.tL.toFixed(2)}（现低 ${cur.lowMin.toFixed(2)}），底部证伪`
          : `未创新低，防守位 ${e.tL.toFixed(2)}`,
      });
      if (e.diverge && !cur.newLow) {
        pts.push({
          k: '底背离',
          v: `第二次超卖：价格底比上次抬高 ${((e.tC / e.prev.tC - 1) * 100).toFixed(1)}%，K 底抬高 ${(e.tK - e.prev.tK).toFixed(1)} 点`,
        });
      }
      pts.push({
        k: '强度',
        v: cur.broken
          ? (st >= 45
            ? `${st}/100 —— 反弹力度够，但已跌破谷底，力度不再作数`
            : `${st}/100 —— 反弹本身就没起来，之后又跌破谷底`)
          : `${st}/100（强反 ≥62，弱反 <45）`,
      });

      /* ---------- 解读 ---------- */
      const pct = (v) => (v == null ? '—' : v.toFixed(1) + '%');
      // 相对谷底的涨幅可能为负（已经跌回低点下方），说成「反弹 -1.5%」读着别扭
      const pxTxt = (v) => (v == null ? '—' : v >= 0 ? `反弹 ${v.toFixed(1)}%` : `已跌回低点下方 ${Math.abs(v).toFixed(1)}%`);
      const xr = (v) => (v == null ? '—' : v.toFixed(2) + '×');
      let verdict;

      if (cur.broken) {
        verdict = age <= 2
          ? `低位金叉才 ${age} 根，价格就跌破了谷底低点 ${e.tL.toFixed(2)}（最低 ${cur.lowMin.toFixed(2)}）—— 这个金叉没成立，是超卖区里的假信号。${P}上一根 K 线就能把结构打坏，说明下方没有任何承接，接着等，别当天就进。`
          : `这次超卖反弹走到第 ${age} 根时，价格跌破了超卖谷的低点 ${e.tL.toFixed(2)}（最低 ${cur.lowMin.toFixed(2)}）。弱势反弹之后继续破位，等于把「还没见底」直接兑现了 —— 这类结构后面多是下跌中继，反弹是减仓机会，不是买点。`;
      } else if (cur.kn < osTh) {
        verdict = `K 从阶段高点 ${cur.kMax.toFixed(1)} 回落重新压到 ${cur.kn.toFixed(1)}，跌破 ${osTh} 超卖线，这波反弹熄火了。SKDJ 二次回到超卖区、价格却没抬起来（自低点 ${pct(cur.pxNow)}），说明前面那一段只是下跌途中的修复。按你的思路，这就是典型的「弱反弹 → 还没见底」，等下一次金叉再看，中间不接。`;
      } else if (st >= 62 && cur.kn >= 45) {
        // 措辞必须跟着实际量能和均线走：缩量反弹还写「有量」就是自相矛盾
        const volTxt = cur.volR == null ? '量能数据不足'
          : cur.volR >= 1.3 ? `量能是下跌段的 ${cur.volR.toFixed(2)} 倍，有明显增量资金`
            : cur.volR >= 1.0 ? `量能 ${cur.volR.toFixed(2)} 倍，略高于下跌段`
              : `但量能只有下跌段的 ${cur.volR.toFixed(2)} 倍，属于缩量反弹`;
        const maTxt = onMa20 ? '收盘站上 MA20' : '收盘还没收复 MA20';
        const head = `从 K=${e.tK.toFixed(1)} 的超卖谷拉起来第 ${age} 根，K 抬到 ${cur.kn.toFixed(1)}（+${cur.kJump.toFixed(1)} 点），价格自低点${cur.giveBack >= 0.3 ? `最多反弹 ${pct(cur.pxReb)}、现在还有 ${pct(cur.pxNow)}` : `反弹 ${pct(cur.pxNow)}`}，${volTxt}，${maTxt}。`;

        verdict = head + (cur.kn > 80
          ? '力度是够的，但 K 已经推到超买区，这一段涨幅基本走完 —— 现在不是买点，是考虑分批减仓的位置；等回落到 50 附近不破、再起一波才是第二次进场。'
          : age <= 10
            ? (cur.volR != null && cur.volR < 1.0
              ? `反弹才第 ${age} 根、K 抬得也快，位置确实在初期；但缩量意味着还没有增量资金接手，这种强更多是「跌不动」而不是「买上来」，要等一根放量确认。防守位 ${e.tL.toFixed(2)}。`
              : `有力度、有量、位置也收复了关键均线，而且反弹才第 ${age} 根，位置还在初期 —— 这就是你说的那种值得做波段的强势反弹。防守位放超卖谷低点 ${e.tL.toFixed(2)}，破了就走。`)
            : age <= 21
              ? `力度和量能都够，但已经走了 ${age} 根，不算起涨点了。这个位置追进去盈亏比一般，等回踩 MA20 不破、K 回到 50 附近再起，才是更稳的第二次进场。防守位仍是 ${e.tL.toFixed(2)}。`
              : `走势是强的（K 抬了 ${cur.kJump.toFixed(0)} 点、涨了 ${cur.pxReb.toFixed(1)}%），但波段已经走了 ${age} 根，属于后段 —— 这里是持有和分批减仓的位置，不是新建仓的位置。`
                + (cur.fade ? ` 而且 K 已从高点 ${cur.kMax.toFixed(1)} 回落到 ${cur.kn.toFixed(1)}，动能正在衰减。` : ''));
      } else if (st >= 45) {
        verdict = `反弹有一点力度但不扎实：K 抬了 ${cur.kJump.toFixed(1)} 点、价格自低点${pxTxt(cur.pxNow)}、量能 ${xr(cur.volR)}，${onMa20 ? '已经站上 MA20' : '但还没收复 MA20'}。这是「能不能成要看后面两三根」的状态 —— 等 K 站上 50 并守住 MA20 再动手，比现在进胜率高。`;
      } else if (st >= 28) {
        verdict = `K 只从 ${e.tK.toFixed(1)} 抬到最高 ${cur.kMax.toFixed(1)}（+${cur.kJump.toFixed(1)} 点），价格自低点${pxTxt(cur.pxNow)}，量能 ${xr(cur.volR)}。反弹力度不足，K 在 20~35 之间磨、价格连 MA20 都${onMa20 ? '刚摸到' : '没摸到'} —— 典型的弱反抽：卖压没出尽，行情大概率还没见底。这种位置不买，反而要防反弹结束后再下一台阶。`;
      } else {
        verdict = `几乎算不上反弹：K 从 ${e.tK.toFixed(1)} 只抬到 ${cur.kMax.toFixed(1)}（+${cur.kJump.toFixed(1)} 点），价格 ${pct(cur.pxNow)}，量能 ${xr(cur.volR)}。超卖之后连一次像样的反抽都没有，说明抛压还在持续释放，这种走势后面常有加速下跌，不要接。`;
      }

      return { score, verdict, points: pts };
    },
  });

  QL.registerStrategy({
    id: 'wyckoff',
    name: '威科夫',
    short: '威科夫',
    color: '#6FD3C7',
    sub: 'wyckoff',
    desc: '供需 / 因果 / 努力与结果 · 吸筹派发五阶段 · Spring-SOS-LPS',

    overlay(ctx) {
      const { data } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const S = wyScan(ctx);
      const out = [];

      /* 交易区间：支撑 / 阻力 / 中轴。这是威科夫所有判断的坐标系 */
      if (S.rangeH > 0) {
        const x1 = Math.max(vs.lo, S.lo), x2 = Math.min(n - 1, vs.hi - 1);
        if (x2 > x1) {
          out.push(...box4(x1, x2, S.sup, S.res, 'rgba(111,211,199,.55)', [5, 4]));
          out.push({ type: 'line', pts: [[x1, S.mid], [x2, S.mid]], color: 'rgba(111,211,199,.30)', width: 1, dash: [2, 4] });
          // 两个标签都向区间内部偏，避免贴边被主图上下沿裁掉
          out.push({ type: 'label', i: x2, p: S.res, text: '阻力', color: 'rgba(111,211,199,.85)', align: 'right', dy: -11, size: 10 });
          out.push({ type: 'label', i: x2, p: S.sup, text: '支撑', color: 'rgba(111,211,199,.85)', align: 'right', dy: -11, size: 10 });
        }
      }

      /* 事件标记：吸筹用暖色、派发用冷色，一眼区分多空含义 */
      const NAME = {
        SC: { t: '抛售潮', c: '#4C8DFF', above: false, prio: 6 },
        BC: { t: '买入潮', c: '#2EBD85', above: true, prio: 6 },
        ST: { t: '二测', c: '#8FA3BF', above: false, prio: 7 },
        SP: { t: '弹簧', c: '#FFD166', above: false, prio: 1 },
        TEST: { t: '测试', c: '#F0B429', above: false, prio: 4 },
        SOS: { t: '强势', c: '#F6465D', above: true, prio: 2 },
        LPS: { t: '末撑', c: '#FF9F43', above: false, prio: 3 },
        UT: { t: '假突破', c: '#A882FF', above: true, prio: 2 },
        SOW: { t: '破位', c: '#2EBD85', above: false, prio: 3 },
      };
      const cands = [];
      for (const k of Object.keys(NAME)) {
        const cfg = NAME[k];
        for (const i of S.ev[k]) {
          if (i < vs.lo || i >= vs.hi) continue;
          cands.push({ i, prio: cfg.prio, m: { text: cfg.t, color: cfg.c, r: k === 'SP' || k === 'SOS' ? 3.8 : 3.0, bold: cfg.prio <= 2, above: cfg.above } });
        }
      }
      // 不做「最新一根保底」：威科夫的价值在事件本身，弹簧（prio 1）比今天的 SOS 更稀有，
      // 交给 mergeMarks 按优先级合并，重叠时保留更重要的那个
      // 本流派标签全是 2 字，42px 足够；58px 会把紧邻最新一根的「弹簧」挤掉
      for (const { i, m } of ctx.helpers.pickMarks(cands, 42, null)) out.push({
        type: 'marker', i, p: m.above ? data[i].h : data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
        r: m.r, bold: m.bold,
        // 贴左右边界时文字向内收，避免被画布裁掉（周线大窗口下尤其明显）
        align: i > n - 12 ? 'right' : (i < vs.lo + 6 ? 'left' : 'center'),
      });

      /* 因果目标位：只在区间成立且价格已接近/突破上沿时画，否则一路虚线没意义 */
      if (S.isRange && S.rangeH > 0 && data[n - 1].c > S.res * 0.98) {
        const x1 = Math.max(vs.lo, n - 12);
        out.push({ type: 'line', pts: [[x1, S.targetUp], [Math.min(n - 1, vs.hi - 1), S.targetUp]], color: 'rgba(246,70,93,.55)', width: 1.2, dash: [6, 5], noRange: true });
        out.push({ type: 'label', i: Math.min(n - 1, vs.hi - 1), p: S.targetUp, text: '量度目标', color: 'rgba(246,70,93,.8)', align: 'right', dy: -9, size: 10, noRange: true });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1;
      const pts = [];
      let s = 0;
      const c = data[i].c;

      if (n < 60) {
        return {
          score: 0,
          verdict: `历史数据不足 60 根（当前 ${n} 根），威科夫需要足够长的横盘区间才能读出建仓结构。`,
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }

      const S = wyScan(ctx);
      const A = (arr, k) => (arr && arr[k] != null ? arr[k] : null);

      /* ① 阶段：威科夫最核心的判断 */
      const stageScore = {
        markup: S.isRange ? 16 : 10, phaseD: 16, phaseD0: 10, phaseC: 18, phaseC0: 10, phaseB: 6,
        weak: -8, trendDown: -12, range: 0, distribution: -22, markdown: -20,
      }[S.phase];
      s += stageScore;
      pts.push({ k: '阶段', v: `${S.phaseName}${S.isRange ? `，${S.W} 根横盘区间成立（高度占股价 ${(S.rangeH / S.mid * 100).toFixed(1)}%）` : '，区间特征不成立（更像趋势而非横盘）'}` });

      if (S.rangeH > 0) {
        pts.push({
          k: S.isRange ? '区间' : '参考区间',
          v: `支撑 ${S.sup.toFixed(2)} / 中轴 ${S.mid.toFixed(2)} / 阻力 ${S.res.toFixed(2)}，现价处于 ${(S.posInRange * 100).toFixed(0)}% 分位`
            + (S.isRange ? `，${S.W} 根内穿越中轴 ${S.crosses} 次` : `；本窗口内只穿越中轴 ${S.crosses} 次，配合净位移判断，不构成横盘`),
        });
      }

      /* ② 事件：按重要度列出最近发生的 */
      const NAMEOF = { SC: '抛售高潮', BC: '买入高潮', ST: '二次测试', SP: '弹簧（Spring）', TEST: '弹簧测试', SOS: '强势信号（SOS）', LPS: '最后支撑（LPS）', UT: '上冲回落（UT）', SOW: '弱势信号（SOW）' };
      const HIT = [
        ['SP', 12, '跌破区间下沿后当日收回，是原文「终极震仓」—— 洗掉最后一批浮动筹码'],
        ['TEST', 8, '弹簧后缩量回踩且低点抬高，供给确实枯竭，这是原文要求的确认'],
        ['SOS', 10, '放量向上突破中轴，需求接管，原文称之为「强势信号」'],
        ['LPS', 8, 'SOS 后缩量回踩守住上半区，前阻力转支撑，原文的首选入场点'],
        ['SC', 8, '放量大跌但收盘脱离低点，恐慌抛售被大资金承接'],
        ['ST', 5, '回到抛售潮低位但明显缩量，卖压衰竭'],
        ['BC', -10, '放量大涨却收在上半区以下，需求被供给吃掉'],
        ['UT', -15, '盘中冲破阻力又收回区间内，典型的多头陷阱'],
        ['SOW', -12, '放量跌破中轴，供给接管'],
      ];
      let shown = 0;
      for (const [k, w, why] of HIT) {
        const idx = S.recent[k];
        if (idx < 0) continue;
        const age = i - idx;
        if (age > 45) continue;   // 一个多月前的事件对当前结构已无指导意义
        // 事件都是「相对交易区间」定义的，区间不成立时只保留 30% 权重作参考
        s += S.isRange ? w : Math.round(w * 0.3);
        pts.push({ k: NAMEOF[k], v: `${age === 0 ? '就在最新一根' : age + ' 根前'}（${data[idx].d}）：${why}${S.isRange ? '' : '（区间不成立，此项仅供参考）'}` });
        shown++;
      }
      if (!shown) pts.push({ k: '事件', v: '近 60 根没有可识别的威科夫事件，结构还在形成中' });

      /* ③ 努力与结果：第三定律 */
      const vr = S.volumeRatio;
      if (vr > 1.25) {
        s += 10;
        pts.push({ k: '努力/结果', v: `近 20 根上涨日均量是下跌日的 ${vr.toFixed(2)} 倍 —— 拉升有量、回调缩量，需求主导，这是健康的量价结构` });
      } else if (vr < 0.8) {
        s -= 10;
        pts.push({ k: '努力/结果', v: `近 20 根上涨日均量只有下跌日的 ${vr.toFixed(2)} 倍 —— 下跌放量、反弹缩量，供给主导，反弹是逃命不是买点` });
      } else {
        pts.push({ k: '努力/结果', v: `上涨/下跌量能比 ${vr.toFixed(2)}，多空投入接近平衡，方向要靠位置突破来选` });
      }

      // 量增价滞：吸收 or 派发，取决于位置
      const e0 = A(ind.wy.effort, i), r0 = A(ind.wy.result, i);
      if (e0 != null && r0 != null) {
        if (e0 > 1.5 && r0 < 0.5) {
          const absorbing = S.posInRange < 0.45;
          s += absorbing ? 6 : -6;
          pts.push({
            k: '量价关系',
            v: `今日量比 ${e0.toFixed(2)}（放量）但价格只走了 ${r0.toFixed(2)} ATR —— 努力大、结果小，` +
              (absorbing ? '发生在区间下半部，是吸收筹码（吸筹）' : '发生在区间上半部，是派发（出货）'),
          });
        } else if (e0 > 1.5 && r0 > 1.2) {
          s += 4;
          pts.push({ k: '量价关系', v: `量比 ${e0.toFixed(2)}、价格走了 ${r0.toFixed(2)} ATR，放量有结果，趋势健康` });
        } else if (e0 < 0.7 && r0 < 0.4) {
          pts.push({ k: '量价关系', v: `量比 ${e0.toFixed(2)}、振幅 ${r0.toFixed(2)} ATR，缩量窄幅，多空都在观望` });
        }
      }

      /* ④ 因果测算：横盘越久、区间越高，突破后的空间越大 */
      if (S.isRange && S.rangeH > 0) {
        const tgt = S.targetUp;
        const up = (tgt / c - 1) * 100;
        if (up > 0 && up < 60) {
          pts.push({ k: '量度目标', v: `按区间高度横向投影，突破 ${S.res.toFixed(2)} 后量度目标 ${tgt.toFixed(2)}（+${up.toFixed(1)}%）；跌破 ${S.sup.toFixed(2)} 则下看 ${S.targetDn.toFixed(2)}` });
        } else {
          pts.push({ k: '量度目标', v: `区间高度 ${S.rangeH.toFixed(2)} 相对股价过大（${(S.rangeH / c * 100).toFixed(0)}%），横向投影会投到很远，参考意义有限` });
        }
      }

      /* ⑤ A 股适配：涨停/跌停会扭曲量价，必须单独说明 */
      const rate = limitRate(ctx);
      let limUp = -1, limDn = -1;
      for (let k = i; k >= Math.max(1, i - 30); k--) {
        if (limUp < 0 && isLimitUp(ctx, k, rate)) limUp = k;
        const p = data[k - 1];
        if (limDn < 0 && p && p.c && (data[k].c / p.c - 1) <= -(rate - 0.003)) limDn = k;
        if (limUp >= 0 && limDn >= 0) break;
      }
      if (limUp >= 0) {
        const age = i - limUp;
        if (age <= 10) {
          pts.push({ k: 'A股适配', v: `${age} 根前涨停（${boardName(rate)}）。涨停当日的量价在威科夫口径里是失真的（买不进、封单不算换手），SOS 若以涨停出现，实际入场要等次日回踩` });
        }
      }
      if (limDn >= 0 && i - limDn <= 15) {
        pts.push({ k: 'A股适配', v: `${i - limDn} 根前跌停。连续跌停打开后的「抛售高潮」量能常被放大失真，SC 需要后面的缩量二次测试才算数` });
      }
      const turn = A(ind.turn, i);
      if (turn != null && turn > 15) {
        s -= 6;
        pts.push({ k: 'A股适配', v: `换手 ${turn.toFixed(1)}%，远超正常水平 —— 这种换手更像游资接力而非机构慢慢吸筹，威科夫的「长期建仓」前提要打折扣` });
      } else if (turn != null && turn < 2) {
        pts.push({ k: 'A股适配', v: `换手仅 ${turn.toFixed(2)}%，关注度低。缩量是双刃剑：抛压小，但也没有承接盘` });
      }

      s = Math.max(-100, Math.min(100, Math.round(s)));

      /* ---- 结论 ---- */
      let verdict;
      const px = c.toFixed(2);
      if (!S.isRange) {
        // 区间不成立时，事件体系失效，不能给「C 段/D 段」这类结论
        verdict = S.phase === 'markup'
          ? `最近 ${S.W} 根的净位移已超过区间高度的 60%，这是上升趋势不是横盘吸筹 —— 威科夫的建仓结构在这里读不出来。现价 ${px}，趋势段请配合趋势类流派，本流派只在价格重新走平后才重新有效。`
          : `最近 ${S.W} 根的净位移已超过区间高度的 60%，这是下降趋势不是横盘派发。现价 ${px}，威科夫的「跌不动了」要看到抛售高潮 + 缩量二次测试，现在还没有，别用「跌多了」当买入理由。`;
      } else if (S.phase === 'phaseC') {
        verdict = `弹簧 + 测试已经完成：跌破 ${S.sup.toFixed(2)} 又被收回、随后缩量回踩且低点抬高。这是威科夫全套里胜率最高的位置 —— 止损放弹簧低点下方，跌破即证明判断错了。现价 ${px}，上方第一目标 ${S.res.toFixed(2)}。`;
      } else if (S.phase === 'phaseC0') {
        verdict = `刚出现弹簧（跌破下沿又收回），但还缺一根缩量回踩的确认。原文要求「Test 之后才动手」，现在追进去要承担二次探底的风险，等回踩不破 ${S.sup.toFixed(2)} 再上。`;
      } else if (S.phase === 'phaseD') {
        verdict = `吸筹 D 段：SOS 已经放量向上，回踩守住了区间上半部。需求接管、供给枯竭，是出发前的最后上车点。现价 ${px}，突破 ${S.res.toFixed(2)} 后量度目标 ${S.targetUp.toFixed(2)}。`;
      } else if (S.phase === 'phaseD0') {
        verdict = `SOS 已经放量向上（收盘站上 ${S.mid.toFixed(2)} 中轴），但还没有缩量回踩的 LPS 确认。原文在 D 段要求「强势拉升 + 缩量回踩」两个动作都完成，现在只有前半段，追高风险偏高 —— 等回踩不破中轴再进。`;
      } else if (S.phase === 'markup') {
        verdict = `已经进入 E 段上涨：价格站上区间阻力 ${S.res.toFixed(2)}，需求主导。这一段不追高，等回踩原阻力（现为支撑）缩量不破，才是 BU 买点。`;
      } else if (S.phase === 'weak') {
        verdict = `还在区间内，但最后一个事件是 SOW（${S.recent.SOW >= 0 ? (i - S.recent.SOW) + ' 根前放量破中轴' : '放量转弱'}），现价 ${px} 处在中轴 ${S.mid.toFixed(2)} 下方。原文对这种位置的判断是「供给重新占上风」，先看能否在 ${S.sup.toFixed(2)} 之上稳住，稳不住就是破位。`;
      } else if (S.phase === 'phaseB') {
        verdict = `处在吸筹 B 段的反复震荡里（${S.W} 根区间，现价 ${(S.posInRange * 100).toFixed(0)}% 分位）。原文对这一段的态度是「等」—— B 段的上下扫专门用来打掉短线客，只有弹簧或 SOS 才值得动手。`;
      } else if (S.phase === 'distribution') {
        verdict = `高位出现买入高潮后走弱（${S.recent.UT >= 0 ? '伴随上冲回落' : '反弹无量'}），这是派发的典型特征。原文的结论很直接：这里是卖点不是买点，A 股不能做空，对应动作是减仓离场。`;
      } else if (S.phase === 'markdown') {
        verdict = `已经放量跌破区间下沿 ${S.sup.toFixed(2)}，进入 Markdown。下跌途中不要用「跌多了就该反弹」抄底 —— 威科夫要求先看到抛售高潮 + 缩量二次测试，现在两样都没有。`;
      } else {
        verdict = `区间特征不成立（${S.W} 根内净位移已超过区间高度的 60%），当前更像趋势行情而非横盘吸筹。现价 ${px}。`;
      }

      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * SuperTrend · ATR 通道趋势跟踪（来源：小红书「经典策略图鉴」2026-11-12）
   *
   * 原文三句话就是全部规则：
   *   ① 价格上下各挂一条 3 倍 ATR 的线；
   *   ② 收盘升破上线翻多、跌破下线翻空，次日开盘执行；
   *   ③ 线只往持仓方向收，所以趋势里拿得住；窄幅来回时被反复穿过，小亏一串。
   *
   * 落到 A 股要做三处适配：
   *   · T+1：原文「次日开盘执行」正好与 T+1 同构，收盘定信号、次日开盘动手，不存在隔夜反手问题；
   *   · 涨停：翻转日封板则次日大概率买不到，信号要降级为「观察」而不是「买入」；
   *   · 震荡市占比高：A 股大部分时间在箱体里磨，原文自己说的「小亏一串」在这里会被放大，
   *     所以必须把历史假翻转率（whip）与 ADX 一起摆到台面上，震荡环境直接压分。
   * ============================================================ */
  /* ============================================================
   * 威科夫 v2 · 三律合参（Wyckoff v2）
   *
   * v1 回答「现在像哪一段」，v2 补三样 v1 没有的东西：
   *   ① 摆动序列：低点/高点是不是逐级抬（降）—— 结构最硬的证据，v1 没有序列概念；
   *   ② 因果测度：区间磨多久、边界被测试几次、波动是否收敛，合成「建仓充分度」；
   *   ③ 证据投票：阶段结论必须带票数与反证条件，不许只丢一个标签。
   *
   * 全部结构计算在 public/js/shape.js 的 wyckoff2Of()，与选股页共用同一份实现。
   * 这里只做两件事：把结构画到图上、把结构翻译成人话。
   * ============================================================ */
  /* 同一份 data 只算一次：overlay 与 analyze 都会调，周/月线切换时 data 换新对象，缓存自然失效 */
  const _wy2cache = new WeakMap();
  function wy2(ctx) {
    const rows = ctx.data;
    if (!rows || !rows.length) return null;
    let v = _wy2cache.get(rows);
    if (v !== undefined) return v;
    const S = window.QLShape;
    if (!S || typeof S.wyckoff2Of !== 'function') { _wy2cache.set(rows, null); return null; }
    const arr = rows.map((x) => [x.d, x.o, x.c, x.h, x.l, x.v, x.a || 0]);
    v = S.wyckoff2Of(arr);
    _wy2cache.set(rows, v);
    return v;
  }

  QL.registerStrategy({
    id: 'wyckoff2',
    name: '威科夫 v2',
    short: '威2',
    color: '#9AD94B',
    sub: 'wy2',
    desc: '三律合参 · 摆动序列 · 因果厚度 · 证据投票与反证',

    overlay(ctx) {
      const { data } = ctx;
      const W = wy2(ctx);
      if (!W) return [];
      const n = ctx.n, vs = ctx.helpers.vspan();
      const out = [];

      /* 区间：这里是全部判断的坐标系，先画出来 */
      if (W.isRange && W.rangeStart != null) {
        const x1 = Math.max(vs.lo, W.rangeStart);
        const x2 = Math.min(n - 1, vs.hi - 1);
        if (x2 > x1) {
          out.push(...box4(x1, x2, W.sup, W.res, 'rgba(154,217,75,.5)', [5, 4]));
          out.push({ type: 'line', pts: [[x1, W.mid], [x2, W.mid]], color: 'rgba(154,217,75,.26)', width: 1, dash: [2, 4] });
          out.push({ type: 'label', i: x2, p: W.res, text: '阻力 ' + W.res.toFixed(2), color: 'rgba(154,217,75,.9)', align: 'right', dy: -11, size: 10 });
          out.push({ type: 'label', i: x2, p: W.sup, text: '支撑 ' + W.sup.toFixed(2), color: 'rgba(154,217,75,.9)', align: 'right', dy: -11, size: 10 });
        }
      }

      /* 摆动序列：把最近 5 个摆动点连成折线。
       * 这条线的斜率就是「结构」本身 —— 低点连线向上是需求在承接，
       * 向下是供给在压价，比任何指标都直观。只在缩放足够宽时才画，
       * 否则点挤在一起反而看不清。 */
      const drawSeq = (pts, color) => {
        const vis = pts.filter((p) => p.i >= vs.lo && p.i < vs.hi);
        if (vis.length < 2) return;
        const seg = vis.map((p) => [p.i, p.p]);
        out.push({ type: 'line', pts: seg, color, width: 1.4, dash: [3, 3], alpha: .9 });
        for (const p of vis) out.push({ type: 'dot', i: p.i, p: p.p, color, r: 2.2 });
      };
      drawSeq(W.swings.lo, 'rgba(46,189,133,.75)');
      drawSeq(W.swings.hi, 'rgba(246,70,93,.55)');

      /* 事件：14 种，按含义分冷暖色 —— 吸筹暖、派发冷，A 股「红涨绿跌」不适用于这里，
       * 这里的颜色编码的是「对多头的含义」而不是涨跌，所以红=强势、绿=破位。 */
      const CFG = {
        SP: { t: '弹簧', c: '#FFD166', prio: 1 },
        TEST: { t: '测试', c: '#F0B429', prio: 4 },
        SOS: { t: 'SOS', c: '#F6465D', prio: 2 },
        LPS: { t: 'LPS', c: '#FF9F43', prio: 3 },
        JAC: { t: '突破', c: '#FF6B9D', prio: 3 },
        BUEC: { t: '回踩', c: '#E8B84B', prio: 5 },
        SC: { t: '抛售潮', c: '#4C8DFF', prio: 5 },
        ST: { t: '二测', c: '#8FA3BF', prio: 7 },
        NS: { t: '无供给', c: '#6FD3C7', prio: 7 },
        BC: { t: '买入潮', c: '#2EBD85', prio: 5 },
        UT: { t: '假突破', c: '#A882FF', prio: 2 },
        SOW: { t: '破位', c: '#2EBD85', prio: 3 },
        SHK: { t: '震仓', c: '#FF8A3D', prio: 4 },
        ND: { t: '无需求', c: '#8FA3BF', prio: 7 },
      };
      const cands = [];
      for (const m of W.marks) {
        if (m.i < vs.lo || m.i >= vs.hi) continue;
        const cfg = CFG[m.type];
        if (!cfg) continue;
        cands.push({
          i: m.i, prio: cfg.prio,
          m: {
            text: cfg.t, color: cfg.c, above: m.above,
            r: cfg.prio <= 2 ? 3.7 : 2.9,
            bold: cfg.prio <= 2,
          },
        });
      }
      for (const { i, m } of ctx.helpers.pickMarks(cands, 44, null)) {
        out.push({
          type: 'marker', i, p: m.above ? data[i].h : data[i].l,
          color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
          r: m.r, bold: m.bold,
          align: i > n - 12 ? 'right' : (i < vs.lo + 6 ? 'left' : 'center'),
        });
      }

      return out;
    },

    analyze(ctx) {
      const { data } = ctx;
      const n = ctx.n, i = n - 1;
      const pts = [];
      const c = data[i].c;

      if (!window.QLShape || typeof window.QLShape.wyckoff2Of !== 'function') {
        return { score: 0, verdict: '形态模块（shape.js）未加载，威科夫 v2 无法读取结构。刷新页面重试。', points: [{ k: '模块', v: 'shape.js 缺失' }] };
      }
      if (n < 120) {
        return {
          score: 0,
          verdict: `历史数据只有 ${n} 根，威科夫 v2 需要至少 120 根才能读出摆动序列与交易区间。数据不够时不硬套结构。`,
          points: [{ k: '数据', v: `仅 ${n} 根` }],
        };
      }

      const W = wy2(ctx);
      if (!W) {
        return { score: 0, verdict: `结构计算返回空值（${n} 根数据），可能是价格序列异常。`, points: [{ k: '数据', v: `${n} 根` }] };
      }

      /* ① 阶段 + 置信度 */
      const CNF = { high: '高', mid: '中', low: '低' };
      const votes = W.evid.length;
      pts.push({
        k: '阶段',
        v: `${W.phaseName} · 置信度${CNF[W.conf]}（${W.confPct}% 证据一致${votes ? '：' + W.evid.join('、') : ''}）`,
      });

      /* ② 位置：年内分位与区间内分位要分开说，两者含义不同。
       * posInRange 是「在区间高度上的百分比位置」，<0 / >100 表示已经跌出/冲出筹码带，
       * 这时不能再说「处在区间 X% 分位」，得直接说跌破/突破了多少。 */
      /* 跌破/突破时改用「价格偏离筹码带多少」来说，而不是「% 分位」——
       * 负分位没有任何可读性，而价格偏离是能直接对照盘面的数。 */
      const posTxt = W.inRange
        ? `区间 ${W.posInRange}% 分位`
        : W.posInRange > 100
          ? `高于筹码带上沿 ${((c / W.res - 1) * 100).toFixed(1)}%`
          : `低于筹码带下沿 ${((1 - c / W.sup) * 100).toFixed(1)}%`;
      if (W.isRange) {
        pts.push({
          k: '位置',
          v: `年内 ${W.pos250}% 分位；区间 ${W.w} 根筹码带（${W.sup.toFixed(2)}~${W.res.toFixed(2)}），`
            + `现价 ${c.toFixed(2)} ${posTxt}`,
        });
      } else {
        pts.push({
          k: '位置',
          v: `年内 ${W.pos250}% 分位；最近 60 根 ${W.ret60 >= 0 ? '+' : ''}${W.ret60}%。横盘结构不成立（净位移超过区间高度 60%），以下判断按趋势口径`,
        });
      }

      /* ③ 摆动序列：v2 的核心证据 */
      const seqTxt = (up, down, what) => `${what}抬高 ${up} 次 / 下移 ${down} 次`;
      pts.push({
        k: '摆动序列',
        v: `${seqTxt(W.lowRise, W.lowFall, '低点')}，${seqTxt(W.hiRise, W.hiFall, '高点')}`
          + `（最近 6 个 2 左 2 右分形点${W.lowLast && W.hiLast ? `，最近低点 ${W.lowLast}、最近高点 ${W.hiLast}` : ''}）`
          + (W.lowFall > W.lowRise ? ' —— 低点净下移，供给在压价' : W.lowRise > W.lowFall ? ' —— 低点净抬高，需求在承接' : ' —— 序列走平，方向未定')
          + (W.hiFall > W.hiRise ? '；高点同步下移' : W.hiRise > W.hiFall ? '；高点同步抬高' : ''),
      });

      /* ④ 最近事件：最多 3 个，按新鲜度排 */
      const EN = {
        SP: '弹簧（spring）', TEST: '弹簧测试（test）', SOS: '强势信号（SOS）', LPS: '最后支撑（LPS）',
        JAC: '跳过小溪（JAC）', BUEC: '回踩溪边（BUEC）', SC: '抛售高潮', ST: '缩量二次测试',
        NS: '无供给', BC: '买入高潮', UT: '上冲回落（upthrust）', SOW: '弱势信号（SOW）',
        SHK: '震仓（shakeout）', ND: '无需求',
      };
      const evs = Object.keys(W.ev)
        .filter((k) => W.ev[k] >= 0 && i - W.ev[k] <= 45)
        .map((k) => ({ k, age: i - W.ev[k] }))
        .sort((a, b) => a.age - b.age)
        .slice(0, 3);
      if (evs.length) {
        pts.push({
          k: '结构事件',
          v: evs.map((e) => {
            const idx = W.ev[e.k];
            const b = data[idx];
            let note = '';
            // 事件是「当时成立」，不等于「现在还成立」。看多类事件要看它的低点/收盘有没有被吞掉
            if (b && (e.k === 'SP' || e.k === 'TEST' || e.k === 'LPS' || e.k === 'BUEC') && b.l > c) {
              note = `，低点 ${b.l.toFixed(2)} 已被跌破`;
            } else if (b && (e.k === 'SOS' || e.k === 'JAC') && c < b.c) {
              note = `，那根收盘 ${b.c.toFixed(2)} 已被回落吞掉`;
            } else if (b && (e.k === 'UT' || e.k === 'SOW' || e.k === 'BC' || e.k === 'ND') && c > b.c) {
              note = `，已被收盘 ${c.toFixed(2)} 反超`;
            }
            return `${EN[e.k]}（${e.age === 0 ? '最新一根' : e.age + ' 根前'}${note}）`;
          }).join('；')
            + ' —— 事件本身只是「发生过什么」，含义要看它落在区间哪个位置、以及有没有失效',
        });
      } else {
        pts.push({ k: '结构事件', v: '近 45 根没有可识别的威科夫事件，结构还在形成中' });
      }

      /* ⑤ 第三定律：努力与结果 */
      const effTxt = W.eff > 0.3 ? '单边上行，位移效率高' : W.eff < -0.3 ? '单边下行，位移效率高（方向向下）' : '来回震荡，净位移小';
      pts.push({
        k: '努力/结果',
        v: `上涨日量能是下跌日的 ${W.sr.toFixed(2)} 倍；近 20 根路径效率 ${(W.eff * 100).toFixed(0)}%（${effTxt}）`
          + (W.stall > 0 ? `；有 ${W.stall} 天放量却推不动（量比 ≥2、位移不足 0.6 ATR）` : '；无放量滞涨'),
      });

      /* ⑥ 第二定律：因果厚度 */
      if (W.isRange) {
        pts.push({
          k: '因果',
          v: `区间 ${W.w} 根、边界被测试 ${W.tests} 次，建仓充分度 ${W.cause}/100`
            + (W.cause >= 70 ? ' —— 横得够久，筹码换手充分' : W.cause >= 45 ? ' —— 时间中等，因还谈不上厚' : ' —— 区间太短，因果关系薄弱')
            + '。注意：因果厚度描述的是「磨了多久」，不保证「往哪边走」——横得再久，向下突破同样是它的果',
        });
      } else {
        pts.push({ k: '因果', v: '没有有效横盘区间，因果定律无从计算 —— 趋势段落里不谈「横有多长竖有多高」' });
      }

      /* ⑦ 反证条件：v2 与 v1 最大的差别，必须显式给出 */
      if (W.against.length) {
        pts.push({ k: '反证条件', v: W.against.slice(0, 2).join('；') });
      }

      /* ⑧ A 股适配 */
      if (ctx.period === 'day') {
        const rate = limitRate(ctx);
        let limUp = -1;
        for (let k = i; k >= Math.max(1, i - 15); k--) if (isLimitUp(ctx, k, rate)) { limUp = k; break; }
        if (limUp >= 0 && i - limUp <= 8) {
          pts.push({ k: 'A股适配', v: `${i - limUp} 根前涨停（${boardName(rate)}）。涨停日的量价在威科夫口径里失真（买不进、封单不算换手），若 SOS/JAC 以涨停出现，要等次日回踩确认` });
        }
      }

      let s = W.score;
      /* 周期适配：周/月线的 250 根窗口对应更长的历史，阈值没跟着放大，
       * 结构含义仍在，但不能把日线的分数直接当周线用 */
      if (ctx.period !== 'day') {
        s = Math.round(s * 0.8);
        pts.push({ k: '周期', v: `${ctx.periodName}口径。区间与事件按 ${W.w} 根计算，相当于更长的历史跨度，信号新鲜度的判断要放宽` });
      }
      s = clamp(s, -100, 100);

      /* ---- 结论 ---- */
      let verdict;
      const px = c.toFixed(2);
      const supT = W.sup.toFixed(2), resT = W.res.toFixed(2);
      if (W.phase === 'accumC') {
        verdict = `吸筹 C 段成立：跌破 ${supT} 后收回、随后缩量测试且价格回到区间中部（现价 ${px}，${posTxt}）。C 段是威科夫全套里证据最集中的位置，但证据集中不等于结果确定 —— 证伪条件很明确：跌回弹簧低点下方且放量，这个假设当场作废。`;
      } else if (W.phase === 'accumC0') {
        verdict = `弹簧已经出现（跌破 ${supT} 又收回，现价 ${px}），但还缺缩量测试那一步。原文对 C 段的要求是「弹簧 + 测试」两个动作都完成，现在只有前半段。二次探底的风险由市场承担，不是由判断承担。`;
      } else if (W.phase === 'accumD') {
        verdict = `吸筹 D 段：SOS 放量向上之后有缩量回踩，且价格守在区间上半部（${W.posInRange}% 分位）。需求接管、供给枯竭的样貌齐了。需要确认的是 ${resT} 能不能被放量拿下 —— 拿不下就还是 D 段内反复。`;
      } else if (W.phase === 'accumD0') {
        verdict = `SOS 已经放量向上（现价 ${px}，${posTxt}），但还没有缩量回踩的 LPS 确认。原文在 D 段要求「强势拉升 + 缩量回踩」两件事都发生，现在只有前半段。`;
      } else if (W.phase === 'markup') {
        verdict = `已在 E 段：价格站上区间上沿 ${resT}（现价 ${px}）。这一段的结构特征是高点持续抬高（${W.hiRise} 次）。E 段本身不是「入场位置」的概念，它的价值在于告诉我们 Cause 已经变现、区间坐标失效，此后要换趋势类框架来看。`;
      } else if (W.phase === 'distrib') {
        verdict = `派发样貌：区间上部（${posTxt}）出现上冲回落或买入高潮，高点不再抬高。现价 ${px}。A 股不能做空，这个标签的实际用途是「别在这里谈低吸」—— 供给正在往需求手里塞货。`;
      } else if (W.phase === 'markdown') {
        verdict = `下跌段（markdown）：年内 ${W.pos250}% 分位、60 根 ${W.ret60}%、低点与高点都在下移，现价 ${px}，${posTxt}，${supT} 是筹码带下沿的参考。威科夫对这一段的要求是「先见抛售高潮，再见缩量二次测试」，两样都没出现之前，跌得多只是跌得多。`;
      } else if (W.phase === 'weak') {
        verdict = `区间走弱（${posTxt}，现价 ${px}）。供给重新占上风，${supT} 这条筹码带下沿正在被反复试探。走弱不等于破位 —— 但「跌到低位」本身不是证据，要看有没有 spring 或者缩量止跌把它拉回带内，否则下一步就是 markdown。`;
      } else if (W.phase === 'accumB') {
        verdict = `吸筹 B 段：区间 ${W.w} 根、低点抬高 ${W.lowRise} 次（现价 ${px}，${posTxt}）。B 段的本质是「反复扫」，专门消耗耐心。原文对这一段的态度就是等 —— 只有弹簧或 SOS 才值得当作结构事件。`;
      } else if (W.phase === 'transition') {
        verdict = `过渡状态：横盘结构不成立（60 根 ${W.ret60}%、年内 ${W.pos250}% 分位），摆动序列也没给出单向结论。现价 ${px}。这种时候任何「吸筹/派发」的标签都是硬套，等结构自己收敛。`;
      } else {
        verdict = `区间中性：${W.isRange ? `${W.w} 根区间成立，现价在 ${posTxt}` : '区间特征不足'}，摆动序列没有方向。现价 ${px}。中性就是中性，不需要为了给结论而挑一个方向。`;
      }

      return { score: s, verdict, points: pts };
    },
  });

  QL.registerStrategy({
    id: 'supertrend',
    name: 'SuperTrend',
    short: 'ST',
    color: '#FF8A3D',
    sub: 'st',
    desc: 'ATR 通道棘轮 · 收盘切换次日执行 · 趋势拿得住、震荡小亏一串',

    overlay(ctx) {
      const { data, ind } = ctx;
      const S = ind.st;
      const n = ctx.n, vs = ctx.helpers.vspan();
      if (!S || !S.st) return [];
      const out = [];
      const lo = Math.max(0, vs.lo - 1), hi = Math.min(n, vs.hi + 1);

      /* 趋势线分段染色：多头段红、空头段绿（A 股习惯色），
       * 同一段内连成一条折线，切换处自然断开，视觉上就能看出「抬轿子」的棘轮。 */
      let seg = [], segDir = null;
      const flush = () => {
        if (seg.length > 1) {
          out.push({ type: 'line', pts: seg, color: segDir === 1 ? '#F6465D' : '#2EBD85', width: 2.0, alpha: .95 });
        }
        seg = [];
      };
      for (let i = lo; i < hi; i++) {
        if (S.st[i] == null) continue;
        if (segDir != null && S.dir[i] !== segDir) {
          // 断点处补上一根，避免折线出现视觉空洞
          if (S.st[i - 1] != null) seg.push([i - 1, S.st[i - 1]]);
          flush();
        }
        segDir = S.dir[i];
        seg.push([i, S.st[i]]);
      }
      flush();

      /* 翻转点：原文唯一的动作指令，必须标出来 */
      const cands = [];
      for (let i = lo; i < hi; i++) {
        if (!S.flip[i]) continue;
        const up = S.flip[i] === 1;
        cands.push({
          i, prio: up ? 1 : 1,
          m: {
            text: up ? '翻多' : '翻空',
            color: up ? '#F6465D' : '#2EBD85',
            r: 4.0, bold: true, above: !up,
          },
        });
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 54, lastIdx)) {
        out.push({
          type: 'marker', i, p: m.above ? data[i].h : data[i].l,
          color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
          r: m.r, bold: m.bold,
          align: i > n - 10 ? 'right' : (i < vs.lo + 5 ? 'left' : 'center'),
        });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1, c = data[i].c;
      const S = ind.st;
      if (!S || S.cur == null || S.curAge == null || n < 25) {
        return { score: 0, verdict: `历史数据不足 25 根（当前 ${n} 根），10 周期 ATR 与棘轮轨道还没成形。`, points: [{ k: '数据', v: `仅 ${n} 根` }] };
      }
      const pts = [];
      let s = 0;

      const dir = S.cur, up = dir === 1;
      const age = S.curAge;
      const atr = S.atr[i], stv = S.st[i], dist = S.dist[i];
      const adx = ind.dmi && ind.dmi.adx ? ind.dmi.adx[i] : null;
      const whip = S.whip;

      /* ① 方向：这是这个流派的主结论，权重给最高 */
      s += up ? 16 : -16;
      pts.push({
        k: '方向',
        v: `${up ? '多头' : '空头'}（趋势线 ${stv.toFixed(2)}，收盘 ${c.toFixed(2)}，已持续 ${age} 根）`,
      });

      /* ② 新鲜度：原文说次日开盘执行，所以刚翻转的这几天是唯一的「按规则可下手」窗口 */
      if (age <= 3) {
        s += up ? 14 : -14;
        pts.push({ k: '翻转', v: `${age} 根前刚${up ? '翻多' : '翻空'}，按原文规则这是次日开盘就该执行的位置` });
      } else if (age <= 8) {
        s += up ? 8 : -8;
        pts.push({ k: '翻转', v: `${age} 根前${up ? '翻多' : '翻空'}，仍在有效窗口内，但已不是最优成本` });
      } else {
        pts.push({ k: '翻转', v: `${age} 根前${up ? '翻多' : '翻空'}，信号已老化` });
      }

      /* ③ 趋势年龄的双面性：走够 20 根才算「趋势成立」，超过 60 根要防末端 */
      if (age >= 20) {
        s += up ? 7 : -7;
        pts.push({ k: '成熟度', v: `趋势已走 ${age} 根，越过 20 根的成立线，属于可跟随的中期趋势` });
      }
      if (age >= 60) {
        s += up ? -5 : 5;
        pts.push({ k: '末端', v: `已连续 ${age} 根未翻向，单边时间偏长；棘轮越久，一旦翻转回吐越大` });
      }

      /* ④ ADX：原文的短处「窄幅来回被反复穿过」，用 ADX 提前识别 */
      if (adx != null) {
        if (adx >= 25) {
          s += up ? 12 : -12;
          pts.push({ k: 'ADX', v: `${adx.toFixed(1)}，趋势强度达标（≥25）—— A 股 142 只样本里，ADX≥25 的信号胜率 60%、平均 +8.5%，这是 SuperTrend 唯一真正赚钱的环境` });
        } else if (adx < 20) {
          s -= 12;
          pts.push({ k: 'ADX', v: `${adx.toFixed(1)}，趋势强度不足（<20）—— 同一批样本里，ADX<20 的信号胜率只有 15%、平均 −5.3%，正是原文说的「被反复穿过、小亏一串」` });
        } else {
          pts.push({ k: 'ADX', v: `${adx.toFixed(1)}，趋势强度中性（20~25 之间，历史期望接近打平）` });
        }
      }

      /* ⑤ 假翻转率：本标的自己的历史统计，比任何经验值都直接 */
      if (S.flips >= 3) {
        if (whip > 0.5) {
          s -= 10;
          pts.push({ k: '假翻转', v: `近 250 根 ${S.flips} 次翻转，其中 ${(whip * 100).toFixed(0)}% 在 3 根内又翻回去 —— 这只票当前就是原文说的「小亏一串」状态` });
        } else if (whip > 0.35) {
          s -= 5;
          pts.push({ k: '假翻转', v: `近 250 根 ${S.flips} 次翻转，假翻转率 ${(whip * 100).toFixed(0)}%，偏高` });
        } else {
          s += 5;
          pts.push({ k: '假翻转', v: `近 250 根 ${S.flips} 次翻转，假翻转率仅 ${(whip * 100).toFixed(0)}%，轨道在这只票上贴合得不错` });
        }
      }

      /* ⑥ 距轨道距离：棘轮线的本质是「移动止损」，离得越远风险越大 */
      if (dist != null) {
        const ad = Math.abs(dist);
        if (up) {
          if (ad <= 1) { s += 6; pts.push({ k: '距轨道', v: `${ad.toFixed(2)} ATR，贴着轨道走，回踩不破就是原文说的「拿得住」的位置` }); }
          else if (ad > 3) { s -= 8; pts.push({ k: '距轨道', v: `${ad.toFixed(2)} ATR，离趋势线太远；此时进场等于把止损位拉大到 3 个 ATR 以上，盈亏比不划算` }); }
          else pts.push({ k: '距轨道', v: `${ad.toFixed(2)} ATR，处于正常区间` });
        } else {
          if (ad >= 3) { s += 4; pts.push({ k: '距轨道', v: `低于趋势线 ${ad.toFixed(2)} ATR，短线超跌；只作反抽预期，不构成反转` }); }
          else if (ad <= 0.5) { s -= 4; pts.push({ k: '距轨道', v: `贴着趋势线下沿 ${ad.toFixed(2)} ATR，空头仍强，反弹随时被打回` }); }
          else pts.push({ k: '距轨道', v: `低于趋势线 ${ad.toFixed(2)} ATR` });
        }
      }

      /* ⑦ 翻转当根的量能：放量翻转才说明有人真的换手 */
      if (S.lastFlip >= 0 && i - S.lastFlip <= 5) {
        const vma = ind.volMa20[S.lastFlip];
        const vr = vma ? data[S.lastFlip].v / vma : null;
        if (vr != null) {
          if (vr >= 1.3) { s += up ? 5 : -5; pts.push({ k: '翻转量能', v: `翻转当根量比 ${vr.toFixed(2)}，放量换手，信号可信度更高` }); }
          else if (vr < 0.8) { s += up ? -3 : 3; pts.push({ k: '翻转量能', v: `翻转当根量比仅 ${vr.toFixed(2)}，缩量翻转，容易是假动作` }); }
          else pts.push({ k: '翻转量能', v: `翻转当根量比 ${vr.toFixed(2)}，量能一般` });
        }
      }

      /* ⑧ A 股：涨停封板则次日大概率买不到 */
      const lim = ctx.period === 'day' ? (ctx.isIndex ? 0.099 : 0.095) : 0.2;
      const chg = i > 0 ? c / data[i - 1].c - 1 : 0;
      if (ctx.period === 'day' && chg >= lim && up && age <= 2) {
        s -= 4;
        pts.push({ k: 'A股', v: '翻转当天接近涨停，次日大概率一字板买不到，信号只能作观察，不要挂隔夜单硬追' });
      }

      s = clamp(s, -100, 100);

      /* 明天的翻向线：这就是原文的移动止损，说清楚具体价位才有用 */
      const flipLine = stv;
      const stopPct = Math.abs(c - flipLine) / c * 100;

      let verdict;
      if (up && age <= 3) {
        verdict = `SuperTrend 刚在 ${age} 根前翻多，趋势线 ${flipLine.toFixed(2)}。按原文规则，这个信号本该在次日开盘执行；止损就放在趋势线上（距现价 ${stopPct.toFixed(1)}%），收盘跌破 ${flipLine.toFixed(2)} 即翻空离场——棘轮线只上不下，拿着不动就是这套系统的全部。`;
      } else if (up && whip > 0.5) {
        verdict = `方向是多头（趋势线 ${flipLine.toFixed(2)}），但这只票近半年有 ${(whip * 100).toFixed(0)}% 的翻转在 3 根内就翻回去了。原文说的「窄幅来回小亏一串」正是这种票——要么降低仓位做，要么干脆等 ADX 站上 25 再说。`;
      } else if (up) {
        verdict = `多头趋势延续中（已 ${age} 根），趋势线抬到 ${flipLine.toFixed(2)}，距现价 ${stopPct.toFixed(1)}%。这个位置不是买点，是持仓者的移动止损位：不破就继续拿，破了就认。`;
      } else if (age <= 3) {
        verdict = `SuperTrend 刚翻空（${age} 根前），趋势线 ${flipLine.toFixed(2)}。A 股不能做空，这条信号对持仓者的含义只有一个：反弹到 ${flipLine.toFixed(2)} 附近仍站不上去，就该减仓。`;
      } else {
        verdict = `空头趋势延续 ${age} 根，趋势线压到 ${flipLine.toFixed(2)}。原文的规则在这里是「空仓等待」——只有收盘重新升破 ${flipLine.toFixed(2)} 才翻多，之前所有反弹都只是反弹。`;
      }

      pts.push({ k: '结论', v: `${up ? '多头' : '空头'} · 第 ${age} 根 · 翻向线 ${flipLine.toFixed(2)}（${stopPct.toFixed(1)}%）` });
      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 三指标共振 · MACD + KDJ + RSI（来源：小红书「汤财好瑟」2026-11-12）
   *
   * 原文规则：
   *   MACD 红绿柱看趋势与动能；KDJ 里 J 最灵敏，J>100 超买、J<0 超卖，金叉偏多、死叉偏空；
   *   RSI >80 偏热、<20 偏冷。
   *   三灯同亮（同向）果断，两灯一致小试，三灯打架不动、等清楚。
   *   震荡市好用；单边涨容易卖飞、单边跌容易接刀。
   *
   * 三个灯各自只出 -1/0/+1，加起来就是原文的三种状态，不存在量纲问题。
   * 关键在于「打架」必须显式判定：sum=1 既可能是两多一空，也可能只是一亮两哑，
   * 前者原文说要停手，后者只是信号弱，两者混为一谈就会把观望位置说成买点。
   *
   * A 股适配（这是原文没有、但必须补的）：
   *   · T+1：这套灯描述的是「低吸高抛」，没有底仓的人当天买了卖不掉，
   *     所以信号只能用于「已有持仓的波段 T」或「次日开盘的低吸」；
   *   · 单边市：原文自己承认会卖飞/接刀，用 ADX 直接把单边环境标出来并压分；
   *   · 每只票的脾气不同，所以用本标的近 3 年的同亮样本算胜率，而不是套经验值。
   * ============================================================ */
  QL.registerStrategy({
    id: 'trires',
    name: '三指标共振',
    short: '三灯',
    color: '#4FE0B0',
    sub: 'tri',
    desc: 'MACD/KDJ/RSI 三灯同亮 · 同亮果断、两灯小试、打架不动',

    overlay(ctx) {
      const { data, ind } = ctx;
      const T = ind.tri;
      if (!T || !T.sum) return [];
      const n = ctx.n, vs = ctx.helpers.vspan();
      const out = [];
      const cands = [];
      for (let i = Math.max(1, vs.lo); i < Math.min(n, vs.hi); i++) {
        const v = T.sum[i];
        if (v == null || Math.abs(v) !== 3) continue;
        cands.push({
          i, prio: 1,
          m: {
            text: v > 0 ? '三多' : '三空',
            color: v > 0 ? '#F6465D' : '#2EBD85',
            r: 4.2, bold: true, above: v < 0,
          },
        });
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 50, lastIdx)) {
        out.push({
          type: 'marker', i, p: m.above ? data[i].h : data[i].l,
          color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
          r: m.r, bold: m.bold,
          align: i > n - 10 ? 'right' : (i < vs.lo + 5 ? 'left' : 'center'),
        });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1;
      const T = ind.tri;
      if (!T || T.sum[i] == null || n < 70) {
        return { score: 0, verdict: `历史数据不足 70 根（当前 ${n} 根），三灯的交叉与胜率统计都还不成立。`, points: [{ k: '数据', v: `仅 ${n} 根` }] };
      }
      const pts = [];
      let s = 0;

      const a = T.macd[i], b = T.kdj[i], c3 = T.rsi[i];
      const sum = T.sum[i], conf = T.conflict[i];
      const jv = ind.kdj.j[i], r6 = ind.rsi6[i];
      const adx = ind.dmi && ind.dmi.adx ? ind.dmi.adx[i] : null;

      const lamp = (v) => (v > 0 ? '多' : v < 0 ? '空' : '灭');
      pts.push({
        k: '三灯',
        v: `MACD ${lamp(a)} · KDJ ${lamp(b)}${jv != null ? `（J=${jv.toFixed(1)}）` : ''} · RSI ${lamp(c3)}${r6 != null ? `（6日=${r6.toFixed(1)}）` : ''} → 合成 ${sum > 0 ? '+' : ''}${sum}`,
      });

      if (conf) {
        // 打架：原文明确「不动」。这里不给任何方向分，避免把矛盾信号包装成买点。
        pts.push({ k: '状态', v: '三灯打架（同时出现多与空），原文的做法是「不动、等清楚」' });
      } else if (Math.abs(sum) === 3) {
        s += sum > 0 ? 34 : -34;
        pts.push({ k: '状态', v: `三灯同亮${sum > 0 ? '多' : '空'} —— 原文的「果断」级别，但要先确认环境不是单边` });
      } else if (Math.abs(sum) === 2) {
        s += sum > 0 ? 16 : -16;
        pts.push({ k: '状态', v: `两灯一致${sum > 0 ? '偏多' : '偏空'}（另一灯不表态）—— 原文的「小试」级别` });
      } else if (sum === 0) {
        pts.push({ k: '状态', v: '三灯全灭或刚好对消，没有可操作信息' });
      } else {
        s += sum > 0 ? 7 : -7;
        pts.push({ k: '状态', v: `仅一灯${sum > 0 ? '偏多' : '偏空'}，其余不表态 —— 信号偏弱，只够观察` });
      }

      /* 环境：原文的适用边界写得比规则本身还重要 */
      if (adx != null) {
        if (adx < 20) {
          if (!conf) s += 6;
          pts.push({ k: '环境', v: `ADX ${adx.toFixed(1)}（<20）= 震荡市，正是原文说「好用」的场景` });
        } else if (adx > 30) {
          const before = s;
          s = Math.round(s * 0.75);
          pts.push({
            k: '环境',
            v: before === 0
              ? `ADX ${adx.toFixed(1)}（>30）= 单边趋势。原文警告这里会「卖飞」或「接刀」；当前三灯本身没有方向分，所以只作环境提示`
              : `ADX ${adx.toFixed(1)}（>30）= 单边趋势。原文警告这里会「卖飞」或「接刀」，实测（142 只 / 1665 笔）该环境下 3 日胜率 44%、均值 −0.09%，属无优势而非系统性亏损，信号强度按 75% 折算（${before} → ${s}）`,
          });
        } else {
          pts.push({ k: '环境', v: `ADX ${adx.toFixed(1)}，趋势强度中性，信号按原值使用` });
        }
      }

      /* 极端单灯：做 T 的「高抛低吸」位置，即使合成只有 1~2 也值得说 */
      if (!conf && jv != null) {
        if (jv > 100) { s -= 8; pts.push({ k: '极度', v: `J=${jv.toFixed(1)}（>100 超买），原文点名的减仓位置；追进去就是给T+1抬轿` }); }
        else if (jv < 0) { s += 8; pts.push({ k: '极度', v: `J=${jv.toFixed(1)}（<0 超卖），原文点名的低吸位置` }); }
      }
      if (!conf && r6 != null) {
        if (r6 >= 80) { s -= 6; pts.push({ k: '过热度', v: `RSI6 ${r6.toFixed(1)}（≥80）偏热，短线继续追的性价比低` }); }
        else if (r6 <= 20) { s += 6; pts.push({ k: '过冷度', v: `RSI6 ${r6.toFixed(1)}（≤20）偏冷，反抽概率上升` }); }
      }

      /* 本标的自己的历史：同亮之后 3 根涨没涨。样本不足 4 次就不下结论。
       * 注意统计口径只针对「三灯同亮」，当前若是两灯，只能作参考，不能当成本次信号的胜率。 */
      const st = T.stats;
      const pick = sum > 0 ? st.up : st.dn;
      const isFull = Math.abs(sum) === 3;
      if (!conf && pick && pick.n >= 4 && pick.win != null) {
        const lead = isFull ? '' : '（当前只有两灯，以下是三灯同亮的历史表现，仅供参考）';
        if (pick.win >= 0.6) { s += isFull ? 10 : 3; pts.push({ k: '历史', v: `本标的三灯同亮${sum > 0 ? '多' : '空'}出现 ${pick.n} 次，其后 3 根方向命中 ${(pick.win * 100).toFixed(0)}%${lead}` }); }
        else if (pick.win <= 0.4) { s -= isFull ? 10 : 3; pts.push({ k: '历史', v: `本标的三灯同亮${sum > 0 ? '多' : '空'}出现 ${pick.n} 次，命中仅 ${(pick.win * 100).toFixed(0)}% —— 在这只票上偏反向，别硬用${lead}` }); }
        else pts.push({ k: '历史', v: `本标的三灯同亮${sum > 0 ? '多' : '空'}出现 ${pick.n} 次，命中 ${(pick.win * 100).toFixed(0)}%，接近抛硬币${lead}` });
      } else if (pick) {
        pts.push({ k: '历史', v: `本标的三灯同亮样本只有 ${pick.n} 次，不足 4 次，不作胜率结论` });
      }

      /* A 股 T+1 的现实约束 */
      if (ctx.period === 'day') {
        pts.push({ k: 'A股', v: 'T+1：当日买入不能当日卖出。这套灯用于「已有底仓的波段 T」或「次日开盘低吸」，不能当日内 T 用' });
      }

      /* 新鲜度：同亮那天才是最有效的执行窗口 */
      if (T.lastStrong >= 0) {
        const age = i - T.lastStrong;
        if (age <= 2 && isFull) {
          s += sum > 0 ? 6 : -6;
          pts.push({ k: '新鲜度', v: `${age === 0 ? '就在今天' : age + ' 根前'}出现三灯同亮，仍是有效窗口` });
        } else if (age <= 2) {
          pts.push({ k: '新鲜度', v: `${age === 0 ? '今天' : age + ' 根前'}曾三灯同亮，当前已降为 ${sum > 0 ? '+' : ''}${sum}，属衰减中，力度不如同亮当天` });
        } else {
          pts.push({ k: '新鲜度', v: `最近一次三灯同亮在 ${age} 根前，当前合成 ${sum > 0 ? '+' : ''}${sum} 只是余波` });
        }
      }

      s = clamp(s, -100, 100);
      const tri = conf ? '打架' : Math.abs(sum) === 3 ? '同亮' : Math.abs(sum) === 2 ? '两灯' : sum === 0 ? '全灭' : '单灯';

      let verdict;
      if (conf) {
        verdict = `三灯打架：MACD 说${a > 0 ? '多' : a < 0 ? '空' : '不清楚'}、KDJ 说${b > 0 ? '多' : b < 0 ? '空' : '不清楚'}、RSI 说${c3 > 0 ? '多' : c3 < 0 ? '空' : '不清楚'}。原文对这种情况只有一句话：不动、等清楚。等三灯里至少两盏同向再谈进场。`;
      } else if (sum >= 2) {
        verdict = `三灯${sum === 3 ? '同亮' : '两盏一致'}偏多${jv != null ? `（J=${jv.toFixed(1)}）` : ''}${adx != null && adx > 30 ? '，但 ADX 已过 30、处于单边强势段，原文提醒这里做 T 容易卖飞，持仓为主、别频繁进出' : '，属原文的做 T 买点区间；有底仓的可以低吸，没底仓的等次日开盘确认'}。`;
      } else if (sum <= -2) {
        verdict = `三灯${sum === -3 ? '同亮' : '两盏一致'}偏空${jv != null ? `（J=${jv.toFixed(1)}）` : ''}${adx != null && adx > 30 ? '，单边下跌里接刀最危险，空仓就继续空仓' : '，是原文的高抛位置：有底仓的减一部分，没底仓的不要在这里开新仓'}。`;
      } else if (sum === 0 && jv != null && jv < 0) {
        verdict = `三灯没同向，但 J 已跌到 ${jv.toFixed(1)}（<0）的极端超卖。原文把 J<0 单列为低吸信号——它不是买点确认，只是「别在这里割」的提示，等 KDJ 金叉与 MACD 柱翻红再动手。`;
      } else {
        verdict = `三灯只有${sum > 0 ? '微弱偏多' : sum < 0 ? '微弱偏空' : '零星'}信号，够不上原文「两灯一致」的门槛。做 T 最怕的就是在这种半亮不亮的位置反复进出，手续费和滑点会把利润吃光——等。`;
      }

      pts.push({ k: '结论', v: `${tri} · 合成 ${sum > 0 ? '+' : ''}${sum} · ${adx != null ? (adx < 20 ? '震荡环境（适用）' : adx > 30 ? '单边环境（降级）' : '中性环境') : '环境未知'}` });
      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * PA 多周期 · 日线定方向、周线定结构、日线内部找时机
   * （来源：小红书「阿布价格行为实战：如何构建完整交易系统」2026-11-12）
   *
   * 原文是「日线筛趋势 → 30 分钟确认结构 → 5 分钟找入场」。
   * 我们只有日/周/月三档，所以层级换成：周线定方向 → 日线定结构 → 最近 5 根定触发。
   * 这不是妥协：原文的核心是「三个周期方向一致才动手」，周期长度可以换，逻辑不能换。
   *
   * 原文点到的概念全部落地：
   *   MTR（主要趋势反转）· Trading Range · Breakout + Follow-through
   *   · Opening Breakout（A 股无分钟数据，用「跳空 + 首根强度」近似）
   *   · Reversal（双底 / 更高低点 / 下跌失败）· Always In Long
   *   · 止损先行、按风险倒推仓位、不逆势补仓、T+1 要留缓冲
   * ============================================================ */
  QL.registerStrategy({
    id: 'pamtf',
    name: 'PA 多周期',
    short: 'PA多',
    color: '#FFC24B',
    sub: 'pabar',
    desc: '周线定向 · 日线定构 · 触发入场 · 止损倒推仓位',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const out = [];
      if (ind.ema20) {
        const line = [];
        for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) if (ind.ema20[i] != null) line.push([i, ind.ema20[i]]);
        if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(255,194,75,.75)', width: 1.5 });
      }
      const S = paScan(ctx);
      const atr = S.AV(n - 1);

      /* 三档周期共振状态直接写在图上：方向不一致是这套系统唯一的一票否决项 */
      const W = bigTrend(ctx);
      const PN = ctx.periodName || '日线';
      let txt = '';
      if (W.dir === 1) txt = W.tag + '多';
      else if (W.dir === -1) txt = W.tag + '空';
      else txt = W.tag + '平';
      txt += S.env === 'up' ? '·' + PN + '多' : S.env === 'down' ? '·' + PN + '空' : '·' + PN + '区';
      const agree = (W.dir === 1 && S.env === 'up') ? 1 : (W.dir === -1 && S.env === 'down') ? -1 : 0;
      // 标注放左上：右侧是价格轴与最新一根的高点，写在那里会被价格标签压住
      let vHi = -Infinity;
      for (let k = Math.max(0, vs.lo); k < Math.min(n, vs.hi); k++) if (data[k].h > vHi) vHi = data[k].h;
      out.push({
        type: 'label', i: Math.max(0, vs.lo) + 2, p: isFinite(vHi) ? vHi : data[n - 1].h,
        text: txt + (agree ? ' ✓共振' : ' ✗不共振'),
        color: agree ? (agree > 0 ? '#F6465D' : '#2EBD85') : '#8A93A6',
        align: 'left', dy: -8, size: 10,
      });

      /* 止损位：近 12 根低点外侧 0.3 ATR —— 原文「先定止损再算仓位」的第一步。
       * 必须与 analyze 里的算法完全一致，否则图上一根线、解读卡另一个数，用户没法用。 */
      let swLo = Infinity;
      for (let k = Math.max(0, n - 12); k < n; k++) if (data[k].l < swLo) swLo = data[k].l;
      const stop = Math.min(swLo - atr * 0.3, data[n - 1].c - atr * 0.5);
      if (isFinite(stop) && stop > 0) {
        const x1 = Math.max(vs.lo, n - 25);
        out.push({
          type: 'line', pts: [[x1, stop], [n - 1, stop]],
          color: 'rgba(46,189,133,.5)', width: 1.1, dash: [5, 4],
        });
        out.push({ type: 'label', i: n - 1, p: stop, text: '止损 ' + stop.toFixed(2), color: 'rgba(46,189,133,.9)', align: 'right', dy: 12, size: 9 });
      }
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, i = n - 1, c = data[i].c;
      const S = paScan(ctx);
      if (n < 40) return { score: 0, verdict: `历史数据不足 40 根（当前 ${n} 根），多周期的结构还读不出来。`, points: [{ k: '数据', v: `仅 ${n} 根` }] };

      const pts = [];
      let s = 0;
      const atr = S.AV(i);
      const W = bigTrend(ctx);
      const PN = ctx.periodName || '日线';
      const envName = S.env === 'up' ? '上升趋势' : S.env === 'down' ? '下降趋势' : '交易区间';

      /* ① 大周期：只做一件事——定方向。方向不明就什么都不做。
       * 日线视图看周线、周线视图看月线；月线视图没有更大的周期可用，直接说明。 */
      if (!W.ok) {
        pts.push({ k: W.name, v: W.reason });
      } else {
        const wTxt = W.dir === 1 ? '多头' : W.dir === -1 ? '空头' : '无方向（均线走平）';
        pts.push({
          k: W.name,
          v: `${wTxt}：收盘${W.above ? '在' : '跌破'}${W.name} MA20（${W.ma20.toFixed(2)}），MA20 四周斜率 ${W.slope >= 0 ? '+' : ''}${W.slope.toFixed(2)}%${W.pending ? '（当根未走完，按已完成的上一根判定）' : ''}`,
        });
        if (W.dir === 1) s += 20;
        else if (W.dir === -1) s -= 20;
      }

      /* ② 中周期：结构。和 albrooks 用同一套读数，保证两个流派不会自相矛盾 */
      s += S.env === 'up' ? 15 : S.env === 'down' ? -15 : 0;
      pts.push({ k: PN, v: `${envName}（20EMA 上方 ${(S.above * 100).toFixed(0)}%，斜率 ${S.slope.toFixed(2)} ATR，K 线重叠 ${(S.ov * 100).toFixed(0)}%）` });

      /* ③ 共振判定：这是这套系统的骨架。不共振时，原文的态度是「等」，不是「折中」 */
      const agree = (W.dir === 1 && S.env === 'up') ? 1 : (W.dir === -1 && S.env === 'down') ? -1 : 0;
      if (W.ok) {
        if (agree) {
          s += agree > 0 ? 10 : -10;
          pts.push({ k: '共振', v: `${W.name}${W.dir > 0 ? '多' : '空'} + ${PN}${S.env === 'up' ? '多' : '空'}，方向一致 —— 原文「三个周期方向一致才动手」的前两关已过` });
        } else if (W.dir === 1 && S.env === 'down') {
          s -= 6;
          pts.push({ k: '共振', v: `${W.name}多、${PN}空：属大周期里的回调。原文的态度是等回调结束（出现更高低点）再买，而不是「大周期多所以可以接飞刀」` });
        } else if (W.dir === -1 && S.env === 'up') {
          s -= 4;
          pts.push({ k: '共振', v: `${W.name}空、${PN}多：属下跌中的反弹。反弹只做减仓，不当作反转` });
        } else {
          pts.push({ k: '共振', v: `${W.name}无方向、${PN}在走结构：可以按${PN}做，但仓位要比共振时更轻` });
        }
      }

      /* ④ 触发：最近 5 根内的 L2 / H2，原文的首选入场点 */
      const lastEnd = (arr) => { for (let k = arr.length - 1; k >= 0; k--) if (arr[k].kind === 'end') return arr[k]; return null; };
      const lu = lastEnd(S.pullsUp), ld = lastEnd(S.pullsDn);
      if (lu && i - lu.i <= 5) {
        s += lu.n >= 2 ? 12 : 5;
        pts.push({ k: '触发', v: `L${lu.n} 已触发（${i - lu.i} 根前）：${envName === '上升趋势' ? '上行趋势里的第 ' + lu.n + ' 次回调被买盘接管' : '区间内第 ' + lu.n + ' 次回踩被接住'}${lu.n >= 2 ? '，双底结构，原文首选买点' : ''}` });
      } else if (ld && i - ld.i <= 5) {
        s += ld.n >= 2 ? -12 : -5;
        pts.push({ k: '触发', v: `H${ld.n} 已触发（${i - ld.i} 根前）：第 ${ld.n} 次反弹失败${ld.n >= 2 ? '，双顶结构，原文的多头最后离场点' : ''}` });
      } else {
        pts.push({ k: '触发', v: '最近 5 根没有 L/H 触发信号，属两腿之间的空窗，不追' });
      }

      /* ⑤ 突破与跟进（Breakout + Follow-through）：
       * 原文反复强调「突破本身不值钱，跟进才值钱」。这里就把跟进量化：
       * 突破 20 根新高之后的 1~3 根，收盘是否守住突破位、量能是否延续。 */
      let bo = null;
      for (let k = Math.max(21, n - 8); k < n; k++) {
        let hh = -Infinity;
        for (let t = k - 20; t < k; t++) if (data[t].h > hh) hh = data[t].h;
        if (data[k].c > hh) { bo = { i: k, hi: hh }; break; }
      }
      if (bo) {
        const after = n - 1 - bo.i;
        const hold = data[i].c > bo.hi;
        const volb = ind.volMa5[bo.i] ? data[bo.i].v / ind.volMa5[bo.i] : null;
        if (hold && after <= 3) {
          s += 8;
          pts.push({ k: '突破', v: `${after === 0 ? '当日' : after + ' 根前'}突破 20 根新高 ${bo.hi.toFixed(2)}，收盘仍站在突破位之上${volb != null ? `（突破量比 ${volb.toFixed(2)}）` : ''} —— 跟进成立，这是原文唯一认可的突破买法` });
        } else if (!hold && after <= 3) {
          s -= 6;
          pts.push({ k: '突破', v: `突破 ${bo.hi.toFixed(2)} 后 ${after} 根内又跌回其下，属原文说的「突破失败」，多头陷阱，不追` });
        } else {
          pts.push({ k: '突破', v: `${after} 根前突破 ${bo.hi.toFixed(2)}，${hold ? '目前仍守住' : '已收回'}，跟进窗口已过` });
        }
      }

      /* ⑥ MTR（主要趋势反转）：原文里胜率最高、也最容易被误用的一类。
       * 判定要三件事同时成立：前一段是下跌、出现强反转 K、反转后突破前一个 swing 高点。
       * 只满足「跌了很多」不算 MTR —— 那是抄底，不是价格行为。 */
      let lo = Infinity, loI = -1;
      for (let k = Math.max(0, n - 40); k < n; k++) if (data[k].l < lo) { lo = data[k].l; loI = k; }
      if (loI >= 0 && n - 1 - loI >= 2 && n - 1 - loI <= 30) {
        let strongAfter = 0, hhAfter = -Infinity;
        for (let k = loI + 1; k < n; k++) {
          const rng = data[k].h - data[k].l;
          if (rng > 0 && (data[k].c - data[k].o) / rng >= 0.55 && (data[k].c - data[k].l) / rng >= 0.65) strongAfter++;
          if (k <= loI + 5 && data[k].h > hhAfter) hhAfter = data[k].h;
        }
        const brokeOut = hhAfter > -Infinity && c > hhAfter;
        if (strongAfter >= 2 && brokeOut) {
          s += 10;
          pts.push({ k: 'MTR', v: `${loI === 0 ? '区间起点' : (n - 1 - loI) + ' 根前'}见低点 ${lo.toFixed(2)}，其后出现 ${strongAfter} 根强多头趋势K线并突破反弹高点 ${hhAfter.toFixed(2)} —— 原文的主要趋势反转（MTR）成立，属反转做多，不是抄底` });
        } else if (strongAfter >= 2) {
          s += 3;
          pts.push({ k: 'MTR', v: `低点 ${lo.toFixed(2)} 后已有 ${strongAfter} 根强多头K线，但尚未越过反弹高点 ${hhAfter.toFixed(2)}，MTR 未确认` });
        } else {
          pts.push({ k: 'MTR', v: `低点 ${lo.toFixed(2)} 之后没有出现成串的强多头趋势K线，属原文说的「下跌失败还没发生」，不构成反转` });
        }
      }

      /* ⑦ Always In Long（原文 5 分钟图上的第三条策略，日线上同样适用） */
      if (S.ai > 0) { s += 6; pts.push({ k: 'Always In', v: 'Always In Long：连续强多头K线 + 回调浅，原文的顺势首选状态' }); }
      else if (S.ai < 0) { s -= 6; pts.push({ k: 'Always In', v: 'Always In Short：连续强空头K线，A 股不能做空，对应动作是空仓' }); }

      /* ⑧ 止损、目标、仓位：原文把这一节看得比入场更重，所以必须给出可执行的数字。
       * 原文的顺序是「先定止损 → 再算盈亏比 → 不足 2R 直接放弃 → 最后按风险倒推仓位」，
       * 少了盈亏比这一关，就成了「只要方向对就买」，那不是价格行为。 */
      const swingLo = (() => { let v = Infinity; for (let k = Math.max(0, n - 12); k < n; k++) if (data[k].l < v) v = data[k].l; return v; })();
      const stop = Math.min(swingLo - atr * 0.3, c - atr * 0.5);
      const riskPct = (c - stop) / c * 100;
      // 「止损过宽」的阈值必须跟着周期走：日线 10% 已经很宽，周线 10% 只是正常波动，
      // 用日线阈值卡周线，会把每一只票都判成「不该做」。
      const maxRisk = ctx.period === 'week' ? 20 : ctx.period === 'month' ? 35 : 10;
      if (riskPct > 0 && riskPct < 45) {
        // 目标位：仍在区间内 → 上沿；已突破 → 按箱体高度做量度移动
        const rngH = S.rngHi - S.rngLo;
        const target = c < S.rngHi ? S.rngHi : S.rngHi + rngH;
        const rr = (target - c) / (c - stop);
        pts.push({
          k: '止损',
          v: `${stop.toFixed(2)}（近 12 根低点外侧 0.3 ATR），距现价 ${riskPct.toFixed(1)}%`,
        });
        if (riskPct > maxRisk) {
          s -= 6;
          pts.push({ k: '止损过宽', v: `止损距离 ${riskPct.toFixed(1)}%，超过${ctx.period === 'day' ? '日线' : ctx.period === 'week' ? '周线' : '月线'} ${maxRisk}% 的上限 —— 说明现价离结构太远，这单本身就不该做，不是仓位能救的` });
        }
        if (rr >= 2) {
          s += 5;
          pts.push({ k: '盈亏比', v: `目标 ${target.toFixed(2)}（${c < S.rngHi ? '区间上沿' : '箱体量度'}），约 ${rr.toFixed(1)}R —— 达到原文要求的 2R 门槛` });
        } else if (rr > 0) {
          s -= 8;
          pts.push({ k: '盈亏比', v: `目标 ${target.toFixed(2)}，只有 ${rr.toFixed(1)}R —— 不足原文要求的 2R，这单应当放弃，等更好的位置` });
        }
        // 单笔风险 1% 本金 → 仓位上限 = 1% / 止损距离。T+1 无法当日纠错，再打七折
        const posFull = 1 / riskPct * 100;
        pts.push({
          k: '仓位',
          v: `按单笔风险 1% 反推：仓位上限 ${posFull.toFixed(0)}%；考虑 T+1 当日无法止损，再打七折 → 建议 ${(posFull * 0.7).toFixed(0)}% 以内`,
        });
      }

      /* ⑨ A 股开盘突破的近似：原文用 5 分钟图看 opening breakout，我们没有分钟数据，
       * 退一步用「跳空 + 当日实体」判断开盘方向是否被跟进。 */
      if (ctx.period === 'day' && i > 0) {
        const gap = (data[i].o - data[i - 1].c) / data[i - 1].c;
        const barBody = S.body[i];
        if (Math.abs(gap) >= 0.01) {
          if (gap > 0 && barBody >= 0.5 && data[i].c > data[i].o) {
            s += 4;
            pts.push({ k: '开盘', v: `高开 ${(gap * 100).toFixed(1)}% 且收出实体 ${(barBody * 100).toFixed(0)}% 的阳线 —— 原文「开盘突破 + 跟进」的日线近似` });
          } else if (gap > 0 && data[i].c < data[i].o) {
            s -= 4;
            pts.push({ k: '开盘', v: `高开 ${(gap * 100).toFixed(1)}% 却收阴，开盘突破没有跟进，属假突破` });
          }
        }
      }

      s = clamp(s, -100, 100);

      let verdict;
      if (!W.ok) {
        verdict = `当前是${PN}视图，系统里没有更大的周期可做共振校验（${W.reason}）。这只票在${PN}上是${envName}${S.env === 'up' ? '，可按顺势回踩做多，但少了上一级周期的确认，仓位要更轻、止损要更近' : S.env === 'down' ? '，A 股只能空仓，等结构转好' : '，区间内只在上下沿动手，中部不动'}。`;
      } else if (W.ok && W.dir === 1 && S.env === 'up' && lu && lu.n >= 2 && i - lu.i <= 5) {
        verdict = `三个条件同时到位：${W.name}多头、${PN}上升趋势、${PN}刚触发 L${lu.n} 双底。这正是原文整套系统的目标状态。止损 ${stop.toFixed(2)}（${riskPct.toFixed(1)}%），按 1% 风险算仓位不超过 ${(100 / riskPct * 0.7).toFixed(0)}%，T+1 下不要一次打满。`;
      } else if (W.ok && W.dir === 1 && S.env === 'up') {
        verdict = `${W.name}与${PN}都向上，方向没问题，但当下没有触发信号（没有 L2、也没有带跟进的突破）。原文的做法是挂着等回调，而不是在趋势中段追一根阳线——追高会让止损位被拉宽到 2 个 ATR 以上，盈亏比直接崩掉。`;
      } else if (W.ok && W.dir === -1 && S.env === 'down') {
        verdict = `${W.name}空、${PN}也空，共振向下。A 股不能做空，这套系统在这个状态下给出的唯一动作是空仓等待；持仓者的每一次反弹都是减仓机会，尤其 H2 双顶。`;
      } else if (S.env === 'range') {
        verdict = `${PN}在交易区间里，${W.name}${W.dir === 1 ? '偏多' : W.dir === -1 ? '偏空' : '没有方向'}。区间的做法只有两条：下沿等强多头信号K线做多、上沿减仓，中间不动。原文说约八成区间突破会失败，所以别在区间中部猜方向。`;
      } else if (W.ok && W.dir === 1) {
        verdict = `${W.name}多头没变，${PN}正在回调。这是原文最愿意等的场景——等回调走出更高低点（L1/L2）再进，而不是现在就接。回调的终点通常落在 20EMA（${ind.ema20[i] != null ? ind.ema20[i].toFixed(2) : '—'}）附近。`;
      } else {
        verdict = `${W.name}方向与${PN}结构不一致，这套系统的一票否决项被触发。原文的态度很明确：宁可错过，不在周期冲突时开仓——冲突状态下胜率不足以覆盖 T+1 的隔夜风险。`;
      }

      pts.push({ k: '结论', v: `${W.tag}${W.dir === 1 ? '多' : W.dir === -1 ? '空' : '平'} · ${PN}${S.env === 'up' ? '多' : S.env === 'down' ? '空' : '区'} · ${agree ? '共振' : '不共振'} · 止损 ${stop.toFixed(2)}` });
      return { score: s, verdict, points: pts };
    },
  });

  /* 更大周期方向：给 PA 多周期用。
   * 层级随当前显示周期自动上移一档：日线 → 周线，周线 → 月线，月线 → 无（降级）。
   * 不这么做的话，在周线视图里会拿周线和周线自己共振，「多周期」就成了摆设。
   * 判定只看三件事：收盘位置、MA20 斜率、当根是否走完 —— 未走完的那根不参与，
   * 否则周三一根阴线就能把「周线多头」改写成空头。 */
  function bigTrend(ctx) {
    const p = ctx.period || 'day';
    if (p === 'month') {
      return {
        ok: false, n: 0, dir: 0, tag: '—', name: '更大周期', reason: '当前已在月线视图，系统里没有比月线更大的周期可用；本流派在这种视图下退化为单周期结构分析，共振一关直接跳过（请在日线或周线视图使用）',
      };
    }
    const W = p === 'week' ? ctx.month : ctx.week;
    const name = p === 'week' ? '月线' : '周线';
    const tag = p === 'week' ? '月' : '周';
    if (!W || !W.n || W.n < 25) {
      return { ok: false, n: W ? W.n : 0, dir: 0, tag, name, reason: `${name}仅 ${W ? W.n : 0} 根（<25），大周期方向无法确认，本流派降级为单周期使用` };
    }
    const lastD = W.d[W.n - 1];
    const pending = ctx.data.length && lastD === ctx.data[ctx.data.length - 1].d;
    const k = pending ? W.n - 2 : W.n - 1;         // 用已完成的那根定方向
    const ma = W.ma20[k], maPrev = W.ma20[k - 4];
    if (ma == null || maPrev == null) {
      return { ok: false, n: W.n, dir: 0, tag, name, reason: `${name}的 MA20 尚未成形（需 24 根以上），大周期方向无法确认` };
    }
    const above = W.c[k] > ma;
    const slope = (ma - maPrev) / maPrev * 100;
    let dir = 0;
    if (above && slope > 0.3) dir = 1;
    else if (!above && slope < -0.3) dir = -1;
    return { ok: true, n: W.n, dir, above, ma20: ma, slope, pending, tag, name };
  }

  /* ============================================================
   * 三周期共振 · 月定空间 / 周定趋势 / 日定买点
   * （来源：小红书「日周月三周期共振趋势找买点原来如此轻松！」2026-11-02）
   *
   * 原文全部内容只有四句：
   *   ① 月线定空间，连续 2 月在 20 线上
   *   ② 周线看趋势，连续 2 周在 20 线上
   *   ③ 日线选买点，在周线趋势后选买点
   *   ④ 选前期周线有倍量堆量标的
   * 评论区反复出现的那句「成交量还差一点点，下午收盘应该可以＞前三天」，
   * 是正文没写进去的第 5 条：日线买点要有量能背书。没有量，前三层只是「位置对」。
   *
   * 与 pamtf（PA 多周期）的分工必须说清楚，否则两个流派会互相打脸：
   *   · pamtf 看的是「结构」——20EMA 环境、Always In、H1/H2、突破跟进、MTR，
   *     回答的是「现在是什么结构、这单该不该做、做多少」。
   *   · tritf 看的是「位置」——三层都用同一条 20 均线，按月→周→日逐级过滤，
   *     回答的是「长期空间开没开、中期趋势转没转、今天是不是回踩到位的买点」。
   *   一个用 EMA 判环境，一个用 MA 卡门槛；一个有止损仓位推导，一个只有「三层齐不齐」。
   *   两者共用 ind.tri3 / paScan，读数不会矛盾。
   * ============================================================ */
  QL.registerStrategy({
    id: 'tritf',
    name: '三周期共振',
    short: '三周期',
    color: '#FF6B9A',
    sub: 'tri3',
    desc: '月线连续2月在MA20上 · 周线连续2周 · 日线回踩放量买点',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const out = [];
      const T = ind.tri3;
      if (!T || !T.ok) return out;
      const isDay = (ctx.period || 'day') === 'day';

      /* 20 日线：原文买点的坐标轴，任何视图都画出来 */
      if (ind.ma20) {
        const line = [];
        for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) if (ind.ma20[i] != null) line.push([i, ind.ma20[i]]);
        if (line.length > 1) out.push({ type: 'line', pts: line, color: 'rgba(255,107,154,.85)', width: 1.5 });
      }

      /* 买点标记：只在日线视图画。周/月视图里「买点」是某一天的事，
       * 画在周线上会被读成「这一周都该买」，那是另一回事。 */
      if (isDay && T.series && T.series.buy) {
        const B = T.series.buy;
        let cnt = 0;
        for (let i = Math.min(n - 1, vs.hi - 1); i >= Math.max(0, vs.lo); i--) {
          if (!B[i]) continue;
          if (++cnt > 3) break;
          out.push({ type: 'marker', i, p: data[i].l, r: 3.4, color: '#FF6B9A', text: '买', pos: 'below', align: 'center', bold: true });
        }
      }

      /* 三层状态贴在左上角：右侧是价格轴，写在那边会被最新价压住 */
      const mark = (L, need) => (!L || !L.ok) ? '?' : (L.streak >= need ? '✓' : (L.live ? '△' : '✗'));
      const txt = `月${mark(T.m, 2)} 周${mark(T.w, 2)} 日${T.d && T.d.dev != null && T.d.dev > 0 ? '✓' : '✗'}`;
      const lv = T.level == null ? 0 : T.level;
      let vHi = -Infinity;
      for (let k = Math.max(0, vs.lo); k < Math.min(n, vs.hi); k++) if (data[k].h > vHi) vHi = data[k].h;
      out.push({
        type: 'label', i: Math.max(0, vs.lo) + 2, p: isFinite(vHi) ? vHi : data[n - 1].h,
        text: txt + (lv >= 3 ? ' 在线上' : ` ${lv}/3`),
        color: lv >= 3 ? '#F6465D' : lv === 2 ? '#E8B84B' : '#8A93A6',
        align: 'left', dy: -8, size: 10,
      });
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, last = data[n - 1];
      const pts = [];
      let s = 0;
      const T = ind.tri3;

      if (!T || !T.ok) {
        return {
          score: 0,
          verdict: `数据不足：日线仅 ${n} 根，20 日均线尚未成形。这套方法需要更长的历史——月线要 24 根（两年）才能确认 20 月线，上市太短的票没法判定。`,
          points: [{ k: '数据', v: '日线不足 25 根，无法计算三周期' }],
        };
      }

      const M = T.m, W = T.w, D = T.d;
      const pct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

      /* ① 月线：空间。这是原文的第一道闸门，关着就什么都不用看 */
      if (!M.ok) {
        s -= 10;
        pts.push({ k: '月线', v: `数据不足：${M.reason}。上市时间太短的票无法判定「长期空间」，只能看周线和日线，结论要打折` });
      } else {
        if (M.streak >= 2) {
          s += 20;
          pts.push({ k: '月线', v: `连续 ${M.streak} 个月收在 20 月线（${M.ma.toFixed(2)}）上方 —— 原文「定空间」的门槛达成。20 月线大约对应 3 年多的平均成本，站上去意味着这批套牢盘已解套，上方不再是密集抛压区` });
        } else if (M.streak === 1) {
          s += 6;
          pts.push({ k: '月线', v: `上月刚站上 20 月线（${M.ma.toFixed(2)}），连续 2 个月还差 1 个月。原文的门槛没到，只能算「空间刚打开」，不是「空间已确认」` });
        } else {
          s -= 24;
          pts.push({ k: '月线', v: `收在 20 月线（${M.ma.toFixed(2)}）下方 —— 原文第一条不成立。这套方法的顺序是月→周→日，第一道闸门关着时，后面两层再漂亮也只是反弹` });
        }
        if (M.live && M.streak >= 1) {
          s += 3;
          const ml = M.maLive != null ? M.maLive.toFixed(2) : '—';
          pts.push({
            k: '本月',
            v: M.streak === 1
              ? `本月至今仍在 20 月线上（${ml}），月末守住的话，下个月初这道门槛就正式满足——这是原文方法里唯一的「提前量」`
              : `本月至今仍在 20 月线上（${ml}），连续月数会继续累加。趋势没坏，但月线是「守得住」而不是「买得进」，进场点仍要看日线`,
          });
        }
        if (M.slope != null) {
          if (M.slope > 1) { s += 6; pts.push({ k: '月线斜率', v: `20 月线近 4 个月上行 ${pct(M.slope)}，是抬升的支撑，不是压下来的天花板` }); }
          else if (M.slope < -0.5) { s -= 4; pts.push({ k: '月线斜率', v: `20 月线仍在下行（${pct(M.slope)}），价格站上去也容易被均线拽回来` }); }
        }
      }

      /* ② 周线：趋势 */
      if (!W.ok) {
        pts.push({ k: '周线', v: `数据不足：${W.reason}，中期趋势无法确认` });
      } else {
        if (W.streak >= 2) {
          s += 16;
          pts.push({ k: '周线', v: `连续 ${W.streak} 周收在 20 周线（${W.ma.toFixed(2)}）上方 —— 原文「看趋势」的门槛达成` });
        } else if (W.streak === 1) {
          s += 5;
          pts.push({ k: '周线', v: `上周刚站上 20 周线（${W.ma.toFixed(2)}），连续 2 周还差 1 周。周线转多通常要 2~3 周确认，提前进等于拿日线波动赌周线方向` });
        } else {
          s -= 18;
          pts.push({ k: '周线', v: `收在 20 周线（${W.ma.toFixed(2)}）下方 —— 第二道闸门没开。月线就算过了，中期趋势还没转` });
        }
        if (W.live && W.streak >= 1) s += 2;
        if (W.slope != null) {
          if (W.slope > 1) { s += 5; pts.push({ k: '周线斜率', v: `20 周线近 4 周上行 ${pct(W.slope)}` }); }
          else if (W.slope < -0.5) { s -= 3; pts.push({ k: '周线斜率', v: `20 周线近 4 周仍在下行（${pct(W.slope)}）` }); }
        }
      }

      /* ③ 日线：位置与买点 */
      if (D.ok) {
        if (D.dev > 0) { s += 8; pts.push({ k: '日线', v: `收在 20 日线（${D.ma.toFixed(2)}）上方 ${pct(D.dev)}` }); }
        else { s -= 10; pts.push({ k: '日线', v: `收在 20 日线（${D.ma.toFixed(2)}）下方 ${pct(D.dev)}，第三层也没过` }); }

        if (D.dev >= 0 && D.dev <= 3) { s += 6; pts.push({ k: '位置', v: `距 20 日线只有 ${D.dev.toFixed(1)}%，是原文说的「回踩到位」区间——买在这里，止损距离最短，盈亏比最好` }); }
        else if (D.dev > 10) { s -= 8; pts.push({ k: '位置', v: `距 20 日线 ${D.dev.toFixed(1)}%，已经走在半山腰。这里进场的止损要放到 20 日线下方，距离被拉到 ${D.dev.toFixed(0)}% 以上，一笔就能吃掉几次正确交易的利润` }); }
        else if (D.dev < -2) { s -= 6; }

        /* 买点：原文只写「选买点」，这里落成三种可执行形态 + 新鲜度衰减 */
        const KNAME = { launch: '放量启动', gapback: '跳空倍量回踩', pull: '缩量回踩企稳' };
        if (D.lastBuy >= 0 && D.buyAge <= 5) {
          /* 三种形态的权重不是按「听起来有多强」给的，是按 1919 笔交易的实测均值给的：
           * 放量启动 −0.03%、缩量回踩 −0.35%、跳空倍量 −0.75%。
           * 追突破在 A 股是负期望，这一点必须体现在分数上，否则文案和评分自相矛盾。 */
          const base = D.lastKind === 'launch' ? 12 : D.lastKind === 'pull' ? 8 : 4;
          const decay = D.buyAge === 0 ? 1 : D.buyAge <= 2 ? 0.75 : 0.45;
          s += Math.round(base * decay);
          pts.push({ k: '买点', v: `${D.buyAge === 0 ? '今天' : D.buyAge + ' 根前'}触发「${KNAME[D.lastKind] || '买点'}」${D.buyAge === 0 ? `，当日量是前 3 日均量的 ${D.volR != null ? D.volR.toFixed(2) : '—'} 倍` : `，按原文该在那天动手，现在只剩约 ${Math.round(decay * 100)}% 的有效性`}` });
        } else if (D.lastBuy >= 0) {
          pts.push({ k: '买点', v: `最近一次买点在 ${D.buyAge} 根前（${KNAME[D.lastKind] || '买点'}），已经过期。原文的买点是「回踩到位那一下」，不是一个可以随时进的价位` });
        } else {
          pts.push({ k: '买点', v: '近 20 根内没有出现回踩、放量启动或跳空倍量买点 —— 现在只是「位置对」，还没到「扣扳机」' });
        }
      }

      /* ④ 周线倍量堆量：原文第 4 条 */
      if (T.pile && T.pile.doneN >= 8) {
        if (T.pile.on) {
          s += 2;
          pts.push({ k: '堆量', v: `近 ${T.pile.span} 周里有 ${T.pile.n} 周的量超过前 4 周均量 1.8 倍 —— 原文第 4 条满足。但实测里「有堆量」的那 1033 笔均值 −0.91%，反而比无堆量的 +0.54% 差：A 股的周线倍量很多时候是高位的派发，不是底部的吸筹。所以这一条只保留「筛选」作用，几乎不加分` });
        } else {
          pts.push({ k: '堆量', v: `近 ${T.pile.span} 周只出现 ${T.pile.n} 周倍量（需 ≥2 周）—— 原文第 4 条不满足，这波上涨缺少资金背书，持续性要打问号` });
        }
      }

      /* ---------- 结论：按「哪一层没开」分档，而不是只给一个分数 ---------- */
      const lv = T.level == null ? 0 : T.level;
      const maTxt = D.ma != null ? D.ma.toFixed(2) : '—';
      const devTxt = D.dev != null ? D.dev.toFixed(1) : '—';
      /* 关键区分：level 只表示「此刻在不在线上」，原文的门槛是「连续 2 根」。
       * 两者不能混用 —— 月线只站上 1 个月时 level 也是 3，
       * 若拿 level 当结论，会把「空间刚打开」说成「三层齐」，这正是这套方法最危险的自欺。 */
      const full = M.ok && W.ok && M.streak >= 2 && W.streak >= 2 && D.dev != null && D.dev > 0;
      let verdict;

      if (!M.ok || !W.ok) {
        verdict = `数据不够长：${[!M.ok ? `月线${M.reason}` : '', !W.ok ? `周线${W.reason}` : ''].filter(Boolean).join('；')}。这套方法的三层里只要缺一层，「共振」就不成立——不是打个折的问题，是根本没法判定，只能当单周期结构看。`;
      } else if (full && D.buyAge === 0) {
        verdict = `三层齐 + 今日买点，正是原文说的那种「轻松」位置：月线连续 ${M.streak} 个月站上 20 月线、周线连续 ${W.streak} 周站上 20 周线、日线在 20 日线（${maTxt}）附近扣扳机。止损就放在买点那根 K 线的低点下方，或 20 日线下方半个 ATR，破了说明这套逻辑失效，不是「再等等」。T+1 下最早明天开盘才能买，若明天高开超过 3% 就别追——买点被抬高，止损距离跟着变宽，盈亏比直接崩。`;
      } else if (full && D.buyAge >= 0) {
        verdict = `三层都齐，但买点在 ${D.buyAge} 根前已经出现。现在进属于「跟一段」：止损必须按那根买点 K 线的低点放，不能拿现价往下量——否则一个正常回踩就把你洗出去，而趋势其实没坏。`;
      } else if (full) {
        verdict = `三层齐，缺的是买点。日线在 20 日线（${maTxt}）上方 ${devTxt}%，属趋势中段。原文的做法是等回踩到 20 日线附近再动手，不在半山腰追——中段进场最大的问题是止损位被迫放得很宽，一次回撤就能吃掉前面几次的利润。`;
      } else if (lv === 3) {
        const gap = [];
        if (M.streak < 2) gap.push(`月线才连续 ${M.streak} 个月（还差 ${2 - M.streak} 个月）`);
        if (W.streak < 2) gap.push(`周线才连续 ${W.streak} 周（还差 ${2 - W.streak} 周）`);
        verdict = `此刻三层都在线上，但门槛没满：${gap.join('、')}。这正是原文方法最容易被误读的地方——「在线上」和「连续 2 根在线上」是两件事。前者的票一抓一大把，后者才是它要的。差这一口气的时候进，等于把「即将共振」当成「已经共振」，止损位和持仓周期都会算错。`;
      } else if (M.streak >= 2 && W.streak >= 2) {
        verdict = `月线、周线都过了，日线跌破 20 日线（${maTxt}）。这正是原文最该「等」的位置：等日线收盘重新站回 ${maTxt} 之上，三层重新齐，那时只要出现量能放大就是买点。现在进，买的是「可能站回去」，不是「已经站回去」。`;
      } else if (M.streak >= 2 && W.streak < 2) {
        verdict = `月线空间在，但周线只连续 ${W.streak} 周站上 20 周线（${W.ma != null ? W.ma.toFixed(2) : '—'}），第二道闸门没开。周线转多一般要 2~3 周，这段时间日线会反复给假信号，原文的「等」在这里最值钱。`;
      } else if (M.streak < 2) {
        verdict = `月线这道闸门关着（连续 ${M.streak} 个月站上 20 月线）。原文把月线放第一位不是为了好看：月线不成立时，周线和日线的多头绝大多数是反弹——可以做，但要按反弹的规矩来（快进快出、不加仓、不扛单），不能按趋势拿。`;
      } else {
        verdict = `三层没有同时满足：月线${M.streak >= 2 ? '✓' : '✗'}、周线${W.streak >= 2 ? '✓' : '✗'}、日线${D.dev != null && D.dev > 0 ? '✓' : '✗'}。这套方法的价值恰恰在「不全满足就不做」——缺一层就降一级处理，缺两层以上直接换票。`;
      }

      /* 实证结论必须写在卡片里，而不是只藏在 README：
       * 用户看到「三层齐」时，有权知道这套规则在 A 股历史上的真实表现。 */
      pts.push({
        k: '实证',
        v: '2021~2026、135 只、1919 笔（跌破 20 日线次日开盘卖，扣双边 0.12%）：胜率 24.9%、均值 −0.24%、盈亏比 0.92，换三种退出口径都在 −0.23%~−0.33%。真正有正期望的是「持有 60 根」+0.43%，以及被筛出来的这批票本身（同期买入持有 +19.6%）。结论：它是个不错的「筛选器」，不是「今天该不该买」的信号',
      });
      pts.push({ k: '结论', v: `月连续 ${M.ok ? M.streak : '?'} 月 · 周连续 ${W.ok ? W.streak : '?'} 周 · 日 ${pct(D.dev)} · 门槛${full ? '全过' : '未满'}` });

      s = Math.max(-70, Math.min(96, Math.round(s)));
      return { score: s, verdict, points: pts };
    },
  });

  /* ============================================================
   * 三把锁低吸（来源：桔子写指标 2026-11-13「三把锁低吸模型」）
   *
   * 原文是一串通达信条件选股公式，三把锁同时成立才出信号：
   *   ① 动量底   MOMI 近 3 日创近 7 日新低（且近 2 日曾为负），今日上穿 3 日均线
   *   ② 布林回踩  近 4 日最低价触及下轨 ×1.04 以内，今日收涨且收盘不低于下轨 ×0.98
   *   ③ 60 线多头  MA60 / MA20 / MA5 同时上行，收盘距 MA60 在 5% 以内
   * 外加一个活性门槛：近 22 日至少有一天涨幅 >1.5%。
   *
   * 三把锁其实只说了一件事——「多头趋势里，价格刚被打到下轨，动量同时拐头」。
   * 少任何一把，含义就变了：
   *   缺①＝还没止跌，接飞刀；缺②＝没跌到便宜位置，追高；
   *   缺③＝根本没有趋势，那是抄底不是低吸。这就是它敢叫「低吸」的底气。
   *
   * ⚠ 原文 M60UP 写的是 MA(C,5)>REF(MA(C,5),1)*1.2，即 5 日线单日涨 20%。
   *   实测 29 只票 / 31115 根日线，该条件成立 0 次 —— 整个公式恒为空。
   *   这里按「5 日线上行」实现（*1.2 判定为笔误），回测对比见 README。
   * ============================================================ */
  function tlScan(ctx) {
    const { data, ind } = ctx;
    const n = ctx.n;
    const P = ctx.period;
    // 原文的百分比阈值（1.5% 涨幅、5% 距线）是日线口径。
    // 周/月一根顶 5/21 个交易日，价格幅度按 √N 放大，否则「5% 以内」在月线上等于要求贴着线走。
    const ps = P === 'week' ? 2.236 : P === 'month' ? 4.583 : 1;
    const LOOK = P === 'week' ? 10 : P === 'month' ? 5 : 22;   // 活性回看根数
    const ACT = 0.015 * ps;                                    // 活性涨幅门槛
    const DIST = 0.05 * ps;                                    // 距 60 线距离

    const mv = ind.momi.v, m3 = ind.momi.ma3;
    const blo = ind.boll.dn;
    const ma5 = ind.ma5, ma20 = ind.ma20, ma60 = ind.ma60;

    /* ① 动量底：近 3 日最低 = 近 7 日最低（新低落在最近 3 天里）
     *    且近 2 日曾为负（确实跌进过负值区）
     *    且今日 MOMI 高于 3 日均 —— 从「还在跌」变成「在回升」的那一根 */
    const raw1 = new Array(n).fill(false);
    for (let i = 7; i < n; i++) {
      if (m3[i] == null) continue;
      let lo3 = Infinity, lo7 = Infinity;
      for (let k = i - 2; k <= i; k++) if (mv[k] < lo3) lo3 = mv[k];
      for (let k = i - 6; k <= i; k++) if (mv[k] < lo7) lo7 = mv[k];
      const wasNeg = mv[i] < 0 || mv[i - 1] < 0;
      raw1[i] = lo3 === lo7 && wasNeg && mv[i] > m3[i];
    }
    // FILTER(…,4)：同一轮只算第一次。下跌途中动量会反复「拐头」，不去重会连喊四根
    const l1 = new Array(n).fill(false);
    let guard = -1;
    for (let i = 0; i < n; i++) {
      if (i <= guard) continue;
      if (raw1[i]) { l1[i] = true; guard = i + 4; }
    }

    // 活性：近 LOOK 根内至少一次涨幅过门槛（原文 RECENT，用来剔除死票）
    const act = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      for (let k = Math.max(1, i - LOOK + 1); k <= i; k++) {
        if (data[k].c / data[k - 1].c - 1 > ACT) { act[i] = true; break; }
      }
    }

    /* ② 布林回踩：近 4 日曾触及下轨 1.04 倍以内，今日收涨且收盘不低于下轨 98%
     *    1.04 是「够近」的容差，0.98 是「别跌穿太深」的下限——
     *    只满足前者的票可能还在自由落体，必须配上「今日收涨」才算踩住了 */
    const touch = new Array(n).fill(false);
    const l2 = new Array(n).fill(false);
    let touchWin = 0;
    for (let i = 0; i < n; i++) {
      const b = blo[i];
      if (b != null) {
        touch[i] = data[i].l <= b * 1.04;
        if (touch[i]) touchWin = 4; else if (touchWin > 0) touchWin--;
        const rise = i > 0 && data[i].c > data[i - 1].c && data[i].c >= b * 0.98;
        l2[i] = touchWin > 0 && rise;
      } else if (touchWin > 0) touchWin--;
    }

    /* ③ 60 线多头：三条均线同日全部上行 + 收盘距 MA60 在门槛内
     *    原文此处为 MA5 > REF(MA5,1)*1.2，单日 20% 不可能成立，按「上行」实现 */
    // 拆成两个子条件：趋势在上、位置够近。原文是一个条件，
    // 但「趋势好但涨远了」和「趋势根本不在」是两种完全不同的处境，
    // 合成一个布尔值就没法在评分上区分，这里分开存
    const l3 = new Array(n).fill(false);
    const up60 = new Array(n).fill(false);
    const up20 = new Array(n).fill(false);
    const up5 = new Array(n).fill(false);
    const near3 = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      if (ma60[i] == null || ma60[i - 1] == null || ma20[i] == null || ma20[i - 1] == null) continue;
      if (ma5[i] == null || ma5[i - 1] == null) continue;
      near3[i] = Math.abs(data[i].c - ma60[i]) / ma60[i] < DIST;
      up60[i] = ma60[i] > ma60[i - 1];
      up20[i] = ma20[i] > ma20[i - 1];
      up5[i] = ma5[i] > ma5[i - 1];
      // 信号严格按原文：三条线同日向上 + 距离达标
      l3[i] = near3[i] && up60[i] && up20[i] && up5[i];
    }

    const sig = new Array(n).fill(false);
    for (let i = 0; i < n; i++) sig[i] = act[i] && l1[i] && l2[i] && l3[i];

    let lastSig = -1;
    for (let i = n - 1; i >= 0; i--) if (sig[i]) { lastSig = i; break; }

    return { l1, l2, l3, up60, up20, up5, near3, act, sig, lastSig, touch, ps, DIST, LOOK, ACT };
  }

  QL.registerStrategy({
    id: 'threelock',
    name: '三把锁低吸',
    short: '三锁',
    color: '#C0A16B',
    sub: 'mom',
    desc: '动量底 · 布林回踩 · 60 线多头，三锁齐开才是低吸',

    overlay(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n, vs = ctx.helpers.vspan();
      const out = [];
      const blo = ind.boll.dn, ma60 = ind.ma60;

      // 60 线：这套战法的「趋势基准」，第三把锁判的就是它
      const l60 = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (ma60[i] != null) l60.push([i, ma60[i]]);
      }
      if (l60.length > 1) out.push({ type: 'line', pts: l60, color: 'rgba(192,161,107,.9)', width: 2 });

      // 布林下轨 + 1.04 容差线：两条线之间的窄带就是「低吸区」
      const ld = [], lt = [];
      for (let i = Math.max(0, vs.lo - 1); i < Math.min(n, vs.hi + 1); i++) {
        if (blo[i] != null) { ld.push([i, blo[i]]); lt.push([i, blo[i] * 1.04]); }
      }
      if (ld.length > 1) {
        out.push({ type: 'line', pts: ld, color: 'rgba(76,141,255,.75)', width: 1.3, dash: [5, 4] });
        out.push({ type: 'line', pts: lt, color: 'rgba(76,141,255,.3)', width: 1, dash: [2, 5] });
      }

      const S = tlScan(ctx);
      const cands = [];
      for (let i = Math.max(1, vs.lo); i < vs.hi; i++) {
        if (S.sig[i]) {
          cands.push({ i, prio: 1, m: { text: '三锁', color: '#E8B84B', r: 4.4, bold: true, above: false } });
        } else if (S.l2[i] && S.l3[i] && S.act[i]) {
          // 「二锁」＝布林回踩 + 60 线多头，跳过动量底。实测这一组的期望好于三锁齐
          // （2454 笔 +0.74% vs 348 笔 −0.23%），画出来让两条口径可以直接对比
          cands.push({ i, prio: 3, m: { text: '二锁', color: 'rgba(192,161,107,.75)', r: 2.8, above: true } });
        }
      }
      const lastIdx = vs.hi >= n ? n - 1 : null;
      for (const { i, m } of ctx.helpers.pickMarks(cands, 46, lastIdx)) out.push({
        type: 'marker', i, p: m.above ? data[i].h : data[i].l,
        color: m.color, text: m.text, pos: m.above ? 'above' : 'below',
        r: m.r, bold: m.bold, align: i > n - 12 ? 'right' : 'center',
      });
      return out;
    },

    analyze(ctx) {
      const { data, ind } = ctx;
      const n = ctx.n;
      const i = n - 1;
      const d = data[i];
      const S = tlScan(ctx);
      const mv = ind.momi.v, m3 = ind.momi.ma3;
      const blo = ind.boll.dn[i], bmid = ind.boll.mid[i], bup = ind.boll.up[i];
      const ma60 = ind.ma60[i];
      const pts = [];
      let s = 0;

      const L1 = S.l1[i], L2 = S.l2[i], L3 = S.l3[i];
      const U60 = S.up60[i], U20 = S.up20[i], U5 = S.up5[i];
      const near = S.near3[i];
      const all = L1 && L2 && L3;

      /* ---------- 三把锁逐条核对 ---------- */
      // ① 动量底
      const mNow = mv[i], m3Now = m3[i];
      const mMin7 = Math.min(...mv.slice(Math.max(0, i - 6), i + 1));
      pts.push({
        k: '① 动量底',
        v: `${L1 ? '✓' : '✗'} MOMI ${mNow.toFixed(1)}（3 日均 ${m3Now == null ? '—' : m3Now.toFixed(1)}，近 7 根最低 ${mMin7.toFixed(1)}）`,
      });
      // 实测（291 只 / 360 笔）：删掉这一把锁后信号量增 7 倍、均值从 −0.23% 变 +0.74%，
      // 也就是说「等动量上穿 3 日线」往往已经错过了反弹第一天，所以单锁只给 10 分
      if (L1) s += 10;

      // ② 布林回踩
      const distLo = blo ? (d.l - blo) / blo * 100 : null;
      pts.push({
        k: '② 布林回踩',
        v: L2
          ? `✓ 最低价距下轨 ${distLo == null ? '—' : (distLo >= 0 ? '+' : '') + distLo.toFixed(2) + '%'}，今日收涨 ${((d.c / data[i - 1].c - 1) * 100).toFixed(2)}%`
          : blo == null ? '✗ 布林未成形（不足 20 根）'
            : `✗ 今日最低价距下轨 ${distLo >= 0 ? '+' : ''}${distLo.toFixed(2)}%，${d.c <= data[i - 1].c ? '且未收涨' : '近 4 日没踩到下轨'}`,
      });
      if (L2) s += 24;

      // ③ 60 线多头
      const dev60 = ma60 ? (d.c - ma60) / ma60 * 100 : null;
      const slope60 = (ma60 != null && ind.ma60[i - 1] != null) ? (ma60 / ind.ma60[i - 1] - 1) * 100 : null;
      const up5 = (ind.ma5[i] != null && ind.ma5[i - 1] != null) ? ind.ma5[i] - ind.ma5[i - 1] : 0;
      const up20 = (ind.ma20[i] != null && ind.ma20[i - 1] != null) ? ind.ma20[i] - ind.ma20[i - 1] : 0;
      pts.push({
        k: '③ 60 线多头',
        v: `${L3 ? '✓' : '✗'} 距 60 线 ${dev60 == null ? '—' : (dev60 >= 0 ? '+' : '') + dev60.toFixed(2) + '%'}`
          + `（门槛 ${(S.DIST * 100).toFixed(1)}%），60 线 ${slope60 == null ? '—' : (slope60 >= 0 ? '+' : '') + slope60.toFixed(3) + '%'}`
          + `，5 线 ${up5 >= 0 ? '↑' : '↓'} / 20 线 ${up20 >= 0 ? '↑' : '↓'}`,
      });
      /* 第三把锁是这套战法的「环境分」，分四档给，不要一刀切：
       *   三线全上 → 环境完全成立（原文的信号前提）
       *   60/20 上、5 线刚拐头 → 大方向没坏，回调正在进行 —— 这恰恰是低吸的时点
       *   只有 60 线撑着 → 中期已转弱
       *   60 线转头 → 趋势不在，这套战法不适用 */
      if (L3) s += 26;
      else if (U60 && U20) s += 14;
      else if (U60) s += 4;

      pts.push({ k: '活性门槛', v: `${S.act[i] ? '✓' : '✗'} 近 ${S.LOOK} 根内出现过 >${(S.ACT * 100).toFixed(1)}% 的单根涨幅` });

      /* ---------- 三锁齐的额外分：单锁成立都不值钱，齐了才是原文要的那一格 ---------- */
      if (all) s += 22;

      /* ---------- 质量微调（±6，不改变「锁优先」的主结构） ---------- */
      if (L2 && blo) {
        // 恰好踩到下轨附近（不高于 1%，不低于 2%）最好；跌穿 4% 以上说明趋势可能已坏
        const dv = (d.l - blo) / blo;
        if (dv < -0.04) { s -= 5; pts.push({ k: '回踩深度', v: '已跌穿下轨 4% 以上，趋势可能已破，不是「回踩」是「破位」' }); }
        else if (dv < -0.01) { s += 4; pts.push({ k: '回踩深度', v: '略穿下轨后收回，洗盘意味明显' }); }
        else if (dv < 0.01) { s += 6; pts.push({ k: '回踩深度', v: '刚好踩在下轨上，位置最标准' }); }
      }
      if (L1) {
        // 从深超卖区拐头的价值远大于从零轴附近拐头
        if (mMin7 < -40) { s += 6; pts.push({ k: '动量位置', v: `从 ${mMin7.toFixed(0)} 的深超卖区拐头，弹性最好` }); }
        else if (mMin7 < -15) { s += 3; }
      }
      const vma5 = ind.volMa5[i];
      const vr = vma5 ? d.v / vma5 : null;
      if (vr != null) {
        if (vr >= 0.9 && vr <= 2.2) { s += 4; pts.push({ k: '量能', v: `量比 ${vr.toFixed(2)}，温和，没有恐慌抛售也没有对倒放量` }); }
        else if (vr > 3) { s -= 4; pts.push({ k: '量能', v: `量比 ${vr.toFixed(2)}，放得太猛，警惕诱多或出货` }); }
        else pts.push({ k: '量能', v: `量比 ${vr.toFixed(2)}` });
      }
      if (L3 && dev60 != null) {
        if (dev60 >= 0 && dev60 < 2) s += 4;
        else if (dev60 < -2) { s -= 4; pts.push({ k: '位置', v: '收盘在 60 线下方 2% 以上，第三把锁的「多头」已名不副实' }); }
      }
      // 布林带宽过窄＝横盘，横盘里的「回踩下轨」只是箱体震荡，不是趋势回调
      if (bup != null && bmid) {
        const bw = (bup - blo) / bmid * 100;
        if (bw < 8) { s -= 4; pts.push({ k: '带宽', v: `布林带宽仅 ${bw.toFixed(1)}%，横盘里的下轨只是箱底，不是趋势回调` }); }
      }

      /* ---------- 缺锁的扣分只针对「趋势真的坏了」这一种错 ----------
       * 前两把锁不满足只是「今天不是买点」，不该把一只趋势股打成空头：
       * 信号本来就每只每年 0.26 次，若 99.7% 的日子都在扣分，综合评分会被系统性压低。 */
      if (!U60) { s -= 20; pts.push({ k: '趋势', v: '60 线转头向下，这套战法的前提（多头趋势）不成立，当下不适用' }); }
      else if (!U20) { s += 0; pts.push({ k: '趋势', v: '60 线仍向上，但 20 线已走平或向下，中期动能在衰减' }); }
      else if (!U5) { pts.push({ k: '趋势', v: '60 / 20 线仍向上，5 线刚拐头向下 —— 回调正在进行，还没到「回调结束」那一步' }); }

      /* ---------- 最近一次信号 ---------- */
      if (S.lastSig >= 0) {
        const age = i - S.lastSig;
        const since = age === 0 ? '今日' : `${age} 根前`;
        const ret = (d.c / data[S.lastSig].c - 1) * 100;
        pts.push({ k: '最近信号', v: `${since}（${data[S.lastSig].d}），至今 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%` });
      } else {
        pts.push({ k: '最近信号', v: '当前数据范围内从未出现三锁齐开' });
      }

      /* 实证结论必须写在卡片里：用户看到「三锁齐」时，有权知道它历史上的真实表现 */
      pts.push({
        k: '实证',
        v: '2021~2026、291 只、360 笔（跌破 60 线次日开盘卖，扣双边 0.12%）：胜率 20.4%、均值 −0.23%、盈亏比 0.91、持仓中位 5 根；换成「跌破信号 K 线低点」是 +0.38%，固定持 5 根 +0.27%（胜率 50.1%）。同期这批票买入持有 +33.1%；随便哪天买、持 20 根 +0.48%，而三锁齐持 20 根 −0.88%。最关键的发现：删掉第一把锁、只留「布林回踩 + 60 线」，信号量增 7 倍、均值变 +0.74%、盈亏比 1.32 —— 动量底这一把在数据上是负贡献。结论：它是一个极严的筛选器（每只每年 0.27 次），用法是「5 根内不涨就走」，不是「今天该买」',
      });

      /* ---------- 结论 ---------- */
      let verdict;
      if (ctx.period !== 'day') {
        verdict = `原文是日线战法（22 日活性、20 日布林、60 日线），当前为${ctx.periodName}。三条均线与布林的相对位置仍然有意义，但「1.5% 涨幅」「距 60 线 5%」这些阈值已按周期折算，这里的信号只作趋势参考，不能直接当买点执行。`;
      } else if (all) {
        const bwNow = (bup != null && bmid) ? (bup - blo) / bmid * 100 : null;
        const bwWarn = (bwNow != null && bwNow < 8)
          ? ` 但要留个心眼：布林带宽只有 ${bwNow.toFixed(1)}%，这么窄的通道说明它其实在横盘，此刻的「下轨」是箱体下沿，不是趋势回调的低点 —— 原文没区分这两种踩线，实盘里得自己看一眼 60 线是不是真在抬。`
          : '';
        verdict = `三把锁全开：动量刚从 ${mMin7.toFixed(0)} 拐头、价格踩在布林下轨（${blo.toFixed(2)}）上、60 线还在向上。这正是原文要的那一格 —— 多头趋势里被打到便宜位置，且当天有人接。止损放这根 K 线低点（${d.l.toFixed(2)}）下方 1 个 ATR，第一目标看布林中轨 ${bmid.toFixed(2)}，站上中轨后看 60 线之上的前高。${bwWarn}`;
      } else if (!U60) {
        verdict = `第三把锁关着，而且是三档里最差的那种：60 线本身已转头向下（${slope60 == null ? '—' : slope60.toFixed(3) + '%'}），距 60 线 ${dev60 == null ? '—' : (dev60 >= 0 ? '+' : '') + dev60.toFixed(2)}%。这套战法的全名叫「趋势中的回调低吸」，趋势不在时它就是抄底 —— 原文自己也没打算这么用。这时候该换票，不是等。`;
      } else if (!U20) {
        verdict = `60 线还在向上，但 20 线已经走平或向下。中期动能正在衰减，「回调」很可能变成「转势」，这时候的低吸赔率不划算。原文要求三条线同时向上不是苛刻，是要躲开这一段。`;
      } else if (!U5) {
        verdict = `大方向没问题（60 线、20 线都在向上），但 5 线刚拐头向下 —— 回调正在进行中，还没走完。原文要的是「回调结束、重新上攻」那一根，现在进等于在半山腰接刀。盯着：等 5 线重新上翘、同时价格踩到下轨，才是它说的那一格。`;
      } else if (!near) {
        verdict = `趋势是好的（60 线与 20 线都在上行），但价格已经涨到 60 线上方 ${dev60.toFixed(2)}%，超出「5% 以内」这个低吸区间。这不是买点，是「等它回来」的位置——原文要求买到趋势里的相对便宜处，追着买就不是这套战法了。`;
      } else if (!L2) {
        verdict = `趋势没问题（60 线向上、股价贴着它），但价格还没跌到便宜位置：今日最低价距布林下轨 ${distLo == null ? '—' : (distLo >= 0 ? '+' : '') + distLo.toFixed(2) + '%'}。低吸的核心是「买得便宜」，位置没到就不动手，宁可不做。`;
      } else if (!L1) {
        verdict = `价格已经踩到下轨、趋势也在，就差动量这一下：MOMI 现在 ${mNow.toFixed(1)}，3 日均线 ${m3Now == null ? '—' : m3Now.toFixed(1)}。等它上穿 3 日线再进 —— 原文的 FILTER 会把这个信号压掉后续 4 根，急不得。`;
      } else {
        verdict = `三把锁里只缺活性门槛：近 ${S.LOOK} 根没有出现过一根像样的涨幅（门槛 ${(S.ACT * 100).toFixed(1)}%）。这类「僵尸票」即使形态齐了，也没有资金愿意接，原文用这一条把 90% 的票挡在门外。`;
      }

      s = clamp(Math.round(s), -100, 100);
      return { score: s, verdict, points: pts };
    },
  });

  /* 权重表（可外部调整） */
  Object.assign(QL.WEIGHTS, {
    ma: 1.25, macd: 1.2, kdj: 0.8, rsi: 0.75, boll: 1.0,
    dow: 1.1, wave: 0.7, gann: 0.85, chan: 1.0, pattern: 1.05,
    fib: 0.8, volume: 1.15, chip: 0.75, sentiment: 0.6,
    // 新增：制度/资金/周期类权重高于纯形态类
    limit: 0.7, dragon: 0.6, cmf: 1.0, turn: 0.9, gap: 0.85,
    weekly: 1.2, donchian: 0.9, ichimoku: 0.8, rs: 1.15,
    volcycle: 0.8, adx: 0.9, bias: 0.7, candle: 0.6,
    // 金坑战法：四重确认的共振体系，权重给到第一梯队
    jinkeng: 1.3,
    // 肉肉战法：斜率均线 + 拐点压力，机械规则清晰，同样给第一梯队
    rou: 1.25,
    // 简谐振荡：自带 50EMA/ADX 环境过滤，信号频率低于纯摆动指标，权重给中上
    sho: 1.1,
    // 价格行为：先定环境再看信号，规则最贴近实盘执行，权重与金坑同级
    albrooks: 1.25,
    // 涨停回踩20：六重条件串联，信号稀少但指向明确，略低于金坑（依赖单一形态）
    zhangting20: 1.15,
    // 威科夫：结构判断（阶段+事件+量价），规则成体系但主观成分多，权重居中
    wyckoff: 1.2,
    // 威科夫 v2：在 v1 的结构上加摆动序列与证据投票，判定更严、假信号更少，
    // 但同样是「描述现状」而非「预测方向」，权重与 v1 同级不让它垄断综合分
    wyckoff2: 1.2,
    // 二买：七重条件串联过滤弱势反弹与高位加速，信号稀少但指向明确
    ermai: 1.1,
    // SKDJ 超卖反弹：判定的是「反弹力度够不够」，属于摆动类，信号频率不低但值博率高
    skdj: 1.05,
    // SuperTrend：机械规则 + 自带移动止损，趋势市里最省心；震荡市假信号多，权重略低于金坑
    supertrend: 1.2,
    // 三指标共振：本质是摆动类做 T 工具，震荡市有效、单边市失效，权重居中偏下
    trires: 0.95,
    // PA 多周期：三周期共振 + 止损仓位成体系，是三个新流派里最完整的，给第一梯队
    pamtf: 1.3,
    // 三周期共振：规则清晰、可复述，但实测（135 只 / 1919 笔）日线择时无正期望，
    // 三层过滤与买点都没有带来增量，所以权重压到观察级，不让它拉高综合分
    tritf: 0.75,
    // 三把锁：三条件串联、信号稀少（每只每年 0.3 次）且自带「趋势 + 位置 + 动量」三重确认，
    // 与涨停回踩 20 日线同属「回调低吸」家族，权重同级
    threelock: 1.15,
    // 资金量价：低位吸筹 + 高位派发两侧都过检（买 t=2.7、卖 t=-4.3），
    // 与涨停回踩同属「等回调再进」的家族，给略高于均值的权重
    flowbs: 1.05,
  });

  /* ============================================================
   * 资金量价（VWAP 净流入强度 × 位置分位）
   *
   * 对用户原始公式的实证修正（476 只 / 2022-2026 / 55 万根日线）：
   *   1. 原式用 (C-O)/(H-L) 代表资金方向，未来 5 日 IC = -0.008，方向是反的；
   *      换成 (C-VWAP)/VWAP 后 IC 全周期转正（5 日 +0.038，20 日 +0.082）。
   *   2. 原式用全历史 SUM 累计，绝对水平取决于上市起点，跨标的不可比；
   *      改为 λ=0.98 的衰减累计。
   *   3. 原式把「换手率」当柱高、把「净量」当颜色，柱高与方向脱节；
   *      这里柱高就是净流入强度本身。
   *   4. 交叉信号在卖出侧完全无效（t=0.1），真正有效的是「位置 + 单日强度」双条件。
   *
   * 结论：低位放量流入（5 日胜率 60%，扣极端行情后均值 +2.1%）比追涨有效得多。
   * ============================================================ */
  QL.registerStrategy({
    id: 'flowbs', name: '资金量价', short: 'FLOW', color: '#FF6B9D', sub: 'flowbs',
    desc: 'VWAP 净流入强度 × 位置分位 · 低位吸筹 / 高位派发',
    overlay(ctx) {
      const f = ctx.ind.flow;
      if (!f || !f.bs.length) return [];
      const vs = ctx.helpers.vspan();
      const out = [];
      let last = -99;
      // 只留二级以上信号，且相邻至少隔 6 根，避免主图被标签淹没
      for (const b of f.bs) {
        if (b.grade < 2) continue;
        if (b.i < vs.lo || b.i > vs.hi) continue;
        if (b.i - last < 6) continue;
        last = b.i;
        const row = ctx.data[b.i];
        out.push({
          type: 'marker', i: b.i,
          p: b.side === 'B' ? row.l : row.h,
          text: `${b.side}${b.grade}`,
          color: b.side === 'B' ? '#F6465D' : '#2EBD85',
          pos: b.side === 'B' ? 'below' : 'above',
        });
      }
      return out;
    },
    analyze(ctx) {
      const f = ctx.ind.flow;
      const n = ctx.n - 1;
      if (!f || !Number.isFinite(N(f.s, n))) {
        return { score: 0, verdict: '资金量价数据不足（需 60 根以上 K 线）', points: [] };
      }
      const s0 = N(f.s, n);
      const pos = N(f.pos, n);
      const cum = N(f.cum, n), cum5 = N(f.cum, n - 5);
      const posTxt = pos < 0.2 ? '极低位' : pos < 0.35 ? '低位' : pos > 0.85 ? '极高位' : pos > 0.75 ? '高位' : '中位';
      const pts = [
        { k: '净流入强度', v: `${s0.toFixed(2)}（约为 20 日均量的 ${Math.abs(s0).toFixed(1)} 倍${s0 >= 0 ? '净流入' : '净流出'}）` },
        { k: '价格位置', v: `${(pos * 100).toFixed(0)}% · ${posTxt}（60 根区间）` },
        { k: '累积方向', v: cum > cum5 ? '近 5 根累积上行，资金持续进场' : '近 5 根累积下行，资金持续离场' },
      ];

      let score = clamp(s0 * 10, -25, 25);       // 中性区只给弱分
      if (pos < 0.2 && s0 >= 2) score = 85;
      else if (pos < 0.3 && s0 >= 1.5) score = 65;
      else if (pos < 0.4 && s0 >= 1) score = 40;
      else if (pos > 0.85 && s0 <= -1.5) score = -85;
      else if (pos > 0.75 && s0 <= -1.5) score = -65;
      else if (pos > 0.6 && s0 <= -1) score = -40;
      if (cum > cum5) score += 6; else score -= 6;

      const recent = f.bs.filter(b => b.i > n - 6).pop();
      if (recent) {
        pts.push({ k: '最近信号', v: `${recent.side}${recent.grade} · ${ctx.data[recent.i].d} · 强度 ${recent.s}` });
      }

      return {
        score: clamp(Math.round(score), -100, 100),
        verdict: (pos < 0.3 && s0 >= 1.5) ? '低位放量流入，属吸筹启动特征（回测 5 日胜率约 60%，需大盘配合）'
          : (pos > 0.75 && s0 <= -1.5) ? '高位放量流出，派发特征明显，反弹缺承接'
            : s0 >= 1.5 ? '资金明显流入，但价格已在相对高位，追高性价比低'
              : s0 <= -1.5 ? '资金明显流出，短线不宜接'
                : '资金多空均衡，等待位置与强度同时给出方向',
        points: pts,
      };
    },
  });

  /* ============================================================
   * 卡尔曼趋势（状态空间估计）
   *
   * 局部线性趋势模型：x = [level, slope]，观测 ln(Close)。
   * 与均线的本质差别不是「更平滑」，而是**同时给出趋势的方差**：
   *   slopeZ = slope / √P₁₁  —— 趋势显著不为 0 的 t 统计量，跨标的跨周期可比，
   *   不需要为「涨 1.5% 算不算趋势」这种问题另设经验阈值。
   *
   * 必须说清的实证结论（476 只 / 2022-2026 / 55 万根日线）：
   *   1. 个股层面用它做趋势跟随无效。日线状态机 36 组参数全部跑输等权基准
   *      （最好一组年化 -0.4%，基准 +2.5%）；横截面按 slopeZ 排序 t 值 -7 ~ -13
   *      （反向即短期反转）；「超跌 + 反抽」-38.9%。
   *   2. 原因不是实现错，而是 A 股日线短期动量本身为负 —— dev 本质是
   *      「价格 vs 自身均线」的重新包装，换皮不换信息。
   *   3. 真正有效的用法在市场层：全市场等权指数的 slopeZ 决定仓位。
   *      中证1000 上实测年化 +1.1%（满仓 -6.4%）、回撤 -46% → -17%。
   *      接口见 /api/kalman/market，那才是这套东西该出现的地方。
   *
   * 所以这里的分是「趋势清晰度」，用来判断该不该按趋势思路持仓，
   * **不是买卖信号**。verdict 必须保持这个措辞，别改成「建议买入」。
   * ============================================================ */
  QL.registerStrategy({
    id: 'kalman', name: '卡尔曼趋势', short: 'KLM', color: '#4C8DFF', sub: 'kalman',
    desc: '状态空间估计趋势线与置信通道 · slopeZ 衡量趋势显著性（诊断用，非买卖信号）',
    overlay(ctx) {
      const k = ctx.ind.kal;
      if (!k || !k.n) return [];
      const vs = ctx.helpers.vspan();
      const lo = Math.max(0, vs.lo), hi = Math.min(k.n - 1, vs.hi);
      if (hi - lo < 2) return [];
      const out = [];
      const line = (arr, color, width, dash, alpha) => {
        const pts = [];
        for (let i = lo; i <= hi; i++) {
          const v = arr[i];
          if (v > 0 && isFinite(v)) pts.push([i, v]);
        }
        if (pts.length > 1) out.push({ type: 'line', pts, color, width: width || 1.5, dash, alpha: alpha == null ? 0.95 : alpha });
      };
      // 通道先画（细虚线），趋势线后画压在上面
      line(k.upper, 'rgba(76,141,255,.55)', 1, [3, 3], 0.8);
      line(k.lower, 'rgba(76,141,255,.55)', 1, [3, 3], 0.8);
      line(k.smoothLevel, 'rgba(232,184,75,.5)', 1, [6, 4], 0.7);   // RTS 平滑（历史，仅供观察）
      line(k.level, '#4C8DFF', 1.8, null, 0.95);                    // 滤波趋势（可实时用）

      // 状态翻转点：进入/退出趋势的时点，比逐根标签信息量大得多
      for (const t of (k.turns || [])) {
        if (t.i < lo || t.i > hi) continue;
        out.push({
          type: 'marker', i: t.i, p: ctx.data[t.i].l,
          color: t.on ? '#F6465D' : '#2EBD85', r: 3.6, bold: true,
          text: t.on ? '▲趋势' : '▼趋势', pos: 'below',
        });
      }
      return out;
    },
    analyze(ctx) {
      const k = ctx.ind.kal;
      const n = ctx.n - 1;
      if (!k || !k.n || !isFinite(k.slopeZ[n])) {
        return { score: 0, verdict: '卡尔曼数据不足（需 60 根以上 K 线）', points: [] };
      }
      const z = k.slopeZ[n];
      const dev = k.dev[n];
      const lv = k.level[n], px = k.price[n];
      const band = k.upper[n] - lv;
      const bw = lv > 0 ? (band / lv) * 100 : 0;      // 通道半宽（%）
      // 状态持续根数
      let run = 1;
      const sign = z > 0.5 ? 1 : z < -0.5 ? -1 : 0;
      for (let i = n - 1; i >= 1; i--) {
        const s = k.slopeZ[i] > 0.5 ? 1 : k.slopeZ[i] < -0.5 ? -1 : 0;
        if (s !== sign) break;
        run++;
      }
      const pts = [
        { k: '趋势显著性', v: `${z.toFixed(2)}（t 值；±0.5 为顺/逆风分界，±2 为强势/恐慌）` },
        { k: '价格 vs 趋势', v: `偏离通道 ${dev.toFixed(2)} 倍（${dev > 1 ? '已破上轨' : dev < -1 ? '已破下轨' : '通道内'}）` },
        { k: '趋势线 / 现价', v: `${lv.toFixed(2)} / ${px.toFixed(2)}（通道半宽 ±${bw.toFixed(1)}%）` },
        { k: '状态持续', v: `${run} 根（当前${sign > 0 ? '顺风' : sign < 0 ? '逆风' : '中性'}）` },
      ];
      const recent = (k.signals || []).filter((s) => s.i > n - 8).pop();
      if (recent) pts.push({ k: '最近结构', v: `${recent.d} · ${{ start: '趋势启动', pullback: '趋势回调', breakout: '通道突破', break: '趋势破位', fade: '趋势衰竭', hot: '过热' }[recent.kind] || recent.kind}` });

      // 分数只表达「趋势有多清楚」，不表达「该不该买」。
      // 实证上 slopeZ 越高，未来收益反而越差（个股层面），所以这里绝不能给正分当买入。
      const score = Math.round(Math.max(-100, Math.min(100, z * 18)));

      return {
        score,
        verdict: Math.abs(z) < 0.5
          ? '无显著趋势，价格在趋势线附近来回。这种状态下趋势策略会被反复止损，等方向明确再说。'
          : z >= 0.5
            ? (dev > 1
              ? '趋势向上但价格已冲出通道上沿。趋势清晰度高，但此刻进场等于买在拉伸末端。'
              : '趋势向上且仍在通道内。按趋势思路持仓的顺风段，可用趋势线做移动止损。')
            : (dev < -1
              ? '趋势向下且价格已破通道下沿。趋势清晰度高，但方向不利 —— 这套系统在趋势向下时的实测收益为负。'
              : '趋势向下但价格回到通道内，属于下跌中继的常见形态，别把它当反转。'),
        points: pts,
      };
    },
  });

  // 六套体系化战法排在均线之后，保证一进页面就能看到
  (function hoist() {
    for (const [id, pos] of [['jinkeng', 1], ['rou', 2], ['sho', 3], ['albrooks', 4], ['zhangting20', 5], ['threelock', 6],
      ['wyckoff', 7], ['wyckoff2', 8], ['flowbs', 9], ['kalman', 10], ['ermai', 11], ['skdj', 12],
      ['supertrend', 10], ['pamtf', 11], ['tritf', 12], ['trires', 13]]) {
      const i = QL.strategies.findIndex(s => s.id === id);
      if (i > pos) QL.strategies.splice(pos, 0, QL.strategies.splice(i, 1)[0]);
    }
  })();

})(window);
