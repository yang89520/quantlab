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
  const DIR_CN = { up: '看多', down: '看空', dn: '看空', flat: '中性' };

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

  // ③/⑥ 与昨日对比：用 /api/judgment/stats 的 recent
  function recentCompare(recent, why) {
    if (!isArr(recent) || !recent.length) return firstRun(why);
    const seq = recent.map((x) => `<span class="${x === 'hit' ? 'ok' : 'no'}">${x === 'hit' ? '✓' : '✗'}</span>`).join(' ');
    const n = recent.filter((x) => x === 'hit').length;
    return `<span>近 ${recent.length} 日</span><span class="now">${n} 中</span>`
      + `<span class="recent-seq">${seq}</span>`;
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

  function renderEnv(pred) {
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

    $('env-delta').innerHTML = firstRun('没有昨日数据可对比');
  }

  /* ---------------- ② 主线（判断型） ---------------- */

  function renderMainline(pred, sector) {
    const cell = $('cell-mainline');
    const ml = pred && pred.mainline;
    // mainline === null → 保留 nodata「需二期功能」空态，不赋数据
    if (!ml) return;
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
          + `<a href="/sector/${code}">${esc(s.name == null ? '—' : s.name)}</a>`
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

    $('main-delta').innerHTML = firstRun('没有昨日 A 档名单可对比');
  }

  /* ---------------- ③ 时机（判断型） ---------------- */

  function renderTiming(wp, stats) {
    const cell = $('cell-timing');
    const groups = wp && wp.groups;
    // 拿不到观察池 → 保留 nodata「需三期功能」空态
    if (!groups) return;
    cell.classList.add('is-live');

    // 四态真实数量，不写死
    const keys = ['watching', 'ambush', 'confirmed', 'holding'];
    const counts = keys.map((k) => ({ k, label: STATE_CN[k], n: isArr(groups[k]) ? groups[k].length : 0 }));
    const total = counts.reduce((s, x) => s + x.n, 0);
    const max = counts.reduce((a, b) => (b.n > a.n ? b : a), counts[0]);

    const chip = $('chip-timing');
    chip.className = 'chip chip-fact';
    chip.textContent = `池内 ${total}`;

    // 结论按最大状态给出一句人读判断
    $('timing-verdict').firstChild.nodeValue = total === 0
      ? '池内暂无标的，先积累观察'
      : `「${max.label}」${max.n} 只最多，节奏以${max.label}为主`;
    $('timing-sub').textContent = `四态合计 ${total} 只 · 池上限 ${wp.maxSize == null ? '—' : wp.maxSize} 只`;

    // 证据（≤3 条，可点跳 /watch?state=）
    const link = (x) => `<a href="/watch?state=${encodeURIComponent(x.k)}">${esc(x.label)} ${x.n} 只</a>`;
    $('timing-evid').innerHTML =
      `<li>${link(counts[0])}</li>`
      + `<li>${link(counts[1])}</li>`
      + `<li>${link(counts[2])} · ${link(counts[3])}</li>`;

    // 失效条件：config 未取到就写默认一条，但必须显示一条
    $('timing-invalid').hidden = false;
    $('timing-invalid-list').innerHTML = '<li>池内标的触发放量跌破 MA20（默认失效条件，未取到 config）</li>';

    $('timing-delta').innerHTML = recentCompare(stats && stats.recent, '没有昨日信号数据可对比');
  }

  /* ---------------- ④ 候选（判断型） ---------------- */

  function renderWatch(pred, summary) {
    const cell = $('cell-watch');
    const cs = pred && isArr(pred.candidates) ? pred.candidates : null;
    if (!cs) return;
    cell.classList.add('is-live');

    const n = cs.length;
    const ups = cs.filter((c) => c.dir === 'up').length;
    const chip = $('chip-watch');
    chip.className = 'chip chip-fact';
    chip.textContent = `候选 ${n}`;

    $('watch-verdict').firstChild.nodeValue = n ? `候选 ${n} 只` : '今日无候选';
    $('watch-sub').textContent = n ? `看多 ${ups} 只 · 点代码进分析台` : '观察池今日无入选标的';

    // 全部候选：真实代码/名称/方向/理由，可点跳 /?code=
    $('watch-list').innerHTML = n
      ? cs.map((c) => {
          const code = hrefCode(c.code);
          const dir = esc(DIR_CN[c.dir] || c.dir || '—');
          return `<li><a href="/?code=${code}">${esc(c.code == null ? '—' : c.code)} ${esc(c.name == null ? '—' : c.name)}</a>`
            + `<span class="dir">${dir}</span><span class="why">${esc(c.reason || '—')}</span></li>`;
        }).join('')
      : '<li class="empty">— 暂无候选 —</li>';

    // 证据（≤3 条）：用 /api/snapshot/summary 补充当日宽度与涨停数
    const s = summary || {};
    const breadth = s.breadth == null ? '—' : (s.breadth * 100).toFixed(1) + '%';
    const zt = s.ztCount == null ? '—' : s.ztCount + ' 只';
    const valid = s.valid == null ? '—' : s.valid + ' 只';
    $('watch-evid').innerHTML =
      `<li><a href="/screen">当日宽度 <b>${esc(breadth)}</b></a>（快照）</li>`
      + `<li><a href="/screen">涨停 <b>${esc(zt)}</b> · 有效 <b>${esc(valid)}</b></a></li>`
      + `<li><a href="/watch">候选共 ${n} 只 · 到观察池核对</a></li>`;

    // 失效条件 C1
    const first = cs.find((c) => isArr(c.invalidIf) && c.invalidIf.length);
    const c1 = first ? first.invalidIf : [];
    $('watch-invalid').hidden = false;
    $('watch-invalid-list').innerHTML = c1.length
      ? c1.map((x) => `<li>${esc(x.id || '')} ${esc(x.desc || '')}</li>`).join('')
      : '<li style="color:var(--up2)">缺失失效条件（后端异常，请重跑预判）</li>';

    $('watch-delta').innerHTML = firstRun('没有昨日候选名单可对比');
  }

  /* ---------------- ⑤ 风险（陈述型 · 不设失效条件） ---------------- */

  // 是否存在熔断/降级的数据资产（供状态条"部分数据源降级"提示）
  function hasTrippedAsset(health) {
    const h = health || {};
    const assets = (h.sources && h.sources.assets) || {};
    return Object.keys(assets).some((key) => {
      const a = assets[key] || {};
      if (isArr(a.tripped) && a.tripped.length) return true;
      return (isArr(a.sources) ? a.sources : []).some((s) => s && (s.state === 'down' || s.trippedUntil));
    });
  }

  // 逐条收集真实风险，绝不填假风险
  function collectRisks(health, sector) {
    const out = [];
    const h = health || {};
    const assets = (h.sources && h.sources.assets) || {};
    Object.keys(assets).forEach((key) => {
      const a = assets[key] || {};
      const tripped = isArr(a.tripped) ? a.tripped : [];
      if (tripped.length) out.push({ t: `数据资产熔断：${key}`, d: `熔断源 ${tripped.join('、')}` });
      (isArr(a.sources) ? a.sources : []).forEach((s) => {
        if (s && (s.state === 'down' || s.trippedUntil)) {
          out.push({
            t: `数据源熔断：${key} / ${s.name}`,
            d: `state=${s.state || '—'} · fail=${s.fail == null ? '—' : s.fail} · ${s.lastError || ''}`,
          });
        }
      });
      if (a.state === 'degraded') {
        out.push({ t: `数据资产降级：${key}`, d: `state=${a.state} · active=${a.active || 'none'}` });
      }
    });
    if (h.storage && h.storage.degraded) {
      out.push({ t: '存储引擎降级', d: `engine=${h.storage.engine || '—'} · wanted=${h.storage.wanted || '—'} · lastError=${h.storage.lastError || '—'}` });
    }
    if (h.python && h.python.available === false) {
      out.push({ t: 'Python 引擎不可用', d: h.python.reason || 'numpy 不可用' });
    }
    const mdb = h.sources && h.sources.marketDb;
    if (mdb && mdb.readable === false) {
      out.push({ t: '行情库不可读', d: `exists=${mdb.exists} · lastError=${mdb.lastError || '—'}` });
    }
    if (sector && typeof sector.degradedCount === 'number' && sector.degradedCount > 0) {
      out.push({ t: `板块资金数据降级 ${sector.degradedCount} 个`, d: sector.footnote || '资金分位缺失' });
    }
    return out;
  }

  function renderRisk(health, sector) {
    const cell = $('cell-risk');
    if (!health) return; // 拿不到 → 保留 nodata 空态
    cell.classList.add('is-live');

    const risks = collectRisks(health, sector);
    const chip = $('chip-risk');
    if (risks.length) {
      chip.className = 'chip chip-wait';
      chip.textContent = `${risks.length} 条风险`;
    } else {
      chip.className = 'chip chip-fact';
      chip.textContent = '无已知风险';
    }

    $('risk-verdict').firstChild.nodeValue = risks.length ? `发现 ${risks.length} 条数据风险` : '无已知数据风险';
    $('risk-sub').textContent = risks.length
      ? '以下均为 /api/health、/api/sector/strength 的真实降级项'
      : '存储 / Python / 行情库 / 数据源 / 板块均正常';
    $('risk-evid').innerHTML = risks.length
      ? risks.map((r) => `<li><span class="rk"><a href="/lab">${esc(r.t)}</a></span><span class="rd">${esc(r.d)}</span></li>`).join('')
      : '<li><span class="rk">全部正常</span><span class="rd"><a href="/lab">查看数据源健康</a></span></li>';

    $('risk-delta').innerHTML = firstRun('没有昨日风险快照可对比');
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

  /* ---------------- 移动端 ②③④ 折叠 ---------------- */

  function setupFolds() {
    const isMobile = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 767px)').matches;
    ['mainline', 'timing', 'watch'].forEach((k) => {
      const cell = $('cell-' + k);
      const btn = $('fold-btn-' + k);
      if (!cell || !btn) return;
      // 桌面端一律展开；移动端按 HTML 默认（② 展开、③④ 折叠）
      if (!isMobile) cell.classList.remove('is-collapsed');
      const sync = () => {
        const collapsed = cell.classList.contains('is-collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.textContent = collapsed ? '展开' : '收起';
      };
      sync();
      btn.addEventListener('click', () => {
        const now = !cell.classList.contains('is-collapsed');
        cell.classList.toggle('is-collapsed', now);
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

    const [stats, health, sector, wp, summary] = await Promise.all([
      safe('/api/judgment/stats?days=20'),
      safe('/api/health'),
      safe('/api/sector/strength'),
      safe('/api/watchpool'),
      safe('/api/snapshot/summary'),
    ]);

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
    renderEnv(pred);
    renderMainline(pred, sector);
    renderTiming(wp, stats);
    renderWatch(pred, summary);
    renderRisk(health, sector);
    renderRecon(pred, stats);
    renderPlan(pred);

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
