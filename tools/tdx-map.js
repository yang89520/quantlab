'use strict';
/**
 * 生成「本项目板块 → 通达信板块指数(880xxx)」映射表。
 *
 * 为什么需要它：我们的板块体系来自新浪（new_jrhy / gn_hwqc），通达信是 880xxx。
 * 只有映射上，才能用板块指数日线替代「聚合 3761 只成分股」——那是云端能否跑通的
 * 全部分量所在。
 *
 * **只允许高置信规则，宁可少配不可错配**：
 *   1) 名称完全相同
 *   2) 去掉通用后缀后完全相同（玻璃行业 → 玻璃）
 * 明确**不做**模糊/包含匹配。实测用最长公共子串打分时，出现
 * 「锂电池 → 钠电池(0.53)」「固废处理 → 医废处理(0.59)」这种错配——
 * 两个完全不同的板块被并成一个，比没配上危险得多：它会静默给出错误的主线。
 *
 * 用法：node tools/tdx-map.js [--dry]
 * 产出：data/sectors/tdx-map.json  { "<我们的code>": {tdxCode,tdxName,how} }
 *       data/sectors/tdx-unmapped.json  未匹配清单（供人工复核，不参与计算）
 */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const log = require('../lib/log');
const tdx = require('../lib/sources/adapters/tdx');

const SUFFIX = /(行业|板块|概念|指数|产业|主题|类)$/;
const norm = (s) => String(s).replace(SUFFIX, '').trim();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const t0 = Date.now();

  const dictPath = config.abs('data/sectors/dict.json');
  if (!fs.existsSync(dictPath)) {
    console.error('板块字典不存在：' + dictPath + '\n请先跑一次 daily-close 或 sectordata 采集。');
    process.exitCode = 1;
    return;
  }
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const ours = dict.sectors || [];

  if (!(await tdx.available(true))) {
    console.error('通达信网关不可用：' + tdx.base() + '\n请先启动：cd tdx-gateway && ./bin/tdx-gateway -port 7710');
    process.exitCode = 1;
    return;
  }

  console.log('拉取通达信板块（约 17 秒）…');
  const b = await tdx.blocks();
  // 只取行业(2)与概念(4)：地域(3)和特色(5)不是本项目的板块维度
  const pool = (b.indexMap || []).filter((x) => x.type === 2 || x.type === 4);
  const byName = new Map(pool.map((x) => [x.name, x]));
  const byNorm = new Map();
  for (const x of pool) {
    const k = norm(x.name);
    if (!byNorm.has(k)) byNorm.set(k, x);   // 同名冲突取先出现的，与 A 股板块命名惯例一致
  }
  console.log(`通达信候选：${pool.length} 个（行业+概念），网关耗时 ${b.ms}ms`);

  const map = {};
  const unmapped = [];
  const stats = { exact: 0, normed: 0 };

  for (const s of ours) {
    const code = String(s.code);
    const name = String(s.name || '');
    let hit = byName.get(name);
    let how = 'exact';
    if (!hit) {
      hit = byNorm.get(norm(name));
      how = 'normed';
    }
    // 板块指数必须是 880xxx；没有指数代码的板块指数拿不到 K 线，等同于没配上
    if (hit && /^8\d{5}$/.test(String(hit.code || ''))) {
      map[code] = { tdxCode: String(hit.code), tdxName: String(hit.name), how };
      stats[how]++;
    } else {
      unmapped.push({
        code, name, type: s.type,
        reason: hit ? '通达信侧无指数代码' : '名称对不上（不做模糊匹配）',
        tdxName: hit ? hit.name : null,
      });
    }
  }

  const total = ours.length;
  const n = Object.keys(map).length;
  console.log('');
  console.log(`匹配 ${n}/${total}（${Math.round(n / total * 100)}%）｜精确 ${stats.exact} · 去后缀 ${stats.normed}`);
  console.log(`未匹配 ${unmapped.length} 个 —— 这些板块在本机仍可走成分聚合，云端会明确显示缺失`);

  if (dry) {
    console.log('\n--dry：不落盘');
  } else {
    const mapPath = config.abs('data/sectors/tdx-map.json');
    const unPath = config.abs('data/sectors/tdx-unmapped.json');
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      gateway: tdx.base(),
      total, matched: n, stats,
      map,
    }, null, 1));
    fs.writeFileSync(unPath, JSON.stringify(unmapped, null, 1));
    console.log('\n已写入：');
    console.log('  ' + mapPath);
    console.log('  ' + unPath);
  }
  log.info('tdx.map_built', { total, matched: n, unmapped: unmapped.length, ms: Date.now() - t0 });
}

main().catch((e) => {
  console.error('生成失败：' + e.message);
  log.error('tdx.map_failed', { error: e.message });
  process.exitCode = 1;
});
