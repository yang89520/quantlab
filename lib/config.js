'use strict';
/**
 * 配置加载：config.json（默认值，进版本库）+ config.local.json（本机覆盖，不进版本库）
 *
 * 规则（docs/dev/01-architecture.md §5）：
 *  - 读不到 config.json 直接抛错，不许默默用默认值跑
 *  - 阈值一律从这里取，代码里不许出现裸数字
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'config.json');
const LOCAL = path.join(ROOT, 'config.local.json');

function deepMerge(a, b) {
  if (b === null || b === undefined) return a;
  if (Array.isArray(a) || typeof a !== 'object') return b;
  if (typeof b !== 'object') return b;
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

function load() {
  if (!fs.existsSync(BASE)) {
    throw new Error(`配置缺失：${BASE}。请先创建 config.json（见 docs/dev/01-architecture.md §5）`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  } catch (e) {
    throw new Error(`config.json 解析失败：${e.message}`);
  }

  if (fs.existsSync(LOCAL)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(LOCAL, 'utf8')));
    } catch (e) {
      throw new Error(`config.local.json 解析失败：${e.message}`);
    }
  }

  // 必备键校验：缺了就在启动时炸，不要等到运行时 undefined
  const required = ['storage.engine', 'storage.ownDb', 'predict.verdict', 'integrity.minSnapshotCount', 'judgment.minSampleDays'];
  for (const key of required) {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg);
    if (v === undefined || v === null) throw new Error(`配置缺项：${key}`);
  }
  return cfg;
}

const config = load();

/** 项目根目录绝对路径 */
config.__root = ROOT;
/** 把配置里的相对路径解析成绝对路径 */
config.abs = function abs(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
};

module.exports = config;
