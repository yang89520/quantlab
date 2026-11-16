'use strict';
/**
 * 观察池状态机 + 存储（docs/dev/04 §4、02 S7/S8）。
 *
 * 纯函数部分 evaluate() 不触网、不读写文件，可离线单测。
 * 存储部分是 Web 进程可写的 JSONL（09 §7.2：按写入方分离，避免 DuckDB 单写进程锁）。
 *
 * 硬规则：
 *  · 一次只前进一档；降级只允许直接到 removed，不设 ambush→watching 回退
 *  · 每次迁移写 S8 日志，含 trigger 与至少 2 条 evidences
 *  · daysInState 按交易日计，不是自然日
 *  · 移出必须选原因（四选一），跳过则报错
 *  · 池满 maxSize 时拒绝入池，绝不自动踢人
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const STATES = ['watching', 'ambush', 'confirmed', 'holding', 'removed'];
const REMOVE_REASONS = ['logic_broken', 'too_slow', 'replaced', 'wrong'];
const REASON_CN = {
  logic_broken: '逻辑破了（触发了失效条件）',
  too_slow: '触发太慢（超过最长停留）',
  replaced: '被更好的标的替代',
  wrong: '我判断错了',
};

function mean(a) {
  const v = (a || []).filter((x) => Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
}

/** 交易日差；sessionDates 缺失时返回 null（不猜、不拿自然日冒充） */
function tradingDaysBetween(from, to, sessionDates) {
  if (!from || !to) return null;
  if (!Array.isArray(sessionDates) || !sessionDates.length) return null;
  const days = sessionDates.map((d) => String(d).slice(0, 10));
  const i = days.indexOf(String(from).slice(0, 10));
  const j = days.indexOf(String(to).slice(0, 10));
  if (i < 0 || j < 0 || j < i) return null;
  return j - i;
}

function indicators(bars) {
  const rows = bars || [];
  const n = rows.length;
  if (n < 21) return null;
  const close = rows.map((r) => Number(r[2]));
  const high = rows.map((r) => Number(r[3]));
  const vol = rows.map((r) => Number(r[5]));
  const last = close[n - 1];
  const ma20 = mean(close.slice(n - 20));
  const ma10 = mean(close.slice(n - 10));
  const v5 = mean(vol.slice(n - 5));
  const v20 = mean(vol.slice(n - 20));
  // 前一日为止的 20 日最高（不含当日，避免自己跟自己比）
  const prevHHV20 = Math.max.apply(null, high.slice(n - 21, n - 1));
  return {
    date: String(rows[n - 1][0]).slice(0, 10),
    close: last, ma20, ma10,
    volRatio: v20 && v20 > 0 ? v5 / v20 : null,
    prevHHV20,
  };
}

function ev(pairs) {
  return pairs.map(([k, v]) => ({ k, v: v == null ? '—' : String(v) }));
}

/**
 * @param {object} entry S7 条目
 * @param {object} ctx { bars, snapshot, sectorGrade, stockScore, date, sessionDates, config }
 * @returns {{nextState, trigger, evidences, reason?, daysInState}}
 */
