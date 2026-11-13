# 09 · 数据与存储规范（强制）

> **本文的四条铁律与双库边界是硬约束，优先级高于其他所有文档。**
> 任何一期、任何模块、任何临时脚本都必须遵守。违反的代码不予合并。

---

## 1. 四条铁律

| # | 铁律 | 一句话解释 |
|---|---|---|
| **D1** | **禁止假数据** | 不许模拟、不许随机、不许占位、不许用旧值顶替。拿不到就标记缺失 |
| **D2** | **本地优先** | 本地库有就用本地，没有才请求网络 |
| **D3** | **时效优先于本地** | 当日行情必须实时获取，**不许用 T-1 本地数据冒充当日** |
| **D4** | **每次取数必须留痕** | 记录来源、级别、数据时点，供追溯与排查 |

**D3 是 D2 的边界，两者不冲突**：本地优先只适用于**历史数据**。当日行情一旦走了本地库，就是拿昨天冒充今天——这是最危险的假数据形态，因为它看起来完全正常。

---

## 2. 双库分离（最重要的硬边界）

### 2.1 三个存储，三种角色

| 存储 | 路径 | 归属 | 我们能做什么 |
|---|---|---|---|
| **上游行情库** | 由上游给定（当前是 `<tdx-backtest>/data/market.db`） | **别人的**，有独立更新引擎每日更新 | **只读。绝不能写** |
| **本项目业务库** | `data/ql.duckdb` | 我们自己的 | 读 + 写 |
| **本项目 JSON 存储** | `data/*.jsonl` | 我们自己的 | 读 + 写 |

### 2.2 铁律：绝不写 `market.db`

| 禁令 | 后果 |
|---|---|
| 不许 `INSERT / UPDATE / DELETE / CREATE TABLE / ATTACH ... (READ_WRITE)` | 会破坏上游的每日更新，且对方无从察觉 |
| 不许对**上游库** `duckdb.connect(path)` 不带 `readOnly` | 默认是读写模式，可能取得写锁，让上游更新引擎失败。**自有 `ql.duckdb` 不在此限**（它本来就要写，见 §7） |
| 不许把我们的表建到 `market.db` 里"图方便" | 上游若重建/迁移该库，我们的数据一并消失 |

**代码层保证（三重）**：

```js
// 1. 唯一的打开入口，写死 readOnly
const MARKET_DB = () => ({ path: config.localDb.marketDb, readOnly: true });

// 2. 写操作只接受自有库句柄，签名层面隔离
function writeOnlyTo(ownDb /* = data/ql.duckdb */, sql, params)

// 3. 启动时自检：断言 market.db 未被我们以可写方式打开
assertReadOnly(marketConn)   // 失败则拒绝启动并 log.error
```

**代码评审检查项**：任何涉及 `market.db` 的 `connect` 调用，必须能看到 `readOnly: true`。

### 2.3 上游只是一个契约，不是这个项目

**不要**把"tdx-backtest 这个仓库"写进我们的代码逻辑。我们只依赖一个**契约**：

> 存在一个 DuckDB 文件，其中有 `kline_daily(market, code, date, open, high, low, close, volume, amount, factor)` 表，
> 覆盖 A 股历史日线，每日更新。

满足契约的任何提供方都能直接替换。**理由**：你已明确要把更新引擎单独抽离，将来这个库可能：
- 换到别的目录
- 由独立服务/定时任务维护
- 换成别的文件名（如 `kline.duckdb`）

所以路径必须走配置（`config.local.json`），**不许硬编码**（路径还含中文）。

### 2.4 我们不管更新

| 我们不做 | 说明 |
|---|---|
| 不触发上游更新 | 它有独立的更新引擎与调度 |
| 不感知它的更新时间 | 只探测 `MAX(date)` 判断数据到哪天 |
| 不对它的数据做修正 | 发现质量问题就**记录并绕过**（如 `amount=0` 时改用 `volume`），不写回 |

**只探测、只消费、只记录问题。**

---

## 3. D1 · 禁止假数据

### 3.1 数据可信度分级

