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

  // 版式：桌面维持原来的 646px 高度；手机竖屏把主图压到 252px，
  // 否则一张图占满一屏，解读卡被挤到第三屏，而且 390px 宽塞 90 根蜡烛一根只有 3.5px。
  const LAYOUT = { t: 14, mainH: 368, gap1: 20, subH: 132, gap2: 12, volH: 74, xAxis: 26, right: 64, left: 10 };
  function fitLayout() {
    // 横屏（844×390）宽度过了 760，但可用高度只有 390，再用 646px 的桌面版式
    // 就得把图切成两屏看，所以高度也参与判断
    const narrow = window.innerWidth < 760 || window.innerHeight < 540;
    LAYOUT.mainH = narrow ? 252 : 368;
    LAYOUT.subH = narrow ? 96 : 132;
    LAYOUT.volH = narrow ? 52 : 74;
    LAYOUT.gap1 = narrow ? 14 : 20;
    LAYOUT.gap2 = narrow ? 8 : 12;
    LAYOUT.right = narrow ? 50 : 64;
    LAYOUT.xAxis = narrow ? 22 : 26;
    LAYOUT.t = narrow ? 31 : 14;      // 手机：图例排两行，给顶部让出 17px
  }

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
      // 浮点视口起点：拖动/缩放时用它绘制，柱子按像素平滑移动。
      // viewStart 仍是整数，供 overlay 指令与 app.js 按「第几根」换算。
      // 以前只有整数 viewStart + Math.round(-dx/bw)，一次至少跳一格，
      // 缩放到 200 根以上时一格只有 2~3px，手感就是「一格一格地蹦」。
      this.pos = 0;
      this.hover = -1;
      this.hoverY = null;
      this.drag = null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 视口一变（缩放 / 拖动 / 换根数）就要重算叠加层，否则信号会停留在旧视野，
      // 表现为「把根数拉到全部后，所有标签仍挤在右侧」。由装配层挂回调，这里只负责通知。
      this.onViewChange = null;
      this._inRender = false;
      this._sizeKey = '';       // canvas 位图尺寸缓存：不变就不重设
      this._lyW = 0; this._lyH = 0;
      this._rafId = 0;
      this._animId = 0;
      this._suspendOverlay = false;   // 手势进行中挂起 overlay 重算
      this._userBars = 0;             // 用户手动缩放后的根数，切标时沿用
      this._pinned = false;           // 十字线是否「钉住」（触屏抬手后保留）
      this._touching = false;
      this._bind();
    }

    setData(data, ind) {
      this.data = data;
      this.ind = ind;
      // 切标的时沿用用户上次手动缩放的根数（通达信这类软件换股不重置缩放），
      // 没有手动缩放过才用自适应默认值。
      const want = this._userBars || (window.innerWidth < 760 ? 60 : 140);
      this.viewCount = Math.max(1, Math.min(want, data.length));
      this.pos = Math.max(0, data.length - this.viewCount);
      this.viewStart = Math.floor(this.pos);
      // 换标的后旧的 hover 索引指向的是别一只票的日期，必须清掉，
      // 否则会拿旧索引画十字线（表现为「刚切过去就有一条线钉在某个位置」）。
      this.hover = -1;
      this.hoverY = null;
      this._pinned = false;
      this.drag = null;
      this._cancelAnim();
      if (this.tip) this.tip.style.opacity = 0;
    }

    setOverlay(cmds) { this.overlay = cmds || []; }
    setSub(sub) { this.sub = sub || { type: 'none', series: [], refs: [] }; }
    /* 设定根数并回到最新（按钮 / 换周期用）。同步渲染：调用方紧接着会读尺寸。 */
    setRange(n) {
      this.viewCount = Math.max(1, Math.min(n, this.data.length));
      this.pos = Math.max(0, this.data.length - this.viewCount);
      this.viewStart = Math.floor(this.pos);
      this._userBars = this.viewCount;
      this._cancelAnim();
      this.render();
    }
    /* 只重绘，不动视野（resize 用） */
    redraw() { this._sizeKey = ''; this.invalidate(); }

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
      return LAYOUT.left + (i - this.pos + 0.5) * bw;
    }
    bw() { return this.plotW / this.viewCount; }
    yP(p) {
      return this.mainTop + (this.pMax - p) / (this.pMax - this.pMin) * LAYOUT.mainH;
    }

    /* ---------- 可视数据 ---------- */
    /* 绘制区间：pos 是浮点的，左右各多画一根，避免拖动时边缘露出空档。
     * 手感上这一点很关键 —— 少画一根的表现为「拖动时最右边闪一下空白」。 */
    _span() {
      const n = this.data.length;
      if (!n) return { s: 0, e: 0 };
      const s = Math.max(0, Math.min(n - 1, Math.floor(this.pos)));
      const e = Math.max(s + 1, Math.min(n, Math.ceil(this.pos + this.viewCount) + 1));
      return { s, e };
    }

    visible() {
      const { s, e } = this._span();
      return this.data.slice(s, e);
    }

    /* ---------- 重绘调度 ----------
     * 手势里每帧最多画一次：pointermove 在 120Hz 屏上可能一帧来两次，
     * 同步 render 会把同一帧画两遍，等于凭空掉一半帧率。
     */
    invalidate() {
      if (this._rafId) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        this.render();
      });
    }

    /* overlay 重算：手势结束后调一次，别放在 render 里每帧跑 */
    _notifyView() {
      if (!this.onViewChange) return;
      if (this._inRender) return;
      this._inRender = true;
      try { this.onViewChange(); } catch (e) { console.error('onViewChange', e); }
      this._inRender = false;
    }

    computeRange() {
      const { s, e } = this._span();
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
      // 只在视口尺寸变化时重算版式：以前每帧调 fitLayout() 会读 innerWidth，
      // 与 canvas 尺寸赋值交替进行，等于每帧强制一次同步布局（layout thrashing）。
      if (window.innerWidth !== this._lyW || window.innerHeight !== this._lyH) {
        this._lyW = window.innerWidth;
        this._lyH = window.innerHeight;
        fitLayout();
      }
      // 手势进行中不重算叠加层：41 个流派的 overlay 要遍历可见区间的全部数据，
      // 拖动时每帧算一遍直接掉到个位数帧率 —— 这就是「抽搐」最直接的来源。
      // 拖动本身不改变信号密度，手势结束重算一次就够。
      if (!this._suspendOverlay) this._notifyView();

      const dpr = this.dpr;
      const W = this.W, H = this.H;
      // 给 canvas.width 赋值会重新分配位图并清空上下文，是这一层最贵的操作。
      // 尺寸没变就只 clearRect。
      const key = W + 'x' + H + '@' + dpr;
      if (key !== this._sizeKey) {
        this._sizeKey = key;
        this.cv.width = Math.round(W * dpr);
        this.cv.height = Math.round(H * dpr);
        this.cv.style.height = H + 'px';
      }
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
      const { s, e } = this._span();
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
      const { s, e } = this._span();
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
      const { s, e } = this._span();
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
      const { s, e } = this._span();
      const idx = this.hover >= s && this.hover < e ? this.hover : e - 1;
      const d = this.data[idx];
      if (!d) return;
      const prev = idx > 0 ? this.data[idx - 1].c : d.o;
      const chg = ((d.c - prev) / prev) * 100;
      const col = d.c >= prev ? C.up : C.dn;

      ctx.font = '10.5px -apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      const draw = (parts, y) => {
        let x = LAYOUT.left + 2;
        for (const [pre, txt, c2] of parts) {
          ctx.fillStyle = c2;
          const full = pre + txt;
          ctx.fillText(full, x, y);
          x += ctx.measureText(full).width + 10;
        }
      };

      // 手机上一行放不下七段（390px 只够约 300px 文字），右侧会被画布裁掉，
      // 所以拆两行：第一行看日期与当日涨跌，第二行看四个价位与量。
      if (window.innerWidth < 760) {
        draw([['', d.d.slice(5), C.text],
          ['收 ', d.c.toFixed(2), col],
          ['', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', col]], 2);
        draw([['开 ', d.o.toFixed(2), d.o >= prev ? C.up : C.dn],
          ['高 ', d.h.toFixed(2), C.up],
          ['低 ', d.l.toFixed(2), C.dn],
          ['量 ', this._fmtVol(d.v), '#8C98AB']], 16);
        return;
      }

      draw([
        ['', d.d, C.text],
        ['开 ', d.o.toFixed(2), d.o >= prev ? C.up : C.dn],
        ['高 ', d.h.toFixed(2), C.up],
        ['低 ', d.l.toFixed(2), C.dn],
        ['收 ', d.c.toFixed(2), col],
        ['', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', col],
        ['量 ', this._fmtVol(d.v), '#8C98AB'],
      ], 2);
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

      // Y 轴价格浮标：横线指到哪个价位，右轴就报哪个价。
      // 只有日期浮标的时候，对齐线只能读「哪一天」，读不了「什么价」——
      // 看盘软件里这根线的用处有一半在价格上。
      if (y != null && y > this.mainTop && y < this.mainBot) {
        const p = this.pMax - ((y - this.mainTop) / LAYOUT.mainH) * (this.pMax - this.pMin);
        const hgt = 15;
        const ty = Math.max(this.mainTop, Math.min(this.mainBot - hgt, y - hgt / 2));
        const wRight = LAYOUT.right - 4;
        ctx.fillStyle = '#2A3648';
        ctx.fillRect(this.W - LAYOUT.right + 1, ty, wRight, hgt);
        ctx.fillStyle = '#E6EDF6';
        ctx.font = '10px ui-monospace,monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.toFixed(2), this.W - LAYOUT.right + 4, ty + hgt / 2 + 0.5);
      }
      ctx.restore();

      // tooltip
      if (this.tip) {
        // 触屏不弹浮层：手指本来就在图中间，160×180 的浮层会盖掉半张图。
        // 主图上沿的图例已经实时显示 收/开/高/低/量，加上 X 轴日期与右轴价格两个浮标，
        // 信息一个不缺 —— 这也正是通达信手机版的做法。
        if (this._touching) { this.tip.style.opacity = 0; return; }
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
        if (this._touching) {
          // 手指必然压在 tooltip 上：挪到反侧、压在主图上沿，别让手挡着读数
          this.tip.style.left = (x > bw / 2 ? 8 : Math.max(8, bw - 168)) + 'px';
          this.tip.style.top = (this.mainTop + 4) + 'px';
        } else {
          const px = x + 18 + 160 > bw ? x - 172 : x + 18;
          this.tip.style.left = px + 'px';
          this.tip.style.top = Math.max(4, Math.min(y || 100, this.mainBot - 130)) + 'px';
        }
      }
    }

    /* ---------- 交互 ---------- */
    /* 鼠标 / 触控笔：Pointer Events + capture。
     * 以前用 mousemove + window.mouseup：按住拖出画布再回来会掉帧（没有 capture，
     * 中间的移动事件收不到），松手在画布外也收不到 mouseup，drag 状态残留。 */
    _bind() {
      const cv = this.cv;

      cv.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') return;      // 触屏走 touch 分支
        if (e.button !== 0) return;
        try { cv.setPointerCapture(e.pointerId); } catch (err) { this._noCapture = true; console.debug('chart.capture_unsupported', err.message); }
        this._cancelAnim();
        this.drag = { x: e.clientX, start: this.pos };
        this._suspendOverlay = true;               // 拖动中不重算 overlay
        cv.style.cursor = 'grabbing';
        e.preventDefault();                        // 别让拖动选中页面文字
      });

      cv.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        if (this.drag) {
          this._panTo(this.drag.start, e.clientX - this.drag.x, true);
          return;
        }
        const r = cv.getBoundingClientRect();
        this._setHover(e.clientX - r.left, e.clientY - r.top);
      });

      const endDrag = (e) => {
        if (e && e.pointerType === 'touch') return;
        if (!this.drag) return;
        this.drag = null;
        cv.style.cursor = 'crosshair';
        this._endGesture();
      };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);
      /* 只有鼠标移出才收十字线。触摸抬起时浏览器同样会派发 pointerleave，
       * 若不加这一层，触屏「长按出线、抬手保留」会被立刻清掉（实测过）。 */
      cv.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'touch' || this.drag) return;
        this._clearHover();
      });

      /* 缩放：以指针位置为锚点，锚点下的那根 K 线在缩放前后保持不动。
       * 以前只按比例改 viewCount 再按鼠标位置重算起点，两个公式用的基准不同，
       * 连续滚轮时图形会「漂」——手感上像是图在手指下面滑。 */
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - r.left - LAYOUT.left) / this.plotW));
        const anchor = this.pos + ratio * this.viewCount;
        const delta = e.deltaY > 0 ? 1.12 : 0.89;
        const nc = Math.round(Math.max(30, Math.min(this.data.length, this.viewCount * delta)));
        if (nc === this.viewCount) return;
        this.viewCount = nc;
        this._userBars = nc;
        this._setPos(anchor - ratio * nc);
        this._notifyView();
      }, { passive: false });

      this._bindTouch();
    }

    /* ---------- 平移 / 缩放 / 惯性 ---------- */
    /* pos 允许越界（回弹用）：越界时 viewStart 仍夹在合法区间，
     * 只是绘制偏移多出来，视觉上露出一点空白，松手弹回去。 */
    _setPos(p, allowOver) {
      const hi = Math.max(0, this.data.length - this.viewCount);
      const q = allowOver ? p : Math.max(0, Math.min(hi, p));
      this.pos = q;
      this.viewStart = Math.max(0, Math.min(hi, Math.floor(q)));
      this.invalidate();
    }

    _panTo(startPos, dxPx, rubber) {
      const now = performance.now();
      if (this._lastPan) {
        const dt = now - this._lastPan.t;
        if (dt > 0 && dt < 120) this._vel = (dxPx - this._lastPan.dx) / dt;   // px/ms，右为正
      }
      this._lastPan = { dx: dxPx, t: now };

      const bw = this.bw();
      const hi = Math.max(0, this.data.length - this.viewCount);
      let p = startPos - dxPx / bw;
      if (rubber) {
        // 边界阻尼：拖到头继续拖只给 32% 的位移，松手回弹
        if (p < 0) p = p * 0.32;
        else if (p > hi) p = hi + (p - hi) * 0.32;
      }
      this._setPos(p, true);
    }

    _cancelAnim() {
      if (this._animId) { cancelAnimationFrame(this._animId); this._animId = 0; }
      this._vel = 0;
      this._lastPan = null;
    }

    /* 手势结束：恢复 overlay 重算 → 越界回弹或惯性滑行 */
    _endGesture() {
      this._suspendOverlay = false;
      this._notifyView();
      const hi = Math.max(0, this.data.length - this.viewCount);
      if (this.pos < -0.01 || this.pos > hi + 0.01) {
        this._springTo(Math.max(0, Math.min(hi, this.pos)));
      } else {
        this._inertia();
      }
    }

    /* 惯性：按松开瞬间的速度滑行，每 16ms 衰减 8%，到底自动停。
     * 幅度刻意做小（约 0.15~0.3 屏），只是让「甩一下」有回应，不是让图飘。 */
    _inertia() {
      const v0 = this._vel;
      this._vel = 0;
      this._lastPan = null;
      if (!v0 || Math.abs(v0) < 0.1) { this.invalidate(); return; }
      const bw = this.bw();
      let v = v0;
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(40, now - last);
        last = now;
        v *= Math.pow(0.92, dt / 16);
        const hi = Math.max(0, this.data.length - this.viewCount);
        let p = this.pos - (v * dt) / bw;
        if (p <= 0) { p = 0; v = 0; }
        if (p >= hi) { p = hi; v = 0; }
        this._setPos(p, true);
        if (Math.abs(v) > 0.02) {
          this._animId = requestAnimationFrame(step);
        } else {
          this._animId = 0;
          this._notifyView();
        }
      };
      this._animId = requestAnimationFrame(step);
    }

    _springTo(target) {
      const from = this.pos, t0 = performance.now(), dur = 190;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        this._setPos(from + (target - from) * e, true);
        if (k < 1) {
          this._animId = requestAnimationFrame(step);
        } else {
          this._animId = 0;
          this._notifyView();
        }
      };
      this._cancelAnim();
      this._animId = requestAnimationFrame(step);
    }

    /* ---------- 触屏：press → pan / pinch / cross ----------
     * 旧实现的两个硬伤，正好对应「拖动抽搐」：
     * 1) touchmove 前 6px 一律 return 且不 preventDefault，浏览器已经判成页面滚动，
     *    后续事件被 cancel，平移只走了几像素就断 —— 看起来就是「抽一下」。
     * 2) 每帧同步 render + 重设 canvas 尺寸 + 重算 41 流派 overlay，帧率掉到个位数。
     */
    _bindTouch() {
      const cv = this.cv;
      if (!('ontouchstart' in window)) return;

      let st = null;        // 单指状态
      let pinch = null;     // 双指状态
      let hold = 0;         // 长按定时器
      let lastTap = 0;
      // 上一次 tap 落下时「手里是否已有十字线」。
      // 必须在 _setHover 之前取：单次 tap 自己也会建线，等到第二次 tap 再查 this.hover
      // 永远是「有」，双击就再也退不回最新了。
      let tapHadCross = false;

      cv.addEventListener('touchstart', (e) => {
        this._touching = true;
        this._cancelAnim();
        if (e.touches.length === 2) {
          clearTimeout(hold);
          st = null;
          const [a, b] = e.touches;
          const r = cv.getBoundingClientRect();
          pinch = {
            d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
            c0: this.viewCount,
            mid: (a.clientX + b.clientX) / 2 - r.left,
            pos0: this.pos,
          };
          this._suspendOverlay = true;
          return;
        }
        const t = e.touches[0];
        st = { x0: t.clientX, y0: t.clientY, t0: Date.now(), pos0: this.pos, mode: 'press', moved: false };
        // 长按 220ms 进入光标模式：手指不动先出十字线，之后带着线走（通达信的手感）
        hold = setTimeout(() => {
          if (!st || st.moved || st.mode !== 'press') return;
          st.mode = 'cross';
          this._pinned = true;
          const r = cv.getBoundingClientRect();
          this._setHover(t.clientX - r.left, t.clientY - r.top);
          if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { console.debug('chart.vibrate_failed', err.message); } }
        }, 220);
      }, { passive: true });

      cv.addEventListener('touchmove', (e) => {
        if (pinch && e.touches.length === 2) {
          const [a, b] = e.touches;
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
          // 手指张开 → 距离变大 → 显示的根数变少（放大）；反之缩小
          const nc = Math.round(Math.max(20, Math.min(this.data.length, pinch.c0 * (pinch.d0 / d))));
          if (nc !== this.viewCount) {
            const ratio = Math.max(0, Math.min(1, (pinch.mid - LAYOUT.left) / this.plotW));
            const anchor = pinch.pos0 + ratio * pinch.c0;
            this.viewCount = nc;
            this._userBars = nc;
            this._setPos(anchor - ratio * nc);
          }
          e.preventDefault();
          return;
        }
        if (!st) return;

        const t = e.touches[0];
        const dx = t.clientX - st.x0, dy = t.clientY - st.y0;
        const adx = Math.abs(dx), ady = Math.abs(dy);

        if (st.mode === 'press') {
          if (adx < 4 && ady < 4) {
            // 位移还小，但方向已经明显偏横 —— 先拦住浏览器，否则它会把手势判成页面滚动
            if (adx > ady + 1) e.preventDefault();
            return;
          }
          clearTimeout(hold);
          st.moved = true;
          if (adx >= ady) {
            st.mode = 'pan';
            // 一旦开始拖，先把钉住的十字线收起来：否则它会跟着 K 线一起平移，
            // 看着像「线黏在图上甩不掉」。通达信/同花顺拖动时同样是线先消失。
            if (this.hover >= 0) this._clearHover();
            this._suspendOverlay = true;
          } else {
            st.mode = 'yield';       // 竖向：交还页面滚动
            st = null;
            return;
          }
        }

        if (st.mode === 'cross') {
          const r = cv.getBoundingClientRect();
          this._setHover(t.clientX - r.left, t.clientY - r.top);
          e.preventDefault();        // 光标模式下页面不跟着滚
          return;
        }

        if (st.mode === 'pan') {
          this._panTo(st.pos0, dx, true);
          e.preventDefault();
        }
      }, { passive: false });

      const finish = (e) => {
        clearTimeout(hold);
        if (e.touches.length > 0) return;          // 还有手指，等全部抬起

        if (pinch) {
          pinch = null;
          this._endGesture();
          st = null;
          this._touching = false;
          return;
        }
        const tap = !!st && !st.moved && Date.now() - st.t0 < 300;
        if (st && st.mode === 'pan') {
          this._endGesture();
        } else if (st && st.mode === 'cross') {
          // 抬手后十字线留着（通达信行为），再点一下才收起
          this._notifyView();
        } else if (tap) {
          const now = Date.now();
          const r = cv.getBoundingClientRect();
          const t = e.changedTouches[0];
          if (now - lastTap < 380) {
            lastTap = 0;
            const had = tapHadCross;
            tapHadCross = false;
            // 双击的语义按「按下第一下之前有没有线」分流：
            // 有线 → 只收起线，K 线原地不动（正看历史时被拉回最新很恼人）；
            // 无线 → 才把视口送回最新。
            this._clearHover();
            if (!had) this._springTo(Math.max(0, this.data.length - this.viewCount));
          } else {
            lastTap = now;
            tapHadCross = this.hover >= 0;
            const my = t.clientY - r.top;
            if (my > this.mainTop && my < this.volBot) {
              this._setHover(t.clientX - r.left, my);
              this._pinned = true;
            } else {
              // 点到坐标轴 / 图外 = 收起光标（通达信里点空白处的同义动作）
              this._clearHover();
            }
          }
        }
        st = null;
        this._touching = false;
      };
      cv.addEventListener('touchend', finish, { passive: true });
      cv.addEventListener('touchcancel', () => {
        clearTimeout(hold);
        st = null;
        pinch = null;
        this._suspendOverlay = false;
        this._touching = false;
        this._notifyView();
      }, { passive: true });
    }

    _setHover(mx, my) {
      const idx = this._idxAt(mx);
      if (idx === this.hover && my === this.hoverY) return;
      this.hover = idx;
      this.hoverY = my;
      this.invalidate();
    }

    _clearHover() {
      if (this.hover < 0) return;
      this.hover = -1;
      this.hoverY = null;
      this._pinned = false;
      if (this.tip) this.tip.style.opacity = 0;
      this.invalidate();
    }

    _idxAt(mx) {
      const i = Math.floor((mx - LAYOUT.left) / this.bw() + this.pos);
      return Math.max(0, Math.min(this.data.length - 1, i));
    }
  }

  global.QLChart = Chart;
})(window);
