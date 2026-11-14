'use strict';
/**
 * 按风险等级配速（docs/dev/10 §2.2）。
 * 东财的间歇失败很可能是限流，硬怼会被封源——这是 tdx-backtest 踩过的坑。
 */
const config = require('../config');
const { ASSETS } = require('./registry');

const lastAt = new Map();

async function wait(assetKey, src) {
  const meta = ASSETS[assetKey];
  const risk = meta ? meta.risk : 'low';
  const ms = Number((config.sources.pacingMs || {})[risk] || 0);
  if (ms <= 0) return;
  const k = `${assetKey}:${src}`;
  const prev = lastAt.get(k) || 0;
  const gap = Date.now() - prev;
  if (gap < ms) await new Promise((r) => setTimeout(r, ms - gap));
  lastAt.set(k, Date.now());
}

function reset() { lastAt.clear(); }

module.exports = { wait, reset };
