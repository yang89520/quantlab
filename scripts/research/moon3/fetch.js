const fs = require('fs');
const path = require('path');
const Q = require('../../../lib/quote');
// 缓存落在脚本旁边的 .cache/，已加进 .gitignore（几十万根 K 线不该进版本库）
const OUT = path.join(__dirname, '.cache', 'month-cache.json');
const TARGET = Number(process.argv[2] || 400);
const CONC = 6;

function load() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return { savedAt: null, data: {} }; }
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const cache = load();
  const list = await Q.marketList();
  // 只取 A 股个股（排除指数、北交所），按代码均匀抽样，避免全挤在 600xxx
  const pool = list.filter((x) => /^(sh6|sz0|sz3)/.test(x.symbol));
  const step = Math.max(1, Math.floor(pool.length / TARGET));
  const picked = pool.filter((_, i) => i % step === 0).slice(0, TARGET);
  console.log('pool', pool.length, 'picked', picked.length, 'cached', Object.keys(cache.data).length);

  const todo = picked.filter((x) => !cache.data[x.symbol]);
  console.log('todo', todo.length);
  let done = 0, fail = 0;
  const t0 = Date.now();

  async function worker() {
    while (todo.length) {
      const it = todo.shift();
      try {
        const r = await Q.klines(it.symbol, 130, 'month');
        cache.data[it.symbol] = { name: r.name, rows: r.rows };
        done++;
      } catch (e) {
        fail++;
      }
      const n = done + fail;
      if (n % 40 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log(`  ${n}/${done + todo.length + fail} ok=${done} fail=${fail} ${el.toFixed(0)}s eta=${(el / n * todo.length).toFixed(0)}s`);
        cache.savedAt = new Date().toISOString();
        fs.writeFileSync(OUT, JSON.stringify(cache));
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  cache.savedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log(`done ok=${done} fail=${fail} total=${((Date.now() - t0) / 1000).toFixed(0)}s`);
})();
