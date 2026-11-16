# 个人投研工作台 · 开发文档集

> 本目录是交给开发的完整规格。**四期全部内容已在此一次性写完**，不存在"待续写"部分。
> 如需变更口径，走 §5 的变更规则，不要各自修改。

---

## 1. 文档地图

| 你想知道 | 看这篇 |
|---|---|
| 这事整体怎么拆、先做什么 | 本文件 §3 |
| **数据能不能用假的 / 从哪取 / 本地库怎么接** | **`09-data-access.md`（强制，优先级最高）** |
| **每个数据源实测能不能用、坏了怎么降级** | **`10-data-source-playbook.md`（实测 + 内化方案）** |
| 为什么用 Node 不用 Python、为什么不改 tdx-backtest | `01-architecture.md` |
| 数据存哪、字段叫什么、一条记录长什么样 | `02-data-model.md` |
| 一期怎么做（预判-验证闭环） | `03-phase1-prediction-loop.md` |
| 二期怎么做（板块对账 + 观察池） | `04-phase2-sector-watchpool.md` |
| 三期怎么做（公式引擎 + 策略实验室） | `05-phase3-strategy-lab.md` |
| 四期怎么做（三入口界面） | `06-phase4-ui.md` |
| 怎么测、怎么算做完 | `07-testing-and-acceptance.md` |
| 有什么风险、排多久、怎么改需求 | `08-risks-roadmap.md` |

**阅读顺序**：先读 `09`（数据规则），再读 `01`（架构），然后按期读。数据规则读漏了，后面全白做。

**上位文档**：`../personal-research-workbench-design.md`（产品设计总纲，讲"为什么"）
本目录讲"怎么做"。两者冲突时，**以本目录为准**，并回头修正上位文档。

---

## 2. 全局硬约束（任何一期都不许违反）

**约束分两组**：D 组是数据铁律（优先级最高，详见 `09-data-access.md`），G 组是工程约束。

### D 组 · 数据铁律

| # | 约束 | 违反了会怎样 |
|---|---|---|
| **D1** | **禁止假数据**：不许模拟、随机、占位、前值顶替。拿不到就返回 `null` 并标记缺失 | 一个假的 `0` 会被算进统计、影响判断，最后变成错误的对账结论，而用户永远不知道从哪一步开始烂的 |
| **D2** | **本地优先**：本项目缓存 → tdx-backtest 本地库 → 网络接口，严格按序 | 白白消耗上游限额，且速度慢 |
| **D3** | **时效优先于本地**：当日行情必须实时获取，**不许用 T-1 本地数据冒充当日** | 这是最危险的假数据形态——因为看起来完全正常 |
| **D4** | **每次取数必须留痕**：记录 `source / level / asOf / stale`，一路传到 UI | 出问题时无法追溯是哪一环取错了数 |

> **D2 与 D3 不冲突**：本地优先只适用于历史数据。当日行情走本地库 = D3 违规。

### G 组 · 工程约束

| # | 约束 | 违反了会怎样 |
|---|---|---|
| G1 | **不修改 `tdx-backtest` 源目录任何文件** | 该目录已有 13 个未提交改动（2026-11-06），再叠加会彻底分不清谁改了什么 |
| G2 | **不复用 `tdx-backtest` 的代码做运行时依赖**（不 `sys.path.append`、不 import）。**但其行情库可只读接入**（见 D2 与 `09` §2/§8） | 路径含中文、依赖独立 venv，代码引用换台机器就废；数据只读接入则安全 |
| G2b | **绝不写上游行情库**：我们的数据只能进 `data/ql.duckdb` 或 `data/*.jsonl`，两者必须是不同文件（启动时断言） | 上游有独立更新引擎每日更新，我们写一行就可能破坏它，且对方无从察觉 |
| G3 | **禁止静默失败**：不许 `catch {}` 空吞，不许"打印错误但 exit 0" | tdx-backtest 有 539 处 `except Exception`、117 处直接 pass，导致判断在模块已挂时照常产出 |
| G4 | **同一指标只允许一套阈值/口径** | 它曾出现温度 `zone`(50/25/10) 与 `state`(15/8) 两套分档，12% 时自相矛盾 |
| G5 | **阈值集中在单一常量表**，每项必须有「初始值 / 依据 / 何时校准」注释 | 后人不知道该不该改，只能猜 |
| G6 | **小样本不下结论**：样本 <10 必须显式提示 | 20 天 70% 就被当成圣杯 |
| G7 | **全链路可追溯**：任取一个结论，能点到原始值 | 只给一个分数，用户无法验证，等于不可信 |
| G8 | **口径变更必须留痕**：改阈值/权重/优先级，记入 `CHANGELOG.md` 并附前后命中率 | 历史数据不可比，对账系统失去意义 |