function evaluate(entry, ctx) {
  const c = Object.assign({}, config.watchpool, (ctx && ctx.config) || {});
  const state = entry.state;
  const keep = (extra) => Object.assign({
    nextState: state, trigger: null, evidences: [],
    daysInState: entry.daysInState == null ? null : entry.daysInState,
  }, extra || {});

  if (state === 'removed') return keep();

  const ind = indicators(ctx.bars);
  const date = ctx.date || (ind && ind.date) || null;
  const daysInState = tradingDaysBetween(entry.stateSince, date, ctx.sessionDates);
  const stay = daysInState == null ? null : daysInState;
  const maxStay = c.maxStay[state];
  if (!ind) {
    // 数据不足不是「通过」，只是无法判定；绝不推进状态
    return keep({ daysInState: stay, reason: null, note: 'bars<21，无法判定' });
  }

  const remove = (trigger, reason, pairs) => ({
    nextState: 'removed',
    trigger,
    reason,
    evidences: ev(pairs),
    daysInState: stay,
    date,
  });

  // 1. 超最长停留 → too_slow（自动）
  if (stay != null && maxStay != null && stay > maxStay) {
    return remove('max_stay', 'too_slow', [
      ['停留交易日', stay], ['上限', maxStay], ['当前状态', state],
    ]);
  }

  // 2. 各状态的失效条件 → logic_broken（自动）
  if (state === 'watching' && ctx.sectorGrade === 'D') {
    return remove('sector_downgrade_D', 'logic_broken', [
      ['板块档位', ctx.sectorGrade], ['收盘', ind.close], ['MA20', ind.ma20],
    ]);
  }
  if (state === 'ambush' && ind.ma20 != null && ind.close < ind.ma20
      && ind.volRatio != null && ind.volRatio > c.removeVol) {
    return remove('volume_break_ma20', 'logic_broken', [
      ['收盘', ind.close], ['MA20', ind.ma20], ['量比', Number(ind.volRatio.toFixed(3))],
      ['放量阈值', c.removeVol],
    ]);
  }
  if (state === 'confirmed') {
    const within = stay == null || stay <= c.confirmWindow;
    const broke = entry.confirmedClose != null && ind.close < entry.confirmedClose;
    if (within && broke) {
      return remove('below_breakout_close', 'logic_broken', [
        ['收盘', ind.close], ['突破日收盘', entry.confirmedClose], ['确认窗口', c.confirmWindow],
      ]);
    }
    if (ind.ma10 != null && ind.close < ind.ma10) {
      return remove('below_ma10', 'logic_broken', [
        ['收盘', ind.close], ['MA10', ind.ma10], ['突破日收盘', entry.confirmedClose],
      ]);
    }
  }
  if (state === 'holding' && ind.ma10 != null && ind.close < ind.ma10) {
    return remove('below_ma10', 'logic_broken', [
      ['收盘', ind.close], ['MA10', ind.ma10], ['MA20', ind.ma20],
    ]);
  }

  // 3. 一次只前进一档：只检查当前状态的下一档
  const advance = (to, trigger, pairs, extra) => ({
    nextState: to, trigger, reason: null, evidences: ev(pairs),
    daysInState: stay, date, extra: extra || {},
  });

  if (state === 'watching' && ind.ma20 != null && ind.volRatio != null) {
    const low = ind.ma20 * c.bandLow;
    const high = ind.ma20 * c.bandHigh;
    if (ind.close >= low && ind.close <= high && ind.volRatio < c.shrink) {
      return advance('ambush', 'shrink_pullback_ma20', [
        ['收盘', ind.close], [`MA20区间`, `${low.toFixed(3)}~${high.toFixed(3)}`],
        ['量比', Number(ind.volRatio.toFixed(3))], ['缩量阈值', c.shrink],
      ]);
    }
  }
  if (state === 'ambush' && ind.volRatio != null) {
    if (ind.close > ind.prevHHV20 && ind.volRatio > c.breakoutVol) {
      return advance('confirmed', 'volume_breakout_hhv20', [
        ['收盘', ind.close], ['前20日最高', ind.prevHHV20],
        ['量比', Number(ind.volRatio.toFixed(3))], ['放量阈值', c.breakoutVol],
      ], { confirmedClose: ind.close });
    }
  }
  if (state === 'confirmed' && entry.confirmedClose != null) {
    if (ind.close >= entry.confirmedClose * c.holdTol) {
      return advance('holding', 'next_day_hold', [
        ['收盘', ind.close], ['突破日收盘', entry.confirmedClose],
        ['容忍线', Number((entry.confirmedClose * c.holdTol).toFixed(3))],
      ]);
    }
  }
  return keep({ daysInState: stay });
}

/* ---------------- JSONL 存储（Web 进程写） ---------------- */

