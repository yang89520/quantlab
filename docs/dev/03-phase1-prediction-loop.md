# 03 · 一期：预判-验证闭环

**工期**：8.25 人日 ｜ **依赖**：无（可立即开工）

---

## 0. 先读这段

本期**不追求把预测做准**，追求的是**让判断变成可被记录、可被验证的对象**。

现在的系统里没有任何东西记录「我昨天认为今天会怎样」。没有这个对象，"什么符合预期什么不符合"就无从谈起。

**一期成功标准不是命中率高，而是**：

> 连续 20 个交易日后，系统能回答——这 20 天我的判断命中多少次、错在哪一环、错因分布是什么。

命中率哪怕只有 40% 也算成功，因为那是第一个真实可信的数字。
**不要为提高命中率去调阈值或加指标**，那属于三期之后的事。一期调阈值 = 拿 20 个样本过拟合。

---

## 1. 范围

### 做

| # | 内容 | 产出 |
|---|---|---|
| 1 | 日快照落盘 | `data/snapshots/YYYY-MM-DD.json` |
| 2 | 预判卡生成（收盘后） | `ql.duckdb` → `prediction` 表（`engine=jsonl` 时落 JSONL） |
| 3 | 次日对账与归因 | 回填 S2 的 `reconcile` |
| 4 | 命中率统计 + 人读报告 | `/api/judgment/stats` + `pred-report.js` |
| 5 | 数据完整性门禁 | 残缺数据不入统计 |

### 不做（明确划出）

- ❌ 不改前端页面（四期）
- ❌ 不做板块/主线对账（二期）
- ❌ 不移植公式/回测引擎（三期）
- ❌ 不做观察池（二期）
- ❌ 不做预测模型、不调阈值、不加新指标

---

## 2. 模块与接口

> **前置**：所有取数必须走 `lib/datasource.js`（见 `09-data-access.md`）。
> 本节的 `snapshot.js` / `predict.js` **不许自己调上游接口**，一律通过 `datasource.resolve`。

### 2.0 `lib/datasource.js` — 统一数据访问（一期前置，0.5 人日）

```js
/**
 * @param {object} req
 *   req.kind   'kline-daily' | 'snapshot' | 'trading-day'
 *   req.code   'sh000001'
 *   req.date   'YYYY-MM-DD'   请求当日数据时必传
 *   req.bars   需要的根数
 * @returns {{ rows|data, source, level, asOf, stale, degraded, missing[] }}
 */
async function resolve(req)

// 交易日：本地库 MAX(date) → 网络最后一根 → 手工表
async function latestTradingDay()
```

**三条必须实现的行为**：

1. **本地优先**：历史 K 线先读 `market.db`，只补当日缺的几根
2. **时效优先于本地**：`requestedDate > dbLatestDate` 时**强制走网络**（D3）
3. **留痕**：返回值必带 `source / level / asOf / stale`，一路传到 UI

`market.db` 打不开时**降级走网络**并记 `degraded=true`，不许让服务起不来。

### 2.1 `lib/dao/` — 统一 DAO（DuckDB 主 / JSONL 兜底）

**不要自己写 `fs.writeFileSync`，也不要在业务代码里直接写 SQL。** 一律通过 DAO：

```js
const store = await open('snapshot');   // 后端由 config.storage.engine 决定

store.insert(rows)
store.upsert(rows, ['date', 'market', 'code'])
store.query({ where: { date: '2026-11-13' }, order: 'code', limit: 6000 })
store.count({ where: { date: '2026-11-13' } })
store.close()
```

| 后端 | 何时用 | 实现要点 |
|---|---|---|
| `duckdao.js` | 默认（cron 独占写的表） | 短连接；只写 `data/ql.duckdb`（**绝不写 market.db**） |
| `jsondao.js` | `engine=jsonl` 时兜底 | 追加 → 读全量 → 替换 → 写 `.tmp` → `rename` |

**实现要求**：
- 文件/表不存在时 `query` 返回 `[]`，不抛错
- JSONL 单行损坏时**跳过该行并 `log.warn`**，不许整个文件失败
- `upsert` 禁止"先删后写"（崩溃会丢数据）
- 同进程内写操作串行（Promise 队列），参考现有 `lib/store.js` 的 `writeQueue`
- **`engine=jsonl` 下全流程必须能跑通**（一期验收硬指标）

