#!/usr/bin/env node
'use strict';
/**
 * 预置策略：月线三重底（超跌 + 箱底 + 地量）。
 *
 * 为什么要一个 seed 脚本而不是直接写 data/strategies/defs.jsonl：
 *   defs.jsonl 是运行期数据（不入库），手工编辑容易破坏 version/archivedAt 的约定；
 *   strategies.save 会负责版本号、归档、字段裁剪。这里只是调用它，重复执行不会产生重复策略。
 *
 * 用法：node tools/seed-strategy.js [--force]
 */
const strategies = require('../lib/strategy');
const log = require('../lib/log');

const ID = 'st_moon3';
const NAME = '月线三重底';

const SOURCE = `{月线三重底：超跌红柱 + 买点 + 地量，三者同时成立}
{参数在这三行改数字：周期=均线月数，偏离阈=低于均线的百分比，箱位阈=34月区间位置}
周期:=60;
偏离阈:=10;
箱位阈:=20;

均60:=MA(C,周期);
偏离:=(C/均60-1)*100;

中位:=(2*C+H+L)/4;
低34:=LLV(L,34);
高34:=HHV(H,34);
箱位:=(中位-低34)/(高34-低34)*100;

{1. 超跌红柱：34 个月箱体的底部 20%，且价格低于 60 月均线 10% 以上}
超跌红柱:=箱位<20 AND 偏离<-10;

{2. 买点：参数化版本，FILTER 保证 20 根内不重复}
原始买:=偏离<-偏离阈 AND 箱位<箱位阈;
买:=FILTER(原始买,20);

{3. 地量：月成交量在近 30 个月成交量的底部 20%}
量位:=(V-LLV(V,30))/(HHV(V,30)-LLV(V,30)+0.0001)*100;
地量:=量位<20;

{输出：三重条件同时成立}
XG:超跌红柱 AND 买 AND 地量;`;

async function main() {
  const force = process.argv.includes('--force');
  const exists = strategies.get(ID);
  if (exists && !force) {
    console.log(`已存在：${ID} v${exists.version}（${exists.name}），未做改动。加 --force 覆盖为新版本。`);
    return;
  }
  // save 内部走串行队列，返回 Promise —— 不 await 会拿到 Promise 对象
  const s = await strategies.save({
    id: ID, name: NAME, type: 'formula', source: SOURCE,
    outputLine: 'XG', status: 'testing',
    note: '月线用法。历史统计（715 只/598 个信号，2020-11~2026-10）：'
      + '12 个月中位 +16.3%、胜率 72.9%；但个股孤立命中只有中位 +2.1%，'
      + '真正的底部信号是「命中率 ≥8%（全市场同时超跌）」那一档。'
      + '详见 docs/月线三重底-研究.md。',
    scanLevel: 'none',
  });
  log.info('seed.strategy_saved', { id: s.id, version: s.version });
  console.log(`已写入：${s.id} v${s.version}（${s.name}），输出线 ${s.outputLine}`);
  console.log('在 /lab 的「验证」页可以跑五道闸；「选股」页可以直接用它扫全市场。');
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