每次取数必须标注级别，随数据一起传递，并在 UI/报告中可见。

| 级别 | 定义 | 允许用途 | 标注要求 |
|---|---|---|---|
| **A 本地库** | 上游行情库，或本项目已落盘数据 | 全部 | 标注 `source + asOf` |
| **B 实时接口** | 当次从新浪/腾讯/同花顺/东财取到 | 全部 | 标注 `source + fetchedAt` |
| **C 派生计算** | 由 A/B 级数据计算得出（温度、宽度、评分、板块强度） | 全部 | 标注「派生」+ 依赖的原始级别 |
| **D 代理口径** | 因成本原因用近似指标替代（如 `strongRatioProxy`） | 仅限明确标注处 | **字段名必须带 Proxy** + 报告标注 |
| **X 禁止** | 模拟 / 随机 / 占位 / 前值填充 / 硬编码示例 | **任何用途** | — |

### 3.2 X 级（禁止）的具体形态

以下是**不允许**的写法，逐条列出因为每一种都实际见过：

```js
// ❌ 随机/模拟
const price = Math.random() * 10 + 5;
const data = mockKlines();

// ❌ 占位值冒充真实值
return { price: 0, chgPct: 0 };                 // 0 是有效值，会被当成真数据
return { score: 50 };                            // 中性默认值 = 撒谎

// ❌ 前值填充（最隐蔽）
const today = cache.get(code) || yesterday.get(code);   // 没标注就是用假的

// ❌ 静默降级为常量
catch (e) { return { breadth: 0.5 }; }

// ❌ 编造置信度
confidence: 0.62                                 // 没算就别填，填 null
```

**正确写法**：

```js
// ✅ 标注缺失
return { breadth: null, missing: ['breadth'], level: 'B' };

// ✅ 前值填充必须显式标注
return { ...yesterday, stale: true, asOf: yesterday.date, level: 'A' };
// UI 必须显示「数据为 T-1，非当日」

// ✅ 无法计算就给 null
confidence: null
```

### 3.3 唯一例外：测试夹具

`tests/fixtures/` 下的假数据**允许存在**，但必须：

- 目录限定在 `tests/`
- 文件名或首字段标注 `fixture`
- **不允许被 `lib/` 下任何生产代码 import**

上线检查表会断言这一点（见 `07` 文档 §6 第 8 项）。

---

## 4. D2 · 本地优先

### 4.1 解析顺序（严格按序，不允许跳级）

```
请求某个数据
   ↓
① 本项目已落盘（ql.duckdb 或 data/*.jsonl）
   ↓ 没有
② 上游行情库 market.db（只读，仅历史数据 ≤ T-1）
   ↓ 没有 / 不适用
③ 网络接口（新浪 → 腾讯 → 同花顺 / 东财）
   ↓ 全失败
④ 返回 null + 记录 missing，**不许编造**
```

**为什么本项目库排第一**：它是本项目口径产出的（已清洗、已截断），优先于原始库。

### 4.2 哪些数据该走上游库

| 数据 | 走本地库 | 理由 |
|---|---|---|
| 个股历史日线（≤ T-1） | ✅ 优先 | 库里有 17.6M 行 / 5560 只 / 从 1990 年起，比网络拉取快且全 |
| 指数历史日线 | ✅ 优先 | 同上 |
| 分钟线 | ✅ 优先 | 库里 `kline_min` 有，网络源基本拿不到 |
| 周/月线 | ✅ 优先 | 库里 `kline_period` 有，省得自己聚合 |
| **当日行情** | ❌ **禁止** | D3：库只到 T-1 |
| 实时快照（全市场 5350 只） | ❌ 不支持 | 库里没有当日快照 |
| 板块列表/成分 | ❌ 不支持 | 库里没有 |
| 涨停池 | ❌ 不支持 | 库里没有 |

### 4.3 实现：统一解析器

`lib/datasource.js` 提供唯一入口，**禁止各模块自己决定从哪取数**：

