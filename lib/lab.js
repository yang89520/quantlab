'use strict';
/**
 * 策略实验室编排（docs/dev/05 §5/§8）：公式解析、回测、五道闸异步任务。
 *
 * 五道闸跑 50 只标的 × 多段回测可能几分钟，必须异步（05 §8）。
 * 任务状态存 data/strategies/tasks.jsonl：pending|running|done|failed + progress。
 * 所有数据来自上游 market.db 只读 + 自有库，绝不造 K 线（D1）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const store = require('./dao');
const ds = require('./datasource');
const localdb = require('./sources/adapters/local-db');
const py = require('./pyrunner');
const gates = require('./gates');
const strategies = require('./strategy');
const Q = require('./quote');

const TF = () => path.join(config.__root, 'data', 'strategies', 'tasks.jsonl');
let queue = Promise.resolve();
function serialize(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}
function readTasks() {
  const p = TF();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}
function writeTasks(rows) {
  const p = TF();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}

let taskSeq = 0;
function createTask(kind, meta) {
  return serialize(() => {
    const rows = readTasks();
    const t = {
      schema: 1,
      // 确定性序号：任务 id 可复现；生产代码不引入随机数发生器
      id: `tk_${Date.now().toString(36)}_${(taskSeq++).toString(36)}`,
      kind, status: 'pending', progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: meta || {}, result: null, error: null,
    };
    rows.push(t);
    writeTasks(rows);
    return t;
  });
}
function updateTask(id, patch) {
  return serialize(() => {
    const rows = readTasks();
    const t = rows.find((x) => x.id === id);
    if (!t) throw new Error(`任务不存在：${id}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    writeTasks(rows);
    return t;
  });
}
function getTask(id) { return readTasks().find((x) => x.id === id) || null; }

/* ---------------- 公式能力 ---------------- */

async function lines(formula) {
  const r = await py.callPython({ task: 'lines', formula });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind, lines: [] };
  // 从公式源码里按「NAME:」取出每条输出线的真实表达式，不许编造
  const exprOf = {};
  for (const line of String(formula).split(/[;\n]/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m) exprOf[m[1].toUpperCase()] = line.trim();
  }
  const list = (r.lines || r.outputs || []).map((l) => {
    const name = typeof l === 'string' ? l : String(l.name || '');
    return { name, expr: exprOf[name.toUpperCase()] || '' };
  });
  return { ok: true, lines: list, error: null };
}

/** Python 用中文级别（高危/中危），前端契约用 high/medium/info，这里统一归一化 */
const isHigh = (l) => l === 'high' || l === '高危' || l === 'critical' || l === 'HIGH';
const isMed = (l) => l === 'medium' || l === '中危' || l === 'warning';

async function scan(formula) {
  const r = await py.callPython({ task: 'scan', formula });
  if (!r.ok) return { ok: false, error: r.error, findings: [], level: null };
  const findings = (r.findings || []).map((f) => ({
    level: isHigh(f.level) ? 'high' : (isMed(f.level) ? 'medium' : 'info'),
    name: f.func || f.name || '',
    desc: f.detail || f.desc || '',
    stmt: f.stmt || null,
    rawLevel: f.level,
  }));
  const level = (r.hasCritical === true || findings.some((f) => f.level === 'high')) ? 'high'
    : (findings.some((f) => f.level === 'medium') ? 'medium' : 'info');
  return { ok: true, findings, level, summary: r.summary || '', verdict: r.verdict || '' };
}

/** 单标的 K 线 → ohlcv dict */
function toOhlcv(rows) {
  return {
    datetime: rows.map((r) => String(r[0]).slice(0, 10)),
    open: rows.map((r) => Number(r[1])),
    close: rows.map((r) => Number(r[2])),
    high: rows.map((r) => Number(r[3])),
    low: rows.map((r) => Number(r[4])),
    vol: rows.map((r) => Number(r[5])),
    amount: rows.map((r) => Number(r[6])),
  };
}
function sliceOhlcv(o, from, to) {
  const out = {};
  for (const k of Object.keys(o)) out[k] = o[k].slice(from, to === undefined ? undefined : to);
  return out;
}
function sliceByDates(o, dateSet) {
  const keep = [];
  for (let i = 0; i < o.datetime.length; i++) if (dateSet.has(o.datetime[i])) keep.push(i);
  const out = {};
  for (const k of Object.keys(o)) out[k] = keep.map((i) => o[k][i]);
  return out;
}