### 2.2 `lib/snapshot.js` — 日快照

```js
async function capture(date)       // 拉全市场 → upsert 进 store → 返回当日汇总
function read(date)                // → { date, complete, count, stocks: Map }
function readRange(from, to)       // → 按日期分组的汇总
```

`capture` 内部复用 `Q.marketList('all')`（现有），映射为长表列。**不要重新写一套拉取逻辑**。

写入目标按 `09` §7.2：**cron 写，落 `ql.duckdb` 的 `snapshot` 表**（`engine=jsonl` 时落按日 JSON）。

### 2.3 `lib/predict.js` — 预判卡生成

```js
/**
 * @param {object} ctx { date, snapshot, bars, config, candidates? }
 * @returns {object} S2 预判卡（reconcile 为 null）
 */
function build(ctx)

function judgeEnv(bars, snapshot, config)   // 纯函数，可单测
function buildInvalidIf(env)                // 生成失效条件
function buildScenario(env)                 // 生成三情景
```

**必须拆出 `judgeEnv` 为纯函数**：它是一期最需要反复验证的部分，不许依赖网络。

### 2.4 `lib/reconcile.js` — 对账与归因

```js
/**
 * @param {object} pred         S2 预判卡
 * @param {object} todaySnapshot S1（目标日快照）
 * @param {object} todayBars     指数 K 线（含目标日）
 * @param {object} config
 * @returns {object} S3 对账结果
 */
function reconcile(pred, todaySnapshot, todayBars, config)

function evalInvalidIf(list, metrics)   // 纯函数：求出命中的 id[]
function attribute(envHit, candHitRatio, candResults, config)  // 纯函数
```

### 2.5 `lib/judgment.js` — 统计

```js
function stats({ from, to })    // → S13 判断力画像
function report(stats)          // → 人读字符串（多行）
```

---

## 3. 算法规则

### 3.1 环境判定（`judgeEnv`）

**只有一套阈值**（G4）。三档打分，满分 100：

| 维度 | 权重 | 计算 |
|---|---|---|
| `trend` | 40 | `close > ma20` → 20 分；`ma20 > ma60` → 20 分 |
| `breadth` | 30 | `clamp((breadth - 0.35) / 0.40, 0, 1) × 30` |
| `vol` | 30 | `clamp((volRatio - 0.70) / 0.60, 0, 1) × 30` |

```js
const score = trend + breadthScore + volScore;   // 0~100，取整

let verdict;
if (score >= config.predict.verdict.attack) verdict = 'attack';    // 默认 65
else if (score <= config.predict.verdict.defend) verdict = 'defend'; // 默认 35
else verdict = 'wait';
```

**自洽校验**：`parts.trend + parts.breadth + parts.vol` 必须等于 `score`（±1 允许取整误差）。测试中断言这一条。

**`confidence` 固定输出 `null`**。不许编一个 0.62 看起来科学的数——要么真算，要么明说没有。

### 3.2 指标口径

| 指标 | 定义 | 取数位置 |
|---|---|---|
| `close` | 上证指数收盘 | `klines[last][2]` |
| `ma20` / `ma60` | 收盘均线 | 自算，`bars>=60` 否则降级 |
| `ret20` | `close / close[-21] - 1` | `bars>=21` |
| `breadth` | `chgPct > 0` 的标的数 ÷ 有效标的数 | 快照 |
| `volRatio` | 指数近 5 日均量 ÷ 近 20 日均量 | `klines[i][5]` |
| `ztCount` | 涨停近似，分板块阈值 | 快照 |
| `strongRatioProxy` | `chgPct >= 5` 的占比（**代理口径**） | 快照 |

**`ztCount` 的正确算法**（统一 10% 会漏掉双创全部涨停）：

```js
function isLimitUp(code, chg) {
  if (/^(300|301|688|689)/.test(code)) return chg >= 19.7;
  if (/^[489]/.test(code))             return chg >= 29.6;
  return chg >= 9.8;                    // 主板 600/601/603/605/000/001/002/003
}
```

**`strongRatio` 为什么是 Proxy**：真口径要算 5350 只 60 日涨幅，按现有 0.27 秒/只的墙钟速度约需 24 分钟，且会打满上游并发闸门。一期用当日涨幅代理，**字段名必须带 Proxy**，报告里标注"代理口径"，防止以后被当精确值用。

### 3.3 失效条件生成

