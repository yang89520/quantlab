#!/usr/bin/env node
/**
 * 用本地快照重建「选股池缓存」，供上游行情列表被限流时兜底。
 *
 * 为什么需要：选股器要从 sina 分页拉 5580 只的列表，连续跑几次就会被限流
 * （实测能只回 2 只）。池子是选股的输入，不能因为一次限流就整条链路停摆 ——
 * 月线选股对「今天是哪 5580 只」不敏感，用昨日收盘的快照完全够。
 *
 * 名称从当日月线缓存里补（那里面每只都带 name），补不到的留空由前端显示代码。
 *
 * 用法：node tools/universe-cache.js [asOf]
 */
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');
const dao = require('../lib/dao');

(async () => {
  const st = await dao.open({ readOnly: true });
  const last = await st.query('snapshot', { order: 'date', desc: true, limit: 1 });
  if (!last.length) throw new Error('快照表为空，先跑 daily-close');
  const date = String(last[0].date).slice(0, 10);
  const rows = await st.query('snapshot', { where: { date }, limit: 8000 });

  // 名称：优先用当日月线缓存（每只带 name），没有就留空
  const asOf = process.argv[2] || date;
  const monthFile = path.join(__dirname, '..', 'data', 'cache', `month-${asOf}.json`);
  let names = {};
  if (fs.existsSync(monthFile)) {
    const m = JSON.parse(fs.readFileSync(monthFile, 'utf8'));
    for (const [sym, v] of Object.entries(m.data || {})) if (v && v.name) names[sym] = v.name;
  }

  const list = rows
    .filter((r) => r.market === 'sh' || r.market === 'sz' || r.market === 'bj')
    .map((r) => {
      const symbol = r.market + r.code;
      return { symbol, code: r.code, name: names[symbol] || '', amount: r.amount || 0, noTrade: false };
    })
    .sort((a, b) => b.amount - a.amount);

  const out = { at: new Date().toISOString(), source: `snapshot:${date}`, list };
  const p = path.join(__dirname, '..', 'data', 'cache', 'universe.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out));

  const cnt = (re) => list.filter((x) => re.test(x.symbol)).length;
  console.log(`池子已重建：${list.length} 只（快照 ${date}）→ ${p}`);
  console.log(`  主板 ${cnt(/^sh6(?!8[89])|^sz00/)} / 创业板 ${cnt(/^sz30/)} / 科创板 ${cnt(/^sh68[89]/)} / 北交所 ${cnt(/^bj/)}`);
  console.log(`  有名称 ${list.filter((x) => x.name).length} 只`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