/** 单次回测 */
async function backtest(req) {
  const b = req || {};
  if (!b.formula || !b.outputLine) throw new Error('formula 与 outputLine 必填');
  const code = String(b.code || 'sh000001');
  // 周期：日线走多源降级链（ds.resolve），周/月线走 Q.klines 的聚合缓存。
  // 月线策略（如「月线三重底」）必须按月线回测 —— 拿日线跑月线参数，
  // MA60 就变成 60 天而不是 60 个月，结论会完全反过来。
  const period = b.period === 'week' ? 'week' : (b.period === 'month' ? 'month' : 'day');
  const barsMax = period === 'day' ? 1200 : 200;
  const bars = Math.max(60, Math.min(barsMax, Number(b.bars) || (period === 'day' ? 300 : 130)));
  let rows = [];
  let source = null;
  if (period !== 'day') {
    const it = Q.normalize(code);
    if (!it) throw new Error(`代码格式不正确：${code}`);
    const r = await Q.klines(it.symbol || it.key, bars, period);
    rows = r.rows || [];
    source = r.source || 'network';
  } else if (/^(sh|sz|bj)\d{6}$/.test(code)) {
    const r = await ds.resolve({ kind: 'kline-daily', code, bars });
    rows = r.rows || [];
    source = r.source;
  } else if (/^\d{6}$/.test(code)) {
    /* B2：6 位纯数字代码原本只查本地市场库，而本地库未配置时
     * readMemberKlines 是**抛错**（"上游行情库未配置或不存在"）而不是返回空，
     * 于是一个合法的回测请求直接 500。
     * 这里改成：本地库拿不到（抛错或为空）就回退到多源网络解析 ——
     * 在用户眼里 600986 与 sh600986 是同一只票，少个前缀不该失败。 */
    try {
      const k = await localdb.readMemberKlines([code], bars);
      rows = k[code] || [];
      source = 'local-aggregate';
    } catch (e) {
      log.warn('lab.backtest.local_miss', { code, error: e.message });
      rows = [];
    }
    if (rows.length < 30) {
      // 注意用 symbol 而不是 key：个股的 key 是裸 6 位，ds.resolve 要求 sh600986 形式
      const it = Q.normalize(code);
      const target = it && (it.symbol || it.key);
      if (target) {
        const r = await ds.resolve({ kind: 'kline-daily', code: target, bars });
        if (r && Array.isArray(r.rows) && r.rows.length >= rows.length) {
          rows = r.rows;
          source = r.source || 'network';
        }
      }
    }
  }
  if (rows.length < 30) {
    return { ok: false, error: `K 线不足 30 根（实际 ${rows.length}）`, kind: 'data' };
  }
  const r = await py.callPython({
    task: 'run', formula: b.formula, outputLine: b.outputLine,
    ohlcv: toOhlcv(rows), params: b.params || {},
  });
  if (!r.ok) return r;
  return Object.assign({}, r, {
    code, period, source, asOf: rows[rows.length - 1][0], bars: rows.length,
  });
}

/* ---------------- 每日信号扫描（05 §7.1） ---------------- */

/**
 * 对单个 active 策略跑当日全市场扫描，返回目标交易日的命中信号。
 *
 * 05 §7.1 的性能约束：全市场 5342 只 × N 个策略不可接受。这里的预筛分两级：
 *   ① 取当日快照成交额前 `signals.pool` 只（真实快照，不造数据）
 *   ② 形态层预筛：`params.prefilter.aboveMa20 !== false` 时要求收盘站上 MA20（本地算，零 Python 成本）
 * 只有两级都通过的标的才进 Python 回测，`scanned` 记录实际回测数量，便于发现预筛过严。
 *
 * @param {object} strategy S9 条目
 * @param {object} opt { date, onProgress }
 * @returns {Promise<{date, strategyId, scanned, candidates, hitCount, signals[], skipped[], missing}>}
 */