---

## 3. 四期总览

| 期 | 主题 | 核心交付 | 解决什么问题 | 人日 |
|---|---|---|---|---|
| **一期** | 预判-验证闭环 | 预判卡 + 次日对账 + 归因 + 命中率 | 「什么符合预期什么不符合」——先让判断变成可验证对象 | 8.25 |
| **二期** | 板块与观察池 | 数据源层 + 板块强度 + 板块对账 + 观察池状态机 | 「什么好什么不好」「什么值得埋伏」 | 11.5 |
| **三期** | 策略实验室 | 公式引擎 + 五道闸 + 信号跟踪 | 「我这套方法到底行不行」「什么有买卖点」 | 15 |
| **四期** | 三入口界面 | 今日一页（七格）+ 观察池页 + 实验室页 | 「现在市场怎么样」「未来会怎样」——把结论收敛到一屏 | 15 |
| 合计 | | | | **49.75** |

> 工期以各期「任务拆解」明细逐项加总为准（各期文档末尾有明细表）。粗估与明细冲突时，改粗估。

依赖关系：`一期 → 二期 → 三期`（严格串行，后一期依赖前一期产出的数据）。
`四期` 依赖一期数据模型定型即可并行开工首页骨架，但七格中的 ②③④ 格要等二、三期。

> **一期必须先做，不许跳。** 它不依赖任何新数据源，改动最小，且只有它能立刻回答最难的一问。
> 更重要的是：跑 20 天对账，比任何代码审查都更能暴露已有判断逻辑的问题。

---

## 4. 术语表（全文统一，不要另造词）

| 术语 | 定义 |
|---|---|
| **温度** | 强势股占比。一期为代理口径（当日涨幅≥5%），二三期换真口径（60日涨幅≥15%） |
| **宽度 breadth** | 上涨家数 ÷ 有效标的数 |
| **环境 / env** | 三态判定：`attack` 进攻 / `wait` 观望 / `defend` 防守 |
| **预判卡** | 每个交易日收盘后生成的一条记录，含环境判断、候选、情景、失效条件 |
| **失效条件 invalidIf** | 一条可计算的判据，条件成立即说明原判断错误。**每个判断必须至少有一条** |
| **对账 reconcile** | 次日收盘后，把预判与实际走势比对并打分 |
| **归因 attribution** | 判断错误时，定位错在哪一环：`env` 环境 / `direction` 方向 / `candidate` 标的 / `timing` 时机 / `hit` 正确 |
| **判断力画像** | 分环境状态统计的命中率，回答"我在什么行情下判断得准" |
| **观察池** | 待埋伏标的的生命周期管理，五态状态机（见 04 文档） |
| **闸 gate** | 策略上线前的强制检验，五道，任一道不过不许上线 |
| **双轨** | 同一策略的公式版与 Python 版，必须信号一致率 ≥99% |
| **完整性门禁** | 数据不足时拒绝让结果进入统计，而不是照常算 |
| **七格** | 今日一页的七个结论格（见 06 文档） |

---

## 5. 变更规则

