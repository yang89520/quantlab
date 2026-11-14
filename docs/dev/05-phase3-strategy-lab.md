# 05 · 三期：策略实验室

**工期**：15 人日 ｜ **依赖**：一期（二期的板块数据非必需，但建议先完成）

---

## 1. 本期解决什么

回答「我这套方法到底行不行」「什么有买卖点」。

三个交付：

1. **公式引擎**：粘贴通达信源码即可跑，不用改写 Python
2. **五道闸**：任一道不过不许上线，结论只给"可用/存疑/不可用"三档
3. **信号跟踪**：策略上线不是结束，是开始——每日记录信号并跟踪 T+1/T+5/T+10

---

## 2. Python 环境

### 2.1 现状

| 项 | 状态 |
|---|---|
| 系统 `python3` | 3.13.12，**numpy / pandas 均未安装** |
| `.venv-axdata` | 存在，但属另一个项目（axdata），**不许借用** |

### 2.2 建独立环境

```bash
cd <项目根>
python3 -m venv py/.venv
py/.venv/bin/pip install -r py/requirements.txt
```

`py/requirements.txt`：

```
numpy>=2.0
pandas>=2.0        # 仅当保留 backtest.py 的 DataFrame 接口时需要
```

**不装**：fastapi、uvicorn、pydantic、httpx、baostock、akshare、pytdx、matplotlib、pyarrow、polars。
理由：Python 侧只做纯计算，不碰网络、不碰存储、不画图。每多一个依赖就多一分装不上的风险。

`.gitignore` 追加：

```
py/.venv/
```

### 2.3 探测与降级

`/api/health` 的 `python` 字段：

```js
// lib/gates.js
function probePython() {
  // spawn py/.venv/bin/python -c "import numpy; print(numpy.__version__)"
  // 成功 → { available: true, numpy: '2.x.x' }
  // 失败 → { available: false, reason: <stderr 首行> }
}
```

Python 不可用时，三期功能整体不可用，但**一、二期照常运行**——不许因为缺 numpy 让整个服务起不来。

---

## 3. 从 tdx-backtest 复制哪些文件

**复制，不是引用**（G1/G2）。复制后即本项目文件，可独立修改。

| 源文件 | 目标 | 处理 |
|---|---|---|
| `tdxback/parser.py` | `py/tdx_engine/parser.py` | 原样复制（零第三方依赖） |
| `tdxback/functions.py` | `py/tdx_engine/functions.py` | 复制 + **扩充函数**（见 §4） |
| `tdxback/signals.py` | `py/tdx_engine/signals.py` | 原样复制（需 numpy） |
| `tdxback/future_scan.py` | `py/tdx_engine/future_scan.py` | 复制 + **补漏检**（见 §6.1） |
| `tdxback/backtest.py` | `py/tdx_engine/backtest.py` | 复制 + 剥离外部依赖（见 §3.2） |

**复制时必须做**：

1. 每个文件头加注释：

```python
# 来源：tdx-backtest/tdxback/parser.py @ commit <填写>
# 复制日期：YYYY-MM-DD
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。
```

2. 在 `py/tdx_engine/README.md` 记录原 commit 与复制清单
3. **不动源目录任何文件**

### 3.1 为什么这些文件能独立

| 文件 | 第三方依赖 | 项目内依赖 | 结论 |
|---|---|---|---|
| `parser.py` | 无 | 无 | 直接可用 |
| `functions.py` | numpy | 仅 `from .parser import ...` | 直接可用 |
| `signals.py` | numpy | 仅 parser/functions | 直接可用 |
| `future_scan.py` | 无 | 仅 parser | 直接可用 |
| `backtest.py` | numpy + pandas | 可能引用 `data.py` 等 | **需处理** |

### 3.2 `backtest.py` 的剥离

先看它的实际依赖范围：

```bash
grep -nE "^import |^from " backtest.py | grep -v "from \."
```

处理原则：

| 情况 | 处理 |
|---|---|
| 只用 pandas 做 `DataFrame` 装 K 线 | 改为接收 `dict[str, np.ndarray]`，删掉 pandas 依赖（**首选**） |
| pandas 用于 rolling/groupby 等重逻辑 | 保留 pandas，`requirements.txt` 加它（安装成本可接受） |
| 引用了 `data.py` / `universe.py` | **不要复制那些文件**，改写为接收外部传入的 ohlcv dict |

**决策规则**：改动量 < 100 行就剥离 pandas；超过则保留。理由是 pandas 装的成本远低于改写引入 bug 的风险。

---

## 4. 函数扩充清单（必做）

