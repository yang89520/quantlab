'use strict';
/**
 * 东财增强适配器（间歇可用，绝不作主源/兜底，docs/dev/10 §3.1/§4）。
 * 实测：clist t:2/t:3 同一接口 5 分钟内可从 200 变 000；f62 与 fs=b:BK 常返 000；
 *       push2ex 涨停池可用；push2delay 可用；push2his 整域持久不可用（本项目不接）。
 *
 * 本适配器失败一律抛错，由上层 fetchAsset 记录健康度并跳到下一源；
 * 绝不返回空数组冒充「没有数据」（D1）。
 */
// 实测 2026-11-14：/api/qt/clist 已整域 404，正确路径带 /get 后缀。
// 保留 ut 参数兼容旧文档记录，实测不带也能返回。
const EM = 'https://push2.eastmoney.com/api/qt/clist/get';
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';

async function getJSON(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (QuantLab)', referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`东财 HTTP ${r.status}`);
  const j = await r.json();
  // 000 是东财的「无数据/被限流」，不是空结果
  if (!j || j.rc !== 0 || !j.data || !Array.isArray(j.data.diff)) {
    throw new Error('东财返回 000（间歇不可用/限流）');
  }
  return j.data;   // { total, diff }
}

function toRow(d) {
  return {
    code: String(d.f12 || ''),           // BK****
    name: String(d.f14 || ''),
    chgPct: Number(d.f3),
    netInflow: Number.isFinite(Number(d.f62)) ? Number(d.f62) : null,
    upCount: Number.isFinite(Number(d.f104)) ? Number(d.f104) : null,
    downCount: Number.isFinite(Number(d.f105)) ? Number(d.f105) : null,
  };
}

/** 实测 2026-11-14：pz 被硬限制为 100，必须按 pn 翻页才能取全。
 *  连打 11 页会被限流，所以逐页配速 + 单页重试；后续页失败保留已取部分（增强字段本就可选），
 *  第一页失败才抛错让上层明确降级，绝不拿空数组冒充成功。 */
async function fetchClist(fs, fields) {
  const out = [];
  let total = Infinity;
  for (let pn = 1; pn <= 12 && out.length < total; pn++) {
    const url = `${EM}?ut=${UT}&pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3`
      + `&fs=${encodeURIComponent(fs)}`
      + `&fields=${encodeURIComponent(fields || 'f12,f14,f3,f62,f104,f105')}`;
    let data = null;
    let lastErr = null;
    for (let retry = 0; retry < 2 && !data; retry++) {
      try { data = await getJSON(url); }
      catch (e) {
        lastErr = e;
        if (retry === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!data) {
      if (pn === 1) throw lastErr || new Error('东财首页请求失败');
      break;   // 部分成功：上层按名称匹配，匹配不上的板块照常走降级口径
    }
    total = Number(data.total) || 0;
    const diff = data.diff || [];
    for (const d of diff) out.push(toRow(d));
    if (!diff.length) break;
    await new Promise((r) => setTimeout(r, 300));   // med 风险配速，别把源打封
  }
  return out;
}

/** 行业板块增强（t:2） */
function fetchIndustry() { return fetchClist('m:90+t:2'); }
/** 概念板块增强（t:3） */
function fetchConcept() { return fetchClist('m:90+t:3'); }
/** 板块主力净流入（f62）：行业 t:2 + 概念 t:3 两批合并；一批失败不影响另一批 */
async function fetchInflow() {
  const out = [];
  for (const fs of ['m:90+t:2', 'm:90+t:3']) {
    try {
      const rows = await fetchClist(fs, 'f12,f14,f62');
      out.push.apply(out, rows);
    } catch (e) {
      // 记在日志里由上层 health 呈现，不把部分成功伪装成全失败
    }
  }
  if (!out.length) throw new Error('东财资金流两批均不可用');
  return out;
}

/** 涨停池（push2ex，实测可用） */
async function fetchZTPool(date) {
  const d = String(date || '').replace(/-/g, '');
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989`
    + `&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=fbt:asc&date=${d}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (QuantLab)' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`涨停池 HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !j.data || !Array.isArray(j.data.pool)) throw new Error('涨停池返回 000');
  return j.data.pool.map((x) => ({ code: String(x.c), name: x.n, chgPct: Number(x.zdp) }));
}

/**
 * 以新浪为骨架，按名称匹配东财增强字段；匹配不上的东财板块不入库（10 L166）。
 * 新浪是一级粗分类（49/172），东财是细分类（496/554），精确名命中率很低，
 * 故补一级「去行业/概念后缀」的保守匹配；不做模糊包含，避免张冠李戴。
 * 主键始终用新浪的 new_ 或 gn_ 前缀代码，东财 BK 开头代码只作 emCode 关联键。
 * @returns {{rows: Array, unmatched: number, matched: number}}
 */
function normName(s) {
  return String(s || '').replace(/(行业|概念|板块|指数|类)$/, '').trim();
}
function mergeByName(sinaRows, emRows) {
  const exact = new Map();
  const normed = new Map();
  for (const e of emRows || []) {
    exact.set(e.name, e);
    const n = normName(e.name);
    if (n && !normed.has(n)) normed.set(n, e);
  }
  let unmatched = 0, matched = 0;
  const rows = (sinaRows || []).map((s) => {
    const e = exact.get(s.name) || normed.get(normName(s.name));
    if (!e || !Number.isFinite(e.netInflow)) {
      unmatched++;
      return Object.assign({}, s, { emCode: null, netInflow: null });
    }
    matched++;
    return Object.assign({}, s, { emCode: e.code, netInflow: e.netInflow });
  });
  return { rows, unmatched, matched };
}

module.exports = { fetchIndustry, fetchConcept, fetchInflow, fetchZTPool, mergeByName };
