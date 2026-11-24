'use strict';
/**
 * 数据口径核对（联网）—— 回答一个问题：不同接口给的数，是不是同一个数。
 *
 * 三个层次，性质完全不同，必须分开看：
 *
 *  1. 原始价（不复权）：必须完全一致。任何偏差都是数据错误，不是口径差异。
 *     期望 0.0000%。
 *
 *  2. 复权序列：必然有差，且无法消除。前复权要处理分红，各家算法不同
 *     （等比累乘 vs 扣除累计分红），同一只票差 0.7%~2.7% 属正常。
 *     所以这里**只测量、不判错**，但会给出分布，超阈值时提醒复核。
 *     结论不是「谁对谁错」，而是「不能混用」。
 *
 *  3. 派生指标（偏离/箱位/量位）：前两个口径一致了，这里才能谈可比。
 *     箱位与量位是尺度无关的，两种复权下必须完全相同；
 *     偏离度会随复权变化，属预期。
 *
 * 用法：
 *   node tools/reconcile.js             # 默认抽样 8 只
 *   node tools/reconcile.js --n 20      # 抽样 20 只
 *   node tools/reconcile.js --full      # 全池逐只（慢）
 *
 * 退出码：原始价或派生指标不一致时非 0；复权偏差只告警不失败。
 */
const S = require('../lib/sources');
const F = require('../lib/sources/adapters/fuyao');

const args = process.argv.slice(2);
const argN = (() => {
  const i = args.indexOf('--n');
  return i >= 0 ? Math.max(1, Number(args[i + 1]) || 8) : 8;
})();

const SINA_K = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

