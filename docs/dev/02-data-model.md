# 02 · 全量数据模型

> 四期所有持久化实体都在此定义。**开发不许自创字段名**，需要新字段走 `README §5` 变更规则。
> 所有记录带 `schema` 字段，当前统一为 `1`。

**命名约定**：一律 camelCase（与现有 QuantLab 代码一致）。日期用 `YYYY-MM-DD` 字符串，时间戳用 ISO 8601 UTC 字符串。

---

## 0. 实体总览

**存储分配依据「谁写」，见 `09-data-access.md` §7。** 同一实体只有一种存储，不许两处都存。

| ID | 实体 | 期 | 存储 | 写入方 | 量级/年 | 唯一键 |
|---|---|---|---|---|---|---|
| S1 | 日快照 | 一 | `ql.duckdb` → `snapshot` 长表 | cron | 133 万行 | date+market+code |
| S2 | 预判卡 | 一 | `ql.duckdb` → `prediction` | cron | 250 行 | date |
| S3 | 对账结果 | 一 | `ql.duckdb` → `reconcile`（投影） | cron | 250 行 | date |
| S4 | 板块字典 | 二 | `data/sectors/dict.json` | cron | 1 文件 / 500 条 | code |
| S5 | 板块成分 | 二 | `ql.duckdb` → `sector_member` | cron | 500 万行 | date+sector+code |
| S6 | 板块强度 | 二 | `ql.duckdb` → `sector_strength` | cron | 1.5 万行 | date+sector |
| S7 | 观察池条目 | 二 | `data/watchpool/pool.jsonl` | **Web** | 常驻 ~200 条 | code |
| S8 | 状态迁移日志 | 二 | `data/watchpool/transitions.jsonl` | Web/cron | ~3000 条 | id |
| S9 | 策略定义 | 三 | `data/strategies/defs.jsonl` | **Web** | 数十条 | id |
| S10 | 验证档案 | 三 | `ql.duckdb` → `strategy_gate` | cron | 数十~数百行 | strategyId+version+date |
| S11 | 策略信号 | 三 | `ql.duckdb` → `strategy_signal` | cron | ~50 万行 | date+strategyId+code |
| S12 | 信号跟踪 | 三 | 内嵌 S11 的 `payload` | cron | 同 S11 | — |
| S13 | 判断力画像 | 一 | **不持久化**，实时聚合 | — | — | — |

**为什么 S7/S9 留在 JSONL**：它们由 Web 进程写，而 `ql.duckdb` 是 cron 独占写的（DuckDB 单写进程）。
放 JSONL 后两进程各写各的，锁冲突从架构上消失。详见 `09` §7.2。

---

## 0.1 表与 JSON 的映射关系

各实体的 JSON 示例是**逻辑形态**，用于表达"一条记录包含什么"，**不代表物理存储格式**。

| 实体 | 物理形态 | 说明 |
|---|---|---|
| S1 快照 | **长表**（每只标的一行） | 不是一天一个 JSON 文档。这样才能 `GROUP BY date` 算每日宽度 |
| S2/S3 预判与对账 | **单行 + `payload JSON`** | 结构化列（date/verdict/score）用于查询，完整原文进 payload |
| S5 成分 | **长表**（板块×股票 一行） | 便于 JOIN |
| S6 强度 | **单行 + `payload JSON`** | 分项与指标进 payload |
| S7/S8/S9 | **JSONL 一行一记录** | 与 JSON 示例一一对应 |

**通用原则**：**结构化列用于查询与聚合，完整原文放 `payload JSON` 兜底。**
这样 schema 演进时只加列、不改历史行。

---

## 0.2 迁移与兼容

| 场景 | 做法 |
|---|---|
| 加字段 | 只加列或只写入 payload，`schema` +1，**不迁移历史行** |
| 改字段语义 | **禁止**。新建列，旧列保留但停止写入 |
| 从 JSONL 迁到 DuckDB | 写一次性脚本 `tools/migrate.js`，导入后校验行数，**不删原文件** |
| 从 DuckDB 降级到 JSONL | DAO 层自动处理（`engine=jsonl`），业务代码不感知 |

---

## S1 · 日快照

**存储**：`ql.duckdb` → `snapshot` 长表（**每只标的 × 每天一行**，不是一天一个 JSON 文档）
**写入方**：cron（`daily-close.js`）
**用途**：次日对账的唯一基准。不落盘就无法对比昨天——这是整个闭环的地基。

