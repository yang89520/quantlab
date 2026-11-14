#!/usr/bin/env python3
# 三期 Python 公式引擎 · stdin/stdout 单行 JSON 协议(见 docs/dev/05 §5)。
# 本项目独立实现, 非上游复制文件。
# 约定: 只处理调用方传入的 ohlcv, 不造 K 线、不联网、不读数据库;
#       任何异常都输出结构化错误(ok:false, kind)并 exit 1;
#       stdout 只输出最后一行 JSON, 本文件不 print 任何调试内容。
from __future__ import annotations

import json
import math
import os
import sys
import traceback

import numpy as np

# 以脚本方式运行时(__package__ 为 None), 把 py/ 加入 sys.path, 用绝对导入
# 让 tdx_engine 成为包, 从而 functions.py 内的 "from .parser import ..." 可用。
_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from tdx_engine import signals, future_scan, backtest       # noqa: E402
from tdx_engine import functions                           # noqa: E402
from tdx_engine.parser import parse, Assign                # noqa: E402
from tdx_engine.functions import (Interpreter, execute_named,  # noqa: E402
                                  FormulaError)

_REQUIRED_FIELDS = ("datetime", "open", "high", "low", "close", "vol", "amount")
_NUM_FIELDS = ("open", "high", "low", "close", "vol", "amount")
_FILLS = ("next_open", "close", "open_confirm", "close_open")


class RunnerError(Exception):
    """带 kind 分类的结构化错误。"""

    def __init__(self, kind, error, detail=None):
        super().__init__(error)
        self.kind = kind
        self.error = error
        self.detail = detail or {}


# ---------- 输入校验 ----------

def _require_formula(payload):
    f = payload.get("formula")
    if not isinstance(f, str) or not f.strip():
        raise RunnerError("data", "缺少 formula(公式源码字符串)", {"field": "formula"})
    return f


def _validate_ohlcv(ohlcv):
    """校验 ohlcv, 返回 (bars, cleaned)。cleaned 数值字段为 float ndarray。"""
    if not isinstance(ohlcv, dict):
        raise RunnerError("data", "ohlcv 必须是对象", {})
    for k in _REQUIRED_FIELDS:
        if k not in ohlcv:
            raise RunnerError("data", f"ohlcv 缺少字段 {k}",
                              {"missing": k, "required": list(_REQUIRED_FIELDS)})
        if not isinstance(ohlcv[k], (list, tuple)):
            raise RunnerError("data", f"ohlcv.{k} 必须是数组", {"field": k})
    n = len(ohlcv["close"])
    if n < 2:
        raise RunnerError("data", "至少需要 2 根 K 线", {"bars": n})
    lens = {k: len(ohlcv[k]) for k in _REQUIRED_FIELDS}
    bad = {k: v for k, v in lens.items() if v != n}
    if bad:
        raise RunnerError("data", "各字段数组长度不一致", {"lengths": lens})
    arrs = {}
    for k in _NUM_FIELDS:
        try:
            arr = np.asarray(ohlcv[k], dtype=float)
        except (ValueError, TypeError) as e:
            raise RunnerError("data", f"ohlcv.{k} 含非数值",
                              {"field": k, "error": str(e)})
        if not np.all(np.isfinite(arr)):
            raise RunnerError("data", f"ohlcv.{k} 含非有限值(NaN/Inf)", {"field": k})
        arrs[k] = arr
    cleaned = dict(ohlcv)
    cleaned.update(arrs)
    return n, cleaned


def _parse_params(payload):
    p = payload.get("params") or {}
    if not isinstance(p, dict):
        raise RunnerError("data", "params 必须是对象", {})
    try:
        commission = float(p.get("fee", 0.0003))
        slippage = float(p.get("slippage", 0.0005))
    except (ValueError, TypeError) as e:
        raise RunnerError("data", f"params.fee/slippage 必须是数值: {e}", {})
    fill = p.get("fill", "next_open")
    if fill not in _FILLS:
        raise RunnerError("data", f"不支持的 fill: {fill!r}", {"allowed": list(_FILLS)})
    return {"commission": commission, "slippage": slippage, "execution": fill}


# ---------- 工具 ----------

def _arr_to_list(a):
    return [float(x) for x in np.atleast_1d(np.asarray(a, dtype=float))]


def _find_line(outputs, names, exclude=None):
    for nm in names:
        if nm in outputs and nm != exclude:
            return outputs[nm]
    return None


