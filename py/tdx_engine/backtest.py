# 来源：tdx-backtest/tdxback/backtest.py @ commit 95408fe
# 复制日期：2026-11-14
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。

"""回测引擎(做多交易系统) + 绩效指标。

信号在 bar t 收盘后产生, 默认在 t+1 开盘成交(避免未来函数); 也可用 --
execution close 在同日收盘成交。可配置佣金/滑点/印花税。

execution 模式:
  next_open     t+1 开盘价成交(默认)
  close         当日收盘价成交
  open_confirm  t+1 开盘价成交, 但要求开盘跳空 ∈ [gap_min, gap_max] 才买入
                (隔夜/跳空类信号在开盘兑现的确认, 未兑现则放弃该信号)
  close_open    信号日收盘买入、次日开盘卖出 —— 隔夜/尾盘类策略(S1 隔夜租金):
                买入挂单在信号日收盘兑现(≈14:45-14:56 尾盘), 卖出信号在次日开盘兑现
                (≈9:30 隔夜修复), 持仓仅隔夜; 同一信号日可同时给出 buy+sell 配对。
"""
from __future__ import annotations

import numpy as np
from datetime import date as _date, datetime as _datetime


def _to_dt(v):
    """把协议传入的日期值转为 datetime；无法解析返回 None。"""
    if hasattr(v, "to_pydatetime"):
        return v.to_pydatetime()
    if isinstance(v, _datetime):
        return v
    if isinstance(v, _date):
        return _datetime(v.year, v.month, v.day)
    s = str(v)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d",
                "%Y-%m-%d %H:%M:%S", "%Y%m%d %H:%M:%S"):
        try:
            return _datetime.strptime(s, fmt)
        except ValueError:
            pass
    try:
        x = float(v)
        return _datetime.fromtimestamp(x if x > 1e9 else x * 1000)
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def _days_between(a, b):
    da, db = _to_dt(a), _to_dt(b)
    return (da - db).days if (da is not None and db is not None) else 0


