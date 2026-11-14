'use strict';
/**
 * 数据源健康层（docs/dev/10 §2.3/§2.4）。
 *
 * 状态机：ok | degraded | down | unknown
 *   down    = 累计失败 >= downAfterFails(3) 且最近 downWindow(5) 次全失败
 *   degraded= 有失败但也有成功
 *   ok      = 只有成功
 * 熔断：down 后写 trippedUntil = now + cooldownMin(20min)，
 *       冷却期内即使探活成功也保持熔断；冷却结束允许再试，成功才解除。
 *
 * 落盘：data/sources/health.json（原子 tmp→rename）。
 * 文档写的是 ql.duckdb 的 meta 表，目的是让 cron 与 Web 两进程共享；
 * 但 Web 进程写 DuckDB 会和 cron 抢单写锁（实测踩过），改用共享 JSON 文件，
 * 同样跨进程、且无锁。语义不变，仅物理位置调整。
 *
 * 本层只做记录与呈现，不改变既有降级语义：真实源失败仍直接抛错由上层兜底，绝不静默造假。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { ASSETS } = require('./registry');

const FILE = path.join(config.__root, 'data', 'sources', 'health.json');
let state = null;

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { state = {}; }
  if (!state || typeof state !== 'object') state = {};
  return state;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}
function key(assetKey, src) { return `${assetKey}:${src}`; }
function blank() { return { ok: 0, fail: 0, recent: [], lat: [], lastError: null, trippedUntil: null }; }

function compute(rec) {
  const c = config.sources;
  const recent = rec.recent.slice(-c.downWindow);
  if (!rec.ok && !rec.fail) return 'unknown';
  if (rec.fail >= c.downAfterFails && recent.length >= c.downAfterFails && recent.every((x) => x === false)) return 'down';
  if (rec.fail > 0 && rec.ok > 0) return 'degraded';
  if (rec.fail > 0) return 'degraded';
  return 'ok';
}

function record(assetKey, src, success, latencyMs, err) {
  const s = load();
  const k = key(assetKey, src);
  if (!s[k]) s[k] = blank();
  const rec = s[k];
  if (success) {
    rec.ok++;
    if (latencyMs != null) { rec.lat.push(Number(latencyMs)); rec.lat = rec.lat.slice(-20); }
    // 冷却期结束后的成功才解除熔断
    if (rec.trippedUntil && Date.now() >= new Date(rec.trippedUntil).getTime()) rec.trippedUntil = null;
  } else {
    rec.fail++;
    rec.lastError = err ? String(err).slice(0, 200) : 'unknown';
  }
  rec.recent.push(!!success);
  rec.recent = rec.recent.slice(-config.sources.downWindow);
  rec.state = compute(rec);
  if (rec.state === 'down' && !rec.trippedUntil) {
    rec.trippedUntil = new Date(Date.now() + config.sources.cooldownMin * 60 * 1000).toISOString();
  }
  save();
  return rec.state;
}

/** 冷却期内保持熔断；探活成功也不提前恢复（10 §378 验收） */
function isTripped(assetKey, src) {
  const rec = load()[key(assetKey, src)];
  if (!rec || !rec.trippedUntil) return false;
  if (Date.now() >= new Date(rec.trippedUntil).getTime()) return false;
  return true;
}

function avgLat(rec) {
  if (!rec.lat || !rec.lat.length) return null;
  return Math.round(rec.lat.reduce((a, b) => a + b, 0) / rec.lat.length);
}

function snapshot() {
  const s = load();
  const out = {};
  for (const [assetKey, meta] of Object.entries(ASSETS)) {
    const sources = meta.sources.map((src) => {
      const rec = s[key(assetKey, src)] || blank();
      return {
        name: src,
        state: rec.state || 'unknown',
        ok: rec.ok, fail: rec.fail,
        avgLatMs: avgLat(rec),
        lastError: rec.lastError,
        trippedUntil: rec.trippedUntil,
      };
    });
    const tripped = sources.filter((x) => x.trippedUntil && Date.now() < new Date(x.trippedUntil).getTime()).map((x) => x.name);
    const active = sources.find((x) => x.state !== 'down' && !tripped.includes(x.name));
    out[assetKey] = {
      state: tripped.length && !active ? 'down' : (active ? active.state : 'unknown'),
      active: tripped.length && !active ? null : (active ? active.name : meta.sources[0]),
      tripped,
      sources,
    };
  }
  return out;
}

function reset() { state = {}; save(); }

module.exports = { record, isTripped, snapshot, reset, compute };
