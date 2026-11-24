#!/usr/bin/env node
'use strict';
/**
 * 威科夫 v2 · 命令行批量结构扫描
 *
 * 为什么要有这个工具：
 *   页面上的「威科夫结构」筛选要先点「扫描全池」，两分多钟，而且结果只存在浏览器
 *   这一侧的内存里。想复核一批票、想导出来自己排、想接进别的脚本，都需要一条
 *   不依赖页面的通道。这里直接复用 public/js/shape.js 的同一份算法 —— 不是重写，
 *   所以命令行给出的阶段与详情页卡片必须一致，不一致就是 bug。
 *
 * 用法：
 *   node tools/wy-scan.js 600986 000001 600519      # 指定标的
 *   node tools/wy-scan.js --pool main --limit 300    # 主板前 300 只（按代码序）
 *   node tools/wy-scan.js --pool main --phase accumC,accumC0
 *   node tools/wy-scan.js --pool main --limit 500 --csv /tmp/wy.csv
 *
 * 参数：
 *   --pool <main|all|sh|sz|cyb|kcb|bj>   股票池，默认 main
 *   --limit <n>                          最多扫多少只，默认 60（每只要拉 260 根日线）
 *   --phase <a,b>                        只输出指定阶段
 *   --min-cause <n>                      建仓充分度下限
 *   --csv <path>                         另存 CSV
 *   --bars <n>                           取多少根日线，默认 260（与页面扫描一致）
 *
 * 输出的每一列都来自真实 K 线，没有任何推断值。数据拿不到的标的单独列出，不参与统计。
 */

const fs = require('fs');
const path = require('path');
const Q = require('../lib/quote');
const { wyckoff2Of, inPool, WY_PHASE } = require('../public/js/shape');

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const o = { codes: [], pool: 'main', limit: 60, phase: null, minCause: null, csv: null, bars: 260 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pool') o.pool = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 60;
    else if (a === '--phase') o.phase = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--min-cause') o.minCause = parseFloat(argv[++i]);
    else if (a === '--csv') o.csv = argv[++i];
    else if (a === '--bars') o.bars = parseInt(argv[++i], 10) || 260;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (/^\d{6}$/.test(a)) o.codes.push(a);
    else if (a.startsWith('-')) { console.error('未知参数:', a); process.exit(2); }
  }
  return o;
}

const CN = { high: '高', mid: '中', low: '低' };

/* 终端列宽对齐：中文按 2 个字符宽算 */
function pad(s, w) {
  s = String(s == null ? '' : s);
  let n = 0;
  for (const ch of s) n += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  if (n <= w) return s + ' '.repeat(w - n);
  // 超宽就截断加省略号：阶段名最长「吸筹 D 段 · 强势待回踩」约 24 宽，
  // 不截断会把后面的列全部顶歪
  let out = '', k = 0;
  for (const ch of s) {
    const cw = /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (k + cw > w - 2) { out += '…'; k += 2; break; }
    out += ch; k += cw;
  }
  return out + ' '.repeat(Math.max(0, w - k));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
    return;
  }

  /* ---- 取代码列表 ---- */
  let codes = opt.codes.slice();
  let nameOf = {};
  if (!codes.length) {
    const list = await Q.marketList('all');
    const pool = list.filter((x) => inPool(x.code, opt.pool));
    for (const x of pool) nameOf[x.code] = x.name;
    codes = pool.slice(0, opt.limit).map((x) => x.code);
    console.log(`股票池 ${opt.pool}：${pool.length} 只，本次扫描前 ${codes.length} 只（--limit 可调）\n`);
  }
  if (!codes.length) { console.error('没有可扫描的代码'); process.exit(1); }

  /* ---- 逐只计算（6 并发，与页面扫描同量级）---- */
  const out = [];
  const failed = [];
  let cursor = 0;
  const t0 = Date.now();
  async function worker() {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      try {
        const k = await Q.klines(code, opt.bars);
        const w = wyckoff2Of(k.rows);
        if (!w) { failed.push(code + '（数据不足 120 根）'); continue; }
        if (!nameOf[code] && k.name) nameOf[code] = k.name;
        if (opt.phase && opt.phase.indexOf(w.phase) < 0) continue;
        if (opt.minCause != null && !(w.cause >= opt.minCause)) continue;
        out.push({ code, name: nameOf[code] || k.name || '', date: k.rows[k.rows.length - 1][0], w });
      } catch (e) {
        failed.push(code + '（' + e.message + '）');
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  out.sort((a, b) => b.w.score - a.w.score);

  /* ---- 终端表格 ---- */
  const head = pad('代码', 8) + pad('名称', 12) + pad('阶段', 26) + pad('信', 4)
    + pad('分', 5) + pad('年内', 6) + pad('区间%', 7) + pad('低点', 6) + pad('充分', 6) + '最近事件';
  console.log(head);
  console.log('-'.repeat(96));
  for (const r of out) {
    const w = r.w;
    const ev = w.lastEv ? `${w.lastEv.type}(${w.lastEv.age})` : '—';
    console.log(
      pad(r.code, 8) + pad(String(r.name).slice(0, 5), 12)
      + pad(WY_PHASE[w.phase].name, 26) + pad(CN[w.conf], 4)
      + pad(w.score, 5) + pad(w.pos250 + '%', 6)
      + pad(w.isRange ? w.posInRange + '%' : '—', 7)
      + pad(`${w.lowRise}/${w.lowFall}`, 6)
      + pad(w.cause, 6) + ev
    );
  }
  console.log('-'.repeat(96));

  /* ---- 分布统计：一眼看出过滤条件是不是把人筛光了 ---- */
  const dist = {};
  for (const r of out) dist[r.w.phase] = (dist[r.w.phase] || 0) + 1;
  console.log(`\n命中 ${out.length} 只，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('阶段分布：' + Object.keys(dist).sort((a, b) => dist[b] - dist[a])
    .map((k) => `${WY_PHASE[k].name} ${dist[k]}`).join(' · '));
  if (failed.length) console.log(`\n取数失败 ${failed.length} 只：` + failed.slice(0, 8).join('、') + (failed.length > 8 ? ' …' : ''));

  /* ---- CSV ---- */
  if (opt.csv) {
    const rows = [['code', 'name', 'date', 'phase', 'phase_name', 'conf', 'confPct', 'score',
      'pos250', 'posInRange', 'inRange', 'rangeBars', 'sup', 'res', 'lowRise', 'lowFall',
      'hiRise', 'hiFall', 'sr', 'eff', 'cause', 'stall', 'ret60', 'lastEvent', 'lastEventAge']];
    for (const r of out) {
      const w = r.w;
      rows.push([r.code, r.name, r.date, w.phase, WY_PHASE[w.phase].name, w.conf, w.confPct, w.score,
        w.pos250, w.posInRange, w.inRange ? 1 : 0, w.w, w.sup, w.res, w.lowRise, w.lowFall,
        w.hiRise, w.hiFall, w.sr, w.eff, w.cause, w.stall, w.ret60,
        w.lastEv ? w.lastEv.type : '', w.lastEv ? w.lastEv.age : '']);
    }
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(',')).join('\n');
    fs.writeFileSync(path.resolve(opt.csv), '\ufeff' + csv);   // BOM：Excel 直接打开不乱码
    console.log('CSV 已写入 ' + path.resolve(opt.csv));
  }

  console.log('\n注：本工具输出的阶段与因子为启发式结构标注，仅供研究，不构成任何投资建议。');
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
