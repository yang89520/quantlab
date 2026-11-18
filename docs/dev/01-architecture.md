# 01 · 架构与技术决策

> 本文回答"为什么这么选"。所有决策都写了被否决的方案与理由，避免后人推翻重来。

---

## 1. 系统全景

```
┌─────────────────────────────────────────────────────────┐
│  浏览器                                                   │
│  今日一页 · 观察池 · 策略实验室 · 原有分析台/选股器（下钻）    │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP
┌───────────────────────▼─────────────────────────────────┐
│  Node.js / Express  :3000                                │
│  server.js（路由）                                        │
│  ├─ 原有：/api/stock  /api/watchlist  /api/screen/*       │
│  ├─ 一期：/api/predict/*  /api/judgment/*                 │
│  ├─ 二期：/api/sector/*   /api/watchpool/*                │
│  └─ 三期：/api/lab/*    ──→ 子进程调用 py/runner.py        │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  数据层                                                    │
│                                                          │
│  上游（只读，有独立更新引擎）                                │
│    market.db  38.5GB DuckDB · 日/月/分钟 K 线 · 每日盘后更新 │
│                                                          │
│  本项目自有（可读写）                                       │
│    data/ql.duckdb       快照/预判/对账/板块/信号（cron 写）   │
│    data/*.jsonl         观察池/迁移日志/策略定义（Web 写）    │
└─────────────────────────────────────────────────────────┘

旁路（只读，不参与运行）
  tdx-backtest/  ← 代码来源（人工复制）+ 当前的上游行情库提供方
```

> **两个"库"必须分清**：`market.db` 是上游资产，我们只读；`ql.duckdb` 是我们自己的，随便写。
> 两者必须是不同文件，启动时断言。详见 `09-data-access.md` §2。

---

## 2. 语言决策

### 2.1 一期、二期：Node.js

**决策**：**业务逻辑**全部用 JavaScript，不引入 Python。

**理由**：

1. 一、二期的算法是**横截面统计**——占比、分位、线性映射、分档。纯算术，不需要 numpy 的向量化优势
2. 现项目已有完整的行情数据链路（`lib/sources.js` 三源降级 + 缓存 + 并发闸门），复用即可
3. 本机 **python3 既无 numpy 也无 pandas**（有 `.venv-axdata` 但属另一个项目），引 Python 就要先解决环境，且交接给任何一台机器都要重来
4. 不新增进程 → 不新增部署、日志、监控面

> **一个例外（不是业务逻辑，是基础设施）**：若 Node 的 DuckDB 原生模块装不上，
> 读上游库会退到「建 `py/.venv` + 子进程查询」（`09` §8.7 方案 B）。
> 那是**被迫的取数通道**，不是把业务逻辑搬到 Python——退到方案 C 时连它也不需要。
> 判断标准：**Python 里不许出现任何业务规则**（评分、归因、状态机都不许）。

**被否决的方案**：一期直接用 Python 复用 tdx-backtest 的 `sectors.py` / `stockscore.py`。
否决理由：这两个文件虽是纯 stdlib，但都 `from . import universe`，剥依赖的成本 > 用 JS 重写（它们的核心逻辑各不到 100 行）。

### 2.2 三期：引入 Python，但只做策略引擎

**决策**：新建 `py/` 目录，独立 venv，只承载公式解析与回测。

**理由**：

1. `functions.py` / `signals.py` / `backtest.py` 依赖 numpy（`backtest.py` 还要 pandas），JS 重写这些是纯浪费——它们是已验证过的成熟实现
2. Python 侧只做**纯计算**，不碰网络、不碰文件存储，边界干净
3. 与 Node 通过 **stdin/stdout JSON** 通信，不引入 HTTP 服务、不引入消息队列

**被否决的方案**：Python 起 FastAPI 独立服务。
否决理由：为一个每天跑几次的批处理任务多开一个常驻进程，运维成本不成比例。子进程调用的不足（冷启动 ~200ms）在批处理场景完全可接受。

### 2.3 三期 Python 的目录隔离

```
py/
├── .venv/                 # 不进版本库
├── requirements.txt       # numpy>=2.0, pandas>=2.0（不装 fastapi/baostock/pytdx 等一堆）
├── tdx_engine/            # 从 tdx-backtest 复制的模块（复制≠修改）
│   ├── parser.py          # 原样复制，零依赖
│   ├── functions.py       # 原样复制 + 扩函数
│   ├── signals.py         # 原样复制
│   ├── future_scan.py     # 原样复制 + 补漏检
│   └── backtest.py        # 复制后剥离 pandas 依赖（见 05 文档 §4）
└── runner.py              # 协议入口
```

