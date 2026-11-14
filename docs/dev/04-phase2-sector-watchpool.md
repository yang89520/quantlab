# 04 · 二期：板块对账 + 观察池

**工期**：11.5 人日 ｜ **依赖**：一期完成（需要 S1 快照与 S2 预判卡）

---

## 1. 本期解决什么

一期只回答「市场看对了没、选股选对了没」。二期补上中间那一环：

- **什么好什么不好** → 板块强度榜（S6）
- **错在方向还是标的** → 归因增加 `direction` 一段
- **什么值得埋伏** → 观察池状态机（S7/S8）

**开工前置条件**：数据源已实测完毕（见 `10-data-source-playbook.md`），**不存在"先验证再决定"的环节**，直接按本文方案实施。

---

## 2. 板块强度

### 2.1 数据从哪来（已实测确定，不要再验证）

| 数据 | 主源 | 备源 | 说明 |
|---|---|---|---|
| 行业板块列表（49 个） | 新浪 `newSinaHy.php` | 东财 clist t:2 | 板块代码用新浪的 `new_*` |
| 概念板块列表（172 个） | 新浪 `newFLJK.php?param=class` | 东财 clist t:3 | `gn_*` |
| 板块成分股 | 新浪 `getHQNodeData?node=` | 东财 `fs=b:BKxxxx` | 可分页，最大板块 <100 只 |
| **板块 K 线** | **本地聚合**（成分股日线 → 等权指数） | — | **上游没有任何源提供** |
| 主力净流入 | 东财 f62（间歇可用） | — | 取不到就走降级口径 |

**三条必须记住的实测结论**：

1. **东财是"间歇可用"不是"挂了"**——同一接口 5 分钟内可从 200 变 000。绝不能当主源或兜底。
2. **板块 K 线必须自己算**——东财 `push2his` 整域不可用，新浪无此接口。用上游 `market.db` 的个股日线聚合（算法见 `10` §3.3）。
3. **板块代码统一用新浪体系**，东财 `BK****` 只作增强字段的关联键，**不作主键**（换主源会导致历史数据全对不上）。

### 2.2 板块四因子（JS 实现）

在 `lib/sector.js` 里纯函数实现，**不触网**，与 `judgeEnv` 同样的可单测标准。

**输入**：一批板块的**聚合日线**（由 `aggregate.js` 从成分股算出）+ 成分股快照。

> **与原计划的差异**：原计划从上游取板块 K 线，现改为本地聚合。四因子的**算法完全不变**，
> 只是序列来源不同。唯一受影响的是「资金」因子——东财 f62 间歇不可用，默认走降级口径。

```js
// 单个板块的原始特征
function extractFeat(sectorBars, members, snapshot) {
  const close = sectorBars.map(r => r[2]);
  const vol   = sectorBars.map(r => r[5]);
  const n = close.length;

  const ret5  = close[n-1] / close[n-6]  - 1;      // 需 n>=21
  const ret20 = close[n-1] / close[n-21] - 1;
  const ma20  = mean(close.slice(n-20));
  const vol5  = mean(vol.slice(n-5));
  const vol20 = mean(vol.slice(n-20));
  const volRatio = vol5 / vol20;

  // 宽度：成分股上涨占比 + 涨停加成
  const chgs = members.map(c => snapshot.stocks[c]?.c).filter(v => v != null);
  const upRatio = chgs.length ? chgs.filter(v => v > 0).length / chgs.length : null;
  const zt = members.filter(c => {
    const s = snapshot.stocks[c];
    return s && isLimitUp(c, s.c);
  }).length;

  // 持续性：近 20 日站上 MA20 的天数
  let above = 0;
  for (let i = n - 20; i < n; i++) {
    const m = mean(close.slice(Math.max(0, i - 19), i + 1));
    if (close[i] > m) above++;
  }

  const amountPctile = /* 当日成交额在本板块近 250 日中的分位 */;

  return { ret5, ret20, volRatio, upRatio, ztCount: zt, daysAboveMa20: above, amountPctile, close: close[n-1], ma20 };
}
```

**四因子合成**（在整批板块内算分位，所以必须批量算，不能单板块算）：

