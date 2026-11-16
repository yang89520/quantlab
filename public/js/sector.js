'use strict';
/**
 * 板块详情页 · public/sector.html
 *
 * 设计依据：docs/dev/06 §2.3② 下钻、07 数据可追溯。
 * 原则：
 *  - 所有数字来自真实 API，缺失一律显示「—」或空态，绝不编造/填 0（09 §D5）
 *  - 结论能点回原始值：metrics 逐项列出 API 原始值
 *  - 所有动态值通过 textContent / setAttribute 写入，或经 esc() 转义后
 *    才进 innerHTML，防 XSS；SVG 用 createElementNS + textContent 构建
 *  - 附加接口（history/predict/health）允许失败并降级为空态，不拖垮整页
 */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ---------------- 通用工具 ---------------- */

  // HTML 文本转义：任何 API 字符串进 innerHTML 前必须过这里
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 仅当「数字」或「可安全转成有限数字的字符串」时才视为有效数值；null/''/NaN → null
  const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const isMissing = (v) => v === null || v === undefined
    || (typeof v === 'number' && !Number.isFinite(v));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '接口返回失败');
    return j.data;
  }
  // 附加数据源允许失败并降级为空态
  const safe = (path) => api(path).catch(() => null);

  const GRADE_CN = { A: '主攻', B: '蓄势', C: '修复', D: '退潮' };
  const typeCn = (t) => t === 'industry' ? '行业' : t === 'concept' ? '概念'
    : (t == null || t === '' ? '—' : String(t));

  // 四因子：parts 的四个键，0~100 分位
  const FACTORS = [
    { key: 'momentum', name: '动量', color: 'var(--up)' },
    { key: 'funds', name: '资金', color: 'var(--gold)' },
    { key: 'breadth', name: '宽度', color: 'var(--blue)' },
    { key: 'continuity', name: '连续性', color: 'var(--cyan)' },
  ];
  // metrics 原始值表：逐项列出真实值
  const METRICS = [
    { k: 'ret5', label: '5 日收益', fmt: 'pct' },
    { k: 'ret20', label: '20 日收益', fmt: 'pct' },
    { k: 'ma20', label: '20 日均线（MA20）', fmt: 'pts' },
    { k: 'amountPctile', label: '成交额分位', fmt: 'pct' },
    { k: 'volRatio', label: '量比（5 日 / 20 日）', fmt: 'x' },
    { k: 'netInflowPctile', label: '净流入分位', fmt: 'pct' },
    { k: 'upRatio', label: '上涨占比', fmt: 'pct' },
    { k: 'ztCount', label: '涨停家数', fmt: 'int' },
    { k: 'daysAboveMa20', label: '站上 MA20 天数', fmt: 'int' },
  ];

  /**
   * metrics 显示格式。API 给的是原始比值（ret5=0.0656 表示 6.56%），
   * 直接 String(v) 会渲染出 28502.404574549233 这种一长串小数，
   * 既读不出量级也看不出单位。这里只做「同一个数换写法」，不改口径：
   * 原始值原样放进 title，鼠标悬停可核对（07 数据可追溯）。
   */
  function fmtMetric(fmt, v) {
    const n = toNum(v);
    if (n == null) return '—';
    switch (fmt) {
      case 'pct': return (n * 100).toFixed(2) + '%';
      case 'pts': return n.toFixed(2);
      case 'x': return n.toFixed(2) + '×';
      case 'int': return String(Math.round(n));
      default: return String(n);
    }
  }

  /* ---------------- 取 URL 参数 ---------------- */

  // 板块代码取自 path 末段（GET /sector/:code）
  function sectorCodeFromPath() {
    const seg = location.pathname.split('/').filter(Boolean);
    try { return decodeURIComponent(seg[seg.length - 1] || ''); }
    catch (e) { return ''; }
  }
  function readQuery() {
    const q = new URLSearchParams(location.search);
    const d = q.get('date');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null;
    const rawDays = q.get('days');
    const days = /^\d+$/.test(rawDays || '') && Number(rawDays) > 0
      ? Math.min(120, Number(rawDays)) : 20;
    return { date, days };
  }

  /* ---------------- 状态：错误 / 空态 / 重试 ---------------- */

  function showError(msg) {
    $('content').hidden = true;
    $('empty-notfound').hidden = true;
    $('errbox').hidden = false;
    $('err-text').textContent = '数据加载失败：' + msg;
    $('statusbar').textContent = '加载失败';
  }
  function showNotFound() {
    $('content').hidden = true;
    $('errbox').hidden = true;
    $('empty-notfound').hidden = false;
    $('statusbar').textContent = '未找到该板块';
    $('sec-name').textContent = '未找到该板块';
  }
  function setupRetry() {
    $('btn-retry').addEventListener('click', () => location.reload());
  }

  /* ---------------- 顶部健康状态（/api/health） ---------------- */

  function healthDegraded(h) {
    if (!h) return false;
    if (h.python && h.python.available === false) return true;
    if (h.storage && h.storage.degraded) return true;
    const assets = h.sources && h.sources.assets;
    if (assets && typeof assets === 'object') {
      for (const key of Object.keys(assets)) {
        const a = assets[key];
        if (!a) continue;
        if (a.state === 'degraded') return true;
        if (Array.isArray(a.tripped) && a.tripped.length) return true;
        if (Array.isArray(a.sources)
          && a.sources.some((s) => s && (s.state === 'down' || s.trippedUntil))) return true;
      }
    }
    return false;
  }
  function renderHealth(health) {
    const el = $('hd-status');
    if (!health) { el.innerHTML = '<span class="tag">健康状态未取到</span>'; return; }
    const bits = [];
    if (healthDegraded(health)) {
      bits.push('<span class="tag warn"><span class="dot warn" aria-hidden="true"></span>部分数据源降级</span>');
    } else {
      bits.push('<span class="tag ok"><span class="dot" aria-hidden="true"></span>服务在线</span>');
    }
    const meta = [
      health.version != null && health.version !== '' ? 'v' + String(health.version) : '',
      typeof health.uptimeSec === 'number' && Number.isFinite(health.uptimeSec)
        ? '运行 ' + Math.round(health.uptimeSec / 60) + ' 分' : '',
    ].filter(Boolean).join(' · ');
    if (meta) bits.push('<span class="tag">' + esc(meta) + '</span>');
    el.innerHTML = bits.join('');
  }

  /* ---------------- 标题区 ---------------- */

  function renderHeader(sec, code) {
    const name = sec.name != null && sec.name !== '' ? String(sec.name) : String(code);
    $('sec-name').textContent = name;
    document.title = name + ' · 板块详情 · QuantLab';

    const g = sec.grade == null ? null : String(sec.grade).toUpperCase();
    const gb = $('grade-badge');
    gb.textContent = g ? g + ' ' + (GRADE_CN[g] || '') : '—';
    gb.className = 'grade-badge ' + (g ? 'grade-' + g.toLowerCase() : 'grade-none');

    $('sec-type').textContent = '类型：' + typeCn(sec.type);
    // stale=true：当天还没跑收盘流程，给的是库内最新一天。
    // 必须写在「数据时点」旁边，否则用户会拿旧榜当今天的榜看（D3）。
    const staleTag = sec.stale
      ? ' · 今日未更新（收盘后自动刷新）'
      : '';
    $('sec-date').textContent = '数据时点：'
      + (sec.date != null && sec.date !== '' ? String(sec.date) : '—') + staleTag;
  }

  /* ---------------- 概览：分数 + 是否今日主线 + 降级角标 ---------------- */

  // 在预判卡 mainline 里找该板块：sectors + byType.industry + byType.concept
  function inMainline(pred, keys) {
    const ml = pred && pred.mainline;
    if (!ml || typeof ml !== 'object') return 'unknown';
    const hasArrays = Array.isArray(ml.sectors)
      || (ml.byType && (Array.isArray(ml.byType.industry) || Array.isArray(ml.byType.concept)));
    if (!hasArrays) return 'unknown';
    const set = new Set();
    const add = (arr) => {
      if (Array.isArray(arr)) arr.forEach((x) => { if (x && x.code != null) set.add(String(x.code)); });
    };
    add(ml.sectors);
    if (ml.byType) { add(ml.byType.industry); add(ml.byType.concept); }
    for (const k of keys) if (set.has(k)) return 'yes';
    return 'no';
  }
  function renderOverview(sec, pred, keys) {
    const s = toNum(sec.score);
    $('ov-score').textContent = s == null ? '—' : String(s);

    const state = inMainline(pred, keys);
    const ml = $('ml-tag');
    if (state === 'yes') { ml.className = 'ml-tag ml-yes'; ml.textContent = '● 在今日主线'; }
    else if (state === 'no') { ml.className = 'ml-tag ml-no'; ml.textContent = '未进入今日主线'; }
    else { ml.className = 'ml-tag ml-unknown'; ml.textContent = '主线数据未取到'; }
  }

  /* ---------------- 四因子拆解（role=progressbar） ---------------- */

  function renderFactors(sec) {
    const parts = sec.parts || {};
    $('factor-list').innerHTML = FACTORS.map((f) => {
      const n = toNum(parts[f.key]);
      const has = n != null;
      const valText = has ? String(n) : '—';
      const width = has ? clamp(n, 0, 100) : 0;
      // 有真实值：确定进度条，aria-valuenow/min/max 齐全。
      // 缺失值：可见数值为「—」而非 0；进度条为空态（虚线轨道），
      // aria-valuetext 明确告知「无数据」，避免把 0 当成真实分数播报。
      const ariaNow = ' aria-valuenow="' + (has ? String(n) : '0') + '"';
      const ariaText = has ? '' : ' aria-valuetext="' + esc(f.name + ' 无数据') + '"';
      return '<li class="factor-row">'
        + '<div class="factor-top">'
        + '<span class="factor-name">' + esc(f.name) + '</span>'
        + '<span class="factor-val num' + (has ? '' : ' muted') + '">' + esc(valText) + '</span>'
        + '</div>'
        + '<div class="progress' + (has ? '' : ' is-empty') + '" role="progressbar"'
        + ' aria-valuemin="0" aria-valuemax="100"' + ariaNow + ariaText
        + ' aria-label="' + esc(f.name) + '">'
        + '<div class="progress-fill" style="width:' + width + '%;background:' + f.color + '"></div>'
        + '</div>'
        + '</li>';
    }).join('');
  }

  /* ---------------- 20 日强度走势（SVG 折线） ---------------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function drawSpark(svg, pts) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = 600, H = 180, pad = 30;
    const n = pts.length;
    const vals = pts.map((p) => p.score);
    const mn = Math.min.apply(null, vals);
    const mx = Math.max.apply(null, vals);
    const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (W - 2 * pad) * i / (n - 1));
    const y = (v) => mx === mn ? H / 2 : (H - pad) - (v - mn) / (mx - mn) * (H - 2 * pad);

    // 水平网格线 + 刻度（数值经 String 写入 textContent，天然安全）
    [mx, (mx + mn) / 2, mn].forEach((v) => {
      const gy = y(v);
      svg.appendChild(svgEl('line', {
        x1: pad, y1: gy, x2: W - pad, y2: gy,
        style: 'stroke:var(--line2);stroke-dasharray:3 4',
      }));
      const t = svgEl('text', { x: pad - 6, y: gy + 4, 'text-anchor': 'end', class: 'spark-yl' });
      t.textContent = String(Math.round(v * 100) / 100);
      svg.appendChild(t);
    });

    const linePts = pts.map((p, i) => x(i) + ',' + y(p.score)).join(' ');

    // 面积
    svg.appendChild(svgEl('polygon', {
      points: pad + ',' + (H - pad) + ' ' + linePts + ' ' + (W - pad) + ',' + (H - pad),
      style: 'fill:var(--up);fill-opacity:.08',
    }));
    // 折线
    svg.appendChild(svgEl('polyline', {
      points: linePts,
      style: 'fill:none;stroke:var(--up);stroke-width:2;stroke-linejoin:round;stroke-linecap:round',
    }));
    // 数据点 + 悬浮标题（textContent）
    pts.forEach((p, i) => {
      const last = i === n - 1;
      const c = svgEl('circle', {
        cx: x(i), cy: y(p.score), r: last ? 4 : 2.5,
        style: 'fill:' + (last ? 'var(--up2)' : 'var(--up)') + ';stroke:var(--bg2);stroke-width:1',
      });
      const ttl = svgEl('title');
      ttl.textContent = p.date + ' · ' + String(p.score);
      c.appendChild(ttl);
      svg.appendChild(c);
    });
    // X 轴首末日期
    const l = svgEl('text', { x: pad, y: H - 6, class: 'spark-xl' });
    l.textContent = pts[0].date;
    svg.appendChild(l);
    const r = svgEl('text', { x: W - pad, y: H - 6, 'text-anchor': 'end', class: 'spark-xl' });
    r.textContent = pts[n - 1].date;
    svg.appendChild(r);

    // setAttribute 写入属性字符串不解析 HTML，天然安全，无需转义
    svg.setAttribute('aria-label', '20 日强度走势折线：共 ' + n + ' 个数据点，'
      + pts[0].date + ' 为 ' + pts[0].score + '，' + pts[n - 1].date + ' 为 ' + pts[n - 1].score
      + '，区间 ' + mn + ' 至 ' + mx);
  }
  function renderTrend(hist, keys) {
    const wrap = $('spark-wrap');
    const empty = $('trend-empty');
    const svg = $('spark');
    const sub = $('trend-sub');
    const rows = hist && Array.isArray(hist.rows) ? hist.rows : [];
    const pts = rows
      .filter((r) => r && keys.has(String(r.sector)) && !isMissing(r.score) && toNum(r.score) != null)
      .map((r) => ({ date: String(r.date), score: toNum(r.score) }))
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    if (pts.length < 2) {
      // 数据点不足：显示「历史数据不足」，绝不画假图
      wrap.hidden = true;
      empty.hidden = false;
      sub.textContent = '共 ' + pts.length + ' 个有效数据点';
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;
    drawSpark(svg, pts);
    sub.textContent = '共 ' + pts.length + ' 个数据点 · ' + pts[0].date + ' ~ ' + pts[pts.length - 1].date;
  }

  /* ---------------- metrics 原始值表 ---------------- */

  function renderMetrics(sec) {
    const m = sec.metrics || {};
    $('metric-tbody').innerHTML = METRICS.map((it) => {
      const v = m[it.k];
      const missing = isMissing(v);
      // title 留原始值：显示可以好看，但必须能点回去核对（07 数据可追溯）
      const raw = missing ? '' : String(v);
      const text = fmtMetric(it.fmt, v);
      let cls = 'r raw-val';
      if (missing) cls += ' muted';
      else if (it.k === 'ret5' || it.k === 'ret20') {
        const n = toNum(v);
        if (n != null && n > 0) cls += ' up';       // 涨红
        else if (n != null && n < 0) cls += ' dn';  // 跌绿
      }
      return '<tr>'
        + '<th scope="row">' + esc(it.label) + '</th>'
        + '<td class="field-name"><code>' + esc(it.k) + '</code></td>'
        + '<td class="' + cls + '"'
        + (missing ? '' : ' title="API 原始值：' + esc(raw) + '"')
        + '>' + esc(text) + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ---------------- 成分股（真实代码，点跳分析台） ---------------- */

  function renderMembers(sec) {
    const list = Array.isArray(sec.members) ? sec.members : [];
    const mc = sec.memberCount;
    $('member-count').textContent = '共 '
      + (typeof mc === 'number' && Number.isFinite(mc) ? String(mc) : '—') + ' 只';
    $('member-list').innerHTML = list.length
      ? list.map((c) => {
          const code = String(c == null ? '' : c);
          // data-back：点进分析台后能用「← 返回」回到这个板块页的原滚动位置（06 §5.2）
          return '<li><a href="/?code=' + encodeURIComponent(code)
            + '" data-back="sector">' + esc(code) + '</a></li>';
        }).join('')
      : '<li class="member-empty">— 暂无成分股数据 —</li>';
  }

  /* ---------------- 脚注：幸存者偏差 / 降级 / 分位口径 ---------------- */

  function renderNotes(sec) {
    // 幸存者偏差脚注：显示 footnote 原文
    $('footnote-text').textContent = sec.footnote != null && sec.footnote !== ''
      ? String(sec.footnote) : '—';
    // 分位口径
    $('scope-text').textContent = sec.pctileScope != null && sec.pctileScope !== ''
      ? String(sec.pctileScope) : '—';
    // 降级角标 + degradeReason 原始值
    const deg = sec.degraded === true;
    $('deg-corner').hidden = !deg;
    $('degrade-box').hidden = !deg;
    $('degrade-foot-text').textContent = deg
      ? (sec.degradeReason != null && sec.degradeReason !== '' ? String(sec.degradeReason) : '—')
      : '—';
  }

  /* ---------------- 主流程 ---------------- */

  async function boot() {
    setupRetry();
    // 健康状态与主请求独立，允许失败降级
    safe('/api/health').then(renderHealth);

    const code = sectorCodeFromPath();
    if (!code) { showNotFound(); return; }
    const qry = readQuery();
    const sectorPath = '/api/sector/' + encodeURIComponent(code)
      + (qry.date ? '?date=' + encodeURIComponent(qry.date) : '');

    let sec = null;
    try {
      sec = await api(sectorPath);
    } catch (e) {
      showError(e && e.message ? e.message : '未知错误');
      return;
    }
    if (sec == null) { showNotFound(); return; } // data:null → 未找到该板块

    // 附加数据并行取，允许失败并降级为空态
    const [hist, pred] = await Promise.all([
      safe('/api/sector/history?days=' + qry.days),
      safe('/api/predict/today'),
    ]);

    // 历史/预判里的板块代码用 API 的规范代码与 URL 代码双重匹配
    const keys = new Set([String(code)]);
    if (sec.sector != null) keys.add(String(sec.sector));

    renderHeader(sec, code);
    renderOverview(sec, pred, keys);
    renderFactors(sec);
    renderTrend(hist, keys);
    renderMetrics(sec);
    renderMembers(sec);
    renderNotes(sec);

    $('statusbar').textContent = '数据已加载 · 数据时点 '
      + (sec.date != null && sec.date !== '' ? String(sec.date) : '—')
      + (sec.stale ? '（今日未更新，收盘后自动刷新）' : '');
    $('errbox').hidden = true;
    $('empty-notfound').hidden = true;
    $('content').hidden = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
