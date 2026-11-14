# 07 · 测试与验收总纲

> 各期的具体用例写在对应文档里。本文规定**跨期的测试原则、夹具设计、回归要求**。

---

## 1. 核心原则：测试跑通不等于有效

一条测试如果改坏了代码仍然是绿的，它就是废物。

**本项目所有断言必须满足：把被测逻辑改错，它必须变红。**

这条不是口号，要求做到：

| 要求 | 具体做法 |
|---|---|
| 每个新增模块必须附变异清单 | 在 PR 描述里列出"改坏什么，哪条用例会红" |
| 变异验证在独立副本上做 | 不污染工作区（参考现有 `tools/smoke.js` 的 `--mutate` 思路） |
| 变异必须只打中它该打中的 | 若改一处导致 10 条红，说明断言粒度太粗 |

**为什么强调这条**：tdx-backtest 有 1078 个测试，但本仓接手时发现它的 `temperature.py` 里 `zone` 与 `state` 两套阈值分档，测试全绿却没发现自相矛盾——因为测试只验证"函数返回了三态之一"，没验证"两套口径一致"。

---

## 2. 四层测试结构

| 层 | 范围 | 何时跑 | 依赖 |
|---|---|---|---|
| L1 纯函数单测 | `judgeEnv` / `attribute` / `evalInvalidIf` / 四因子 / 状态机迁移 | 每次改动 | 无网络、无文件 |
| L2 模块集成 | 快照落盘→读回、JSONL upsert 幂等、对账回填 | 每次改动 | 本地文件 |
| L3 端到端 | `daily-close.js` 全流程 | 每日 / 发版前 | 真实上游 |
| L4 变异验证 | 改坏副本、断言必须红 | 每期交付前 | — |

### 2.1 L1 是主力

一、二期算法全部应可纯函数化。**如果一个逻辑无法纯函数测试，说明它耦合了 IO，应重构**。

必须抽成纯函数的：

```js
predict.judgeEnv(bars, snapshot, config)
reconcile.attribute(envHit, candHitRatio, candResults, config)
reconcile.evalInvalidIf(list, metrics)
sector.extractFeat(bars, members, snapshot)
sector.grade(momentum, funds, close, ma20, config)
watchpool.evaluate(entry, ctx)
judgment.aggregate(records, config)
```

### 2.2 L3 允许不稳

端到端依赖真实上游，可能因网络失败。**处理方式**：

- L3 失败时先判断是"代码问题"还是"环境问题"
- 在输出里显式分组标注（参考现有 `tools/smoke.js` 的 `[纯函数]` / `[接口]` 分组）
- `npm test --offline` 只跑 L1/L2，CI 与快速验证用这个

---

## 3. 测试夹具设计

### 3.1 目录

```
tests/
├── fixtures/
│   ├── bars-normal.json        1200 根正常 K 线
│   ├── bars-short.json         50 根（不足）
│   ├── bars-gap.json           含整年缺口
│   ├── snapshot-full.json      5342 只
│   ├── snapshot-partial.json   1200 只（不完整）
│   ├── pred-attack.json        昨日预判卡（进攻）
│   ├── pred-defend.json        昨日预判卡（防守）
│   └── pred-nocand.json        无候选的预判卡
├── unit/                       L1
├── integration/                L2
└── mutate/                     变异验证脚本
```

### 3.2 夹具必须覆盖的边界

| 边界 | 夹具 | 用途 |
|---|---|---|
| K 线不足 | `bars-short` | 验证"至少需要 N 根"的报错 |
| 数据缺口 | `bars-gap` | 验证清洗层与质量标记 |
| 快照不完整 | `snapshot-partial` | 验证门禁 `skipped=true` |
| 无候选 | `pred-nocand` | 验证 `candHitRatio=null` 的归因分支 |
| 全空 | 代码生成 | 验证不崩、不返回 0 |
| 首日运行 | 无昨日文件 | 验证「首次运行」不报错 |

**禁止使用真实当日数据做夹具**：明天就变了，测试会无缘无故红。

### 3.3 变异脚本约定

```js
// tests/mutate/run.js
const MUTATIONS = [
  {
    name: '归因删掉 env 分支',
    file: 'lib/reconcile.js',
    from: "if (!envHit) return 'env';",
    to: '',
    expectFail: ['unit/reconcile.test.js → attribute envHit=false'],
  },
  // ...
];
```

要求：
- 每条变异声明**期望被打中的用例**
- 若某条变异没有用例变红 → 报告「断言缺口」
- 若变红的用例超出声明范围 → 报告「断言粒度过粗」

---

## 4. 各期验收清单

### 4.1 一期

- [ ] 首次运行生成快照（count≥4000）与 1 条预判卡
- [ ] 幂等：重复运行预判行数不变
- [ ] 对账：构造昨日预判 + 今日快照 → `reconcile` 非空
- [ ] 门禁：快照 1200 只 → `skipped=true`，不入统计
- [ ] 统计分母 = 有效对账日数
- [ ] 样本 <10 时首行提示
- [ ] 变异 6 条全红
- [ ] `npm test` 26 项全绿

### 4.2 二期

- [ ] 板块 A/B/C/D 四档都有实际板块
- [ ] 行业榜与概念榜分开，榜内 `type` 唯一
- [ ] `degraded` 在 UI 可见
- [ ] 观察池自动迁移且每次有 S8 日志
- [ ] 移出强制选原因
- [ ] 归因出现 `direction` 且优先级在 `candidate` 之前
- [ ] 变异 5 条全红
- [ ] 一期验收全部仍通过（**不允许退化**）

### 4.3 三期

