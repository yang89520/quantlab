'use strict';
/**
 * 四期 · 策略实验室生产前端
 *
 * 原则：
 *  - 所有数字 / 文案来自 /api/lab/* 与 /api/health；拿不到显示「—」或空态，绝不填假数据。
 *  - 用户输入与接口文案一律 esc()/textContent，防 XSS。
 *  - 五道闸严格三态：true ✓ 通过 / false ✗ 未通过 / null|undefined ! 无法检验。
 *  - 高危未来函数禁止保存；公式改动后必须重新扫描通过才解锁。
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  /* ================= 常量 ================= */
  const STATUS_CN = { draft: '草稿', testing: '验证中', active: '已上线', suspect: '已降级', retired: '已退役' };
  const STATUS_CLS = { draft: 'st-draft', testing: 'st-testing', active: 'st-active', suspect: 'st-suspect', retired: 'st-retired' };
  const VERDICT_CN = { usable: '可用', doubtful: '存疑', unusable: '不可用' };
  const VERDICT_CLS = { usable: 'chip-ok', doubtful: 'chip-warn', unusable: 'chip-bad' };
  const TYPE_CN = { formula: '公式', python: 'Python' };
  const ACTION_CN = { buy: '买入', sell: '卖出' };
  const SUSPECT_TEXT = '已降级，实盘表现偏离回测';
  const GATE_DEFS = [
    { key: 'future', no: '①', name: '未来函数' },
    { key: 'isOos', no: '②', name: '样本内外' },
    { key: 'universe', no: '③', name: '普适性' },
    { key: 'phase', no: '④', name: '牛熊分段' },
    { key: 'dual', no: '⑤', name: '双轨一致' },
  ];
  const METRIC_LABELS = { trades: '交易笔数', winRate: '胜率', ret: '收益', maxDD: '最大回撤', sharpe: '夏普' };

  /* ================= 工具 ================= */
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function isNum(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
    return isFinite(Number(v));
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function num(v, d) { return isNum(v) ? Number(v).toFixed(d === undefined ? 2 : d) : '—'; }
  /** 比例/收益率字段：接口可能给 0~1 小数或 0~100 百分数，统一归一为「百分数数值」。 */
  function toPctNum(v) {
    if (!isNum(v)) return null;
    var n = Number(v);
    return Math.abs(n) <= 1 ? n * 100 : n;
  }
  function fmtPct(v, signed) {
    var p = toPctNum(v);
    if (p === null) return '—';
    var s = p.toFixed(1) + '%';
    return (signed && p > 0) ? '+' + s : s;
  }
  /** 05 §7.2：t1/t5/t10 已按 (close/price-1)*100 计算，接口给的是百分数。 */
  function fmtTrackPct(v) {
    if (!isNum(v)) return '—';
    var n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function intOrDash(v) { return isNum(v) ? String(Math.round(Number(v))) : '—'; }
  function rawStr(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  function localDateStr(d) {
    var x = d || new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }
  function announce(msg) { $('live-region').textContent = msg; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setEditMsg(text, cls) {
    var m = $('edit-msg');
    m.textContent = text;
    m.className = 'edit-msg' + (cls ? ' ' + cls : '');
  }

  /* ================= 请求 ================= */
  async function api(path, opts) {
    var o = Object.assign({ headers: { accept: 'application/json' } }, opts || {});
    var r = await fetch(path, o);
    var j;
    try { j = await r.json(); } catch (e) { throw new Error('接口返回不是有效 JSON'); }
    if (!j.ok) throw new Error(j.error ? String(j.error) : ('接口请求失败（HTTP ' + r.status + '）'));
    return j.data;
  }
  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* ================= 状态 ================= */
  const state = {
    strategies: null,
    health: null,
    outputLine: null,
    lines: null,
    scan: null,            // {high, level, formula, findings}
    editingId: null,
    signalRows: [],
    signalDate: '',
    gateStrategyId: null,
    gateResult: null,
    gateRunToken: 0,
    retry: null,
  };

  /* ================= 错误条 / 重试 ================= */
  function clearError() {
    $('global-error').hidden = true;
    state.retry = null;
  }
  function showError(msg, retryFn) {
    $('global-error-msg').textContent = '数据加载失败：' + msg;
    $('global-error').hidden = false;
    state.retry = typeof retryFn === 'function' ? retryFn : null;
    $('global-error-retry').hidden = !state.retry;
  }
  function guard(loader) {
    clearError();
    return Promise.resolve().then(loader).catch(function (e) {
      showError((e && e.message) ? e.message : '接口请求失败', function () { guard(loader); });
    });
  }

  /* ================= 健康 / Python ================= */
  async function loadHealth() {
    state.health = (await api('/api/health')) || {};
    renderHealth();
  }
  function renderHealth() {
    var py = state.health && state.health.python;
    var warn = $('python-warn');
    var reason = $('python-warn-reason');
    if (py && py.available === false) {
      warn.hidden = false;
      var bits = [];
      if (py.reason) bits.push('原因：' + String(py.reason));
      if (py.numpy !== undefined) bits.push('numpy：' + rawStr(py.numpy));
      if (bits.length) { reason.textContent = bits.join(' · '); reason.hidden = false; }
      else { reason.textContent = ''; reason.hidden = true; }
    } else {
      warn.hidden = true;
      reason.hidden = true;
    }
  }

  /* ================= 策略 ================= */
  async function ensureStrategies() {
    if (state.strategies) return state.strategies;
    var d = await api('/api/lab/strategies');
    state.strategies = (d && Array.isArray(d.list)) ? d.list : [];
    onStrategiesReady();
    return state.strategies;
  }
  function strategyById(id) {
    if (!state.strategies || !id) return null;
    for (var i = 0; i < state.strategies.length; i++) {
      if (String(state.strategies[i].id) === String(id)) return state.strategies[i];
    }
    return null;
  }
  function strategyLabel(s) {
    if (!s) return '';
    var name = s.name ? String(s.name) : (s.id ? String(s.id) : '未命名策略');
    return name + (s.version !== undefined && s.version !== null ? ' v' + s.version : '');
  }
  function statusChip(s) {
    var v = s && s.status;
    var cn = STATUS_CN[v] || (v ? String(v) : '—');
    var cls = STATUS_CLS[v] || 'st-draft';
    return '<span class="st ' + cls + '">' + esc(cn) + '</span>';
  }
  function verdictChip(v) {
    return '<span class="chip ' + (VERDICT_CLS[v] || 'chip-c') + '" style="margin:0">' +
      esc(VERDICT_CN[v] || '—') + '</span>';
  }
  function onStrategiesReady() {
    var list = state.strategies || [];
    $('page-sub').textContent = list.length
      ? '已保存 ' + list.length + ' 个策略 · 数据来自 /api/lab/strategies。'
      : '暂无已保存策略 · 可在编辑器中创建。';
    $('tab-count-gate').textContent = String(list.length);

    var sig = $('sig-strategy'), trk = $('track-strategy');
    var sigPrev = sig.value, trkPrev = trk.value;
    sig.innerHTML = '<option value="">全部策略</option>';
    trk.innerHTML = '<option value="">请选择策略</option>';
    list.forEach(function (s) {
      if (s.id === undefined || s.id === null) return;
      var id = String(s.id);
      var o1 = document.createElement('option'); o1.value = id; o1.textContent = strategyLabel(s);
      var o2 = document.createElement('option'); o2.value = id; o2.textContent = strategyLabel(s);
      sig.appendChild(o1); trk.appendChild(o2);
    });
    if (sigPrev) sig.value = sigPrev;
    if (trkPrev) trk.value = trkPrev;
    if (!trk.value && list.length && list[0].id !== undefined && list[0].id !== null) trk.value = String(list[0].id);

    renderStrategyList();
    renderBatch();
  }

  /* ================= Tab 切换 ================= */
  const TABS = ['t-edit', 't-gate', 't-sig', 't-track', 't-batch'];
  const PANELS = ['p-edit', 'p-gate', 'p-sig', 'p-track', 'p-batch'];
  const PANEL_LOADERS = { 1: loadGatePanel, 2: loadSignalPanel, 3: loadTrackPanel, 4: loadBatchPanel };

  function selectTab(i, focus) {
    TABS.forEach(function (id, k) {
      var on = k === i;
      var t = $(id);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      $(PANELS[k]).hidden = !on;
    });
    if (focus) $(TABS[i]).focus();
    if (PANEL_LOADERS[i]) guard(PANEL_LOADERS[i]);
  }
  function wireTabs() {
    TABS.forEach(function (id, i) {
      var t = $(id);
      t.addEventListener('click', function () { selectTab(i, false); });
      t.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = TABS.length - 1;
        if (n !== null) { e.preventDefault(); selectTab(n, true); }
      });
    });
  }

  /* ================= 编辑器 ================= */
  function sourceValue() { return $('f-source').value; }
  function renderGutter() {
    var g = $('gutter');
    var n = sourceValue().split('\n').length;
    g.textContent = '';
    for (var i = 1; i <= n; i++) g.appendChild(el('div', '', i));
  }
  function onSourceInput() {
    renderGutter();
    // 公式变化：输出线清单与扫描结果都失效，必须重新解析 / 重新扫描
    state.outputLine = null;
    state.lines = null;
    $('lines-list').textContent = '';
    $('line-chip').className = 'chip chip-c';
    $('line-chip').textContent = '需重新解析';
    $('f-line-current').textContent = '公式已修改，请重新解析输出线并手选';
    $('scan-card').classList.add('is-stale');
    $('scan-note').textContent = '公式已修改，上次扫描结果已失效，请重新扫描。';
    updateSaveGuard();
  }
  function wireEditor() {
    var src = $('f-source');
    src.addEventListener('input', onSourceInput);
    src.addEventListener('scroll', function () { $('gutter').scrollTop = src.scrollTop; });
    src.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = this.selectionStart, en = this.selectionEnd;
        this.value = this.value.slice(0, s) + '  ' + this.value.slice(en);
        this.selectionStart = this.selectionEnd = s + 2;
        onSourceInput();
      }
    });
    renderGutter();
    $('btn-lines').addEventListener('click', function () { guard(parseLines); });
    $('btn-scan').addEventListener('click', function () { guard(scanFormula); });
    $('btn-save').addEventListener('click', function () { guard(saveStrategy); });
    $('btn-new').addEventListener('click', newStrategy);
    updateSaveGuard();
  }

  async function parseLines() {
    var formula = sourceValue();
    if (!formula.trim()) { setEditMsg('请先输入公式源码再解析输出线。', 'err'); return; }
    var d = await post('/api/lab/formula/lines', { formula: formula });
    if (d && d.error) { state.lines = []; renderLines([], String(d.error)); return; }
    var lines = d && Array.isArray(d.lines) ? d.lines : [];
    state.lines = lines;
    renderLines(lines, null);
    announce('解析到 ' + lines.length + ' 条输出线，请手选一条');
  }
  function renderLines(lines, error) {
    state.outputLine = null;   // 不许自动猜：每次解析都清空选择，由用户手选
    var box = $('lines-list');
    box.textContent = '';
    var chip = $('line-chip');
    if (error) {
      chip.className = 'chip chip-bad'; chip.textContent = '解析失败';
      $('f-line-current').textContent = '解析失败：' + error;
      box.appendChild(el('div', 'lab-empty', '解析失败：' + error));
      updateSaveGuard();
      return;
    }
    if (!lines.length) {
      chip.className = 'chip chip-warn'; chip.textContent = '0 条';
      $('f-line-current').textContent = '未解析到输出线，请检查公式';
      box.appendChild(el('div', 'lab-empty', '未解析到输出线。'));
      updateSaveGuard();
      return;
    }
    chip.className = 'chip chip-ok'; chip.textContent = lines.length + ' 条';
    $('f-line-current').textContent = '请手选一条输出线作为信号线（不自动选择）';
    lines.forEach(function (ln) {
      var name = ln && ln.name !== undefined && ln.name !== null ? String(ln.name) : '';
      var expr = ln && ln.expr !== undefined && ln.expr !== null ? String(ln.expr) : '';
      var label = document.createElement('label');
      label.className = 'line-opt';
      var input = document.createElement('input');
      input.type = 'radio'; input.name = 'outputline'; input.value = name;
      var txt = el('span', 'txt');
      txt.appendChild(el('span', 'nm', name || '(未命名)'));
      txt.appendChild(el('code', 'ex', expr || '—'));
      label.appendChild(input); label.appendChild(txt);
      input.addEventListener('change', function () {
        state.outputLine = name;
        $('f-line-current').textContent = '已选输出线：' + (name || '(未命名)');
        setEditMsg('', '');
        updateSaveGuard();
      });
      box.appendChild(label);
    });
    updateSaveGuard();
  }

  async function scanFormula() {
    var formula = sourceValue();
    if (!formula.trim()) { setEditMsg('请先输入公式源码再扫描未来函数。', 'err'); return; }
    var d = await post('/api/lab/formula/scan', { formula: formula });
    var findings = d && Array.isArray(d.findings) ? d.findings : [];
    var level = d && d.level ? String(d.level) : 'info';
    var high = level === 'high' || findings.some(function (f) { return f && f.level === 'high'; });
    state.scan = { high: high, level: level, formula: formula, findings: findings };
    renderScan();
    announce(high ? '扫描完成：含高危未来函数，禁止保存' : '扫描完成：无高危未来函数');
  }
  function renderScan() {
    var s = state.scan;
    var card = $('scan-card');
    var box = $('scan-list');
    box.textContent = '';
    card.classList.remove('is-stale', 'is-high');
    if (!s) return;
    var stale = s.formula !== sourceValue();
    if (stale) card.classList.add('is-stale');
    if (s.high) card.classList.add('is-high');
    var chip = $('scan-chip');
    if (s.high) { chip.className = 'chip chip-bad'; chip.textContent = '高危'; }
    else if (s.level === 'medium') { chip.className = 'chip chip-warn'; chip.textContent = '中危'; }
    else { chip.className = 'chip chip-ok'; chip.textContent = '无高危'; }
    if (!s.findings.length) {
      box.appendChild(el('div', 'scan-item lo', '未检测到未来函数。'));
    } else {
      s.findings.forEach(function (f) {
        var lv = f && f.level ? String(f.level) : 'info';
        var cls = lv === 'high' ? 'hi' : (lv === 'medium' ? 'mid' : 'lo');
        var item = el('div', 'scan-item ' + cls);
        item.appendChild(el('span', 'ico', lv === 'info' ? 'i' : '!'));
        var body = document.createElement('span');
        if (f && f.line !== undefined && f.line !== null) body.appendChild(el('span', 'ln', '第 ' + String(f.line) + ' 行'));
        if (f && f.name) body.appendChild(el('b', '', String(f.name) + '：'));
        if (f && f.desc) body.appendChild(document.createTextNode(String(f.desc)));
        item.appendChild(body);
        box.appendChild(item);
      });
    }
    $('scan-note').textContent = stale
      ? '公式已修改，上次扫描结果已失效，请重新扫描。'
      : (s.high ? '扫描发现高危未来函数，禁止保存；请修改公式后重新扫描。'
        : '高危禁止保存；中危允许保存但需留意；提示仅告知。');
    updateSaveGuard();
  }
  function updateSaveGuard() {
    var src = sourceValue();
    var s = state.scan;
    var high = !!(s && s.high);
    var stale = !!(s && s.formula !== src);
    var g = $('save-guard');
    var msg, cls;
    if (!s) { msg = '请先扫描未来函数，通过后方可保存'; cls = 'warn'; }
    else if (high) { msg = '含未来函数，禁止保存' + (stale ? '（公式已改，请重新扫描）' : ''); cls = 'hi'; }
    else if (stale) { msg = '公式已修改，请重新扫描通过后才解锁保存'; cls = 'warn'; }
    else if (!state.outputLine) { msg = '请解析输出线并手选一条后再保存'; cls = 'warn'; }
    else { msg = '扫描通过，可以保存'; cls = 'ok'; }
    g.className = 'lab-guard ' + cls;
    g.textContent = msg;
    var disabled = !s || high || stale || !state.outputLine;
    $('btn-save').disabled = disabled;
    $('btn-save').title = disabled ? msg : '';
  }
  function newStrategy() {
    $('f-name').value = '';
    $('f-type').value = 'formula';
    $('f-source').value = '';
    state.editingId = null;
    state.outputLine = null;
    state.lines = null;
    state.scan = null;
    $('lines-list').textContent = '';
    $('line-chip').className = 'chip chip-c'; $('line-chip').textContent = '未解析';
    $('f-line-current').textContent = '尚未选择输出线';
    $('scan-list').textContent = '';
    $('scan-chip').className = 'chip chip-c'; $('scan-chip').textContent = '未扫描';
    $('scan-note').textContent = '高危禁止保存；中危允许保存但需留意；提示仅告知。';
    $('scan-card').classList.remove('is-stale', 'is-high');
    $('f-ver').textContent = '新建策略 · 保存后由接口返回版本号';
    renderGutter();
    setEditMsg('', '');
    updateSaveGuard();
    announce('已清空编辑器，可新建策略');
  }
  async function saveStrategy() {
    var name = $('f-name').value.trim();
    var type = $('f-type').value;
    var source = sourceValue();
    if (!name) { setEditMsg('请填写策略名。', 'err'); return; }
    if (!source.trim()) { setEditMsg('请填写公式源码。', 'err'); return; }
    if (!state.outputLine) { setEditMsg('请先「解析输出线」并手选一条输出线。', 'err'); return; }
    var body = { name: name, type: type, source: source, outputLine: state.outputLine };
    if (state.editingId) body.id = state.editingId;
    var saved = await post('/api/lab/strategies', body);
    if (saved && saved.id !== undefined && saved.id !== null) state.editingId = String(saved.id);
    var ver = saved && saved.version !== undefined && saved.version !== null ? 'v' + saved.version : '';
    $('f-ver').textContent = ver
      ? '当前 ' + ver + ' · 再次保存将生成新版本（版本 +1）'
      : '已保存 · 再次保存将生成新版本（版本 +1）';
    state.strategies = null;   // 使其它 tab 重新拉取
    $('tab-count-gate').textContent = '—';
    setEditMsg('已保存' + (ver ? '为 ' + ver : '') + '，其它标签将在切换时刷新策略列表。', 'ok');
    announce('策略已保存' + (ver ? ' ' + ver : ''));
  }

  /* ================= 验证：策略列表 ================= */
  function renderStrategyList() {
    var list = state.strategies || [];
    var wrap = $('gate-strategy-wrap');
    var empty = $('gate-strategy-empty');
    var tbody = $('gate-strategy-tbody');
    tbody.textContent = '';
    if (!list.length) {
      wrap.hidden = true; empty.hidden = false; $('gate-list-note').textContent = '';
      return;
    }
    wrap.hidden = false; empty.hidden = true;
    $('gate-list-note').textContent = '共 ' + list.length + ' 个策略';
    list.forEach(function (s) {
      var id = s.id !== undefined && s.id !== null ? String(s.id) : '';
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'strong', s.name ? String(s.name) : (id || '未命名策略')));
      tr.appendChild(el('td', 'muted', TYPE_CN[s.type] || (s.type ? String(s.type) : '—')));
      tr.appendChild(el('td', 'r', s.version !== undefined && s.version !== null ? 'v' + s.version : '—'));
      var tdS = document.createElement('td');
      tdS.innerHTML = statusChip(s);
      if (s.status === 'suspect') tdS.appendChild(el('span', 'suspect-note', SUSPECT_TEXT));
      tr.appendChild(tdS);
      var tdV = document.createElement('td');
      tdV.innerHTML = s.gate && s.gate.verdict
        ? verdictChip(s.gate.verdict)
        : '<span class="chip chip-c" style="margin:0">未验证</span>';
      tr.appendChild(tdV);
      var tdA = el('td', 'r');
      var run = el('button', 'btn btn-sm', '跑五道闸');
      run.type = 'button'; run.setAttribute('data-run', id);
      run.addEventListener('click', function () { guard(function () { return runGates(id); }); });
      var view = el('button', 'btn btn-sm', '查看明细');
      view.type = 'button'; view.style.marginLeft = '6px';
      if (!(s.gate && (s.gate.metrics || s.gate.gates || s.gate.verdict))) view.disabled = true;
      view.addEventListener('click', function () {
        openDrawer((s.gate && s.gate.metrics) || {}, (s.gate && s.gate.gates) || null, strategyLabel(s));
      });
      tdA.appendChild(run); tdA.appendChild(view);
      tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
  }
  function setRunButtonsDisabled(dis) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-run]'), function (b) { b.disabled = dis; });
  }
  async function loadGatePanel() { await ensureStrategies(); }

  /* ================= 验证：跑闸 / 轮询 / 结果 ================= */
  async function runGates(id) {
    if (!id) { setEditMsg('策略缺少 id，无法跑闸。', 'err'); return; }
    state.gateStrategyId = id;
    var token = ++state.gateRunToken;
    $('gate-result').hidden = true;
    $('gate-placeholder').hidden = true;
    $('gate-progress').hidden = false;
    $('gate-progress-text').textContent = '任务已提交，等待执行…';
    $('gate-progress-pct').textContent = '';
    $('gate-progress-fill').style.width = '0%';
    $('gate-progress-track').removeAttribute('aria-valuenow');
    setRunButtonsDisabled(true);
    try {
      var start = await post('/api/lab/gates', { strategyId: id });
      var taskId = start && start.taskId;
      if (!taskId) throw new Error('接口未返回 taskId');
      renderProgress(start);
      var deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await wait(1000);
        if (token !== state.gateRunToken) return;
        var s = await api('/api/lab/gates/' + encodeURIComponent(String(taskId)));
        if (token !== state.gateRunToken) return;
        renderProgress(s);
        if (s && s.status === 'done') {
          renderGateResult(s.result || {}, s.metrics);
          $('gate-progress').hidden = true;
          announce('五道闸完成');
          return;
        }
        if (s && s.status === 'failed') {
          throw new Error('五道闸任务失败' + (s.error ? '：' + String(s.error) : ''));
        }
      }
      throw new Error('五道闸任务超时（120 秒），请稍后重试');
    } catch (e) {
      if (token === state.gateRunToken) {
        $('gate-progress').hidden = true;
        $('gate-placeholder').hidden = false;
      }
      throw e;
    } finally {
      if (token === state.gateRunToken) setRunButtonsDisabled(false);
    }
  }
  function renderProgress(s) {
    var st = ({ pending: '排队中', running: '运行中', done: '完成', failed: '失败' })[(s && s.status) || ''] || '处理中';
    var p = toPctNum(s && s.progress);
    var pct = p === null ? null : clamp(p, 0, 100);
    $('gate-progress-text').textContent = '五道闸任务 ' + st;
    $('gate-progress-pct').textContent = pct === null ? '' : '进度 ' + Math.round(pct) + '%';
    $('gate-progress-fill').style.width = (pct === null ? 0 : pct) + '%';
    if (pct === null) $('gate-progress-track').removeAttribute('aria-valuenow');
    else $('gate-progress-track').setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  /** 三态：true ✓ 通过 / false ✗ 未通过 / null|undefined ! 无法检验。绝不把 null 当通过。 */
  function gateState(pass) {
    if (pass === true) return { ico: '✓', text: '✓ 通过', cls: 'pass', chip: 'chip-ok', desc: '该道闸通过检验。' };
    if (pass === false) return { ico: '✗', text: '✗ 未通过', cls: 'fail', chip: 'chip-bad', desc: '该道闸未通过，结论不可用。' };
    return { ico: '!', text: '! 无法检验', cls: 'na', chip: 'chip-warn', desc: '样本不足或条件不满足，无法检验；无法检验 ≠ 通过。' };
  }
  /** 每道闸的关键数字，全部取自接口；缺失显示「—」，不编造。 */
  function gateFigures(key, g) {
    if (!g) return [];
    var out = [];
    if (key === 'future') {
      var f = Array.isArray(g.findings) ? g.findings : null;
      if (f) {
        var hi = f.filter(function (x) { return x && x.level === 'high'; }).length;
        out.push(['检出', String(f.length) + ' 项']);
        out.push(['高危', String(hi) + ' 项']);
      } else { out.push(['检出', '—']); out.push(['高危', '—']); }
      return out;
    }
    if (key === 'isOos') {
      out.push(['样本内', fmtPct(g.is, true)]);
      out.push(['样本外', fmtPct(g.oos, true)]);
      out.push(['衰减', fmtPct(g.decay)]);
      return out;
    }
    if (key === 'universe') {
      out.push(['正收益', intOrDash(g.positive) + ' / ' + intOrDash(g.tested)]);
      out.push(['占比', fmtPct(g.positiveRatio)]);
      return out;
    }
    if (key === 'phase') {
      out.push(['牛市', fmtPct(g.bull, true)]);
      out.push(['震荡', fmtPct(g.range, true)]);
      out.push(['熊市', fmtPct(g.bear, true)]);
      return out;
    }
    if (key === 'dual') {
      if (g.reason !== undefined && g.reason !== null && String(g.reason) !== '') out.push(['说明', String(g.reason)]);
      return out;
    }
    return out;
  }
  function renderGateResult(result, metricsFallback) {
    var res = result || {};
    var gates = res.gates || {};
    var metrics = res.metrics || metricsFallback || {};
    state.gateResult = { metrics: metrics, gates: gates, verdict: res.verdict };

    var v = res.verdict;
    var box = $('gate-verdict-box');
    box.className = 'verdict-box' +
      (v === 'usable' ? ' v-usable' : v === 'doubtful' ? ' v-doubtful' : v === 'unusable' ? ' v-unusable' : '');
    $('gate-verdict-big').textContent = VERDICT_CN[v] || '—';
    var chip = $('gate-verdict-chip');
    chip.className = 'chip ' + (VERDICT_CLS[v] || 'chip-c');
    chip.textContent = VERDICT_CN[v] || '无结论';

    // 未通过 / 无法检验的具体闸 + 该闸的关键数字
    var problems = [];
    GATE_DEFS.forEach(function (d) {
      var g = gates[d.key];
      if (g && g.pass === true) return;
      var txt = (g && g.pass === false) ? '未通过' : '无法检验';
      var figs = gateFigures(d.key, g || {});
      var figTxt = figs.map(function (p) { return p[0] + ' ' + p[1]; }).join(' / ');
      problems.push(d.no + ' ' + d.name + '（' + txt + (figTxt ? '：' + figTxt : '') + '）');
    });
    $('gate-verdict-why').textContent = Object.keys(gates).length
      ? (problems.length ? '未通过 / 无法检验的具体闸：' + problems.join('；') : '五道闸全部通过。')
      : '接口未返回五道闸明细，无法给出具体依据。';

    // 五道闸纵向步骤条（三态）
    $('gate-list').innerHTML = GATE_DEFS.map(function (d) {
      var g = gates[d.key] || {};
      var st = gateState(g.pass);
      var figs = gateFigures(d.key, g);
      return '<div class="gate ' + st.cls + '">' +
        '<span class="ico" aria-hidden="true">' + st.ico + '</span>' +
        '<div class="body">' +
          '<div class="t">' + esc(d.no + ' ' + d.name) +
            '<span class="chip ' + st.chip + '" style="margin:0">' + esc(st.text) + '</span></div>' +
          '<div class="d">' + esc(st.desc) + '</div>' +
          (figs.length ? '<div class="figs">' + figs.map(function (p) {
            return '<span>' + esc(p[0]) + ' <b>' + esc(p[1]) + '</b></span>';
          }).join('') + '</div>' : '') +
        '</div></div>';
    }).join('');

    renderGateMetrics(metrics);
    var s = strategyById(state.gateStrategyId);
    $('gate-suspect').hidden = !(s && s.status === 'suspect');
    $('gate-suspect').textContent = SUSPECT_TEXT;
    $('gate-result').hidden = false;
  }
  function renderGateMetrics(metrics) {
    var box = $('gate-kpis');
    box.textContent = '';
    if (!metrics || !Object.keys(metrics).length) {
      box.appendChild(el('p', 'lab-sub', '暂无指标数据（接口未返回 metrics）。'));
      return;
    }
    var rows = [
      ['交易笔数', num(metrics.trades, 0)],
      ['胜率', fmtPct(metrics.winRate)],
      ['收益', fmtPct(metrics.ret, true)],
      ['最大回撤', fmtPct(metrics.maxDD)],
      ['夏普', num(metrics.sharpe, 2)],
    ];
    Object.keys(metrics).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(METRIC_LABELS, k)) rows.push([k, rawStr(metrics[k])]);
    });
    rows.forEach(function (r) {
      var c = el('div', 'kpi');
      c.appendChild(el('div', 'k', r[0]));
      c.appendChild(el('div', 'v num', r[1]));
      box.appendChild(c);
    });
  }

  /* ================= 明细抽屉（role=dialog aria-modal + 焦点管理） ================= */
  var lastFocused = null;
  function openDrawer(metrics, gates, label) {
    lastFocused = document.activeElement;
    $('drawer-title').textContent = '五道闸 · 指标原始值';
    var body = $('drawer-body');
    body.textContent = '';
    body.appendChild(el('p', 'dlg-sub',
      (label ? '策略：' + label + '。' : '') + '以下为接口返回的原始数值，未做单位换算。'));
    body.appendChild(el('h3', 'sect-h', '关键指标 metrics'));
    if (metrics && Object.keys(metrics).length) {
      appendRawTable(body, Object.keys(metrics).map(function (k) {
        return [METRIC_LABELS[k] || k, rawStr(metrics[k])];
      }));
    } else {
      body.appendChild(el('p', 'lab-sub', '暂无指标数据（接口未返回 metrics）。'));
    }
    var det = document.createElement('details');
    det.className = 'lab-details';
    det.appendChild(el('summary', '', '各道闸原始值 gates'));
    if (gates && Object.keys(gates).length) {
      var grows = [];
      flatten(gates, '', grows, 0);
      var wrap = el('div', '');
      wrap.style.padding = '0 14px 14px';
      appendRawTable(wrap, grows);
      det.appendChild(wrap);
    } else {
      var p = el('p', 'lab-sub', '未返回五道闸原始值。');
      p.style.padding = '0 14px 14px';
      det.appendChild(p);
    }
    body.appendChild(det);

    var dlg = $('drawer');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    $('drawer-close').focus();
  }
  function appendRawTable(container, rows) {
    var t = el('table', 'drawer-raw');
    var tb = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var th = el('th', '', r[0]); th.scope = 'row';
      tr.appendChild(th); tr.appendChild(el('td', '', r[1]));
      tb.appendChild(tr);
    });
    t.appendChild(tb); container.appendChild(t);
  }
  function flatten(obj, prefix, out, depth) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function (k) {
      var key = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flatten(v, key, out, depth + 1);
      else out.push([key, rawStr(v)]);
    });
  }
  function closeDrawer() {
    var dlg = $('drawer');
    if (dlg.open && typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
  function wireDrawer() {
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-ok').addEventListener('click', closeDrawer);
    var dlg = $('drawer');
    dlg.addEventListener('close', function () {
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
      lastFocused = null;
    });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeDrawer(); });
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var nodes = dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      var list = Array.prototype.filter.call(nodes, function (x) { return !x.disabled; });
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ================= 信号 ================= */
  function enumerateDates(from, to, fallback) {
    var a, b;
    if (from && to && from <= to) { a = from; b = to; }
    else { a = fallback; b = fallback; }
    if (!a || !b) return [];
    var start = new Date(a + 'T00:00:00'), end = new Date(b + 'T00:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [a];
    var out = [], cur = new Date(start.getTime()), count = 0, MAX = 62;
    while (cur <= end && count < MAX) {
      out.push(localDateStr(cur));
      cur.setDate(cur.getDate() + 1);
      count++;
    }
    return out;
  }
  async function loadSignalPanel() {
    await ensureStrategies();
    if (!$('sig-date').value) $('sig-date').value = localDateStr();
    await runSignals();
  }
  async function runSignals() {
    state.signalRows = [];   // 避免导出上一次的陈旧结果
    var fallback = $('sig-date').value || localDateStr();
    var from = $('sig-from').value, to = $('sig-to').value;
    if (from && to && from > to) {
      renderSignals([], { note: '起始日不能晚于截止日，请调整日期范围。' });
      return;
    }
    var dates = enumerateDates(from, to, fallback);
    if (!dates.length) { renderSignals([], { note: '请选择有效日期。' }); return; }

    var results = await Promise.all(dates.map(function (d) {
      return api('/api/lab/signals?date=' + encodeURIComponent(d))
        .then(function (data) { return { date: d, data: data, error: null }; })
        .catch(function (e) { return { date: d, data: null, error: e }; });
    }));
    var okCount = results.filter(function (r) { return !r.error; }).length;
    if (okCount === 0) {
      throw new Error((results[0] && results[0].error && results[0].error.message) || '信号接口请求失败');
    }

    var rows = [], scannedSum = 0, scannedOk = true;
    results.forEach(function (r) {
      if (r.error || !r.data) return;
      var list = Array.isArray(r.data.list) ? r.data.list : [];
      list.forEach(function (it) {
        if (!it) return;
        rows.push({
          date: it.date ? String(it.date) : r.date,
          strategyId: it.strategyId !== undefined && it.strategyId !== null ? String(it.strategyId) : '',
          version: it.version !== undefined && it.version !== null ? String(it.version) : '',
          code: it.code !== undefined && it.code !== null ? String(it.code) : '',
          action: it.action !== undefined && it.action !== null ? String(it.action) : '',
          price: it.price,
          track: it.track || {},
        });
      });
      if (isNum(r.data.scanned)) scannedSum += Number(r.data.scanned);
      else scannedOk = false;
    });

    // 策略筛选 + 日期范围过滤（基于接口返回的真实字段）
    var strat = $('sig-strategy').value;
    rows = rows.filter(function (r) {
      if (strat && r.strategyId !== strat) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    });

    var notes = ['查询 ' + dates.length + ' 个交易日，返回 ' + rows.length + ' 条信号'];
    if (scannedOk) notes.push((dates.length === 1 ? '扫描 ' : '累计扫描 ') + scannedSum + ' 只标的');
    var failed = results.length - okCount;
    if (failed) notes.push(failed + ' 个日期加载失败，未纳入统计');
    if (from && to) {
      var total = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
      if (total > 62) notes.push('范围超过 62 天，仅查询前 62 天');
    }
    state.signalRows = rows;
    state.signalDate = dates.length === 1 ? dates[0] : (dates[0] + '_' + dates[dates.length - 1]);
    renderSignals(rows, { note: notes.join(' · ') });
  }
  function renderSignals(rows, info) {
    $('sig-note').textContent = info && info.note ? info.note : '';
    var wrap = $('sig-table-wrap'), empty = $('sig-empty'), tbody = $('sig-tbody');
    tbody.textContent = '';
    if (!rows.length) { wrap.hidden = true; empty.hidden = false; return; }
    wrap.hidden = false; empty.hidden = true;
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'muted', r.date));
      tr.appendChild(el('td', '', r.strategyId || '—'));
      // 信号代码点跳分析台（06 §5.2 下钻映射），data-back 让返回时保留 tab 与筛选
      var codeTd = document.createElement('td');
      codeTd.className = 'strong';
      if (/^\d{6}$/.test(String(r.code || ''))) {
        var a = document.createElement('a');
        a.href = '/?code=' + encodeURIComponent(String(r.code));
        a.setAttribute('data-back', 'lab');
        a.textContent = String(r.code);
        codeTd.appendChild(a);
      } else {
        codeTd.textContent = r.code || '—';
      }
      tr.appendChild(codeTd);
      tr.appendChild(el('td', '', ACTION_CN[r.action] || r.action || '—'));
      tr.appendChild(el('td', 'r', num(r.price, 2)));
      ['t1', 't5', 't10'].forEach(function (k) {
        var v = r.track ? r.track[k] : null;
        var cls = isNum(v) ? (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'dn' : '') : 'muted';
        tr.appendChild(el('td', 'r ' + cls, isNum(v) ? fmtTrackPct(v) : '—'));
      });
      tbody.appendChild(tr);
    });
  }
  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    var rows = state.signalRows || [];
    if (!rows.length) {
      $('sig-note').textContent = '当前没有可导出的信号。';
      announce('当前没有可导出的信号');
      return;
    }
    var head = ['日期', '策略ID', '版本', '代码', '动作', '信号日收盘价', 'T+1', 'T+5', 'T+10'];
    var lines = [head.map(csvCell).join(',')];
    rows.forEach(function (r) {
      lines.push([
        r.date, r.strategyId, r.version, r.code, r.action, r.price,
        r.track ? r.track.t1 : null, r.track ? r.track.t5 : null, r.track ? r.track.t10 : null,
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'lab-signals-' + (state.signalDate || 'export') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    announce('已导出 ' + rows.length + ' 条信号为 CSV');
  }
  function wireSignals() {
    $('sig-reload').addEventListener('click', function () { guard(runSignals); });
    $('sig-export').addEventListener('click', exportCsv);
    ['sig-date', 'sig-strategy', 'sig-from', 'sig-to'].forEach(function (id) {
      $(id).addEventListener('change', function () { guard(runSignals); });
    });
  }

  /* ================= 跟踪 ================= */
  async function loadTrackPanel() {
    await ensureStrategies();
    var sel = $('track-strategy');
    if (!sel.value) { showTrackEmpty('暂无策略，无法查看跟踪数据。'); return; }
    await runTrack(sel.value);
  }
  async function runTrack(id) {
    if (!id) { showTrackEmpty('请选择一个策略。'); return; }
    var d = await api('/api/lab/track?strategyId=' + encodeURIComponent(String(id)));
    if (!d) { showTrackEmpty('接口未返回跟踪数据。'); return; }
    renderTrack(d);
  }
  function showTrackEmpty(text) {
    $('track-content').hidden = true;
    $('track-empty').textContent = text;
    $('track-empty').hidden = false;
    $('track-degraded').hidden = true;
  }
  function setBar(fillId, valId, pctNum) {
    var val = $(valId);
    if (pctNum === null) {
      val.textContent = '样本不足'; val.className = 'bar-val na';
      $(fillId).style.width = '0%';
    } else {
      val.textContent = pctNum.toFixed(1) + '%'; val.className = 'bar-val num';
      $(fillId).style.width = clamp(pctNum, 0, 100) + '%';
    }
  }
  function renderTrack(d) {
    var live = toPctNum(d.liveWinRate);
    var bt = toPctNum(d.backtestWinRate);
    var list = Array.isArray(d.list) ? d.list : [];
    if (live === null && bt === null && !list.length) { showTrackEmpty('暂无跟踪数据。'); return; }
    $('track-empty').hidden = true;
    $('track-content').hidden = false;
    setBar('bar-live', 'bar-live-val', live);
    setBar('bar-bt', 'bar-bt-val', bt);
    var deg = $('track-degraded');
    if (d.degraded) {
      var extra = (live !== null && bt !== null) ? '（实盘低于回测 ' + (bt - live).toFixed(1) + ' 个百分点）' : '';
      deg.textContent = SUSPECT_TEXT + extra;
      deg.hidden = false;
    } else deg.hidden = true;
    $('track-count').textContent = String(list.length);
    var body = $('track-list-body');
    body.textContent = '';
    if (list.length) {
      var keys = [];
      list.forEach(function (it) {
        if (it && typeof it === 'object') {
          Object.keys(it).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
        }
      });
      var t = el('table', 'tbl');
      var thead = document.createElement('thead'), htr = document.createElement('tr');
      keys.forEach(function (k) { htr.appendChild(el('th', '', k)); });
      thead.appendChild(htr); t.appendChild(thead);
      var tb = document.createElement('tbody');
      list.forEach(function (it) {
        var tr = document.createElement('tr');
        keys.forEach(function (k) {
          var v = (it && it[k] !== undefined) ? it[k] : null;
          tr.appendChild(el('td', '', v === null ? '—' : rawStr(v)));
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb); body.appendChild(t);
    } else {
      body.appendChild(el('p', 'lab-sub', '接口未返回跟踪明细记录。'));
    }
  }
  function wireTrack() {
    $('track-reload').addEventListener('click', function () {
      guard(function () { return runTrack($('track-strategy').value); });
    });
    $('track-strategy').addEventListener('change', function () {
      guard(function () { return runTrack($('track-strategy').value); });
    });
  }

  /* ================= 批量对比 ================= */
  async function loadBatchPanel() { await ensureStrategies(); }
  function renderBatch() {
    var list = state.strategies || [];
    var wrap = $('batch-wrap'), empty = $('batch-empty'), tbody = $('batch-tbody');
    tbody.textContent = '';
    if (!list.length) { wrap.hidden = true; empty.hidden = false; return; }
    wrap.hidden = false; empty.hidden = true;
    list.forEach(function (s) {
      var m = (s.gate && s.gate.metrics) || {};
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'strong', s.name ? String(s.name) : (s.id ? String(s.id) : '未命名策略')));
      tr.appendChild(el('td', 'muted', TYPE_CN[s.type] || (s.type ? String(s.type) : '—')));
      tr.appendChild(el('td', 'r', s.version !== undefined && s.version !== null ? 'v' + s.version : '—'));
      var tdS = document.createElement('td');
      tdS.innerHTML = statusChip(s);
      if (s.status === 'suspect') tdS.appendChild(el('span', 'suspect-note', SUSPECT_TEXT));
      tr.appendChild(tdS);
      var tdV = document.createElement('td');
      tdV.innerHTML = s.gate && s.gate.verdict
        ? verdictChip(s.gate.verdict)
        : '<span class="chip chip-c" style="margin:0">未验证</span>';
      tr.appendChild(tdV);
      tr.appendChild(el('td', 'r', num(m.trades, 0)));
      tr.appendChild(el('td', 'r', fmtPct(m.winRate)));
      tr.appendChild(el('td', 'r', fmtPct(m.ret, true)));
      tr.appendChild(el('td', 'r', fmtPct(m.maxDD)));
      tr.appendChild(el('td', 'r', num(m.sharpe, 2)));
      tbody.appendChild(tr);
    });
  }
  function wireBatch() {
    $('batch-refresh').addEventListener('click', function () {
      state.strategies = null;
      guard(loadBatchPanel);
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    $('global-error-retry').addEventListener('click', function () {
      var f = state.retry;
      clearError();
      if (f) f();
    });
    $('global-error-close').addEventListener('click', clearError);

    wireTabs();
    wireEditor();
    wireSignals();
    wireTrack();
    wireBatch();
    wireDrawer();
    $('gate-detail-btn').addEventListener('click', function () {
      var r = state.gateResult || {};
      var s = strategyById(state.gateStrategyId);
      openDrawer(r.metrics || {}, r.gates || null, s ? strategyLabel(s) : '');
    });

    $('sig-date').value = localDateStr();
    guard(loadHealth);
    selectTab(0, false);

    // 下钻返回原位置（06 §5.2）：记住当前 tab 与信号筛选，回来时还原
    window.QLPageState = function () {
      var t = document.querySelector('[role="tab"][aria-selected="true"]');
      return {
        tab: t ? t.id : null,
        sigFrom: $('sig-from') ? $('sig-from').value : null,
        sigTo: $('sig-to') ? $('sig-to').value : null,
        strategy: $('sig-strategy') ? $('sig-strategy').value : null,
      };
    };
    window.QLApplyState = function (s) {
      if (!s) return;
      if ($('sig-from') && s.sigFrom) $('sig-from').value = s.sigFrom;
      if ($('sig-to') && s.sigTo) $('sig-to').value = s.sigTo;
      if (s.tab) {
        var btn = document.getElementById(s.tab);
        if (btn) btn.click();            // 走页面自己的 tab 切换逻辑，不绕过
      }
    };
  }
  boot();
})();
