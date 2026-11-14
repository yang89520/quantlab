'use strict';
/**
 * 统一日志：JSONL 追加到 logs/YYYY-MM-DD.log，同时输出到 stdout。
 *
 * 关键约束（docs/dev/01-architecture.md §6.1）：
 *  - 每次任务必须记录 start / end / 耗时
 *  - 完整性降级、每个失败原因必须落日志
 *  - 禁止 console.error 之后正常退出（退出码由调用方设置）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function write(level, event, fields) {
  const rec = Object.assign({ ts: new Date().toISOString(), level, event }, fields || {});
  const line = JSON.stringify(rec);
  // stdout 给人看
  const tag = level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
  process.stdout.write(`${tag} ${event}${fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''}\n`);
  // 文件给机器看
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${today()}.log`), line + '\n');
  } catch (e) {
    // 日志写不进去不能影响主流程，但必须让调用方能感知
    process.stderr.write(`日志写入失败：${e.message}\n`);
  }
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  LOG_DIR,
};