```sql
-- 物理形态
INSERT INTO snapshot (date, market, code, price, chg_pct, amount, turnover, float_cap)
VALUES ('2026-11-13', 'sh', '600986', 7.46, -1.84, 595560000, 5.31, 15200000000);
```

**为什么是长表**：5342 只 × 250 天 = 133 万行/年，DuckDB 毫无压力；
长表能直接 `GROUP BY date` 算每日宽度、`GROUP BY code` 算个股连续性——按日 JSON 做不到。

**逻辑形态**（一天的全景，仅用于理解，不落盘）：

```jsonc
{
  "date": "2026-11-13",
  "capturedAt": "2026-11-13T08:35:12.000Z",
  "source": "sina-quote",
  "complete": true,
  "count": 5342,
  "stocks": {
    "600986": { "p": 7.46, "c": -1.84, "a": 595560000, "t": 5.31, "fc": 15200000000 }
  }
}
```

| 列（DuckDB） | 类型 | 说明 | 来源 |
|---|---|---|---|
| `date` | DATE | 交易日 | 当日 |
| `market` | VARCHAR | `sh`/`sz`/`bj` | 代码推导 |
| `code` | VARCHAR | 6 位代码 | 快照 |
| `price` | DOUBLE | 收盘价（元） | 快照 `price` |
| `chg_pct` | DOUBLE | 涨跌幅（%） | 快照 `chgPct` |
| `amount` | DOUBLE | 成交额（元） | 快照 `amount` |
| `turnover` | DOUBLE | 换手率（%） | 快照 `turnover` |
| `float_cap` | DOUBLE | 流通市值（元） | 快照 `floatCap` |

**`complete` 判定**：当日行数 `>= config.integrity.minSnapshotCount`（默认 4000）。

**幂等**：按 `(date, market, code)` upsert；重跑同一天不产生重复行。

**`engine=jsonl` 降级形态**：退化为 `data/snapshots/YYYY-MM-DD.json` 的按日文档（上面的逻辑形态）。

---

## S2 · 预判卡

**存储**：`ql.duckdb` → `prediction`（一行一条，`payload JSON` 存完整原文）
**写入方**：cron

```sql
prediction(date DATE PK, target_date DATE, verdict VARCHAR,
           score INTEGER, data_complete BOOLEAN, created_at TIMESTAMP, payload JSON)
```

查询用结构化列（如 `WHERE verdict='attack'`），完整内容读 `payload`。
下表是 `payload` 的逻辑结构：

```jsonc
{
  "schema": 1,
  "date": "2026-11-13",
  "targetDate": "2026-11-16",
  "createdAt": "2026-11-13T08:40:00.000Z",

  "dataComplete": true,
  "integrity": {
    "snapshotCount": 5342,
    "bars": 260,
    "lastBarDate": "2026-11-13",
    "warnings": []
  },

  "env": {
    "verdict": "attack",
    "confidence": null,
    "score": 62,
    "metrics": {
      "close": 3421.5, "ma20": 3380.2, "ma60": 3310.8, "ret20": 0.041,
      "breadth": 0.58, "strongRatioProxy": 0.284, "volRatio": 1.12, "ztCount": 47
    },
    "parts": { "trend": 40, "breadth": 18, "vol": 4 },
    "evidence": [
      { "k": "指数站上MA20", "v": "3421.5 > 3380.2", "ok": true },
      { "k": "市场宽度", "v": "58%", "ok": true }
    ],
    "invalidIf": [
      { "id": "E1", "desc": "指数跌破MA20", "metric": "close", "op": "<", "ref": "ma20" },
      { "id": "E2", "desc": "宽度低于40%", "metric": "breadth", "op": "<", "value": 0.40 }
    ]
  },

  "candidates": [
    {
      "code": "600986", "name": "浙文互联", "dir": "up",
      "reason": "站上MA20且放量",
      "invalidIf": [{ "id": "C1", "desc": "跌破MA20", "metric": "close", "op": "<", "ref": "ma20" }]
    }
  ],

  "scenario": {
    "optimistic":  { "cond": "指数涨>0.8% 且 宽度>55%", "plan": "顺势持有，不追高" },
    "neutral":     { "cond": "指数振幅<0.8%",          "plan": "观察为主，不加仓" },
    "pessimistic": { "cond": "指数跌>0.8% 或 宽度<40%", "plan": "降仓，不接反弹" }
  },

  "reconcile": null
}
```

