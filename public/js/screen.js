/* ============================================================
 * QuantLab · 选股器
 *
 * 数据全部来自真实行情接口（新浪全市场快照 + 同花顺/新浪 K 线），
 * 没有任何模拟、随机或造出来的样本：
 *   1) 行情条件在全市场 5000+ 只上本地过滤，实时生效
 *   2) 形态对「当前股票池的全部标的」做服务端扫描（主板 3160 只），
 *      每只取 260 根真实日线，算法与精算共用 public/js/shape.js
 *   3) 流派评分只对命中的标的做，逐只拉 1200 根日线 + 周/月线，
 *      交给与详情页完全相同的 QLMount(headless) 计算，不截断候选
 * ============================================================ */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const SHAPE = window.QLShape;
  const S = {
    all: [],
    filtered: [],
    result: [],          // 精算后的结果（含 screen 字段）
    shape: {},           // code -> 形态特征（全池扫描结果）
    scan: { total: 0, done: 0, at: null, running: false, pending: false, poolDone: null },
    mode: 'filter',      // filter | screen
    sort: 'amount',
    dir: -1,
    strategy: 'jinkeng',
    running: false,
    stopReq: false,
    updatedAt: null,
    trading: false,
    limit: 300,          // 表格最多渲染 300 行
    pool: 'main',
  };

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function fmtAmt(v) {
    if (v == null || !v) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e9 ? 0 : 2) + '亿';
    return Math.round(v / 1e4) + '万';
  }
  function fmtCap(v) {
    if (v == null || !v) return '—';
    return (v / 1e8).toFixed(v >= 1e10 ? 0 : 1) + '亿';
  }
  function fmtPct(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    const d = digits == null ? 2 : digits;
    return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  }
  function fmt2(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(2);
  }
  function cls(v) { return v > 0 ? 'up' : v < 0 ? 'dn' : 'fl'; }
  function num(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
  }

  const api = (url, opt) => fetch(url, opt).then((r) => r.json()).then((j) => {
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j.data;
  });

  /* ---------------- 股票池 ---------------- */
  function inPool(x) {
    return SHAPE ? SHAPE.inPool(x.code, S.pool) : true;
  }
  function poolCodes() {
    return S.all.filter(inPool).map((x) => x.code);
  }

  /* ---------------- 条件读取 ---------------- */
  function readCond() {
    return {
      pMin: num('fPriceMin'), pMax: num('fPriceMax'),
      cMin: num('fChgMin'), cMax: num('fChgMax'),
      tMin: num('fTurnMin'), tMax: num('fTurnMax'),
      aMin: num('fAmpMin'), aMax: num('fAmpMax'),
      amt: Number($('#fAmt').value) || 0,
      cap: Number($('#fCap').value) || 0,
      limit: Number($('#fLimit').value) || 100,
      peMin: num('fPeMin'), peMax: num('fPeMax'),
      pbMin: num('fPbMin'), pbMax: num('fPbMax'),
      exST: $('#fExST').checked,
      exNew: $('#fExNew').checked,
      exLow: $('#fExLow').checked,
      exLoss: $('#fExLoss').checked,
    };
  }

  /** 行情层筛选：只用快照字段，池内标的本地过滤（毫秒级），不含形态 */
  function filterMarket() {
    const c = readCond();
    const out = [];
    for (const x of S.all) {
      if (!inPool(x)) continue;

      if (c.exST && /ST|退/.test(x.name)) continue;
      if (c.exNew && /^[NC]/.test(x.name)) continue;
      if (c.exLow && x.price != null && x.price < 2) continue;
      if (c.exLoss && x.pe != null && x.pe <= 0) continue;

      if (c.pMin != null && !(x.price >= c.pMin)) continue;
      if (c.pMax != null && !(x.price <= c.pMax)) continue;
      if (c.cMin != null && !(x.chgPct >= c.cMin)) continue;
      if (c.cMax != null && !(x.chgPct <= c.cMax)) continue;
      if (c.tMin != null && !(x.turnover >= c.tMin)) continue;
      if (c.tMax != null && !(x.turnover <= c.tMax)) continue;
      if (c.aMin != null && !(x.amplitude >= c.aMin)) continue;
      if (c.aMax != null && !(x.amplitude <= c.aMax)) continue;
      if (c.amt && !(x.amount >= c.amt)) continue;
      if (c.cap && !(x.floatCap >= c.cap)) continue;

      if (c.peMin != null && !(x.pe >= c.peMin)) continue;
      if (c.peMax != null && !(x.pe <= c.peMax)) continue;
      if (c.pbMin != null && !(x.pb >= c.pbMin)) continue;
      if (c.pbMax != null && !(x.pb <= c.pbMax)) continue;

      if (c.limit < 100) {
        const up = upLimitOf(x);
        if (!up) continue;
        const gap = (up - x.price) / x.price * 100;
        if (!(gap >= 0 && gap <= c.limit)) continue;
      }

      out.push(x);
    }
    return out;
  }

  /** 涨停价：主板 10%、创业板/科创板 20%、北交所 30%、ST 5% */
  function upLimitOf(x) {
    if (!x.prevClose) return null;
    let pct = 0.10;
    if (/^(30|688)/.test(x.code)) pct = 0.20;
    else if (/^(4|8|9)/.test(x.code)) pct = 0.30;
    if (/ST/.test(x.name)) pct = 0.05;
    return Math.round(x.prevClose * (1 + pct) * 100) / 100;
  }

  /* ---------------- 形态 ---------------- */
  /** 是否启用了任一形态条件（启用了就必须先有扫描结果，否则无法判定） */
  function shapeOn() {
    if ($('#fMaBull').checked || $('#fAbove20').checked || $('#fMa20Up').checked
      || $('#fVolUp').checked || $('#fNew60').checked) return true;
    return num('fGain5') != null || num('fPos') != null;
  }

  function passShape(f) {
    if (!f) return false;
    if ($('#fMaBull').checked && !f.maBull) return false;
    if ($('#fAbove20').checked && !f.above20) return false;
    if ($('#fMa20Up').checked && !f.ma20Up) return false;
    if ($('#fVolUp').checked && !f.volUp) return false;
    if ($('#fNew60').checked && !f.new60) return false;
    const g5 = num('fGain5');
    if (g5 != null && !(f.gain5 >= g5)) return false;
    const posMin = num('fPos');
    if (posMin != null && !(f.pos >= posMin)) return false;
    return true;
  }

  /** 形态过滤：只看已扫描的标的；未扫描的不会被当成「不合格」而静默丢弃 */
  function shapeFilter(list) {
    if (!shapeOn()) return list;
    return list.filter((x) => passShape(S.shape[x.code]));
  }

  /* ---------------- 全池形态扫描 ---------------- */
  /** 当前池内已覆盖多少只（服务端缓存 + 本轮扫描结果） */
  function poolHave() {
    let n = 0;
    for (const x of S.all) if (inPool(x) && S.shape[x.code]) n++;
    return n;
  }

  /**
   * 对当前股票池逐批扫描形态。服务端对当日已扫过的标的直接回缓存，
   * 所以这个函数幂等：换池子、隔一会儿再点，只补没扫过的部分。
   * quiet = 静默模式：服务端已经扫满时直接取回结果，不打扰用户。
   */
  async function scanPool(opt) {
    const force = !!(opt && opt.force);
    const quiet = !!(opt && opt.quiet);
    if (S.scan.running) { S.scan.pending = true; return; }
    const codes = poolCodes();
    if (!codes.length) return;

    S.scan.running = true;
    S.scan.total = codes.length;
    S.scan.done = 0;
    if (!quiet) {
      $('#btnScan').disabled = true;
      $('#btnScan').textContent = '扫描中…';
      // 扫描期间先别精算：否则算的是「扫到一半」的子集，扫完数字又变，容易看不懂
      $('#btnRun').disabled = true;
      $('#scProg').hidden = false;
    }

    const B = 120;
    let ok = 0, fail = 0;
    try {
      for (let i = 0; i < codes.length; i += B) {
        const batch = codes.slice(i, i + B);
        const res = await api('/api/screen/shape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: batch, force }),
        });
        for (const c of Object.keys(res.data || {})) S.shape[c] = res.data[c];
        ok += res.scanned || 0;
        fail += (res.failed || []).length;
        S.scan.done = Math.min(codes.length, i + batch.length);
        if (!quiet) {
          setProg(S.scan.done / codes.length, `扫描形态 ${S.scan.done}/${codes.length} 只（本轮新取 ${ok}，失败 ${fail}）`);
        }
        if (i % (B * 4) === 0) refresh();
      }
      S.scan.at = Date.now();
      // 记下「这个池子本轮已经完整扫过」：新股/停牌股永远扫不出结果，
      // 只按覆盖率判断会导致每次勾选都重新扫一遍全池
      S.scan.poolDone = S.pool;
      if (!quiet) {
        setProg(1, `形态已覆盖 ${S.scan.done}/${codes.length} 只` + (fail ? `，${fail} 只取数失败` : ''));
        setTimeout(() => { if (!S.scan.running) $('#scProg').hidden = true; }, 1200);
      }
    } catch (e) {
      if (!quiet) {
        setProg(1, '形态扫描失败：' + e.message);
        setTimeout(() => { $('#scProg').hidden = true; }, 3000);
      }
    } finally {
      S.scan.running = false;
      $('#btnScan').disabled = false;
      $('#btnScan').textContent = '扫描全池';
      $('#btnRun').disabled = false;
      updateScanInfo();
      refresh();
      if (S.scan.pending) { S.scan.pending = false; setTimeout(() => scanPool(), 50); }
    }
  }

  /** 服务端今日已扫满时，静默把结果取回来（几十个请求一两秒，用户无感） */
  async function autoCover() {
    if (S.scan.running) return;
    try {
      const c = await api('/api/screen/shape/coverage?pool=' + encodeURIComponent(S.pool));
      if (c.total && c.covered >= c.total * 0.6) await scanPool({ quiet: true });
    } catch (e) { /* 取不到覆盖率就让用户手动点扫描 */ }
  }

  function updateScanInfo() {
    const el = $('#scanInfo');
    if (!S.all.length) { el.textContent = '等待行情'; return; }
    const total = poolCodes().length;
    const have = poolHave();
    if (!have) { el.textContent = `未扫描 · 池内 ${total} 只`; el.className = 'scan-info'; return; }
    const t = S.scan.at ? new Date(S.scan.at) : null;
    const hm = t ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '';
    el.textContent = `已覆盖 ${have}/${total} 只` + (hm ? ' · ' + hm : '');
    el.className = 'scan-info' + (have >= total ? ' ok' : '');
  }

  /* ---------------- 排序 ---------------- */
  function sortList(list) {
    const k = S.sort;
    const d = S.dir;
    return list.slice().sort((a, b) => {
      let va = a[k], vb = b[k];
      if (k === 'screen') { va = a.screen ? a.screen.score : null; vb = b.screen ? b.screen.score : null; }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * d;
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const base = S.mode === 'screen' && S.result.length ? S.result : S.filtered;
    const list = sortList(base);
    const shown = list.slice(0, S.limit);

    const poolN = poolCodes().length;
    $('#allN').textContent = poolN ? poolN.toLocaleString() : '—';
    $('#hitN').textContent = list.length ? list.length.toLocaleString() : '0';
    $('#tbHit').textContent = list.length.toLocaleString();

    const btn = $('#btnRun');
    if (!S.running) {
      btn.textContent = list.length ? `精算 ${list.length} 只` : '精算';
      // 按实测 ~0.27s/只（1200 日线 + 周/月线，6 并发）给个预期，免得以为卡住
      const sec = Math.round(list.length * 0.27);
      btn.title = list.length
        ? `预计 ${sec >= 90 ? Math.round(sec / 60) + ' 分钟' : sec + ' 秒'}（每只都要现拉 K 线，可随时停止）`
        : '';
    }

    if (S.mode === 'screen') {
      $('#tbSub').textContent = `· 已精算 ${S.result.length} 只 · ${stratName()}`;
    } else {
      const has = poolHave();
      $('#tbSub').textContent = shapeOn()
        ? `· 形态已覆盖 ${has}/${poolN} 只` + (S.scan.running ? '（扫描中）' : '')
        : '· 行情条件筛选（形态未启用）';
    }

    if (!list.length) {
      $('#tbody').innerHTML = '';
      $('#scEmpty').hidden = false;
      if (S.scan.running) {
        $('#scEmpty').textContent = `正在扫描形态 ${S.scan.done}/${S.scan.total} 只，扫完自动出结果…`;
      } else if (shapeOn() && poolHave() < poolN) {
        $('#scEmpty').textContent = '形态尚未覆盖全部标的，点左侧「扫描全池」补扫';
      } else {
        $('#scEmpty').textContent = S.all.length ? '没有符合条件的标的，试着放宽条件' : '正在加载行情…';
      }
      $('#scMore').hidden = true;
      updateScanInfo();
      return;
    }
    $('#scEmpty').hidden = true;

    const rows = shown.map((x, i) => {
      const sc = x.screen;
      const feat = x.feats || S.shape[x.code];
      const tags = ((feat && feat.tags) || []).slice(0, 2).map((t) => `<i class="tag">${esc(t)}</i>`).join('');
      const scoreCell = sc
        ? `<div class="sc-cell"><b class="${sc.score > 0 ? 'up' : sc.score < 0 ? 'dn' : 'fl'}">${sc.score > 0 ? '+' : ''}${Math.round(sc.score)}</b></div>`
        : '<span class="mut">—</span>';
      const verdict = sc
        ? `<span class="vd ${sc.score > 0 ? 'up' : sc.score < 0 ? 'dn' : 'fl'}" title="${esc(sc.verdict)}">${esc(sc.verdict).slice(0, 46)}</span>`
        : '<span class="mut">—</span>';
      return `<tr data-code="${x.code}" class="row">
        <td class="c-idx">${i + 1}</td>
        <td class="c-name">
          <span class="nm">${esc(x.name)}</span>
          <span class="cd">${x.code}</span>
        </td>
        <td class="c-num ${cls(x.chgPct)}"${x.noTrade ? ' title="盘前尚未成交，显示昨收价"' : ''}>${fmt2(x.price)}</td>
        <td class="c-num ${cls(x.chgPct)}">${x.noTrade && !x.chgPct ? '—' : fmtPct(x.chgPct)}</td>
        <td class="c-num">${fmtAmt(x.amount)}</td>
        <td class="c-num">${x.turnover == null || (x.noTrade && !x.turnover) ? '—' : x.turnover.toFixed(2) + '%'}</td>
        <td class="c-num">${fmtCap(x.floatCap)}</td>
        <td class="c-num">${x.pe == null ? '—' : (x.pe < 0 ? '亏' : x.pe.toFixed(1))}</td>
        <td class="c-tag">${tags || '<span class="mut">—</span>'}</td>
        <td class="c-score">${scoreCell}</td>
        <td class="c-verdict">${verdict}</td>
      </tr>`;
    }).join('');

    $('#tbody').innerHTML = rows;
    if (list.length > S.limit) {
      $('#scMore').hidden = false;
      $('#scMore').textContent = `仅显示前 ${S.limit} 条（共 ${list.length} 只），再收一收条件或按成交额排序看头部`;
    } else {
      $('#scMore').hidden = true;
    }

    $$('.sc-tbl thead th').forEach((th) => {
      th.classList.toggle('on', th.dataset.sort === S.sort);
      th.classList.toggle('desc', th.dataset.sort === S.sort && S.dir === -1);
    });
    updateScanInfo();
  }

  function stratName() {
    const opt = $('#fStrategy').selectedOptions[0];
    return opt ? opt.textContent : '';
  }

  /* ---------------- 精算 ---------------- */
  const CALC_BATCH = 40;

  /**
   * 对当前命中的全部标的逐只拉真实 K 线，用与详情页同一个 QLMount(headless) 跑流派评分。
   * 不截断候选：命中多少算多少（形态已把范围收窄到几十~几百只）。
   * 这一步不产出任何虚构数值：拿不到 K 线的标的直接跳过，不参与排序。
   */
  async function runScreen() {
    if (S.running) { S.stopReq = true; $('#btnRun').textContent = '停止中…'; return; }
    const base = sortList(S.filtered);
    if (!base.length) return;

    // 全量精算要逐只拉 K 线，几千只要十几分钟：先问一句，避免误点
    if (base.length > 800) {
      const min = Math.round(base.length * 0.27 / 60);
      if (!window.confirm(`将对 ${base.length} 只标的逐只拉真实 K 线，预计约 ${min} 分钟。\n\n建议先勾一个形态（如均线多头）把范围收窄。仍要继续吗？`)) return;
    }

    const sid = S.strategy;
    S.running = true;
    S.stopReq = false;
    const btn = $('#btnRun');
    btn.disabled = false;
    btn.textContent = '停止';
    $('#scProg').hidden = false;
    const est = Math.round(base.length * 0.27);
    setProg(0, `精算 ${base.length} 只，预计 ${est >= 90 ? Math.round(est / 60) + ' 分钟' : est + ' 秒'}…`);

    const out = [];
    const t0 = performance.now();
    let bench = null, benchName = '';
    let cursor = 0;

    try {
      while (cursor < base.length) {
        if (S.stopReq) break;
        const batch = base.slice(cursor, cursor + CALC_BATCH);
        let res;
        try {
          res = await api('/api/screen/klines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codes: batch.map((x) => x.code), bars: 1200 }),
          });
        } catch (e) {
          cursor += batch.length;
          continue;                   // 单批失败不拖垮整轮，进度继续
        }
        if (!bench && res.bench) { bench = res.bench; benchName = res.benchName; }

        for (const item of batch) {
          const d = res.data[item.code];
          if (!d || !d.klines || d.klines.length < 60) continue;

          let rec = null;
          try {
            const inst = window.QLMount(d.klines, {
              headless: true,
              code: item.code,
              name: d.name || item.name,
              isIndex: false,
              floatShares: d.floatShares || null,
              week: d.week,
              month: d.month,
              bench: bench,
              benchName: benchName,
            });
            rec = inst.analyzeOne(sid);
          } catch (e) {
            rec = { score: 0, verdict: '计算失败：' + e.message, points: [] };
          }

          out.push(Object.assign({}, item, {
            screen: rec,
            feats: S.shape[item.code] || SHAPE.shapeOf(d.klines),
            bars: d.klines.length,
          }));
        }

        cursor += batch.length;
        const p = 0.02 + 0.96 * (cursor / base.length);
        setProg(p, `已精算 ${Math.min(cursor, base.length)}/${base.length} 只`);
        await new Promise((r) => setTimeout(r, 0));
      }

      S.result = out;
      S.mode = 'screen';
      S.sort = 'screen';
      S.dir = -1;
      $('#sortSel').value = 'screen';
      const ms = Math.round(performance.now() - t0);
      setProg(1, (S.stopReq ? '已停止：' : '完成：') + `${S.result.length} 只 · ${(ms / 1000).toFixed(1)}s`);
      setTimeout(() => { if (!S.running) $('#scProg').hidden = true; }, 1500);
    } catch (e) {
      setProg(1, '精算失败：' + e.message);
      setTimeout(() => { $('#scProg').hidden = true; }, 3000);
    } finally {
      S.running = false;
      btn.disabled = false;
      render();
    }
  }

  function setProg(p, text) {
    $('#progBar').style.width = Math.round(p * 100) + '%';
    if (text) $('#progText').textContent = text;
  }

  /* ---------------- 加载 ---------------- */
  async function loadMarket() {
    setStatus('wait', '正在拉取全市场行情…');
    try {
      const d = await api('/api/screen/market?node=all');
      S.all = d.list || [];
      S.updatedAt = d.updatedAt;
      S.trading = !!d.trading;
      const t = new Date(d.updatedAt);
      const hm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      // 盘前（9:00–集合竞价成交前）新浪快照没有成交价，这里显示的是昨收
      const pre = (d.list || []).filter((x) => x.noTrade).length > (d.list || []).length * 0.5;
      const el = $('#scStatus');
      el.title = '数据源：新浪财经全市场快照（真实行情），服务端缓存 ' + (S.trading ? '60 秒' : '5 分钟');
      setStatus('ok', (S.trading ? '盘中实时' : pre ? '盘前 · 昨收' : '已收盘') + ' · ' + S.all.length.toLocaleString() + ' 只 · ' + hm + ' 更新');
      refresh();
      autoCover();
    } catch (e) {
      setStatus('err', '行情加载失败：' + e.message);
      $('#scEmpty').hidden = false;
      $('#scEmpty').textContent = '行情加载失败，请点右上角刷新重试';
    }
  }

  function setStatus(kind, text) {
    const el = $('#scStatus .dot');
    el.className = 'dot ' + kind;
    $('#stText').textContent = text;
  }

  /** 重算筛选结果（不重置精算结果，除非条件变了） */
  function refresh() {
    S.filtered = shapeFilter(filterMarket());
    if (S.mode === 'screen') {
      const keep = new Set(S.filtered.map((x) => x.code));
      S.result = S.result.filter((x) => keep.has(x.code));
      if (!S.result.length) S.mode = 'filter';
    }
    render();
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $$('#poolSeg button').forEach((b) => {
      b.onclick = () => {
        $$('#poolSeg button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        S.pool = b.dataset.pool;
        S.mode = 'filter';
        S.result = [];
        refresh();
        // 换了池子，形态覆盖范围变了：勾着形态就自动补扫新增部分
        if (shapeOn()) scanPool();
        else autoCover();
      };
    });

    // 行情 / 估值条件：输入即筛选（数字框做 180ms 防抖）
    let t = null;
    const onInput = () => {
      clearTimeout(t);
      t = setTimeout(refresh, 180);
    };
    $$('.sc-panel input, .sc-panel select').forEach((el) => {
      if (el.id === 'fStrategy' || /^f(MaBull|Above20|Ma20Up|VolUp|New60|Gain5|Pos)$/.test(el.id)) return;
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', onInput);
    });

    // 形态条件：未覆盖全池时先补扫，扫的进度条会自己走
    const shapeIds = ['fMaBull', 'fAbove20', 'fMa20Up', 'fVolUp', 'fNew60', 'fGain5', 'fPos'];
    shapeIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        clearTimeout(t);
        t = setTimeout(() => {
          refresh();
          if (shapeOn() && S.scan.poolDone !== S.pool) scanPool();
        }, 180);
      });
    });

    $('#btnScan').onclick = () => scanPool();

    // 排序
    $('#sortSel').onchange = (e) => {
      S.sort = e.target.value;
      S.dir = S.sort === 'pe' ? 1 : -1;
      $('#sortDir').textContent = S.dir === -1 ? '降序 ↓' : '升序 ↑';
      $('#sortDir').dataset.dir = S.dir;
      render();
    };
    $('#sortDir').onclick = () => {
      S.dir = -S.dir;
      $('#sortDir').textContent = S.dir === -1 ? '降序 ↓' : '升序 ↑';
      render();
    };
    $$('.sc-tbl thead th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.sort;
        if (k === 'screen' && S.mode !== 'screen') return;
        if (S.sort === k) S.dir = -S.dir;
        else { S.sort = k; S.dir = -1; }
        $('#sortSel').value = k === 'screen' ? 'screen' : k;
        $('#sortDir').textContent = S.dir === -1 ? '降序 ↓' : '升序 ↑';
        render();
      };
    });

    // 重置
    $('#btnReset').onclick = () => {
      $$('.sc-panel input[type=number]').forEach((el) => { el.value = ''; });
      $('#fAmt').value = '0';
      $('#fCap').value = '0';
      $('#fLimit').value = '100';
      $('#fExST').checked = true;
      $('#fExNew').checked = true;
      $('#fExLow').checked = true;
      $('#fExLoss').checked = false;
      shapeIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.type === 'checkbox') el.checked = false;
      });
      S.mode = 'filter';
      S.result = [];
      refresh();
    };

    $('#btnRun').onclick = runScreen;
    $('#btnReload').onclick = () => {
      S.mode = 'filter';
      S.result = [];
      S.scan = { total: 0, done: 0, at: null, running: false, pending: false, poolDone: null };
      loadMarket();
    };

    // 点行 → 打开详情页，带上当前流派
    $('#tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.row');
      if (!tr) return;
      location.href = '/#' + tr.dataset.code + '/' + S.strategy;
    });

    // 移动端筛选抽屉
    const openPnl = (on) => {
      $('#scPanel').classList.toggle('open', on);
      $('#scMask').classList.toggle('on', on);
      document.body.classList.toggle('pnl-open', on);
    };
    $('#fabFilter').onclick = () => openPnl(!$('#scPanel').classList.contains('open'));
    $('#btnClosePnl').onclick = () => openPnl(false);
    $('#scMask').onclick = () => openPnl(false);
    // 选完条件下自动收起，回到结果列表
    $('#scPanel').addEventListener('change', (e) => {
      if (e.target.tagName !== 'SELECT') return;
      if (e.target.id === 'fStrategy') return;   // 选完流派还要点「精算」
      if (window.innerWidth <= 920) openPnl(false);
    });
  }

  /* ---------------- 流派下拉 ---------------- */
  function fillStrategies() {
    const list = (window.QuantLab && window.QuantLab.strategies) || [];
    $('#fStrategy').innerHTML = list.map((s) => (
      `<option value="${s.id}"${s.id === 'jinkeng' ? ' selected' : ''}>${esc(s.name)}</option>`
    )).join('');
    S.strategy = 'jinkeng';
    $('#fStrategy').onchange = (e) => {
      S.strategy = e.target.value;
      if (S.mode === 'screen') { S.mode = 'filter'; S.result = []; render(); }
    };
  }

  /* ---------------- 启动 ---------------- */
  if (!SHAPE) {
    document.getElementById('scEmpty').hidden = false;
    document.getElementById('scEmpty').textContent = '形态模块未加载（shape.js），请刷新页面';
    return;
  }
  fillStrategies();
  bind();
  loadMarket();
})();