```js
/**
 * @param {object} req
 *   req.kind    'kline-daily' | 'kline-min' | 'kline-period' | 'snapshot' | 'sector' ...
 *   req.code    'sh000001' | '600986'
 *   req.date    'YYYY-MM-DD'（需当日数据时必传）
 *   req.bars    需要的根数
 * @returns {{ rows|data, source, level, asOf, stale, missing[] }}
 */
async function resolve(req)
```

**返回结构强制包含**：`source`、`level`、`asOf`、`stale`。调用方拿到后**必须把这个元信息一路传下去**，最终显示在界面上。不许在中间层丢掉。

---

## 5. D3 · 时效边界

### 5.1 上游库只到 T-1

实测（2026-11-13 查询）：`MAX(date) = 20261112`，而当日是 11-13。

这是正常的——上游是**盘后更新**，所以库里永远是 T-1（盘后跑完变 T）。

| 请求 | 判定 |
|---|---|
| 请求日期 ≤ 库内 `MAX(date)` | 允许走本地库 |
| 请求日期 > 库内 `MAX(date)` | **必须走网络** |
| 请求当日（用于实时判断） | **必须走网络** |

### 5.2 判定函数

```js
function canUseLocal(requestedDate, dbLatestDate) {
  return requestedDate <= dbLatestDate;
}
```

`dbLatestDate` 由 `SELECT MAX(date) FROM kline_daily` 得到，**不许用 `new Date()` 推算**——节假日、停市都会让它错。

### 5.3 一条容易犯的错

```js
// ❌ 错：用本地库的最后一根 K 线当作"今天"
const bars = await localKline(code, 260);
const today = bars[bars.length - 1];   // 这根是 11-12，不是今天

// ✅ 对：显式判断并补齐
let bars = await localKline(code, 260);
if (bars[bars.length - 1].d < todayStr()) {
  const tail = await fetchKline(code, 5);        // 只补最近几根
  bars = merge(bars, tail);                      // 按日期去重合并
}
```

**补数只补缺的几根，不重拉全量**——这是本地优先的收益所在：260 根里 259 根来自本地，只请求 1 根。

---

## 6. D4 · 留痕

每次取数必须记录（写日志 + 随数据返回）：

```jsonc
{
  "source": "market-db",        // market-db | ql-duckdb | sina-quote | tencent-quote | ths-kline | cache | computed
  "level": "A",
  "asOf": "2026-11-12",
  "fetchedAt": "2026-11-13T08:35:00.000Z",
  "stale": false,
  "degraded": false,
  "degradeReason": null
}
```

**这些字段要一路传到 UI**：今日一页的状态条要能显示「数据来源」与「数据时点」。

---

## 7. 存储层：按写入方分离

### 7.1 一个绕不过去的问题

DuckDB 是**单写进程**数据库：同一个文件在同一时刻只允许一个写连接。

而本项目有**两个进程会写数据**：

- `daily-close.js`（cron，每日一次）
- Web 服务（用户点观察池、改策略）

如果两者都写 `ql.duckdb`，必然出现 `Conflicting lock`。

### 7.2 解法：按"谁写"划分存储

| 数据 | 唯一写入方 | 存储 | 理由 |
|---|---|---|---|
| S1 日快照 | cron | **DuckDB** | 133 万行/年，需 SQL 聚合与分组 |
| S2 预判卡 | cron | **DuckDB** | 要按日期范围统计命中率 |
| S3 对账结果 | cron | **DuckDB** | 同上（内嵌于 S2 的 payload） |
| S5 板块成分 | cron | **DuckDB** | 2 万代码/日，量大 |
| S6 板块强度 | cron | **DuckDB** | 要排行、要跨日对比轮动 |
| S10 验证档案 | cron | **DuckDB** | 结构化查询 |
| S11 策略信号 | cron | **DuckDB** | 量大，要跟踪聚合 |
| S7 观察池 | **Web** | **JSONL** | 用户随时改；约 200 条；要能手改 |
| S8 迁移日志 | Web/cron | **JSONL** | 只追加；要能人工查阅 |
| S9 策略定义 | **Web** | **JSONL** | 用户编辑源码，需 `git diff` 可见 |
| S4 板块字典 | cron | JSON | 500 条，一天覆盖一次 |