- [ ] BOLL 公式（含 `STD`）跑通
- [ ] 未定义标识符抛错并提示近似名
- [ ] 动态检测抓住「中间变量藏未来」
- [ ] 五道闸三档，`null` 不等于通过
- [ ] Python 不可用时服务照常启动
- [ ] 120s 超时强杀
- [ ] 策略可自动降级 `suspect`
- [ ] 变异 5 条全红
- [ ] 一、二期验收全部仍通过

### 4.4 四期

- [ ] 五页导航可达，主入口视觉区分
- [ ] 七格四件套完整
- [ ] 三种状态正确呈现
- [ ] 移出强制原因
- [ ] `!` 与 `✓` 视觉区分
- [ ] 下钻可返回原位置
- [ ] 移动端 375px 七格结论 2 屏内
- [ ] 前三期验收全部仍通过

---

## 5. 回归策略

### 5.1 现有 26 项是底线

`tools/smoke.js` 的 26 项断言覆盖了代码空间、K线清洗、形态判定、周期聚合、接口契约。**每期交付前必跑，任何一项红都不许交付。**

只许新增，不许删除或放宽已有断言。

### 5.2 回归套件的扩展方式

新增断言按现有分组约定：

```js
group('[纯函数] xxx');
check('断言描述', () => { ... });
```

**新断言加入前必须做一次变异验证**，否则等于没加。

### 5.3 每期结束的完整回归

```bash
npm test                  # 26 项 + 本期新增
node tests/mutate/run.js  # 变异验证
node tools/daily-close.js --date <历史某日>   # 补跑一天，验证幂等与对账
```

---

## 6. 上线前检查表

| # | 检查 | 判定 |
|---|---|---|
| 1 | 所有断言变异有效 | 变异清单全部按预期变红 |
| 2 | 无静默失败 | `grep -rn "catch {" lib/ \| grep -v "log\."` 应为空 |
| 3 | 无裸阈值 | `grep -rnE "\b(0\.[0-9]+\|65\|35)\b" lib/` 抽查是否都来自 config |
| 4 | 失败非 0 退出 | 手工制造失败，确认 `echo $?` 为 1 |
| 5 | 日志有耗时与结果 | 每次任务有 start/end/ms |
| 6 | `/api/health` 反映真实状态 | `pendingReconcile` 能反映漏跑 |
| 7 | 数据可追溯 | 任取一个结论，能点到原始值 |
| 8 | **无假数据（9 条断言全过）** | 见 `09-data-access.md` §9：无 mock、无常量兜底、取数带元信息、当日不走本地库、缺失返回 null、fixtures 不外泄、降级有标记、不写上游库、自有库可独立运行 |
| 9 | 文档口径与代码一致 | 阈值改过则该文档已同步 |
| 10 | 旧功能未退化 | 上一期验收清单全绿 |

---

## 6.1 数据规则专项验收（每期必跑）

`09-data-access.md` §9 的 9 条断言**优先级高于功能验收**——功能可以少做，假数据一条都不许有。

| # | 断言 | 命令/做法 |
|---|---|---|
| D-1 | 生产代码无 mock/fake/random | `grep -rniE "mock\|fake\|random\|lorem" lib/ tools/` 为空 |
| D-2 | 无静默常量兜底 | 逐个 `catch` 块检查，不许 `return { x: 0.5 }` |
| D-3 | 取数必带元信息 | 断言 `resolve()` 返回值含 `source/level/asOf` |
| D-4 | 当日不走本地库 | mock `dbLatestDate=昨日` + 请求今日 → 断言 `source` 为网络源 |
| D-5 | 缺失返 null 不返 0 | mock 上游全失败 → 断言 `price === null` |
| D-6 | fixtures 不进生产 | `grep -rn "tests/fixtures" lib/` 为空 |
| D-7 | 降级有标记 | 关掉本地库 → 断言 `degraded === true` |
| D-8 | 不写上游库 | 静态检查所有 market.db 连接均带 `readOnly:true`；断言 `ownDb !== marketDb` |
| D-9 | 自有库可独立运行 | `engine=jsonl` 跑完整一期流程不报错 |
| D-10 | 留痕一路到 UI | 断言预判卡含 `integrity.provenance.index/snapshot`；`npm run test:today` 断言状态条含「来源」「时点」及真实日期 |

**D-4 是最重要的一条**：它防的是"拿 T-1 本地数据冒充当日"——这种假数据看起来完全正常，最难发现。

---

## 7. 已知的测试难点与对策

| 难点 | 对策 |
|---|---|
| 对账依赖"昨日"，无法天然构造 | 用夹具 `pred-*.json` 手工构造，不依赖真实历史 |
| 板块分位需要一批板块 | 夹具造 20 个假板块，覆盖各档 |
| 动态未来函数检测需两段数据 | 从 `bars-normal.json` 切前 M 与 M+20 两段 |
| Python 超时测试要等 120s | 测试用 3s 超时（可配），生产用 120s |
| 移动端布局无法自动化 | 人工按 375px 宽度检查 + 截图留档 |
| 归因优先级容易写反 | 专门一组用例，覆盖所有优先级交叉组合 |

**归因优先级的交叉组合必须穷举**（这是最容易出错的地方）：

| envHit | directionHit | candHitRatio | hasSpikeFade | 期望 |
|---|---|---|---|---|
| false | false | 0.9 | false | `env` |
| false | true | 0.1 | true | `env` |
| true | false | 0.9 | false | `direction` |
| true | false | 0.1 | true | `direction` |
| true | true | 0.2 | false | `candidate` |
| true | true | 0.8 | true | `timing` |
| true | true | 0.8 | false | `hit` |
| true | null（二期未上线） | 0.8 | false | `hit` |