### 字段约束

| 字段 | 必填 | 约束 |
|---|---|---|
| `date` | ✅ | 唯一键，同一天只允许一条 |
| `targetDate` | ✅ | 下一个交易日。周五 → 下周一；需跳过节假日（用简表，见 §S1 附注） |
| `env.verdict` | ✅ | 枚举 `attack`/`wait`/`defend` |
| `env.confidence` | ✅ | **一期固定 `null`**。不许填假数值——要么真算，要么明说没有 |
| `env.parts` | ✅ | 三个分项必须与 `score` 自洽：`sum(parts) == score`（允许 ±1 取整误差） |
| `env.evidence` | ✅ | 1~3 条，多于此说明结论不够收敛 |
| `env.invalidIf` | ✅ | **不得为空**。没有失效条件的判断是不可证伪的，不许入库 |
| `candidates` | ✅ | 0~`config.predict.candidateCount` 条；允许为空（无候选也是一种判断） |
| `scenario` | ✅ | 三情景齐全 |
| `reconcile` | ✅ | 初始 `null`，次日回填 |

### `invalidIf` 的判据 DSL

统一结构，对账时逐条求值：

```jsonc
{ "id": "E2", "desc": "人读描述", "metric": "<指标>", "op": "<比较符>", "value": 0.40 }
{ "id": "E1", "desc": "...",     "metric": "<指标>", "op": "<比较符>", "ref": "ma20" }
```

- `metric` 取值：`close` / `ma20` / `ma60` / `ret20` / `breadth` / `volRatio` / `ztCount` / `strongRatioProxy`（个股级另有 `chg` / `close`）
- `op` 取值：`<` `<=` `>` `>=`
- 二选一：`value`（常量）或 `ref`（同日其他 metric 值）

**禁止**在 `invalidIf` 里放模糊描述（如"市场转弱"）。无法计算的条件等于没有条件。

---

## S3 · 对账结果

内嵌于 S2 的 `reconcile` 字段，**不单独存文件**。理由：对账与预判是一对一，分开存会产生孤儿记录。

```jsonc
"reconcile": {
  "schema": 1,
  "reconciledAt": "2026-11-16T08:45:00.000Z",
  "actual": {
    "idxChg": -0.62,
    "breadth": 0.34,
    "snapshotCount": 5310,
    "ztCount": 21
  },
  "envResult": {
    "hit": false,
    "verdictExpected": "attack",
    "actualDirection": "down",
    "invalidHits": ["E2"]
  },
  "candResults": [
    { "code": "600986", "chg": -2.1, "hit": false, "invalidHits": ["C1"] }
  ],
  "candHitRatio": 0.25,
  "attribution": "env",
  "judgmentScore": 13,
  "skipped": false,
  "skipReason": null
}
```

| 字段 | 说明 |
|---|---|
| `actualDirection` | `idxChg > 0.5` → `up`；`< -0.5` → `down`；否则 `flat` |
| `invalidHits` | 命中的失效条件 id 列表。**即使 hit=true 也要输出**（可能环境对了但某条失效条件也触发了） |
| `attribution` | `env`/`candidate`/`timing`/`hit`（二期加 `direction`） |
| `judgmentScore` | 0~100，见 `03` 文档 §3.4 |
| `skipped` | `true` 时该日不进统计 |
| `skipReason` | `no_snapshot` / `incomplete` / `no_prediction` |

---

## S4 · 板块字典

**路径**：`data/sectors/dict.json`（覆盖写，每日更新）

```jsonc
{
  "schema": 1,
  "updatedAt": "2026-11-13T08:40:00.000Z",
  "source": "em-clist",
  "sectors": [
    { "code": "BK0475", "name": "银行", "type": "industry", "stockCount": 42 },
    { "code": "BK0896", "name": "白酒", "type": "concept",  "stockCount": 20 }
  ]
}
```

`type` 枚举：`industry`（行业）/ `concept`（概念）。**两者分开统计，不许混在一张榜里**——混了会让"概念炒作"和"行业基本面"互相污染。

---

## S5 · 板块成分

**存储**：`ql.duckdb` → `sector_member` 长表（每板块 × 每成分股 一行）
**写入方**：cron