**划分依据是写入方，不是数据类型。** 这条划分让两个进程各自写各自的文件，锁冲突从架构上消失。

### 7.3 自有库结构（`data/ql.duckdb`）

**设计原则**：结构化列用于查询/聚合，完整原文放 `payload JSON` 兜底。
这样 schema 演进时只需改查询，不用迁移全部历史。

```sql
-- 日快照（长表，便于 SQL 聚合）
CREATE TABLE snapshot (
  date DATE, market VARCHAR, code VARCHAR,
  price DOUBLE, chg_pct DOUBLE, amount DOUBLE, turnover DOUBLE, float_cap DOUBLE,
  PRIMARY KEY (date, market, code)
);

-- 预判卡
CREATE TABLE prediction (
  date DATE PRIMARY KEY, target_date DATE, verdict VARCHAR,
  score INTEGER, data_complete BOOLEAN, created_at TIMESTAMP, payload JSON
);

-- 对账（内嵌于 prediction.payload，此表为便于统计的投影）
CREATE TABLE reconcile (
  date DATE PRIMARY KEY, env_hit BOOLEAN, cand_hit_ratio DOUBLE,
  attribution VARCHAR, judgment_score INTEGER, skipped BOOLEAN, payload JSON
);

-- 板块成分与强度
CREATE TABLE sector_member (
  date DATE, sector VARCHAR, code VARCHAR, PRIMARY KEY (date, sector, code)
);
CREATE TABLE sector_strength (
  date DATE, sector VARCHAR, name VARCHAR, type VARCHAR,
  score DOUBLE, grade VARCHAR, payload JSON, PRIMARY KEY (date, sector)
);

-- 策略信号与验证
CREATE TABLE strategy_signal (
  date DATE, strategy_id VARCHAR, version INTEGER, code VARCHAR,
  action VARCHAR, price DOUBLE, payload JSON,
  PRIMARY KEY (date, strategy_id, code)
);
CREATE TABLE strategy_gate (
  strategy_id VARCHAR, version INTEGER, date DATE, verdict VARCHAR, payload JSON,
  PRIMARY KEY (strategy_id, version, date)
);

-- 元信息（schema 版本、上次更新等）
CREATE TABLE meta (k VARCHAR PRIMARY KEY, v JSON);
```

**为什么快照用长表**：5342 只 × 250 天 = 133 万行/年，DuckDB 毫无压力；长表能直接做
`GROUP BY date` 算每日宽度、`GROUP BY code` 算个股连续性——JSONL 做不到。

**为什么预判卡保留 `payload JSON`**：预判卡结构还在演进（二期要加 `mainline`），
用 JSON 兜底可以只加列、不改历史行。

### 7.4 统一 DAO（业务代码不感知存储）

`lib/store/index.js`：

```js
/**
 * @param {string} name  'snapshot' | 'prediction' | 'watchpool' ...
 * @returns store 对象，方法签名对所有后端一致
 */
async function open(name)

store.insert(rows)                  // 追加
store.upsert(rows, keyFields)       // 按键替换
store.query({ where, order, limit })// 条件查询
store.count({ where })              // 计数
store.close()
```

`config.storage.engine` 三值：

| 值 | 行为 |
|---|---|
| `duckdb` | 全部走 ql.duckdb（不可用时**启动失败并报错**，不静默降级） |
| `jsonl` | 全部走 JSONL（强制降级模式，用于 DuckDB 装不上时） |
| `auto`（默认） | 能开 DuckDB 就用，否则**自动降级 JSONL 并 `log.warn`** |

**一期验收要求**：`engine=jsonl` 下全部功能可跑通。这样即使 Node 原生模块装不上，一期照样能交付。

### 7.5 体积

| 数据 | 年增量 |
|---|---|
| snapshot 表 | 133 万行 × ~60B ≈ 80MB（DuckDB 压缩后约 20~30MB） |
| prediction / reconcile | 250 行，可忽略 |
| sector_member | 2 万 × 250 ≈ 500 万行 ≈ 60MB |
| sector_strength | 1.5 万行，可忽略 |
| strategy_signal | 视策略数，估 50 万行 ≈ 20MB |
| **合计** | **约 100~150MB/年**，单文件完全可控 |

