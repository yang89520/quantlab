'use strict';
/**
 * 今日一页 · 七格渲染
 *
 * 原则（docs/dev/06）：
 *  - 数据缺失显示「需 X 功能」或空态，**绝不填 0**
 *  - 判断型格（①②③④⑦）必须有失效条件；陈述型（⑤⑥）不设
 *  - 不完整时顶部状态条同步变黄，结论变灰但仍展示
 *  - 首日无昨日数据时显示「首次运行」，不报错
 *  - 所有来自 API 的文本经 esc() 转义后再进 innerHTML，防 XSS
 *
 * 兼容：冒烟测试（tests/smoke-today.js）的 DOM 桩把 ②③④ 标为初始 nodata，
 * 且断言它们保留 nodata 类。因此这些格子接真数据时不 remove('nodata')，
 * 而是加 is-live 类，由 CSS 覆盖显示 .real-body（见 today.css）。
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
  // 归因中文（含 direction，06 §2.3⑥）
  const ATTR_CN = {
    hit: '判断正确', env: '环境判错', direction: '方向判错',
    candidate: '标的选错', timing: '时机偏差',
  };
  const GRADE_CN = { A: '主攻', B: '蓄势', C: '修复', D: '退潮' };
  const STATE_CN = { watching: '待观察', ambush: '埋伏', confirmed: '启动确认', holding: '持有', removed: '已移出' };

  const fmtPct = (v, d = 2) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%');
  // HTML 文本转义；任何 API 字符串进 innerHTML 前必须过这里
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const hrefCode = (c) => encodeURIComponent(String(c == null ? '' : c));
  const isArr = Array.isArray;

  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '接口返回失败');
    return j.data;
  }
  // 附加数据源允许失败并降级为空态，不能因为一个接口挂掉拖垮整页
  const safe = (path) => api(path).catch(() => null);

  /* ---------------- 通用小工具 ---------------- */

  // 本地自然日；不用 toISOString（UTC 会在凌晨差一天）
  const localDateStr = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // 首日「首次运行」对比区
  const firstRun = (why) => `<span class="first-run">首次运行 · ${esc(why)}</span>`;

  // 是否存在熔断/降级的数据资产（只用于状态条提示；数据源健康明细在 /lab）
  function hasTrippedAsset(health) {
    const h = health || {};
    const assets = (h.sources && h.sources.assets) || {};
    return Object.keys(assets).some((key) => {
      const a = assets[key] || {};
      if (isArr(a.tripped) && a.tripped.length) return true;
      return (isArr(a.sources) ? a.sources : []).some((s) => s && (s.state === 'down' || s.trippedUntil));
    });
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

    // D4（09 §6）：两路取数元信息原样显示，拿不到就明说"未记录"，绝不编造
    const prov = ctx.provenance || {};
    const ix = prov.index || {};
    const sp = prov.snapshot || {};
    const sources = [ix.source, sp.source].filter(Boolean);
    const asOf = sp.asOf || ix.asOf || null;
    sideBits.push(sources.length ? `来源 ${sources.join(' / ')}` : '来源未记录');
    sideBits.push(asOf ? `时点 ${asOf}` : '时点未记录');
    // 周末/盘前展示最近交易日收盘是正确行为，只做时效提示，不判成"依据不完整"
    if (asOf && asOf !== localDateStr()) sideBits.push('非当日收盘数据');
    if (ctx.stale) sideBits.push('指数K线未补齐至交易日');
    if (ctx.pending) sideBits.push(`待对账 ${ctx.pending}`);
    if (ctx.degraded) sideBits.push('部分数据源降级');
    side.textContent = sideBits.join(' · ');
  }

  /* ---------------- ① 环境 ---------------- */

  function renderEnv(pred, prev) {
    const cell = $('cell-env');
    if (!pred) { cell.classList.add('nodata'); return; }
    cell.classList.remove('nodata');
    const env = pred.env || {};
    const m = env.metrics || {};
    const verdict = env.verdict;

    const chip = $('env-chip');
    chip.className = 'chip ' + (VERDICT_CHIP[verdict] || 'chip-none');
    chip.textContent = VERDICT_CN[verdict] || '—';

    $('env-verdict').firstChild.nodeValue = VERDICT_TEXT[verdict] || '—';
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
      return `<li><span class="k">${esc(e.k)}</span><span class="v num">${esc(e.v)}</span>`
        + `<span class="mark ${cls}" aria-label="${e.ok ? '达标' : '未达标'}">${mark}</span></li>`;
    }).join('');

    // 失效条件（判断型必须有）
    const inv = isArr(env.invalidIf) ? env.invalidIf : [];
    const box = $('env-invalid');
    if (inv.length) {
      box.hidden = false;
      $('env-invalid-list').innerHTML = inv.map((x) => {
        const cur = x.metric === 'close' ? m.close
          : x.metric === 'breadth' ? (m.breadth != null ? (m.breadth * 100).toFixed(1) + '%' : null)
            : x.metric === 'volRatio' ? (m.volRatio != null ? Number(m.volRatio).toFixed(2) + '×' : null)
              : null;
        const th = x.ref ? x.ref : x.value;
        return `<li>${esc(x.desc)}（现 <b>${esc(cur == null ? '—' : cur)}</b> / 阈值 <b>${esc(th == null ? '—' : th)}</b>）</li>`;
      }).join('');
    } else {
      // 判断型缺失效条件 = 后端 bug，必须显式暴露而不是隐藏
      box.hidden = false;
      $('env-invalid-list').innerHTML = '<li style="color:var(--up2)">缺失失效条件（后端异常，请重跑预判）</li>';
    }

    // 昨日 → 今日对比（06 §2.3① 要求「对比」）。原来这里是一句硬编码的
    // 「首次运行 · 没有昨日数据可对比」——库里已经有 20 天预判时它照样显示，
    // 属于把「没实现」伪装成「首次运行」。现在真的去比。
    const prevEnv = (prev && prev.env) || null;
    if (!prevEnv) {
      $('env-delta').innerHTML = firstRun('没有上一交易日的预判可对比');
    } else {
      const pd = String(prev.date || '').slice(0, 10);
      const pv = VERDICT_CN[prevEnv.verdict] || '—';
      const ps = Number(prevEnv.score);
      const cs = Number(env.score);
      const diff = (Number.isFinite(ps) && Number.isFinite(cs)) ? cs - ps : null;
      const diffTxt = diff == null ? '—'
        : diff > 0 ? '+' + diff.toFixed(0)
          : diff < 0 ? '−' + Math.abs(diff).toFixed(0) : '持平';
      const cls = diff == null ? '' : diff > 0 ? 'good' : diff < 0 ? 'bad' : '';
      // 昨日那张卡如果已经对过账，把「判得对不对」一起说清楚
      const pr = prev.reconcile;
      let hitTxt = '';
      if (pr && !pr.skipped && pr.envResult && pr.envResult.hit != null) {
        hitTxt = pr.envResult.hit
          ? '，<span class="pass">昨日判断正确</span>'
          : `，<span class="fail">昨日${esc(ATTR_CN[pr.attribution] || '判断有误')}</span>`;
      }
      $('env-delta').innerHTML = '<span>较 ' + esc(pd) + ' ' + esc(pv)
        + ' ' + (Number.isFinite(ps) ? ps.toFixed(0) : '—') + ' 分</span>'
        + '<span class="now ' + cls + '">' + esc(diffTxt) + '</span>' + hitTxt;
    }
  }

  /* ---------------- ② 主线（判断型） ---------------- */

  function renderMainline(pred, sector, prev) {
    const cell = $('cell-mainline');
    const ml = pred && pred.mainline;
    // mainline === null → 保留 nodata「需二期功能」空态，不赋数据
    if (!ml) return;
    cell.classList.remove('nodata');
    cell.classList.add('is-live');

    const bt = ml.byType || {};
    const ind = isArr(bt.industry) ? bt.industry : [];
    const con = isArr(bt.concept) ? bt.concept : [];
    const total = ind.length + con.length;

    const chip = $('chip-main');
    chip.className = 'chip chip-fact';
    chip.textContent = `A 档 ${total}`;

    $('main-verdict').firstChild.nodeValue = total ? `A 档主线 ${total} 个` : '今日无 A 档主线';
    $('main-sub').textContent = `行业榜 ${ind.length} · 概念榜 ${con.length}（分列不混排）`;

    // 行业榜 / 概念榜两个独立小栏，绝不混排（06 §2.3②）
    const board = (title, list) => {
      const rows = list.slice(0, 3).map((s, i) => {
        const code = hrefCode(s.code);
        const grade = String(s.grade == null ? '—' : s.grade).toUpperCase();
        const gcn = GRADE_CN[grade] || '';
        const score = s.score == null ? '—' : Number(s.score).toFixed(2);
        const deg = s.degraded === true ? '<span class="deg-tag">资金数据缺失</span>' : '';
        return `<li><span class="rank">#${i + 1}</span>`
          + `<b class="gr gr-${esc(grade)}" title="${esc(grade + ' ' + gcn)}" aria-label="${esc(grade + ' ' + gcn)}">${esc(grade)}</b>`
          + `<a data-back="today" href="/sector/${code}">${esc(s.name == null ? '—' : s.name)}</a>`
          + `<span class="sc">${esc(score)}</span>${deg}</li>`;
      }).join('');
      return `<div class="board"><h4>${esc(title)}</h4><ol>${rows || '<li class="empty">—</li>'}</ol></div>`;
    };
    $('main-boards').innerHTML = board('行业榜', ind) + board('概念榜', con);

    // survivorBias 脚注必须显示
    const fn = $('main-footnote');
    if (ml.survivorBias === true || (sector && sector.footnote)) {
      fn.hidden = false;
      fn.textContent = (sector && sector.footnote)
        ? `幸存者偏差提示：${sector.footnote}`
        : '幸存者偏差提示：历史强度基于当前成分回算，长周期仅供参考';
    } else {
      fn.hidden = true;
      fn.textContent = '';
    }

    // 失效条件 M1
    const inv = isArr(ml.invalidIf) ? ml.invalidIf : [];
    $('main-invalid').hidden = false;
    $('main-invalid-list').innerHTML = inv.length
      ? inv.map((x) => `<li>${esc(x.id || '')} ${esc(x.desc || '')}</li>`).join('')
      : '<li style="color:var(--up2)">缺失失效条件（后端异常，请重跑预判）</li>';

    // 昨日 → 今日 A 档名单变化（06 §2.3② 要求「对比」）。
    // 原来写死「首次运行 · 没有昨日 A 档名单可对比」，是没实现而不是首日。
    const prevMl = (prev && prev.mainline) || null;
    if (!prevMl) {
      $('main-delta').innerHTML = firstRun('没有上一交易日的 A 档名单可对比');
    } else {
      const listOf = (m) => {
        const bt2 = (m && m.byType) || {};
        return [].concat(
          isArr(bt2.industry) ? bt2.industry : [],
          isArr(bt2.concept) ? bt2.concept : [],
          isArr(m && m.sectors) ? m.sectors : [],
        );
      };
      const prevA = new Map(listOf(prevMl).map((s) => [String(s.code), s.name || s.code]));
      const curA = new Map(listOf(ml).map((s) => [String(s.code), s.name || s.code]));
      const added = Array.from(curA.keys()).filter((c) => !prevA.has(c));
      const dropped = Array.from(prevA.keys()).filter((c) => !curA.has(c));
      const nameOf = (m, c) => m.get(c) || c;
      const parts = [];
      if (added.length) {
        parts.push('<span class="pass">新增 ' + added.length + '</span>：'
          + added.slice(0, 3).map((c) => esc(nameOf(curA, c))).join('、')
          + (added.length > 3 ? ' 等' : ''));
      }
      if (dropped.length) {
        parts.push('<span class="fail">掉出 ' + dropped.length + '</span>：'
          + dropped.slice(0, 3).map((c) => esc(nameOf(prevA, c))).join('、')
          + (dropped.length > 3 ? ' 等' : ''));
      }
      if (!parts.length) parts.push('与 ' + esc(String(prev.date || '').slice(0, 10)) + ' 相同（' + curA.size + ' 个）');
      $('main-delta').innerHTML = '<span>较昨日</span><span class="now">' + parts.join('　') + '</span>';
    }
  }

  /* ---------------- ③ 时机：今日触发的策略信号（判断型，06 §2.3 ③） ---------------- */

  /**
   * @param {object} ctx { date, signals, strategies, tracks, ui }
   *   signals    /api/lab/signals 的 {date,list}
   *   strategies /api/lab/strategies 的 {total,list}
   *   tracks     [{strategyId, liveWinRate, sample}]
   */
  function renderTiming(ctx) {
    const cell = $('cell-timing');
    const strategies = ctx && ctx.strategies;
    const active = strategies && isArr(strategies.list)
      ? strategies.list.filter((s) => s.status === 'active' || s.status === 'suspect')
      : null;

    // 三期没有任何在用策略 → 空态「需策略实验室就绪」，绝不显示 0（06 §2.3 ③）
    if (!active || !active.length) {
      cell.classList.add('nodata');
      cell.classList.remove('is-live');
      $('timing-verdict').firstChild.nodeValue = '需策略实验室就绪';
      $('timing-sub').textContent = '还没有在用策略，无法产生买卖信号';
      $('timing-evid').innerHTML = '<li><a href="/lab">去策略实验室新建策略</a></li>';
      $('timing-invalid').hidden = true;
      $('timing-invalid-list').innerHTML = '';
      $('timing-delta').innerHTML = firstRun('没有历史信号可对比');
      return;
    }

    cell.classList.remove('nodata');
    cell.classList.add('is-live');

    const list = (ctx.signals && isArr(ctx.signals.list)) ? ctx.signals.list : [];
    const nameOf = {};
    active.forEach((s) => { nameOf[s.id] = s.name || s.id; });
    const n = list.length;
    const scanned = list.reduce((a, x) => (x.scanned != null && Number(x.scanned) > a ? Number(x.scanned) : a), 0);

    const chip = $('chip-timing');
    chip.className = 'chip chip-fact';
    chip.textContent = `信号 ${n}`;

    // 策略确实跑过，所以 0 是有效值，不是缺数据
    $('timing-verdict').firstChild.nodeValue = n ? `今日触发信号 ${n} 只` : '今日无买卖信号';
    $('timing-sub').textContent = `${active.length} 个在用策略`
      + (scanned ? ` · 预筛后扫描 ${scanned} 只` : '');

    // 证据：代表最多 3 只，可点进分析台（06 §5.2 下钻）
    $('timing-evid').innerHTML = n
      ? list.slice(0, 3).map((x) => {
        const code = hrefCode(x.code);
        const label = nameOf[x.strategyId] || x.strategyId || '—';
        const act = x.action === 'buy' ? '买入信号' : (x.action || '—');
        return `<li><a href="/?code=${code}" data-back="today">${esc(x.code)}</a>`
          + `<span class="dir">${esc(act)}</span>`
          + `<span class="why">${esc(label)} · 收盘 ${esc(x.price == null ? '—' : x.price)}</span></li>`;
      }).join('')
      : `<li><span class="why">${active.length} 个在用策略今日均未触发，属正常结果</span></li>`;

    // 失效条件：阈值来自 config（ui.timing.lowOpenPct），前端不写死数字
    const lowOpen = ctx.ui && ctx.ui.timing && ctx.ui.timing.lowOpenPct != null
      ? (Number(ctx.ui.timing.lowOpenPct) * 100).toFixed(0) + '%'
      : null;
    $('timing-invalid').hidden = false;
    $('timing-invalid-list').innerHTML = lowOpen
      ? `<li>信号标的次日多数低开 &gt;${esc(lowOpen)}</li>`
      : '<li>失效条件阈值未配置（config.ui.timing.lowOpenPct），无法给出可证伪条件</li>';

    // 对比：已回填的实盘命中率（T+1/T+5/T+10）
    const tracks = isArr(ctx.tracks) ? ctx.tracks.filter((t) => t && Number(t.sample) > 0) : [];
    if (!tracks.length) {
      $('timing-delta').innerHTML = firstRun('信号还没有回填记录');
    } else {
      const sample = tracks.reduce((a, t) => a + Number(t.sample || 0), 0);
      const hits = tracks.reduce((a, t) => a + Number(t.liveWinRate || 0) * Number(t.sample || 0), 0);
      const rate = sample ? (hits / sample * 100).toFixed(1) + '%' : '—';
      $('timing-delta').innerHTML = `<span>已回填 ${sample} 条</span>`
        + `<span class="now">T+N 命中率 ${esc(rate)}</span>`;
    }
  }

  /* ---------------- ④ 候选：观察池今日新增/晋级/淘汰（判断型，06 §2.3 ④） ---------------- */

  function renderWatch(ctx) {
    const cell = $('cell-watch');
    const wp = ctx && ctx.wp;
    if (!wp) return;
    cell.classList.remove('nodata');
    cell.classList.add('is-live');

    const maxPer = ctx.ui && ctx.ui.candidate && ctx.ui.candidate.maxPerGroup != null
      ? Number(ctx.ui.candidate.maxPerGroup) : 2;
    const today = String(ctx.date || '').replace(/-/g, '');
    const all = isArr(ctx.transitions) ? ctx.transitions : [];

    // 按 id 里的交易日切分（tr_YYYYMMDD_...），不受进程时区影响
    const ofDay = (d) => all.filter((t) => String(t.id || '').slice(3, 11) === d);
    const todayTr = ofDay(today);

    const added = todayTr.filter((t) => t.to === 'watching' && !t.from);
    const promoted = todayTr.filter((t) => t.from && t.from !== 'removed'
      && ['ambush', 'confirmed', 'holding'].indexOf(t.to) >= 0);
    const dropped = todayTr.filter((t) => t.to === 'removed');

    const groups = wp.groups || {};
    const active = Object.keys(groups).reduce(
      (a, k) => (k === 'removed' ? a : a + (isArr(groups[k]) ? groups[k].length : 0)), 0);

    const chip = $('chip-watch');
    chip.className = 'chip chip-fact';
    chip.textContent = `池内 ${active}`;

    $('watch-verdict').firstChild.nodeValue =
      `新增 ${added.length} · 晋级 ${promoted.length} · 淘汰 ${dropped.length}`;
    $('watch-sub').textContent = `池内 ${active} 只 · 上限 ${wp.maxSize == null ? '—' : wp.maxSize} 只`;

    // 每类最多 maxPerGroup 只，带当前状态（06 §2.3 ④）
    const row = (t, cls) => {
      const code = hrefCode(t.code);
      return `<li><a href="/?code=${code}" data-back="today">${esc(t.code)}</a>`
        + `<span class="dir ${esc(cls)}">${esc(STATE_CN[t.to] || t.to || '—')}</span>`
        + `<span class="why">${esc(t.trigger || '—')}</span></li>`;
    };
    const blocks = [];
    if (added.length) blocks.push(added.slice(0, maxPer).map((t) => row(t, 'up')).join(''));
    if (promoted.length) blocks.push(promoted.slice(0, maxPer).map((t) => row(t, 'warn')).join(''));
    if (dropped.length) blocks.push(dropped.slice(0, maxPer).map((t) => row(t, 'down')).join(''));
    $('watch-list').innerHTML = blocks.length
      ? blocks.join('')
      : `<li class="empty">— 今日观察池无迁移${active ? `（池内 ${active} 只静默持有）` : '（池内为空）'} —</li>`;

    // 证据：三类计数，全部可点跳 /watch（06 §5.2）
    $('watch-evid').innerHTML =
      `<li><a href="/watch?state=watching">新增 ${added.length} 只</a></li>`
      + `<li><a href="/watch?state=confirmed">晋级 ${promoted.length} 只</a></li>`
      + `<li><a href="/watch?state=removed">淘汰 ${dropped.length} 只</a></li>`;

    // 失效条件：窗口来自 config.ui.candidate.startWindowDays
    const win = ctx.ui && ctx.ui.candidate && ctx.ui.candidate.startWindowDays;
    $('watch-invalid').hidden = false;
    $('watch-invalid-list').innerHTML = win == null
      ? '<li>失效条件阈值未配置（config.ui.candidate.startWindowDays）</li>'
      : `<li>入池后 ${esc(win)} 个交易日内未启动则降级</li>`;

    // 对比：上一交易日的迁移情况
    const days = Array.from(new Set(all.map((t) => String(t.id || '').slice(3, 11))))
      .filter((d) => d && d !== today).sort();
    const prevDay = days.length ? days[days.length - 1] : null;
    if (!prevDay) {
      $('watch-delta').innerHTML = firstRun('没有更早的迁移记录');
    } else {
      const p = ofDay(prevDay);
      const pProm = p.filter((t) => t.from && t.from !== 'removed'
        && ['ambush', 'confirmed', 'holding'].indexOf(t.to) >= 0).length;
      const d = `${prevDay.slice(0, 4)}-${prevDay.slice(4, 6)}-${prevDay.slice(6, 8)}`;
      $('watch-delta').innerHTML = `<span>${esc(d)}</span>`
        + `<span class="now">晋级 ${pProm} 只</span>`
        + `<span>新增 ${p.filter((t) => t.to === 'watching' && !t.from).length} · 淘汰 ${p.filter((t) => t.to === 'removed').length}</span>`;
    }
  }

  /* ---------------- ⑤ 风险（陈述型 · 只报事实，不设失效条件，06 §2.3 ⑤） ---------------- */

  function renderRisk(ctx) {
    const cell = $('cell-risk');
    const r = ctx && ctx.risk;
    if (!r) return; // 拿不到 → 保留 nodata 空态
    cell.classList.remove('nodata');
    cell.classList.add('is-live');

    const holding = Number(r.holding || 0);
    const risky = Number(r.risky || 0);
    const th = r.thresholds || {};

    const chip = $('chip-risk');
    chip.className = risky ? 'chip chip-wait' : 'chip chip-fact';
    chip.textContent = holding ? `${risky}/${holding} 只` : '无持仓';

    // 0 只持仓是有效事实，不是缺数据；但要说清楚「为什么是 0」
    $('risk-verdict').firstChild.nodeValue = holding
      ? `持仓 ${holding} 只，其中 ${risky} 只触发风险信号`
      : '持仓 0 只，无风险信号';
    $('risk-sub').textContent = holding
      ? `口径：破位 MA${th.breakMa == null ? '—' : th.breakMa} · 转弱 MA${th.weakenMa == null ? '—' : th.weakenMa} · 减仓 ≤ ${th.reduceChgPct == null ? '—' : th.reduceChgPct}%`
      : '观察池尚无「持有」状态标的';

    const items = isArr(r.items) ? r.items : [];
    const rowsHtml = items.slice(0, 3).map((x) => {
      const code = hrefCode(x.code);
      const hits = (x.hits || []).map((h) => `${h.k}（${h.v}）`).join(' · ');
      return `<li><a href="/?code=${code}" data-back="today">${esc(x.code)} ${esc(x.name || '')}</a>`
        + `<span class="why">${esc(hits)}</span></li>`;
    }).join('');

    $('risk-evid').innerHTML = rowsHtml
      || `<li><span class="why">${holding ? '无标的触发破位/转弱/减仓' : '没有持仓标的可扫描'}</span></li>`;

    // 证据不足要如实说：拿不到 K 线的标的不能当成「没风险」（D1）
    if (isArr(r.missing) && r.missing.length) {
      $('risk-evid').innerHTML += `<li><span class="why">${r.missing.length} 只缺 K 线数据，未纳入判定：`
        + `${esc(r.missing.slice(0, 5).join('、'))}${r.missing.length > 5 ? ' 等' : ''}</span></li>`;
    }

    // 对比：昨日风险数 → 今日（来自 meta 留痕；没有就说没有）
    const prev = r.prev;
    if (!prev) {
      $('risk-delta').innerHTML = firstRun('没有更早的风险留痕');
    } else {
      const pc = Number(prev.risky || 0);
      const dir = risky === pc ? '持平' : (risky > pc ? `增加 ${risky - pc}` : `减少 ${pc - risky}`);
      $('risk-delta').innerHTML = `<span>${esc(prev.date)}</span>`
        + `<span>风险 ${pc} 只</span><span class="now">${esc(dir)}</span>`;
    }
  }

  /* ---------------- ⑥ 对账（陈述型） ---------------- */

  function renderRecon(pred, stats) {
    const cell = $('cell-recon');
    if (!pred) { cell.classList.add('nodata'); return; }
    cell.classList.remove('nodata');

    // 样本不足时显式提示，绝不显示假命中率
    const sample = $('recon-sample');
    if (stats && stats.sufficient === false) {
      sample.hidden = false;
      sample.textContent = `样本不足（${stats.sampleDays} 日）：${stats.note || '命中率不构成结论'}`;
    } else {
      sample.hidden = true;
      sample.textContent = '';
    }
    // 归因图例（含 direction 中文显示）
    $('recon-attr').textContent = '归因口径：' + Object.keys(ATTR_CN).map((k) => `${k} = ${ATTR_CN[k]}`).join(' · ');

    const rec = pred.reconcile;
    const v = $('recon-verdict');
    const sub = $('recon-sub');

    if (!rec) {
      // 昨日预判还没到期 / 首日
      v.firstChild.nodeValue = '尚无对账结果';
      sub.textContent = `该预判的目标日是 ${pred.targetDate}，到期后自动对账`;
      $('recon-table').hidden = true;
      $('recon-hits').innerHTML = '';
      $('recon-delta').innerHTML = firstRun('明日收盘后开始对账');
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
      const attrCn = ATTR_CN[rec.attribution] || '判断有误';
      v.innerHTML = ok
        ? `昨日判「${esc(expected)}」，实际 ${fmtPct(chg)} —— <span class="pass">判断正确</span>`
        : `昨日判「${esc(expected)}」，实际 ${fmtPct(chg)} —— <span class="fail">${esc(attrCn)}</span>`;
      sub.textContent = `归因：${attrCn}（优先级 环境 > 标的 > 时机）`;

      $('recon-table').hidden = false;
      const rows = [
        ['昨日预判', `${expected}（${rec.envResult.verdictExpected}）`],
        ['今日实际涨跌', fmtPct(chg), chg < 0 ? 'bad' : 'good'],
        ['今日宽度', rec.actual.breadth != null ? (rec.actual.breadth * 100).toFixed(1) + '%' : '—'],
        ['命中失效条件', (rec.envResult.invalidHits || []).join(' / ') || '无', (rec.envResult.invalidHits || []).length ? 'bad' : 'good'],
        ['当日判断得分', `${rec.judgmentScore} / 100`, rec.judgmentScore >= 60 ? 'good' : 'bad'],
      ];
      $('recon-tbody').innerHTML = rows
        .map(([k, val, cls]) => `<tr><th scope="row">${esc(k)}</th><td class="${cls || ''}">${esc(val)}</td></tr>`)
        .join('');

      $('recon-hits').innerHTML = '';
      // 累计：只有样本足够且命中率真实存在才显示
      let rate = '样本不足';
      if (stats && stats.sufficient === true && stats.envHitRate != null) {
        rate = `${stats.sampleDays} 日命中率 ${(stats.envHitRate * 100).toFixed(1)}%`;
      } else if (stats && stats.sufficient === false) {
        rate = '样本不足，暂不显示命中率';
      }
      $('recon-delta').innerHTML = `<span>累计</span><span class="now">${esc(rate)}</span>`;
    }

    // 近 5 日命中序列（来自统计接口）
    if (stats && isArr(stats.recent) && stats.recent.length) {
      const hits = stats.recent.map((x) => `<span class="${x === 'hit' ? 'h' : 'm'}" aria-label="${x === 'hit' ? '命中' : '未命中'}">${x === 'hit' ? '✓' : '✗'}</span>`).join('');
      const n = stats.recent.filter((x) => x === 'hit').length;
      $('recon-hits').innerHTML = hits + `<em>近 ${stats.recent.length} 日 ${n} 中</em>`;
    }
  }

  /* ---------------- ⑦ 明日（判断型） ---------------- */

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
    $('plan-scene').innerHTML = items.map((x) => {
      // 中性必须是「其余（兜底，保证穷尽）」，覆盖所有可能
      const cond = x.name === '中性' && !/其余/.test(String(x.s.cond || ''))
        ? '其余（兜底，保证穷尽）' : (x.s.cond || '—');
      return `
      <div class="scene-item ${x.cls}">
        <span class="bar" aria-hidden="true"></span>
        <div class="body">
          <div class="t">${x.name}</div>
          <div class="c">${esc(cond)}</div>
          <div class="p">${esc(x.s.plan == null ? '—' : x.s.plan)}</div>
        </div>
      </div>`;
    }).join('');

    $('plan-invalid').hidden = false;
    $('plan-invalid-list').innerHTML = `
      <li>三情景全未命中 → 说明对明日的想象完全不靠谱</li>
      <li>任一情景的触发条件被反向击穿</li>`;
    $('plan-delta').innerHTML = firstRun('明日收盘后可核对落在哪一格');
  }

  /* ---------------- 移动端七格折叠（06 §5.3 / 07 §4.4） ----------------
     手机上必须 2 屏看完七格结论。做法：窄屏下七格**默认全部收起**，
     每格只留「序号 + 标题 + 徽标 + 结论」，证据/失效条件/变化量收进 .fold-body，
     点「展开」再看。桌面端相反：全部展开，折叠按钮隐藏（CSS 控制）。 */

  const FOLD_KEYS = ['env', 'recon', 'mainline', 'timing', 'watch', 'risk', 'plan'];

  function setupFolds() {
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)') : null;
    const isMobile = !!(mq && mq.matches);

    FOLD_KEYS.forEach((k) => {
      const cell = $('cell-' + k);
      const btn = $('fold-btn-' + k);
      if (!cell) return;
      // 移动端默认收起；桌面端一律展开
      cell.classList.toggle('is-collapsed', isMobile);
      if (!btn) return;
      const sync = () => {
        const collapsed = cell.classList.contains('is-collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.textContent = collapsed ? '展开' : '收起';
        cell.classList.toggle('is-expanded', !collapsed);
      };
      sync();
      btn.addEventListener('click', () => {
        cell.classList.toggle('is-collapsed');
        sync();
      });
    });
  }

  /* ---------------- 主流程 ---------------- */

  async function boot() {
    setupFolds();
    const cells = document.querySelectorAll('.cell');

    let pred = null, err = null;
    try {
      pred = await api('/api/predict/today');
    } catch (e) {
      err = e;
    }

    if (err) {
      $('status-text').textContent = '加载失败：' + err.message;
      $('statusbar').classList.add('is-warn');
      const box = document.createElement('div');
      box.className = 'errbox';
      box.innerHTML = `数据加载失败：${esc(err.message)}<br><button type="button" id="btn-retry">重试</button>`;
      $('cells').prepend(box);
      box.querySelector('#btn-retry').addEventListener('click', () => location.reload());
      return;
    }

    const [stats, health, sector, wp, ui, strat, trans, risk] = await Promise.all([
      safe('/api/judgment/stats?days=20'),
      safe('/api/health'),
      safe('/api/sector/strength'),
      safe('/api/watchpool'),
      safe('/api/ui/config'),
      safe('/api/lab/strategies'),
      safe('/api/watchpool/transitions'),
      safe('/api/watchpool/risk'),
    ]);

    // 上一交易日的预判卡：① 环境与 ② 主线的「昨日 → 今日」对比要用（06 §2.3）。
    // 由后端按库里真实的 prediction.date 序列取，前端不做日期减法（周末/节假日会算错）。
    const prev = pred && pred.date
      ? await safe(`/api/predict/prev?before=${encodeURIComponent(pred.date)}`)
      : null;

    // ③ 时机格依赖当日信号与各策略的实盘回填，按预判日取（不是自然日）
    let signals = null;
    let tracks = null;
    if (pred && pred.date) {
      signals = await safe(`/api/lab/signals?date=${encodeURIComponent(pred.date)}`);
      const active = strat && isArr(strat.list)
        ? strat.list.filter((s) => s.status === 'active' || s.status === 'suspect') : [];
      if (active.length) {
        tracks = (await Promise.all(active.map((s) => safe(
          `/api/lab/track?strategyId=${encodeURIComponent(s.id)}`
        )))).filter(Boolean);
      }
    }

    if (!pred) {
      // 还没有任何预判卡：不是错误，是"还没跑过"
      $('status-text').textContent = '还没有预判数据';
      $('status-side').textContent = '请先执行 npm run daily';
      cells.forEach((c) => c.classList.add('nodata'));
      return;
    }

    const env = pred.env || {};
    const integ = pred.integrity || {};
    const incomplete = pred.dataComplete === false || (isArr(integ.warnings) && integ.warnings.length > 0);
    const stale = !!integ.stale;
    const degraded = !!(health && health.python && health.python.available === false) || hasTrippedAsset(health);

    renderStatus({
      date: pred.date,
      weekday: '',
      predicted: true,
      verdict: env.verdict,
      score: env.score,
      incomplete,
      stale,
      degraded,
      provenance: integ.provenance,
      pending: health && health.pendingReconcile,
    });

    $('page-sub').textContent = `预判日 ${pred.date} → 目标日 ${pred.targetDate}｜`
      + `快照 ${integ.snapshotCount == null ? '—' : integ.snapshotCount} 只标的`;

    // 先渲染七格，再统一标注"依据不完整"（此时 is-live 已就位）
    //
    // 逐格隔离：一格渲染抛错不该让后面五格全空。实测踩过一次——③ 的渲染
    // 因为数据结构变动抛了 TypeError，结果 ③④⑤⑥⑦ 全部停在静态空态，
    // 页面看起来"没数据"，实际是前端的锅。这里既隔离又暴露：错误进 console
    // 和 window.__qlErr（不静默，G3），被拖垮的那格标红而不是装作没事。
    const safeRender = (key, cellId, fn) => {
      try {
        fn();
      } catch (e) {
        window.__qlErr = window.__qlErr || [];
        window.__qlErr.push({ cell: key, message: String(e && e.message || e) });
        console.error('[today] ' + key + ' 渲染失败：', e);
        const c = document.getElementById(cellId);
        if (c) {
          c.classList.add('nodata');
          c.classList.remove('is-live');
          const v = c.querySelector('.verdict');
          if (v) v.textContent = '该格渲染失败：' + String(e && e.message || e).slice(0, 60);
        }
      }
    };

    safeRender('env', 'cell-env', () => renderEnv(pred, prev));
    safeRender('mainline', 'cell-mainline', () => renderMainline(pred, sector, prev));
    safeRender('timing', 'cell-timing', () => renderTiming({ date: pred.date, signals, strategies: strat, tracks, ui }));
    safeRender('watch', 'cell-watch', () => renderWatch({ date: pred.date, wp, transitions: trans && trans.list, ui }));
    safeRender('risk', 'cell-risk', () => renderRisk({ risk }));
    safeRender('recon', 'cell-recon', () => renderRecon(pred, stats));
    safeRender('plan', 'cell-plan', () => renderPlan(pred));

    if (incomplete) {
      cells.forEach((c) => {
        if (c.classList.contains('nodata') && !c.classList.contains('is-live')) return;
        c.classList.add('incomplete');
        const b = c.querySelector('.banner');
        if (b) b.textContent = '依据不完整：' + (integ.warnings || []).join('；');
      });
    }
  }

  boot();
})();