**为什么按月分片且每天存一份**：板块成分会变（调样、新增概念）。对账必须用**当日**的成分，不能用今天的成分去解释一个月前的板块表现。

```jsonc
{
  "schema": 1,
  "date": "2026-11-13",
  "sector": "BK0475",
  "members": ["600036", "601398", "..."],
  "count": 42
}
```

**注意**：一天 ~500 板块 × 平均 40 只 ≈ 20000 个代码，单日约 600KB。一年 150MB。若过大，可只存发生变化的板块（与上一日 diff），但**必须在字段里标记是全量还是增量**（`mode: "full" | "delta"`）。

---

## S6 · 板块日度强度

**存储**：`ql.duckdb` → `sector_strength`（结构化列 + `payload JSON`）
**写入方**：cron

```jsonc
{
  "schema": 1,
  "date": "2026-11-13",
  "sector": "BK0475",
  "name": "银行",
  "type": "industry",
  "score": 78.4,
  "grade": "A",
  "parts": { "momentum": 82.1, "funds": 74.5, "breadth": 68.0, "continuity": 85.0 },
  "metrics": {
    "ret5": 0.032, "ret20": 0.081,
    "amountPctile": 0.72, "volRatio": 1.24,
    "netInflowPctile": 0.68,
    "upRatio": 0.71, "ztCount": 3,
    "daysAboveMa20": 14
  },
  "degraded": false,
  "degradeReason": null
}
```

`grade` 枚举：`A` 主攻 / `B` 蓄势 / `C` 修复 / `D` 退潮。判定规则见 `04` 文档 §2.3。

`degraded=true` 表示资金因子缺失降级（净流入取不到），必须在 UI 标注。

---

## S7 · 观察池条目

**路径**：`data/watchpool/pool.jsonl`（全量重写，常驻约 200 条）

```jsonc
{
  "schema": 1,
  "code": "600986",
  "name": "浙文互联",
  "state": "ambush",
  "enteredAt": "2026-11-10",
  "stateSince": "2026-11-12",
  "daysInState": 1,
  "daysTotal": 3,
  "maxStay": 15,
  "sector": "BK0896",
  "entryReason": "板块B档 + 评分72 + 缩量回踩MA20",
  "invalidIf": [
    { "id": "W1", "desc": "放量跌破MA20", "metric": "close", "op": "<", "ref": "ma20" }
  ],
  "snapshots": [
    { "date": "2026-11-10", "close": 7.12, "score": 72 },
    { "date": "2026-11-12", "close": 7.28, "score": 74 }
  ],
  "note": ""
}
```

| 字段 | 说明 |
|---|---|
| `state` | `watching` 待观察 / `ambush` 埋伏 / `confirmed` 启动确认 / `holding` 持有 / `removed` 已移出 |
| `daysInState` | 当前状态已停留交易日数。超过 `maxStay` 强制降级 |
| `daysTotal` | 入池总天数。用于统计"平均多久能启动" |
| `snapshots` | 入池后每日收盘价与评分，最多留 60 条（滚动） |
| `note` | 用户手写备注 |

**`removed` 的条目不移出文件**，保留 90 天后清理。理由是移出原因本身是数据资产（见 S8）。

---

## S8 · 状态迁移日志

**路径**：`data/watchpool/transitions.jsonl`（只追加，永不改）

```jsonc
{
  "schema": 1,
  "id": "tr_20261112_600986_ambush",
  "at": "2026-11-12T08:40:00.000Z",
  "code": "600986",
  "from": "watching",
  "to": "ambush",
  "trigger": "shrink_pullback_ma20",
  "evidences": [{ "k": "量比", "v": "0.62" }, { "k": "距MA20", "v": "+1.2%" }],
  "reason": null
}
```

**移出必须带 `reason`**，四选一枚举：

| reason | 含义 | 用途 |
|---|---|---|
| `logic_broken` | 逻辑破了（跌破失效条件） | 说明判断条件设对了 |
| `too_slow` | 触发太慢（超最长停留） | 说明观察池门槛太松 |
| `replaced` | 被更好的标的替代 | 中性 |
| `wrong` | **我判断错了** | 最有价值：语料库原料 |

**`wrong` 的样本是判断力画像的核心输入**。绝大多数交易者只有买入记录，没有"我为什么放弃"的记录，后者才是提高判断力的样本。