function file(name) { return path.join(config.__root, 'data', 'watchpool', name); }
let queue = Promise.resolve();
function serialize(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}
function readJsonl(name) {
  const p = file(name);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { log.warn('watchpool.corrupt_line', { file: name, line: line.slice(0, 80) }); }
  }
  return out;
}
function writeJsonl(name, rows) {
  const p = file(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}
function appendJsonl(name, row) {
  const p = file(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + '\n');
}

function list() { return readJsonl('pool.jsonl'); }
function transitions(code) {
  const all = readJsonl('transitions.jsonl');
  return code ? all.filter((t) => String(t.code) === String(code)) : all;
}

function transitionId(date, code, to) {
  return `tr_${String(date).replace(/-/g, '')}_${code}_${to}`;
}

function applyTransition(entry, r, date) {
  if (r.trigger == null) return entry;
  const t = {
    schema: 1,
    id: transitionId(date || r.date || '', entry.code, r.nextState),
    at: new Date().toISOString(),
    code: entry.code,
    from: entry.state,
    to: r.nextState,
    trigger: r.trigger,
    evidences: r.evidences || [],
    reason: r.reason || null,
  };
  appendJsonl('transitions.jsonl', t);
  return Object.assign({}, entry, {
    state: r.nextState,
    stateSince: date || r.date || entry.stateSince,
    daysInState: 0,
    reason: r.reason || null,
    removedAt: r.nextState === 'removed' ? (date || r.date) : entry.removedAt,
    confirmedClose: r.extra && r.extra.confirmedClose != null
      ? r.extra.confirmedClose : entry.confirmedClose,
  });
}

/** 入池：池满拒绝、不踢人；评分不足拒绝 */
function add(input, ctx) {
  return serialize(() => {
    const c = Object.assign({}, config.watchpool, (ctx && ctx.config) || {});
    const code = String((input && input.code) || '').replace(/^(sh|sz|bj)/, '');
    if (!/^\d{6}$/.test(code)) throw new Error(`标的代码格式不正确：${code}`);
    const rows = list();
    const active = rows.filter((r) => r.state !== 'removed');
    if (active.some((r) => String(r.code) === code)) throw new Error(`标的 ${code} 已在观察池`);
    if (active.length >= c.maxSize) throw new Error('池已满，请先处理');
    const score = Number(input.score);
    if (!Number.isFinite(score) || score < c.minScore) {
      throw new Error(`综合评分未达入池门槛 ${c.minScore}（实际 ${input.score == null ? 'null' : score}）`);
    }
    const grade = String(input.grade || '');
    if (!/^[AB]$/.test(grade)) throw new Error(`入池要求板块 A/B 档（实际 ${grade || 'null'}）`);
    const date = input.date || null;
    const entry = {
      schema: 1,
      code, name: input.name || '',
      state: 'watching',
      enteredAt: date, stateSince: date,
      daysInState: 0, daysTotal: 0,
      maxStay: c.maxStay.watching,
      sector: input.sector || null,
      entryReason: input.entryReason || `板块${grade}档 + 评分${score}`,
      invalidIf: [{ id: 'W1', desc: '放量跌破MA20', metric: 'close', op: '<', ref: 'ma20' }],
      snapshots: [], note: '', score,
    };
    rows.push(entry);
    writeJsonl('pool.jsonl', rows);
    appendJsonl('transitions.jsonl', {
      schema: 1,
      id: transitionId(date || '', code, 'watching'),
      at: new Date().toISOString(), code, from: null, to: 'watching',
      trigger: 'entry', evidences: ev([['板块档位', grade], ['综合评分', score]]), reason: null,
    });
    return entry;
  });
}

/** 改备注 / 手工改状态；移出必须走 remove() 并带原因 */
function update(code, patch) {
  return serialize(() => {
    const rows = list();
    const e = rows.find((r) => String(r.code) === String(code));
    if (!e) throw new Error(`观察池无此标的：${code}`);
    if (patch.note !== undefined) e.note = String(patch.note);
    if (patch.state && patch.state !== 'removed') {
      if (!STATES.includes(patch.state)) throw new Error(`未知状态：${patch.state}`);
      const r = { nextState: patch.state, trigger: 'manual_state', evidences: ev([['操作', '手工调整'], ['原状态', e.state]]), reason: null };
      Object.assign(e, applyTransition(e, r, patch.date));
    }
    writeJsonl('pool.jsonl', rows);
    return e;
  });
}

/** 移出：reason 必填且必须是四选一；「错在哪」只在 wrong 时记录 */
function remove(code, reason, extra) {
  return serialize(() => {
    if (!REMOVE_REASONS.includes(reason)) {
      throw new Error('移出必须选择原因（logic_broken / too_slow / replaced / wrong）');
    }
    const rows = list();
    const e = rows.find((r) => String(r.code) === String(code));
    if (!e) throw new Error(`观察池无此标的：${code}`);
    const date = (extra && extra.date) || null;
    const chg = extra && extra.chg != null ? Number(extra.chg) : null;
    const r = {
      nextState: 'removed', trigger: 'manual_remove',
      evidences: ev([['移出原因', REASON_CN[reason]], ['移出时涨跌', chg == null ? '—' : chg]]),
      reason,
    };
    Object.assign(e, applyTransition(e, r, date));
    e.removeReason = reason;
    e.removeChg = chg;
    if (reason === 'wrong') e.wrongDetail = (extra && extra.wrongDetail) || '';
    writeJsonl('pool.jsonl', rows);
    return e;
  });
}

/** 每日推进：对全部非 removed 条目跑 evaluate，写 S8 日志、滚动快照 */
function advanceAll(ctx) {
  return serialize(() => {
    const rows = list();
    const out = [];
    let moved = 0;
    for (const e of rows) {
      if (e.state === 'removed') { out.push(e); continue; }
      // 每只标的必须用自己的 K 线；barsOf 缺失时宁可不判定，也不共用一根假数据
      const bars = typeof ctx.barsOf === 'function' ? ctx.barsOf(e.code) : ctx.bars;
      const one = Object.assign({}, ctx, {
        bars,
        sectorGrade: typeof ctx.sectorGradeOf === 'function' ? ctx.sectorGradeOf(e.sector) : ctx.sectorGrade,
      });
      const r = evaluate(e, one);
      const daysTotal = tradingDaysBetween(e.enteredAt, ctx.date, ctx.sessionDates);
      let next = e;
      if (r.trigger) {
        next = applyTransition(e, r, ctx.date);
        moved++;
        log.info('watchpool.transition', {
          code: e.code, from: e.state, to: r.nextState,
          trigger: r.trigger, reason: r.reason || null,
        });
      }
      next.daysInState = r.daysInState == null ? next.daysInState : r.daysInState;
      next.daysTotal = daysTotal == null ? next.daysTotal : daysTotal;
      next.maxStay = config.watchpool.maxStay[next.state] || next.maxStay;
      const ind = indicators(bars);
      if (ind && ind.close != null) {
        const snaps = (next.snapshots || []).slice();
        snaps.push({ date: ctx.date, close: ind.close, score: ctx.stockScore == null ? null : ctx.stockScore });
        next.snapshots = snaps.slice(-config.watchpool.snapshotLimit);
      }
      out.push(next);
    }
    writeJsonl('pool.jsonl', out);
    return { total: rows.length, active: out.filter((r) => r.state !== 'removed').length, moved };
  });
}

/**
 * 持仓风险扫描（docs/dev/06 §2.3 ⑤「风险」格）。
 *
 * 只报已发生的事实（破位 / 转弱 / 减仓），不做预判——所以这一格不设失效条件。
 * 拿不到 K 线的标的进 missing，**不用 0 或前值顶替**（D1）。
 *
 * @param {object} opt { date, barsOf? }
 * @returns {Promise<{date, holding, risky, items[], missing[], thresholds}>}
 */
/**
 * 纯函数：单只标的的风险判定（06 §2.3 ⑤）。
 * 只报已发生事实，不做预判；拿不到足够 K 线返回 null（不是「没风险」）。
 *
 * @param {Array<[date,open,close,high,low,volume,amount]>} bars 升序
 * @param {object} u 阈值 {breakMa, weakenMa, reduceChgPct}
 * @returns {{close, chgPct, hits: Array<{k,v,metric,value}>}|null}
 */
function riskOf(bars, u) {
  const ind = indicators(bars);
  if (!ind) return null;
  const rows = bars.slice();
  const n = rows.length;
  const prevClose = n >= 2 ? Number(rows[n - 2][2]) : null;
  const chgPct = prevClose && prevClose > 0 ? (ind.close / prevClose - 1) * 100 : null;

  const hits = [];
  if (ind.close < ind.ma20) {
    hits.push({ k: '破位', metric: 'close', value: ind.close, ref: ind.ma20, v: `收盘 ${fmt(ind.close)} < MA${u.breakMa} ${fmt(ind.ma20)}` });
  }
  if (ind.close < ind.ma10) {
    hits.push({ k: '转弱', metric: 'close', value: ind.close, ref: ind.ma10, v: `收盘 ${fmt(ind.close)} < MA${u.weakenMa} ${fmt(ind.ma10)}` });
  }
  if (chgPct != null && chgPct <= Number(u.reduceChgPct)) {
    hits.push({ k: '减仓', metric: 'chgPct', value: chgPct, ref: Number(u.reduceChgPct), v: `当日 ${fmt(chgPct)}% ≤ 阈值 ${fmt(u.reduceChgPct)}%` });
  }
  return { close: ind.close, chgPct, hits };
}

async function riskScan(opt) {
  opt = opt || {};
  const raw = Object.assign({ breakMa: 20, weakenMa: 10, reduceChgPct: -5 }, (config.ui || {}).risk || {});
  // 去掉 _note_* 说明键：只把真正参与判定的阈值给前端
  const u = {};
  Object.keys(raw).forEach((k) => { if (!k.startsWith('_')) u[k] = raw[k]; });
  const date = opt.date || null;
  const holdings = list().filter((e) => e.state === 'holding');
  if (!holdings.length) {
    return { date, holding: 0, risky: 0, items: [], missing: [], thresholds: u };
  }

  // K 线来源：优先调用方注入（cron 内已批量读过），否则现读上游只读库
  let barsOf = typeof opt.barsOf === 'function' ? opt.barsOf : null;
  if (!barsOf) {
    let map = {};
    try {
      // 延迟 require：保持本模块在单测里不依赖上游库。
      // 传 date 作 until：回补历史日时不许用之后的 K 线判风险（前视偏差）
      map = await require('./sources/adapters/local-db.js')
        .readMemberKlines(holdings.map((e) => e.code), 30, date);
    } catch (e) {
      log.warn('watchpool.risk_bars_failed', { error: e.message, count: holdings.length });
    }
    barsOf = (code) => map[String(code).replace(/^(sh|sz|bj)/, '')] || null;
  }

  const items = [];
  const missing = [];
  for (const e of holdings) {
    const r = riskOf(barsOf(e.code), u);
    if (!r) { missing.push(e.code); continue; }
    if (r.hits.length) {
      items.push({
        code: e.code, name: e.name || '', close: r.close, chgPct: r.chgPct, hits: r.hits,
        sector: e.sector || null, enteredAt: e.enteredAt || null,
      });
    }
  }
  return { date, holding: holdings.length, risky: items.length, items, missing, thresholds: u };
}

function fmt(v) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2);
}