```js
// 固定生成三条，不许多不许少（多说明结论不收敛）
buildInvalidIf(env) → [
  { id:'E1', desc:'指数跌破MA20', metric:'close', op:'<', ref:'ma20' },
  { id:'E2', desc:'宽度低于40%',  metric:'breadth', op:'<', value: 0.40 },
  { id:'E3', desc:'量能萎缩至0.7倍', metric:'volRatio', op:'<', value: 0.70 }
]
```

个股级：

```js
{ id:'C1', desc:'跌破MA20', metric:'close', op:'<', ref:'ma20' }
```

### 3.4 对账与归因（`reconcile`）

**判定顺序严格串行**，不允许并行（并行会让同一错误归到多类，失去指向性）：

```
1) 门禁：todaySnapshot 缺失 或 count < minSnapshotCount
   → { skipped: true, skipReason: 'no_snapshot' | 'incomplete' }，直接返回

2) 计算 actual：idxChg（目标日指数涨跌幅）、breadth、ztCount

3) 环境判定
   actualDirection = idxChg > 0.5 ? 'up' : idxChg < -0.5 ? 'down' : 'flat'
   envHit = (expected==='attack' && actual==='up')
         || (expected==='defend' && actual==='down')
         || (expected==='wait'   && actual==='flat')

4) 逐候选
   for each c: chg = (today.p / prevSnapshot.p - 1) * 100
               hit = chg > 0
               invalidHits = evalInvalidIf(c.invalidIf, { close: today.p, chg })
   candHitRatio = 上涨候选数 / 有效候选数     // 候选为空时记 null

5) 归因（优先级从高到低，命中即停）
   if (!envHit)                    → 'env'
   else if (candHitRatio === null) → 'hit'        // 无候选，只看环境
   else if (candHitRatio < 0.40)   → 'candidate'
   else if (hasSpikeFade)          → 'timing'
   else                            → 'hit'

   hasSpikeFade = 任一候选当日 (high - low)/prevClose > 3% 且 chg < 0
                  （冲高回落：日内振幅大但收跌）

6) judgmentScore = round(envScore * 0.5 + candScore * 0.5)
   envScore  = envHit ? 100 : 0
   candScore = candHitRatio === null ? envScore : candHitRatio * 100
```

**归因优先级为什么必须写死**：环境错了就不该怪选股——环境错时选股再好也是逆势。反过来环境对了选股还亏，才是选股逻辑的问题。顺序颠倒是归因分析最常见的错误。

**为什么一期只有三段、缺 `direction`**：完整设计有四个错因（环境 / 方向 / 标的 / 时机）。方向错需要板块成分数据，一期不具备。

硬凑一个"方向"会让归因失真（没法判断是板块选错还是个股选错）。**宁可少归一类，也不要把不同原因混成一类**——归因的意义就是指向该改哪一环，混了就没意义了。

三段已经能回答最核心的问题：**是市场看错了，还是选股选错了。** `direction` 在二期补齐（见 `04` 文档 §3）。

### 3.5 统计（`stats`）

```js
{
  sampleDays,          // 有效对账日数（skipped 必须排除）
  sufficient,          // sampleDays >= config.judgment.minSampleDays（10）
  envHitRate, candHitRate, avgJudgmentScore,
  byState: { attack:{n,envHitRate}, wait:{...}, defend:{...} },
  byAttribution: { hit, env, candidate, timing },
  note
}
```

**硬规则**：
- 分母永远是**有效对账日数**，不是预判卡总数
- `sufficient=false` 时报告首行必须打印「样本不足 10 天，比率不构成结论」
- 分状态统计永远同时输出 `n`；`n < config.judgment.minStateSample`（5）标注「样本过少」
- 比率字段用 `null` 表示"无法计算"（如分母为 0），**不许填 0**——0 和"没有数据"是两件事

---

## 4. 编排 `tools/daily-close.js`

```
1. resolveDate()    → 交易日（优先用 datasource.latestTradingDay()）
2. 指数 K 线        → datasource.resolve({ kind:'kline-daily', code:'sh000001', bars:260 })
                      本地库 259 根 + 网络补当日 1 根
3. 全市场快照       → datasource.resolve({ kind:'snapshot' })   仅网络
4. snapshot.capture(date)            → 落盘
5. 昨日有预判 && 未对账 → reconcile → upsert 回填
6. 今日无预判 → predict.build → upsert
7. 输出一行摘要（含 source / stale 标记）
```

