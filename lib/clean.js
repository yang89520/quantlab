'use strict';
/**
 * K 线清洗层
 *
 * 设计原则：**只修「确定错了」的，只报「可能错了」的，绝不凭空生成 K 线。**
 *   · 修：格式、OHLC 内部矛盾、重复日期、乱序、负量 —— 这些有唯一正确答案；
 *   · 报：缺口、异常跳空 —— 无法判断是停牌、除权还是数据源缺失，交给人看；
 *   · 不补：缺失的交易日一律不插值/不复制前值。假的连续比明显断层更危险，
 *     它会让均线、形态、量能比全部失真，而且看不出来。
 *
 * 缺口判定的难点是「怎么区分停牌和丢数据」。这里不依赖外部交易日历，
 * 用相邻 K 线的日期间隔做分层判断：A 股最长休市（春节/国庆）不超过 12 天，
 * 超过这个长度必然是非交易日之外的原因。
 */

/** 一个交易月内允许的最大自然日跨度（含春节长假） */
const MAX_HOLIDAY = 12;

/** 各板块单日涨跌幅上限（%，ST 单独处理） */
function limitPct(code) {
  if (/^(300|301)/.test(code)) return 20;
  if (/^(688|689)/.test(code)) return 20;
  /* 北交所 ±30%；900/901 是沪 B，仍是 ±10%，不能算进 30% 那一档。
   * 判错会让 B 股的正常波动被当成「异常涨跌」剔掉，清洗后序列缺 K 线。 */
  if (/^(4|8)/.test(code) || /^92/.test(code)) return 30;
  return 10;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function dayDiff(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((tb - ta) / 86400000);
}

/**
 * @param {Array} rows 原始 K 线 [d, o, c, h, l, v, a]
 * @param {object} opt { code, period, strict }
 * @returns {{rows, quality}} quality = { ok, fixed, dropped, gaps, jumps, lastDate }
 */
function sanitize(rows, opt) {
  const o = opt || {};
  const period = o.period || 'day';
  const code = String(o.code || '');
  const lim = limitPct(code);
  const fixed = [];
  const dropped = [];
  const gaps = [];
  const jumps = [];

  if (!Array.isArray(rows) || !rows.length) {
    return { rows: [], quality: { ok: false, fixed, dropped, gaps, jumps, empty: true } };
  }

  /* ---------- 1. 逐行合法性 ---------- */
  const stage = [];
  const seen = new Set();
  for (const raw of rows) {
    // 数据源内部用对象行 {d,o,c,h,l,v,a}，对外用数组行 [d,o,c,h,l,v,a]，两种都收
    let r = raw;
    if (r && !Array.isArray(r) && typeof r === 'object') {
      r = [r.d, r.o, r.c, r.h, r.l, r.v, r.a];
    }
    if (!Array.isArray(r) || r.length < 6) { dropped.push('shape'); continue; }
    const d = String(r[0] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { dropped.push('date:' + d); continue; }

    let [, op, cl, hi, lo, vol, amt] = r;
    if (![op, cl, hi, lo].every(isNum)) { dropped.push('nan:' + d); continue; }
    // 非正价格：停牌占位行、上游 0 值、字段错位都长这样，留着会污染均线
    if (op <= 0 || cl <= 0 || hi <= 0 || lo <= 0) { dropped.push('nonpos:' + d); continue; }

    // 同一日期重复：年份文件与 last.js 有重叠区，保留先到的（last.js 更新）
    if (seen.has(d)) { dropped.push('dup:' + d); continue; }
    seen.add(d);

    /* ---------- 2. OHLC 内部一致性 ---------- */
    // 只做「收敛到包络」，不改收盘价 —— 收盘价是复权基准，动它会连锁污染全部指标
    let nOp = op, nHi = hi, nLo = lo;
    const top = Math.max(op, cl);
    const bot = Math.min(op, cl);
    if (nHi < top) { nHi = top; fixed.push('high<' + d); }
    if (nLo > bot) { nLo = bot; fixed.push('low>' + d); }
    if (nHi < nLo) { dropped.push('hi<lo:' + d); continue; }

    stage.push({
      d,
      row: [d, nOp, cl, nHi, nLo,
        isNum(vol) && vol > 0 ? vol : 0,
        isNum(amt) && amt > 0 ? amt : 0],
    });
  }

  /* ---------- 3. 排序 ---------- */
  stage.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const out = stage.map((x) => x.row);

  /* ---------- 4. 缺口 / 跳空检测 ---------- */
  // 周月线本来就稀疏，只做跳空检查，不做缺口检查
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i];
    const prevC = prev[2];

    if (period === 'day') {
      const span = dayDiff(prev[0], cur[0]);
      if (span > MAX_HOLIDAY) {
        // 跨年整段缺失：prev 在 12 月、cur 在下一年 1 月，且间隔接近一年
        const y1 = +prev[0].slice(0, 4), y2 = +cur[0].slice(0, 4);
        const wholeYear = y2 - y1 >= 1 && span > 300;
        // 13~90 天：资产重组、ST 停牌、重大事项，本身就是行情的一部分，不是脏数据。
        // 90 天以上才怀疑数据缺失 —— A 股重整停牌三五个月很常见，
        // 但把真实停牌报成「数据有问题」会让人去改一个本来正确的东西。
        const kind = wholeYear ? 'year' : span > 90 ? 'block' : 'suspend';
        gaps.push({
          from: prev[0], to: cur[0], days: span,
          // bar 数按一年 242 个交易日折算，只用于给用户一个量级感
          bars: Math.round(span / 365 * 242),
          kind,
        });
      }
    }

    // 跳空超过涨跌停上限：除权、复牌、或数据断层
    if (prevC > 0) {
      const gap = (cur[1] - prevC) / prevC;
      // 指数没有涨跌停，放宽到 12%
      const th = (o.code && /^(sh|sz|bj)?\d{6}$/.test(o.code) && o.asset === 'index' ? 0.12 : lim / 100 + 0.02);
      if (Math.abs(gap) > th) {
        jumps.push({
          d: cur[0], pct: +(gap * 100).toFixed(2),
          from: prevC, open: cur[1],
          // 开盘就跳 = 除权/复牌；盘中走出来的 = 数据或真实极端行情
          kind: Math.abs((cur[1] - prevC) / prevC) > th * 0.6 ? 'open' : 'intraday',
        });
      }
    }
  }

  /* ---------- 5. 结论 ---------- */
  // 对外仍用对象行：aggregate / klines 都按 {d,o,c,h,l,v,a} 取字段，
  // 在这里转成数组会让整条链路静默错位。
  const list = out.map((r) => ({ d: r[0], o: r[1], c: r[2], h: r[3], l: r[4], v: r[5], a: r[6] }));
  // 整段缺口（缺一年以上）视为不可用：任何含历史统计的流派都会算错
  const fatal = gaps.some((g) => g.kind === 'year' || g.kind === 'block');
  // 新股上市不足 30 根本身就是事实，不算数据坏
  const newListing = list.length > 0 && list.length < 30
    && dayDiff(list[0].d, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)) < 120;
  const quality = {
    ok: (!fatal && list.length >= 30) || newListing,
    fixed: fixed.slice(0, 20),
    fixedN: fixed.length,
    dropped: dropped.slice(0, 20),
    droppedN: dropped.length,
    gaps,
    jumps,
    bars: list.length,
    lastDate: list.length ? list[list.length - 1].d : null,
    newListing,
  };
  return { rows: list, quality };
}

module.exports = { sanitize, limitPct, MAX_HOLIDAY };
