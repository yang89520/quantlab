'use strict';
/**
 * L4 变异验证（docs/dev/07 §3.3 / §1）。
 *
 * 每条变异在**独立临时副本**上改坏一处代码，然后跑它声明应该打中的用例：
 *   · 一条都没红  → 报「断言缺口」，本次验证失败
 *   · 红了的用例超出声明范围 → 报「断言粒度过粗」（提示，不判失败）
 *   · 目标字符串找不到 → 报「变异目标失效」，提示更新清单
 *
 * 不污染工作区：只复制 lib/ + tests/ + 配置，node_modules 用软链。
 * 运行：npm run test:mutate
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const MUTATIONS = [
  /* ---------------- 一期 6 条（07 §4.1） ---------------- */
  {
    name: '归因删掉 env 分支', file: 'lib/reconcile.js', phase: '一期',
    from: "  if (!envHit) return 'env';", to: '',
    expectFail: ['unit/phase1.test.js', 'integration/reconcile.test.js'],
    expectRed: ['环境错 → env（不管选股多好）'],
  },
  {
    name: '涨停阈值统一 9.8（漏掉双创 20%）', file: 'lib/snapshot.js', phase: '一期',
    from: '  if (/^(300|301|688|689)/.test(c)) return v >= 19.7;',
    to: '  if (/^(300|301|688|689)/.test(c)) return v >= 9.8;',
    expectFail: ['unit/phase1.test.js'],
    expectRed: ['创业板 10.5% 不是涨停'],
  },
  {
    name: '全强环境改成 wait', file: 'lib/predict.js', phase: '一期',
    from: "  if (score >= th.attack) verdict = 'attack';",
    to: "  if (score >= th.attack) verdict = 'wait';",
    expectFail: ['unit/phase1.test.js'],
    expectRed: ['全强：上行 + 宽带 + 放量'],
  },
  {
    name: 'confidence 编一个 0.5', file: 'lib/predict.js', phase: '一期',
    from: '    confidence: null,          // 一期不估计置信度，明说没有',
    to: '    confidence: 0.5,',
    expectFail: ['unit/phase1.test.js'],
    expectRed: ['confidence 必须是 null'],
  },
  {
    name: '归因删掉 timing 分支', file: 'lib/reconcile.js', phase: '一期',
    from: "  if (hasSpikeFade) return 'timing';", to: '',
    expectFail: ['unit/phase1.test.js'],
    expectRed: ['冲高回落 → timing'],
  },
  {
    name: '归因删掉 candidate 分支', file: 'lib/reconcile.js', phase: '一期',
    from: '  if (candHitRatio < minHit) return \'candidate\';', to: '',
    expectFail: ['unit/phase1.test.js', 'integration/reconcile.test.js'],
    expectRed: ['环境对 + 候选差 → candidate'],
  },

  /* ---------------- 二期 5 条（07 §4.2 / 04 §7.3） ---------------- */
  {
    name: 'direction 判定挪到 candidate 之后（删掉该分支）', file: 'lib/reconcile.js', phase: '二期',
    from: "  if (directionHit === false) return 'direction';", to: '',
    expectFail: ['integration/phase2-direction.test.js', 'unit/phase2.test.js'],
    expectRed: ['direction 优先于 candidate'],
  },
  {
    name: '删掉 degraded 标记', file: 'lib/sector.js', phase: '二期',
    from: "      degrade.push('net_inflow_missing');", to: '',
    expectFail: ['unit/phase2.test.js'],
    expectRed: ['净流入缺失 → degraded=true'],
  },
  {
    name: '状态机允许跳档', file: 'lib/watchpool.js', phase: '二期',
    from: "      return advance('ambush', 'shrink_pullback_ma20', [",
    to: "      return advance('confirmed', 'shrink_pullback_ma20', [",
    expectFail: ['unit/phase2.test.js'],
    expectRed: ['watching→ambush'],
  },
  {
    name: '超期不处理', file: 'lib/watchpool.js', phase: '二期',
    from: '  if (stay != null && maxStay != null && stay > maxStay) {',
    to: '  if (false) {',
    expectFail: ['unit/phase2.test.js'],
    expectRed: ['超期：daysInState=11'],
  },
  {
    name: '行业/概念混排算分位', file: 'lib/sector.js', phase: '二期',
    from: '    const mixList = groupMix.get(t);',
    to: '    const mixList = all.map(mixOf);',
    expectFail: ['unit/phase2.test.js'],
    expectRed: ['行业榜与概念榜分开算分位'],
  },

  /* ---------------- 三期 5 条（05 §9.5） ---------------- */
  {
    name: '去掉动态检测只留静态', file: 'lib/gates.js', phase: '三期',
    from: '  return { pass: !signalsDiffer(s1, s2), reason: null, k, compared: m };',
    to: '  return { pass: true, reason: null, k, compared: m };',
    expectFail: ['unit/phase3.test.js'],
    expectRed: ['detectFuture：加数据后历史信号变了'],
  },
  {
    name: 'INTPART 用 round 而不是截断', file: 'py/tdx_engine/functions.py', phase: '三期',
    from: '    return np.trunc(_f(interp.arg(args, 0)))',
    to: '    return np.round(_f(interp.arg(args, 0)))',
    expectFail: ['PY_SELFTEST'],
    expectRed: ['INTPART(-1.7) == -1'],
  },
  {
    name: 'null 当 true（三态塌成两态）', file: 'lib/gates.js', phase: '三期',
    from: "  if (list.some((g) => g && g.pass === null)) return 'doubtful';",
    to: '',
    expectFail: ['unit/phase3.test.js'],
    expectRed: ['null 绝不等于通过'],
  },
  {
    name: 'stdout 读第一行而非最后一行', file: 'lib/pyrunner.js', phase: '三期',
    from: '  const last = lines[lines.length - 1];',
    to: '  const last = lines[0];',
    expectFail: ['unit/phase3.test.js'],
    expectRed: ['parseLastJson：Python 输出前有 print'],
  },
  {
    name: '未定义标识符返回 0', file: 'py/tdx_engine/functions.py', phase: '三期',
    from: '            raise FormulaError(msg)',
    to: '            return _const(np.full(self.n, 0.0, dtype=float))',
    expectFail: ['PY_SELFTEST'],
    expectRed: ['未定义标识符 CLOES 抛错'],
  },
];