async function scanSignals(strategy, opt) {
  opt = opt || {};
  const c = config.signals || {};
  if (!strategy || !strategy.source) throw new Error('scanSignals 需要策略源码');
  if (strategy.type && strategy.type !== 'formula') {
    throw new Error(`暂只支持 formula 策略扫描（实际 type=${strategy.type}）`);
  }

  const date = opt.date ? String(opt.date).slice(0, 10) : (await ds.latestTradingDay()).date;
  const barsN = Math.max(60, Number(c.bars) || 250);
  const minBars = Math.max(30, Number(c.minBars) || 60);
  const poolN = Math.max(1, Number(c.pool) || 200);

  // ① 当日快照成交额前 N（上游没有当日快照，快照由 daily-close 落库，这里只读自有库）
  const st = await store.open({ readOnly: true });
  const snap = await st.query('snapshot', { where: { date }, order: 'amount', desc: true, limit: poolN });
  const universe = snap
    .filter((r) => /^\d{6}$/.test(String(r.code)) && Number(r.amount) > 0)
    .map((r) => String(r.code));
  if (!universe.length) {
    return {
      date, strategyId: strategy.id, scanned: 0, candidates: 0,
      hitCount: 0, signals: [], skipped: [], missing: ['snapshot'],
    };
  }

  // 读本地日线（只读上游库）；拿不到的标的进 missing，不当成「没信号」。
  // until=date：回补历史日时必须截到当日，否则信号是用「未来」K 线算出来的（前视偏差）
  let klines = {};
  try {
    klines = await localdb.readMemberKlines(universe, barsN, date);
  } catch (e) {
    log.warn('lab.signals_klines_failed', { error: e.message });
    return {
      date, strategyId: strategy.id, scanned: 0, candidates: 0,
      hitCount: 0, signals: [], skipped: [], missing: ['kline'],
    };
  }

  // ② 形态层预筛
  const pre = (strategy.params && strategy.params.prefilter) || {};
  const needAboveMa20 = pre.aboveMa20 !== false;
  const candidates = [];
  const missing = [];
  for (const code of universe) {
    const rows = klines[code];
    if (!rows || rows.length < minBars) { missing.push(code); continue; }
    if (needAboveMa20) {
      const close = Number(rows[rows.length - 1][2]);
      const ma20 = rows.slice(-20).reduce((a, r) => a + Number(r[2]), 0) / Math.min(20, rows.length);
      if (!Number.isFinite(close) || !Number.isFinite(ma20) || close <= ma20) continue;
    }
    candidates.push({ code, rows });
  }

  // ③ 逐只回测，只取目标交易日的信号
  const hits = [];
  const skipped = [];
  let scanned = 0;
  for (const one of candidates) {
    scanned++;
    const r = await py.callPython({
      task: 'run',
      formula: strategy.source,
      outputLine: strategy.outputLine,
      ohlcv: toOhlcv(one.rows),
      params: strategy.params || {},
    });
    if (!r.ok) {
      skipped.push({ code: one.code, error: r.error || 'python_failed' });
      continue;
    }
    for (const s of (r.signals || [])) {
      if (String(s.date).slice(0, 10) !== date) continue;
      hits.push({
        code: one.code,
        action: s.action || 'buy',
        price: Number(s.price),
        strategyId: strategy.id,
        version: strategy.version,
      });
    }
    if (typeof opt.onProgress === 'function') {
      opt.onProgress(Math.round((scanned / candidates.length) * 100));
    }
  }

  log.info('lab.signals_done', {
    date, strategyId: strategy.id, universe: universe.length,
    candidates: candidates.length, scanned, hits: hits.length, skipped: skipped.length,
  });
  return {
    date, strategyId: strategy.id, scanned, candidates: candidates.length,
    hitCount: hits.length, signals: hits, skipped, missing,
    prefilter: { pool: poolN, aboveMa20: needAboveMa20, minBars },
  };
}

/* ---------------- 五道闸真实取数 ---------------- */

/** 固定种子伪随机（LCG），保证可复现；从当日成交额前 200 只里抽 50 只 */
function seededPick(arr, n, seed) {
  const a = arr.slice();
  let s = Number(seed) >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a.slice(0, n);
}