现有 33 个函数（无 `STD`），导致**经典 BOLL 公式直接跑不了**——这是 tdx-backtest 被迫用 Python 重写布林策略的根因，也是本项目必须解决的第一件事。

### 4.1 必补：12 个常规函数

| 函数 | 语义 | 备注 |
|---|---|---|
| `STD(X,N)` | N 周期标准差 | **最高优先级**，BOLL 必用 |
| `VAR(X,N)` | N 周期方差 | |
| `AVEDEV(X,N)` | 平均绝对偏差 | |
| `EXIST(C,N)` | N 周期内是否存在条件成立 | 常用 |
| `VALUEWHEN(C,X)` | 条件最近一次成立时 X 的值 | 常与 BARSLAST 配合 |
| `BARSSINCE(C)` | 首次条件成立到当前的周期数 | |
| `SIGN(X)` | 符号：正 1 / 负 -1 / 零 0 | |
| `INTPART(X)` | 取整数部分（截断，不是四舍五入） | |
| `BETWEEN(X,A,B)` | `A <= X <= B` | |
| `SLOPE(X,N)` | N 周期线性回归斜率 | |
| `FORCAST(X,N)` | N 周期线性回归预测值 | |
| `LONGCROSS(A,B,N)` | A 持续 N 周期低于 B 后上穿 | |

### 4.2 未来函数：实现但不许用于信号

| 函数 | 为什么要实现 |
|---|---|
| `XMA(X,N)` | 偏移均线，属未来函数。实现它才能让含它的公式**被检测并拒绝**，而不是报"不支持函数"让人误以为可以凑合用 |
| `ZIG(K,N)` / `PEAK` / `TROUGH` / `PEAKBARS` / `TROUGHBARS` | 同上 |
| `REFX(X,N)` | 反向引用未来 |

**约束**：这些函数一旦出现在公式里，`future_scan` 必须报「高危」，五道闸第 1 道直接判 `unusable`。实现目的是**可检测**，不是可用。

### 4.3 明确不实现

| 类别 | 例子 | 原因 |
|---|---|---|
| 实时行情 | `DYNAINFO`、`INDEXC` | 回测无意义 |
| 财务数据 | `FINANCE` | 需要财报数据源，本期不接 |
| 绘图 | `DRAWICON` 等 | 已由现有 `_DRAW_FUNCS` 安全忽略 |
| 板块引用 | `HY_INDEXC` 等 | 依赖板块数据（二期已有，但回测接入复杂，留待后续） |

遇到不支持的函数时，**必须报出函数名与已支持清单**，不许静默返回 0。

> tdx-backtest 当前的 `Ident` 未定义时静默返回 0 数组——这让公式里的拼写错误（`CLOES` 写成 `CLOSE`）变成"跑通了但没有任何信号"，极难排查。**本项目必须改**：未定义标识符直接抛错，错误信息里给出最相近的已定义名称（编辑距离 ≤2 时提示）。

---

## 5. Python 侧协议

### 5.1 通信方式

Node 通过**子进程 + stdin/stdout JSON** 调用，不起 HTTP 服务。

```
Node                                    Python
 │  spawn(py/.venv/bin/python, [runner.py])
 │  ── stdin: {任务 JSON} ──────────────→
 │                                       解析/计算
 │  ←────────────── stdout: {结果 JSON} ──
 │  或 ←───────── stderr + exit 1 ───────
```

**为什么不用 HTTP**：一个每天跑几次的批处理，不值得多一个常驻进程（要管端口、存活、重启、日志轮转）。

### 5.2 请求 / 响应格式

**请求**（stdin，单行 JSON）：

```jsonc
{
  "task": "run",                  // run | scan | lines | funcs
  "formula": "MA20:MA(C,20);\nBUY:CROSS(C,MA20);",
  "outputLine": "BUY",
  "ohlcv": {
    "datetime": ["2026-01-05", "..."],
    "open":  [10.0, "..."],
    "high":  [10.5, "..."],
    "low":   [9.8,  "..."],
    "close": [10.2, "..."],
    "vol":   [12345, "..."],
    "amount":[1234000, "..."]
  },
  "params": { "fee": 0.0003, "slippage": 0.002, "fill": "next_open" }
}
```

**响应**（stdout，单行 JSON）：

```jsonc
{
  "ok": true,
  "task": "run",
  "outputs": { "MA20": [...], "BUY": [...] },
  "signals": [ { "i": 120, "date": "2026-06-18", "action": "buy", "price": 10.2 } ],
  "metrics": { "trades": 84, "winRate": 0.52, "ret": 0.31, "maxDD": 0.18, "sharpe": 1.12 },
  "quality": { "bars": 1200, "skipped": 0 }
}
```

