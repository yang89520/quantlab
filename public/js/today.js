'use strict';
/**
 * 今日一页 · 七格渲染
 *
 * 原则（docs/dev/06）：
 *  - 数据缺失显示「需 X 功能」或空态，**绝不填 0**
 *  - 判断型格（①②③④⑦）必须有失效条件；陈述型（⑤⑥）不设
 *  - 不完整时顶部状态条同步变黄，结论变灰但仍展示
 *  - 首日无昨日数据时显示「首次运行」，不报错
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const VERDICT_CN = { attack: '进攻', wait: '观望', defend: '防守' };
  const VERDICT_CHIP = { attack: 'chip-attack', wait: 'chip-wait', defend: 'chip-defend' };
  // 文案固定（06 §2.3①），不许自由发挥
  const VERDICT_TEXT = {
    attack: '可顺势，回踩不破可加',
    wait: '以观察仓为主，等共振',
    defend: '控总仓，等右侧信号',
  };
  const ATTR_CN = { hit: '判断正确', env: '环境判错', candidate: '标的选错', timing: '时机偏差' };

  const fmtPct = (v, d = 2) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%');
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '接口返回失败');
    return j.data;
  }

  /* ---------------- 顶部状态条 ---------------- */

  function renderStatus(ctx) {
    const bar = $('statusbar');
    const txt = $('status-text');
    const side = $('status-side');
    const incomplete = ctx.incomplete;
    bar.classList.toggle('is-warn', incomplete);

    const bits = [];
    bits.push(ctx.date ? `${ctx.date}${ctx.weekday || ''}` : '无预判数据');
    if (ctx.predicted) bits.push(`${VERDICT_CN[ctx.verdict] || ctx.verdict} ${ctx.score} 分`);
    txt.textContent = bits.join(' · ');

    const sideBits = [];
    if (incomplete) sideBits.push('依据不完整');
    else sideBits.push('数据完整');
    if (ctx.stale) sideBits.push('数据为上一交易日收盘');
    if (ctx.pending) sideBits.push(`待对账 ${ctx.pending}`);
    side.textContent = sideBits.join(' · ');
  }

  /* ---------------- ① 环境 ---------------- */

  function renderEnv(pred) {
    const cell = $('cell-env');
    if (!pred) {
      cell.classList.add('nodata');
      return;
    }
    cell.classList.remove('nodata');
    const env = pred.env || {};
    const m = env.metrics || {};
    const verdict = env.verdict;

    const chip = $('env-chip');
    chip.className = 'chip ' + (VERDICT_CHIP[verdict] || 'chip-none');
    chip.textContent = VERDICT_CN[verdict] || '—';

    $('env-verdict').firstChild.nodeValue = VERDICT_TEXT[verdict] || '—';
    $('env-sub').textContent = `${VERDICT_CN[verdict] || ''} · 综合 ${env.score} 分`;
    $('env-sub').textContent = `${VERDICT_CN[verdict] || ''} · 综合 ${env.score} 分`;

    // 评分拆解：只给总分等于不可信
    const parts = env.parts || {};
    const bd = $('env-breakdown');
    if (env.score > 0) {
      bd.hidden = false;
      const seg = [
        { k: '趋势', v: parts.trend || 0, max: 40, c: 'var(--up)' },
        { k: '宽度', v: parts.breadth || 0, max: 30, c: '#6BA5FF' },
        { k: '量能', v: parts.vol || 0, max: 30, c: 'var(--gold)' },
      ];
      $('env-bar').innerHTML = seg
        .map((s) => `<i style="width:${(s.v / 100) * 100}%;background:${s.c}"></i>`)
        .join('');
      $('env-bar').setAttribute('aria-label',
        `评分拆解：${seg.map((s) => `${s.k} ${Math.round(s.v)} 分`).join('，')}，合计 ${env.score} 分`);
      $('env-legend').innerHTML = seg
        .map((s) => `<span><i style="background:${s.c}" aria-hidden="true"></i>${s.k} ${Math.round(s.v)}</span>`)
        .join('');
    } else {
      bd.hidden = true;
    }

    // 证据（≤3 条，显示原始值与是否达标）
    const ma20 = m.ma20;
    const evid = [
      {
        k: '指数站上 MA20',
        v: m.close != null && ma20 != null ? `${m.close} > ${ma20}` : '—',
        ok: m.close != null && ma20 != null ? m.close > ma20 : null,
      },
      {
        k: '市场宽度',
        v: m.breadth != null ? (m.breadth * 100).toFixed(1) + '%' : '—',
        ok: m.breadth != null ? m.breadth >= 0.40 : null,
      },
      {
        k: '量能（5日/20日）',
        v: m.volRatio != null ? Number(m.volRatio).toFixed(2) + '×' : '—',
        ok: m.volRatio != null ? m.volRatio >= 0.70 : null,
      },
    ];
    $('env-evid').innerHTML = evid.map((e) => {
      const mark = e.ok === null ? '·' : e.ok ? '✓' : '·';
      const cls = e.ok ? 'ok' : 'no';
      return `<li><span class="k">${e.k}</span><span class="v num">${e.v}</span>`
        + `<span class="mark ${cls}" aria-label="${e.ok ? '达标' : '未达标'}">${mark}</span></li>`;
    }).join('');

    // 失效条件（判断型必须有）
    const inv = env.invalidIf || [];
    const box = $('env-invalid');
    if (inv.length) {
      box.hidden = false;
      $('env-invalid-list').innerHTML = inv.map((x) => {
        const cur = x.metric === 'close' ? m.close
          : x.metric === 'breadth' ? (m.breadth != null ? (m.breadth * 100).toFixed(1) + '%' : null)
            : x.metric === 'volRatio' ? (m.volRatio != null ? Number(m.volRatio).toFixed(2) + '×' : null)
              : null;
        const th = x.ref ? x.ref : x.value;
        return `<li>${x.desc}（现 <b>${cur == null ? '—' : cur}</b> / 阈值 <b>${th}</b>）</li>`;
      }).join('');
    } else {
      // 判断型缺失效条件 = 后端 bug，必须显式暴露而不是隐藏
      box.hidden = false;
      $('env-invalid-list').innerHTML = '<li style="color:var(--up2)">缺失失效条件（后端异常，请重跑预判）</li>';
    }

    $('env-delta').innerHTML = '<span class="first-run">首次运行 · 没有昨日数据可对比</span>';
  }

  /* ---------------- ⑥ 对账 ---------------- */

  function renderRecon(pred, stats) {
    const cell = $('cell-recon');
    if (!pred) { cell.classList.add('nodata'); return; }
    cell.classList.remove('nodata');

    const rec = pred.reconcile;
    const v = $('recon-verdict');
    const sub = $('recon-sub');

    if (!rec) {
      // 昨日预判还没到期 / 首日
      v.firstChild.nodeValue = '尚无对账结果';
      sub.textContent = `该预判的目标日是 ${pred.targetDate}，到期后自动对账`;
      $('recon-table').hidden = true;
      $('recon-hits').innerHTML = '';
      $('recon-delta').innerHTML = '<span class="first-run">首次运行 · 明日收盘后开始对账</span>';
    } else if (rec.skipped) {
      v.firstChild.nodeValue = '本次对账已跳过';
      sub.textContent = `原因：${rec.skipReason || '数据不完整'}（不计入统计）`;
      $('recon-table').hidden = true;
      $('recon-hits').innerHTML = '';
      $('recon-delta').innerHTML = '';
    } else {
      const expected = VERDICT_CN[rec.envResult.verdictExpected] || rec.envResult.verdictExpected;
      const chg = rec.actual.idxChg;
      const ok = rec.envResult.hit;
      v.innerHTML = ok
        ? `昨日判「${expected}」，实际 ${fmtPct(chg)} —— <span class="pass">判断正确</span>`
        : `昨日判「${expected}」，实际 ${fmtPct(chg)} —— <span class="fail">${ATTR_CN[rec.attribution] || '判断有误'}</span>`;
      sub.textContent = `归因：${ATTR_CN[rec.attribution] || rec.attribution}（优先级 环境 > 标的 > 时机）`;

      $('recon-table').hidden = false;
      const rows = [
        ['昨日预判', `${expected}（${rec.envResult.verdictExpected}）`],
        ['今日实际涨跌', fmtPct(chg), chg < 0 ? 'bad' : 'good'],
        ['今日宽度', rec.actual.breadth != null ? (rec.actual.breadth * 100).toFixed(1) + '%' : '—'],
        ['命中失效条件', (rec.envResult.invalidHits || []).join(' / ') || '无', (rec.envResult.invalidHits || []).length ? 'bad' : 'good'],
        ['当日判断得分', `${rec.judgmentScore} / 100`, rec.judgmentScore >= 60 ? 'good' : 'bad'],
      ];
      $('recon-tbody').innerHTML = rows
        .map(([k, val, cls]) => `<tr><th scope="row">${k}</th><td class="${cls || ''}">${val}</td></tr>`)
        .join('');

      $('recon-hits').innerHTML = '';
      $('recon-delta').innerHTML = `<span>累计</span><span class="now">${pred ? '' : ''}`
        + (stats && stats.envHitRate != null
          ? `${stats.sampleDays} 日命中率 ${(stats.envHitRate * 100).toFixed(1)}%`
          : '样本不足') + '</span>';
    }

    // 近 5 日命中序列（来自统计接口）
    if (stats && Array.isArray(stats.recent) && stats.recent.length) {
      const hits = stats.recent.map((x) => `<span class="${x === 'hit' ? 'h' : 'm'}" aria-label="${x === 'hit' ? '命中' : '未命中'}">${x === 'hit' ? '✓' : '✗'}</span>`).join('');
      const n = stats.recent.filter((x) => x === 'hit').length;
      $('recon-hits').innerHTML = hits + `<em>近 ${stats.recent.length} 日 ${n} 中</em>`;
    }
  }

  /* ---------------- ⑦ 明日 ---------------- */

  function renderPlan(pred) {
    const cell = $('cell-plan');
    if (!pred) { cell.classList.add('nodata'); return; }
    cell.classList.remove('nodata');
    const sc = pred.scenario || {};

    $('plan-chip').className = 'chip chip-wait';
    $('plan-chip').textContent = VERDICT_CN[pred.env.verdict] || '—';
    $('plan-verdict').firstChild.nodeValue = '三种情景，互斥且穷尽';
    $('plan-sub').textContent = `目标日 ${pred.targetDate} · 收盘后自动归入其一`;

    const items = [
      { cls: 'opt', name: '乐观', s: sc.optimistic },
      { cls: 'neu', name: '中性', s: sc.neutral },
      { cls: 'pes', name: '悲观', s: sc.pessimistic },
    ].filter((x) => x.s);
    $('plan-scene').innerHTML = items.map((x) => `
      <div class="scene-item ${x.cls}">
        <span class="bar" aria-hidden="true"></span>
        <div class="body">
          <div class="t">${x.name}</div>
          <div class="c">${x.s.cond}</div>
          <div class="p">${x.s.plan}</div>
        </div>
      </div>`).join('');

    $('plan-invalid').hidden = false;
    $('plan-invalid-list').innerHTML = `
      <li>三情景全未命中 → 说明对明日的想象完全不靠谱</li>
      <li>任一情景的触发条件被反向击穿</li>`;
    $('plan-delta').innerHTML = '<span class="first-run">首次运行 · 明日收盘后可核对落在哪一格</span>';
  }

  /* ---------------- 主流程 ---------------- */

  async function boot() {
    const cells = document.querySelectorAll('.cell');

    let pred = null, stats = null, health = null, err = null;
    try {
      ;[pred, stats, health] = await Promise.all([
        api('/api/predict/today'),
        api('/api/judgment/stats?days=20'),
        api('/api/health'),
      ]);
    } catch (e) {
      err = e;
    }

    if (err) {
      $('status-text').textContent = '加载失败：' + err.message;
      $('statusbar').classList.add('is-warn');
      const box = document.createElement('div');
      box.className = 'errbox';
      box.innerHTML = `数据加载失败：${err.message}<br><button type="button" id="btn-retry">重试</button>`;
      $('cells').prepend(box);
      box.querySelector('#btn-retry').addEventListener('click', () => location.reload());
      return;
    }

    if (!pred) {
      // 还没有任何预判卡：不是错误，是"还没跑过"
      $('status-text').textContent = '还没有预判数据';
      $('status-side').textContent = '请先执行 npm run daily';
      cells.forEach((c) => c.classList.add('nodata'));
      return;
    }

    const incomplete = pred.dataComplete === false || (pred.integrity && pred.integrity.warnings || []).length > 0;
    const stale = !!(pred.integrity && pred.integrity.stale);

    renderStatus({
      date: pred.date,
      weekday: '',
      predicted: true,
      verdict: pred.env.verdict,
      score: pred.env.score,
      incomplete,
      stale,
      pending: health && health.pendingReconcile,
    });

    $('page-sub').textContent = `预判日 ${pred.date} → 目标日 ${pred.targetDate}｜`
      + `数据源 ${(pred.integrity && pred.integrity.snapshotCount) || 0} 只标的`;

    if (incomplete) {
      cells.forEach((c) => {
        if (c.classList.contains('nodata')) return;
        c.classList.add('incomplete');
        const b = c.querySelector('.banner');
        if (b) b.textContent = '依据不完整：' + (pred.integrity.warnings || []).join('；');
      });
    }

    renderEnv(pred);
    renderRecon(pred, stats);
    renderPlan(pred);
  }

  boot();
})();
