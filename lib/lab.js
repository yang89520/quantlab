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
  const bars = Math.max(60, Math.min(1200, Number(b.bars) || 300));
  let rows = [];
  let source = null;
  if (/^(sh|sz|bj)\d{6}$/.test(code)) {
    const r = await ds.resolve({ kind: 'kline-daily', code, bars });
    rows = r.rows || [];
    source = r.source;
  } else if (/^\d{6}$/.test(code)) {
    const k = await localdb.readMemberKlines([code], bars);
    rows = k[code] || [];
    source = 'local-aggregate';
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
    code, source, asOf: rows[rows.length - 1][0], bars: rows.length,
  });
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

/** 启动异步闸任务；立即返回 taskId */
function startGates(strategyId) {
  return createTask('gates', { strategyId }).then((task) => {
    setImmediate(async () => {
      try {
        await updateTask(task.id, { status: 'running', progress: 1 });
        const s = strategies.get(strategyId);
        if (!s) throw new Error(`策略不存在：${strategyId}`);
        let last = 1;
        const result = await computeGates(s, (p) => {
          if (p - last >= 5 || p === 100) {
            last = p;
            updateTask(task.id, { progress: p }).catch(() => {});
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
        await updateTask(task.id, { status: 'done', progress: 100, result });
        log.info('lab.gates_done', { taskId: task.id, strategyId, verdict: result.verdict });
      } catch (e) {
        await updateTask(task.id, { status: 'failed', error: e.message });
        log.error('lab.gates_failed', { taskId: task.id, error: e.message });
      }
    });
    return task.id;
  });
}

module.exports = {
  lines, scan, backtest, toOhlcv, sliceOhlcv, classifyPhases, pickUniverse,
  computeGates, startGates, createTask, getTask, updateTask,
};
