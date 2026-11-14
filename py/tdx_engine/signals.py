# 来源：tdx-backtest/tdxback/signals.py @ commit 95408fe
# 复制日期：2026-11-14
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。

"""买卖信号提取。

通达信"交易系统"挂买卖两条线(布尔/状态), 平台对两条输出线做"上升沿"触发:
当某线从前一根 <=0 变成 >0 时, 记为一次触发信号。这也兼容 CROSS 型公式与
画线型(线下的输出名)。可自定义阈值。
"""
from __future__ import annotations

import numpy as np


DEFAULT_BUY_NAMES = ("BUY", "ENTERLONG", "B", "买入", "买", "开仓", "做多", "多单")
DEFAULT_SELL_NAMES = ("SELL", "EXITLONG", "S", "卖出", "卖", "平仓", "平多", "空单")


def rising_edge(arr: np.ndarray, threshold: float = 0.0) -> np.ndarray:
    """前一根 not>thr 且本根 >thr → 上升沿(即触发信号)。"""
    a = np.asarray(arr, dtype=float)
    act = a > threshold
    sig = np.zeros(len(a), dtype=bool)
    sig[1:] = act[1:] & ~act[:-1]
    return sig


def active_state(arr: np.ndarray, threshold: float = 0.0) -> np.ndarray:
    return np.asarray(arr, dtype=float) > threshold


def resolve_signal_lines(outputs: dict, buy_name=None, sell_name=None,
                         threshold: float = 0.0):
    """从输出线名称解析买/卖信号线。

    返回 (buy_arr, sell_arr, buy_name_used, sell_name_used)。
    找不到指定线时, 尝试自动匹配常见信号名。
    """
    names = list(outputs.keys())
    if buy_name is not None and buy_name not in outputs:
        raise ValueError(f"买家信号线 '{buy_name}' 不存在。可用输出线: {names}")
    if sell_name is not None and sell_name not in outputs:
        raise ValueError(f"卖家信号线 '{sell_name}' 不存在。可用输出线: {names}")

    buy_arr = sell_arr = None
    used_b = used_s = None

    if buy_name is not None:
        buy_arr = _asbool(outputs[buy_name], threshold); used_b = buy_name
    if sell_name is not None:
        sell_arr = _asbool(outputs[sell_name], threshold); used_s = sell_name

    # 自动匹配
    if buy_arr is None:
        for nm in DEFAULT_BUY_NAMES:
            if nm in outputs:
                buy_arr = _asbool(outputs[nm], threshold); used_b = nm; break
    if sell_arr is None:
        for nm in DEFAULT_SELL_NAMES:
            if nm in outputs:
                sell_arr = _asbool(outputs[nm], threshold); used_s = nm; break

    return buy_arr, sell_arr, used_b, used_s


def _asbool(arr, threshold):
    return np.asarray(arr, dtype=float) > threshold