'use strict';
/**
 * 卡尔曼 · 市场状态（regime）
 *
 * 这个模块只做一件事：把「全市场处于什么状态」算成一个可执行仓位。
 * 它存在的前提是先证否了另一件事 —— 卡尔曼对个股方向的预测在 A 股无效：
 *
 *   个股日线状态机（36 组参数）：全部跑输等权基准，最好的一组年化 -0.4%
 *   个股横截面按趋势强度排序：t 值 -7 ~ -13，反向即短期反转
 *   个股「超跌 + 反抽」：-38.9%
 *
 * 但把全市场等权成指数后，噪声互相抵消、真实趋势浮出来，结论就反过来了。
 * 指数层面的 slopeZ 是用来判断「该不该承担风险」的，不是用来判断「买哪只」的。
 *
 * 指数选择有讲究：等权程度越高越有效。
 *   上证指数   择时年化 -1.7%，差于满仓 -0.5%
 *   沪深300    择时年化 -4.3%，差于满仓 -4.4%
 *   中证1000   择时年化 +1.1%，满仓 -6.4%，回撤 -46% → -17%
 *   国证2000   择时年化 +3.1%，满仓 -3.9%，回撤 -43% → -14%
 * 原因是权重股主导的指数不反映「多数股票」的赚钱效应，而 A 股的赚钱效应在中小盘。
 *
 * 所有阈值与区间在 LEVELS 里，改阈值要同步 tests/unit/kalman-market.test.js。
 */
const K = require('../public/js/kalman.js');
const fuyao = require('./sources/adapters/fuyao');
const log = require('./log');

/* 指数候选：按等权程度从高到低。前一个取不到就降级，降级会写进 note。 */
const CANDIDATES = [
  { code: 'sh000852', name: '中证1000' },
  { code: 'sz399303', name: '国证2000' },
  { code: 'sh000905', name: '中证500' },
];

/**
 * 状态分档与建议仓位。
 * 仓位来自实测最优映射「滞回 1 / 0.3 / 0」：slopeZ > 0.5 满仓、> -0.5 三成、其余空仓。
 * 2022-2026 实测：年化 +1.1%（满仓 -6.4%），最大回撤 -17%（满仓 -46%），Sharpe 0.15（满仓 -0.13）。
 *
 * 恐慌档的仓位给 0 而不是抄底，是因为「slopeZ < -2.5 后 20 日 +10%」这个观察只有 21 个样本
 * 且集中在 2022/2024/2025 的几次急跌，不足以支撑自动加仓；只作为提示文案输出。
 */
const LEVELS = [
  { key: 'strong', min: 2.0, label: '强势', pos: 1.0, color: '#F6465D' },
  { key: 'up', min: 0.5, label: '上行', pos: 1.0, color: '#E8B84B' },
  { key: 'flat', min: -0.5, label: '中性', pos: 0.3, color: '#7A8AA0' },
  { key: 'down', min: -2.0, label: '弱势', pos: 0.0, color: '#2EBD85' },
  { key: 'panic', min: -Infinity, label: '恐慌', pos: 0.0, color: '#2EBD85' },
];

const PANIC_Z = -2.5;