```js
// 1. 动量 35%
mixRet    = 0.40 * ret5 + 0.60 * ret20          // 偏中期，避免被单日异动带偏
momentum  = pctile(allMixRet, mixRet) * 100     // 0~100

// 2. 资金 25%
volScore  = clamp((volRatio - 0.5) / 1.0, 0, 1) * 100
if (netInflowPctile != null) {
  funds = 0.45 * amountPctile*100 + 0.25 * volScore + 0.30 * netInflowPctile*100
} else {
  funds = 0.70 * amountPctile*100 + 0.30 * volScore      // 降级口径，必须标 degraded
}

// 3. 宽度 20%
breadth = (upRatio == null ? 50 : upRatio * 100) * 0.8
        + Math.min(ztCount / 5, 1) * 100 * 0.2           // 5 只涨停记满分

// 4. 持续性 20%
continuity = (daysAboveMa20 / 20) * 100

score = 0.35*momentum + 0.25*funds + 0.20*breadth + 0.20*continuity
```

**关键实现要求**：

1. `pctile` 的分位是**在当日所有参评板块内**算的，不是跨日算。所以必须先收集全部板块的 `mixRet`，排序，再逐个取值
2. `amountPctile` 是**单个板块自身的历史分位**（今日成交额在该板块近 250 日的分位），与上面不同维度，别搞混
3. 净流入取不到时 `funds` 用降级口径，**必须置 `degraded=true` 并写入 `degradeReason`**
4. `upRatio == null`（成分股全无数据）时用中性值 50，并记为降级
5. 参评板块不足 10 个时**不评分**，抛错——分位在小样本上没有意义

### 2.3 ABCD 分档

```js
if (momentum >= 80 && funds >= 70)                    grade = 'A';   // 主攻
else if (momentum >= 80 && funds <  70)               grade = 'B';   // 蓄势
else if (close < ma20 && momentum < 40)               grade = 'D';   // 退潮
else                                                   grade = 'C';   // 修复
```

**判定顺序不能换**：D 的条件要放在 A/B 之后判断，否则「动量低但已跌破 MA20」会被误判。

`grade` 语义（写进 UI 文案，不要自创）：

| 档 | 名称 | 含义 | 动作提示 |
|---|---|---|---|
| A | 主攻 | 动量与资金共振 | 联动优先级最高 |
| B | 蓄势 | 动量强但量能未确认 | 等放量 |
| C | 修复 | 低位企稳或趋势未明 | 仅观察 |
| D | 退潮 | 跌破 20 日线且动量衰减 | 不接力 |

### 2.4 行业与概念必须分开排榜

`type` 为 `industry` 与 `concept` 的板块**分两张榜**，绝不混排。

理由：行业是基本面分类（银行、白酒），概念是题材炒作（AI 算力、机器人）。混在一起算分位，会让"概念暴涨"把真实行业板块的相对强度压下去，判断失真。

---

## 3. 板块对账（归因增加 `direction`）

### 3.1 预判阶段的新增内容

一期预判卡增加 `mainline` 字段（在 `predict.js` 里生成）：

```jsonc
"mainline": {
  "sectors": [
    { "code": "BK0475", "name": "银行", "grade": "A", "score": 78.4, "expect": "continue" }
  ],
  "invalidIf": [
    { "id": "M1", "desc": "A档板块次日平均涨幅低于全市场中位数", "metric": "sectorAvg", "op": "<", "ref": "marketMedian" }
  ]
}
```

取 `grade==='A'` 的前 3 个板块，`expect='continue'`（预期延续强势）。

### 3.2 对账阶段

```js
// 目标日：这些板块的涨幅是否仍在全部板块的前 30%？
const ranks = mainline.sectors.map(s => rankInAll(sectorsToday, s.code));  // 百分位
const directionHit = ranks.every(r => r >= 0.70);      // 全部仍在前 30%
```

**归因优先级更新为四段**（`03` 文档 §3.4 的第 5 步整体替换）：

```
if (!envHit)                        → 'env'
else if (mainline && !directionHit) → 'direction'
else if (candHitRatio === null)     → 'hit'
else if (candHitRatio < 0.40)       → 'candidate'
else if (hasSpikeFade)              → 'timing'
else                                → 'hit'
```

**`direction` 必须排在 `candidate` 之前**：方向错了却去怪选股，会让人一直优化选股逻辑而永远修不好——这是归因分析最坑的一种错位。