def _finite(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _finding_dict(f):
    return {"level": f.level, "func": f.func, "detail": f.detail, "stmt": f.stmt}


# ---------- 各 task ----------

def task_funcs(payload):
    lf = functions.list_functions()
    return {"ok": True, "task": "funcs", **lf}


def task_lines(payload):
    formula = _require_formula(payload)
    ast = parse(formula)  # SyntaxError -> kind=syntax
    lines = [{"name": s.name, "output": bool(s.output)}
             for s in ast if isinstance(s, Assign)]
    return {"ok": True, "task": "lines", "lines": lines}


def task_scan(payload):
    formula = _require_formula(payload)
    res = future_scan.scan_formula(formula)  # SyntaxError -> kind=syntax
    return {
        "ok": True, "task": "scan",
        "findings": [_finding_dict(f) for f in res.findings],
        "hasCritical": res.has_critical,
        "hasWarning": res.has_warning,
        "summary": res.summary(),
        "verdict": res.verdict(),
    }


def task_run(payload):
    formula = _require_formula(payload)
    n, cleaned = _validate_ohlcv(payload.get("ohlcv"))
    prm = _parse_params(payload)

    # 静态扫描: 出现高危未来函数立即拒绝(实现目的仅为可检测, 不用于信号)。
    scan = future_scan.scan_formula(formula)
    if scan.has_critical:
        crits = [f for f in scan.findings if f.level == "高危"]
        raise RunnerError(
            "formula", "公式含高危未来函数, 拒绝回测",
            {"findings": [_finding_dict(f) for f in crits],
             "hint": '用 task:"scan" 查看详情并移除未来函数后再评估'})

    ast = parse(formula)
    interp = Interpreter(cleaned, n)
    outputs, _ = execute_named(ast, interp)
    if not outputs:
        raise RunnerError("formula", "公式没有输出线(需用 ':' 声明)", {})

    # 信号线: 优先用 outputLine 作买线, 卖线自动匹配; 否则按常见名自动匹配。
    out_line = payload.get("outputLine")
    if out_line:
        if out_line not in outputs:
            raise RunnerError("formula", f"输出线 {out_line} 不存在",
                              {"available": list(outputs.keys())})
        buy_src = outputs[out_line]
        sell_src = _find_line(outputs, signals.DEFAULT_SELL_NAMES, exclude=out_line)
    else:
        buy_src = _find_line(outputs, signals.DEFAULT_BUY_NAMES)
        sell_src = _find_line(outputs, signals.DEFAULT_SELL_NAMES)
        if buy_src is None and sell_src is None:
            buy_src = next(iter(outputs.values()))

    buy_arr = signals.rising_edge(buy_src) if buy_src is not None else None
    sell_arr = signals.rising_edge(sell_src) if sell_src is not None else None

    close = cleaned["close"]
    op = cleaned["open"]
    dates = cleaned["datetime"]
    fill = prm["execution"]

    def fill_price(i):
        if fill == "close":
            return float(close[i])
        return float(op[min(i + 1, n - 1)])  # next_open / open_confirm / close_open

    sig_list = []
    if buy_arr is not None:
        for i in np.flatnonzero(buy_arr):
            sig_list.append({"i": int(i), "date": str(dates[i]),
                             "action": "buy", "price": fill_price(int(i))})
    if sell_arr is not None:
        for i in np.flatnonzero(sell_arr):
            sig_list.append({"i": int(i), "date": str(dates[i]),
                             "action": "sell", "price": fill_price(int(i))})
    sig_list.sort(key=lambda x: x["i"])

    buy_sig = (np.zeros(n, dtype=bool) if buy_arr is None
               else np.asarray(buy_arr, dtype=bool))
    sell_sig = (np.zeros(n, dtype=bool) if sell_arr is None
                else np.asarray(sell_arr, dtype=bool))
    res = backtest.run_backtest(
        cleaned, buy_sig, sell_sig,
        commission=prm["commission"], slippage=prm["slippage"],
        execution=prm["execution"], stamp=0.0)
    m = backtest.compute_metrics(res, cleaned, stats_only=True)
    metrics = {
        "trades": int(m["n_trades"]),
        "winRate": _finite(m["win_rate"]),
        "ret": _finite(m["total_return"]),
        "maxDD": _finite(abs(m["max_drawdown"])),
        "sharpe": _finite(m["sharpe"]),
    }

    return {
        "ok": True, "task": "run",
        "outputs": {k: _arr_to_list(v) for k, v in outputs.items()},
        "signals": sig_list,
        "metrics": metrics,
        # 数据已校验为有限且等长; MA/STD 等起始不足段返回 null, 不计为跳过。
        "quality": {"bars": n, "skipped": 0},
    }


_DISPATCH = {
    "run": task_run, "lines": task_lines, "scan": task_scan, "funcs": task_funcs,
}


def dispatch(payload):
    task = payload.get("task")
    if task not in _DISPATCH:
        raise RunnerError("data", f"未知或缺少 task: {task!r}",
                          {"allowed": sorted(_DISPATCH)})
    return _DISPATCH[task](payload)


# ---------- 输出序列化 ----------

def _sanitize(o):
    """递归清理: numpy 标量 -> 原生值, NaN/Inf -> None, 保证 allow_nan=False 可序列化。"""
    if isinstance(o, dict):
        return {str(k): _sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_sanitize(x) for x in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, (bool, int, str)) or o is None:
        return o
    return str(o)


def main():
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            raise RunnerError("data", "空输入: 需要单行 JSON")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RunnerError("syntax", f"请求 JSON 解析失败: {e.msg}",
                              {"line": e.lineno, "col": e.colno})
        if not isinstance(payload, dict):
            raise RunnerError("data", "请求必须是 JSON 对象")
        result = dispatch(payload)
        code = 0
    except RunnerError as e:
        result = {"ok": False, "error": e.error, "kind": e.kind, "detail": e.detail}
        code = 1
    except SyntaxError as e:  # parser 抛的公式语法错误
        result = {"ok": False, "error": f"公式语法错误: {e}",
                  "kind": "syntax", "detail": {"message": str(e)}}
        code = 1
    except FormulaError as e:  # 未定义标识符 / 不支持函数 / 未来函数(继承 ValueError)
        result = {"ok": False, "error": str(e), "kind": "formula", "detail": {}}
        code = 1
    except Exception as e:  # 其余一律 internal, 带 traceback 供 Node 记日志
        result = {"ok": False, "error": "Python 内部异常", "kind": "internal",
                  "detail": {"type": type(e).__name__, "message": str(e),
                             "traceback": traceback.format_exc()}}
        code = 1
    sys.stdout.write(json.dumps(_sanitize(result), ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


if __name__ == "__main__":
    main()
