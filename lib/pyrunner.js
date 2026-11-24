'use strict';
/**
 * Node → Python 公式引擎封装（docs/dev/05 §5）。
 * 子进程 + stdin/stdout 单行 JSON，不起 HTTP 服务；每次 spawn 独立进程，不复用。
 *
 * 五条硬规矩：
 *  1. 超时强杀 SIGKILL（生产 120s，测试可传 3s）
 *  2. stderr 全量捕获写日志（traceback 是排查唯一线索）
 *  3. stdout 只取最后一行（防止 Python 里的 print 污染协议）
 *  4. 大 payload 走 stdin，不走命令行参数
 *  5. 同时检查 ok 字段与退出码，不许只看其中一个
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const log = require('./log');

/**
 * @param {string} [script] 引擎脚本名，默认 runner.py。
 *   screen.py 是批量选股执行器（一次多吃），协议与 runner 完全一致，
 *   只是入口不同 —— 不复用一份实现，因为两者对「一批还是一个」的语义本就不同。
 */
function paths(script) {
  return {
    py: path.join(config.__root, 'py', '.venv', 'bin', 'python'),
    runner: path.join(config.__root, 'py', 'tdx_engine', script || 'runner.py'),
  };
}

function available() {
  const p = paths();
  return fs.existsSync(p.py) && fs.existsSync(p.runner);
}

/** 探测 numpy，供 /api/health 与自动降级（05 §2.3） */
function probePython() {
  return new Promise((resolve) => {
    const { py } = paths();
    if (!fs.existsSync(py)) return resolve({ available: false, reason: 'py/.venv 不存在' });
    const child = spawn(py, ['-c', 'import numpy; print(numpy.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ available: false, reason: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ available: true, numpy: out.trim().split('\n').pop() });
      else resolve({ available: false, reason: (err.trim().split('\n')[0] || `exit ${code}`).slice(0, 200) });
    });
  });
}

/** stdout 只取最后一行解析：Python 里的 print 不许污染协议 */
function parseLastJson(out) {
  const lines = String(out || '').split('\n').filter((s) => s.trim());
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  try { return JSON.parse(last); }
  catch (e) { return null; }
}

/**
 * @param {object} payload 单行 JSON 请求
 * @param {{timeout?:number}} opt
 * @returns {Promise<object>} 成功为 runner 响应；失败恒为 {ok:false,error,kind,detail}
 */
function callPython(payload, opt) {
  const o = opt || {};
  const timeout = Number(o.timeout) || config.gates.pythonTimeoutMs;
  const p = paths(o.script);
  if (!available()) {
    return Promise.resolve({ ok: false, error: 'Python 计算环境不可用', kind: 'internal', detail: p });
  }
  return new Promise((resolve) => {
    const child = spawn(p.py, [p.runner], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, error: 'timeout', kind: 'internal', detail: { timeout } });
    }, timeout);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, error: e.message, kind: 'internal' }));
    child.on('close', (code) => {
      if (err.trim()) log.error('pyrunner.stderr', { stderr: err.trim().slice(0, 4000) });
      // stdout 只取最后一行
      const lines = out.split('\n').filter((s) => s.trim());
      const last = lines.length ? lines[lines.length - 1] : null;
      const parsed = parseLastJson(out);
      if (!parsed) {
        return done({
          ok: false, error: 'Python 输出不是合法 JSON（或 stdout 被污染）',
          kind: 'internal', detail: { exitCode: code, lastLine: last ? last.slice(0, 200) : null },
        });
      }
      if (code !== 0 || parsed.ok !== true) {
        return done({
          ok: false,
          error: parsed.error || `Python 退出码 ${code}`,
          kind: parsed.kind || 'internal',
          detail: parsed.detail || null,
        });
      }
      done(parsed);
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (e) {
      child.kill('SIGKILL');
      done({ ok: false, error: e.message, kind: 'internal' });
    }
  });
}

module.exports = { callPython, probePython, available, parseLastJson, paths };
