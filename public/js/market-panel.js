/* ============================================================
 * QuantLab · 市场状态卡（卡尔曼）
 *
 * 这个卡片是整个卡尔曼模块唯一对外的「指令」：今天该承担多少风险。
 * 个股层面的卡尔曼信号已回测证否（A 股日线动量本身为负），
 * 但市场等权指数的 slopeZ 是有效的 —— 它管的不是「买哪只」，是「敢不敢买」。
 * ============================================================ */
(function () {
  'use strict';
  const box = document.getElementById('kalmanMarket');
  if (!box) return;

  const pct = (x, d) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%');

  function spark(history, color) {
    // 极简 sparkline：slopeZ 的时间序列，±0.5 用两条虚线标出「顺风/逆风」边界
    const vals = history.map((h) => h.z).filter((v) => isFinite(v));
    if (vals.length < 2) return '';
    const W = 100, H = 34;
    let lo = Math.min(-2, ...vals), hi = Math.max(2, ...vals);
    const X = (i) => (i / (vals.length - 1)) * W;
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const grid = [0.5, -0.5].map((v) =>
      `<line x1="0" y1="${Y(v).toFixed(1)}" x2="${W}" y2="${Y(v).toFixed(1)}" stroke="#2A3547" stroke-width=".5" stroke-dasharray="2 2"/>`
    ).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:34px;display:block;margin:6px 0 2px">
      ${grid}<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function render(d) {
    const st = d.state;
    const chg = d.change20;
    // 恐慌档单独提示：历史 21 次、20 日 19 次为正，但样本不足以自动加仓，只做提示
    const warn = d.panic
      ? `<div style="margin-top:8px;padding:7px 9px;border-radius:6px;background:rgba(46,189,133,.10);border:1px solid rgba(46,189,133,.28);font-size:12px;line-height:1.6;color:#9FD8C0">
          急跌区（slopeZ ${d.slopeZ.toFixed(2)} < −2.5）。历史上这种状态的 21 个时点，其后 20 个交易日 19 次为正、均值约 +10%。
          属于均值回复区，但样本集中在几次急跌，不构成加仓依据 —— 看你的资金久期自己决定。
        </div>`
      : '';

    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:19px;font-weight:600;color:${st.color}">${st.label}</span>
        <span style="font-size:12px;color:var(--muted);padding:2px 7px;border:1px solid ${st.color}55;border-radius:4px">
          建议仓位 ${Math.round(st.pos * 100)}%
        </span>
        <span style="font-size:12px;color:var(--muted);margin-left:auto">
          ${d.index.name} ${d.price.toFixed(2)} · 近 20 日 ${pct(chg)}
        </span>
      </div>
      ${spark(d.history, st.color)}
      <div style="font-size:12.5px;line-height:1.75;color:var(--text2,#B9C4D2);margin-top:6px">
        ${d.headline}<br/>${d.advice}
      </div>
      <div style="display:flex;gap:14px;margin-top:9px;font-size:11.5px;color:var(--muted);flex-wrap:wrap">
        <span>slopeZ <b style="color:${st.color}">${d.slopeZ.toFixed(2)}</b></span>
        <span>偏离通道 ${d.dev.toFixed(2)}</span>
        <span>趋势线 ${d.level.toFixed(2)}</span>
        <span>${d.date}</span>
      </div>
      ${warn}
      <div style="margin-top:9px;font-size:11px;line-height:1.6;color:var(--muted);opacity:.8">
        口径：${d.index.name}日线 · 局部线性趋势模型（λ=${d.snr}）· slopeZ 是趋势显著性的 t 值。
        回测 2022-2026：该规则年化 +1.1%（满仓 −6.4%）、最大回撤 −17%（满仓 −46%）。
      </div>`;
  }

  let tries = 0;
  function load() {
    fetch('/api/kalman/market', { headers: { 'x-requested-with': 'fetch' } })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) {
          box.innerHTML = `<div style="font-size:12px;color:var(--muted)">市场状态暂不可用${j && j.error ? '：' + j.error : ''}</div>`;
          return;
        }
        render(j.data);
      })
      .catch(() => {
        if (tries++ < 2) return setTimeout(load, 2500);
        box.innerHTML = '<div style="font-size:12px;color:var(--muted)">市场状态接口无响应</div>';
      });
  }
  load();
})();