| 场景 | 做法 |
|---|---|
| 发现口径不清 | **先改文档，再改代码**。文档是唯一事实源 |
| 要改阈值 | 只能改 `config.json` 与常量表，且必须在提交信息里写明「原值 → 新值 → 依据」 |
| 要加字段 | 只能新增，不许改名或复用旧字段语义（JSONL 已有历史数据） |
| 要改归因优先级 | 必须同步更新 `03` 文档与对应用例，否则归因结果不可比 |
| 想砍某期的范围 | 记入 `08` 文档的「明确不做」清单，不要默默不做 |
| 两处文档冲突 | 以 `docs/dev/` 为准，修正另一处 |

**schema 版本**：每条持久化记录都带 `schema` 字段。改结构必须 +1，并在 `02-data-model.md` 记录迁移方式。读取端必须容忍旧版本（缺失字段给默认值），不许因为版本旧就崩。

---

## 6. 开发环境

| 项 | 要求 | 现状 |
|---|---|---|
| Node.js | ≥18（本机 22.22.2） | ✅ 已具备 |
| npm | 随 Node | ✅ |
| **DuckDB 客户端** | 一期起需要（读上游行情库 + 写自有 `ql.duckdb`） | ⚠️ 本机**无 duckdb CLI、系统 python3 无 duckdb 模块**；三方案见 `09` §8.7。装不上则 `engine=jsonl` 降级 |
| Python 3 | 三期需要，≥3.10；若走 DuckDB 方案 B 则一期就需要 | ⚠️ 本机 3.13.12，但 **numpy / pandas / duckdb 均未安装** |
| 磁盘 | 自有数据每年约 **100~150MB**（`ql.duckdb` 为主） | ✅ |
| 网络 | 需访问新浪 / 腾讯 / 同花顺；二期需东财 | ⚠️ 东财自 2026-11 起对所有请求返回空响应，二期须先验证可用性 |
| 上游行情库 | 一个 DuckDB 文件（`kline_daily` 表），路径配在 `config.local.json` | ✅ 当前可用，38.5GB，数据到 2026-11-12 |

**启动**：

```bash
npm install
npm start            # 服务 :3000
npm test             # 现有 26 项回归
```

---

## 7. 现有代码基线（开发前必读）

| 文件 | 行数 | 作用 | 改动权限 |
|---|---|---|---|
| `server.js` | 381 | Express 路由 | 可改（加接口） |
| `lib/sources.js` | 693 | 三源适配 + 缓存 + 并发闸门 | 可改（二期加板块源） |
| `lib/quote.js` | 213 | 代码规范化 + 快照 + K线门面 | 可改 |
| `lib/clean.js` | 163 | K线清洗 | **只读**（改它会污染全部历史口径） |
| `lib/store.js` | 224 | 自选股 JSON 原子写 | 可改 |
| `lib/scan.js` | 170 | 全池形态扫描 | 只读 |
| `public/js/shape.js` | 105 | 前后端共用形态算法 | 只读 |
| `public/js/strategies.js` | 5481 | 40 流派注册 | 可加不可改（改会影响历史评分可比性） |
| `tools/smoke.js` | 377 | 26 项回归冒烟 | 只加不减 |

**`lib/clean.js` 与 `public/js/shape.js` 为什么只读**：它们决定所有历史 K 线的清洗口径与形态判定。改动会让改造前后的评分不可比，而对账系统最怕的就是"口径悄悄变了"。

新增代码一律放 `lib/` 下的新文件，不要往 `sources.js` 里堆逻辑（它已经 693 行）。

---

## 8. 交付物清单（四期全部）