**失败**：

```jsonc
{ "ok": false, "error": "不支持的函数 FOO()", "kind": "formula", "detail": {...} }
```

同时 `exit 1`。Node 侧必须同时检查 `ok` 与退出码，**不许只看其中一个**。

**错误分类 `kind`**：

| kind | 含义 | Node 侧处理 |
|---|---|---|
| `syntax` | 公式语法错误 | 直接展示给用户，附位置 |
| `formula` | 函数不支持/语义错误 | 展示 + 提示可用的替代 |
| `data` | 输入数据不足 | 提示"至少需要 N 根 K 线" |
| `internal` | Python 内部异常 | 记日志 + 上报，不展示细节给用户 |

### 5.3 Node 侧调用封装

`lib/pyrunner.js`：

```js
async function callPython(payload, { timeout = 120000 } = {})
```

必须做到：

1. **超时强杀**：`setTimeout` → `child.kill('SIGKILL')`，返回 `{ ok:false, error:'timeout' }`
2. **stderr 全量捕获**，失败时写入日志（Python traceback 是排查的唯一线索）
3. **stdout 只取最后一行**：防止 Python 里有 `print` 污染协议
4. **大 payload 用 stdin 写，不走命令行参数**：命令行有长度上限，1200 根 K 线会超
5. **不允许多次调用复用同一进程**：每次 spawn 独立，避免状态残留

---

## 6. 五道闸

### 6.1 第 1 道：未来函数

**静态扫描**（复用 `future_scan.py`）+ **补三类漏检**：

| 漏检 | 现状 | 补法 |
|---|---|---|
| `REF(X, N)` 的 N 是变量 | 只判字面量负数 | 静态分析变量表达式，若其取值域含负数则告警 |
| `HHV(X, 0)` 的 0 写成变量 | 只判 `Number(0)` | 同上，静态推断 |
| 通过中间变量间接引用未来 | 完全不检测 | 见下方动态检测 |

**动态检测（必做，比静态扫描强得多）**：

```
取前 M 根 K 线算信号序列 S1（含 M 根）
取前 M+K 根 K 线算信号序列 S2（含 M+K 根），截取前 M 个
若 S1 != S2 → 存在未来函数
```

**为什么必须做**：任何静态黑名单都漏得掉（用户可以把未来函数藏在中间变量里）。而"加数据后历史信号变了"是未来函数的**定义本身**，绕不过去。

参数：`K = 20`，比对容差 0（信号是布尔，必须严格相等）。

这一条是整套系统可信度的地基。tdx-backtest 只做了静态扫描，本项目必须补上。

### 6.2 第 2 道：样本内外

```js
split = round(bars * 0.7)
is  = 前 split 根
oos = 后 (bars - split) 根
decay = (is.ret - oos.ret) / Math.abs(is.ret)     // is.ret <= 0 时直接判不通过
pass = decay <= config.gates.maxDecay            // 默认 0.5
```

**要求**：`oos` 段至少 100 根 K 线，否则该道闸 `pass = null`（无法检验，判 `doubtful`）。

### 6.3 第 3 道：普适性

```js
对 >= config.gates.minUniverse（默认 30）只标的分别回测
positiveRatio = 正收益标的数 / 有效标的数
pass = positiveRatio >= config.gates.minPositiveRatio   // 默认 0.5
```

标的选取：从当前全市场按成交额取前 200 只，**随机抽 50 只**（固定随机种子，保证可复现）。

**为什么随机而不是选最好的**：挑标的是最常见的过拟合手段。

### 6.4 第 4 道：牛熊分段

按上证指数划分三段（用固定区间，不许按回测结果反向挑）：

| 段 | 区间 | 判定 |
|---|---|---|
| 牛 | 指数 250 日涨幅 > 15% | — |
| 熊 | 指数 250 日涨幅 < -15% | — |
| 震荡 | 其余 | — |

```js
pass = 三段收益均 >= config.gates.minPhaseRet    // 默认 -0.05（允许小幅回撤）
```

**注意**：若某段样本日数 < 60，该段结果标 `null`，整道闸按 `doubtful` 处理。

### 6.5 第 5 道：双轨一致性

同一策略若有公式版与 Python 版：

```
对 100 只标的分别跑两版，逐日比信号
agreeRate = 信号相同的 (标的, 日期) 数 / 总 (标的, 日期) 数
pass = agreeRate >= 0.99
```

只有一版时 `pass = null`（不算通过，也不算不通过）。