### 3.3 二期完成后，归因才有完整的指向性

| 归因 | 该改什么 |
|---|---|
| `env` | 改环境判定阈值/维度 |
| `direction` | 改板块强度算法/主线选择 |
| `candidate` | 改选股条件 |
| `timing` | 改买卖点/入场时机 |

四段齐了，"我该改哪一环"才有唯一答案。

---

## 4. 观察池状态机

### 4.1 状态与迁移

```
                    ┌──────────┐
   入池条件满足  →  │ watching │  待观察
                    └────┬─────┘
              缩量回踩MA20 │ 不破
                    ┌────▼────┐
                    │  ambush │  埋伏
                    └────┬────┘
              放量突破前高 │
                    ┌────▼──────┐
                    │ confirmed │  启动确认
                    └────┬──────┘
              次日站稳    │
                    ┌────▼─────┐
                    │ holding  │  持有
                    └────┬─────┘
                         │ 任一失效条件
                    ┌────▼─────┐
                    │ removed  │  移出（必填原因）
                    └──────────┘

任意状态 → removed：失效条件触发 / 超最长停留
```

### 4.2 各状态的判定条件（可计算，不许用模糊描述）

| 迁移 | 条件 | 参数 |
|---|---|---|
| `→ watching` | 板块 `grade ∈ {A,B}` 且 `stockScore >= 70` | `minScore: 70` |
| `watching → ambush` | `close ∈ [ma20*0.98, ma20*1.03]` 且 `volRatio < 0.8` | `bandLow: 0.98, bandHigh: 1.03, shrink: 0.8` |
| `ambush → confirmed` | `close > hhv(high, 20)[前一日]` 且 `volRatio > 1.5` | `breakoutVol: 1.5` |
| `confirmed → holding` | 次日 `close >= confirmed 日收盘 * 0.97` | `holdTol: 0.97` |
| `holding → removed` | `close < ma10` 或 策略 E 类卖出条件 | — |
| `watching → removed` | 板块降 `D` 档 / 超期 10 日 / 失效条件 | `maxStay.watching: 10` |
| `ambush → removed` | 放量跌破 MA20（`close<ma20 && volRatio>1.2`）/ 超期 15 日 | `maxStay.ambush: 15` |
| `confirmed → removed` | 3 日内 `close < 突破日收盘` / 跌破 MA10 | `confirmWindow: 3` |

`stockScore` 复用现有 `public/js/strategies.js` 的综合评分（`QLMount(..., {headless:true}).composite()`），**不要另写一套评分**——两套评分必然打架。

**为什么不用 `tdx-backtest` 的 `stockscore.py` 三因子**（动量40/行业共振30/活跃度30）：

| 问题 | 综合评分 composite | 三因子 stockscore |
|---|---|---|
| 回答什么 | 这只票**当下技术面强不强、有没有买卖点** | 这只票**在全市场横截面上排第几** |
| 数据需求 | 1200 日线 + 周月线（已有） | 全市场 60 日涨幅横截面（要算 5350 只） |
| 适用场景 | 入池判断（要时机） | 板块内横向选股（要相对强弱） |

观察池要的是"**现在能不能动手**"，不是"它在全市场排第几"——所以用 composite 是对的。

> **明确决定：本期不引入三因子**。理由见 `README` §2 的 G4（同一指标只允许一套口径）：
> 若同时存在两套个股评分，用户会问"到底按哪个选"，而两个答案都"有道理"——这正是要避免的。
> 将来若要做"板块内前排个股"（`LINKAGE-DESIGN` 的第 3 步），再单独立项，且必须**只用于横向排序，不参与入池判断**。

### 4.3 状态机实现要求

```js
function evaluate(entry, ctx) {
  // ctx: { bars, snapshot, sectorGrade, stockScore, config }
  // 返回 { nextState, trigger, evidences[], reason? }
}
```

**必须遵守**：

1. **一次只前进一档**：`watching` 不允许直接跳到 `confirmed`，即使条件同时满足。理由：跳档会让"停留时长"统计失真，而那是判断池子质量的核心指标
2. **降级只允许直接到 `removed`**：不设 `ambush → watching` 的回退。退了就是判断错了，该记录原因，不该悄悄回退
3. **每次迁移必须写 S8 日志**，含 `trigger` 与 `evidences`（至少 2 条可追溯的原始值）
4. **`daysInState` 按交易日计**，不是自然日