def run_backtest(ohlcv: dict, buy_sig, sell_sig, *,
                 capital: float = 100_000.0,
                 commission: float = 0.0003,     # 双边佣金(比例)
                 slippage: float = 0.0005,       # 单边滑点(比例)
                 stamp: float = 0.001,           # 印花税(仅卖出)
                 position_pct: float = 1.0,      # 单笔动用资金比例(可传逐bar序列: 波动目标化)
                 execution: str = "next_open",  # next_open | close | open_confirm | close_open
                 gap_min: float = 0.0,          # open_confirm: 开盘跳空≥该比例才买入
                 gap_max: float | None = None,  # open_confirm: 开盘跳空≤该比例(透支不追), None不设上限
                 stop_loss: float | None = None,  # 止损比例(如0.05=5%), None不启用
                 take_profit: float | None = None,  # 止盈比例(如0.10=10%), None不启用
                 stop_price: np.ndarray | None = None,
                 scale_out: list | None = None,   # 分批止盈: [{"at":0.15,"frac":0.4},...] 浮盈达at兑现frac仓位
                 trail_arm: float | None = None,  # 浮盈移动保护: 持仓浮盈≥此比例后启动, None不启用
                 trail_dd: float | None = None,   # 启动后止损=峰值价*(1-trail_dd), 锁盈防回吐
                 lock_dd: float | None = None):   # 回撤熔断: 峰值回撤≥此比例强制全平(需先有浮盈), None不启用
    """stop_price: 动态止损价序列(长度=n), 持仓中 l[i]<=stop_price[i] 触发止损。
    与 stop_loss(比例)互斥; 提供后忽略 stop_loss。典型用于 ATR 自适应止损。

    风控/仓位管理(全部默认 None 可不启用, 供"控回撤提alpha"策略内置参数):
      scale_out : 分批止盈 —— 持仓浮盈(峰值收益)达到 at 时, 兑现 frac(原始仓位比例), 落袋回收复利降回撤。
      trail_arm/dd : 浮盈移动保护 —— 浮盈越过 trail_arm 后, 把止损上移至 峰值价*(1-trail_dd) 并随峰值上移(锁盈)。
      lock_dd   : 回撤熔断 —— 持仓曾浮盈>0 且峰值回撤≥lock_dd 时强制全平, 封死极端回吐。
    """
    o = np.asarray(ohlcv["open"], dtype=float)
    c = np.asarray(ohlcv["close"], dtype=float)
    h = np.asarray(ohlcv["high"], dtype=float) if "high" in ohlcv else c
    l = np.asarray(ohlcv["low"], dtype=float) if "low" in ohlcv else c
    n = len(c)
    # 日期序列仅用于成交明细与周期统计, 按 0-based 位置索引访问。
    _d = ohlcv.get("datetime")
    dates = list(_d) if _d is not None and len(_d) else list(range(n))
    # position_pct 支持逐bar序列(波动目标化): 开仓时取该bar的仓位比例; 标量则全程固定
    pp_arr = np.asarray(position_pct, dtype=float) if isinstance(position_pct, (np.ndarray, list)) else None
    if pp_arr is not None and len(pp_arr) != n:
        raise ValueError("position_pct 序列长度须与K线等长")
    buy_sig = np.asarray(buy_sig, dtype=bool)
    sell_sig = np.asarray(sell_sig, dtype=bool)

    cash = float(capital)
    shares = 0.0
    equity_curve = np.empty(n)
    trades = []
    entry_idx = entry_price = None
    in_pos = False
    stop_px = take_price = None  # 止损/止盈触发价(比例模式)
    active_stop = None           # 动态价格止损(stop_price)当前生效天花板: 入场后只上移
    orig_shares = 0.0            # 原始开仓股数(分批止盈 frac 的基准)
    peak_high = 0.0              # 持仓周期峰值最高价(浮盈移动保护/回撤熔断基准)
    scale_k = 0                  # 已触发的分批止盈档位数指针

    def exec_price(i, kind):
        if execution == "close":
            p = c[i]
        else:
            nxt = min(i + 1, n - 1)
            p = o[nxt]
        if kind == "buy":
            return p * (1.0 + slippage)   # 买: 加滑点
        return p * (1.0 - slippage)       # 卖: 减滑点

    def _close_position(i, price, reason, shares_close: float | None = None):
        """全平(shares_close=None，默认)或部分平(shares_close>0)。部分平保留持仓状态。"""
        nonlocal cash, shares, in_pos, entry_idx, entry_price, stop_px, take_price, active_stop, orig_shares, peak_high, scale_k
        n_sh = shares if shares_close is None else shares_close
        proceeds = n_sh * price * (1.0 - commission - stamp)
        cash += proceeds
        trades.append({
            "entry_date": dates[entry_idx], "entry_price": entry_price,
            "exit_date": dates[i], "exit_price": price,
            "shares": n_sh,
            "pnl": proceeds - n_sh * entry_price * (1.0 + commission),
            "exit_reason": reason,
        })
        if shares_close is None:
            shares = 0.0
            in_pos = False
            entry_idx = entry_price = None
            stop_px = take_price = None
            active_stop = None
            orig_shares = peak_high = 0.0
            scale_k = 0
        else:
            shares -= shares_close   # 部分兑现, 保持持仓, 峰值/止损状态延续

    # 真正 T+1 布局(2026-09 修复): next_open/open_confirm 下, 信号在 bar t 收盘产生、
    # 实际成交在 bar t+1 开盘。用 pending 信号把成交延迟到次日, 使:
    #   · trades.entry_date/exit_date = 实际成交日(非信号日), 与成交价对齐;
    #   · equity_curve 从成交日起算持仓市值, 与明细/回撤/K线 mark 对齐。
    # close 模式当日收盘成交(信号日即成交日), 行为不变。
    # close_open 模式: 买入当日收盘成交(信号日), 卖出信号次日开盘成交(挂单 pend_sell)。
    open_fill = execution in ("next_open", "open_confirm", "close_open")
    pend_buy = False          # 上一根产生的买入信号, 待本 bar 开盘成交
    pend_sell = False         # 上一根产生的卖出信号, 待本 bar 开盘成交
    for i in range(n):
        # ── ① 开盘成交: 兑现上一根挂单(pend_buy/pend_sell), 记录成交日为 i ──
        if open_fill:
            if pend_buy and not in_pos:
                # open_confirm: 隔夜须开盘跳空落在 [gap_min, gap_max] 才追, 否则放弃
                if execution != "open_confirm":
                    fill_buy = True
                else:
                    g = (o[i] / c[i - 1] - 1.0) if i >= 1 else float("inf")
                    fill_buy = (i < n - 1 and g >= gap_min
                                and (gap_max is None or g <= gap_max))
                if fill_buy:
                    p = o[i] * (1.0 + slippage)
                    budget = cash * (pp_arr[i] if pp_arr is not None else position_pct)
                    cost_per = p * (1.0 + commission)
                    qty = int(budget / cost_per) if cost_per > 0 else 0
                    if qty > 0:
                        shares = float(qty)
                        cash -= qty * cost_per
                        in_pos = True
                        entry_idx, entry_price = i, p          # 成交日 index = i
                        orig_shares = float(qty)               # 分批止盈基准
                        peak_high = h[i]                       # 建仓当根峰值
                        scale_k = 0
                        if stop_loss is not None:
                            stop_px = p * (1.0 - stop_loss)
                        if take_profit is not None:
                            take_price = p * (1.0 + take_profit)
                        if stop_price is not None:
                            active_stop = float(stop_price[i])
                pend_buy = False
            if pend_sell and in_pos:
                p = o[i] * (1.0 - slippage)
                _close_position(i, p, "signal")                # 成交日 index = i
                equity_curve[i] = cash + shares * c[i]
                pend_sell = False
                # 不 continue: 平仓后本 bar 仍可能给出再入场买入信号(下一根开盘成交),
                # 若 __continue 会丢掉该信号(回归: 见 test_metrics_win_rate / test_avg_hold_days)
        # ── ② 持仓中: 先检查止损/止盈/管理(日内高低点触发, 保守先止损) ──
        has_mgmt = (stop_loss is not None or stop_price is not None or take_profit is not None
                    or scale_out or trail_arm is not None or lock_dd is not None)
        if in_pos and has_mgmt:
            if stop_price is not None and active_stop is not None:
                active_stop = max(active_stop, float(stop_price[i]))
            peak_high = max(peak_high, h[i])
            peak_gain = peak_high / entry_price - 1.0 if entry_price else 0.0

            # 优先级顺序: 固定止损/动态止损 → 浮盈移动保护 → 回撤熔断 → 固定止盈 → 分批止盈(部分)
            triggered = None
            trig_price = None
            if stop_price is not None and active_stop is not None and l[i] <= active_stop:
                triggered = "stop_loss"; trig_price = active_stop
            elif stop_loss is not None and stop_px is not None and l[i] <= stop_px:
                triggered = "stop_loss"; trig_price = stop_px
            elif (trail_arm is not None and peak_gain >= trail_arm
                  and trail_dd is not None and l[i] <= peak_high * (1.0 - trail_dd)):
                triggered = "trail"; trig_price = peak_high * (1.0 - trail_dd)
            elif lock_dd is not None and peak_gain > 0 and l[i] <= peak_high * (1.0 - lock_dd):
                triggered = "lock_dd"; trig_price = peak_high * (1.0 - lock_dd)
            elif take_profit is not None and take_price is not None and h[i] >= take_price:
                triggered = "take_profit"; trig_price = take_price
            if triggered:
                sell_p = trig_price * (1.0 - slippage)
                _close_position(i, sell_p, triggered)
                equity_curve[i] = cash + shares * c[i]
                # 不 continue: 止损/止盈平仓后, 本 bar 仍可能给出再入场买入信号(下一根开盘成交)

            # 分批止盈: 浮盈(峰值收益)达档位即兑现原仓位 frac, 按当日收盘落袋(部分平, 保留趋势仓位)
            if in_pos and scale_out:
                keep = 1.0 - sum(float(x.get("frac", 0)) for x in scale_out[:scale_k])
                while scale_k < len(scale_out):
                    lv = scale_out[scale_k]
                    if peak_gain >= float(lv.get("at", 0.0)):
                        frac = max(min(float(lv.get("frac", 0)), keep), 0.0)
                        n_sh = orig_shares * frac
                        if n_sh > 0.5:
                            _close_position(i, c[i], "scale_out", shares_close=n_sh)
                            keep -= frac
                        scale_k += 1
                    else:
                        break
        # ── ③ 信号检测(本 bar 收盘) ──
        # close 模式当日收盘可成交; next_open 需有次日开盘才可成交(否则挂单永不兑现)
        if execution == "close_open":
            # 隔夜/尾盘模式: 信号日收盘买入、次日开盘卖出, 持仓仅隔夜。
            # 同 bar 可给出 buy+sell 配对(S1: 尾盘买→次日开盘修复兑现)。
            if in_pos and sell_sig[i] and i < n - 1:
                pend_sell = True                     # 次日开盘卖
                equity_curve[i] = cash + shares * c[i]
                continue
            if not in_pos and buy_sig[i] and i < n - 1:
                p = c[i] * (1.0 + slippage)          # 尾盘买入 ≈ 当日收盘
                budget = cash * (pp_arr[i] if pp_arr is not None else position_pct)
                cost_per = p * (1.0 + commission)
                qty = int(budget / cost_per) if cost_per > 0 else 0
                if qty > 0:
                    shares = float(qty)
                    cash -= qty * cost_per
                    in_pos = True
                    entry_idx, entry_price = i, p
                    orig_shares = float(qty)
                    peak_high = h[i]
                    scale_k = 0
                    if sell_sig[i]:                  # 配对: 当日买+次日开盘卖
                        pend_sell = True
                equity_curve[i] = cash + shares * c[i]
                continue
        elif in_pos and sell_sig[i] and (execution == "close" or i < n - 1):
            # 卖出: next_open 挂单待次日开盘; close 当日收盘平
            if open_fill:
                pend_sell = True
                equity_curve[i] = cash + shares * c[i]
                continue
            p = exec_price(i, "sell")
            _close_position(i, p, "signal")
        elif not in_pos and buy_sig[i] and (execution == "close" or i < n - 1):
            if open_fill:
                # open_confirm 成交条件在次日开盘判定, 这里先挂单
                pend_buy = True
            else:  # close 当日收盘买入
                p = exec_price(i, "buy")
                budget = cash * (pp_arr[i] if pp_arr is not None else position_pct)
                cost_per = p * (1.0 + commission)
                qty = int(budget / cost_per) if cost_per > 0 else 0
                if qty > 0:
                    shares = float(qty)
                    cash -= qty * cost_per
                    in_pos = True
                    entry_idx, entry_price = i, p
                    orig_shares = float(qty)
                    peak_high = h[i]
                    scale_k = 0
                    if stop_loss is not None:
                        stop_px = p * (1.0 - stop_loss)
                    if take_profit is not None:
                        take_price = p * (1.0 + take_profit)
                    if stop_price is not None:
                        active_stop = float(stop_price[i])
        equity_curve[i] = cash + shares * c[i]

    # 收尾: 最后一个交易若有持仓, 计入未实现
    if in_pos:
        equity_curve[n - 1] = cash + shares * c[n - 1]

    return {
        "equity": equity_curve,
        "benchmark": capital * c / c[0],
        "trades": trades,
        "n_buy_sig": int(buy_sig.sum()),
        "n_sell_sig": int(sell_sig.sum()),
        "final_cash": cash,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
    }