**第 2 步的收益**：一期原本每次要向上游要 260 根，现在本地取 259 根只补 1 根——更快、更稳、且大幅降低被限流的风险。

**第 5 步必须在第 6 步之前**：先生成新预判会覆盖上下文，且对账需要昨日预判与今日快照的对比。

**幂等**：
- 快照：按文件名覆盖
- 预判卡：按 `date` upsert
- 对账：已有 `reconcile` 则跳过，除非 `--force`

**非交易日处理**：若快照 `lastBarDate !== date`，说明当日无行情 → 打印「非交易日，跳过」并 `exit 0`（这是正常情况，不是失败）。

**退出码**：捕获异常 → `log.error` → `process.exitCode = 1`。**不许打印错误后正常退出**（G3）。

**参数**：

```
--date YYYY-MM-DD    指定日期（补跑用）
--skip-fetch         用已有快照（调试）
--force              强制重算对账
```

---

## 5. 接口

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/predict/today` | 最近一张预判卡（含 reconcile） |
| GET | `/api/predict/:date` | 指定日期预判卡 |
| GET | `/api/predict/list?from&to` | 预判卡列表（精简字段） |
| GET | `/api/judgment/stats?days=20` | S13 判断力画像 |
| GET | `/api/health` | 见 `01` 文档 §6.2 |

响应结构沿用现有约定 `{ ok: true, data }` / `{ ok: false, error }`。

---

## 6. 错误处理约定

| 情况 | 处理 |
|---|---|
| 上游取数失败 | 重试 2 次（复用 `requestRetry`），仍失败则 `log.error` + 非 0 退出 |
| 快照数量不足 | 仍生成预判，但 `dataComplete=false` + `integrity.warnings` 记录；**不阻断** |
| 指数 K 线不足 120 根 | **阻断**，抛错退出（无法算 MA60 就没有判断基础） |
| 单条预判卡损坏 | 跳过该行 + warn，继续处理其余 |
| 候选代码已退市 | `chg` 记 `null`，该候选不计入 `candHitRatio` 分母 |
| 时区错误 | 一律用北京时间（`new Date(Date.now() + 8*3600e3)`），与 `sources.js` 现有写法一致 |

---

## 7. 测试清单

### 7.1 单元测试（纯函数）

| 用例 | 输入 | 期望 |
|---|---|---|
| `judgeEnv` 全强 | close>ma20>ma60, breadth=0.8, volRatio=1.4 | score=100, verdict=attack |
| `judgeEnv` 全弱 | close<ma20<ma60, breadth=0.2, volRatio=0.5 | score≈0, verdict=defend |
| `judgeEnv` 中性 | 部分满足 | verdict=wait |
| `judgeEnv` 自洽 | 任意 | `sum(parts) === score` |
| `evalInvalidIf` | `close=3300, ma20=3380` | 命中 `E1` |
| `evalInvalidIf` | `close=3421, ma20=3380` | 不命中 |
| `attribute` | envHit=false | `'env'` |
| `attribute` | envHit=true, candHitRatio=0.2 | `'candidate'` |
| `attribute` | envHit=true, 候选冲高回落 | `'timing'` |
| `attribute` | envHit=true, candHitRatio=0.75 | `'hit'` |
| `isLimitUp` | `300750`, chg=19.8 | true |
| `isLimitUp` | `300750`, chg=10.5 | **false**（创业板 10% 不是涨停） |
| `isLimitUp` | `600986`, chg=9.9 | true |

### 7.2 集成测试

| 用例 | 做法 | 期望 |
|---|---|---|
| 首次运行 | `daily-close.js` | 生成快照 + 1 条预判，`reconcile=null` |
| 幂等 | 再跑一次 | 预判行数不变 |
| 对账 | 构造昨日预判 + 今日快照 | `reconcile` 非空 |
| 门禁 | 快照 count=1200 | `skipped=true`，不进统计 |
| 非交易日 | 快照 `lastBarDate` 落后 | exit 0 + "非交易日" |
| 上游失败 | mock 抛错 | exit 1 |

### 7.3 变异验证（必做，否则测试无效）

| 变异 | 应被哪条用例抓住 |
|---|---|
| 删掉归因里的 `env` 分支 | `attribute` envHit=false 用例 |
| 把 `skipped` 计入分母 | 统计分母用例 |
| 把 `strongRatioProxy` 改名 `strongRatio` | 字段名断言 |
| `upsert` 改成 append | 幂等用例 |
| `ztCount` 统一用 9.8 | `isLimitUp` 创业板用例 |
| 快照数量不足时不标记 | 门禁用例 |

---

## 8. 验收

```bash
# 1. 首次运行
node tools/daily-close.js
# 期望：snapshot 表当日行数 >=4000；prediction 恰好 1 行；reconcile 为 null