### 4.4 移出原因四选一（强制）

```js
reason ∈ ['logic_broken', 'too_slow', 'replaced', 'wrong']
```

| 原因 | 含义 | 系统判断依据 |
|---|---|---|
| `logic_broken` | 失效条件触发 | 自动判定 |
| `too_slow` | 超最长停留 | 自动判定 |
| `replaced` | 被更好标的替代 | **需人工确认** |
| `wrong` | 我判断错了 | **需人工确认** |

系统自动判定只产出前两种。后两种在 UI 上由用户点选，**必须选，不允许跳过**——否则语料库缺失最关键的一类。

**为什么 `wrong` 最重要**：绝大多数交易者只有买入记录，没有"我为什么放弃"的记录。后者才是能提高判断力的样本。这一条是整个观察池的数据价值所在，实现时不许省。

### 4.5 池子容量上限

`config.watchpool.maxSize`（默认 30）。

入池时若已满：**不允许自动踢出**，而是提示"池已满，请先处理"。理由：自动踢出会让人失去对池子的掌控感，且踢掉的可能正是最好的那个。

---

## 5. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sector/strength?type=industry` | 板块强度榜（按 grade 排序） |
| GET | `/api/sector/:code` | 单板块详情（因子拆解 + 成分股） |
| GET | `/api/sector/history?days=20` | 板块强度历史（用于看轮动） |
| GET | `/api/watchpool` | 观察池全量（按 state 分组） |
| POST | `/api/watchpool` | 加标的 `{ code }` |
| PATCH | `/api/watchpool/:code` | 改状态/备注 `{ state?, note?, reason? }` |
| DELETE | `/api/watchpool/:code` | 移出 `{ reason }` |
| GET | `/api/watchpool/transitions?code=` | 迁移历史 |

---

## 6. 调度

**二期不新增 cron 条目**，全部串在 `daily-close.js` 内部按序执行（少一次进程启动，且顺序有保证）：

```
daily-close.js（每个交易日收盘后一次）
  1. 交易日 / 指数 K 线 / 全市场快照
  2. 板块强度计算        ← 二期新增，**必须早于对账**
  3. 对账（昨日预判 vs 今日实际，含 direction）
  4. 生成今日预判卡（含 mainline）
  5. 观察池状态机推进    ← 二期新增
  6. 策略信号扫描        ← 三期新增，**必须早于回填**
  7. 持仓风险扫描留痕    ← 四期新增
  8. 信号跟踪回填 + 策略自动降级  ← 三期新增
  9. 摘要
```

> 2026-11-14 补齐：原文把三期内容合并写成「信号跟踪回填 + 策略自动降级」一步，
> 实际实现拆成了「先扫信号、再回填」两步——同一天先有信号才谈得上回填，
> 合在一起会让当天新产生的信号要等第二天才被记录。
> 持仓风险留痕（步骤 7）是四期 ⑤ 风险格要「昨日→今日」对比才加的，
> 数据落 `meta` 表 `risk.YYYY-MM-DD`，不单独建表。

**三条顺序约束，方向不同，别搞混**：

| 约束 | 原因 |
|---|---|
| 对账 **在** 预判之前（步骤 3 → 4） | 对账要用昨日预判与今日实际，先生成新预判会覆盖上下文 |
| 板块强度 **在** 预判之前（步骤 2 → 4） | 预判卡的 `mainline` 字段依赖当日板块强度榜 |
| 板块强度 **在** 对账之前（步骤 2 → 3） | `direction` 归因要用**目标日板块榜**判断昨日 A 档是否仍在前 30%；排在对账之后会拿不到当日榜单，`directionHit` 只能恒为 null |

> 实现修正说明：本文初版把板块排在对账之后，只考虑了 `mainline` 对预判的依赖。
> 二/三期落地时发现 `direction` 对账同样依赖当日榜单，故把板块强度提前到对账之前。
> 两条「在预判之前」的约束依然成立，三者并不矛盾。

**板块段不作为独立 cron 条目**。`--skip-sector` 用于调试时跳过重新采集、直接读库内已有榜单：

