'use strict';
/**
 * 声明式资产注册表（docs/dev/10 §2.1）—— 唯一事实源。
 * sources 是有序兜底链，第一个是主源，顺序是实测出来的。
 *
 * **2026-11-18 校正**：接入通达信网关后，`stock-kline` / `sector-kline` /
 * `market-snapshot` 三个资产的主源变了，但当时只改了代码路径、没改这里 ——
 * 于是「看注册表判断数据来源」变成假的。这次补齐，并把 `tdx-*` 系列
 * 加进 LEVEL（网络源，B 级）。
 */
const ASSETS = {
  'sector-list-industry': { cn: '行业板块列表', sources: ['sina-hy', 'em-clist-industry'], risk: 'low' },
  'sector-list-concept': { cn: '概念板块列表', sources: ['sina-fljk', 'em-clist-concept'], risk: 'low' },
  'sector-members': { cn: '板块成分股', sources: ['sina-node', 'em-clist-members'], risk: 'low' },

  // 板块 K 线：通达信板块指数（880xxx）优先，映射不到才回落成分聚合。
  // 这是云端方案的基石——没有它，板块强度只能靠本地 38.5GB 库。
  'sector-kline': {
    cn: '板块K线',
    sources: ['tdx-block-index', 'local-aggregate'],
    risk: 'low',
    note: 'tdx 覆盖约 45%（99/221），其余走 local-aggregate；无本地库时后者必然失败',
  },

  // 全市场快照：tdx 一次给全 5583 只（含成交额），比新浪少一层分页。
  // 代价：没有换手率与流通市值。
  'market-snapshot': {
    cn: '全市场快照',
    sources: ['tdx-snapshot', 'sina-quote', 'em-push2delay'],
    risk: 'low',
    via: 'datasource',
    note: '取数在 lib/datasource.js 的 snapshot 分支（要处理跨日缓存与时点标注），不经 fetchAsset。tdx 缺 turnover / floatCap，落 null 并标 degraded',
  },

  'stock-kline': {
    cn: '个股K线',
    sources: ['local-db', 'tdx-kline', 'ths', 'sina'],
    risk: 'low',
    via: 'datasource',
    note: '取数在 lib/datasource.js 的 kline-daily 分支（要处理本地优先、逐根补齐、按日截断），不经 fetchAsset。本地库优先（D2）；无本地库或请求当日时走 tdx，失败退 ths/sina',
  },

  'net-inflow': {
    cn: '板块主力净流入',
    sources: ['sina-moneyflow', 'em-clist-f62', 'none'],
    risk: 'med',
    note: '东财 f62 2026-11 起失效，改由新浪资金流顶上（B 级，云端作业实装）。'
      + '注：tdx 的 tdxstat2.cfg 只有成交额与板块归属，没有主力净流入，替代不了这一项',
  },
};

// 可信度分级（09 §3）：A 本地库 / B 稳定网络源 / C 降级推导 / D 兜底
const LEVEL = {
  'local-aggregate': 'A',
  'local-db': 'A',

  'tdx-kline': 'B',
  'tdx-block-index': 'B',
  'tdx-snapshot': 'B',
  'tdx-stat': 'C',          // 个股统计（PE/区间涨幅），未接入评分
  'tdx-hy': 'C',            // 行业归属，未接入

  'sina-hy': 'B',
  'sina-fljk': 'B',
  'sina-node': 'B',
  'sina-moneyflow': 'B',
  'sina-quote': 'B',
  ths: 'B',
  sina: 'B',

  'em-clist-industry': 'C',
  'em-clist-concept': 'C',
  'em-clist-members': 'C',
  'em-clist-f62': 'C',
  'em-push2delay': 'C',
  'snapshot-derive': 'C',
  none: null,
};

function asset(key) {
  const a = ASSETS[key];
  if (!a) throw new Error(`未注册的资产：${key}`);
  return a;
}

module.exports = { ASSETS, LEVEL, asset };
