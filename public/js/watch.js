'use strict';
/**
 * 观察池 · public/watch.html  (docs/dev/06 §3)
 *
 * 原则：
 *  - 所有标的/数量/分数/文案数据来自 /api/*，拿不到显示「—」或空态，绝不写死或编造
 *  - 所有用户输入与接口文本一律经 esc() 转义后再进 innerHTML，防 XSS
 *  - 原生 JS，无框架、无构建；单文件 IIFE + 局部 state
 */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ---------------- 工具 ---------------- */

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) {
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  }

  /** 统一处理 {ok,data} / {ok:false,error}；支持 GET/POST/PATCH/DELETE + JSON body */
  async function api(path, opts) {
    opts = opts || {};
    const init = { headers: { accept: 'application/json' } };
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, init);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '接口返回失败');
    return j.data;
  }

  function announce(msg) {
    const d = document.createElement('div');
    d.setAttribute('role', 'status');
    d.className = 'sr-only';
    d.textContent = msg;               // 纯文本，天然安全
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1800);
  }

  /* ---------------- 局部 state ---------------- */

  const state = {
    data: null,        // /api/watchpool 的 data
    byCode: {},        // code -> entry（本地缓存，供抽屉/操作取用）
    sectorMap: {},     // 板块代码 -> {name, grade}（来自 /api/sector/strength，可选增强）
    filter: 'all',
  };
  let lastFocus = null;   // 打开对话框前的焦点，关闭后还原
  let rmCode = null;      // 当前待移出的代码
  let drawerToken = 0;    // 防止异步时间轴回填到已关闭/已切换的抽屉

  // 固定 UI 术语（状态/原因枚举），不是业务数据
  const STATE_META = {
    watching:  { label: '待观察',   cls: 'st-watching' },
    ambush:    { label: '埋伏',     cls: 'st-ambush' },
    confirmed: { label: '启动确认', cls: 'st-confirmed' },
    holding:   { label: '持有',     cls: 'st-holding' },
    removed:   { label: '已移出',   cls: 'st-removed' },
  };
  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'watching', label: '待观察' },
    { key: 'ambush', label: '埋伏' },
    { key: 'confirmed', label: '启动确认' },
    { key: 'holding', label: '持有' },
    { key: 'removed', label: '已移出' },
  ];
  const REMOVE_KEYS = ['logic_broken', 'too_slow', 'replaced', 'wrong'];
  const REMOVE_HELP = {
    logic_broken: '触发了失效条件，如放量跌破 MA20',
    too_slow: '超过最长停留天数仍未启动',
    replaced: '池内出现更强标的，主动换仓',
    wrong: '当初入池的理由本身站不住',
  };
  const REASON_FALLBACK = {
    logic_broken: '逻辑破了', too_slow: '触发太慢', replaced: '被替代', wrong: '我判断错了',
  };

  function stateInfo(s) {
    return STATE_META[s] || { label: (s == null ? '—' : String(s)), cls: 'st-draft' };
  }
  function reasonLabel(k) {
    if (!k) return '—';
    const r = state.data && state.data.reasons;
    if (r && r[k]) return String(r[k]);   // 优先用接口返回的真实文案
    return REASON_FALLBACK[k] || String(k);
  }

  /* ---------------- 数值格式化（全部来自真实字段） ---------------- */

  function fmtStay(e) {
    const d = isNum(e.daysInState) ? Number(e.daysInState) : null;
    const m = isNum(e.maxStay) ? Number(e.maxStay) : null;
    if (d !== null && m !== null) return d + ' / ' + m + ' 天';
    if (d !== null) return d + ' 天';
    return '—';
  }
  function stayHTML(e) {
    const d = isNum(e.daysInState) ? Number(e.daysInState) : null;
    const m = isNum(e.maxStay) ? Number(e.maxStay) : null;
    const near = (d !== null && m !== null && m > 0 && d / m > 0.8);
    return '<b' + (near ? ' class="stay-near"' : '') + '>' + esc(fmtStay(e)) + '</b>';
  }
  function chgHTML(v) {
    if (!isNum(v)) return '<span class="chg chg-flat">—</span>';
    const n = Number(v);
    const cls = n > 0 ? 'chg-up' : n < 0 ? 'chg-dn' : 'chg-flat';
    const txt = (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    return '<span class="chg ' + cls + '">' + esc(txt) + '</span>';
  }
  /** 「错在哪」只在 removeReason==='wrong' 且 wrongDetail 非空时返回内容，否则空串 */
  function wrongDetailHTML(e) {
    if (e.removeReason === 'wrong' && e.wrongDetail && String(e.wrongDetail).trim()) {
      return esc(String(e.wrongDetail));
    }
    return '';
  }
  /** 板块徽标：能查到板块榜就显示名称+档位，否则退回真实代码，绝不编造 */
  function sectorChip(code) {
    if (code === null || code === undefined || code === '') return '<b>—</b>';
    const info = state.sectorMap[String(code)];
    if (info) {
      const g = info.grade;
      const cls = (g === 'A' ? 'chip-a' : g === 'B' ? 'chip-b' : g === 'C' ? 'chip-c' : g === 'D' ? 'chip-d' : 'chip-c');
      return '<span class="chip ' + cls + '" style="margin:0">'
        + esc(info.name || code) + (g ? ' · ' + esc(g) : '') + '</span>';
    }
    return '<b>' + esc(code) + '</b>';
  }

  /* ---------------- 计数 / tabs / 计数条 ---------------- */

  function counts() {
    const g = (state.data && state.data.groups) || {};
    const len = (k) => Array.isArray(g[k]) ? g[k].length : 0;
    const active = len('watching') + len('ambush') + len('confirmed') + len('holding');
    return {
      all: active, watching: len('watching'), ambush: len('ambush'),
      confirmed: len('confirmed'), holding: len('holding'), removed: len('removed'),
    };
  }

  function renderTabs() {
    const c = counts();
    FILTERS.forEach(function (f) {
      const btn = $('tab-' + f.key);
      const cnt = $('cnt-' + f.key);
      if (!btn || !cnt) return;
      cnt.textContent = String(c[f.key]);
      const sel = f.key === state.filter;
      btn.setAttribute('aria-selected', sel ? 'true' : 'false');
      btn.setAttribute('tabindex', sel ? '0' : '-1');
    });
    const panel = $('watch-panel');
    if (panel) panel.setAttribute('aria-labelledby', 'tab-' + state.filter);
  }

  function renderTally() {
    const c = counts();
    const max = state.data && isNum(state.data.maxSize) ? Number(state.data.maxSize) : null;
    $('pt-n').textContent = String(c.all);                       // 在池 N（按真实分组计算）
    $('pt-of').textContent = '/ ' + (max !== null ? String(max) : '—');
    const total = state.data && isNum(state.data.total) ? Number(state.data.total) : null;
    const bits = [];
    if (total !== null) bits.push('累计记录 ' + total + ' 条');
    bits.push('移出 ' + c.removed + ' 只');
    $('pt-sub').textContent = bits.join(' · ');
  }

  function renderPageSub() {
    const c = counts();
    $('page-sub').textContent = '共 ' + c.all + ' 只在池 · 累计移出 ' + c.removed + ' 只';
  }

  /* ---------------- 列表渲染 ---------------- */

  function currentEntries() {
    const g = (state.data && state.data.groups) || {};
    const pick = (k) => Array.isArray(g[k]) ? g[k].slice() : [];
    if (state.filter === 'all') {
      return [].concat(pick('watching'), pick('ambush'), pick('confirmed'), pick('holding'));
    }
    return pick(state.filter);
  }

  function emptyStateHTML() {
    return '<div class="empty-state">'
      + '<div class="es-ico" aria-hidden="true">◎</div>'
      + '<h2>观察池还是空的</h2>'
      + '<p>当板块强度榜单出现 A / B 档板块，且个股综合评分达到入池门槛时，标的会进入这里。'
      + '入池后的状态流转、失效条件与移出原因都会被记录，用来复盘判断力。</p>'
      + '</div>';
  }

  function actionHTML(e, includeRemove) {
    const nm = esc((e.name ? e.name + ' · ' : '') + (e.code || ''));
    const desk = ''
      + '<button type="button" class="btn btn-sm" data-action="detail" aria-label="查看详情 ' + nm + '">详情</button>'
      + '<button type="button" class="btn btn-sm" data-action="note" aria-label="给 ' + nm + ' 加备注">加备注</button>'
      + (includeRemove ? '<button type="button" class="btn btn-sm btn-danger" data-action="remove" aria-label="移出 ' + nm + '">移出</button>' : '');
    const menu = ''
      + '<span class="menu-wrap">'
      + '<button type="button" class="kebab" aria-haspopup="menu" aria-expanded="false" aria-label="更多操作 ' + nm + '">⋯</button>'
      + '<span class="menu" role="menu" data-open="false">'
      + '<button type="button" role="menuitem" data-action="detail">查看详情</button>'
      + '<button type="button" role="menuitem" data-action="note">加备注</button>'
      + (includeRemove ? '<button type="button" role="menuitem" class="danger" data-action="remove">移出观察池</button>' : '')
      + '</span></span>';
    return desk + menu;
  }

  function rowHTML(e) {
    const removed = e.state === 'removed';
    const si = stateInfo(e.state);
    const meta = [];
    meta.push('<span>入池理由：<b>' + esc(e.entryReason || '—') + '</b></span>');
    meta.push('<span>板块：' + sectorChip(e.sector) + '</span>');
    meta.push('<span>停留：' + stayHTML(e) + '</span>');
    if (isNum(e.score)) meta.push('<span>评分：<b>' + esc(String(Number(e.score))) + '</b></span>');
    meta.push('<span>备注：<b>' + esc(e.note && String(e.note).trim() ? String(e.note) : '—') + '</b></span>');
    if (removed) {
      meta.push('<span>移出原因：<b>' + esc(reasonLabel(e.removeReason)) + '</b></span>');
      meta.push('<span>移出时涨跌：' + chgHTML(e.removeChg) + '</span>');
      const wd = wrongDetailHTML(e);
      if (wd) meta.push('<span>错在哪：<b>' + wd + '</b></span>');   // 仅 wrong 且非空才显示
    }
    return '<div class="row" data-code="' + esc(e.code) + '" role="listitem">'
      + '<div class="r-main">'
      + '<span class="r-code num">' + esc(e.code) + '</span>'
      + '<span class="r-name">' + esc(e.name || '—') + '</span>'
      + '<span class="st ' + si.cls + '">' + esc(si.label) + '</span>'
      + '</div>'
      + '<div class="act">' + actionHTML(e, !removed) + '</div>'
      + '<div class="r-meta">' + meta.join('') + '</div>'
      + '</div>';
  }

  function renderList() {
    const region = $('list-region');
    const total = state.data && isNum(state.data.total) ? Number(state.data.total) : 0;
    if (total === 0) { region.innerHTML = emptyStateHTML(); return; }
    const arr = currentEntries();
    if (!arr.length) {
      region.innerHTML = '<div class="empty-state"><h2>该分类下暂无标的</h2><p>试试切换其他状态标签。</p></div>';
      return;
    }
    region.innerHTML = '<div class="list" role="list" aria-label="观察池标的">'
      + arr.map(rowHTML).join('') + '</div>';
  }

  function renderAll() {
    renderTabs();
    renderTally();
    renderPageSub();
    renderList();
  }

  /* ---------------- 详情抽屉：各区块 ---------------- */

  function summaryHTML(e) {
    const si = stateInfo(e.state);
    const items = [];
    items.push(['状态', '<span class="st ' + si.cls + '">' + esc(si.label) + '</span>']);
    items.push(['入池理由', esc(e.entryReason || '—')]);
    items.push(['板块', sectorChip(e.sector)]);
    items.push(['停留交易日', stayHTML(e)]);
    items.push(['综合评分', isNum(e.score) ? esc(String(Number(e.score))) : '—']);
    items.push(['备注', esc(e.note && String(e.note).trim() ? String(e.note) : '—')]);
    if (e.state === 'removed') {
      items.push(['移出原因', esc(reasonLabel(e.removeReason))]);
      items.push(['移出时涨跌', chgHTML(e.removeChg)]);
      const wd = wrongDetailHTML(e);
      if (wd) items.push(['错在哪', wd]);
    }
    return '<dl class="dr-summary">' + items.map(function (it) {
      return '<div><dt>' + esc(it[0]) + '</dt><dd>' + it[1] + '</dd></div>';
    }).join('') + '</dl>';
  }

  /** 用 snapshots 的 close 画 SVG 折线 + 均线；数据不足显示「走势数据不足」而非假图 */
  function sparkHTML(snaps) {
    const valid = (Array.isArray(snaps) ? snaps : []).filter(function (s) {
      return s && isNum(s.close);
    });
    const closes = valid.map(function (s) { return Number(s.close); });
    if (closes.length < 2) return '<p class="chart-empty">走势数据不足</p>';
    const W = 280, H = 84, padX = 4, padTop = 6, padBot = 10;
    let min = Infinity, max = -Infinity;
    closes.forEach(function (v) { if (v < min) min = v; if (v > max) max = v; });
    const span = (max - min) || 1;
    const n = closes.length;
    const X = (i) => padX + (i / (n - 1)) * (W - 2 * padX);
    const Y = (v) => padTop + (1 - (v - min) / span) * (H - padTop - padBot);
    const line = closes.map(function (v, i) {
      return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
    }).join(' ');
    const area = line + ' L' + X(n - 1).toFixed(1) + ' ' + (H - padBot)
      + ' L' + X(0).toFixed(1) + ' ' + (H - padBot) + ' Z';
    // 均线：对真实收盘价做窗口 min(20,n) 的滚动均值，按可用点数诚实标注，不冒充 20 日数据
    const win = Math.min(20, n);
    const ma = closes.map(function (v, i) {
      const from = Math.max(0, i - win + 1);
      let s = 0;
      for (let k = from; k <= i; k++) s += closes[k];
      return s / (i - from + 1);
    });
    const maLine = ma.map(function (v, i) {
      return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
    }).join(' ');
    const first = closes[0], last = closes[n - 1];
    const trend = last > first ? '整体上行' : last < first ? '整体下行' : '基本走平';
    const d0 = valid[0] && valid[0].date ? esc(String(valid[0].date)) : '—';
    const d1 = valid[n - 1] && valid[n - 1].date ? esc(String(valid[n - 1].date)) : '—';
    const maLabel = '均线 MA' + win;
    return '<div class="spark-wrap">'
      + '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" '
      + 'aria-label="入池以来收盘价走势，' + esc(trend) + '，共 ' + n + ' 个交易日">'
      + '<path d="' + area + '" fill="rgba(246,70,93,.10)"/>'
      + '<path d="' + line + '" fill="none" stroke="#F6465D" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<path d="' + maLine + '" fill="none" stroke="#6BA5FF" stroke-width="1.2" stroke-dasharray="3 2" opacity=".9"/>'
      + '</svg>'
      + '<div class="spark-legend">'
      + '<span><i class="lg-close" aria-hidden="true"></i>收盘价</span>'
      + '<span><i class="lg-ma" aria-hidden="true"></i>' + esc(maLabel) + '</span>'
      + '<span class="spark-range">' + d0 + ' → ' + d1 + '</span>'
      + '</div></div>';
  }

  function invalidHTML(e) {
    const inv = Array.isArray(e.invalidIf) ? e.invalidIf : [];
    if (!inv.length) return '<p class="chart-empty">暂无失效条件</p>';
    return '<ul class="inv-list">' + inv.map(function (x) {
      if (x && typeof x === 'object') {
        const desc = x.desc != null ? x.desc : '';
        const extra = x.metric
          ? '（' + esc(x.metric) + ' ' + esc(x.op || '') + ' ' + esc(x.ref || '') + '）' : '';
        return '<li>' + esc(desc) + extra + '</li>';
      }
      return '<li>' + esc(x) + '</li>';
    }).join('') + '</ul>';
  }

  function peersHTML(e) {
    const list = (state.data && state.data.list) || [];
    const peers = list.filter(function (x) {
      return x && x.state !== 'removed' && String(x.code) !== String(e.code)
        && e.sector && String(x.sector) === String(e.sector);
    });
    if (!peers.length) return '<p class="chart-empty">同板块暂无其它在池标的</p>';
    return '<div class="tbl-wrap"><table class="tbl">'
      + '<caption class="sr-only">同板块其它在池标的</caption>'
      + '<thead><tr><th>代码</th><th>名称</th><th>状态</th><th class="r">评分</th></tr></thead><tbody>'
      + peers.map(function (p) {
        const si = stateInfo(p.state);
        return '<tr><td class="muted num">' + esc(p.code) + '</td>'
          + '<td class="strong">' + esc(p.name || '—') + '</td>'
          + '<td><span class="st ' + si.cls + '">' + esc(si.label) + '</span></td>'
          + '<td class="r">' + (isNum(p.score) ? esc(String(Number(p.score))) : '—') + '</td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  function fmtAt(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 时间轴：from→to、trigger、evidences 的 k/v 原始值、reason */
  function timelineHTML(list) {
    if (!Array.isArray(list) || !list.length) return '<p class="chart-empty">暂无状态迁移记录</p>';
    return '<div class="timeline">' + list.map(function (t, i) {
      const from = (t.from == null || t.from === '') ? '入池' : stateInfo(t.from).label;
      const to = stateInfo(t.to).label;
      const ev = Array.isArray(t.evidences) ? t.evidences.map(function (x) {
        return '<span>' + esc(x.k) + '：' + esc(x.v) + '</span>';
      }).join('') : '';
      return '<div class="tl-item">'
        + '<span class="tl-dot' + (i === list.length - 1 ? ' on' : '') + '" aria-hidden="true">' + (i + 1) + '</span>'
        + '<div class="tl-body">'
        + '<div class="t">' + esc(from) + ' → ' + esc(to) + '</div>'
        + '<div class="d">' + esc(fmtAt(t.at)) + '</div>'
        + '<div class="e"><span>触发：' + esc(t.trigger == null ? '—' : t.trigger) + '</span>'
        + (t.reason ? '<span>原因：' + esc(t.reason) + '</span>' : '') + '</div>'
        + (ev ? '<div class="e tl-ev">' + ev + '</div>' : '')
        + '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------------- 焦点还原 ---------------- */

  function restoreFocus() {
    const el = lastFocus;
    lastFocus = null;
    // 只还原到真正可聚焦的元素（点击行空白处时 trigger 是 div，focus() 是空操作）
    const focusable = el && document.body.contains(el) && typeof el.focus === 'function'
      && (el.tabIndex >= 0 || /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
    if (focusable) { el.focus(); return; }
    const active = $('tab-' + state.filter);
    if (active && typeof active.focus === 'function') { active.focus(); return; }
    const m = $('main');
    if (m && typeof m.focus === 'function') m.focus();
  }

  /* ---------------- 打开抽屉 ---------------- */

  function openDrawer(code, opts) {
    const key = String(code);
    const e = state.byCode[key];
    if (!e) return;
    opts = opts || {};
    const token = ++drawerToken;
    lastFocus = opts.trigger || document.activeElement;

    const drawer = $('drawer');
    const body = $('drawer-body');
    $('drawer-title').textContent = (e.name ? e.name + ' · ' : '') + key;  // textContent 安全
    body.innerHTML = ''
      + '<section class="dr-section"><h3 class="sect-h">标的信息</h3>' + summaryHTML(e) + '</section>'
      + '<section class="dr-section"><h3 class="sect-h">入池以来走势（收盘价 / 均线）</h3>' + sparkHTML(e.snapshots) + '</section>'
      + '<section class="dr-section"><h3 class="sect-h">状态时间轴</h3>'
      + '<div id="tl-region"><p class="chart-empty">正在加载迁移记录…</p></div></section>'
      + '<section class="dr-section"><h3 class="sect-h">当前失效条件</h3>' + invalidHTML(e) + '</section>'
      + '<section class="dr-section"><h3 class="sect-h">同板块其它在池标的</h3>' + peersHTML(e) + '</section>'
      + '<section class="dr-section note-editor"><h3 class="sect-h">加备注</h3>'
      + '<label class="sr-only" for="note-input">备注内容</label>'
      + '<textarea class="note-input" id="note-input" rows="3" placeholder="记一条观察笔记…"></textarea>'
      + '<div class="note-ft">'
      + '<button type="button" class="btn btn-primary" id="note-save">保存备注</button>'
      + '<span class="note-status" id="note-status" role="status" aria-live="polite"></span>'
      + '</div></section>';

    // 备注初值用 value，避免任何 HTML 注入
    const ni = body.querySelector('#note-input');
    ni.value = e.note ? String(e.note) : '';

    drawer.showModal();                 // 原生 modal：自带焦点陷阱与 ESC
    body.scrollTop = 0;
    $('drawer-close').focus();          // 打开时焦点移入
    if (opts.focusNote) ni.focus();

    // 保存备注 → PATCH
    const saveBtn = body.querySelector('#note-save');
    const status = body.querySelector('#note-status');
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      status.textContent = '保存中…';
      try {
        const val = ni.value;
        await api('/api/watchpool/' + encodeURIComponent(key), { method: 'PATCH', body: { note: val } });
        e.note = val;                   // 同步本地缓存
        status.textContent = '已保存';
        renderList();                   // 同步列表中的备注（抽屉保持打开）
      } catch (err) {
        status.textContent = '保存失败：' + (err && err.message ? err.message : '未知错误');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // 时间轴异步加载，token 防止回填到已关闭/已切换的抽屉
    const tl = body.querySelector('#tl-region');
    api('/api/watchpool/transitions?code=' + encodeURIComponent(key))
      .then(function (d) {
        if (token !== drawerToken || !drawer.open) return;
        tl.innerHTML = timelineHTML(d && d.list);
      })
      .catch(function (err) {
        if (token !== drawerToken || !drawer.open) return;
        tl.innerHTML = '<p class="chart-empty">迁移记录加载失败：'
          + esc(err && err.message ? err.message : '') + '</p>';
      });
  }

  /* ---------------- 移出 ---------------- */

  function buildReasonRadios() {
    $('rm-reasons').innerHTML = '<legend>移出原因（必选，四选一）</legend>'
      + REMOVE_KEYS.map(function (k) {
        return '<label class="opt">'
          + '<input type="radio" name="rm-reason" value="' + esc(k) + '">'
          + '<span class="txt"><span class="t">' + esc(reasonLabel(k)) + '</span>'
          + '<span class="d">' + esc(REMOVE_HELP[k] || '') + '</span></span>'
          + '</label>';
      }).join('');
  }

  function openRemoveDialog(code, trigger) {
    const key = String(code);
    const e = state.byCode[key];
    if (!e) return;
    rmCode = key;
    lastFocus = trigger || document.activeElement;
    $('rm-target').textContent = (e.name ? e.name + ' · ' : '') + key;   // textContent 安全
    buildReasonRadios();
    $('rm-wrong').value = '';
    $('rm-wrong-wrap').hidden = true;
    $('rm-err').classList.remove('on');
    $('rm-err').textContent = '请先选择一个移出原因';
    const rm = $('rm');
    rm.showModal();
    const first = rm.querySelector('input[name="rm-reason"]');
    if (first) first.focus();           // 打开时焦点移入；无默认选中
  }

  async function onRemoveConfirm() {
    const rm = $('rm');
    const picked = rm.querySelector('input[name="rm-reason"]:checked');
    if (!picked) {                       // 未选不许提交
      $('rm-err').classList.add('on');
      const f = rm.querySelector('input[name="rm-reason"]');
      if (f) f.focus();
      return;
    }
    const reason = picked.value;
    const payload = { reason: reason };  // reason 必填四选一
    if (reason === 'wrong') {
      const wd = $('rm-wrong').value.trim();
      if (wd) payload.wrongDetail = wd;
    }
    const okBtn = $('rm-ok');
    okBtn.disabled = true;
    try {
      await api('/api/watchpool/' + encodeURIComponent(rmCode), { method: 'DELETE', body: payload });
      const name = state.byCode[rmCode] ? state.byCode[rmCode].name : rmCode;
      state.filter = 'removed';         // 移出后落到「已移出」tab
      lastFocus = null;                 // 行将被重绘，改用 tab 作为焦点还原点
      rm.close();
      announce('已移出 ' + (name || rmCode) + '，原因：' + reasonLabel(reason));
      await refresh();                  // 重新取数，刷新列表（含 removeChg）
    } catch (err) {
      $('rm-err').textContent = '移出失败：' + (err && err.message ? err.message : '未知错误');
      $('rm-err').classList.add('on');
    } finally {
      okBtn.disabled = false;
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function closeMenus() {
    const open = document.querySelectorAll('.menu[data-open="true"]');
    Array.prototype.forEach.call(open, function (m) {
      m.setAttribute('data-open', 'false');
      const wrap = m.closest('.menu-wrap');
      const k = wrap ? wrap.querySelector('.kebab') : null;
      if (k) k.setAttribute('aria-expanded', 'false');
    });
  }

  function initListEvents() {
    const region = $('list-region');
    region.addEventListener('click', function (ev) {
      const t = ev.target;
      const closest = (sel) => (t.closest ? t.closest(sel) : null);
      const actionBtn = closest('[data-action]');
      const kebab = closest('.kebab');
      const row = closest('.row');

      if (actionBtn) {
        ev.stopPropagation();
        closeMenus();
        const code = row ? row.getAttribute('data-code') : null;
        if (!code) return;
        const a = actionBtn.getAttribute('data-action');
        if (a === 'detail') openDrawer(code, { trigger: actionBtn });
        else if (a === 'note') openDrawer(code, { trigger: actionBtn, focusNote: true });
        else if (a === 'remove') openRemoveDialog(code, actionBtn);
        return;
      }
      if (kebab) {
        ev.stopPropagation();
        const wrap = kebab.closest('.menu-wrap');
        const menu = wrap ? wrap.querySelector('.menu') : null;
        if (!menu) return;
        const willOpen = menu.getAttribute('data-open') !== 'true';
        closeMenus();
        menu.setAttribute('data-open', willOpen ? 'true' : 'false');
        kebab.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) { const f = menu.querySelector('button'); if (f) f.focus(); }
        return;
      }
      if (row) {                          // 点击行空白处 → 打开详情抽屉
        const code = row.getAttribute('data-code');
        if (code) openDrawer(code, { trigger: row });
      }
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest || !ev.target.closest('.menu-wrap')) closeMenus();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeMenus();
    });
  }

  function initTabs() {
    FILTERS.forEach(function (f) {
      $('tab-' + f.key).addEventListener('click', function () {
        state.filter = f.key;
        renderTabs();
        renderList();
      });
    });
    // 方向键 / Home / End 切换 tab（自动激活）
    $('tabs').addEventListener('keydown', function (ev) {
      let idx = -1;
      for (let i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === state.filter) { idx = i; break; }
      if (idx < 0) return;
      let next = null;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % FILTERS.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + FILTERS.length) % FILTERS.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = FILTERS.length - 1;
      else return;
      ev.preventDefault();
      state.filter = FILTERS[next].key;
      renderTabs();
      renderList();
      const b = $('tab-' + state.filter);
      if (b) b.focus();
    });
  }

  function initDrawer() {
    const drawer = $('drawer');
    $('drawer-close').addEventListener('click', function () { drawer.close(); });
    drawer.addEventListener('close', function () {
      $('drawer-body').innerHTML = '';
      restoreFocus();                   // 关闭后还原焦点
    });
    drawer.addEventListener('click', function (ev) { if (ev.target === drawer) drawer.close(); });
  }

  function initRemove() {
    const rm = $('rm');
    $('rm-x').addEventListener('click', function () { rm.close(); });
    $('rm-cancel').addEventListener('click', function () { rm.close(); });
    rm.addEventListener('close', restoreFocus);
    rm.addEventListener('click', function (ev) { if (ev.target === rm) rm.close(); });
    $('rm-reasons').addEventListener('change', function (ev) {
      const wrong = ev.target && ev.target.value === 'wrong';
      $('rm-wrong-wrap').hidden = !wrong;
      $('rm-err').classList.remove('on');
      if (wrong) $('rm-wrong').focus();
    });
    $('rm-ok').addEventListener('click', onRemoveConfirm);
  }

  /* ---------------- 头部状态（可选增强，失败不影响核心） ---------------- */

  function renderHeaderStatus(health, predict) {
    const el = $('hd-status');
    if (!el) return;
    const tags = [];
    const secs = predict && predict.mainline && Array.isArray(predict.mainline.sectors)
      ? predict.mainline.sectors.filter(function (s) {
        return s && (s.grade === 'A' || s.grade === 'B');
      }).slice(0, 2) : [];
    if (secs.length) {
      tags.push('<span class="tag">当前主线 · '
        + esc(secs.map(function (s) { return s.name || s.code; }).join(' · ')) + '</span>');
    }
    if (health) {
      const degraded = !!(health.storage && health.storage.degraded);
      tags.push('<span class="tag ' + (degraded ? 'warn' : 'ok') + '">'
        + '<span class="dot" aria-hidden="true"></span>'
        + (degraded ? '存储降级' : '服务正常') + '</span>');
    }
    el.innerHTML = tags.join('');
  }

  function enrich() {
    Promise.all([
      api('/api/sector/strength').catch(function () { return null; }),
      api('/api/health').catch(function () { return null; }),
      api('/api/predict/today').catch(function () { return null; }),
    ]).then(function (res) {
      const sector = res[0];
      if (sector) {
        const map = {};
        ['industry', 'concept'].forEach(function (k) {
          (Array.isArray(sector[k]) ? sector[k] : []).forEach(function (s) {
            if (s && s.sector != null) map[String(s.sector)] = { name: s.name, grade: s.grade };
          });
        });
        state.sectorMap = map;
        renderList();                   // 用板块名称重绘（失败则仍是真实代码）
      }
      renderHeaderStatus(res[1], res[2]);
    }).catch(function (err) { console.warn('[watch] 增强数据获取失败', err); });
  }

  /* ---------------- 主流程 ---------------- */

  async function refresh() {
    const data = await api('/api/watchpool');
    state.data = data;
    state.byCode = {};
    (Array.isArray(data.list) ? data.list : []).forEach(function (e) {
      if (e && e.code != null) state.byCode[String(e.code)] = e;
    });
    renderAll();
  }

  function showFatal(err) {
    $('errbox').hidden = false;
    $('err-text').textContent = '观察池数据加载失败：' + (err && err.message ? err.message : '未知错误');
    $('page-sub').textContent = '数据加载失败';
    $('pt-n').textContent = '—';
    $('pt-of').textContent = '/ —';
    $('pt-sub').textContent = '';
    FILTERS.forEach(function (f) { const c = $('cnt-' + f.key); if (c) c.textContent = '—'; });
    $('list-region').innerHTML = '<div class="empty-state"><h2>暂时无法读取观察池</h2>'
      + '<p>请稍后点击上方「重试」。</p></div>';
  }

  async function boot() {
    try {
      await refresh();
      $('errbox').hidden = true;
    } catch (err) {
      showFatal(err);
      return;
    }
    enrich();                           // 非阻塞增强
  }

  function init() {
    initTabs();
    initListEvents();
    initDrawer();
    initRemove();
    $('btn-retry').addEventListener('click', function () { location.reload(); });
    // 下钻：/watch?state=ambush 直接落到对应筛选
    try {
      const qs = new URLSearchParams(location.search).get('state');
      if (qs && FILTERS.some(function (f) { return f.key === qs; })) state.filter = qs;
    } catch (e) { console.warn('[watch] URL 参数解析失败', e); }
    boot();
  }

  init();
})();