function makeCopy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-mut-'));
  for (const f of ['config.json', 'config.local.json', 'package.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(tmp, f));
  }
  fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests'), path.join(tmp, 'tests'), { recursive: true });
  // 三期 Python 引擎也要复制（venv 太大，用软链指向原环境）
  const pySrc = path.join(ROOT, 'py');
  if (fs.existsSync(pySrc)) {
    fs.cpSync(pySrc, path.join(tmp, 'py'), {
      recursive: true,
      filter: (s) => !s.includes(`${path.sep}.venv`) && !s.includes(`${path.sep}__pycache__`),
    });
    const venv = path.join(pySrc, '.venv');
    if (fs.existsSync(venv)) fs.symlinkSync(venv, path.join(tmp, 'py', '.venv'), 'dir');
  }
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(tmp, 'node_modules'), 'dir');
  return tmp;
}

function runTest(tmp, rel) {
  let r;
  if (rel === 'PY_SELFTEST') {
    r = cp.spawnSync(path.join(tmp, 'py', '.venv', 'bin', 'python'),
      [path.join(tmp, 'py', 'tdx_engine', 'selftest.py')],
      { cwd: tmp, encoding: 'utf8', timeout: 120000 });
  } else {
    r = cp.spawnSync(process.execPath, [path.join('tests', rel)], {
      cwd: tmp, encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, { QL_BASE: process.env.QL_BASE || 'http://localhost:3000' }),
    });
  }
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let failures = 0;
let byPhase = { 一期: 0, 二期: 0, 三期: 0 };

(async () => {
  console.log('L4 变异验证（改坏副本 → 断言必须红）\n');
  for (const m of MUTATIONS) {
    const tmp = makeCopy();
    try {
      const p = path.join(tmp, m.file);
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes(m.from)) {
        failures++;
        console.log(`  ✗ [${m.phase}] ${m.name}\n      变异目标失效：${m.file} 找不到目标字符串，请更新清单`);
        continue;
      }
      fs.writeFileSync(p, src.replace(m.from, m.to));

      const red = [];
      const outputs = [];
      for (const t of m.expectFail) {
        const r = runTest(tmp, t);
        if (r.code !== 0) { red.push(t); outputs.push(r.out); }
      }
      if (!red.length) {
        failures++;
        console.log(`  ✗ [${m.phase}] ${m.name}\n      断言缺口：改坏了但 ${m.expectFail.join(', ')} 全绿`);
        continue;
      }
      // 粒度检查：期望被打中的具名用例是否真的出现在失败输出里
      const joined = outputs.join('\n');
      const hitNames = (m.expectRed || []).filter((n) => joined.includes(n));
      const coarse = (m.expectRed || []).length > 0 && hitNames.length === 0;
      if (coarse) console.log(`  ! [${m.phase}] ${m.name}：用例变红但非声明用例，检查断言粒度`);
      byPhase[m.phase] = (byPhase[m.phase] || 0) + 1;
      console.log(`  ✓ [${m.phase}] ${m.name} → ${red.join(' + ')} 变红${hitNames.length ? `（命中 ${hitNames.join('、')}）` : ''}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`\n变异结果：一期 ${byPhase['一期'] || 0}/6、二期 ${byPhase['二期'] || 0}/5、三期 ${byPhase['三期'] || 0}/5`);
  if (failures) {
    console.log(`✗ ${failures} 条变异未通过（断言缺口或目标失效）`);
    process.exitCode = 1;
  } else {
    console.log('✓ 全部变异按预期变红');
  }
})();