---

## S9 · 策略定义

**路径**：`data/strategies/defs.jsonl`

```jsonc
{
  "schema": 1,
  "id": "st_ma_break",
  "name": "均线突破",
  "type": "formula",          // formula | python
  "version": 3,
  "createdAt": "2026-11-20T00:00:00.000Z",
  "source": "MA20:MA(C,20);\nBUY:CROSS(C,MA20);",
  "params": { "n": 20 },
  "outputLine": "BUY",        // 哪个输出线作为信号
  "status": "active",         // draft | testing | active | suspect | retired
  "note": ""
}
```

| 字段 | 说明 |
|---|---|
| `type` | `formula` 通达信源码 / `python` Python 脚本 |
| `version` | 每次改源码 +1，旧版本保留在 archives |
| `outputLine` | 公式可能有多条输出线，必须显式指定哪条是买卖信号，不许自动猜 |
| `status` | `suspect` = 实盘跟踪偏离回测过大，自动降级；`retired` = 手动停用 |

---

## S10 · 验证档案（五道闸）

**存储**：`ql.duckdb` → `strategy_gate`（结构化列 + `payload JSON`）
**写入方**：cron（跑闸后落库）

```jsonc
{
  "schema": 1,
  "strategyId": "st_ma_break",
  "version": 3,
  "date": "2026-11-20",
  "verdict": "usable",        // usable | doubtful | unusable
  "gates": {
    "future": { "pass": true,  "findings": [] },
    "isOos":  { "pass": true,  "is": { "ret": 0.31, "dd": 0.12 }, "oos": { "ret": 0.18, "dd": 0.15 }, "decay": 0.42 },
    "universe": { "pass": true, "tested": 120, "positive": 78, "positiveRatio": 0.65 },
    "phase":  { "pass": true,  "bull": 0.28, "bear": -0.05, "range": 0.09 },
    "dual":   { "pass": null,  "reason": "仅公式版，无双轨" }
  },
  "metrics": { "trades": 84, "winRate": 0.52, "avgWin": 0.041, "avgLoss": -0.023, "sharpe": 1.12, "maxDD": 0.18 }
}
```

`verdict` 判定：五道闸全 `pass=true` → `usable`；任一 `pass=false` → `unusable`；有 `pass=null`（无法检验）→ `doubtful`。

**`null` 不等于 `true`**。这是从 tdx-backtest 学到的：它的 `SKIPPED` 状态容易被当成通过。

---

## S11 · 策略信号

**存储**：`ql.duckdb` → `strategy_signal`（每策略 × 每天 × 每标的 一行，`payload` 含 track）
**写入方**：cron

```jsonc
{
  "schema": 1,
  "date": "2026-11-13",
  "strategyId": "st_ma_break",
  "version": 3,
  "signals": [
    {
      "code": "600986",
      "action": "buy",           // buy | sell
      "price": 7.46,             // 信号日收盘价（不是成交价）
      "track": {
        "t1": { "chg": 0.021, "hit": true },
        "t5": { "chg": -0.013, "hit": false },
        "t10": null
      }
    }
  ],
  "scanned": 5342,
  "hitCount": 1
}
```

**口径关键**：
- `price` 是**信号日收盘价**，用于计算后续收益。
- `track.tN` 是**信号后第 N 个交易日**相对 `price` 的涨跌（不是 N 个自然日）。
- `t5` 在信号后第 5 个交易日收盘后回填；`t10` 同理。未到期为 `null`。
- `hit` 判定：buy 信号 `chg > 0` 为 true。sell 信号暂无（A 股只做多）。

---

## S12 · 信号跟踪

**存储**：**不单独建表**，内嵌于 S11 的 `payload.track`。理由：与信号是一对一，分开存会产生孤儿记录。

**回填规则**：

| 字段 | 回填时机 | 未到期 | 到期但无数据 |
|---|---|---|---|
| `track.t1` | 信号后第 1 个交易日收盘 | `null` | `null` + `reason: 'no_data'`（停牌/退市） |
| `track.t5` | 第 5 个交易日收盘 | `null` | 同上 |
| `track.t10` | 第 10 个交易日收盘 | `null` | 同上 |

```jsonc
"track": {
  "t1":  { "chg": 0.021, "hit": true },
  "t5":  { "chg": -0.013, "hit": false },
  "t10": null
}
```

