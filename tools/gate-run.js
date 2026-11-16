'use strict';
/**
 * 跑五道闸（docs/dev/05 §6，交付物 README §8 的 `tools/gate-run.js`）。
 *
 * 网页里的「跑五道闸」走异步任务队列（lib/lab.startGates），适合不阻塞 UI；
 * 但机器上要批量跑、或在 CI 里做上线前核验时，队列没有意义 —— 这里给一个
 * 同步 CLI，跑完直接落 S10（strategy_gate）并打印三档结论。
 *
 * 用法：
 *   node tools/gate-run.js --list                      列出策略与最近一次闸结论
 *   node tools/gate-run.js --strategy st_mwggh5rw      跑指定策略
 *   node tools/gate-run.js --all                       跑全部 active/suspect 策略
 *   node tools/gate-run.js --all --include-draft       连 draft 一起跑
 *
 * 退出码：0 全部跑完；1 有策略失败；2 参数错误。
 * `unusable` 不算失败——那是闸给出的正常结论，不是程序故障（G3：区分「跑挂了」与「结论是不合格」）。
 */
const store = require('../lib/dao');
const log = require('../lib/log');
const lab = require('../lib/lab');
const strategies = require('../lib/strategy');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (n) => process.argv.includes('--' + n);

const GATE_CN = {
  future: '① 未来函数',
  isOos: '② 样本内外',
  universe: '③ 普适性',
  phase: '④ 牛熊分段',
  dual: '⑤ 双轨一致',
};
const VERDICT_CN = { usable: '可用', doubtful: '存疑', unusable: '不可用' };

/** 三态符号固定：✓ 通过 / ✗ 不通过 / ! 无法检验（null 绝不等于通过） */
function mark(pass) {
  if (pass === true) return '✓ 通过';
  if (pass === false) return '✗ 不通过';
  return '! 无法检验';
}

function gateDetail(key, g) {
  if (!g) return '—';
  const r = g.reason ? `（${g.reason}）` : '';
  switch (key) {
    case 'isOos':
      return g.decay == null ? r || '—' : `衰减 ${(g.decay * 100).toFixed(0)}%${r}`;
    case 'universe':
      return g.positiveRatio == null ? r || '—'
        : `${g.positive}/${g.tested} 只正收益（${(g.positiveRatio * 100).toFixed(0)}%）${r}`;
    case 'phase':
      return g.phases
        ? `牛 ${pct(g.phases.bull)} / 熊 ${pct(g.phases.bear)} / 震荡 ${pct(g.phases.range)}${r}`
        : r || '—';
    case 'dual':
      return g.agreeRate == null ? r || '—' : `一致率 ${(g.agreeRate * 100).toFixed(0)}%${r}`;
    case 'future':
      return g.findings && g.findings.length ? `${g.findings.length} 处可疑` : (r || '未检测到');
    default:
      return r || '—';
  }
}

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

async function listStrategies() {
  const all = strategies.list();
  const st = await store.open({ readOnly: true });
  const gr = await st.query('strategy_gate', { order: 'date', desc: true, limit: 1000 });
  const last = new Map();
  for (const g of gr) {
    const k = `${g.strategy_id}@${g.version}`;
    if (!last.has(k)) last.set(k, g);
  }
  console.log(`策略共 ${all.length} 个`);
  console.log('  ID              状态      版本  最近闸结论');
  for (const s of all) {
    const g = last.get(`${s.id}@${s.version}`);
    console.log(`  ${String(s.id).padEnd(15)} ${String(s.status).padEnd(8)} v${String(s.version).padEnd(3)}`
      + ` ${g ? `${VERDICT_CN[g.verdict] || g.verdict}（${g.date}）` : '未跑过'}`);
  }
}

async function runOne(s) {
  console.log(`\n=== ${s.name || s.id}（${s.id} v${s.version}，状态 ${s.status}）===`);
  const t0 = Date.now();
  const result = await lab.computeGates(s, (p) => {
    if (p % 25 === 0 || p === 100) process.stderr.write(`  … ${p}%\r`);
  });
  process.stderr.write('              \r');

  for (const key of Object.keys(GATE_CN)) {
    const g = result.gates[key];
    console.log(`  ${GATE_CN[key].padEnd(12)} ${mark(g && g.pass).padEnd(8)} ${gateDetail(key, g)}`);
  }
  console.log(`  结论：${VERDICT_CN[result.verdict] || result.verdict}｜耗时 ${Date.now() - t0}ms`);

  await store.open().then((db) => db.upsert('strategy_gate', [{
    strategy_id: s.id,
    version: s.version,
    date: new Date().toISOString().slice(0, 10),
    verdict: result.verdict,
    payload: result,
  }]));
  log.info('gate-run.done', { id: s.id, verdict: result.verdict, ms: Date.now() - t0 });
  return result;
}

async function main() {
  const t0 = Date.now();
  log.info('gate-run.start', { argv: process.argv.slice(2) });

  if (has('list')) {
    await listStrategies();
    log.info('gate-run.done', { mode: 'list', ms: Date.now() - t0 });
    return;
  }

  const id = typeof arg('strategy') === 'string' ? arg('strategy') : null;
  let targets;
  if (id) {
    const s = strategies.get(id);
    if (!s) throw Object.assign(new Error(`策略不存在：${id}`), { exit: 2 });
    targets = [s];
  } else if (has('all')) {
    const want = new Set(['active', 'suspect']);
    if (has('include-draft')) want.add('draft');
    targets = strategies.list().filter((s) => want.has(s.status));
  } else {
    throw Object.assign(new Error('需要 --strategy <id> 或 --all（--list 可看清单）'), { exit: 2 });
  }

  if (!targets.length) {
    console.log('没有需要跑闸的策略。');
    return;
  }

  let failed = 0;
  for (const s of targets) {
    try {
      await runOne(s);
    } catch (e) {
      failed++;
      log.error('gate-run.failed', { id: s.id, error: e.message, stack: e.stack });
      console.error(`  ✗ ${s.id} 跑闸失败：${e.message}`);
    }
  }
  console.log(`\n共 ${targets.length} 个策略，成功 ${targets.length - failed}、失败 ${failed}`);
  log.info('gate-run.done', { total: targets.length, failed, ms: Date.now() - t0 });
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  log.error('gate-run.failed', { error: e.message, stack: e.stack });
  console.error('失败：' + e.message);
  process.exitCode = e.exit || 1;
});