# 2. 幂等（再跑一次，行数不变）
node tools/daily-close.js
node -e "require('./lib/dao').open().then(async d=>console.log(await d.count('prediction')))"   # 仍为 1

# 3. 报告
node tools/pred-report.js --days 20
# 期望：分母 = 有效对账日数；样本<10 时首行提示

# 4. 兜底后端也能跑通（硬指标）
QL_STORAGE=jsonl node tools/daily-close.js
# 期望：与 duckdb 后端结果一致

# 5. 回归（现有 26 项不许退化）
npm test
```

> 2026-11-14 修正两处：
> 1. 第 2 步原写 `require('./lib/store')` —— `lib/store.js` 是**自选股 JSON 存储**，
>    与数据库 DAO 不是一回事（DAO 在 `lib/dao`）。照原文敲会报 `open is not a function`。
> 2. 第 4 步的 `QL_STORAGE=jsonl` 原先**代码里没有实现**，环境变量被忽略，实际跑的还是 duckdb
>    （日志里 `store.ready {"engine":"duckdb"}` 会露馅）。现已在 `lib/config.js` 补上该开关，
>    非法值直接抛错而不是静默回落。

- [x] 上述 5 条全通过
- [x] 变异验证 6 条全部变红
- [x] `/api/health` 返回 `lastPrediction` 非空（`{date,targetDate,verdict,score,dataComplete,createdAt}`）
- [x] **确认 `market.db` 未被修改**（对比运行前后的文件 mtime）

> 2026-11-14 核验记录：
> - 幂等：连跑 3 次 `daily-close.js` 后 `prediction` 仍为 1 行
> - 兜底后端：`QL_STORAGE=jsonl` 跑完整闭环，日志 `store.ready {"engine":"jsonl"}`，预判/观察池/信号/风险四步都落盘
> - 上游库只读：`market.db` 运行前后 `mtime=1794647609 / size=37660143616` 完全一致（11-14 跑完 `--skip-fetch` 全流程后复核）
> - `lastPrediction` 落地时踩到两个坑，都已修：DuckDB 的 TIMESTAMP 不是 JS `Date`（返回 `{micros: BigInt}`），
>   `res.json` 遇 BigInt 直接抛错让整个 `/api/health` 变 500。现在响应层统一做了 BigInt 兜底 + 时间折 ISO。

---

## 9. 任务拆解

| # | 任务 | 依赖 | 人日 |
|---|---|---|---|
| T0 | **`datasource.js` 本地优先解析链 + 上游库只读接入** | — | 1.0 |
| T1 | **`lib/dao/` DAO 双后端（duckdao + jsondao）+ 单测** | — | 1.0 |
| T2 | `snapshot.js` + 落盘 | — | 0.5 |
| T3 | `predict.js`（含 `judgeEnv` 纯函数）+ 单测 | T1,T2 | 1.5 |
| T4 | `reconcile.js`（含 `attribute`）+ 单测 | T1,T2 | 1.5 |
| T5 | `judgment.js` | T4 | 0.5 |
| T6 | `daily-close.js` 编排 + 幂等 + 退出码 | T3–T5 | 0.5 |
| T7 | `pred-report.js` | T5 | 0.5 |
| T8 | 测试夹具 + 变异验证 | 全部 | 1.0 |
| T9 | cron + 日志 + `/api/health` | T6 | 0.25 |

**建议顺序**：T0（数据层先行）→ T1 → T2 → T3 → T6（先能跑出第一张卡）→ T4 → T5 → T7 → T8 → T9。

先跑出第一张卡再补对账，因为预判卡格式最容易反复改，让它在真实数据上跑一天再定稿。

**合计 8.25 人日**（T0 数据层 1.0 + T1 DAO 双后端 1.0，均来自 `09-data-access.md` 的强制要求）。
