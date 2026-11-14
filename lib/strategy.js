'use strict';
/**
 * 策略定义存储（docs/dev/02 S9 / 05 §7）。
 * Web 进程可写 → JSONL（09 §7.2 按写入方分离，避开 DuckDB 单写锁）。
 * 版本每次改源码 +1，旧版本进 archives 不删除；outputLine 必须显式指定，不许猜。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const DIR = () => path.join(config.__root, 'data', 'strategies');
const F = () => path.join(DIR(), 'defs.jsonl');
const A = () => path.join(DIR(), 'archives.jsonl');
const STATUSES = ['draft', 'testing', 'active', 'suspect', 'retired'];

let queue = Promise.resolve();
function serialize(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}
function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { log.warn('strategy.corrupt_line', { file: path.basename(p), line: line.slice(0, 80) }); }
  }
  return out;
}
function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}

function list() { return readJsonl(F()); }
function get(id) { return list().find((s) => s.id === id) || null; }
function archives(id) { return readJsonl(A()).filter((s) => !id || s.id === id); }

/**
 * 新建/更新策略。
 * @param {object} input {id?,name,type,source,outputLine,note?,status?,scanLevel?}
 *   scanLevel === 'high'（含未来函数）时拒绝保存，UI 也应提前禁用按钮。
 */
function save(input) {
  return serialize(() => {
    const b = input || {};
    if (!b.name || !b.source || !b.outputLine) {
      throw new Error('策略名、公式源码、outputLine 都必填（outputLine 不许自动猜）');
    }
    if (b.scanLevel === 'high') throw new Error('含未来函数，禁止保存');
    if (b.type && !['formula', 'python'].includes(b.type)) throw new Error(`未知策略类型：${b.type}`);
    const rows = list();
    const id = b.id || `st_${Date.now().toString(36)}`;
    const idx = rows.findIndex((s) => s.id === id);
    const prev = idx >= 0 ? rows[idx] : null;
    const next = {
      schema: 1, id,
      name: String(b.name).slice(0, 80),
      type: b.type || (prev && prev.type) || 'formula',
      version: prev ? prev.version + 1 : 1,
      createdAt: (prev && prev.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: String(b.source),
      params: b.params || (prev && prev.params) || {},
      outputLine: String(b.outputLine),
      status: b.status || (prev && prev.status) || 'draft',
      note: b.note === undefined ? (prev && prev.note) || '' : String(b.note),
    };
    if (!STATUSES.includes(next.status)) throw new Error(`未知状态：${next.status}`);
    if (prev) {
      const arc = readJsonl(A());
      arc.push(Object.assign({}, prev, { archivedAt: new Date().toISOString() }));
      writeJsonl(A(), arc);
      rows[idx] = next;
    } else {
      rows.push(next);
    }
    writeJsonl(F(), rows);
    log.info('strategy.saved', { id, version: next.version, status: next.status });
    return next;
  });
}

function setStatus(id, status) {
  return serialize(() => {
    if (!STATUSES.includes(status)) throw new Error(`未知状态：${status}`);
    const rows = list();
    const s = rows.find((x) => x.id === id);
    if (!s) throw new Error(`策略不存在：${id}`);
    s.status = status;
    s.updatedAt = new Date().toISOString();
    writeJsonl(F(), rows);
    log.info('strategy.status', { id, status });
    return s;
  });
}

module.exports = { STATUSES, list, get, archives, save, setStatus };
