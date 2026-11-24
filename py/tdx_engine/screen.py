#!/usr/bin/env python3
"""批量公式选股（批量执行器，单次 spawn 处理多只）。

为什么单独一个脚本：runner.py 是「一只票一次进程」的回测协议，全市场几千只
挨个 spawn 光进程开销就要几分钟。这里一次吃进一批，共用同一份 AST。

协议与 runner 一致：stdin 单行 JSON → stdout 单行 JSON，异常结构化返回。

输入：
  {
    "formula": "...", "outputLine": "XG",
    "asOf": "2026-11-18",          # 调用方的"今天"，用于剔除未走完的 K 线
    "dropIncompleteTail": true,     # 月/周线：最后一根若是本期未完成，剔除
    "period": "month",
    "lookback": 3,                  # 每只返回最近几根的中间量
    "items": [{"sym": "sh600986", "name": "浙文互联",
               "rows": [["2020-01-31", o, c, h, l, v, amount], ...]}]
  }

输出：
  {
    "ok": true, "scanned": 60, "failed": 0,
    "hits": [{"sym","name","date","dev","box","vpos","close","i"}],
    "tails": {"sh600986": [{...}, ...]},   # 最近 lookback 根的指标
    "errors": [{"sym","error"}]
  }

刻意不做的事：
  - 不联网、不读库、不造 K 线；
  - 不猜"今天"（由 asOf 传入，避免 UTC/北京时区在两台机器上算出不同月份）；
  - 不静默丢样本：单只失败进 errors，不让整批挂掉。
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from tdx_engine.parser import parse                      # noqa: E402
from tdx_engine.functions import (Interpreter, execute_named,  # noqa: E402
                                  FormulaError)


class ScreenError(Exception):
    def __init__(self, kind, error, detail=None):
        super().__init__(error)
        self.kind = kind
        self.error = error
        self.detail = detail or {}


def _rows_to_ohlcv(rows):
    """rows: [[date, o, c, h, l, v, amount], ...] → ohlcv dict"""
    if not rows:
        raise ScreenError("data", "rows 为空")
    n = len(rows)
    out = {"datetime": [], "open": [], "close": [], "high": [],
           "low": [], "vol": [], "amount": []}
    for r in rows:
        if not isinstance(r, (list, tuple)) or len(r) < 6:
            raise ScreenError("data", "rows 元素需为 [date,o,c,h,l,v,(amount)]")
        out["datetime"].append(str(r[0]))
        out["open"].append(float(r[1]))
        out["close"].append(float(r[2]))
        out["high"].append(float(r[3]))
        out["low"].append(float(r[4]))
        out["vol"].append(float(r[5]))
        out["amount"].append(float(r[6]) if len(r) > 6 else 0.0)
    for k in ("open", "close", "high", "low", "vol", "amount"):
        a = np.asarray(out[k], dtype=float)
        if not np.all(np.isfinite(a)):
            raise ScreenError("data", "含非数值 K 线")
        out[k] = a
    if n != len(out["datetime"]):
        raise ScreenError("data", "字段长度不一致")
    return out, n


def _is_complete(period, date_str, as_of):
    """判断最后一根是否已走完：月线看月份 < asOf 的月份；周线看日期 < asOf 所在周的周一。

    只做「明显未完成」的判定，不追求精确交易日历 —— 宁可多留一根已完成，
    也不要拿半根月线去算量位（那是这个指标最容易出错的地方）。
    """
    if not as_of or not date_str:
        return True
    d = str(date_str)[:10]
    a = str(as_of)[:10]
    if period == "month":
        return d[:7] < a[:7]
    if period == "week":
        # 同一周内（7 天窗口）视为未完成
        from datetime import date as _d
        try:
            dd = _d(*[int(x) for x in d.split("-")])
            aa = _d(*[int(x) for x in a.split("-")])
        except ValueError:
            return True
        return (aa - dd).days >= 7
    return True


def _val(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def screen(payload):
    formula = payload.get("formula")
    if not isinstance(formula, str) or not formula.strip():
        raise ScreenError("data", "缺少 formula")
    line = payload.get("outputLine")
    if not line:
        raise ScreenError("data", "缺少 outputLine（必须手选，不自动猜）")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ScreenError("data", "items 必须是非空数组")
    period = str(payload.get("period") or "month")
    as_of = payload.get("asOf")
    drop_tail = bool(payload.get("dropIncompleteTail"))
    lookback = max(1, min(12, int(payload.get("lookback") or 3)))
    # 回溯窗口：月线选股不是「只有本月命中才算」，用户还要看「最近一年谁出过信号」。
    # 默认 12 个月；0 表示只看最后一根。
    months = int(payload.get("months") if payload.get("months") is not None else 12)
    months = max(0, min(120, months))

    ast = parse(formula)          # 语法错误 → SyntaxError，由上层转 kind=syntax

    hits, tails, errors = [], {}, []
    for it in items:
        sym = str(it.get("sym") or it.get("code") or "")
        name = str(it.get("name") or "")
        rows = it.get("rows") or []
        try:
            ohlcv, n = _rows_to_ohlcv(rows)
            if drop_tail and n > 1 and not _is_complete(period, ohlcv["datetime"][-1], as_of):
                ohlcv = {k: (v[:-1] if isinstance(v, np.ndarray) else v[:-1])
                         for k, v in ohlcv.items()}
                n -= 1
            if n < 40:
                errors.append({"sym": sym, "error": f"K 线不足（{n} 根）"})
                continue
            interp = Interpreter(ohlcv, n)
            outputs, _ = execute_named(ast, interp)
            if line not in outputs:
                errors.append({"sym": sym,
                               "error": f"输出线 {line} 不存在",
                               "available": sorted(outputs.keys())[:20]})
                continue
            sig = np.asarray(outputs[line], dtype=float)
            sig = np.nan_to_num(sig, nan=0.0)
            close = ohlcv["close"]
            dates = ohlcv["datetime"]

            # 最近 lookback 根的中间量，供「差一点就触发」的观察名单用
            tail = []
            for j in range(max(0, n - lookback), n):
                tail.append({
                    "date": dates[j],
                    "dev": _val(outputs.get("偏离", [None] * n)[j]) if "偏离" in outputs else None,
                    "box": _val(outputs.get("箱位", [None] * n)[j]) if "箱位" in outputs else None,
                    "vpos": _val(outputs.get("量位", [None] * n)[j]) if "量位" in outputs else None,
                    "close": _val(close[j]),
                    "hit": bool(sig[j] > 0),
                })
            tails[sym] = tail

            # 回溯窗口内每只票只报最近一次命中（再早的被 FILTER 抑制过，重复报没意义）
            lo = n - 1 - months if months > 0 else n - 1
            lo = max(0, lo)
            idx = [int(j) for j in np.flatnonzero(sig[lo:])]
            if idx:
                j = lo + idx[-1]
                hits.append({
                    "sym": sym, "name": name, "date": dates[j], "i": j,
                    "barsAgo": n - 1 - j,
                    "close": _val(close[j]),
                    "dev": _val(outputs.get("偏离", [None] * n)[j]) if "偏离" in outputs else None,
                    "box": _val(outputs.get("箱位", [None] * n)[j]) if "箱位" in outputs else None,
                    "vpos": _val(outputs.get("量位", [None] * n)[j]) if "量位" in outputs else None,
                })
        except (ScreenError, FormulaError) as e:
            errors.append({"sym": sym, "error": str(e)})
        except Exception as e:  # 单只异常不许拖垮整批
            errors.append({"sym": sym, "error": f"{type(e).__name__}: {e}"})

    return {"ok": True, "task": "screen", "scanned": len(items),
            "failed": len(errors), "hits": hits, "tails": tails, "errors": errors}


_DISPATCH = {"screen": screen}


def _sanitize(o):
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
            raise ScreenError("data", "空输入：需要单行 JSON")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ScreenError("data", "请求必须是 JSON 对象")
        task = payload.get("task", "screen")
        if task not in _DISPATCH:
            raise ScreenError("data", f"未知 task: {task!r}", {"allowed": sorted(_DISPATCH)})
        result = _DISPATCH[task](payload)
        code = 0
    except ScreenError as e:
        result = {"ok": False, "error": e.error, "kind": e.kind, "detail": e.detail}
        code = 1
    except SyntaxError as e:
        result = {"ok": False, "error": f"公式语法错误: {e}", "kind": "syntax",
                  "detail": {"message": str(e)}}
        code = 1
    except FormulaError as e:
        result = {"ok": False, "error": str(e), "kind": "formula", "detail": {}}
        code = 1
    except Exception as e:
        result = {"ok": False, "error": "Python 内部异常", "kind": "internal",
                  "detail": {"type": type(e).__name__, "message": str(e),
                             "traceback": traceback.format_exc()}}
        code = 1
    sys.stdout.write(json.dumps(_sanitize(result), ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


if __name__ == "__main__":
    main()