---

## 8. 上游行情库接入规范

### 8.1 库概况（实测）

| 项 | 值 |
|---|---|
| 路径 | 由 `config.localDb.marketDb` 指定（当前指向 tdx-backtest） |
| 体积 | **38.5 GB** |
| 表 | `kline_daily` / `kline_min` / `kline_period` / `manifest` |
| 覆盖 | 17,608,275 行 / 5,560 只 / 1990-12-19 起 |
| 最新 | `MAX(date) = 20261112`（T-1，每日盘后更新） |

### 8.2 表结构

```sql
-- 日线
kline_daily(
  market  VARCHAR,   -- 'sh' | 'sz' | 'bj'
  code    VARCHAR,   -- '600986'
  date    INTEGER,   -- 20261112（YYYYMMDD 整数，不是字符串！）
  open, high, low, close DOUBLE,
  volume  DOUBLE,    -- 股
  amount  DOUBLE,    -- 元
  factor  DOUBLE     -- 复权因子；指数为 NULL
)

-- 分钟线
kline_min(market, code, period, bar_ts TIMESTAMP, open, high, low, close, volume, amount, fq INTEGER)

-- 周/月线
kline_period(market, code, period, date INTEGER, open, high, low, close, volume, amount, factor)
```

### 8.3 三条访问铁律

```js
// 铁律 1：只读打开（见 §2.2）
duckdb.connect(MARKET_DB, { readOnly: true })

// 铁律 2：短连接 —— 每次查询 open → query → close
// 绝不允许持有长连接。DuckDB 单文件同一时刻只允许一个写进程，
// 我们持着读连接，上游的每日更新就永远拿不到写锁。

// 铁律 3：开库失败要退避重试
// 上游更新期间持排他锁，我们打不开是正常并发状态，不是故障。
```

**重试实现**：

```js
async function withMarketDb(fn, { retries = 3, backoff = 300 } = {}) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(await openReadOnly(MARKET_DB)); }
    catch (e) {
      if (i === retries - 1) throw e;
      await sleep(backoff * (i + 1));      // 300 / 600 / 900
    }
  }
}
```

### 8.4 SQL 约束（38.5GB 库，乱查会很慢）

| 约束 | 说明 |
|---|---|
| **禁止 `SELECT *` 全表扫描** | 17.6M 行，会耗尽内存 |
| **必须带 `WHERE market=? AND code=?`** | 走分区裁剪 |
| **必须带 `ORDER BY date DESC LIMIT n`** | 只取需要的根数 |
| **`date` 是整数** | 比较用 `20261112`，不是 `'2026-11-12'` |
| **禁止跨库 `ATTACH`** | 一期不做跨库 JOIN，需要时在应用层合并（ATTACH 会长时间持锁） |

标准查询模板：

```sql
SELECT date, open, high, low, close, volume, amount, factor
FROM kline_daily
WHERE market = ? AND code = ? AND date <= ?
ORDER BY date DESC
LIMIT ?
```

### 8.5 数据质量注意（实测发现）

**`amount` 有 0 值**。实测上证指数 20261111 那行 `amount = 0.0`，而 `volume` 正常。

因此：

- 量能类指标一律用 `volume`，不要用 `amount`
- 若必须用 `amount`，先校验 `amount > 0`，否则标记缺失（不许当 0 用）

**发现质量问题只记录不修正**（见 §2.4），绝不写回上游库。

### 8.6 交易日历：用库内 MAX(date)

```js
async function latestTradingDay() {
  const d = await marketDbLatestDate();    // SELECT MAX(date) FROM kline_daily
  if (d) return d;                         // 数据事实，绝不猜错
  // 降级：网络取指数最后一根
  // 再降级：手工表
}
```

**理由**：节假日调休规则每年变，手工维护的表必出错；`MAX(date)` 是数据本身的事实。

### 8.7 Node 读 DuckDB 的三个方案

