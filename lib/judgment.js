'use strict';
/**
 * 命中率统计（判断力画像）
 *
 * 硬规则（docs/dev/03 §3.5）：
 *  - 分母永远是**有效对账日数**，不是预判卡总数（skipped 必须排除）
 *  - 样本 < minSampleDays 时 sufficient=false，报告首行必须提示
 *  - 分状态统计永远同时输出 n
 *  - 无法计算用 null，**不许填 0**——0 和「没有数据」是两件事
 */
const store = require('./dao');
const config = require('./config');

function rate(hit, total) {
  return total > 0 ? Number((hit / total).toFixed(4)) : null;
}

/**
 * @param {object} opt { from, to } 日期区间（含端点）
 */
async function stats(opt) {
  opt = opt || {};
  const cfg = config;
  const st = await store.open();

  const where = {};
  const preds = await st.query('prediction', { order: 'date', desc: true, limit: 400 });
  const recs = await st.query('reconcile', { order: 'date', desc: true, limit: 400 });

  const recByDate = new Map(recs.map((r) => [r.date, r]));

  const inRange = (d) =>
    (!opt.from || d >= opt.from) && (!opt.to || d <= opt.to);

  let totalDays = 0;       // 有效对账日数
  let envHit = 0;
  let candSum = 0, candN = 0;
  let scoreSum = 0, scoreN = 0;
  const byState = new Map();     // verdict -> { n, hit }
  const byAttr = { hit: 0, env: 0, candidate: 0, timing: 0 };
  const hits = [];               // 近 N 日命中序列

  for (const p of preds) {
    if (!inRange(p.date)) continue;
    const r = recByDate.get(p.date);
    if (!r || r.skipped) continue;   // skipped 不进分母
    totalDays++;
    if (r.env_hit) envHit++;
    if (r.cand_hit_ratio !== null && r.cand_hit_ratio !== undefined) {
      candSum += r.cand_hit_ratio; candN++;
    }
    if (r.judgment_score !== null && r.judgment_score !== undefined) {
      scoreSum += r.judgment_score; scoreN++;
    }
    const v = p.verdict;
    if (!byState.has(v)) byState.set(v, { n: 0, hit: 0 });
    const bs = byState.get(v);
    bs.n++; if (r.env_hit) bs.hit++;
    if (r.attribution && byAttr[r.attribution] !== undefined) byAttr[r.attribution]++;
    if (hits.length < 5) hits.push(r.env_hit ? 1 : 0);
  }

  const sufficient = totalDays >= cfg.judgment.minSampleDays;
  const byStateOut = {};
  for (const [k, v] of byState) {
    byStateOut[k] = {
      n: v.n,
      envHitRate: rate(v.hit, v.n),
      note: v.n < cfg.judgment.minStateSample ? '样本过少' : undefined,
    };
  }

  return {
    sampleDays: totalDays,
    sufficient,
    envHitRate: rate(envHit, totalDays),
    candHitRate: candN ? Number((candSum / candN).toFixed(4)) : null,
    avgJudgmentScore: scoreN ? Number((scoreSum / scoreN).toFixed(1)) : null,
    byState: byStateOut,
    byAttribution: byAttr,
    recent: hits.map((h) => (h ? 'hit' : 'miss')),
    note: sufficient
      ? `样本 ${totalDays} 天，可作初步参考`
      : `样本不足 ${cfg.judgment.minSampleDays} 天，比率不构成结论`,
  };
}

/** 人读报告 */
function report(s) {
  const pct = (v) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
  const lines = [];
  lines.push('='.repeat(52));
  lines.push('判断力报告');
  lines.push('='.repeat(52));
  if (!s.sufficient) lines.push(`⚠ ${s.note}`);
  lines.push(`有效对账日数：${s.sampleDays} 天（skipped 已排除）`);
  lines.push(`环境命中率：${pct(s.envHitRate)}`);
  lines.push(`候选命中率：${pct(s.candHitRate)}`);
  lines.push(`平均判断得分：${s.avgJudgmentScore === null ? '—' : s.avgJudgmentScore}`);
  lines.push('');
  lines.push('分状态：');
  const CND = { attack: '进攻', wait: '观望', defend: '防守' };
  for (const [k, v] of Object.entries(s.byState)) {
    lines.push(`  ${CND[k] || k}  n=${v.n}  命中 ${pct(v.envHitRate)}${v.note ? '  (' + v.note + ')' : ''}`);
  }
  lines.push('');
  lines.push('错因分布：');
  lines.push(`  判断正确 ${s.byAttribution.hit} · 环境错 ${s.byAttribution.env} · 标的错 ${s.byAttribution.candidate} · 时机错 ${s.byAttribution.timing}`);
  lines.push('');
  lines.push(`近 5 日：${s.recent.map((x) => (x === 'hit' ? '✓' : '✗')).join(' ') || '—'}`);
  lines.push('='.repeat(52));
  return lines.join('\n');
}

module.exports = { stats, report };