**关键约束**：`tdx_engine/` 里的文件复制过来后就是**本项目的文件**，可以改。但必须：
- 文件头加注释注明「来源：tdx-backtest/tdxback/xxx.py @ <commit>，复制日期，本文件已独立维护」
- 在原项目对应文件上方**不做任何修改**（G1）
- 复制时记录原 commit，便于将来对照上游修复

---

## 3. 存储架构

> **完整规则见 `09-data-access.md` §2 与 §7。本节只讲为什么这么分。**

### 3.1 三份存储，三种角色

| 存储 | 归属 | 读写 |
|---|---|---|
| `<上游>/market.db`（38.5GB） | **别人的**，有独立更新引擎每日更新 | **只读** |
| `data/ql.duckdb` | 本项目自有 | 读 + 写 |
| `data/*.jsonl` | 本项目自有 | 读 + 写 |

**铁律：绝不写上游库**。上游有自己的更新引擎，我们写一行就可能破坏它，而对方无从察觉。（`09` §2.2 给了三重代码层保证）

### 3.2 为什么自有数据分 DuckDB 与 JSONL 两处

不是为了"技术多样"，而是为了解决一个硬约束：**DuckDB 单文件只允许一个写进程**。

本项目有两个进程会写数据：

- `daily-close.js`（cron，每日一次）
- Web 服务（用户随时点观察池、改策略）

两者都写同一个 `.duckdb` 必然 `Conflicting lock`。所以**按写入方划分存储**：

| 写入方 | 数据 | 存储 | 理由 |
|---|---|---|---|
| cron 独写 | 快照 / 预判卡 / 对账 / 板块成分与强度 / 策略信号与验证 | **DuckDB** | 写入密集、量大（快照 133 万行/年）、需要 SQL 聚合与跨日对比 |
| Web 可写 | 观察池 / 迁移日志 / 策略定义 | **JSONL** | 量小（约 200 条）、要能手工改、要能 `git diff` |

**划分依据是写入方，不是数据类型**——这样两个进程各写各的文件，锁冲突从架构上消失。

### 3.3 统一 DAO，业务代码不感知后端

`lib/dao/index.js` 对上层提供一致的方法签名，底层可切 DuckDB 或 JSONL：

```js
const store = await open('snapshot');   // 后端由 config.storage.engine 决定
store.upsert(rows, ['date', 'market', 'code']);
store.query({ where: { date }, order: 'code', limit: 100 });
```

`config.storage.engine`：

| 值 | 行为 |
|---|---|
| `duckdb` | 全走 DuckDB（不可用时启动失败，不静默降级） |
| `jsonl` | 全走 JSONL（强制降级，用于原生模块装不上时） |
| `auto`（默认） | 能开就用，否则自动降级并 `log.warn` |

**一期验收要求**：`engine=jsonl` 下全部功能可跑通。这样即使 DuckDB 原生模块装不上，一期照样能交付。

### 3.4 为什么不让所有数据都进 JSONL

一期原本打算全用 JSONL（年度 500KB 足够）。改为 DuckDB 主存储的理由：

1. **快照是长表**：5342 只 × 250 天 = 133 万行/年。JSONL 要算"每日宽度"得全量读入再遍历；DuckDB 一条 `GROUP BY date` 就够
2. **对账要跨日聚合**：命中率、分状态、错因分布都是 SQL 天然擅长的事
3. **既然读上游库已经要 DuckDB 客户端了，写自有库的边际成本几乎为零**

但 JSONL 仍然保留为**强制可用的兜底后端**——原生模块装不上时不能把整个项目卡死。

### 3.5 为什么不用 SQLite

Node 22 的 `node:sqlite` 仍是实验特性（需 `--experimental-sqlite`），`better-sqlite3` 需本地编译。
既然为了读上游库已经要引入 DuckDB，再引入第二个数据库引擎没有理由。

---

## 4. 进程模型