def compute_metrics(res: dict, ohlcv: dict, stats_only: bool = False):
    eq = np.asarray(res["equity"], dtype=float)
    bench = np.asarray(res["benchmark"], dtype=float)
    trades = res["trades"]
    n = len(eq)

    total_return = eq[-1] / eq[0] - 1
    ann_return = (1.0 + total_return) ** (252.0 / n) - 1 if n > 0 else 0.0
    bh_return = bench[-1] / bench[0] - 1

    # 回撤
    hwm = np.maximum.accumulate(eq)
    dd = eq / hwm - 1
    max_dd = float(dd.min())
    # 最大回撤持续时间(bar): 峰值 → 谷底 → 修复回峰值的完整时长; 未修复则到序列末尾
    gap = hwm - eq
    if gap.max() == 0:
        mdd_dur = 0
    else:
        mdd_end = int(np.argmax(gap == gap.max()))
        peak = int(np.where(hwm[:mdd_end + 1] == hwm[mdd_end])[0][-1])
        rec = np.where(eq[peak + 1:] >= hwm[mdd_end])[0]
        mdd_dur = int(rec[0] + 1) if len(rec) else (n - peak)

    # 收益率序列(bar)
    rets = np.diff(eq) / eq[:-1]
    sharpe = 0.0
    if len(rets) > 1 and rets.std() > 0:
        sharpe = float(rets.mean() / rets.std() * np.sqrt(252.0))

    # 交易统计
    n_trades = len(trades)
    pnls = [t["pnl"] for t in trades]
    win = [p for p in pnls if p > 0]
    lose = [p for p in pnls if p <= 0]
    win_rate = len(win) / n_trades if n_trades else 0.0
    gross_profit = sum(win)
    gross_loss = -sum(lose)
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

    avg_pnl = np.mean(pnls) if pnls else 0.0
    # 平均持仓天数: 全部已平仓交易的持有天数均值(兼容字符串/数字日期)。
    hold_days = [_days_between(t["exit_date"], t["entry_date"]) for t in trades]
    avg_days = float(np.mean(hold_days)) if hold_days else 0.0

    _d = ohlcv.get("datetime")
    dates = list(_d) if _d is not None and len(_d) else list(range(n))
    fd, ld = _to_dt(dates[0]), _to_dt(dates[-1])
    period_days = (ld - fd).days if (fd is not None and ld is not None) else 0
    period_days = period_days or n or 1
    annual_wr = win_rate  # 供展示
    trades_per_year = n_trades * (365.0 / period_days) if period_days > 0 else 0

    metrics = {
        "period_days": period_days,
        "n_bars": n,
        "total_return": total_return,
        "annual_return": ann_return,
        "benchmark_return": bh_return,
        "alpha": (total_return - bh_return),
        "max_drawdown": max_dd,
        "mdd_duration_bars": mdd_dur,
        "sharpe": sharpe,
        "n_trades": n_trades,
        "n_buy_sig": res["n_buy_sig"],
        "n_sell_sig": res["n_sell_sig"],
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "avg_trade_pnl": avg_pnl,
        "avg_hold_days": avg_days,
        "trades_per_year": trades_per_year,
        "final_equity": eq[-1],
        "initial_capital": eq[0],
    }
    if stats_only:
        return metrics
    metrics["_drawdown"] = dd
    metrics["_trades"] = trades
    metrics["_equity"] = eq
    metrics["_benchmark"] = bench
    return metrics