**回填任务**：`daily-close.js` 每次运行时，回填所有「到期但未填」的记录（不只回填今日的）。
查询条件：`track.tN IS NULL AND 信号日 + N 个交易日 <= today`。

**为什么必须回填历史**：漏跑一次任务就永久缺一条跟踪——而"实盘 vs 回测"对比线断了就失去意义。所以回填要**幂等且补漏**。

---

## S13 · 判断力画像（不持久化）

实时聚合 S2/S3 得出，不进文件。理由：聚合逻辑可能反复调整，持久化会让历史数据与新口径混在一起。

```jsonc
{
  "sampleDays": 20,
  "sufficient": true,
  "envHitRate": 0.55,
  "candHitRate": 0.48,
  "avgJudgmentScore": 51.5,
  "byState": {
    "attack": { "n": 8, "envHitRate": 0.75 },
    "wait":   { "n": 7, "envHitRate": 0.43 },
    "defend": { "n": 5, "envHitRate": 0.40 }
  },
  "byAttribution": { "hit": 11, "env": 9, "candidate": 0, "timing": 0 },
  "byWeekday": { "1": 0.6, "2": 0.5, "3": 0.4, "4": 0.7, "5": 0.5 },
  "streak": { "current": 2, "max": 5, "type": "hit" },
  "note": "样本 20 天，可作初步参考"
}
```

`byWeekday` 与 `streak` 是可选分析项，不影响核心判定，可后加。

---

## 附注 · 交易日历

`targetDate` 需要"下一个交易日"。

**首选方案（有本地库时）：数据驱动**

```js
// tdx-backtest 的 data/market.db 里 kline_daily 的 MAX(date) 就是真实最新交易日
async function latestTradingDay() {
  const d = await duckLatestDate();        // SELECT MAX(date) FROM kline_daily
  if (d) return d;                         // 数据事实，绝不猜错
  // 降级见下
}
```

**理由**：节假日调休规则每年变，手工维护的表必出错；`MAX(date)` 是数据本身的事实。
**这条替代了原先的手工方案**（保留在下方作为降级路径）。

**降级 1：网络取指数最后一根 K 线的日期**

**降级 2：手工表**（仅当本地库与网络都不可用，约 11 条/年）：

```json
{ "schema": 1, "year": 2026, "days": ["2026-01-01", "2026-02-17", "2026-10-01"] }
```

**校验**：生成 `targetDate` 后检查是否在节假日列表里，在则继续 +1。

---

## 附注 · 本地库数据质量（实测）

`market.db` 的 `kline_daily` 中，**部分行 `amount = 0`**（实测上证指数 20261111 那行，`volume` 正常但 `amount` 为 0）。

因此：

| 用途 | 用什么 |
|---|---|
| 量能类指标（`volRatio`） | **用 `volume`**，不要用 `amount` |
| 若必须用 `amount` | 先校验 `amount > 0`，否则标记缺失（**不许当 0 参与计算**） |

不要把 0 当有效值算进分位或均值——这会静默拉低整段统计。

详见 `09-data-access.md` §8.5。

---

## 附注 · 体积与清理策略

| 数据 | 存储 | 年增量 | 保留策略 |
|---|---|---|---|
| 快照 | ql.duckdb | 133 万行 ≈ 20~30MB（压缩后） | 永久（对账依据） |
| 预判卡 + 对账 | ql.duckdb | ~2MB | 永久 |
| 板块成分 | ql.duckdb | 500 万行 ≈ 60MB | 保留 2 年，之后按季归档 |
| 板块强度 | ql.duckdb | ~5MB | 永久 |
| 策略信号 | ql.duckdb | ~20MB | 保留 2 年 |
| 观察池 + 迁移日志 | jsonl | ~600KB | 永久（语料库，是小样本金矿） |
| 策略定义 | jsonl | <1MB | 永久 |
| **合计** | | **约 100~150MB/年** | 三年内 < 500MB |

单文件 `ql.duckdb` 完全可控，不需要自动清理机制。提供 `tools/archive.js` 手动归档旧年份。

**注意**：`ql.duckdb` 与上游 `market.db` 是**两个文件**，前者百MB级、后者 38.5GB。
若发现 `ql.duckdb` 体积异常增大，多半是误把 K 线写进了自己的库——**K 线属于上游库，不归我们存**。