| 进程 | 何时跑 | 挂了会怎样 | 处理 |
|---|---|---|---|
| Web 服务 | 常驻 | 页面打不开 | 与现有 `npm start` 一致，不改 |
| 收盘任务 `daily-close.js` | 交易日 16:35 | 当天没预判卡 | cron 每天跑，幂等，可手工补跑 |
| 板块段（二期） | **不独立调度**，串在 `daily-close.js` 内 | 板块数据缺 | 失败只影响 `mainline` 字段，不阻断预判卡生成 |
| 策略闸（三期） | 手动触发 | 无影响 | 手动工具，不调度 |
| 通达信网关 `tdx-gateway` | 常驻（:7710） | 板块指数、个股 K 线、报价退回 ths/sina | 只影响取数质量，不阻断服务；`/api/health` 里 `tdx.available` 可看 |
| Python 子进程（三期） | 被 Node 调起 | 该次计算失败 | 超时 120s 强杀，错误透传 |

**调度用系统 cron，不用常驻调度器。**
理由：tdx-backtest 的 `scheduler.py` 是常驻线程，进程挂了调度就没了，还要额外守护。cron 天然解决"进程不在也能跑"。

```cron
# 每个交易日盘后跑一次（一期上线时启用；二期不新增条目，板块与观察池串在同一脚本内）
35 16 * * 1-5  cd <项目目录> && node tools/daily-close.js >> logs/daily.log 2>&1
```

**安装方式（按优先级）**

| 优先级 | 方式 | 命令 | 说明 |
|---|---|---|---|
| 1 | launchd | `sh tools/install-schedule.sh` | macOS 推荐。睡眠期间错过的任务会在唤醒后补跑，且不需要 Full Disk Access |
| 2 | cron | `sh tools/install-schedule.sh --print` 拿到行后粘进 `crontab -e` | 部分 macOS 机器上 `crontab` 被 TCC 挡成 `operation not permitted`，装不了 |
| 3 | 看门狗（兜底） | `config.json` → `schedule.catchUp.enabled` | 只要 Web 服务在跑，16:35 之后发现当天没有预判卡就补跑一次 `daily-close` |

> **2026-11-16 补**：原稿只写了「用系统 cron」。实际部署时遇到两个环境问题：
> 本机 macOS 的 `crontab` 报 `operation not permitted`（TCC 拦截），
> `launchctl bootstrap` 在受限环境里也报 `Input/output error`。
> 结果是「代码齐了但一天新数据都没有」——预判只有 1 天、对账 0 条，闭环等于没跑。
> 所以补了看门狗兜底：它不是替代调度，而是保证「调度装不上时也不会彻底停摆」。
> 看门狗与 cron 共存安全：当天已有预判卡时直接返回，不会重复执行。

**只有一个 cron 条目**。各段的先后顺序在 `daily-close.js` 内部保证（见 `03` §4 与 `04` §6）：

```
交易日 → 指数K线 → 快照 → 板块强度 → 对账(昨日) → 预判卡(今日) → 观察池推进
      → 策略信号扫描 → 持仓风险留痕 → 信号回填/自动降级 → 摘要
```

> **2026-11-14 修正**：原稿写「快照 → 对账 → 板块强度」，实现时发现顺序必须调整——
> 一期对账的 `direction` 归因要用**当日板块强度**判断「方向是否判错」（`04` §3），
> 板块强度必须在**对账之前**算完。此处以本顺序为准，`04` §6 已同步。

分成多条 cron 会有竞态（前一条没写完，后一条就起来读），所以仍然只有一条。

`--sector` 等参数只用于调试补跑，不作为独立调度项。

### 5.1 历史回补（`--backfill N`）

新机器上线或调度停摆一段时间后，库里只有孤零零一两天数据，对账算不出来、
命中率画像永远空着。这时用回补把闭环补齐：

```bash
node tools/daily-close.js --backfill 20      # 最近 20 个交易日，按日期升序
```

三条关键约束（都已落进代码，不是靠人记）：

| 约束 | 做法 | 为什么 |
|---|---|---|
| 快照必须合成，不能抓实时 | `snapshot.captureFromLocal(date)` 从上游日线算 `chg_pct`/`amplitude` | 网络快照只有「此刻」。用 `capture(历史日)` 会把今天的行情标成历史日（D3），所以 `capture()` 现在对历史日**直接拒绝** |
| 不许看到未来 | `readMemberKlines(codes, bars, until=date)`，指数 K 线 `resolve({date})` | 少传一个 `until`，板块榜和信号就会用上目标日之后的 K 线，回测结果漂亮但全是假的 |
| 升序跑、同进程循环 | 单进程内按日循环，板块字典与成分股复用 | 成分股要打 221 次接口，20 天各起一个进程会被限流；实测已出现 `timeout`。改成字典读盘 + 成分读库，整轮 0 次网络请求 |

> 回补出来的快照在 `integrity.provenance.snapshot.derived` 上标 `true`，
> 与当场抓的快照可区分（`turnover` / `float_cap` 为 `null`，见 `08` TD7）。