**为什么必须 99%**：两版不一致时，用户不知道该信哪一版。这是 tdx-backtest 双轨并行却从不对账留下的隐患。

### 6.6 结论判定

```js
if (gates.some(g => g.pass === false)) verdict = 'unusable';
else if (gates.some(g => g.pass === null)) verdict = 'doubtful';
else verdict = 'usable';
```

**`null` 绝不等同 `true`**。tdx-backtest 的 `SKIPPED` 容易被误读为通过，本项目必须显式三态。

### 6.7 结论只有三档

不允许"给你 20 个指标自己看"。UI 只展示：结论 + 未通过的具体闸 + 该闸的关键数字。指标明细放折叠区。

理由：把判断责任推回给用户，等于这个功能没做。

---

## 7. 信号跟踪

### 7.1 每日记录

策略 `status==='active'` 时，每日收盘后跑全市场，记录命中的标的（S11）。

**性能约束**：全市场 5342 只 × N 个策略。若策略 5 个，一轮 26710 次回测不可接受。

**做法**：
1. 先用**形态层预筛**（现有 `lib/scan.js` 的全池形态扫描，260 根 K 线，成本 1/5）缩小候选
2. 只对候选池跑完整回测
3. 预筛规则由策略声明（如"仅主板 + 站上 MA20"），不许拍脑袋

**明确记录预筛后的扫描数量** `scanned`，便于发现"预筛过严导致漏信号"。

### 7.2 回填跟踪

信号产生后，第 1/5/10 个交易日回填 `track.t1/t5/t10`。

```
t1 = (close[t+1] / signalPrice - 1) * 100
hit = t1 > 0        // buy 信号
```

未到期为 `null`，到期未回填（如停牌）也记 `null` 并标记 `reason: 'no_data'`。

### 7.3 自动降级

每 20 个交易日检查：实盘跟踪命中率 vs 回测命中率。

```js
if (liveWinRate < backtestWinRate - config.gates.degradeGap)   // 默认 0.15
  strategy.status = 'suspect'
```

`suspect` 后仍继续记录信号（为了继续观察），但 UI 标注"已降级，实盘表现偏离回测"。

**这是整套系统里最能防自欺的机制**——回测再好，实盘对不上就是有问题。

---

## 8. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/lab/formula/lines` | 解析公式，返回输出线清单 |
| POST | `/api/lab/formula/scan` | 未来函数扫描 |
| POST | `/api/lab/backtest` | 单次回测 |
| POST | `/api/lab/gates` | 跑五道闸（耗时长，返回任务 id） |
| GET | `/api/lab/gates/:taskId` | 轮询闸结果 |
| GET | `/api/lab/strategies` | 策略列表 |
| POST | `/api/lab/strategies` | 新建/更新（版本 +1） |
| GET | `/api/lab/signals?date=` | 某日信号 |
| GET | `/api/lab/track?strategyId=` | 跟踪曲线 |

**五道闸要走异步任务**：跑 50 只标的 × 4 道闸可能几分钟，同步请求会被网关掐断（这是 tdx-backtest 踩过的坑）。

任务状态存 `data/strategies/tasks.jsonl`：`pending | running | done | failed`，含进度百分比。

### 8.1 异步任务的并发、重试与进度（文档未规定，实现时定）

本节三项是原文没写的空白，实现时按下面取值，写进 `config.json` 的 `gates` 段，可改不用改代码。

| 项 | 取值 | 理由 |
|---|---|---|
| 并发上限 | `gates.maxConcurrent = 1` | 闸任务内部要逐只调 Python 进程，单任务已能吃满 CPU；再并发只会让两个任务都变慢，还会互相抢 DuckDB 连接。超出的任务留在队列里 `pending`，前端轮询看到的是排队而不是失败 |
| 失败重试 | 1 次 | 失败多是 Python 进程超时/OOM 这类瞬时问题，重试一次能救回大部分；重试还失败就是真失败，`failed` 必须让用户看到，不能无限重试掩盖 |
| 进度写失败 | `log.warn` 后继续跑 | 进度只是给人看的，写不进 `tasks.jsonl` 不该让正在跑的回测前功尽弃；但**必须留痕**，否则"进度卡住不动"会被误判成任务挂了 |

队列状态通过 `GET /api/health` 的 `gates: { running, queued, max }` 暴露，运维无需翻日志。

**不做的**：不做任务取消、不做优先级队列、不做跨进程抢占。
单机单用户场景下这三样都是负收益——真需要时再加，那时候的需求才清楚。

---

## 9. 测试清单

### 9.1 公式引擎

