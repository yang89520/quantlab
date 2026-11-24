#!/usr/bin/env node
'use strict';
/**
 * 资金量价指标研究 · 样本数据集构建
 *
 * 目标：为「模拟主力净量」类指标的回测准备一份干净、可复现的日线样本。
 *
 * 抽样规则（全部写死，任何人重跑都应得到同一批股票）：
 *   1. 取最近交易日全市场快照，剔除北交所（涨跌幅与流动性制度不同）；
 *   2. 剔除流通市值 < 5 亿（微盘股流动性噪声太大，次日开盘价不可信）；
 *   3. 按流通市值五等分，每层等距抽 100 只 —— 保证大中小盘都有代表，
 *      避免「只在茅台上有效」或「只在妖股上有效」；
 *   4. 拉 2022 年至今的日线（前复权价 + 不复权真量真额）。
 *
 * 产物：data/backtest/flow-dataset.json
 *   { meta: {...}, series: { sh600519: [[d,o,h,l,c,v,a], ...] } }
 *
 * 用法：
 *   node tools/flow-dataset.js            # 已有缓存则跳过
 *   node tools/flow-dataset.js --force    # 强制重拉
 */

const fs = require('fs');
const path = require('path');
const dao = require('../lib/dao');
const fuyao = require('../lib/sources/adapters/fuyao');

const OUT_DIR = path.join(__dirname, '..', 'data', 'backtest');
const OUT_FILE = path.join(OUT_DIR, 'flow-dataset.json');

const START = '2022-01-01';
const END = '2026-11-21';
const PER_LAYER = 100;
const LAYERS = 5;
const MIN_FLOAT_CAP = 5e8;
const CONCURRENCY = 4;
const BATCH = 10;

const ms = (s) => new Date(`${s}T00:00:00+08:00`).getTime();

/** 固定种子线性同余，保证每次抽样一致 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function toKey(market, code) {
  return `${market}${code}`;
}

async function pickSample() {
  const db = await dao.open();
  // 最近交易日：从今天往前找，最多回溯 10 天（含长假）
  let rows = [];
  let date = null;
  for (let i = 0; i < 10 && !rows.length; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    rows = await db.query('snapshot', { where: { date: d }, limit: 6000 });
    if (rows.length) date = d;
  }
  if (!rows.length) throw new Error('快照表里近 10 天都没有数据，无法抽样');

  const pool = rows
    .filter((r) => r.market !== 'bj')
    .filter((r) => Number(r.float_cap) >= MIN_FLOAT_CAP)
    .map((r) => ({ key: toKey(r.market, r.code), code: r.code, cap: Number(r.float_cap) }))
    .sort((a, b) => a.cap - b.cap);

  const rand = rng(20261121);
  const picked = [];
  const seen = new Set();
  for (let L = 0; L < LAYERS; L++) {
    const from = Math.floor((L * pool.length) / LAYERS);
    const to = Math.floor(((L + 1) * pool.length) / LAYERS);
    const seg = pool.slice(from, to);
    // 层内等距 + 抖动，避免取到价格尾数相同的整块
    const step = Math.max(1, Math.floor(seg.length / PER_LAYER));
    let cursor = Math.floor(rand() * step);
    let got = 0;
    for (let i = 0; i < seg.length && got < PER_LAYER; i++) {
      const item = seg[(cursor + i * step) % seg.length];
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      picked.push(item);
      got++;
    }
  }
  return { date, picked, total: pool.length };
}

async function fetchAll(keys) {
  const series = {};
  const failed = [];
  const batches = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));

  let done = 0;
  async function worker(queue) {
    while (queue.length) {
      const batch = queue.shift();
      try {
        const { rows } = await fuyao.historicalBatch(batch, {
          interval: '1d',
          start: ms(START),
          end: ms(END),
          adjust: 'forward',
        });
        for (const [k, arr] of rows) {
          series[k] = arr.map((r) => [r.d, r.o, r.h, r.l, r.c, r.v, r.a]);
        }
        for (const k of batch) if (!rows.has(k)) failed.push(k);
      } catch (e) {
        failed.push(...batch);
        process.stderr.write(`批量失败 ${batch[0]}…: ${e.message}\n`);
      }
      done++;
      if (done % 10 === 0) process.stderr.write(`  ${done}/${batches.length} 批\n`);
    }
  }
  const queue = batches.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
  return { series, failed };
}

/** 数据质量闸门：根数太少（次新/长期停牌）直接剔除，免得污染统计 */
function qualify(arr) {
  if (!Array.isArray(arr) || arr.length < 600) return false;
  const valid = arr.every((r) => r[4] > 0 && r[5] >= 0 && r[6] > 0);
  if (!valid) return false;
  // 停牌洞：相邻交易日间隔 > 30 自然日，说明长期停牌，剔除
  for (let i = 1; i < arr.length; i++) {
    const gap = (new Date(arr[i][0]) - new Date(arr[i - 1][0])) / 86400000;
    if (gap > 30) return false;
  }
  return true;
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && fs.existsSync(OUT_FILE)) {
    const j = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log(`已有缓存：${Object.keys(j.series).length} 只，跳过（--force 重拉）`);
    return;
  }
  if (!fuyao.enabled()) throw new Error('未配置扶摇 apiKey');

  const t0 = Date.now();
  const { date, picked, total } = await pickSample();
  console.log(`抽样基准日 ${date}，可选池 ${total} 只，抽中 ${picked.length} 只`);

  const { series, failed } = await fetchAll(picked.map((p) => p.key));
  const clean = {};
  const dropped = [];
  for (const [k, arr] of Object.entries(series)) {
    if (qualify(arr)) clean[k] = arr;
    else dropped.push(k);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    meta: {
      builtAt: new Date().toISOString(),
      snapshotDate: date,
      start: START,
      end: END,
      adjust: 'forward（价格）/ none（量额）',
      sampled: picked.length,
      kept: Object.keys(clean).length,
      failed,
      dropped,
      layers: LAYERS,
      perLayer: PER_LAYER,
    },
    series: clean,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));

  const bars = Object.values(clean).reduce((s, a) => s + a.length, 0);
  console.log(`完成：保留 ${Object.keys(clean).length} 只 / ${bars} 根，剔除 ${dropped.length}，失败 ${failed.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`产物 ${OUT_FILE}（${(fs.statSync(OUT_FILE).size / 1048576).toFixed(1)} MB）`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
