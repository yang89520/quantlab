# 从零跑起 QuantLab

按顺序做完 §1~§7 就能跑起来，全程不需要看别的文档。

> **v2.0（已合并 yang89520/quantlab）**
> 上游那版是在我方 v1.1 基础上加了五道闸、TDX 公式引擎、观察池五态机、
> 今日一页七格、选股器分段、板块详情等 12 项能力；我方保留了威科夫 v2（41 流派）、
> 手机端布局、2500 根日线、形态缓存扫描。合并方式是「以对方铺底、反向移植我方」，
> 共 8 个独立提交，可逐条 `git revert`。回滚点见 §9。

---

## 1. 环境

| 需要 | 版本 | 怎么查 |
|---|---|---|
| Node.js | ≥ 18（20 LTS 更稳） | `node -v` |
| Python | ≥ 3.9 | `python3 -V` |
| numpy | ≥ 2.0 | `python3 -c "import numpy;print(numpy.__version__)"` |

`brew install node python3` 可一次装齐（Python 自带 pip 与 venv）。

## 2. 一键准备

```bash
cd quantlab
bash tools/setup.sh
```

它会：装 Node 依赖 → 建 `py/.venv` → 建 `data/` 子目录 → 跑 Python 自检。
重复执行无副作用。

**手动版**（想逐步控制时）：

```bash
npm install                                        # express + @duckdb/node-api
python3 -m venv --system-site-packages py/.venv    # 复用系统 numpy
py/.venv/bin/python -c "import numpy" || py/.venv/bin/pip install -r py/requirements.txt
mkdir -p data/cache logs
```

## 3. 起服务

```bash
npm start                 # → http://localhost:3000
PORT=3100 npm start       # 端口被占时
```

打开 <http://localhost:3000>。改 `public/` 下的前端存盘刷新即可，改 `server.js` / `lib/` 要重启。

## 4. 跑一次收盘编排（**首次必做**）

```bash
npm run daily
```

没有这一步，四个新页面会是空的 —— 它们读的是 `data/ql.duckdb` 里由收盘编排写入的数据：

| 产物 | 落在哪 | 谁在用它 |
|---|---|---|
| 预判卡（明日环境判断 + 候选） | `prediction` 表 | `/today` ① ② ④ |
| 全市场快照（5579 只） | `snapshot` 表 | 宽度、涨停数、对账 |
| 板块强度榜（221 个板块） | `sector_strength` 表 | `/today` ③、`/sector/:code` |
| 观察池迁移 | `watchpool` 表 | `/watch` |
| 信号回填 | `signal_track` 表 | `/lab` 信号 tab |

首次约 2~3 分钟（要拉 3700+ 只个股日线算板块），之后同一天再跑命中缓存约 20 秒。

**想补齐对账闭环**（让「判断力画像」有数据、① ② 出现「昨日→今日」对比）：

```bash
node tools/daily-close.js --backfill 15
```

回补 15 个交易日，用现有日线缓存合成历史快照（`derived` 标记 + 覆盖率说明），
再逐日跑预判与对账。约 3~5 分钟。

## 5. 五个页面

| 入口 | 用途 |
|---|---|
| `/` | 分析台：41 个流派 K 线 + 解读卡 + 综合评分 |
| `/screen` | 选股器：全池扫描（形态 + 威科夫结构）、按流派精算 |
| `/today` | 今日一页：①②…⑦ 七格，环境 / 对账 / 主线 / 候选 / 风险 / 明日 |
| `/watch` | 观察池：五态状态机（观察→埋伏→确认→持有→移除） |
| `/lab` | 策略实验室：TDX 公式、真回测（日/周/月）、五道闸、信号跟踪、**公式选股** |

手机上的图表手势（对齐通达信）：

| 手势 | 动作 |
|---|---|
| 单指左右拖 | 平移 K 线，松手有惯性，拖到头有阻尼回弹；一开始拖就把十字线收起 |
| 单指上下滑 | 滚动页面（图表不抢这个手势） |
| 双指捏合 / 张开 | 缩放，两指中点下的那根 K 线保持不动 |
| 长按 220ms | 出十字光标，之后手指往哪走线往哪走，K 线不动、页面不滚 |
| 抬手 | 光标保留（通达信的做法） |
| **双击（已有光标）** | **收起光标与 OHLC 读数，K 线停在原处不动** |
| 双击（无光标） | 回到最新一根 |
| 点坐标轴 / 图外 | 收起光标 |

### 用「选股」页按公式扫全市场

1. `/lab` → 「选股」页，公式已预填「月线三重底」（`node tools/seed-strategy.js` 也会把它写进策略列表）；
2. 输出线 `XG`，周期「月线」，扫描范围选 **1200 只以上**；
3. 首次全市场约 15~20 分钟（逐只拉月线），**同一天再跑走 `data/cache/month-<日期>.json`，秒级**；
4. 结果看三块：拥挤度判读、按月份分布、命中明细。

判读口径是**命中率**而不是命中只数（扫 400 只和扫 5000 只能差十倍）：

| 当月命中率 | 判读 | 历史 12 个月中位 | 胜率 |
|---|---|---:|---:|
| < 0.5% 或 ≤2 只 | 个股级 | +8.8% | 57.1% |
| < 2% | 零散 | +2.1% | 56.5% |
| 2% ~ 8% | 扩散 | +12.6% | 69.7% |
| **≥ 8%** | **市场级** | **+25.4%** | **87.6%** |

一句话：**单只命中大概率是价值陷阱，一堆票同时命中才是底部。** 完整研究（含参数敏感性、六个坑、复现步骤）见 `docs/月线三重底-研究.md`。