| 用例 | 期望 |
|---|---|
| `MA(C,5)` | 与手算一致 |
| `STD(C,20)` | 与 numpy.std(ddof=0) 一致 |
| `EXIST(C>O, 5)` | 布尔序列正确 |
| `VALUEWHEN(CROSS(A,B), C)` | 取最近一次交叉的收盘 |
| `INTPART(-1.7)` | `-1`（截断不是四舍五入） |
| `SIGN(-0.001)` | `-1` |
| 未定义标识符 `CLOES` | **抛错**，且提示"是否想用 CLOSE" |
| 不支持函数 `FOO()` | 抛错并列出已支持函数 |
| `ZIG(3,5)` 出现在公式 | `future_scan` 报高危 |

### 9.2 未来函数动态检测

| 用例 | 期望 |
|---|---|
| `BUY: CROSS(C, MA(C,20));` | S1 === S2（无未来函数） |
| `BUY: REF(C, -1) > C;` | S1 !== S2（检测到） |
| `X:=REF(C,-1); BUY: X>C;` | S1 !== S2（**中间变量藏未来，静态扫描漏、动态必抓**） |
| `BUY: C > HHV(C, 0);` | 动态检测到（历史最高随新数据变化） |

最后两条是核心用例——静态扫描抓不到，只有动态检测能抓。

### 9.3 五道闸

| 用例 | 期望 |
|---|---|
| 五道全 pass=true | `usable` |
| 第 2 道 pass=false | `unusable` |
| 第 5 道无 Python 版 | `doubtful`（不是 usable） |
| oos 段 < 100 根 | 第 2 道 `null` |

### 9.4 Python 集成

| 用例 | 期望 |
|---|---|
| Python 未安装 | `/api/health` 报告不可用，服务正常 |
| 计算超时（sleep 200s） | 120s 强杀，返回 timeout |
| Python 输出前有 print | 仍能正确解析（只取最后一行） |
| Python traceback | 记录到日志，用户看到通用错误 |
| 1200 根 K 线 payload | 通过 stdin 传输成功（不超命令行限制） |

### 9.5 变异验证

| 变异 | 应被抓住 |
|---|---|
| 去掉动态检测只留静态 | 中间变量藏未来的用例 |
| `INTPART` 用 `round` | `INTPART(-1.7)` 用例 |
| `null` 当 `true` | 第 5 道无 Python 版用例 |
| stdout 读第一行而非最后一行 | print 污染用例 |
| 未定义标识符返回 0 | `CLOES` 用例 |

---

## 10. 验收

- [x] BOLL 公式（含 `STD`）能直接跑通
- [x] 未定义标识符抛错并给提示
- [x] 动态未来函数检测能抓住"中间变量藏未来"
- [x] 五道闸结论只有三档，`null` 不等于通过
- [x] Python 不可用时服务照常启动
- [x] 120s 超时能强杀
- [x] 策略可自动降级为 `suspect`
- [x] `npm test` 26 项仍全绿（一期、二期也不许退化）

> 2026-11-14 核验：`py/tdx_engine/selftest.py` 8/8（MA 手算、`numpy.std(ddof=0)`、`INTPART(-1.7)==-1`、
> `ZIG` 高危、BOLL 含 `STD`）；变异三期 5/5 全红；信号链路实测——
> `daily-close --date 2026-11-13` 预筛 200 只 → 站上 MA20 得 101 只候选 → 回测 101 只 → **11 条真实信号**入库，
> 全程 61.7s 单策略。

---

## 11. 任务拆解

| # | 任务 | 依赖 | 人日 |
|---|---|---|---|
| T1 | 建 venv + 复制 5 个文件 + 头注释 + README | — | 1.0 |
| T2 | `runner.py` 协议 + Node `pyrunner.js` | T1 | 1.5 |
| T3 | 补 12 个常规函数 + 单测 | T1 | 1.5 |
| T4 | 未来函数函数族（XMA/ZIG/PEAK…）+ 静态扫描补漏 | T3 | 1.0 |
| T5 | **动态未来函数检测** | T2,T3 | 1.5 |
| T6 | 五道闸 1–4 实现 | T5 | 2.0 |
| T7 | 双轨一致性对账（第 5 道） | T6 | 1.5 |
| T8 | 信号记录 + T+1/T+5/T+10 跟踪 | T6 | 2.0 |
| T9 | 策略版本管理 + 自动降级 | T8 | 1.0 |
| T10 | 异步任务队列（闸跑得慢） | T6 | 1.0 |
| T11 | 测试 + 变异验证 | 全部 | 1.0 |

**关键路径**：T1 → T2 → T5（动态检测）→ T6（五道闸）。T3/T4 可与 T2 并行。