```bash
node tools/daily-close.js                  # 完整闭环（含板块采集）
node tools/daily-close.js --skip-sector    # 用已有板块榜重跑，省一次全量采集
node tools/sector-report.js --capture      # 单独重跑板块采集并出人读报告
```

**不设 16:40 的第二条 cron**：两次独立进程跑会有竞态（16:35 那次可能还没写完，16:40 就起来读），且板块数据本身也是 16:35 那次拉快照时的同一批数据，没必要分两次拉。

---

## 7. 测试清单

### 7.1 单元测试

| 用例 | 期望 |
|---|---|
| **聚合：3 只成分股日涨跌 [1%, 2%, 3%]** | 板块日涨跌 = 2%（等权均值） |
| **聚合：某日 2 只停牌只剩 3 只有效** | 分母为 3，且若 <5 标记 `insufficient` |
| **聚合：首日指数 = 1000** | 基准值固定，便于跨板块比较 |
| 四因子合成：动量 80 / 资金 70 | grade=A |
| 动量 80 / 资金 69 | grade=B |
| 动量 30 且 close<ma20 | grade=D |
| 动量 30 但 close>ma20 | grade=C |
| 净流入缺失 | `degraded=true`，funds 用降级口径 |
| 参评板块 8 个 | 抛错（不足 10） |
| 板块分位：3 个板块 mixRet=[1,2,3] | 分位分别 ≈ 33/66/100 |
| 观察池 `watching→ambush`：close=ma20*1.01, volRatio=0.7 | 迁移 |
| 观察池 `watching→ambush`：volRatio=0.9 | **不迁移** |
| 观察池一次跳两档：条件全满足 | **只前进一档** |
| 超期：daysInState=11 (max=10) | → removed, reason=too_slow |
| 池满 30 再加 | 拒绝，不踢人 |

### 7.2 集成测试

| 用例 | 期望 |
|---|---|
| 东财全不可用 | 主源新浪照常出数；资金因子 `degraded=true`；不抛错 |
| 板块对账：A 档板块次日全部跌出前 30% | attribution=direction |
| 板块对账：env 错且 direction 也错 | attribution=**env**（优先级测试） |

### 7.3 变异验证

| 变异 | 应被抓住 |
|---|---|
| 把 `direction` 判定挪到 `candidate` 之后 | 归因优先级用例 |
| 删掉 `degraded` 标记 | 降级用例 |
| 状态机允许跳档 | 跳档用例 |
| 超期不处理 | 超期用例 |
| 行业/概念混排 | 分榜用例（加一条断言：榜内 type 唯一） |

---

## 8. 验收

> 2026-11-14 核验：以下各项已实测（板块档位分布来自 `/api/sector/strength` 当日真实数据）。

- [x] 板块强度榜可用，A/B/C/D 四档都有实际板块（221 个：A 8 / B 37 / C 89 / D 87）
- [x] 行业榜与概念榜分开，榜内 `type` 唯一
- [x] `degraded` 板块在 UI 有可见标记（`degradeReason` → 灰色角标「资金数据缺失」）
- [x] 观察池能自动迁移，且每步有日志（S8 迁移日志带 `tr_YYYYMMDD` 主键）
- [x] 移出必须选原因，跳过则报错（`POST /api/watchpool/remove` 未传原因返回 400）
- [x] 归因出现 `direction`，且优先级正确
- [x] `npm test` 26 项仍全绿

---

## 9. 任务拆解

| # | 任务 | 依赖 | 人日 |
|---|---|---|---|
| T1 | `lib/sources/` 注册表 + 健康层 + 熔断 + 配速；新浪/东财适配器 | — | 1.5 |
| T2 | `sectordata.js` 板块字典/成分采集 + **`aggregate.js` 板块K线聚合** | T1 | 2.0 |
| T3 | `sector.js` 四因子 + ABCD + 单测 | T2 | 2.0 |
| T4 | 板块对账 + 归因加入 `direction` | T3,一期 T4 | 1.5 |
| T5 | `watchpool.js` 状态机 + 单测 | 一期 T4 | 2.0 |
| T6 | 观察池接口 + 迁移日志 | T5 | 1.0 |
| T7 | `daily-close.js` 串入板块与观察池 | T3,T5 | 0.5 |
| T8 | `sector-report.js` + 测试 | 全部 | 1.0 |
