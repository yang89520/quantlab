# 变更记录

> 只记录**影响历史可比性**的口径变更。纯代码优化、文案调整不记。
> 判断标准见 `08-risks-roadmap.md` §5.2。

## 记录格式

```
## YYYY-MM-DD · <变更项>

- 原值：
- 新值：
- 依据：
- 变更前 20 日命中率：
- 变更后 20 日命中率：
- 结论：保留 / 回滚
```

---

## 待填写

尚未发生口径变更。首次变更时在此追加。

**高危变更清单**（改之前必须记录）：

- 环境判定的三档阈值（`config.predict.verdict`）
- 三因子权重（`config.predict.weights`）
- 归因优先级顺序
- 板块四因子权重与 ABCD 阈值
- 观察池任一状态的迁移条件
- 五道闸的任一通过阈值
- ⑤ 风险格的三个触发阈值（`config.ui.risk.breakMa / weakenMa / reduceChgPct`）——
  改了以后「今天有几只持仓触发风险」会和历史截图对不上
- ④ 候选格的迁移展示口径（`config.ui.candidate.startWindowDays / maxPerGroup`）
- ③ 时机格的失效条件阈值（`config.ui.timing.lowOpenPct`）
- 策略信号预筛口径（`config.signals.pool / bars / minBars`）——
  改了以后同一策略在不同日期跑出来的信号数不可直接比较