非交易日自动跳过（快照 `lastBarDate` 与当日不符即跳过），不需要维护节假日表。

---

## 5. 配置管理

`config.json`（进版本库，作为默认值）+ `config.local.json`（不进版本库，本机覆盖）。

```jsonc
{
  "schema": 1,

  // ---- 存储（见 09 §7）----
  "storage": {
    "engine": "auto",              // duckdb | jsonl | auto
    "ownDb": "data/ql.duckdb"      // 本项目自有库；必须与 localDb.marketDb 不同
  },
  "localDb": {
    "enabled": true,
    "marketDb": ""                 // 上游行情库路径（只读）。写在 config.local.json，勿提交
  },

  // ---- 一期：环境判定 ----
  "predict": {
    "weights": { "trend": 40, "breadth": 30, "vol": 30 },
    "verdict": { "attack": 65, "defend": 35 },
    "candidateCount": 5,
    "historyDays": 250
  },
  "integrity": {
    "minSnapshotCount": 4000,
    "minBars": 120
  },
  "judgment": {
    "minSampleDays": 10,
    "minStateSample": 5
  },

  // ---- 二期：板块与观察池 ----
  "sector": {
    "minMomentum": 80,             // A/B 档：动量分位门槛
    "minFunds": 70,                // A 档：资金分位门槛
    "dropMomentum": 40,            // D 档：动量分位上限
    "minSectors": 10               // 少于该数量不评分（分位无意义）
  },
  "watchpool": {
    "maxStay": { "watching": 10, "ambush": 15, "confirmed": 5 },
    "maxSize": 30,
    "minScore": 70,
    "bandLow": 0.98, "bandHigh": 1.03, "shrink": 0.8,
    "breakoutVol": 1.5, "holdTol": 0.97, "confirmWindow": 3
  },

  // ---- 三期：五道闸 ----
  "gates": {
    "maxDecay": 0.5,               // 第 2 道：样本内外收益衰减上限
    "minUniverse": 30,             // 第 3 道：最少测试标的数
    "minPositiveRatio": 0.5,       // 第 3 道：正收益占比下限
    "minPhaseRet": -0.05,          // 第 4 道：牛/熊/震荡每段收益下限
    "degradeGap": 0.15             // 实盘命中率低于回测超过该值时降级 suspect
  }
}
```

**每条阈值都必须带兄弟键 `_note`**（示例）：

```jsonc
"verdict": {
  "attack": 65,
  "_note_attack": "初始值。依据：2026-11 人工观察 65 分以上多为顺势环境。需累积 20 个交易日对账后校准。"
}
```

**规则**：
- 代码里不许出现裸数字阈值，一律从 config 读
- 每个阈值在 config 里配一条 `_note` 说明「初始值 / 依据 / 何时校准」
- 读不到 config 要**报错退出**，不许默默用默认值跑

---

## 6. 可观测性

### 6.1 日志

统一 `lib/log.js`，输出 JSONL 到 `logs/YYYY-MM-DD.log`：

```js
log.info('predict.done', { date, verdict, score, candidates: 5, ms: 1203 })
log.warn('snapshot.incomplete', { count: 1203, min: 4000 })
log.error('reconcile.failed', { date, err: e.message, stack: e.stack })
```

**必须记录的关键事件**：每次任务的开始/结束/耗时、完整性降级、每个失败原因。

### 6.2 健康检查

`GET /api/health` 返回：

```jsonc
{
  "ok": true,
  "lastSnapshot": "2026-11-13",
  "lastPrediction": "2026-11-13",
  "pendingReconcile": 0,
  "storage": { "engine": "duckdb", "ownDb": true, "marketDb": true },
  "sources": { /* 按资产分组，结构见 10 §4.4 */ },
  "python": { "available": false, "reason": "未安装 numpy" }
}
```

`sources` 不再是一排布尔值，而是**按数据资产分组**（`sector-list-industry`、`kt-pool` 等），
每组给出当前生效源、各源状态与熔断情况——完整结构见 `10-data-source-playbook.md` §4.4。

`pendingReconcile > 0` 意味着有预判没对账，说明调度漏了——这比任何报警都直观。

### 6.3 失败必须非 0 退出

```js
process.exitCode = 1     // 不许 console.error 之后正常退出
```

理由：cron 的失败要靠退出码才能被 `|| echo FAILED` 捕获，退出码 0 的"假成功"是最难发现的故障。

---

