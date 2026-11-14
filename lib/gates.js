'use strict';
/**
 * 五道闸判定（docs/dev/05 §6）—— 纯函数为主，可离线单测。
 *
 * 三态铁律：pass 只能是 true / false / null；
 *   null = 无法检验，绝不等于通过。任一 false → unusable；有 null → doubtful。
 *
 * 第 1 道动态未来函数检测是整套系统可信度的地基：
 *   静态黑名单绕得过去（未来函数可以藏在中间变量里），
 *   但「加数据后历史信号变了」是未来函数的定义本身。
 */
const config = require('./config');
const log = require('./log');
const py = require('./pyrunner');

/** 只取信号序列，严格比对（布尔/0-1，容差 0） */
function signalsDiffer(s1, s2) {
  if (!Array.isArray(s1) || !Array.isArray(s2) || s1.length !== s2.length) return true;
  for (let i = 0; i < s1.length; i++) {
    const a = s1[i] ? 1 : 0;
    const b = s2[i] ? 1 : 0;
    if (a !== b) return true;
  }
  return false;
}

/**
 * 动态未来函数检测：前 M 根算 S1，前 M+K 根算 S2 截前 M 个，S1 !== S2 即存在未来函数。
 * @returns {Promise<{pass:boolean|null, reason:string|null, k:number, compared:number}>}
 */
async function detectFuture(formula, outputLine, ohlcv, opt) {
  const o = opt || {};
  const cfg = Object.assign({}, config.gates, o.config || {});
  const k = Number(cfg.dynamicK) || 20;
  const call = o.call || py.callPython;
  const dates = (ohlcv && ohlcv.datetime) || [];
  const m = dates.length - k;
  if (m < 30) {
    return { pass: null, reason: `数据不足（需 > ${30 + k} 根，实际 ${dates.length}）`, k, compared: 0 };
  }
  const slice = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
  const head = {};
  for (const key of ['datetime', 'open', 'high', 'low', 'close', 'vol', 'amount']) {
    head[key] = slice(ohlcv[key], m);
  }
  const req = (data) => ({ task: 'run', formula, outputLine, ohlcv: data });
  const r1 = await call(req(head), o.callOpt);
  const r2 = await call(req(ohlcv), o.callOpt);
  if (!r1.ok || !r2.ok) {
    return { pass: null, reason: r1.ok ? r2.error : r1.error, k, compared: 0 };
  }
  const s1 = r1.outputs && r1.outputs[outputLine];
  const s2all = r2.outputs && r2.outputs[outputLine];
  const s2 = Array.isArray(s2all) ? s2all.slice(0, m) : null;
  if (!Array.isArray(s1) || !Array.isArray(s2) || s1.length !== m) {
    return { pass: null, reason: '输出线序列长度异常，无法比对', k, compared: 0 };
  }
  return { pass: !signalsDiffer(s1, s2), reason: null, k, compared: m };
}

/** 第 2 道：样本内外衰减。is.ret<=0 直接不通过；oos 不足 100 根 → null */
function evalIsOos(isRet, oosRet, oosBars, cfg) {
  const c = cfg || config.gates;
  if (oosBars < c.oosMinBars) return { pass: null, decay: null, reason: `样本外不足 ${c.oosMinBars} 根` };
  if (isRet == null || oosRet == null) return { pass: null, decay: null, reason: '收益数据缺失' };
  if (isRet <= 0) return { pass: false, decay: null, reason: '样本内收益 <= 0' };
  const decay = (isRet - oosRet) / Math.abs(isRet);
  return { pass: decay <= c.maxDecay, decay: Number(decay.toFixed(4)), reason: null };
}

/** 第 3 道：普适性，随机抽 50 只（固定种子由 lab 层保证） */
function evalUniverse(tested, positive, cfg) {
  const c = cfg || config.gates;
  if (tested == null || tested < c.minUniverse) {
    return { pass: null, tested, positive, positiveRatio: null, reason: `有效标的不足 ${c.minUniverse} 只` };
  }
  const ratio = positive / tested;
  return {
    pass: ratio >= c.minPositiveRatio, tested, positive,
    positiveRatio: Number(ratio.toFixed(4)), reason: null,
  };
}

/** 第 4 道：牛熊震荡三段；某段样本 <60 日 → 整道闸 doubtful */
function evalPhase(phases, cfg) {
  const c = cfg || config.gates;
  const keys = ['bull', 'bear', 'range'];
  const out = {};
  let unknown = false;
  for (const k of keys) {
    const p = phases[k];
    if (!p || p.ret == null || p.days == null || p.days < c.phaseMinDays) {
      out[k] = null;
      unknown = true;
    } else {
      out[k] = Number(p.ret.toFixed(4));
    }
  }
  if (unknown) return { pass: null, phases: out, reason: '某段样本不足 60 日' };
  return { pass: keys.every((k) => out[k] >= c.minPhaseRet), phases: out, reason: null };
}

/** 第 5 道：双轨一致性。只有一版 → null（不是通过） */
function evalDual(hasBoth, agreeRate, cfg) {
  const c = cfg || config.gates;
  if (!hasBoth) return { pass: null, reason: '仅公式版，无双轨' };
  if (agreeRate == null) return { pass: null, reason: '一致率缺失' };
  return { pass: agreeRate >= c.dualAgreeRate, agreeRate: Number(agreeRate.toFixed(4)), reason: null };
}

/** 三档结论：任一 false → unusable；有 null → doubtful；否则 usable */
function verdictOf(gates) {
  const list = Object.values(gates || {});
  if (list.some((g) => g && g.pass === false)) return 'unusable';
  if (list.some((g) => g && g.pass === null)) return 'doubtful';
  return 'usable';
}

/**
 * 汇总五道闸（纯函数）。未来函数结果由 detectFuture/static scan 传入。
 * @param {object} input { futurePass, futureFindings, isRet, oosRet, oosBars,
 *                         tested, positive, phases, hasBoth, agreeRate, metrics }
 */
function aggregateGates(input, opt) {
  const i = input || {};
  const cfg = Object.assign({}, config.gates, (opt && opt.config) || {});
  const gates = {
    future: { pass: i.futurePass == null ? null : !!i.futurePass, findings: i.futureFindings || [] },
    isOos: evalIsOos(i.isRet, i.oosRet, i.oosBars, cfg),
    universe: evalUniverse(i.tested, i.positive, cfg),
    phase: evalPhase(i.phases || {}, cfg),
    dual: evalDual(!!i.hasBoth, i.agreeRate, cfg),
  };
  const verdict = verdictOf(gates);
  log.info('gates.aggregated', { verdict, passes: Object.keys(gates).map((k) => `${k}:${gates[k].pass}`).join(' ') });
  return { schema: 1, verdict, gates, metrics: i.metrics || null };
}

/** 策略自动降级：每 20 个交易日检查实盘 vs 回测（05 §7.3） */
function shouldDegrade(liveWinRate, backtestWinRate, cfg) {
  const c = cfg || config.gates;
  if (liveWinRate == null || backtestWinRate == null) return false;
  return liveWinRate < backtestWinRate - c.degradeGap;
}

module.exports = {
  signalsDiffer, detectFuture, evalIsOos, evalUniverse, evalPhase, evalDual,
  verdictOf, aggregateGates, shouldDegrade,
};
