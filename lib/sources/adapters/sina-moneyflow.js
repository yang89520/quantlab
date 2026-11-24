'use strict';
/**
 * 新浪板块资金流适配器 —— 替代已熔断的东财 clist f62（net-inflow 资产）。
 *
 * 为什么换：东财 push2 clist 在 2026-11-18 连续 100 次失败被熔断，
 * 导致「板块主力净流入」长期为空。新浪这个接口实测稳定，且**直接返回
 * 新浪板块代码**（category = new_jxhy / gn_rzrq），与板块字典同体系，
 * 可以按 code 精确合并 —— 不需要东财那套「按名称去后缀猜」的模糊匹配，
 * 匹配率从「精确名很低、要靠保守匹配补」变成基本 100%。
 *
 * 接口：GET MoneyFlow.ssl_bkzj_bk?page=&num=&sort=netamount&asc=0&fenlei=
 *   fenlei=0 行业（实测 48 个）、fenlei=1 概念（实测 181 个）
 *   num 给 500 一次拿全，无需翻页。
 *
 * ── 口径（重要，与东财不同）────────────────────────────────
 *  · netamount  单位「元」，是新浪定义的净流入额（大单口径），
 *               与东财 f62「主力净流入」（超大单+大单）**不完全等价**，
 *               量级相近但边界不同，不可与历史东财数值直接比较。
 *  · ratioamount 净流入占比（小数，0.0303 = 3.03%），跨板块可比性比净额好，
 *               因为不受板块市值大小影响 —— 分位计算优先用它。
 *  · avg_changeratio 板块涨跌幅（小数）。
 *  · turnover   成交额，单位「亿元」。
 *  · 数据为当日快照，盘中实时变动，收盘后固定。
 */

const HOST = 'https://vip.stock.finance.sina.com.cn';
const API = `${HOST}/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk`;
const PAGE_SIZE = 500;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function get(fenlei) {
  const url = `${API}?page=1&num=${PAGE_SIZE}&sort=netamount&asc=0&fenlei=${fenlei}`;
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (QuantLab)',
      referer: 'https://finance.sina.com.cn/',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`新浪资金流 HTTP ${r.status} (fenlei=${fenlei})`);
  const txt = await r.text();
  const s = String(txt).trim();
  if (!s || s === 'null' || s === '[]') return [];
  let arr;
  try {
    arr = JSON.parse(s);
  } catch (e) {
    throw new Error(`新浪资金流返回非 JSON (fenlei=${fenlei})：${s.slice(0, 80)}`);
  }
  if (!Array.isArray(arr)) throw new Error(`新浪资金流返回结构异常 (fenlei=${fenlei})`);

  const out = [];
  for (const x of arr) {
    const code = String(x.category || '').trim();
    const name = String(x.name || '').trim();
    if (!code || !name) continue;
    out.push({
      code,                                   // new_jxhy / gn_rzrq，与板块字典同体系
      name,
      netInflow: num(x.netamount),            // 元
      netRatio: num(x.ratioamount),           // 小数
      chgPct: num(x.avg_changeratio) != null ? num(x.avg_changeratio) * 100 : null,
      turnoverYi: num(x.turnover),            // 亿元
      inAmount: num(x.inamount),
      outAmount: num(x.outamount),
      leadSymbol: String(x.ts_symbol || '').trim() || null,
      leadName: String(x.ts_name || '').trim() || null,
      leadChgPct: num(x.ts_changeratio) != null ? num(x.ts_changeratio) * 100 : null,
      kind: String(fenlei) === '1' ? 'concept' : 'industry',
    });
  }
  return out;
}

/**
 * 取全部板块资金流（行业 + 概念）。
 * 任一批全失败才抛错；一批成功一批失败时返回成功的部分，由调用方按 health 呈现。
 * @returns {Promise<Array<{code,name,netInflow,netRatio,chgPct,...}>>}
 */
async function fetchInflow() {
  const results = await Promise.allSettled([get(0), get(1)]);
  const merged = new Map();
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const x of r.value) merged.set(x.code, x);
    } else {
      errors.push(r.reason && r.reason.message);
    }
  }
  if (!merged.size) throw new Error(`新浪资金流两批均不可用：${errors.join(' / ') || 'unknown'}`);
  return [...merged.values()];
}

/**
 * 按板块代码合并资金流到板块列表（精确匹配，不做名称模糊）。
 * 与 em.mergeByName 的签名保持兼容，便于直接替换。
 * @param {Array} sinaRows 板块列表（code 为 new_* / gn_*）
 * @param {Array} flowRows fetchInflow() 的结果
 */
function mergeByCode(sinaRows, flowRows) {
  const byCode = new Map();
  for (const f of flowRows || []) byCode.set(f.code, f);
  let matched = 0;
  let unmatched = 0;
  const rows = (sinaRows || []).map((s) => {
    const f = byCode.get(s.code);
    if (!f) {
      unmatched++;
      return Object.assign({}, s, { netInflow: null, netRatio: null, inflowCode: null });
    }
    matched++;
    return Object.assign({}, s, {
      netInflow: f.netInflow,
      netRatio: f.netRatio,
      inflowCode: f.code,
      leadName: f.leadName,
      leadChgPct: f.leadChgPct,
    });
  });
  return { rows, matched, unmatched };
}

module.exports = { fetchInflow, mergeByCode };