function levelOf(z) {
  if (!isFinite(z)) return LEVELS[2];
  for (const l of LEVELS) if (z >= l.min) return l;
  return LEVELS[LEVELS.length - 1];
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ms = (s) => new Date(s + 'T00:00:00+08:00').getTime();

/* 进程内缓存：市场状态一天不变，没必要每次请求都取一遍指数 */
let MEM = null;
const TTL_MS = 30 * 60 * 1000;

async function fetchIndex(code, years) {
  const end = new Date();
  const start = new Date(end.getTime() - years * 365 * 86400000);
  const r = await fuyao.historical(code, {
    interval: '1d', start: ms(fmt(start)), end: ms(fmt(end)), adjust: 'none',
  });
  const rows = (r && r.rows) || [];
  return rows.map((x) => [x.d, x.o, x.h, x.l, x.c, x.v, x.a || 0]);
}

function describe(state, z, dev, change20, panic) {
  const pos = Math.round(state.pos * 100);
  const head = {
    strong: `趋势强盛（slopeZ ${z.toFixed(2)}），市场处于风险偏好高位。`,
    up: `趋势向上（slopeZ ${z.toFixed(2)}），可以承担风险。`,
    flat: `趋势不明（slopeZ ${z.toFixed(2)}），多空都没有优势。`,
    down: `趋势向下（slopeZ ${z.toFixed(2)}），亏钱概率高于赚钱概率。`,
    panic: `趋势急跌（slopeZ ${z.toFixed(2)}），市场处于恐慌区。`,
  }[state.key];
  const advice = state.pos === 0
    ? '建议空仓或仅保留底仓 —— 这套系统在趋势向下时的实测收益是负的，不做比做错好。'
    : state.pos >= 1
      ? '建议满仓，趋势窗口打开时不要因为「涨多了」而提前下车。'
      : `建议三成左右仓位试仓，等 slopeZ 站上 0.5 再加到满仓。`;
  const tail = panic
    ? ` 注意：历史上 slopeZ 跌破 ${PANIC_Z} 的 21 个时点，其后 20 个交易日 19 次为正、均值约 +10%，` +
      '属于急跌后的均值回复区。要不要左侧接，取决于你的资金久期，系统本身不自动加仓。'
    : '';
  return {
    headline: head,
    advice,
    note: `${state.label} · 建议仓位 ${pos}%${tail}`,
    change20: change20 == null ? null : change20,
  };
}

/**
 * 计算市场状态。失败时返回 ok:false 而不是猜一个默认值 ——
 * 仓位建议如果是猜的，比没有更危险。
 */
async function getMarketState(opts) {
  const force = !!(opts && opts.force);
  if (!force && MEM && Date.now() - MEM.at < TTL_MS) return MEM.data;

  const errors = [];
  let picked = null, rows = null;
  for (const c of CANDIDATES) {
    try {
      const r = await fetchIndex(c.code, 3.2);
      if (r.length < 260) throw new Error('数据不足 ' + r.length + ' 根');
      picked = c; rows = r;
      break;
    } catch (e) {
      errors.push(c.code + ': ' + e.message);
      log.warn('kalman.market_index_failed', { code: c.code, error: e.message });
    }
  }
  if (!picked) {
    return {
      ok: false,
      error: '所有指数都取不到数据，市场状态不可用',
      detail: errors,
      at: new Date().toISOString(),
    };
  }

  const a = K.analyze(rows, { snr: 0.3 });
  if (!a.n) return { ok: false, error: '卡尔曼计算失败（K 线异常）', at: new Date().toISOString() };

  const last = a.n - 1;
  const z = a.slopeZ[last];
  const state = levelOf(z);
  const panic = isFinite(z) && z < PANIC_Z;
  const change20 = last >= 20 ? a.price[last] / a.price[last - 20] - 1 : null;
  const desc = describe(state, z, a.dev[last], change20, panic);

  // 近 120 根的轨迹，供前端画迷你趋势图
  const from = Math.max(0, a.n - 120);
  const history = [];
  for (let i = from; i < a.n; i++) {
    history.push({
      d: rows[i][0],
      z: +a.slopeZ[i].toFixed(3),
      p: +a.price[i].toFixed(3),
      lv: +a.level[i].toFixed(3),
    });
  }

  // 观察：最近一次「进入恐慌」的日期
  let panicSince = null;
  if (panic) {
    for (let i = a.n - 1; i > 0; i--) {
      if (!(a.slopeZ[i] < PANIC_Z)) break;
      panicSince = rows[i][0];
    }
  }

  const data = {
    ok: true,
    index: { code: picked.code, name: picked.name },
    date: rows[last][0],
    price: +a.price[last].toFixed(3),
    level: +a.level[last].toFixed(3),
    upper: +a.upper[last].toFixed(3),
    lower: +a.lower[last].toFixed(3),
    slopeZ: +z.toFixed(3),
    dev: +a.dev[last].toFixed(3),
    snr: a.snr,
    state: { key: state.key, label: state.label, pos: state.pos, color: state.color },
    change20,
    panic, panicSince,
    headline: desc.headline,
    advice: desc.advice,
    note: desc.note,
    history,
    degradedFrom: errors.length ? errors : null,
    at: new Date().toISOString(),
  };
  MEM = { at: Date.now(), data };
  return data;
}

function reset() { MEM = null; }

module.exports = { getMarketState, levelOf, LEVELS, PANIC_Z, CANDIDATES, reset };
