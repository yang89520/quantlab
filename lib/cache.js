'use strict';
/**
 * 跨进程二级缓存（docs/dev/01 §7.5）。
 *
 * 目录：`data/cache/YYYY-MM-DD/market.json`、`data/cache/YYYY-MM-DD/klines-<code>.json`
 * 目的：cron 与 Web 服务是两个进程，共享这层，避免同一份当日数据被拉两次。
 *
 * 三条硬约束：
 *  · **跨日必失效**：目录按自然日分，读的时候只认「今天」的目录（D3 不许拿旧值顶替）
 *  · **命中要留痕**：返回值带 `fetchedAt` 与 `day`，调用方必须把它并进 D4 元信息
 *  · **只缓存当日可复用的数据**：历史 K 线内容不变才缓存；当日盘中数据不缓存（会变）
 *
 * 关掉：`config.cache.enabled=false` 或环境变量 `QL_NO_CACHE=1`（测试用）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function enabled() {
  if (process.env.QL_NO_CACHE === '1') return false;
  const c = config.cache || {};
  return c.enabled !== false;
}

function baseDir() {
  const c = config.cache || {};
  return path.join(config.__root, c.dir || path.join('data', 'cache'));
}

function dayDir(day) {
  return path.join(baseDir(), day || todayStr());
}

function fileOf(name, day) {
  // 文件名只允许字母数字与 - _ .，避免路径穿越
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dayDir(day), safe + '.json');
}

/**
 * 读当日缓存。
 * @returns {{value, fetchedAt, day}|null} 未命中、跨日、损坏一律返回 null
 */
function get(name) {
  if (!enabled()) return null;
  const day = todayStr();
  const p = fileOf(name, day);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 跨日/结构不符一律当未命中——宁可重拉，也不拿旧值冒充
    if (!obj || obj.day !== day || obj.value === undefined) return null;
    return { value: obj.value, fetchedAt: obj.fetchedAt || null, day: obj.day };
  } catch (e) {
    log.warn('cache.read_failed', { name, error: e.message });
    return null;
  }
}

/** 写当日缓存（原子替换）；失败只告警，绝不影响主流程 */
function set(name, value) {
  if (!enabled()) return false;
  const day = todayStr();
  const p = fileOf(name, day);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload = JSON.stringify({ day, fetchedAt: new Date().toISOString(), value });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    log.warn('cache.write_failed', { name, error: e.message });
    return false;
  }
}

/** 清理过期目录（保留最近 keepDays 天）；供 tools/archive.js 调用 */
function prune(keepDays) {
  const keep = Math.max(1, Number(keepDays) || Number((config.cache || {}).keepDays) || 7);
  const dir = baseDir();
  if (!fs.existsSync(dir)) return { removed: 0, kept: 0 };
  const days = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const cut = days.slice(0, Math.max(0, days.length - keep));
  let removed = 0;
  for (const d of cut) {
    try {
      fs.rmSync(path.join(dir, d), { recursive: true, force: true });
      removed++;
    } catch (e) {
      log.warn('cache.prune_failed', { day: d, error: e.message });
    }
  }
  return { removed, kept: days.length - removed };
}

module.exports = { get, set, prune, enabled, todayStr, baseDir, dayDir };