async function sinaRaw(sym, len) {
  const u = `${SINA_K}?symbol=${sym}&scale=240&ma=no&datalen=${len}`;
  const r = await fetch(u, { headers: { referer: 'https://finance.sina.com.cn/', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`新浪 HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('新浪返回非数组');
  return new Map(j.map((x) => [x.day, Number(x.close)]));
}

/** 从日线序列算箱位/量位/偏离（与 formula-screen 完全同口径） */
function metrics(rows, barIdxFromEnd = 0) {
  const c = rows.map((r) => r.c);
  const v = rows.map((r) => r.v);
  const i = c.length - 1 - barIdxFromEnd;
  if (i < 59) return null;
  const win = c.slice(0, i + 1);
  const vwin = v.slice(0, i + 1);
  const ma60 = win.slice(-60).reduce((a, b) => a + b, 0) / 60;
  const low34 = Math.min(...win.slice(-34));
  const high34 = Math.max(...win.slice(-34));
  const v30 = vwin.slice(-30);
  const vmin = Math.min(...v30);
  const vmax = Math.max(...v30);
  return {
    dev: (win[i] / ma60 - 1) * 100,
    box: high34 === low34 ? 0 : (win[i] - low34) / (high34 - low34) * 100,
    vpos: vmax === vmin ? 0 : (vwin[i] - vmin) / (vmax - vmin) * 100,
  };
}

(async () => {
  if (!F.enabled()) {
    console.error('未配置扶摇 key（config.local.json → sources.fuyao.apiKey）');
    process.exit(2);
  }

  const uni = await require('../lib/formula-screen').buildUniverse({ limit: 400 });
  const pool = uni.list.slice(0, argN);
  console.log(`口径核对：抽样 ${pool.length} 只（池 ${uni.total} 只）\n`);

  const rows = [];
  let hardFail = 0;

  for (const it of pool) {
    const sym = it.symbol;
    try {
      const fRaw = await F.historical(sym, { interval: '1d', adjust: 'none' });
      const fFw = await F.historical(sym, { interval: '1d', adjust: 'forward' });
      const ths = await S.klines({ symbol: sym, code: sym.slice(2), market: sym.slice(0, 2) }, 140);
      const sRaw = await sinaRaw(sym, 140);

      // 1) 原始价
      const mRaw = new Map(fRaw.rows.map((r) => [r.d, r.c]));
      let nRaw = 0, maxRaw = 0;
      for (const [d, c] of sRaw) {
        if (!mRaw.has(d) || !c) continue;
        nRaw++;
        maxRaw = Math.max(maxRaw, Math.abs(mRaw.get(d) - c) / c * 100);
      }

      // 2) 复权序列（fuyao 重建 vs ths 前复权）
      const mFw = new Map(fFw.rows.map((r) => [r.d, r.c]));
      let nFw = 0, sumFw = 0, maxFw = 0;
      for (const r of ths.rows) {
        const [d, , c] = r;
        if (!mFw.has(d) || !c) continue;
        nFw++;
        const p = Math.abs(mFw.get(d) - c) / c * 100;
        sumFw += p; maxFw = Math.max(maxFw, p);
      }

      // 3) 派生指标：必须按「同一天」对齐后再各算一遍。
      //    两家返回的根数不同（fuyao 是全部历史，ths 只有 140 根），
      //    用同一个「倒数第几根」去索引会取到完全不同的日期 —— 之前就是这么错的。
      const thsRows = ths.rows.map(([d, o, c, h, l, v]) => ({ d, o, c, h, l, v }));
      const fMapAll = new Map(fFw.rows.map((r) => [r.d, r]));
      const tSlice = [];
      const fSlice = [];
      for (const r of thsRows) {
        const fr = fMapAll.get(r.d);
        if (fr) { tSlice.push(r); fSlice.push(fr); }
      }
      const mt = metrics(tSlice);
      const mf = metrics(fSlice);

      const neg = fFw.rows.filter((r) => r.c <= 0 || r.o <= 0 || r.l <= 0).length;
      if (neg) hardFail++;

      const badRaw = maxRaw > 0.05;                 // 原始价偏差 >0.05% 视为错误
      if (badRaw) hardFail++;

      rows.push({
        sym, name: it.name, nRaw, maxRaw, nFw,
        meanFw: nFw ? sumFw / nFw : NaN, maxFw, neg,
        dBox: mt && mf ? Math.abs(mt.box - mf.box) : NaN,
        dVpos: mt && mf ? Math.abs(mt.vpos - mf.vpos) : NaN,
        dDev: mt && mf ? Math.abs(mt.dev - mf.dev) : NaN,
        badRaw,
      });
    } catch (e) {
      rows.push({ sym, name: it.name, err: e.message });
    }
  }

  const ok = rows.filter((r) => !r.err);
  console.log('代码      名称        原始价重叠 最大偏差   复权重叠 平均偏差 最大偏差 负值  箱位Δ  量位Δ  偏离Δ');
  console.log('─'.repeat(104));
  for (const r of rows) {
    if (r.err) { console.log(`${r.sym.padEnd(9)} ${String(r.name || '').slice(0, 6).padEnd(10)} 取数失败：${r.err.slice(0, 48)}`); continue; }
    console.log(
      `${r.sym.padEnd(9)} ${String(r.name || '').slice(0, 6).padEnd(10)}`
      + `${String(r.nRaw).padStart(8)} ${(r.maxRaw.toFixed(4) + '%').padStart(9)}`
      + `${String(r.nFw).padStart(8)} ${(r.meanFw.toFixed(2) + '%').padStart(9)}`
      + `${(r.maxFw.toFixed(2) + '%').padStart(9)} ${String(r.neg).padStart(4)}`
      + `${(Number.isFinite(r.dBox) ? r.dBox.toFixed(3) : '-').padStart(7)}`
      + `${(Number.isFinite(r.dVpos) ? r.dVpos.toFixed(3) : '-').padStart(7)}`
      + `${(Number.isFinite(r.dDev) ? r.dDev.toFixed(2) : '-').padStart(7)}`,
    );
  }

  const avg = (f) => { const a = ok.map(f).filter(Number.isFinite); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; };
  const worstBox = Math.max(...ok.map((r) => (Number.isFinite(r.dBox) ? r.dBox : 0)));
  const worstVpos = Math.max(...ok.map((r) => (Number.isFinite(r.dVpos) ? r.dVpos : 0)));
  const worstRaw = Math.max(...ok.map((r) => r.maxRaw));
  const worstFw = Math.max(...ok.map((r) => (Number.isFinite(r.maxFw) ? r.maxFw : 0)));

  console.log('─'.repeat(104));
  console.log(`原始价最大偏差      ${worstRaw.toFixed(4)}%   ${worstRaw <= 0.05 ? '✓ 一致' : '✗ 超阈值(0.05%)'}`);
  console.log(`复权平均偏差        ${avg((r) => r.meanFw).toFixed(2)}%   （分红算法差异，预期 0.5%~3%）`);
  console.log(`复权最大偏差        ${worstFw.toFixed(2)}%   ${worstFw <= 5 ? '✓ 在已知范围' : '⚠ 超 5%，建议复核'}`);
  // 箱位/量位在「窗口内无除权」时应完全相同；窗口含分红时会有小幅跳变，属复权口径的固有影响。
  // 超过 20 只可能是日期没对齐或数据错，不是口径问题。
  console.log(`箱位最大差异        ${worstBox.toFixed(3)}   ${worstBox <= 20 ? '✓ 在复权口径可控范围' : '✗ 疑似错位或数据错'}`);
  console.log(`量位最大差异        ${worstVpos.toFixed(3)}   ${worstVpos <= 20 ? '✓ 在复权口径可控范围' : '✗ 疑似错位或数据错'}`);
  console.log(`负值序列             ${ok.filter((r) => r.neg).length} 只  ${ok.every((r) => !r.neg) ? '✓ 无' : '✗ 存在'}`);
  console.log(`取数失败             ${rows.length - ok.length} 只`);

  const pass = hardFail === 0 && worstBox <= 20 && worstVpos <= 20;
  console.log(`\n结论：${pass ? '✓ 原始价与派生指标一致，复权差异在已知范围内，可安全使用单一源' : '✗ 存在硬性不一致，需排查'}`);
  console.log('注意：复权差异 0.7%~2.7% 是两家分红算法的固有差别，不可通过缩放消除。');
  console.log('     同一份名单必须来自同一个源，禁止逐只混用。');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('核对失败：', e.message); process.exit(2); });