本机现状：**无 duckdb CLI、系统 python3 无 duckdb 模块**（仅 `tdx-backtest/.venv-axdata` 有 1.5.5）。

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A（首选）** | npm `@duckdb/node-api` 或 `duckdb` | 纯 Node，无额外进程；读写自有库也用它 | 原生模块，需预编译二进制 |
| **B（降级）** | 本项目自建 `py/.venv` + `py/dbq.py` 子进程 | 零原生编译风险 | 多一个进程；自有库写入走子进程会有延迟 |
| **C（兜底）** | 不接 DuckDB：上游库不读、自有库退 JSONL | 零依赖 | 历史数据要现拉，慢；分钟线拿不到 |

**决策顺序**：先试 A → 装不上或报错走 B → B 也不通走 C（`config.storage.engine='jsonl'`），并在 `/api/health` 标注。

**严禁**：借用 `tdx-backtest/.venv-axdata`。它属另一个项目，哪天被删/升级就崩，且路径含中文。

### 8.8 路径配置

**绝不硬编码**（路径含中文，且上游可能换位置）：

```jsonc
// config.local.json（不进版本库）
{
  "localDb": {
    "enabled": true,
    "marketDb": "/path/to/market.db"        // 上游行情库，只读
  },
  "storage": {
    "engine": "auto",                        // duckdb | jsonl | auto
    "ownDb": "data/ql.duckdb"                // 本项目自有库，可写
  }
}
```

- `marketDb` 为空或 `enabled=false` → 跳过上游库，走网络
- 路径存在但打不开 → `log.warn` + 降级走网络，**不许让服务起不来**
- 启动时做一次连通性检查，结果写进 `/api/health`
- **`ownDb` 与 `marketDb` 必须是不同文件**，启动时断言（防止误配）

---

## 9. 验收断言（怎么证明"没有假数据"）

以下断言要加进 `tools/smoke.js`，每次回归都跑：

| # | 断言 | 做法 |
|---|---|---|
| 1 | 生产代码无 mock | `grep -rniE "mock\|fake\|random\|lorem" lib/` 应为空 |
| 2 | 无静默常量兜底 | 抽查所有 `catch` 块，不许 `return { x: 0.5 }` 这类 |
| 3 | 所有取数带元信息 | 遍历 `datasource.resolve` 的返回值，必须含 `source/level/asOf` |
| 4 | 当日数据不走本地库 | mock `dbLatestDate = 昨日`，请求今日 → 断言走网络 |
| 5 | 缺失返回 null 不返回 0 | 构造上游全失败 → 断言 `price === null` 而非 `0` |
| 6 | fixtures 不被生产代码引用 | `grep -rn "tests/fixtures" lib/` 应为空 |
| 7 | 降级有标记 | 强制本地库不可用 → 断言返回值 `degraded=true` |
| **8** | **不写上游库** | 断言所有 `marketDb` 连接均为 `readOnly:true`；`ownDb !== marketDb` |
| **9** | **自有库可独立运行** | `engine=jsonl` 下跑完整一期流程不报错 |

---

## 10. 实施影响

| 期 | 受影响内容 |
|---|---|
| 一期 | 新增 `datasource.js`（本地优先）+ `store/`（DAO 双后端）；快照与预判卡按 §7.2 分存 |
| 二期 | 板块成分/强度入 DuckDB；观察池仍 JSONL（Web 可写） |
| 三期 | `py/` 与 DuckDB 共用 venv；回测 K 线优先从上游库取 |
| 四期 | 状态条显示数据来源与时点；`stale=true` 必须可见 |

**一期的实际收益**：指数 K 线从"每次问上游"变成"本地 259 根 + 补 1 根"，既快又稳，也降低被限流的风险。

---

## 11. 一句话总结

**宁可显示「没有」，也不显示一个看起来正常的假数字。**

一条假的 0 会被算进统计、影响判断、最后反映成错误的对账结论——而用户永远不知道是哪一步开始烂的。

**同理，宁可我们的库小一点，也不许往别人的库里塞一行数据。**