/* 风险数量按日留痕（meta 表），供 ⑤ 格「昨日 → 今日」对比。
   写入方是 cron，所以走自有库 meta 而不是 JSONL（09 §7.2）。 */
const RISK_META_PREFIX = 'risk.';

async function saveRiskSnapshot(date, r) {
  if (!date) throw new Error('saveRiskSnapshot 需要 date');
  const store = require('./dao');
  const st = await store.open();
  await st.upsert('meta', [{
    k: RISK_META_PREFIX + String(date).slice(0, 10),
    v: { holding: r.holding, risky: r.risky, at: new Date().toISOString() },
  }]);
  return true;
}

/** 取 date 之前最近一条留痕；没有则返回 null（不猜、不拿 0 顶替） */
async function prevRisk(date, opt) {
  const store = require('./dao');
  const st = await store.open(opt || { readOnly: true });
  const rows = await st.query('meta', { order: 'k', desc: false, limit: 5000 });
  const keys = rows
    .map((r) => ({ k: String(r.k), v: r.v }))
    .filter((x) => x.k.startsWith(RISK_META_PREFIX))
    .map((x) => ({ date: x.k.slice(RISK_META_PREFIX.length), v: x.v }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const before = keys.filter((x) => x.date < String(date).slice(0, 10));
  return before.length ? before[before.length - 1] : null;
}

/** 清理超过保留期的已移出条目（默认 90 天） */
function prune(today) {
  return serialize(() => {
    const rows = list();
    const keepDays = config.watchpool.removedRetentionDays;
    const t = new Date(String(today));
    const kept = rows.filter((r) => {
      if (r.state !== 'removed' || !r.removedAt) return true;
      const d = new Date(String(r.removedAt));
      const diff = (t - d) / 86400000;
      return Number.isNaN(diff) || diff <= keepDays;
    });
    if (kept.length !== rows.length) writeJsonl('pool.jsonl', kept);
    return { removed: rows.length - kept.length };
  });
}

module.exports = {
  STATES, REMOVE_REASONS, REASON_CN,
  evaluate, indicators, tradingDaysBetween, riskOf, riskScan, saveRiskSnapshot, prevRisk,
  list, transitions, add, update, remove, advanceAll, prune,
};
