'use strict';
/**
 * 声明式资产注册表（docs/dev/10 §2.1）—— 唯一事实源。
 * sources 是有序兜底链，第一个是主源，顺序是实测出来的。
 */
const ASSETS = {
  'sector-list-industry': { cn: '行业板块列表', sources: ['sina-hy', 'em-clist-industry'], risk: 'low' },
  'sector-list-concept': { cn: '概念板块列表', sources: ['sina-fljk', 'em-clist-concept'], risk: 'low' },
  'sector-members': { cn: '板块成分股', sources: ['sina-node', 'em-clist-members'], risk: 'low' },
  'sector-kline': { cn: '板块K线', sources: ['local-aggregate'], risk: 'none' },
  'market-snapshot': { cn: '全市场快照', sources: ['sina-quote', 'em-push2delay'], risk: 'low' },
  'zt-pool': { cn: '涨停池', sources: ['em-push2ex', 'snapshot-derive'], risk: 'med' },
  'stock-kline': { cn: '个股K线', sources: ['local-db', 'ths', 'sina'], risk: 'low' },
  'net-inflow': { cn: '板块主力净流入', sources: ['em-clist-f62', 'none'], risk: 'med' },
};

// 可信度分级（09 §3）：A 本地库 / B 稳定网络源 / C 降级推导 / D 兜底
const LEVEL = {
  'local-aggregate': 'A',
  'local-db': 'A',
  'sina-hy': 'B',
  'sina-fljk': 'B',
  'sina-node': 'B',
  'sina-quote': 'B',
  ths: 'B',
  sina: 'B',
  'em-clist-industry': 'C',
  'em-clist-concept': 'C',
  'em-clist-members': 'C',
  'em-clist-f62': 'C',
  'em-push2delay': 'C',
  'em-push2ex': 'C',
  'snapshot-derive': 'C',
  none: null,
};

function asset(key) {
  const a = ASSETS[key];
  if (!a) throw new Error(`未注册的资产：${key}`);
  return a;
}

module.exports = { ASSETS, LEVEL, asset };
