/* ============================================================
 * QuantLab · Watchlist（自选股 / 分组 / 数据加载）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 工具 ---------------- */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmt2 = (v) => (v == null ? '—' : Number(v).toFixed(2));

  /* ---------------- 触屏判定 ----------------
   * 触屏设备没有 hover，行内操作按钮永远不可见，
   * 因此改用「常显 ⋯ 按钮 + 底部操作面板 + 长按」三套入口。
   */
  const TOUCH = (function () {
    try {
      return window.matchMedia('(hover: none)').matches ||
        ('ontouchstart' in window && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) { return 'ontouchstart' in window; }
  })();
  if (TOUCH) document.documentElement.classList.add('touch');

  async function api(path, opt) {
    const o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt || {});
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error) || ('请求失败 HTTP ' + r.status));
    }
    return j.data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    groups: [],
    currentCode: null,
    currentName: '',
    bars: 1200,
    range: 90,
    strategy: null,
    collapsed: new Set(JSON.parse(localStorage.getItem('ql.collapsed') || '[]')),
    // 搜索添加的目标分组：显式记住用户最后点过的分组，
    // 避免折叠状态 / 分组顺序变化导致「加到哪个组」不可预期
    activeGid: localStorage.getItem('ql.activeGid') || null,
    loading: false,
    pendingOpen: null,   // 加载中点的下一只股票
    klinesAt: 0,
    lastCode: null,
  };

  function saveCollapsed() {
    localStorage.setItem('ql.collapsed', JSON.stringify([...S.collapsed]));
  }

  function setActiveGid(gid) {
    const v = gid || null;
    if (v === S.activeGid) return;
    S.activeGid = v;
    if (v) localStorage.setItem('ql.activeGid', v);
    else localStorage.removeItem('ql.activeGid');
  }

  /** 生效的目标分组：优先用户选择，其次第一个分组 */
  function targetGroup() {
    let g = S.groups.find((x) => x.id === S.activeGid);
    if (!g) g = S.groups[0];
    return g || null;
  }

  /* ---------------- 市场状态 ---------------- */
  function marketState() {
    const d = new Date();
    const day = d.getDay();
    const hm = d.getHours() * 100 + d.getMinutes();
    const open = day >= 1 && day <= 5 && ((hm >= 915 && hm <= 1130) || (hm >= 1300 && hm <= 1500));
    return open ? { open: true, txt: '盘中' } : { open: false, txt: '休市' };
  }
  function renderMarket() {
    const m = marketState();
    const el = $('mktState');
    el.className = 'mkt' + (m.open ? '' : ' closed');
    el.lastElementChild.textContent = m.txt;
  }

  /* ---------------- 指数条 ---------------- */
  const IDX = { list: [], at: 0 };

  function renderIdx() {
    const box = $('idxChips');
    if (!box) return;
    if (!IDX.list.length) { box.innerHTML = ''; return; }
    box.innerHTML = IDX.list.map((x) => {
      const cls = x.chgPct == null ? 'fl' : x.chgPct > 0 ? 'up' : x.chgPct < 0 ? 'dn' : 'fl';
      const sign = x.chgPct > 0 ? '+' : '';
      const on = x.code === S.currentCode ? ' on' : '';
      return `<div class="idx-chip${on}" data-code="${x.code}" data-name="${esc(x.name)}">
        <div class="n">${esc(x.name)}</div>
        <div class="r">
          <span class="p ${cls}">${x.price == null ? '—' : x.price.toFixed(2)}</span>
          <span class="g ${cls}">${x.chgPct == null ? '—' : sign + x.chgPct.toFixed(2) + '%'}</span>
        </div>
      </div>`;
    }).join('');
  }

  async function loadIndices() {
    try {
      IDX.list = await api('/api/indices');
      IDX.at = Date.now();
      renderIdx();
    } catch (e) { /* 指数条失败不影响主流程 */ }
  }

  $('idxChips').addEventListener('click', (e) => {
    const c = e.target.closest('.idx-chip');
    if (!c) return;
    if (c.dataset.code === S.currentCode) return;
    openStock(c.dataset.code, c.dataset.name);
  });

  $('idxMore').onclick = () => {
    if (!IDX.list.length) return;
    const rows = IDX.list.map((x) => {
      const cls = x.chgPct == null ? '' : x.chgPct > 0 ? 'up' : x.chgPct < 0 ? 'dn' : '';
      return `<button class="sh-i" data-k="i:${x.code}">
        <span class="sh-lb">${esc(x.name)}</span>
        <span class="sh-note ${cls}" style="font-family:ui-monospace,monospace">${x.price == null ? '—' : x.price.toFixed(2)} ${x.chgPct == null ? '' : (x.chgPct > 0 ? '+' : '') + x.chgPct.toFixed(2) + '%'}</span>
      </button>`;
    }).join('');
    showSheet({
      title: '大盘指数',
      sub: '选择后直接进入技术分析',
      html: `<div class="sh-list">${rows}</div>`,
      onPick: (k) => {
        if (!k.startsWith('i:')) return;
        const code = k.slice(2);
        const it = IDX.list.find((x) => x.code === code);
        closeSheet();
        if (code !== S.currentCode) openStock(code, it ? it.name : '');
      },
    });
  };

  /* ---------------- 渲染自选树 ---------------- */
  function stockActHtml() {
    return TOUCH
      ? '<div class="stk-act"><button data-act="more" aria-label="更多操作">⋯</button></div>'
      : '<div class="stk-act">' +
        '<button data-act="move" title="移动到分组">⇄</button>' +
        '<button data-act="del" title="从自选移除">×</button></div>';
  }

  function groupActHtml() {
    return TOUCH
      ? '<span class="grp-act"><button data-act="more" aria-label="分组操作">⋯</button></span>'
      : '<span class="grp-act">' +
        '<button data-act="rename" title="重命名">✎</button>' +
        '<button data-act="delgrp" title="删除分组">×</button></span>';
  }

  // 标题栏数量：手机收起后也知道自选了多少只
  function syncCount(n) {
    const el = $('sbCount');
    if (el) el.textContent = n > 0 ? n : '';
  }

  function renderTree() {
    const box = $('groupList');
    if (!S.groups.length) {
      box.innerHTML = '<div class="sb-empty">还没有自选股<br>在上方搜索代码或名称添加</div>';
      syncCount(0);
      return;
    }
    syncCount(S.groups.reduce((n, g) => n + g.items.length, 0));
    const tg = targetGroup();
    S.activeGid = tg ? tg.id : null;

    const html = S.groups.map((g) => {
      const closed = S.collapsed.has(g.id);
      const items = g.items.map((it) => {
        const cls = it.chgPct == null ? 'fl' : it.chgPct > 0 ? 'up' : it.chgPct < 0 ? 'dn' : 'fl';
        const sign = it.chgPct > 0 ? '+' : '';
        const on = it.code === S.currentCode ? ' on' : '';
        const isIdx = it.asset === 'index';
        const cd = isIdx ? it.code.slice(2) : it.code;
        return `<div class="stk${on}" data-code="${it.code}" data-name="${esc(it.name)}">
          <div class="stk-l">
            <div class="stk-nm">${esc(it.name)}</div>
            <div class="stk-cd">${isIdx ? '<span class="tag-idx" style="margin-right:4px">指</span>' : ''}${cd}</div>
          </div>
          <div class="stk-r">
            <div class="stk-p ${cls}">${fmt2(it.price)}</div>
            <div class="stk-g ${cls}">${it.chgPct == null ? '—' : sign + it.chgPct.toFixed(2) + '%'}</div>
          </div>
          ${stockActHtml()}
        </div>`;
      }).join('');
      return `<div class="grp${closed ? ' closed' : ''}" data-gid="${g.id}">
        <div class="grp-hd">
          <span class="caret">▾</span>
          <span class="grp-nm" title="${esc(g.name)}">${esc(g.name)}</span>
          <span class="grp-ct">${g.items.length}</span>
          ${groupActHtml()}
        </div>
        <div class="grp-body">${items || '<div class="sb-empty" style="padding:8px 10px;font-size:11px">空分组</div>'}</div>
      </div>`;
    }).join('');
    box.innerHTML = html;

    // 搜索框提示当前目标分组，避免「加到哪个组」不明确
    const inp = $('sInput');
    if (inp && document.activeElement !== inp) {
      inp.placeholder = tg ? `搜索并添加到「${tg.name}」` : '搜索 代码/名称/拼音';
    }
  }

  /* ---------------- 加载自选列表 ---------------- */
  async function loadWatchlist(silent) {
    try {
      const d = await api('/api/watchlist');
      S.groups = d.groups;
      renderTree();
      // 当前股票不在列表里（首次进入），选第一只
      if (!S.currentCode) {
        const first = S.groups.flatMap((g) => g.items)[0];
        if (first) openStock(first.code, first.name, true);
      } else {
        const cur = S.groups.flatMap((g) => g.items).find((x) => x.code === S.currentCode);
        if (cur) S.currentName = cur.name;
      }
      if (!silent) renderMarket();
    } catch (e) {
      if (!silent) toast('自选列表加载失败：' + e.message, true);
      console.error(e);
    }
  }

  /* ---------------- 打开股票 ---------------- */
  function setLoading(on) {
    S.loading = on;
    let el = document.querySelector('.loading');
    if (!el) {
      el = document.createElement('div');
      el.className = 'loading';
      el.innerHTML = '<div class="spin"></div>';
      const card = document.querySelector('.chart-card');
      if (card) card.appendChild(el);
    }
    el.classList.toggle('on', on);
  }

  function showChartError(msg, retry) {
    const card = document.querySelector('.chart-card');
    if (!card) return;
    let el = card.querySelector('.err-layer');
    if (!el) {
      el = document.createElement('div');
      el.className = 'err-layer';
      card.appendChild(el);
    }
    el.innerHTML = `<div class="err-box">
      <div class="err-t">行情加载失败</div>
      <div class="err-m">${esc(msg)}</div>
      <button class="err-b">重新加载</button>
    </div>`;
    el.classList.add('on');
    el.querySelector('.err-b').onclick = () => {
      el.classList.remove('on');
      if (retry) retry();
    };
  }
  function clearChartError() {
    const el = document.querySelector('.err-layer');
    if (el) el.classList.remove('on');
  }

  /**
   * 数据质量标记。只报「会影响判断」的问题，停牌不报 —— 停牌本身是行情的一部分，
   * 每只重组过的票都提示一次就成了噪音。
   */
  function renderQuality(q, source) {
    const el = $('sQual');
    if (!el) return;
    if (!q) { el.hidden = true; return; }
    const bad = (q.gaps || []).filter((g) => g.kind === 'year' || g.kind === 'block');
    if (!q.ok && !bad.length && !q.newListing) {
      el.hidden = false;
      el.textContent = '数据不足';
      el.title = '仅取到 ' + (q.bars || 0) + ' 根 K 线，不足以计算依赖长周期的指标';
      return;
    }
    if (bad.length) {
      el.hidden = false;
      el.textContent = '历史缺 ' + bad.length + ' 段';
      el.title = '以下区间 K 线缺失，均线、形态与含历史统计的流派会失真：\n'
        + bad.map((g) => `  ${g.from} ~ ${g.to}（约 ${g.bars} 根）`).join('\n')
        + '\n数据源：' + (source === 'sina' ? '新浪（不复权）' : '同花顺（前复权）');
      return;
    }
    if (q.droppedN > 0) {
      el.hidden = false;
      el.textContent = '已清洗 ' + q.droppedN + ' 行';
      el.title = '剔除的异常行（非正价格 / 日期非法 / 重复）：\n  '
        + (q.dropped || []).slice(0, 12).join('\n  ');
      return;
    }
    el.hidden = true;
  }

  async function openStock(code, name, keepView, attempt) {
    if (!code) return;
    // 首屏/加载中连点：不吞掉请求，记下来等当前这次结束后接着开
    if (S.loading) {
      S.pendingOpen = { code, name, keepView };
      return;
    }
    S.pendingOpen = null;
    const tryNo = attempt || 1;
    setLoading(true);
    clearChartError();
    try {
      // 指数带市场前缀：指数按全历史拉取（约 20 年），个股仍按 1200 根
      const isIdxCode = /^(sh|sz|bj)\d{6}$/.test(code);
      const d = await api('/api/stock/' + code + '?bars=' + S.bars + (isIdxCode ? '&all=1' : ''));
      S.currentCode = d.code;
      S.currentName = d.name || name || d.code;
      S.lastCode = d.code;
      S.klinesAt = Date.now();

      // 重挂载图表引擎
      const prevRange = keepView ? S.range : null;
      if (!keepView) S.range = 90;
      window.QLMount(d.klines, {
        name: S.currentName,
        display: d.display,
        code: d.code,
        asset: d.asset,
        isIndex: !!d.isIndex,
        floatShares: d.floatShares,
        week: d.week,
        month: d.month,
        bench: d.bench,
        benchName: d.benchName,
      });
      renderQuality(d.quality, d.source);
      if (prevRange) {
        const app = window.QuantLab.app;
        if (app) { app.chart.setRange(prevRange); app.select(app.currentId); }
      }
      syncHash();
      renderTree();
      renderIdx();
      // 手机上选完股票，收起列表把图表让出来
      if (isPhone() && !sidebarEl.classList.contains('folded')) {
        setFold(true, true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (e) {
      console.error(e);
      if (tryNo < 3) {
        // 上游偶发断连，退避重试
        await new Promise((r) => setTimeout(r, 500 * tryNo));
        setLoading(false);
        return openStock(code, name, keepView, tryNo + 1);
      }
      toast('行情加载失败：' + e.message, true);
      showChartError(e.message, () => openStock(code, name, keepView, 1));
      return;
    } finally {
      // 重试分支已在切走前把遮罩关掉，这里兜底收尾并处理排队中的点击
      setLoading(false);
      const pd = S.pendingOpen;
      S.pendingOpen = null;
      if (pd && pd.code !== S.currentCode) {
        setTimeout(() => openStock(pd.code, pd.name, pd.keepView), 0);
      }
    }
  }

  function syncHash() {
    if (!S.currentCode) return;
    const id = (window.QuantLab.app && window.QuantLab.app.currentId) || '';
    history.replaceState(null, '', '#' + S.currentCode + (id ? '/' + id : ''));
  }

  /* ---------------- 搜索 ---------------- */
  const sug = { list: [], idx: -1, timer: null };

  function hideSug() {
    $('sug').classList.remove('on');
    sug.idx = -1;
  }

  function renderSug() {
    const box = $('sug');
    if (!sug.list.length) {
      box.innerHTML = '<div class="sug-empty">未找到匹配的 A 股</div>';
      box.classList.add('on');
      return;
    }
    const gname = currentGroupName();
    box.innerHTML = sug.list.map((s, i) => {
      const added = S.groups.some((g) => g.items.some((it) => it.code === s.code));
      const isIdx = s.type === 'index';
      const cd = isIdx ? s.code.slice(2) : s.code;
      return `<div class="sug-item${i === sug.idx ? ' cur' : ''}" data-i="${i}">
        <span class="n">${isIdx ? '<span class="tag-idx" style="margin-right:5px">指</span>' : ''}${esc(s.name)}</span>
        <span class="c">${cd}</span>
        <span class="a">${added ? '已在自选' : '＋' + esc(gname)}</span>
      </div>`;
    }).join('');
    box.classList.add('on');
  }

  function currentGroupName() {
    const g = targetGroup();
    return (g && g.name) || '自选';
  }

  function currentGroupId() {
    const g = targetGroup();
    return g ? g.id : null;
  }

  async function doSearch(q) {
    if (!q.trim()) { hideSug(); return; }
    try {
      sug.list = await api('/api/search?q=' + encodeURIComponent(q));
      sug.idx = sug.list.length ? 0 : -1;
      renderSug();
    } catch (e) { hideSug(); }
  }

  async function addStock(item) {
    // 已在自选：直接打开，不再发一次会 409 的请求
    if (S.groups.some((g) => g.items.some((it) => it.code === item.code))) {
      $('sInput').value = '';
      hideSug();
      if (TOUCH) $('sInput').blur();
      if (item.code !== S.currentCode) openStock(item.code, item.name);
      return;
    }
    try {
      await api('/api/watchlist', { method: 'POST', body: { code: item.code, name: item.name, groupId: currentGroupId() } });
      const gname = currentGroupName();
      $('sInput').value = '';
      hideSug();
      if (TOUCH) $('sInput').blur();   // 收键盘，避免挡住下方内容
      await loadWatchlist(true);
      toast('已添加 ' + item.name + ' 到 ' + gname);
      openStock(item.code, item.name);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------------- 分组操作 ---------------- */
  function inlineInput(placeholder, value, onOk) {
    const box = $('groupList');
    const wrap = document.createElement('div');
    wrap.className = 'inline-new';
    wrap.innerHTML = `<input placeholder="${esc(placeholder)}" value="${esc(value || '')}" maxlength="20" autocomplete="off">
      <button type="button">确定</button>`;
    box.prepend(wrap);
    const inp = wrap.querySelector('input');
    const btn = wrap.querySelector('button');
    let settled = false;

    const cancel = () => {
      if (settled) return;
      settled = true;
      wrap.remove();
    };
    const done = () => {
      if (settled) return;
      const v = inp.value.trim();
      if (!v) { cancel(); return; }
      settled = true;
      wrap.remove();
      onOk(v);
    };

    inp.focus();
    try { inp.select(); } catch (e) { /* ignore */ }

    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done();
      if (e.key === 'Escape') cancel();
    };
    // 触屏上点按钮会先让输入框 blur，若立刻移除节点，click 就丢了。
    // 用 pointerdown 拦住默认的失焦行为，确保 click 一定能到达。
    const keep = (e) => e.preventDefault();
    btn.addEventListener('pointerdown', keep);
    btn.addEventListener('mousedown', keep);
    btn.addEventListener('click', (e) => { e.preventDefault(); done(); });
    inp.onblur = () => setTimeout(() => { if (!settled) cancel(); }, 200);
    return inp;
  }

  async function newGroup() {
    // 收起状态下输入框在隐藏区域里，先展开再让用户输入
    if (sidebarEl.classList.contains('folded')) setFold(false, true);
    inlineInput('分组名称，如「AI 算力」', '', async (name) => {
      try {
        await api('/api/groups', { method: 'POST', body: { name } });
        await loadWatchlist(true);
        toast('已创建分组「' + name + '」');
      } catch (e) { toast(e.message, true); }
    });
  }

  function openCtx(x, y, html) {
    const m = $('ctxMenu');
    m.innerHTML = html;
    m.classList.add('on');
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  function closeCtx() { $('ctxMenu').classList.remove('on'); }

  /* ============================================================
   * 底部操作面板（触屏主入口）
   * 手机上 hover / 右键都不可用，所有行内操作收进这里
   * ============================================================ */
  let sheetState = null;
  let sheetAt = 0;   // 面板打开时刻

  function showSheet(cfg) {
    const mask = $('sheetMask');
    const sh = $('sheet');
    sheetState = cfg;
    sheetAt = Date.now();

    const sub = cfg.sub ? `<span class="sh-sub">${esc(cfg.sub)}</span>` : '';
    sh.innerHTML =
      '<div class="sh-grab"></div>' +
      `<div class="sh-hd"><div class="sh-tt">${esc(cfg.title || '')}${sub}</div>` +
      '<button class="sh-x" data-sh="close" aria-label="关闭">×</button></div>' +
      `<div class="sh-body">${cfg.html || ''}</div>`;

    sh.classList.add('on');
    mask.classList.add('on');

    sh.onclick = (e) => {
      if (e.target.closest('[data-sh="close"]')) { closeSheet(); return; }
      const t = e.target.closest('[data-k]');
      if (!t || t.disabled) return;
      if (cfg.onPick) cfg.onPick(t.dataset.k);
    };

    // 面板内输入时滚动到可见区域，避免被键盘遮挡
    if (cfg.autofocus) {
      setTimeout(() => {
        const inp = sh.querySelector('.sh-in');
        if (!inp) return;
        inp.focus();
        try { inp.select(); } catch (err) { /* ignore */ }
        if (inp.scrollIntoView) inp.scrollIntoView({ block: 'center' });
      }, 80);
    }
  }

  function closeSheet() {
    const st = sheetState;
    sheetState = null;
    $('sheet').classList.remove('on');
    $('sheetMask').classList.remove('on');
    if (st && st.onClose) st.onClose();
  }

  /** 自定义确认框：部分 WebView 会屏蔽原生 confirm */
  function askConfirm(title, sub, okLabel) {
    return new Promise((resolve) => {
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      showSheet({
        title,
        sub,
        html: '<div class="sh-list">' +
          `<button class="sh-i danger" data-k="ok"><span class="sh-lb">${esc(okLabel || '确定')}</span></button>` +
          '<button class="sh-i" data-k="cancel"><span class="sh-lb">取消</span></button></div>',
        onPick: (k) => { end(k === 'ok'); closeSheet(); },
        onClose: () => end(false),
      });
    });
  }

  /** 面板内联输入 */
  function sheetInput(cfg) {
    showSheet({
      title: cfg.title,
      sub: cfg.sub,
      autofocus: true,
      html: '<div class="sh-form">' +
        `<input class="sh-in" placeholder="${esc(cfg.placeholder || '')}" ` +
        `value="${esc(cfg.value || '')}" maxlength="20" enterkeyhint="done" autocomplete="off">` +
        '<div class="sh-btns">' +
        '<button class="sh-btn gh" data-k="cancel">取消</button>' +
        '<button class="sh-btn" data-k="ok">确定</button></div></div>',
      onPick: (k) => {
        const inp = document.querySelector('.sh-in');
        const v = inp ? inp.value.trim() : '';
        if (k === 'cancel') { closeSheet(); return; }
        if (k === 'ok') {
          if (!v) { toast('名称不能为空', true); return; }
          closeSheet();
          cfg.onOk(v);
        }
      },
    });
  }

  /** 移动到分组面板 */
  function sheetMove(code, name) {
    const cur = S.groups.find((g) => g.items.some((i) => i.code === code));
    const rows = S.groups.map((g) => {
      const isCur = cur && cur.id === g.id;
      return `<button class="sh-i${isCur ? ' cur' : ''}" data-k="g:${g.id}">` +
        `<span class="sh-lb">${esc(g.name)}</span>` +
        `<span class="sh-note">${g.items.length} 只</span>` +
        (isCur ? '<span class="sh-tick">✓</span>' : '') + '</button>';
    }).join('');

    showSheet({
      title: '移动到分组',
      sub: name,
      html: `<div class="sh-list">${rows}` +
        '<button class="sh-i" data-k="g:__new"><span class="sh-lb">＋ 新建分组并移入</span></button></div>',
      onPick: async (k) => {
        if (!k.startsWith('g:')) return;
        const to = k.slice(2);
        if (to === '__new') {
          sheetInput({
            title: '新建分组',
            placeholder: '分组名称，如「AI 算力」',
            onOk: async (nm) => {
              try {
                const g = await api('/api/groups', { method: 'POST', body: { name: nm } });
                await api('/api/watchlist/' + code, { method: 'PATCH', body: { groupId: g.id } });
                setActiveGid(g.id);
                await loadWatchlist(true);
                toast('已移入「' + nm + '」');
              } catch (err) { toast(err.message, true); }
            },
          });
          return;
        }
        closeSheet();
        if (cur && cur.id === to) return;
        try {
          await api('/api/watchlist/' + code, { method: 'PATCH', body: { groupId: to } });
          setActiveGid(to);
          await loadWatchlist(true);
          const g = S.groups.find((x) => x.id === to);
          toast('已移入「' + (g ? g.name : '') + '」');
        } catch (err) { toast(err.message, true); }
      },
    });
  }

  /** 股票操作面板 */
  function openStockSheet(code, name) {
    const cur = S.groups.find((g) => g.items.some((i) => i.code === code));
    showSheet({
      title: name || code,
      sub: code,
      html: '<div class="sh-list">' +
        '<button class="sh-i" data-k="open"><span class="sh-ico">◧</span><span class="sh-lb">打开分析</span></button>' +
        '<button class="sh-i" data-k="move"><span class="sh-ico">⇄</span><span class="sh-lb">移动到分组</span>' +
        `<span class="sh-note">${esc(cur ? cur.name : '')}</span></button>` +
        '<button class="sh-i" data-k="copy"><span class="sh-ico">⧉</span><span class="sh-lb">复制代码</span></button>' +
        '<button class="sh-i danger" data-k="del"><span class="sh-ico">×</span><span class="sh-lb">从自选移除</span></button>' +
        '</div>',
      onPick: async (k) => {
        if (k === 'move') { sheetMove(code, name); return; }
        closeSheet();
        if (k === 'open') { if (code !== S.currentCode) openStock(code, name); return; }
        if (k === 'copy') {
          try {
            await navigator.clipboard.writeText(code);
            toast('已复制 ' + code);
          } catch (err) { toast('复制失败，请手动长按选择', true); }
          return;
        }
        if (k === 'del') {
          const ok = await askConfirm('从自选移除', (name || '') + ' ' + code, '确认移除');
          if (!ok) return;
          try {
            await api('/api/watchlist/' + code, { method: 'DELETE' });
            if (S.currentCode === code) S.currentCode = null;
            await loadWatchlist(true);
            toast('已移除 ' + (name || code));
          } catch (err) { toast(err.message, true); }
        }
      },
    });
  }

  /** 分组操作面板 */
  function openGroupSheet(gid) {
    const g = S.groups.find((x) => x.id === gid);
    if (!g) return;
    showSheet({
      title: g.name,
      sub: g.items.length + ' 只股票',
      html: '<div class="sh-list">' +
        '<button class="sh-i" data-k="add"><span class="sh-ico">＋</span><span class="sh-lb">向本组添加股票</span></button>' +
        '<button class="sh-i" data-k="rename"><span class="sh-ico">✎</span><span class="sh-lb">重命名分组</span></button>' +
        '<button class="sh-i danger" data-k="del"><span class="sh-ico">×</span><span class="sh-lb">删除分组</span></button>' +
        '</div>',
      onPick: async (k) => {
        if (k === 'add') {
          closeSheet();
          setActiveGid(gid);
          renderTree();
          const inp = $('sInput');
          if (inp) { inp.focus(); inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          return;
        }
        if (k === 'rename') {
          sheetInput({
            title: '重命名分组',
            value: g.name,
            onOk: async (v) => {
              if (v === g.name) return;
              try {
                await api('/api/groups/' + gid, { method: 'PATCH', body: { name: v } });
                await loadWatchlist(true);
                toast('已重命名为「' + v + '」');
              } catch (err) { toast(err.message, true); }
            },
          });
          return;
        }
        if (k === 'del') {
          closeSheet();
          if (S.groups.length === 1) { toast('至少保留一个分组', true); return; }
          const other = S.groups.find((x) => x.id !== gid);
          const sub = g.items.length
            ? `组内 ${g.items.length} 只股票将移到「${other.name}」`
            : '空分组，删除后不可恢复';
          const ok = await askConfirm('删除分组「' + g.name + '」', sub, '确认删除');
          if (!ok) return;
          try {
            await api('/api/groups/' + gid, { method: 'DELETE' });
            if (S.activeGid === gid) setActiveGid(null);
            await loadWatchlist(true);
            toast('已删除分组');
          } catch (err) { toast(err.message, true); }
        }
      },
    });
  }

  // 遮罩点击 / 返回键关闭
  // 长按后手指抬起会补发一次 click，落点正好在刚铺开的遮罩上，
  // 不加保护会出现「长按弹出后立刻自己关掉」
  $('sheetMask').addEventListener('click', () => {
    if (Date.now() - sheetAt < 420) return;
    closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetState) closeSheet();
  });
  // 面板内滑动不外泄到页面
  $('sheet').addEventListener('touchmove', (e) => {
    if (!e.target.closest('.sh-body')) e.preventDefault();
  }, { passive: false });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxMenu')) closeCtx();
    if (!e.target.closest('.sb-search')) hideSug();
  });

  /* ---------------- 手机端折叠 ----------------
   * 手机上自选股如果一直展开，会把图表挤到半屏以下，
   * 并且若定位是 sticky 还会直接盖住内容。这里做成可折叠卡片：
   * 首次访问默认收起，只留一条标题栏；点标题或箭头展开，
   * 选择写进 localStorage，下次沿用。
   */
  const sidebarEl = $('sidebar');
  const foldBtn = $('sbFold');
  const FOLD_KEY = 'ql.sbfold';
  const isPhone = () => window.matchMedia('(max-width:760px)').matches;

  function setFold(folded, persist) {
    const on = !!folded && isPhone();
    sidebarEl.classList.toggle('folded', on);
    foldBtn.setAttribute('aria-expanded', String(!on));
    if (persist) localStorage.setItem(FOLD_KEY, on ? '1' : '0');
  }
  function restoreFold() {
    // 没存过 → 首次访问默认收起；存过 → 按用户选择
    setFold(localStorage.getItem(FOLD_KEY) !== '0', false);
  }
  restoreFold();

  foldBtn.onclick = (e) => {
    e.stopPropagation();
    setFold(!sidebarEl.classList.contains('folded'), true);
  };
  // 标题栏整条可点，扩大触控区（+ 号按钮单独处理）
  document.querySelector('.sb-hd').addEventListener('click', (e) => {
    if (!isPhone() || e.target.closest('button')) return;
    setFold(!sidebarEl.classList.contains('folded'), true);
  });
  // 旋屏 / 改窗口宽度后重新套用偏好
  let foldTimer;
  window.addEventListener('resize', () => {
    clearTimeout(foldTimer);
    foldTimer = setTimeout(restoreFold, 150);
  });

  /* ---------------- 事件绑定 ---------------- */
  $('btnAddGroup').onclick = newGroup;

  const input = $('sInput');
  input.oninput = () => {
    clearTimeout(sug.timer);
    const q = input.value.trim();
    if (!q) { hideSug(); return; }
    sug.timer = setTimeout(() => doSearch(q), 180);
  };
  input.onkeydown = (e) => {
    if (!sug.list.length) return;
    if (e.key === 'ArrowDown') { sug.idx = Math.min(sug.list.length - 1, sug.idx + 1); renderSug(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sug.idx = Math.max(0, sug.idx - 1); renderSug(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (sug.idx >= 0) addStock(sug.list[sug.idx]); e.preventDefault(); }
    else if (e.key === 'Escape') hideSug();
  };

  $('sug').onclick = (e) => {
    const it = e.target.closest('.sug-item');
    if (!it) return;
    addStock(sug.list[+it.dataset.i]);
  };
  $('sug').onmousedown = (e) => e.preventDefault();

  /* ---------------- 长按（触屏第二入口） ----------------
   * ⋯ 按钮在主入口，长按作为习惯性补充；触发后抑制随后的 click
   */
  let lpTimer = null, lpStart = null, lpAt = 0;

  $('groupList').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('[data-act]')) return;   // 按钮自身已处理
    const row = e.target.closest('.stk, .grp-hd');
    if (!row) return;
    const t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY, row, moved: false };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (!lpStart || lpStart.moved) return;
      lpAt = Date.now();
      const stk = lpStart.row.closest('.stk');
      if (stk) {
        openStockSheet(stk.dataset.code, stk.dataset.name);
      } else {
        const grp = lpStart.row.closest('.grp');
        if (grp) openGroupSheet(grp.dataset.gid);
      }
      lpStart = null;
      try { if (navigator.vibrate) navigator.vibrate(14); } catch (err) { /* ignore */ }
    }, 480);
  }, { passive: true });

  $('groupList').addEventListener('touchmove', (e) => {
    if (!lpStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpStart.x) > 8 || Math.abs(t.clientY - lpStart.y) > 8) {
      lpStart.moved = true;
      clearTimeout(lpTimer);
    }
  }, { passive: true });

  const endLongPress = () => { clearTimeout(lpTimer); lpStart = null; };
  $('groupList').addEventListener('touchend', endLongPress, { passive: true });
  $('groupList').addEventListener('touchcancel', endLongPress, { passive: true });

  $('groupList').addEventListener('click', async (e) => {
    // 长按已弹出面板时，随后的 click 要丢弃，否则会顺带打开股票
    if (Date.now() - lpAt < 700) return;

    const grp = e.target.closest('.grp');
    const gid = grp && grp.dataset.gid;
    const actBtn = e.target.closest('[data-act]');
    const stk = e.target.closest('.stk');

    // 股票操作
    if (actBtn && stk) {
      e.stopPropagation();
      const code = stk.dataset.code;
      const name = stk.dataset.name;
      if (actBtn.dataset.act === 'more') {
        openStockSheet(code, name);
        return;
      }
      if (actBtn.dataset.act === 'del') {
        if (!(await askConfirm('从自选移除', name + ' ' + code, '确认移除'))) return;
        try {
          await api('/api/watchlist/' + code, { method: 'DELETE' });
          if (S.currentCode === code) S.currentCode = null;
          await loadWatchlist(true);
          toast('已移除 ' + name);
        } catch (err) { toast(err.message, true); }
      } else if (actBtn.dataset.act === 'move') {
        const r = actBtn.getBoundingClientRect();
        const rows = S.groups.map((g) => {
          const cur = g.items.some((it) => it.code === code);
          return `<div class="ctx-i${cur ? ' sel' : ''}" data-move="${g.id}">${esc(g.name)}</div>`;
        }).join('');
        openCtx(r.left - 100, r.bottom + 4,
          `<div class="ctx-t">移动到分组</div>${rows}
           <div class="ctx-sep"></div>
           <div class="ctx-i" data-move="__new">＋ 新建分组…</div>`);
        $('ctxMenu').onclick = async (ev) => {
          const t = ev.target.closest('[data-move]');
          if (!t) return;
          const to = t.dataset.move;
          closeCtx();
          if (to === '__new') {
            inlineInput('新分组名称', '', async (nm) => {
              try {
                const g = await api('/api/groups', { method: 'POST', body: { name: nm } });
                await api('/api/watchlist/' + code, { method: 'PATCH', body: { groupId: g.id } });
                await loadWatchlist(true);
                toast('已移入「' + nm + '」');
              } catch (err) { toast(err.message, true); }
            });
            return;
          }
          try {
            await api('/api/watchlist/' + code, { method: 'PATCH', body: { groupId: to } });
            await loadWatchlist(true);
            const g = S.groups.find((x) => x.id === to);
            toast('已移入「' + (g ? g.name : '') + '」');
          } catch (err) { toast(err.message, true); }
        };
      }
      return;
    }

    // 分组头操作
    if (actBtn && gid) {
      e.stopPropagation();
      const g = S.groups.find((x) => x.id === gid);
      if (actBtn.dataset.act === 'more') {
        openGroupSheet(gid);
        return;
      }
      if (actBtn.dataset.act === 'rename') {
        const hd = actBtn.closest('.grp-hd');
        const nmEl = hd.querySelector('.grp-nm');
        const old = g.name;
        nmEl.innerHTML = `<input class="rename-in" value="${esc(old)}" maxlength="20"
          style="width:100%;background:#0A0F17;border:1px solid #2E3D52;border-radius:4px;
          color:#E8EDF5;font-size:11.5px;padding:1px 4px;outline:none;font-family:inherit">`;
        const ri = nmEl.querySelector('input');
        ri.focus(); ri.select();
        const commit = async () => {
          const v = ri.value.trim();
          if (!v || v === old) { renderTree(); return; }
          try {
            await api('/api/groups/' + gid, { method: 'PATCH', body: { name: v } });
            await loadWatchlist(true);
            toast('已重命名为「' + v + '」');
          } catch (err) { toast(err.message, true); renderTree(); }
        };
        ri.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ri.onblur = null; commit(); }
          if (ev.key === 'Escape') renderTree();
        };
        ri.onblur = commit;
      } else if (actBtn.dataset.act === 'delgrp') {
        if (S.groups.length === 1) { toast('至少保留一个分组', true); return; }
        const other = S.groups.find((x) => x.id !== gid);
        if (!(await askConfirm('删除分组「' + g.name + '」',
          `组内 ${g.items.length} 只股票会移到「${other.name}」`, '确认删除'))) return;
        try {
          await api('/api/groups/' + gid, { method: 'DELETE' });
          if (S.activeGid === gid) setActiveGid(null);
          await loadWatchlist(true);
          toast('已删除分组');
        } catch (err) { toast(err.message, true); }
      }
      return;
    }

    // 折叠 + 记住添加目标分组
    if (e.target.closest('.grp-hd') && gid) {
      setActiveGid(gid);
      if (S.collapsed.has(gid)) S.collapsed.delete(gid); else S.collapsed.add(gid);
      saveCollapsed();
      grp.classList.toggle('closed');
      const tg = targetGroup();
      const inp2 = $('sInput');
      if (inp2 && document.activeElement !== inp2) {
        inp2.placeholder = tg ? `搜索并添加到「${tg.name}」` : '搜索 代码/名称/拼音';
      }
      return;
    }

    // 打开股票
    if (stk) {
      const code = stk.dataset.code;
      if (code === S.currentCode) return;
      openStock(code, stk.dataset.name);
    }
  });

  // 右键菜单：股票可删除，分组可重命名
  $('groupList').addEventListener('contextmenu', (e) => {
    const stk = e.target.closest('.stk');
    const grp = e.target.closest('.grp');
    if (!stk && !grp) return;
    e.preventDefault();
    if (stk) {
      const code = stk.dataset.code, name = stk.dataset.name;
      openCtx(e.clientX, e.clientY,
        `<div class="ctx-t">${esc(name)} ${code}</div>
         <div class="ctx-i" data-r="open">打开分析</div>
         <div class="ctx-i" data-r="copy">复制代码</div>
         <div class="ctx-sep"></div>
         <div class="ctx-i danger" data-r="del">从自选移除</div>`);
      $('ctxMenu').onclick = async (ev) => {
        const t = ev.target.closest('[data-r]');
        if (!t) return;
        const r = t.dataset.r;
        closeCtx();
        if (r === 'open') openStock(code, name);
        if (r === 'copy') { navigator.clipboard && navigator.clipboard.writeText(code); toast('已复制 ' + code); }
        if (r === 'del') {
          try {
            await api('/api/watchlist/' + code, { method: 'DELETE' });
            if (S.currentCode === code) S.currentCode = null;
            await loadWatchlist(true);
            toast('已移除 ' + name);
          } catch (err) { toast(err.message, true); }
        }
      };
    }
  });

  /* ---------------- hash 路由 ---------------- */
  function parseHash() {
    const h = (location.hash || '').replace('#', '');
    if (!h) return null;
    const [code, sid] = h.split('/');
    // 个股 6 位；指数带市场前缀（sh000001）
    return { code: /^(?:(?:sh|sz|bj))?\d{6}$/.test(code) ? code : null, sid: sid || null };
  }

  /* ---------------- 定时刷新 ---------------- */
  function tickRefresh() {
    if (document.hidden) return;
    const m = marketState();
    if (!m.open) return;
    loadWatchlist(true);
    if (Date.now() - IDX.at > 20000) loadIndices();
    if (S.currentCode && Date.now() - S.klinesAt > 60000) {
      openStock(S.currentCode, S.currentName, true);
    }
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    renderMarket();
    if (TOUCH) {
      const hint = $('chartHint');
      if (hint) hint.textContent = '双指缩放 · 左右拖拽平移 · 点按查看明细';
    }
    const h = parseHash();
    if (h && h.sid) S.strategy = h.sid;
    loadIndices();
    await loadWatchlist(false);
    // 处理 hash 指定的标的：不必在自选里也能直接打开（选股结果就是从这里跳进来的）
    if (h && h.code && h.code !== S.currentCode) {
      await openStock(h.code, '', true);
    }
    setInterval(renderMarket, 30000);
    setInterval(tickRefresh, 15000);
    // 记录当前流派，用于刷新后恢复
    setInterval(() => {
      const app = window.QuantLab.app;
      if (app) { S.strategy = app.currentId; S.range = app.chart.viewCount; }
    }, 1000);
  })();
})();