## 6. 可选：接上游行情库

装一个 38GB 的历史行情库（DuckDB 格式，表 `kline_daily`）能让板块强度更准、回补更快，
**但不是必须的**：

```bash
# config.local.json（不进版本库）
echo '{"localDb":{"marketDb":"/绝对路径/market.db"}}' > config.local.json
```

没有它时系统会自己降级，并在数据来源里标清楚：

- 板块强度改用**网络日线合成**，每条记录带 `degraded: true` 与原因
- 历史回补改用**日线缓存合成**，快照带 `derived: true`，覆盖率约 67%
- 当日快照仍走实时抓取（5579 只，完整）

## 7. 目录分工

```
server.js              Express 入口，60+ 路由（行情 / 选股 / 预判 / 板块 / 观察池 / 实验室）
lib/
  quote.js             代码规范化、快照、全市场列表、搜索
  sources.js           老的多源行情适配（同花顺 → 新浪 → 腾讯 → 东财）
  sources/index.js     新数据源注册表 + 健康度熔断 + 节流
  sources/adapters/    各源实现（local-db / sina / em / aggregate / sina-sector）
  sources/member-klines.js  成分股日线批量取数 + 按日缓存（无上游库时的回退）
  datasource.js        统一取数入口，返回必带 source/level/asOf/stale/degraded
  snapshot.js          全市场快照：实时抓取 / 本地合成 / 缓存合成
  predict.js           一期环境判断（趋势 + 宽度 + 量能 → attack/defend）
  reconcile.js         预判对账（次日实际走势 → 命中/未命中）
  judgment.js          判断力画像（命中率分组归因）
  sector.js            板块四因子评分
  sectordata.js        板块数据编排（列表 → 成分 → 日线 → 聚合 → 落库）
  watchpool.js         观察池五态状态机
  lab.js / strategy.js / gates.js / track.js / pyrunner.js   三期策略实验室
  formula-screen.js                                          全市场公式选股（月/周线）
  dao/                 存储层（DuckDB 主 / JSONL 兜底）
  config.js / log.js / cache.js
public/js/
  strategies.js        41 个流派插件
  shape.js             形态 + 威科夫 v2 结构（前后端共用，扫描与精算必须同源）
  engine.js            Canvas 图表引擎（桌面/手机双版式）
  app.js               分析台（含入观察池）
  screen.js            选股器
  today.js / watch.js / lab.js / sector.js   四个新页面
  watchlist.js         自选股侧栏
tools/
  daily-close.js       收盘编排（单日 / --date / --backfill N）
  wy-scan.js           命令行批量威科夫扫描（支持 --phase 过滤与 CSV）
  gate-run.js          五道闸同步执行
  smoke.js / install-schedule.sh / archive.js
  backtest*.py / verify-tdx.py   独立回测与通达信对账
py/tdx_engine/         TDX 公式引擎（解析 → 执行 → 未来函数检测）
tests/                 单元 / 集成 / 变异 / 验收（65 条）
```

## 8. 测试

```bash
npm test                 # 26 项冒烟（含离线模式 --offline）
npm run test:unit        # 单元 + 集成 + Python 自检
npm run acceptance       # 65 条全量验收（需服务在跑）
npm run test:mutate      # 变异测试（20 条必须全红，验证测试真的有效）
```

## 9. 改坏了怎么退

```bash
git log --oneline                 # 看历史
git diff                          # 看当前改动
git checkout -- public/js/app.js  # 撤单个文件
git reset --hard v2.0-merged      # 退回合并不动上游能力的这一版（当前成果）
git reset --hard v1.1-41strategy  # 退回合并前的稳定版
git reset --hard pre-merge-backup # 退回合并前的最后一次提交
```

合并过程分了 8 个独立提交（铺底 → 威科夫 → UI → 阻断缺陷 → 回补链路 → 横屏溢出 → 版本），
每一条都能单独 `git revert`，不用整段回退。动手前先 `git commit -am "改之前"`，出问题就有精确落点。

## 10. 数据源

全部普通 HTTPS，带自定义 UA/Referer，macOS 直连即可：

| 用途 | 源 |
|---|---|
| 个股/指数日线 | 同花顺 `d.10jqka.com.cn` → 新浪 `quotes.sina.cn` → 腾讯 |
| 实时快照 | 新浪 `hq.sinajs.cn`（批量 800 只/次） |
| 板块列表/成分 | 新浪行业 `new_*`、概念 `gn_*`；东财 `BK****` 作增强 |
| 资金净流入 | 东财 `push2.eastmoney.com`（f62 字段，可选） |

取不到数据时先看 <http://localhost:3000/api/health>：每个能力分组都列了
当前激活源、成功/失败次数、熔断状态与最后错误。公司网络带代理时给 Node 设 `HTTPS_PROXY`。

## 11. 回测（独立于 Web，直接 python3 跑）

```bash
python3 tools/backtest-threelock.py --n 300    # 三把锁，约 20 分钟
python3 tools/backtest-tritf.py                # 三周期共振
python3 tools/backtest.py                      # SuperTrend / 三灯
python3 tools/verify-tdx.py                    # 与通达信独立通道对账（需 tdxrs）
```

首次跑会拉全量日线并缓存到 `/tmp`，第二次起秒级。`--probe` 只统计信号频次，不算收益。

## 12. 和线上那个链接的关系

线上地址是**沙箱快照**，读沙箱里的文件，不读你 Mac 上的文件。本地改完线上不会自动变。

- 自己用 → 本地 `localhost:3000` 就够，数据同样实时
- 给别人看 → 重新发布，或临时隧道：`npx localtunnel --port 3000`
