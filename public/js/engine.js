/* ============================================================
 * QuantLab · Chart Engine
 * Canvas 渲染层：K线、成交量、副图指标、叠加指令、十字光标。
 * 流派只输出声明式指令，不直接操作 canvas —— 这是扩展点。
 * ============================================================ */
(function (global) {
  'use strict';

  const C = {
    bg: '#080B11', grid: '#151D29', gridV: '#121A25',
    axis: '#5A6678', text: '#8C98AB',
    up: '#F6465D', upFill: 'rgba(246,70,93,.85)',
    dn: '#2EBD85', dnFill: 'rgba(46,189,133,.85)',
    cross: '#5C6B82',
  };

  const LAYOUT = { t: 14, mainH: 368, gap1: 20, subH: 132, gap2: 12, volH: 74, xAxis: 26, right: 64, left: 10 };

  class Chart {
    constructor(canvas, tipEl) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.tip = tipEl;
      this.data = [];
      this.ind = {};
      this.overlay = [];
      this.sub = { type: 'none', series: [], refs: [] };
      this.viewStart = 0;
      this.viewCount = 120;
      this.hover = -1;
      this.hoverY = null;
      this.drag = null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 视口一变（缩放 / 拖动 / 换根数）就要重算叠加层，否则信号会停留在旧视野，
      // 表现为「把根数拉到全部后，所有标签仍挤在右侧」。由装配层挂回调，这里只负责通知。
      this.onViewChange = null;
      this._inRender = false;
      this._bind();
    }

    setData(data, ind) {
      this.data = data;
      this.ind = ind;
      this.viewCount = Math.min(90, data.length);
      this.viewStart = Math.max(0, data.length - this.viewCount);
    }

    setOverlay(cmds) { this.overlay = cmds || []; }
    setSub(sub) { this.sub = sub || { type: 'none', series: [], refs: [] }; }
    setRange(n) {
      this.viewCount = Math.min(n, this.data.length);
      this.viewStart = Math.max(0, this.data.length - this.viewCount);
      this.render();
    }

    /* ---------- 坐标 ---------- */
    get W() { return this.cv.clientWidth; }
    get plotW() { return this.W - LAYOUT.left - LAYOUT.right; }
    get mainTop() { return LAYOUT.t; }
    get mainBot() { return LAYOUT.t + LAYOUT.mainH; }
    get subTop() { return this.mainBot + LAYOUT.gap1; }
    get subBot() { return this.subTop + LAYOUT.subH; }
    get volTop() { return this.subBot + LAYOUT.gap2; }
    get volBot() { return this.volTop + LAYOUT.volH; }
    get H() { return this.volBot + LAYOUT.xAxis; }

    x(i) {
      const bw = this.plotW / this.viewCount;
      return LAYOUT.left + (i - this.viewStart + 0.5) * bw;
    }
    bw() { return this.plotW / this.viewCount; }
    yP(p) {
      return this.mainTop + (this.pMax - p) / (this.pMax - this.pMin) * LAYOUT.mainH;
    }

    /* ---------- 可视数据 ---------- */
    visible() {
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      return this.data.slice(s, e);
    }

    computeRange() {
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      let lo = Infinity, hi = -Infinity;
      for (let i = s; i < e; i++) {
        if (this.data[i].l < lo) lo = this.data[i].l;
        if (this.data[i].h > hi) hi = this.data[i].h;
      }
      // 纳入叠加层价位，但限制在合理区间（防止远端价位压扁图形）
      const levels = [];
      const scan = (v) => { if (typeof v === 'number' && isFinite(v)) levels.push(v); };
      for (const c of this.overlay) {
        if (c.type === 'hline') scan(c.p);
        if (c.type === 'rect' && !c.noRange) { scan(c.p1); scan(c.p2); }
        if (c.type === 'marker' || c.type === 'label') scan(c.p);
      }
      const rawLo = lo, rawHi = hi, span = rawHi - rawLo || rawHi * 0.1;
      for (const p of levels) {
        if (p > rawLo - span * 0.35 && p < rawHi + span * 0.35) {
          lo = Math.min(lo, p); hi = Math.max(hi, p);
        }
      }
      const pad = (hi - lo) * 0.07 || 0.2;
      this.pMin = lo - pad;
      this.pMax = hi + pad;
    }

    /* ---------- 主渲染 ---------- */
    render() {
      if (!this.data.length) return;
      // 通知装配层重算叠加层（内部用 _inRender 防重入，回调里只改数据不再嵌套渲染）
      if (this.onViewChange && !this._inRender) {
        this._inRender = true;
        try { this.onViewChange(); } catch (e) { console.error('onViewChange', e); }
        this._inRender = false;
      }
      const dpr = this.dpr;
      const W = this.W, H = this.H;
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(H * dpr);
      this.cv.style.height = H + 'px';
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      this.computeRange();

      this._grid();
      this._main();
      this._overlay();
      this._sub();
      this._vol();
      this._axisX();
      this._legend();
      if (this.hover >= 0) this._cross();
    }

    _grid() {
      const ctx = this.ctx, W = this.W;
      ctx.save();
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.font = '10px ui-monospace,SFMono-Regular,monospace';
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const ticks = 5;
      for (let i = 0; i <= ticks; i++) {
        const y = this.mainTop + (LAYOUT.mainH / ticks) * i;
        const p = this.pMax - (this.pMax - this.pMin) * (i / ticks);
        ctx.beginPath();
        ctx.moveTo(LAYOUT.left, y + .5);
        ctx.lineTo(W - LAYOUT.right, y + .5);
        ctx.stroke();
        ctx.fillText(p.toFixed(2), W - LAYOUT.right + 8, y);
      }
      // 副图与量图顶线
      ctx.strokeStyle = '#1B2432';
      [this.subTop, this.volTop, this.volBot].forEach(y => {
        ctx.beginPath(); ctx.moveTo(LAYOUT.left, y + .5); ctx.lineTo(W - LAYOUT.right, y + .5); ctx.stroke();
      });
      ctx.restore();
    }

    _main() {
      const ctx = this.ctx;
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      const bw = this.bw();
      const cw = Math.max(1.2, Math.min(bw * 0.68, 13));

      ctx.save();
      ctx.beginPath();
      ctx.rect(LAYOUT.left, this.mainTop, this.plotW, LAYOUT.mainH);
      ctx.clip();

      for (let i = s; i < e; i++) {
        const d = this.data[i];
        const x = this.x(i);
        const up = d.c >= d.o;
        const col = up ? C.up : C.dn;
        const yO = this.yP(d.o), yC = this.yP(d.c);
        const yH = this.yP(d.h), yL = this.yP(d.l);

        // 影线
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, Math.min(bw * 0.1, 1.4));
        ctx.beginPath();
        ctx.moveTo(x, yH);
        ctx.lineTo(x, yL);
        ctx.stroke();

        // 实体
        const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
        if (up) {
          ctx.fillStyle = C.upFill;
          ctx.fillRect(x - cw / 2, top, cw, hgt);
          ctx.strokeStyle = C.up;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - cw / 2 + .5, top + .5, cw - 1, Math.max(0, hgt - 1));
        } else {
          ctx.fillStyle = C.dnFill;
          ctx.fillRect(x - cw / 2, top, cw, hgt);
        }
      }
      ctx.restore();
    }

    /* ---------- 叠加指令 ---------- */
    _overlay() {
      const ctx = this.ctx;
      const cmd = this.overlay || [];
      ctx.save();
      ctx.beginPath();
      ctx.rect(LAYOUT.left, this.mainTop - 4, this.plotW, LAYOUT.mainH + 8);
      ctx.clip();

      for (const c of cmd) {
        ctx.globalAlpha = c.alpha == null ? 1 : c.alpha;
        switch (c.type) {
          case 'hline': {
            const y = this.yP(c.p);
            if (y < this.mainTop - 10 || y > this.mainBot + 10) break;
            ctx.strokeStyle = c.color || '#888';
            ctx.lineWidth = c.width || 1;
            ctx.setLineDash(c.dash || []);
            ctx.beginPath();
            ctx.moveTo(LAYOUT.left, y);
            ctx.lineTo(this.W - LAYOUT.right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            if (c.label) {
              ctx.font = '10.5px -apple-system,"PingFang SC",sans-serif';
              ctx.textBaseline = 'bottom';
              if (c.side === 'right') {
                ctx.textAlign = 'right';
                ctx.strokeStyle = 'rgba(6,9,14,.92)';
                ctx.lineWidth = 3;
                ctx.strokeText(c.label, this.W - LAYOUT.right - 4, y - 3);
                ctx.fillStyle = c.color || '#888';
                ctx.fillText(c.label, this.W - LAYOUT.right - 4, y - 3);
              } else {
                ctx.textAlign = 'left';
                ctx.strokeStyle = 'rgba(6,9,14,.92)';
                ctx.lineWidth = 3;
                ctx.strokeText(c.label, LAYOUT.left + 6, y - 3);
                ctx.fillStyle = c.color || '#888';
                ctx.fillText(c.label, LAYOUT.left + 6, y - 3);
              }
            }
            break;
          }
          case 'vline': {
            const x = this.x(c.i);
            ctx.strokeStyle = c.color || '#888';
            ctx.lineWidth = c.width || 1;
            ctx.setLineDash(c.dash || []);
            ctx.beginPath();
            ctx.moveTo(x, this.mainTop);
            ctx.lineTo(x, this.volBot);
            ctx.stroke();
            ctx.setLineDash([]);
            if (c.label) {
              ctx.save();
              ctx.translate(x, this.mainTop + 4);
              ctx.font = '10px -apple-system,sans-serif';
              ctx.fillStyle = c.color || '#888';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(c.label, 4, 2);
              ctx.restore();
            }
            break;
          }
          case 'line': {
            const pts = c.pts || [];
            if (pts.length < 2) break;
            ctx.strokeStyle = c.color || '#4C8DFF';
            ctx.lineWidth = c.width || 1.4;
            ctx.setLineDash(c.dash || []);
            ctx.beginPath();
            pts.forEach((pt, k) => {
              const x = this.x(pt[0]), y = this.yP(pt[1]);
              k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.stroke();
            ctx.setLineDash([]);
            break;
          }
          case 'trend': {
            // 射线：从 (i1,p1) 经 (i2,p2) 延伸到右边界
            const [i1, p1] = c.a, [i2, p2] = c.b;
            const slope = (p2 - p1) / (i2 - i1);
            const iEnd = this.viewStart + this.viewCount + 4;
            const pEnd = p2 + slope * (iEnd - i2);
            ctx.strokeStyle = c.color || '#888';
            ctx.lineWidth = c.width || 1.2;
            ctx.setLineDash(c.dash || []);
            ctx.beginPath();
            ctx.moveTo(this.x(i1), this.yP(p1));
            ctx.lineTo(this.x(iEnd), this.yP(pEnd));
            ctx.stroke();
            ctx.setLineDash([]);
            break;
          }
          case 'rect': {
            const x1 = this.x(c.x1), x2 = this.x(c.x2);
            const y1 = this.yP(c.p2), y2 = this.yP(c.p1);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y1);
            ctx.lineTo(x2, y2);
            ctx.lineTo(x1, y2);
            ctx.closePath();
            if (c.fill) { ctx.fillStyle = c.fill; ctx.fill(); }
            if (c.stroke) {
              ctx.strokeStyle = c.stroke;
              ctx.lineWidth = c.width || 1;
              ctx.setLineDash(c.dash || []);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            if (c.label) {
              ctx.font = '10px -apple-system,"PingFang SC",sans-serif';
              ctx.fillStyle = c.color || c.stroke || '#888';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(c.label, x1 + 5, y1 + 4);
            }
            break;
          }
          case 'area': {
            const pts = c.pts || [];
            if (pts.length < 3) break;
            ctx.fillStyle = c.fill || 'rgba(76,141,255,.10)';
            ctx.beginPath();
            pts.forEach((pt, k) => {
              const x = this.x(pt[0]), y = this.yP(pt[1]);
              k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.fill();
            break;
          }
          case 'marker': {
            const x = this.x(c.i), y = this.yP(c.p);
            ctx.fillStyle = c.color || '#E8B84B';
            ctx.beginPath();
            ctx.arc(x, y, c.r || 3.2, 0, Math.PI * 2);
            ctx.fill();
            if (c.text) {
              ctx.font = c.bold ? 'bold 10.5px -apple-system,"PingFang SC",sans-serif' : '10.5px -apple-system,"PingFang SC",sans-serif';
              ctx.textAlign = c.align || 'center';
              ctx.textBaseline = c.pos === 'above' ? 'bottom' : 'top';
              const dy = c.pos === 'above' ? -8 : 8;
              // 描边提升可读性
              ctx.strokeStyle = 'rgba(6,9,14,.92)';
              ctx.lineWidth = 3;
              ctx.strokeText(c.text, x, y + dy);
              ctx.fillStyle = c.color || '#E8B84B';
              ctx.fillText(c.text, x, y + dy);
            }
            break;
          }
          case 'label': {
            const x = this.x(c.i), y = this.yP(c.p);
            ctx.font = (c.bold ? 'bold ' : '') + (c.size || 10.5) + 'px -apple-system,"PingFang SC",sans-serif';
            ctx.textAlign = c.align || 'center';
            ctx.textBaseline = 'middle';
            ctx.strokeStyle = 'rgba(6,9,14,.9)';
            ctx.lineWidth = 3.2;
            ctx.strokeText(c.text, x, y + (c.dy || 0));
            ctx.fillStyle = c.color || '#C6D0DE';
            ctx.fillText(c.text, x, y + (c.dy || 0));
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    /* ---------- 副图 ---------- */
    _sub() {
      const sub = this.sub;
      if (!sub || sub.type === 'none') return;
      const ctx = this.ctx;
      const top = this.subTop, h = LAYOUT.subH, bot = this.subBot;
      const series = sub.series || [];

      // 计算范围：只在没显式指定的一侧按数据推算（以前任一为 null 就两边重算，
      // 结果 ampstr 的 min:0 被丢掉）。参考线也纳入范围，否则「10 是上限」这种
      // 刚好贴在数据上沿的刻度会被挤出画布，线画不出来、刻度也被跳过。
      let lo = sub.min, hi = sub.max;
      if (lo == null || hi == null) {
        let dlo = Infinity, dhi = -Infinity;
        for (const s of series) {
          for (let i = this.viewStart; i < Math.min(this.data.length, this.viewStart + this.viewCount); i++) {
            const v = s.data[i];
            if (v == null) continue;
            if (v < dlo) dlo = v;
            if (v > dhi) dhi = v;
          }
        }
        for (const r of (sub.refs || [])) {
          if (r.v < dlo) dlo = r.v;
          if (r.v > dhi) dhi = r.v;
        }
        if (!isFinite(dlo)) { dlo = -1; dhi = 1; }
        const pad = (dhi - dlo) * 0.12 || 1;
        if (lo == null) lo = dlo - pad;
        if (hi == null) hi = dhi + pad;
        if (hi <= lo) hi = lo + 1;
      }
      const Y = (v) => bot - (v - lo) / (hi - lo) * h;

      ctx.save();
      ctx.beginPath();
      ctx.rect(LAYOUT.left, top, this.plotW, h);
      ctx.clip();

      // 参考线
      for (const r of (sub.refs || [])) {
        const y = Y(r.v);
        if (y < top || y > bot) continue;
        ctx.strokeStyle = r.color || '#2A3547';
        ctx.lineWidth = 1;
        ctx.setLineDash(r.dash || [3, 3]);
        ctx.beginPath(); ctx.moveTo(LAYOUT.left, y); ctx.lineTo(this.W - LAYOUT.right, y); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 柱状（MACD）
      if (sub.bars) {
        const bwv = Math.max(1, Math.min(this.bw() * 0.6, 10));
        const zero = Y(0);
        for (let i = this.viewStart; i < Math.min(this.data.length, this.viewStart + this.viewCount); i++) {
          const v = sub.bars[i];
          if (v == null) continue;
          const x = this.x(i), y = Y(v);
          const bc = sub.barColors && sub.barColors[i];
          ctx.fillStyle = bc || (v >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(46,189,133,.75)');
          ctx.fillRect(x - bwv / 2, Math.min(y, zero), bwv, Math.max(1, Math.abs(y - zero)));
        }
      }

      // 线
      for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 1.3;
        ctx.beginPath();
        let started = false;
        for (let i = this.viewStart; i < Math.min(this.data.length, this.viewStart + this.viewCount); i++) {
          const v = s.data[i];
          if (v == null) { started = false; continue; }
          const x = this.x(i), y = Y(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // 参考线刻度：画在右侧轴区，必须放在 clip 之外，否则会被裁掉
      let lastRefY = -999;
      for (const r of (sub.refs || [])) {
        const y = Y(r.v);
        if (y < top + 6 || y > bot - 6) continue;
        if (Math.abs(y - lastRefY) < 11) continue;   // 太近就跳过，避免刻度叠字
        lastRefY = y;
        const txt = r.label != null ? String(r.label) : String(r.v);
        ctx.font = '9.5px ui-monospace,monospace';
        ctx.fillStyle = r.color || C.axis;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, this.W - LAYOUT.right + 8, y);
      }

      // 副图标题与图例
      if (sub.title) {
        ctx.font = '10px -apple-system,"PingFang SC",sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let lx = LAYOUT.left + 2;
        ctx.fillStyle = '#6B7787';
        ctx.fillText(sub.title, lx, top + 3);
        lx += ctx.measureText(sub.title).width + 12;
        for (const s2 of series) {
          if (!s2.label) continue;
          const v = s2.data[Math.min(this.data.length - 1, this.viewStart + this.viewCount - 1)];
          const dg = sub.digits == null ? 2 : sub.digits;
          const txt = s2.label + ' ' + (v == null ? '—' : v.toFixed(dg));
          ctx.fillStyle = s2.color;
          ctx.fillText(txt, lx, top + 3);
          lx += ctx.measureText(txt).width + 11;
        }
      }
    }

    /* ---------- 成交量 ---------- */
    _vol() {
      const ctx = this.ctx;
      const top = this.volTop, bot = this.volBot;
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      let vmax = 0;
      for (let i = s; i < e; i++) if (this.data[i].v > vmax) vmax = this.data[i].v;
      if (!vmax) return;
      const bwv = Math.max(1, Math.min(this.bw() * 0.62, 11));

      ctx.save();
      ctx.beginPath();
      ctx.rect(LAYOUT.left, top, this.plotW, LAYOUT.volH);
      ctx.clip();
      for (let i = s; i < e; i++) {
        const d = this.data[i];
        const x = this.x(i);
        const h = (d.v / vmax) * LAYOUT.volH * 0.94;
        const up = i > 0 ? d.c >= this.data[i - 1].c : d.c >= d.o;
        ctx.fillStyle = up ? 'rgba(246,70,93,.62)' : 'rgba(46,189,133,.62)';
        ctx.fillRect(x - bwv / 2, bot - h, bwv, h);
      }
      // 量均线
      const mv = this.ind.volMa5;
      if (mv) {
        ctx.strokeStyle = 'rgba(232,184,75,.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let st = false;
        for (let i = s; i < e; i++) {
          if (mv[i] == null) continue;
          const x = this.x(i), y = bot - (mv[i] / vmax) * LAYOUT.volH * 0.94;
          if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      ctx.font = '9.5px ui-monospace,monospace';
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(this._fmtVol(vmax), this.W - LAYOUT.right + 8, top + 8);
    }

    _fmtVol(v) {
      if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if (v >= 1e4) return (v / 1e4).toFixed(0) + '万';
      return v.toFixed(0);
    }

    _axisX() {
      const ctx = this.ctx;
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      const target = Math.max(4, Math.floor(this.plotW / 108));
      ctx.font = '10px ui-monospace,monospace';
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const t0 = Date.parse(this.data[s].d), t1 = Date.parse(this.data[e - 1].d);
      const span = t1 - t0;
      if (span <= 0) return;
      // 视野跨年后只写 MM-DD 会重复（01-02 出现好几次），此时补上年份
      const multiYear = span > 420 * 864e5;
      const fmt = (d) => (multiYear ? d.slice(2, 7) : d.slice(5));
      for (let k = 0; k < target; k++) {
        const t = t0 + span * (k + 0.5) / target;
        let bi = s, best = Infinity;
        for (let i = s; i < e; i++) {
          const dd = Math.abs(Date.parse(this.data[i].d) - t);
          if (dd < best) { best = dd; bi = i; }
        }
        ctx.fillText(fmt(this.data[bi].d), this.x(bi), this.volBot + 8);
      }
    }

    _legend() {
      const ctx = this.ctx;
      const s = this.viewStart, e = Math.min(this.data.length, s + this.viewCount);
      const idx = this.hover >= s && this.hover < e ? this.hover : e - 1;
      const d = this.data[idx];
      if (!d) return;
      const prev = idx > 0 ? this.data[idx - 1].c : d.o;
      const chg = ((d.c - prev) / prev) * 100;
      const col = d.c >= prev ? C.up : C.dn;

      ctx.font = '10.5px -apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const parts = [
        ['', d.d, C.text],
        ['开 ', d.o.toFixed(2), d.o >= prev ? C.up : C.dn],
        ['高 ', d.h.toFixed(2), C.up],
        ['低 ', d.l.toFixed(2), C.dn],
        ['收 ', d.c.toFixed(2), col],
        ['', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', col],
        ['量 ', this._fmtVol(d.v), '#8C98AB'],
      ];
      let x = LAYOUT.left + 2;
      for (const [pre, txt, c2] of parts) {
        ctx.fillStyle = c2;
        const full = pre + txt;
        ctx.fillText(full, x, 2);
        x += ctx.measureText(full).width + 11;
      }
    }

    /* ---------- 十字光标 ---------- */
    _cross() {
      const ctx = this.ctx;
      const i = this.hover;
      if (i < 0 || i >= this.data.length) return;
      const x = this.x(i);
      const y = this.hoverY;

      ctx.save();
      ctx.strokeStyle = C.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, this.mainTop);
      ctx.lineTo(x, this.volBot);
      ctx.stroke();
      if (y != null && y > this.mainTop && y < this.mainBot) {
        ctx.beginPath();
        ctx.moveTo(LAYOUT.left, y);
        ctx.lineTo(this.W - LAYOUT.right, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // X 轴日期浮标
      const label = this.data[i].d;
      ctx.font = '10px ui-monospace,monospace';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = '#1B2534';
      ctx.fillRect(x - tw / 2, this.volBot + 3, tw, 16);
      ctx.fillStyle = '#C6D0DE';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, this.volBot + 11);
      ctx.restore();

      // tooltip
      if (this.tip) {
        const d = this.data[i];
        const prev = i > 0 ? this.data[i - 1].c : d.o;
        const chg = ((d.c - prev) / prev) * 100;
        const col = d.c >= prev ? '#F6465D' : '#2EBD85';
        this.tip.innerHTML =
          `<div class="dt">${d.d}</div>` +
          `<div class="row"><span>开盘</span><span>${d.o.toFixed(2)}</span></div>` +
          `<div class="row"><span>最高</span><span style="color:#FF7A8A">${d.h.toFixed(2)}</span></div>` +
          `<div class="row"><span>最低</span><span style="color:#3ED49A">${d.l.toFixed(2)}</span></div>` +
          `<div class="row"><span>收盘</span><span style="color:${col}">${d.c.toFixed(2)}</span></div>` +
          `<div class="row"><span>涨跌</span><span style="color:${col}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span></div>` +
          `<div class="row"><span>成交量</span><span>${this._fmtVol(d.v)}</span></div>`;
        this.tip.style.opacity = 1;
        const wrap = this.cv.parentElement;
        const bw = wrap.clientWidth;
        const px = x + 18 + 160 > bw ? x - 172 : x + 18;
        this.tip.style.left = px + 'px';
        this.tip.style.top = Math.max(4, Math.min(y || 100, this.mainBot - 130)) + 'px';
      }
    }

    /* ---------- 交互 ---------- */
    _bind() {
      const cv = this.cv;

      cv.addEventListener('mousemove', (e) => {
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        if (this.drag) {
          const dx = mx - this.drag.x;
          const shift = Math.round(-dx / this.bw());
          const ns = Math.max(0, Math.min(this.data.length - this.viewCount, this.drag.start + shift));
          if (ns !== this.viewStart) { this.viewStart = ns; this.render(); }
          return;
        }
        const idx = this._idxAt(mx);
        this.hover = idx;
        this.hoverY = my;
        this.render();
      });

      cv.addEventListener('mouseleave', () => {
        this.hover = -1; this.hoverY = null;
        if (this.tip) this.tip.style.opacity = 0;
        this.render();
      });

      cv.addEventListener('mousedown', (e) => {
        this.drag = { x: e.clientX - cv.getBoundingClientRect().left, start: this.viewStart };
        cv.style.cursor = 'grabbing';
      });
      window.addEventListener('mouseup', () => {
        this.drag = null;
        cv.style.cursor = 'crosshair';
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const anchor = this.viewStart + (mx - LAYOUT.left) / this.bw();
        const delta = e.deltaY > 0 ? 1.12 : 0.89;
        const nc = Math.round(Math.max(30, Math.min(this.data.length, this.viewCount * delta)));
        const ratio = (mx - LAYOUT.left) / this.plotW;
        this.viewCount = nc;
        this.viewStart = Math.max(0, Math.min(this.data.length - nc, Math.round(anchor - nc * ratio)));
        this.render();
      }, { passive: false });

      this._bindTouch();
    }

    /* ---------- 触屏：单指平移 / 双指缩放 / 点按查看 ---------- */
    _bindTouch() {
      const cv = this.cv;
      if (!('ontouchstart' in window)) return;

      let mode = null;        // 'pan' | 'pinch'
      let start = null;
      let pinch = null;
      let hoverTimer = null;

      const clearHover = () => {
        this.hover = -1;
        this.hoverY = null;
        if (this.tip) this.tip.style.opacity = 0;
        this.render();
      };

      cv.addEventListener('touchstart', (e) => {
        clearTimeout(hoverTimer);
        if (e.touches.length === 2) {
          const [a, b] = e.touches;
          pinch = {
            dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
            count: this.viewCount,
            midX: (a.clientX + b.clientX) / 2 - cv.getBoundingClientRect().left,
          };
          mode = 'pinch';
          return;
        }
        const t = e.touches[0];
        start = {
          x: t.clientX, y: t.clientY,
          viewStart: this.viewStart,
          at: Date.now(), moved: false,
        };
        mode = null;   // 先不定性，等首次移动再决定是平移还是翻页
      }, { passive: true });

      cv.addEventListener('touchmove', (e) => {
        if (!start && !pinch) return;

        if (pinch && e.touches.length === 2) {
          const [a, b] = e.touches;
          const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (pinch.dist > 10) {
            const ratio = Math.max(0.2, Math.min(5, pinch.dist / dist));
            const nc = Math.round(Math.max(30, Math.min(this.data.length, pinch.count * ratio)));
            const anchor = this.viewStart + (pinch.midX - LAYOUT.left) / this.bw();
            const pos = (pinch.midX - LAYOUT.left) / this.plotW;
            this.viewCount = nc;
            this.viewStart = Math.max(0, Math.min(this.data.length - nc,
              Math.round(anchor - nc * pos)));
            this.render();
          }
          e.preventDefault();
          return;
        }

        if (!start) return;
        const t = e.touches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!start.moved) {
          if (Math.abs(dx) < 6) return;              // 还看不出方向，交给浏览器判定
          if (Math.abs(dx) <= Math.abs(dy)) { start = null; return; }  // 竖向：让页面滚动
          start.moved = true;
          mode = 'pan';
        }
        if (mode === 'pan') {
          const shift = Math.round(-dx / this.bw());
          const ns = Math.max(0, Math.min(this.data.length - this.viewCount,
            start.viewStart + shift));
          if (ns !== this.viewStart) { this.viewStart = ns; this.render(); }
          e.preventDefault();
        }
      }, { passive: false });

      cv.addEventListener('touchend', (e) => {
        if (mode === 'pan' || mode === 'pinch') {
          if (e.touches.length === 0) { start = null; pinch = null; mode = null; }
          return;
        }
        // 点按：定位到对应交易日并显示明细，2.6s 后自动收起
        if (start && !start.moved && Date.now() - start.at < 500 && e.changedTouches.length) {
          const t = e.changedTouches[0];
          const r = cv.getBoundingClientRect();
          const my = t.clientY - r.top;
          if (my > LAYOUT.top && my < this.mainBot) {
            this.hover = this._idxAt(t.clientX - r.left);
            this.hoverY = my;
            this.render();
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(clearHover, 2600);
          }
        }
        if (e.touches.length === 0) { start = null; pinch = null; mode = null; }
      }, { passive: true });

      cv.addEventListener('touchcancel', () => {
        start = null; pinch = null; mode = null;
      }, { passive: true });
    }

    _idxAt(mx) {
      const i = Math.floor((mx - LAYOUT.left) / this.bw()) + this.viewStart;
      return Math.max(0, Math.min(this.data.length - 1, i));
    }
  }

  global.QLChart = Chart;
})(window);
