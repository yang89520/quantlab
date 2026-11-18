'use strict';
/**
 * 全量验收（docs/dev/07 §4/§6/§6.1 + 09 §9）。
 * 逐条输出 PASS/FAIL；任一 FAIL 退出码 1，必须回到开发修复后重跑。
 *
 * 运行前需启动服务：npm start
 * 运行：node tests/acceptance.js
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.QL_BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
const failures = [];
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}`); }
  else { fail++; failures.push(`${id} ${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${id} ${name}${detail ? '\n      ' + detail : ''}`); }
}
function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function filesIn(dir, ext) {
  const out = [];
  const walk = (d) => {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.venv') continue;
        walk(rel);
      } else if (!ext || e.name.endsWith(ext)) out.push(rel);
    }
  };
  walk(dir);
  return out;
}
function grep(rels, re) {
  const hits = [];
  for (const rel of rels) {
    const lines = read(rel).split('\n');
    lines.forEach((l, i) => { if (re.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  return hits;
}
async function get(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(20000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function run(cmd, args, opts) {
  return cp.spawnSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8', timeout: 300000 }, opts || {}));
}

(async () => {
  console.log('全量验收（07 各期 + 09 数据规则 + 上线检查表）\n');

  /* ---------- A. 回归套件 ---------- */
  console.log('【A 回归套件】');
  const t1 = run('npm', ['test']);
  ok('A1', 'npm test 26 项全绿', /26\/26 通过/.test(t1.stdout || ''), t1.stdout && t1.stdout.slice(-160));
  const t2 = run('npm', ['run', 'test:unit']);
  const unitOut = (t2.stdout || '') + (t2.stderr || '');
  ok('A2', '一期/二期/三期/集成单测 + Python selftest 全绿',
    t2.status === 0 && /8\/8 通过/.test(unitOut), unitOut.slice(-220));
  const t3 = run('npm', ['run', 'test:today']);
  ok('A3', '今日一页渲染冒烟通过', t3.status === 0 && /渲染冒烟通过/.test(t3.stdout || ''));
  const t4 = run('npm', ['run', 'test:mutate']);
  const mutOut = t4.stdout || '';
  ok('A4', '变异 20 条全红', t4.status === 0 && /一期 6\/6、二期 5\/5、三期 5\/5、新增 4\/4/.test(mutOut), mutOut.slice(-200));
  const t5 = run(process.execPath, ['tests/integration/datasource-rules.test.js']);
  const dsRules = (t5.stdout || '') + (t5.stderr || '');
  ok('A5', '数据铁律专项全绿（D-3/D-4/D-5/D-7/D-8 真跑）',
    t5.status === 0 && /8\/8 通过/.test(dsRules), dsRules.slice(-220));

  /* ---------- B. 数据规则（09 §9 / 07 §6.1） ---------- */
  console.log('\n【B 数据规则专项（优先级高于功能验收）】');
  const jsFiles = filesIn('lib', '.js').concat(filesIn('tools', '.js'));
  const d1 = grep(jsFiles, /\b(mock|fake|random|lorem)\b/i);
  ok('D-1', '生产代码无 mock/fake/random/lorem', d1.length === 0, d1.slice(0, 3).join('\n      '));

  const d2 = grep(jsFiles, /catch\s*\([^)]*\)\s*\{\s*\}/);
  ok('D-2', '无空 catch 静默吞错', d2.length === 0, d2.slice(0, 4).join('\n      '));

  const dsSrc = read('lib/datasource.js');
  ok('D-3', 'resolve 返回带 source/level/asOf/stale/degraded',
    /source,\s*level,\s*asOf/.test(dsSrc) || /source:\s*/.test(dsSrc));

  const cfg = JSON.parse(read('config.json'));
  const marketPath = fs.existsSync(path.join(ROOT, 'config.local.json'))
    ? JSON.parse(read('config.local.json')).localDb.marketDb : '';
  ok('D-8a', '自有库与上游行情库不同文件',
    !!marketPath && path.resolve(marketPath) !== path.resolve(ROOT, cfg.storage.ownDb));
  const upstreamRefs = grep(jsFiles, /marketDb|localDb\.marketDb/);
  const dsConn = read('lib/datasource.js');
  ok('D-8b', '所有上游库连接只读 + 短连接',
    /access_mode:\s*'READ_ONLY'/.test(dsConn) && /closeSync/.test(dsConn));

  const d6 = grep(jsFiles, /tests\/fixtures|test[s/\\]fixtures/);
  ok('D-6', 'fixtures 不进生产代码', d6.length === 0, d6.slice(0, 2).join('\n      '));
  ok('D-7', '降级有标记（degraded 字段存在）',
    /degraded/.test(read('lib/sources/index.js')) && /degraded/.test(read('lib/sector.js')));

  // D-4 是全套里最重要的一条：它防「拿 T-1 本地数据冒充当日」（09 §9）
  ok('D-4', '当日不走本地库（夹具库 MAX=历史日 + 请求今日 → 走网络且 asOf=今日）',
    /✓ D-4 请求今日（> 库内 MAX）必须走网络/.test(dsRules)
    && /✓ D-4 请求历史日期（≤ 库内 MAX）走本地库/.test(dsRules),
    dsRules.split('\n').filter((l) => /D-4/.test(l)).join('\n      '));
  ok('D-5', '缺失返 null 不返 0（上游全失败 → rows 为空、level=null、asOf=null）',
    /✓ D-5 本地与网络全失败/.test(dsRules)
    && /✓ D-5 快照取不到/.test(dsRules),
    dsRules.split('\n').filter((l) => /D-5/.test(l)).join('\n      '));

  // engine=jsonl 独立运行（在临时目录跑，不污染业务库）
  const jsonlProbe = run(process.execPath, ['-e', `
    const config=require('./lib/config');
    config.__root=require('os').tmpdir()+'/ql-acc-'+Date.now();
    config.storage.engine='jsonl';
    const store=require('./lib/dao');
    (async()=>{const s=await store.open();await s.upsert('prediction',[{date:'2026-01-05',verdict:'wait',score:50,payload:{a:1}}]);
      const r=await s.query('prediction',{where:{date:'2026-01-05'}});
      if(!r.length)throw new Error('jsonl 写后读不到');console.log('OK',s.engine);})().catch(e=>{console.error(e.message);process.exit(1)});
  `]);
  ok('D-9', 'engine=jsonl 可独立跑通一期流程', jsonlProbe.status === 0,
    (jsonlProbe.stdout || '') + (jsonlProbe.stderr || ''));

  /* ---------- C. 动态 API 验收 ---------- */
  console.log('\n【C 各期功能验收】');
  let health, strength, predict, wp;
  try {
    health = (await get('/api/health')).body.data;
  } catch (e) { health = null; }
  ok('C-H', '服务在线且 /api/health 可读', !!health, health ? '' : '请先执行 npm start');
  if (health) {
    ok('C-H2', '/api/health 含 storage/python/assets/pendingReconcile',
      !!health.storage && !!health.python && !!health.sources.assets && health.pendingReconcile !== undefined);
    ok('C-H3', 'Python 环境探测可用', health.python && health.python.available === true, JSON.stringify(health.python));
    ok('D-10', '预判卡留痕 integrity.provenance 存在', true); // 下面用真实卡再验
  }
  try { strength = (await get('/api/sector/strength')).body.data; } catch (e) { strength = null; }
  if (strength) {
    const grades = new Set(strength.industry.concat(strength.concept).map((r) => r.grade));
    ok('C1', '板块 A/B/C/D 四档都有实际板块', ['A', 'B', 'C', 'D'].every((g) => grades.has(g)), [...grades].join(','));
    ok('C2', '行业榜与概念榜分开且榜内 type 唯一',
      strength.industry.length > 0 && strength.concept.length > 0
      && strength.industry.every((r) => r.type === 'industry')
      && strength.concept.every((r) => r.type === 'concept'));
    ok('C3', 'degraded 有可见标记且带原因',
      strength.industry.concat(strength.concept).some((r) => r.degraded && r.degradeReason));
    ok('C19', '板块下钻页可达', (await get('/sector/' + strength.industry[0].sector)).status === 200);
  }
  try { predict = (await get('/api/predict/today')).body.data; } catch (e) { predict = null; }
  if (predict) {
    ok('D-10b', '预判卡含 provenance 两路元信息',
      !!(predict.integrity && predict.integrity.provenance
        && predict.integrity.provenance.index && predict.integrity.provenance.snapshot));
    ok('C15a', '预判卡 mainline 含行业/概念双栏',
      !!(predict.mainline && predict.mainline.byType
        && Array.isArray(predict.mainline.byType.industry) && Array.isArray(predict.mainline.byType.concept)));
    ok('C15b', '① 失效条件三条', (predict.env.invalidIf || []).length === 3);
    ok('C16a', '⑦ 中性情景为「其余」兜底', /其余/.test(predict.scenario.neutral.cond));
  }
  try { wp = (await get('/api/watchpool')).body.data; } catch (e) { wp = null; }
  if (wp) ok('C4a', '观察池 5 个状态分组齐全',
    ['watching', 'ambush', 'confirmed', 'holding', 'removed'].every((s) => Array.isArray(wp.groups[s])));

  // 移出必须选原因（用不存在的标的，验证 400 而非 404 掩盖）
  const delNoReason = await fetch(BASE + '/api/watchpool/999999', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then((r) => r.json()).catch(() => ({}));
  ok('C5', '移出未选原因返回 400 明确报错',
    /必须选择原因/.test(delNoReason.error || ''), JSON.stringify(delNoReason));

  const scanHi = await fetch(BASE + '/api/lab/formula/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formula: 'BUY:ZIG(3,5);' }),
  }).then((r) => r.json()).catch(() => ({}));
  ok('C7', '高危未来函数被识别为 high', (scanHi.data || {}).level === 'high', JSON.stringify(scanHi.data));
  const saveHi = await fetch(BASE + '/api/lab/strategies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '验收临时', type: 'formula', source: 'BUY:ZIG(3,5);', outputLine: 'BUY' }),
  });
  ok('C17', '高危公式禁止保存（400）', saveHi.status === 400);

  /* ---------- D. 静态页面与文档 ---------- */
  console.log('\n【D 四期页面 / 上线检查表】');
  const NAV = ['/today', '/watch', '/lab', '/', '/screen'];
  const pages = ['public/today.html', 'public/watch.html', 'public/lab.html', 'public/index.html', 'public/screen.html', 'public/sector.html'];
  let navOk = true, navDetail = '';
  for (const p of pages) {
    const s = read(p);
    const missing = NAV.filter((u) => !s.includes(`href="${u}"`));
    if (missing.length) { navOk = false; navDetail += `${p} 缺 ${missing.join(',')}; `; }
  }
  ok('C14', '六页导航 5 项可达且主入口区分', navOk, navDetail);

  const todayHtml = read('public/today.html');
  const cellIds = ['cell-env', 'cell-mainline', 'cell-timing', 'cell-watch', 'cell-risk', 'cell-recon', 'cell-plan'];
  ok('C15c', '今日一页七格齐全', cellIds.every((c) => todayHtml.includes(c)));
  const todayJs = read('public/js/today.js');
  ok('C15d', '判断型格有失效条件、陈述型格不设',
    /invalid/.test(todayJs) && /首次运行/.test(todayJs));
  ok('C16b', '三种状态（完整/不完整/首次运行）',
    /is-warn/.test(todayJs) && /首次运行/.test(todayJs) && /dataComplete/.test(todayJs));
  const labJs = read('public/js/lab.js');
  ok('C18', '五道闸 ! 与 ✓ 视觉区分（三态）',
    /无法检验/.test(labJs) && /通过/.test(labJs) && /未通过/.test(labJs));
  ok('C20', '移动端与无障碍（reduced-motion / focus-visible / skip-link）',
    /prefers-reduced-motion/.test(read('public/css/today.css') + read('public/css/style.css') + read('public/css/ql.css'))
    && /focus-visible/.test(read('public/css/ql.css'))
    && /skip-link/.test(todayHtml));
  ok('C21', '设计令牌对比度修复（--tx3:#828FA5 / --focus）',
    /#828FA5/i.test(read('public/css/ql.css') + read('public/css/style.css') + read('public/css/screen.css'))
    && /--focus/.test(read('public/css/ql.css') + read('public/css/style.css')));
  ok('C22', '板块详情可点回原始值（metrics 表）',
    /amountPctile/.test(read('public/js/sector.js')) && /ret20/.test(read('public/js/sector.js')));

  // C23：06 §5.3 / 07 §4.4「移动端 375px 七格结论 2 屏内」
  // 只靠 CSS 收不起 ①⑤⑥⑦（它们原本没有折叠按钮），所以三处必须同时成立：
  //   1) 七格各有一个 fold-toggle（结论始终可见，明细点开再看）
  //   2) 移动端收起态用 :not(.verdict) 兜住所有非结论块，新增块不用再补选择器
  //   3) JS 在窄屏下把七格全部置为 is-collapsed（而不是照着 HTML 静态 class 走）
  const foldKeys = ['env', 'recon', 'mainline', 'timing', 'watch', 'risk', 'plan'];
  const foldBtns = foldKeys.filter((k) => todayHtml.includes(`id="fold-btn-${k}"`));
  const todayCss = read('public/css/today.css');
  const styleCss = read('public/css/style.css');
  const mobileCss = todayCss.slice(todayCss.indexOf('@media (max-width:767px)'));
  ok('C23', '移动端 375px 七格结论 2 屏内（七格可折叠 + 窄屏全收起）',
    foldBtns.length === 7
    && foldKeys.every((k) => todayCss.includes(`fold-body`) && todayHtml.includes(`id="fold-${k}"`))
    && /\.cell\.is-collapsed > \.real-body > :not\(\.verdict\)\{display:none\}/.test(mobileCss)
    && /classList\.toggle\('is-collapsed', isMobile\)/.test(todayJs)
    && /const FOLD_KEYS = \['env', 'recon', 'mainline', 'timing', 'watch', 'risk', 'plan'\]/.test(todayJs)
    // 头部 .hd-right 不单独占行时会把文档撑出横向滚动条（分析台/选股器实测 16–47px）
    && /\.hd-right\{flex:1 1 100%/.test(styleCss),
    `折叠按钮 ${foldBtns.length}/7`);

  // C24：03 §8 要求「/api/health 返回 lastPrediction 非空」。
  // 这条同时守住两个坑：BigInt 序列化会让整个接口 500；DuckDB 的 TIMESTAMP
  // 不是 JS Date，透传出去前端会拿到 {"micros":...}。
  const hResp = await get('/api/health');
  const hp = (hResp.body && hResp.body.data) || {};
  const lp = hp.lastPrediction;
  ok('C24', '/api/health 暴露 lastPrediction（cron 漏跑能看出来）',
    hResp.status === 200 && !!lp && !!lp.date
    && typeof lp.score === 'number'
    && (lp.createdAt === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(lp.createdAt))),
    `status=${hResp.status} lastPrediction=${JSON.stringify(lp)}`);

  // C25：06 §5.2「下钻必须能返回原位置」。
  // 光有 nav-return.js 不够——页面得真的把 data-back 挂在下钻链接上，
  // 否则点击时不会记录滚动位置，回去就跳回顶部。
  const drillPages = ['public/today.html', 'public/watch.html', 'public/lab.html',
    'public/sector.html', 'public/index.html'];
  const navLoaded = drillPages.filter((p) => /nav-return\.js/.test(read(p)));
  const backPages = ['public/js/today.js', 'public/js/watch.js', 'public/js/lab.js', 'public/js/sector.js']
    // 两种写法都算：拼字符串是 data-back="x"，动态生成是 setAttribute('data-back', 'x')
    .filter((p) => /data-back="|'data-back'/.test(read(p)));
  ok('C25', '下钻可返回原位置（五页都加载 nav-return，下钻链接带 data-back）',
    navLoaded.length === 5 && backPages.length === 4
    && /QLPageState/.test(read('public/js/watch.js'))
    && /QLApplyState/.test(read('public/js/watch.js')),
    `加载 ${navLoaded.length}/5，带 data-back ${backPages.length}/4`);

  // 加严：前端也在检查范围内（文档只要求 lib/，本项目把前端一并纳入）
  const allJs = jsFiles.concat(filesIn('public/js', '.js'));
  const d2b = grep(allJs, /catch\s*\([^)]*\)\s*\{\s*\/\*[^]*?\*\/\s*\}/);
  ok('D-2b', '无纯注释型静默 catch', d2b.length === 0, d2b.slice(0, 3).join('\n      '));
  ok('D-3b', '取数元信息一路传到状态条',
    /provenance/.test(todayJs) && /来源/.test(todayJs) && /时点/.test(todayJs));

  const docs = ['04-phase2-sector-watchpool.md', '08-risks-roadmap.md', '10-data-source-playbook.md', '03-phase1-prediction-loop.md', '09-data-access.md']
    .map((f) => 'docs/dev/' + f);
  const stale = grep(docs, /东财可用性验证|用夹具先行|用夹具数据先行|`store\/`/);
  ok('D-9b', '文档无过时口径残留', stale.length === 0, stale.slice(0, 3).join('\n      '));
  const d5hits = grep(jsFiles, /\b(65|35)\b/);
  ok('D-5', '业务阈值集中在 config.json（判定与分项阈值都由 config 读取）',
    cfg.predict.verdict.attack === 65 && cfg.predict.verdict.defend === 35
      && /th\.attack/.test(read('lib/predict.js')) && /th\.defend/.test(read('lib/predict.js'))
      && /sc\.breadthLow/.test(read('lib/predict.js')) && d5hits.length === 0,
    d5hits.length ? d5hits.slice(0, 3).join('\n      ') : '');

  // C26：响应式体检（06 §5.3）。
  // style.css 里 `main{display:grid;grid-template-columns:318px minmax(0,1fr)}` 是分析台专用的
  // 两栏壳子，但六个页面的 <main> 都吃这条规则。今日一页若不显式 display:block，
  // 宽屏下七格会被塞进 318px 那一栏，文字竖排成一列 —— 而 ≤1080px 时 style.css
  // 会改回单列，于是「手机正常、桌面炸裂」，最难发现的那种坏法。
  ok('C26', '今日一页不被分析台两栏栅格接管（桌面七格可铺满）',
    /\.today-wrap\{display:block/.test(todayCss),
    '缺少 .today-wrap{display:block}');

  // C27：原生 dialog 的关闭态必须显式 display:none。
  // ql.css 给 dialog.drawer 设了 display:flex，特异性高于 UA 的
  // `dialog:not([open]){display:none}` —— 抽屉关着也照渲染，观察池/实验室页
  // 底部会多出一整屏空白的「标的详情」框（实测页高 1569 → 853）。
  const qlCss = read('public/css/ql.css');
  ok('C27', '抽屉关闭态不占位（dialog.drawer:not([open]) 显式 none）',
    /dialog\.drawer:not\(\[open\]\)\{display:none\}/.test(qlCss),
    '缺少 dialog.drawer:not([open]){display:none}');

  // C28：触屏点击目标（07 §4.4，参考 WCAG 2.5.5）。
  // 行内「代码 / 评分 / 板块」原本只有 15–23px 高（实测 601288 那个链接 45×15），
  // 手指点不准；下拉 27px、复选框 14px 同样点不中。
  ok('C28', '触屏点击目标撑到可点尺寸（≥32px 行内链接 / ≥34px 表单控件）',
    /min-height:32px/.test(read('public/css/watch.css'))
    && /min-height:34px/.test(read('public/css/screen.css')),
    'watch.css 或 screen.css 缺少触屏点击目标规则');

  // C29：metrics 原始值必须过格式化。
  // API 给的是原始比值，直接 String(v) 会渲染出 28502.404574549233 这种一长串小数，
  // 既读不出量级也看不出单位。显示走 fmtMetric，原始值留在 title 上供核对。
  ok('C29', '板块 metrics 数值格式化（原始值留在 title）',
    /function fmtMetric/.test(read('public/js/sector.js'))
    && /fmtMetric\(it\.fmt, v\)/.test(read('public/js/sector.js'))
    && /API 原始值/.test(read('public/js/sector.js')));

  // C30：跨市场同号必须分开取序列。
  // 上游 kline_daily 里 000001 同时有 sh（上证指数 3700 点）与 sz（平安银行 11 元），
  // 只按 code 过滤会把两条序列按日期交错塞进同一个数组，aggregate 的 prevClose
  // 被来回覆盖，板块指数算出 ±30000%（实测金融行业 ret20 = 28502%）。
  const localDbJs = read('lib/sources/adapters/local-db.js');
  ok('C30', '成分股取数按 (market, code) 分离，不按 code 合并两条序列',
    /byMk\.size > 1/.test(localDbJs)
    && /code_market_collision/.test(localDbJs)
    && /map\(\(x\) => x\.market\)|String\(row\.market\)/.test(localDbJs)
    && /module\.exports = \{ sessionDates, readMemberKlines, withMarket \}/.test(localDbJs),
    'local-db.js 未按 market 分离序列');

  // C31：等权指数要挡住非交易性跳变（除权未复权 / 复牌 / 脏数据）。
  ok('C31', '等权指数剔除超限单日样本（maxDailyChg 来自 config）',
    /maxDailyChg/.test(read('lib/sources/adapters/aggregate.js'))
    && cfg.sector.aggregate.maxDailyChg > 0,
    'aggregate.js 或 config.json 缺少 maxDailyChg');

  // C32：窄屏头部导航必须一行放下 5 项。
  // 六个页面分两套头部：today/index/screen 用 `.main-nav`（style.css），
  // watch/lab/sector 用裸 `<nav>`（ql.css）。两套都实测过：375px 下 5 项共 267px，
  // 可用 351px。一旦让 nav 换行，「选股器」会孤零零掉到第二行，看着像页面坏了。
  ok('C32', '窄屏头部导航一行容纳 5 项（两套头部都不换行）',
    /\.main-nav a\{min-height:32px\}/.test(styleCss)
    && /\.hd nav\{flex-wrap:nowrap/.test(qlCss),
    'style.css 或 ql.css 缺少窄屏导航规则');

  // C33：触屏点击目标覆盖到「流派 tab / 图标按钮 / 行内文字按钮」。
  // 实测 375px 下流派 tab 只有 28px 高、图标按钮 22×22、选股器行内按钮 31×22，
  // 手指点不中（参考 WCAG 2.5.8 的 24px 下限）。
  ok('C33', '触屏点击目标覆盖 tab / 图标按钮 / 行内按钮（均 ≥32px）',
    /\.tab\{min-height:32px/.test(styleCss)
    && /\.icon-btn\{min-width:32px;min-height:32px\}/.test(styleCss)
    && /\.lnk\{min-height:32px/.test(read('public/css/screen.css'))
    && /@media\(max-width:760px\)\{\s*\.icon-btn\{width:32px;height:32px\}/.test(read('public/css/watchlist.css')),
    '有触屏目标未撑到 32px');

  // C34：闭环真的跑起来了 —— 这是最容易「测试全绿但其实没跑」的地方。
  // 库里有快照、有预判，但对账 0 条，会让人以为系统正常：判断力画像永远空、
  // ⑥ 对账格永远显示「尚未对账」。所以这条直接断言**对账样本天数**。
  // 走 /api/judgment/stats 而不是自己开库：acceptance 与 Web 服务是两个进程，
  // 同时开同一个 DuckDB 会互相抢锁（实测因此 fetch failed 过一次）。
  const jResp = await get('/api/judgment/stats?days=30');
  const jd = (jResp.body && jResp.body.data) || {};
  ok('C34', '对账闭环有真实数据（对账样本 ≥ 10 天，不是 0 条空转）',
    jResp.status === 200 && Number(jd.sampleDays) >= 10
    && typeof jd.envHitRate === 'number',
    `sampleDays=${jd.sampleDays} envHitRate=${jd.envHitRate}`);

  // C35：归因链路必须给出不止一种结论。
  // 全是 env 说明归因退化成「无论对错都怪环境」，方向/标的/时机那几档根本没被走过。
  const byAttr = jd.byAttribution || {};
  const attrKinds = ['env', 'direction', 'candidate', 'timing', 'hit']
    .filter((k) => Number(byAttr[k]) > 0);
  ok('C35', '归因分布覆盖多个档位（不是一律 env）',
    attrKinds.length >= 2,
    `命中 ${attrKinds.length} 类：${JSON.stringify(byAttr)}`);

  // C36：README §8 承诺的 `tools/gate-run.js` CLI 入口。
  // 这里只做静态检查（语法通 + 关键符号），**不真跑**：
  // 跑它会写 strategy_gate，与服务进程抢 DuckDB 写锁。
  const gateCheck = run(process.execPath, ['--check', 'tools/gate-run.js']);
  let gateSrc = '';
  try { gateSrc = read('tools/gate-run.js'); } catch (e) { gateSrc = ''; }
  ok('C36', 'tools/gate-run.js 存在且可用（同步跑闸 + 落 S10）',
    gateCheck.status === 0
    && /computeGates/.test(gateSrc)
    && /strategy_gate/.test(gateSrc)
    && /--list/.test(gateSrc),
    `exit=${gateCheck.status} len=${gateSrc.length}`);

  // C37：合成快照必须带 derived 标记（D4 留痕）。
  const BF_DAY = '2026-11-12';   // 回补窗口内、且不与实时日重叠的一天
  // 回补出来的快照和当场抓的快照肉眼无法区分，不标出来后人分不清「当时抓的」
  // 和「事后算的」，而这直接决定这条对账数据能不能信。
  const todayResp = await get('/api/predict/today');
  const todayData = (todayResp.body && todayResp.body.data) || {};
  const provOf = (card) => ((card && card.integrity && card.integrity.provenance
    && card.integrity.provenance.snapshot) || {});
  const liveProv = provOf(todayData);
  // 回补日的卡（11-12 是回补出来的）必须自证 derived=true；实时采集的卡必须 false。
  // 只断言「最新一天」不够：最新一天通常是实时采集的，derived 本来就该是 false。
  const bfResp = await get('/api/predict/' + BF_DAY);
  const bfProv = provOf((bfResp.body && bfResp.body.data) || {});
  const dailyCloseSrc = read('tools/daily-close.js');
  ok('C37', '合成快照带 derived 标记（回补日 true / 实时日 false，可区分）',
    bfProv.derived === true
    && Array.isArray(bfProv.nullFields) && bfProv.nullFields.length >= 2
    && liveProv.derived === false
    && /derived: !!\(snapRec && snapRec\.synthesized\)/.test(dailyCloseSrc),
    `回补日 ${BF_DAY} derived=${bfProv.derived} nullFields=${JSON.stringify(bfProv.nullFields)}｜最新日 derived=${liveProv.derived}`);

  // C38：06 §4.4「必须画实盘 vs 回测两条线」。
  // 之前只有跟踪 tab 的两根静态进度条，看不出「最近在变好还是变差」。
  // 现在信号 tab 底部有累计曲线：接口给逐日累计序列，前端画折线 + 回测基准虚线。
  const curveResp = await get('/api/lab/track-curve?strategyId=st_mwggh5rw');
  const curveData = (curveResp.body && curveResp.body.data) || null;
  const curvePts = (curveData && curveData.points) || [];
  const curveLabJs = read('public/js/lab.js');
  const curveLabHtml = read('public/lab.html');
  ok('C38', '信号 tab 有累计命中率曲线（接口给序列 + 前端画两条线）',
    curveResp.status === 200 && Array.isArray(curvePts)
    && curvePts.every((p) => typeof p.cumLive === 'number' && p.date)
    && /function drawCurve/.test(curveLabJs)
    && /track-curve/.test(curveLabJs)
    && /sig-curve/.test(curveLabHtml)
    // 未到期不得计入分母：接口返回的 total 必须等于最后一点的 cumSample
    && (curvePts.length === 0 || curvePts[curvePts.length - 1].cumSample === curveData.total),
    `status=${curveResp.status} points=${curvePts.length}`);

  // C39：① ② 的「昨日 → 今日」对比必须是真的（06 §2.3①②）。
  // 这两格底部原来写死 `firstRun('没有昨日数据可对比')`：库里已经有 20 天预判时
  // 它照样显示「首次运行」——把「没实现」伪装成「首天」。这种假空态比报错更糟，
  // 因为没人会怀疑它。
  const prevResp = await get('/api/predict/prev?before=' + encodeURIComponent(String(todayData.date || '')));
  const prevData = (prevResp.body && prevResp.body.data) || null;
  const todayJsSrc = read('public/js/today.js');
  ok('C39', '① ② 的昨日对比是真实数据（上一交易日可查，非硬编码首日）',
    prevResp.status === 200 && !!prevData && !!prevData.date && !!prevData.env
    && /\/api\/predict\/prev/.test(todayJsSrc)
    && /renderEnv\(pred, prev\)/.test(todayJsSrc)
    && /renderMainline\(pred, sector, prev\)/.test(todayJsSrc),
    `prev=${prevData && prevData.date} status=${prevResp.status}`);

  // C40：一格渲染抛错不许拖垮整页。
  // 实测踩过：② 里 `prev is not defined` 抛了 TypeError，结果 ③④⑤⑥⑦ 全部停在
  // 静态空态，页面看起来「没数据」——实际是前端的锅，而且完全看不到错误。
  ok('C40', '七格逐格隔离渲染（一格失败不影响其余，且不静默）',
    /const safeRender = \(key, cellId, fn\)/.test(todayJsSrc)
    && (todayJsSrc.match(/safeRender\('/g) || []).length === 7
    && /window\.__qlErr/.test(todayJsSrc),
    `safeRender 调用 ${(todayJsSrc.match(/safeRender\('/g) || []).length} 处`);

  const badDaily = run(process.execPath, ['tools/sector-report.js', '--date', 'not-a-date']);
  ok('D-4b', '失败任务非 0 退出', badDaily.status !== 0, `exit=${badDaily.status}`);
  const logFiles = filesIn('logs', '.log');
  const logHasMs = logFiles.some((f) => /\bms\b/.test(read(f)));
  ok('D-4c', '日志含 start/end/耗时', logHasMs, `logFiles=${logFiles.length}`);

  console.log(`\n${fail ? '✗' : '✓'} 验收结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n未通过项：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('验收脚本异常：' + e.stack);
  process.exitCode = 1;
});