## 7. 数据源策略

> **完整规则见 `09-data-access.md`（强制）与 `10-data-source-playbook.md`（实测与具体实施）。**
> 本节只讲架构落点。

### 7.1 三级解析链

所有取数统一走 `lib/datasource.js`，**禁止各模块自己决定从哪取**：

```
① 本项目已落盘（ql.duckdb · data/*.jsonl · data/cache）
        ↓ 未命中
② tdx-backtest 本地库 data/market.db（DuckDB，只读，历史数据 ≤ T-1）
        ↓ 未命中 / 或请求当日
③ 网络接口（新浪 → 腾讯 → 同花顺 / 东财）
        ↓ 全失败
④ 返回 null + missing[]，并标记 level='X'（缺失），**绝不编造**
```

### 7.2 各数据的来源归属

| 数据 | 一期 | 二期 | 首选来源 |
|---|---|---|---|
| 指数日线 | ✅ | ✅ | **本地库**（260 根里 259 根本地，只补当日） |
| 个股日线 | 候选用 | 观察池用 | **本地库** → 网络 |
| 分钟线 | — | — | **仅本地库**（网络源基本拿不到） |
| 周/月线 | — | — | **本地库** `kline_period`（省去自行聚合） |
| 全市场快照 | ✅ | ✅ | **仅网络**（库里没有当日快照） |
| 板块列表/成分 | — | ✅ | **仅网络**（东财，需先验证可用性） |
| 板块 K 线 | — | ✅ | 网络（东财 push2his） |
| 涨停池 | 近似 | 精确 | 一期走快照推导；二期接东财 |

### 7.3 本地库的接入方式

`data/market.db` 实测：**38.5 GB / 17.6M 行 / 5,560 只 / 1990 起**，三表 `kline_daily` `kline_min` `kline_period`。

三条铁律（违反会搞坏对方的写库）：

```js
// 1. 只读
duckdb.connect(DB_PATH, { readOnly: true })

// 2. 短连接：每次查询 open→query→close，绝不持有长连接
//    DuckDB 单文件同时只允许一个写进程；我们持着读连接，
//    tdx-backtest 的盘后入库就永远拿不到写锁。

// 3. 开库失败必须退避重试（写端持锁时打不开是正常并发状态，不是故障）
```

**Node 读 DuckDB 的方案优先级**：`@duckdb/node-api`（首选）→ 自建 `py/.venv` + 子进程（降级）→ 不接本地库只走网络（兜底）。
详见 `09` §8.7。**严禁借用 `tdx-backtest/.venv-axdata`。**

### 7.4 多源降级与熔断（内化自 tdx-backtest）

**已实测的事实**（`10` §1）：东财是「间歇可用」——同一接口 5 分钟内可从 200 变 000；
`push2his` 整个域不可用；新浪板块链路稳定。

**因此我们的策略是**：

| 资产 | 主源 | 兜底 | 说明 |
|---|---|---|---|
| 板块列表 / 成分 | **新浪** | 东财（增强） | 板块主键用新浪体系，东财只补字段 |
| 板块 K 线 | **本地聚合** | — | 上游没有，用 `market.db` 个股日线算 |
| 全市场快照 | **新浪** | 东财 push2delay | 现项目已在用 |
| 涨停池 | 东财 push2ex | 快照阈值推导 | 推导结果标 `derived` |
| 个股 K 线 | **上游 `market.db`** | 同花顺 → 新浪 | 东财不作兜底 |

**三个机制**（全部来自 tdx-backtest 的 `datahealth.py`，按我们的栈重写）：

1. **声明式资产注册表**：`lib/sources/registry.js`，每个资产声明「主源 + 有序兜底链 + 风险等级」
2. **风险分级配速**：`none` 0s / `low` 0s / `med` 0.3s / `high` 0.5s，慢一点反而更稳
3. **熔断 + 冷却**：连续 3 次失败且近 5 次全失败 → `down` → 冷却 20 分钟内**即使探活成功也不恢复**（防抖动）

**健康层只记录不造假**：它不负责"帮你想办法"，只如实报告谁坏了；兜底逻辑写在各业务模块里。

**不许用模拟数据顶替任何源**（D1）。

### 7.5 二级缓存

现有 `lib/sources.js` 的内存缓存保留，新增一层**磁盘缓存**用于跨进程（cron 任务与 Web 服务是两个进程）：

```
data/cache/YYYY-MM-DD/market.json          全市场快照（当天有效）
data/cache/YYYY-MM-DD/klines-<code>.json   K线（当天有效）
```

