'use strict';
/**
 * 板块 K 线本地聚合 —— 纯函数，不触网、不读库、不写库。
 *
 * 依据 docs/dev/10-data-source-playbook.md §3.3：
 *   · 上游没有任何源提供板块 K 线，必须自己算
 *   · 每日涨跌幅 = 当日有效成分股涨跌幅的算术平均（等权，不是市值加权）
 *   · 指数序列首日 base=1000，逐日累乘 (1 + 日涨跌幅)
 *   · 停牌（当日无 K 线）的股跳过，不计入分母
 *   · 有效成分数 < minMembers(5) 的日期标记 insufficient
 *   · 单只成分股单日 |涨跌幅| > maxDailyChg(31%) 视为非交易性变动（除权未复权、
 *     复牌、脏数据），剔除该样本 —— A 股单日理论极限是主板 ±10%、双创 ±20%、
 *     北交 ±30%，31% 以上不可能是正常涨跌。不剔除的话一只票就能把整条等权
 *     指数带飞（实测曾有板块 ret20 算出 28502%）。
 *
 * 幸存者偏差（§3.4）：成分用的是「当日成分」，不是历史成分。
 * 因此结果只能用于当日横截面比较与近 20~60 日动量，
 * 禁止用于长周期历史回溯或策略回测；UI 必须带脚注。
 *
 * @param {Record<string, Array<[date,open,close,high,low,volume,amount]>>} membersKlines
 * @param {{config?: object}} opt
 * @returns {{bars: Array, meta: Array, base: number, minMembers: number, dates: string[], survivorBias: true}}
 */
const config = require('../../config');

function aggregateSector(membersKlines, opt) {
  const o = opt || {};
  const cfg = Object.assign({}, config.sector.aggregate, o.config || {});
  const base = Number(cfg.base);
  const minMembers = Number(cfg.minMembers);
  const maxDailyChg = Number.isFinite(Number(cfg.maxDailyChg)) && Number(cfg.maxDailyChg) > 0
    ? Number(cfg.maxDailyChg) : 0.31;

  // 1. 建日期并集（升序）
  const byDate = new Map();
  for (const [code, rows] of Object.entries(membersKlines || {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!r || !r[0]) continue;
      const d = String(r[0]).slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, new Map());
      byDate.get(d).set(code, r);
    }
  }
  const dates = Array.from(byDate.keys()).sort();

  // 2. 每只成分股独立维护「上一有效收盘」，停牌日自动跳过
  const prevClose = new Map();
  let index = base;
  const bars = [];
  const meta = [];

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const cur = byDate.get(d);
    const chgs = [];
    let dropped = 0;
    let sumVol = 0, sumAmount = 0, sumOpen = 0, sumHigh = 0, sumLow = 0, sumClose = 0, cnt = 0;

    for (const [code, r] of cur) {
      const close = Number(r[2]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const prev = prevClose.get(code);
      if (prev !== undefined && prev > 0) {
        const chg = close / prev - 1;
        // 超极限的样本不计入均值，但价格照常推进 —— 否则下一日会连坐
        if (Math.abs(chg) > maxDailyChg) dropped++;
        else chgs.push(chg);
      }
      prevClose.set(code, close);
      sumOpen += Number(r[1]) || close;
      sumHigh += Number(r[3]) || close;
      sumLow += Number(r[4]) || close;
      sumClose += close;
      sumVol += Number(r[5]) || 0;
      // 上游已知缺陷：部分行 amount=0。0 不是有效成交额，不参与求和（09 §7 / 02 L582）
      const amt = Number(r[6]) || 0;
      if (amt > 0) sumAmount += amt;
      cnt++;
    }

    const dayChg = chgs.length
      ? chgs.reduce((a, b) => a + b, 0) / chgs.length
      : null;
    // 首日固定 base，不累乘（没有前收）
    if (i > 0 && dayChg !== null) index *= (1 + dayChg);

    // OHLC 用成分均值按指数比例缩放，保证与 close 同一量纲（仅用于画图）
    const meanClose = cnt ? sumClose / cnt : 0;
    const scale = meanClose > 0 ? index / meanClose : 1;
    bars.push([
      d,
      cnt ? (sumOpen / cnt) * scale : index,
      index,
      cnt ? (sumHigh / cnt) * scale : index,
      cnt ? (sumLow / cnt) * scale : index,
      sumVol,
      sumAmount,
    ]);
    meta.push({
      date: d,
      chg: dayChg,
      memberCount: cnt,
      validCount: chgs.length,
      droppedCount: dropped,
      insufficient: chgs.length < minMembers,
      index,
    });
  }

  return { bars, meta, base, minMembers, dates, survivorBias: true };
}

module.exports = { aggregateSector };
