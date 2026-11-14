'use strict';
/**
 * 判断力报告（人读）
 * 用法：node tools/pred-report.js --days 20
 */
const { stats, report } = require('../lib/judgment');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  return process.argv[i + 1] || def;
}

async function main() {
  const days = Number(arg('days', 20));
  const to = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const toStr = `${to.getFullYear()}-${p(to.getMonth() + 1)}-${p(to.getDate())}`;
  const from = new Date(to.getTime() - days * 86400000);
  const fromStr = `${from.getFullYear()}-${p(from.getMonth() + 1)}-${p(from.getDate())}`;

  const s = await stats({ from: fromStr, to: toStr });
  console.log(report(s));
}

main().catch((e) => {
  console.error('报告生成失败：' + e.message);
  process.exitCode = 1;
});