```
新增
├── lib/log.js                  一期  统一日志（JSONL + 关键事件）
├── lib/datasource.js           一期  统一数据访问（本地优先解析链）
├── lib/sources/registry.js     二期  资产注册表（主源 + 兜底链 + 风险等级）
├── lib/sources/health.js       二期  运行态 + 状态机 + 熔断（落盘 meta 表）
├── lib/sources/pacing.js       二期  按风险等级节流
├── lib/sources/adapters/sina-sector.js  二期  新浪板块列表 + 成分股
├── lib/sources/adapters/em.js  二期  东财 clist / push2delay / push2ex
├── lib/sources/adapters/local-db.js     二期  上游 market.db 读
├── lib/sources/adapters/aggregate.js    二期  板块 K 线聚合（纯函数）
├── lib/dao/index.js          一期  统一 DAO（DuckDB 主 / JSONL 兜底）
├── lib/dao/duckdao.js        一期  DuckDB 后端（ql.duckdb）
├── lib/dao/jsondao.js        一期  JSONL 后端（兜底）
├── lib/snapshot.js             一期  日快照存取
├── lib/predict.js              一期  预判卡生成
├── lib/reconcile.js            一期  对账与归因
├── lib/judgment.js             一期  命中率统计
├── lib/sectordata.js           二期  板块数据获取
├── lib/sector.js               二期  板块强度四因子（JS）
├── lib/watchpool.js            二期  观察池状态机
├── lib/pyrunner.js             三期  Node ↔ Python 子进程调用封装
├── lib/gates.js                三期  五道闸（Node 侧编排）
├── py/                         三期  Python 策略引擎（venv 独立）
│   ├── tdx_engine/             复制自 tdx-backtest，剥离依赖
│   │   ├── README.md           记录原 commit 与复制清单
│   │   ├── parser.py
│   │   ├── functions.py        已扩函数
│   │   ├── signals.py
│   │   ├── future_scan.py      已补漏检
│   │   ├── backtest.py         已剥离 pandas（或保留，见 05 §3.2）
│   │   ├── runner.py           stdin/stdout JSON 协议
│   │   └── selftest.py         纯函数自测（8 项，随 test:unit 跑）
│   └── requirements.txt
├── tools/daily-close.js        一期  收盘后编排入口（支持 --backfill N 回补历史日）
├── tools/pred-report.js        一期  人读报告
├── tools/archive.js            二期  旧年份手动归档
├── tools/sector-report.js      二期  板块报告
├── tools/gate-run.js           三期  跑五道闸（CLI，同步版）
├── tools/install-schedule.sh   一期  装定时调度（launchd 优先，可打印 cron 行）
├── public/today.html           四期  今日一页
├── public/watch.html           四期  观察池
├── public/lab.html             四期  策略实验室
├── public/js/today.js          四期
├── public/js/watch.js          四期
├── public/js/lab.js            四期
├── public/css/today.css        四期  七格布局样式
└── data/
    ├── ql.duckdb               自有库：快照/预判/对账/板块/信号（cron 写）
    ├── snapshots/              一期  仅 engine=jsonl 时使用的降级目录
    ├── watchpool/              二期  pool.jsonl + transitions.jsonl（Web 写）
    ├── strategies/             三期  defs.jsonl（Web 写）+ tasks.jsonl（闸任务队列）
    └── sectors/                二期  dict.json（板块字典）
```

> **`data/ql.duckdb` 与上游 `market.db` 是两个文件**，绝不可混用。启动时断言两者路径不同。

**测试**：新增 `tests/unit/`、`tests/integration/`、`tests/mutate/`（结构见 `07` §3）。
夹具在用例内现造（临时 DuckDB / 内联数组），不落 `tests/fixtures/` 目录 —— 见 `07` §3.1 的说明。

**两个已从清单移除的交付物**（原因见 `08` §4）：`tools/migrate.js`（一期就用的 DuckDB，
从未产生过需要迁移的 JSONL）、`py/dbq.py`（`@duckdb/node-api` 一直可用，降级方案未触发）。

**存量文件改动仅限**：
`server.js`（加 `/api/predict` `/api/sector` `/api/lab` `/api/health` 路由）、
`package.json`（加 `test:*` 脚本与 duckdb 依赖）、
`lib/sources.js`（二期加板块源）、
`.gitignore`（加 `data/ql.duckdb` `py/.venv` `logs/`）。