async function pickUniverse() {
  const c = config.gates;
  let codes = [];
  try {
    const st = await store.open({ readOnly: true });
    const rows = await st.query('snapshot', { order: 'amount', desc: true, limit: c.universePool });
    codes = rows.filter((r) => /^\d{6}$/.test(String(r.code)) && Number(r.amount) > 0)
      .map((r) => String(r.code));
  } catch (e) {
    log.warn('lab.universe_snapshot_failed', { error: e.message });
  }
  if (!codes.length) return { pool: [], source: null };
  const picked = seededPick(codes, c.universeSample, c.sampleSeed);
  let klines = {};
  // 400 根：样本外占 30% = 120 根，满足五道闸第 2 道 oosMinBars=100 的最低要求
  try { klines = await localdb.readMemberKlines(picked, 400); }
  catch (e) { log.warn('lab.universe_klines_failed', { error: e.message }); }
  const pool = [];
  for (const code of picked) {
    const rows = klines[code];
    if (rows && rows.length >= 60) pool.push({ code, ohlcv: toOhlcv(rows) });
  }
  return { pool, source: 'market-db' };
}

/** 指数按 250 日涨幅标注牛/熊/震荡（固定区间，不许按回测结果反挑） */
function classifyPhases(rows) {
  const c = config.gates;
  const out = { bull: new Set(), bear: new Set(), range: new Set() };
  const close = rows.map((r) => Number(r[2]));
  for (let i = c.phaseLookback; i < close.length; i++) {
    const prev = close[i - c.phaseLookback];
    if (!prev) continue;
    const ret = close[i] / prev - 1;
    const d = String(rows[i][0]).slice(0, 10);
    if (ret > c.phaseBull) out.bull.add(d);
    else if (ret < c.phaseBear) out.bear.add(d);
    else out.range.add(d);
  }
  return out;
}

async function retOf(ohlcv, formula, outputLine) {
  if (!ohlcv || !ohlcv.datetime || ohlcv.datetime.length < 30) return null;
  const r = await py.callPython({ task: 'run', formula, outputLine, ohlcv });
  return r.ok && r.metrics && Number.isFinite(r.metrics.ret) ? r.metrics.ret : null;
}

/**
 * 真实跑五道闸；progress 回调用于任务进度。
 * 数据不足的闸一律 pass=null（无法检验），绝不填 0 或 true。
 */
async function computeGates(strategy, onProgress) {
  const c = config.gates;
  const formula = strategy.source;
  const outputLine = strategy.outputLine;
  const tick = (p) => { if (typeof onProgress === 'function') onProgress(p); };

  const scanResult = await scan(formula);
  const findings = scanResult.findings || [];
  tick(10);

  const { pool } = await pickUniverse();
  if (!pool.length) {
    return gates.aggregateGates({
      futurePass: scanResult.level === 'high' ? false : null,
      futureFindings: findings,
      metrics: null,
    });
  }
  const dyn = await gates.detectFuture(formula, outputLine, pool[0].ohlcv);
  const futurePass = scanResult.level === 'high' ? false : dyn.pass;
  tick(25);

  // 第 2 道：样本内外
  const total = pool[0].ohlcv.datetime.length;
  const split = Math.round(total * c.split);
  const isRet = await retOf(sliceOhlcv(pool[0].ohlcv, 0, split), formula, outputLine);
  const oosRet = await retOf(sliceOhlcv(pool[0].ohlcv, split), formula, outputLine);
  const oosBars = total - split;
  tick(40);

  // 第 3 道：普适性，逐只真实回测
  let tested = 0, positive = 0;
  for (let i = 0; i < pool.length; i++) {
    const ret = await retOf(pool[i].ohlcv, formula, outputLine);
    if (ret != null) { tested++; if (ret > 0) positive++; }
    if (i % 10 === 0) tick(40 + Math.round((i / pool.length) * (75 - 40)));
  }
  tick(78);

  // 第 4 道：牛熊震荡三段，每段用前 5 只样本在该区间真实回测
  let phases = {};
  try {
    const idx = await ds.resolve({ kind: 'kline-daily', code: 'sh000001', bars: 1200 });
    const seg = classifyPhases(idx.rows || []);
    for (const k of ['bull', 'bear', 'range']) {
      const rets = [];
      for (const p of pool.slice(0, 5)) {
        const sub = sliceByDates(p.ohlcv, seg[k]);
        if (sub.datetime.length < 30) continue;
        const ret = await retOf(sub, formula, outputLine);
        if (ret != null) rets.push(ret);
      }
      phases[k] = {
        ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
        days: seg[k].size,
      };
    }
  } catch (e) {
    log.warn('lab.phase_unavailable', { error: e.message });
    phases = {};
  }
  tick(95);

  // 第 5 道：本期只提供公式版，无 Python 版策略 → 显式 null（不是通过）
  const result = gates.aggregateGates({
    futurePass, futureFindings: findings,
    isRet, oosRet, oosBars,
    tested, positive, phases,
    hasBoth: false, agreeRate: null,
    metrics: {
      universeTested: tested, universePositive: positive,
      oosBars, dynamicCompared: dyn.compared, dynamicK: dyn.k,
      universeSource: 'market-db',
    },
  });
  tick(100);
  return result;
}

