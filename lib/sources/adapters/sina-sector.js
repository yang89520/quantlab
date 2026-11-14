'use strict';
/**
 * 新浪板块适配器（主源，实测稳定，docs/dev/10 §3.1/§3.2）。
 *  · 行业 newSinaHy.php → 49 个 new_*
 *  · 概念 newFLJK.php?param=class → 172 个 gn_*
 *  · 成分 Market_Center.getHQNodeData?node= → 可分页，最大板块 <100 只
 * 列表接口返回 GBK 编码的 JS 变量赋值，必须按 GBK 解码，否则乱码。
 * 板块代码统一用新浪体系，东财 BK**** 只作增强关联键，不作主键。
 */
const config = require('../../config');

const HOST = 'https://vip.stock.finance.sina.com.cn';
const HY = `${HOST}/q/view/newSinaHy.php`;
const GN = `${HOST}/q/view/newFLJK.php?param=class`;
const NODE = `${HOST}/quotes_service/api/json_v2.php/Market_Center.getHQNodeData`;

async function get(url, encoding) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (QuantLab)', referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`新浪 HTTP ${r.status}: ${url}`);
  const buf = await r.arrayBuffer();
  return new TextDecoder(encoding || 'utf-8').decode(buf);
}

/** 解析 `var S_Finance_xxx = {...};` */
function parseList(text) {
  const m = /=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(String(text).trim());
  if (!m) throw new Error('新浪板块列表格式无法识别（未找到 JSON 对象）');
  const obj = JSON.parse(m[1]);
  const out = [];
  for (const [code, raw] of Object.entries(obj)) {
    const a = String(raw).split(',');
    if (a.length < 8) continue;
    const num = (i) => { const v = Number(a[i]); return Number.isFinite(v) ? v : null; };
    out.push({
      code: a[0] || code,
      name: a[1] || '',
      stockCount: num(2),
      avgPrice: num(3),
      chgPct: num(5),
      volume: num(6),
      amount: num(7),
      leaderCode: a[8] || null,
      leaderName: a[12] || null,
    });
  }
  return out;
}

function assertSinaCodes(rows, type) {
  const re = type === 'industry' ? /^new_/ : /^gn_/;
  return rows.filter((r) => re.test(r.code)).map((r) => Object.assign({ type }, r));
}

async function fetchIndustry() {
  const rows = parseList(await get(HY, 'gbk'));
  return assertSinaCodes(rows, 'industry');
}
async function fetchConcept() {
  const rows = parseList(await get(GN, 'gbk'));
  return assertSinaCodes(rows, 'concept');
}

/** 成分股，自动翻页；page 返回空数组即结束 */
async function fetchMembers(node) {
  const cfg = config.sources;
  const out = [];
  for (let page = 1; page <= cfg.sectorMemberPages; page++) {
    const url = `${NODE}?node=${encodeURIComponent(node)}&num=${cfg.sectorMemberPageSize}`
      + `&page=${page}&sort=symbol&asc=1`;
    const text = await get(url);
    let arr;
    try { arr = JSON.parse(text); }
    catch (e) { throw new Error(`新浪成分股返回非 JSON（node=${node} page=${page}）`); }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const s of arr) {
      out.push({
        code: String(s.code || String(s.symbol || '').replace(/^(sh|sz|bj)/, '')),
        symbol: s.symbol,
        name: s.name || '',
        price: Number(s.trade),
        chgPct: Number(s.changepercent),
        amount: Number(s.amount),
      });
    }
    if (arr.length < cfg.sectorMemberPageSize) break;
  }
  return out;
}

function withMarket(code) {
  const c = String(code).replace(/^(sh|sz|bj)/, '');
  if (/^(6|9)/.test(c)) return `sh${c}`;
  if (/^(4|8)/.test(c)) return `bj${c}`;
  return `sz${c}`;
}

module.exports = { fetchIndustry, fetchConcept, fetchMembers, parseList, withMarket };