Web 服务与 cron 任务共享这层，避免同一份数据被拉两次。

**实现（`lib/cache.js`）**：

| 约束 | 做法 |
|---|---|
| 跨日必失效 | 目录按自然日分；读取时只认「今天」的目录，跨日一律当未命中（否则就是 D3 的「拿旧值冒充当日」） |
| 命中要留痕 | 返回 `{value, fetchedAt, day}`，调用方把 `source='cache'`、`fetchedAt`、`cached=true` 并进 D4 元信息 |
| 只缓存可复用的数据 | 快照（当日有效）；K 线**仅历史请求**（`asOf < 今天`，内容已固定）。当日盘中数据不缓存，会变 |
| 能关掉 | `config.cache.enabled=false` 或 `QL_NO_CACHE=1`（测试用） |
| 清理 | `node tools/archive.js --prune-cache`，保留 `config.cache.keepDays` 天 |

---

## 8. 安全与边界

**明确的边界声明**（避免开发按互联网产品标准做过度设计）：

| 项 | 决策 |
|---|---|
| 部署形态 | 本地单机，`127.0.0.1:3000` |
| 鉴权 | **不做**。绑定 127.0.0.1 即可，不上公网 |
| 多用户 | **不支持**。单用户，数据文件即用户数据 |
| 数据加密 | 不做。无敏感信息（只有股票代码与评分） |
| 备份 | 建议用户自己 `git commit data/` 或定时 `tar` |

**如果将来要上公网**，必须补：鉴权、CSRF、请求限流、HTTPS。本期不预留接口，避免过度设计。

---

## 9. 与现有 QuantLab 代码的兼容

| 约束 | 说明 |
|---|---|
| 不改 `lib/clean.js`、`public/js/shape.js` | 历史口径可比性 |
| 不改 `public/js/strategies.js` 已有 40 个流派 | 只许新增，不许修改已有 |
| `/api/*` 现有响应结构保持 | 新增接口放在 `/api/predict` `/api/sector` `/api/lab` 前缀下 |
| 现有 `tools/smoke.js` 26 项必须持续全绿 | 每期结束跑一次，任何一项红都不许交付 |

---

## 10. 架构决策记录（ADR 摘要）

| # | 决策 | 备选 | 否决理由 |
|---|---|---|---|
| ADR-1 | 一、二期用 Node | Python | 本机无 numpy/pandas，且算法无需向量化 |
| ADR-2 | **自有数据按写入方分 D 库/JSONL** | 全 JSONL / 全 DuckDB / SQLite | 全 JSONL 算不了跨日聚合；全 DuckDB 会因两进程写而锁冲突；SQLite 在 Node 22 仍实验性或需编译 |
| ADR-2b | DuckDB 为**主**存储，JSONL 为**强制可用兜底** | 只用 DuckDB | 原生模块装不上时不能把项目卡死；`engine=jsonl` 必须能跑通全流程 |
| ADR-3 | cron 而非常驻调度器 | 常驻线程 | 进程挂了调度就没了 |
| ADR-4 | 三期子进程而非 HTTP 服务 | FastAPI | 日跑几次的批处理不需要常驻服务 |
| ADR-5 | **代码**复制而非引用 tdx-backtest | sys.path / pip install | 中文路径 + 独立 venv，代码引用不可移植 |
| ADR-6 | 单进程写、不做文件锁 | flock | 只有 cron 与 Web 会写，且时间错开；加锁复杂度大于收益 |
| ADR-7 | 归因优先级写死 | 并行判定 | 并行会让同一错归到多类，失去指向性 |
| ADR-8 | **数据**允许只读接入 `market.db`（与 ADR-5 不矛盾） | 完全不碰 / 复制整个库 | 代码耦合不可移植，但**只读一个文件**是安全的；复制 38.5GB 更荒谬。前提：只读 + 短连接 + 路径走配置 + 缺失可降级 |
| ADR-9 | 本地优先，但当日必须实时 | 全部走网络 | 本地库只到 T-1，历史数据走本地既快又稳；但当日走本地就是拿昨天冒充今天 |
| ADR-10 | 交易日历用库内 `MAX(date)` | 手工维护节假日表 | 节假日调休每年变，手工表必错；`MAX(date)` 是数据事实 |

**ADR-5 与 ADR-8 的边界**：**代码不引用，数据可只读接入**。判据是"换台机器会不会废"——代码引用会废（路径+venv），只读一个数据文件不会（路径配置化 + 缺失降级）。