/* ---------------- 异步闸任务的并发控制与重试（05 §8） ----------------
 * 决策（文档未规定，这里定下来并写进 05 §8）：
 *  · 并发上限默认 1（五道闸要跑 50 只 × 4 道，CPU/Python 子进程都吃满，并发只会互相拖慢）
 *    —— 超出上限的任务保持 `pending` 排队，progress=0，并在 meta 里记录排队位置
 *  · 失败重试 1 次（只重试一次：超时/子进程崩溃这类瞬时故障重试有意义，重复失败会浪费十几分钟）
 *  · 进度写盘失败不能静默吞掉（上线检查表第 2 项），必须 log.warn
 */
let runningGates = 0;
const gateQueue = [];

function maxConcurrentGates() {
  const n = Number(config.gates && config.gates.maxConcurrent);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function pumpGates() {
  while (runningGates < maxConcurrentGates() && gateQueue.length) {
    const taskId = gateQueue.shift();
    runningGates++;
    runGatesTask(taskId)
      .catch((e) => log.error('lab.gates_task_crashed', { taskId, error: e.message }))
      .finally(() => { runningGates--; pumpGates(); });
  }
}

async function runGatesTask(taskId) {
  const task = getTask(taskId);
  const strategyId = task && task.meta ? task.meta.strategyId : null;
  const attempt = (task && task.meta && Number(task.meta.attempt)) || 1;
  try {
    await updateTask(taskId, { status: 'running', progress: 1 });
    const s = strategies.get(strategyId);
    if (!s) throw new Error(`策略不存在：${strategyId}`);
    let last = 1;
    const result = await computeGates(s, (p) => {
      if (p - last >= 5 || p === 100) {
        last = p;
        updateTask(taskId, { progress: p }).catch((e) => {
          log.warn('lab.task_progress_failed', { taskId, progress: p, error: e.message });
        });
      }
    });
    // 验证档案落自有库（02 S10），供策略列表展示最近一次结论
    const st = await store.open();
    await st.upsert('strategy_gate', [{
      strategy_id: s.id,
      version: s.version,
      date: new Date().toISOString().slice(0, 10),
      verdict: result.verdict,
      payload: result,
    }]);
    await updateTask(taskId, { status: 'done', progress: 100, result });
    log.info('lab.gates_done', { taskId, strategyId, verdict: result.verdict, attempt });
  } catch (e) {
    if (attempt < 2) {
      log.warn('lab.gates_retry', { taskId, strategyId, attempt, error: e.message });
      await updateTask(taskId, {
        status: 'pending', progress: 0, error: e.message,
        meta: Object.assign({}, (task && task.meta) || {}, { strategyId, attempt: attempt + 1 }),
      });
      gateQueue.unshift(taskId);          // 重试插队，不排到队尾
      return;
    }
    await updateTask(taskId, { status: 'failed', error: e.message });
    log.error('lab.gates_failed', { taskId, strategyId, attempt, error: e.message });
  }
}

/** 启动异步闸任务；立即返回 taskId（超出并发上限时排队，状态为 pending） */
function startGates(strategyId) {
  return createTask('gates', { strategyId, attempt: 1 }).then((task) => {
    gateQueue.push(task.id);
    log.info('lab.gates_queued', { taskId: task.id, strategyId, queued: gateQueue.length, running: runningGates });
    setImmediate(pumpGates);
    return task.id;
  });
}

/** 队列状态，供 /api/health 观测「是不是卡住了」 */
function gatesQueue() {
  return { running: runningGates, queued: gateQueue.length, max: maxConcurrentGates() };
}

module.exports = {
  lines, scan, backtest, toOhlcv, sliceOhlcv, scanSignals,
  classifyPhases, pickUniverse,
  computeGates, startGates, gatesQueue, createTask, getTask, updateTask,
};
