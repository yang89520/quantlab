#!/usr/bin/env python3
# 三期 Python 公式引擎 · 自检(对应 docs/dev/05 §9.1)。
# 本项目独立实现, 非上游复制文件。
# 说明: 这里的 ohlcv 是"仅用于数学自检"的确定性合成数据;
#       runner.py 本身绝不造数据, 只处理调用方传入的 K 线。
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from tdx_engine import future_scan                          # noqa: E402
from tdx_engine.parser import parse                         # noqa: E402
from tdx_engine.functions import (Interpreter, execute_named,  # noqa: E402
                                  FormulaError)

_N = 60


def make_ohlcv(n=_N):
    """确定性合成数据: 仅验证公式数学正确性。"""
    b = np.arange(n, dtype=float)
    close = 10.0 + np.sin(b / 3.0) * 2.0 + b * 0.05
    op = close - 0.1
    high = close + 0.3
    low = close - 0.3
    vol = 10000.0 + b * 10
    amount = vol * close
    dates = [(date(2026, 1, 5) + timedelta(days=int(i))).isoformat()
             for i in range(n)]
    return {
        "datetime": dates,
        "open": op.tolist(), "high": high.tolist(), "low": low.tolist(),
        "close": close.tolist(), "vol": vol.tolist(), "amount": amount.tolist(),
    }


OHLCV = make_ohlcv()
C = np.asarray(OHLCV["close"], dtype=float)


def run(formula, ohlcv=None):
    ohlcv = ohlcv or OHLCV
    itp = Interpreter(ohlcv, len(ohlcv["close"]))
    outputs, _ = execute_named(parse(formula), itp)
    return outputs


# ---------- 8 个用例 ----------

def t1_ma():
    out = run("M:MA(C,5);")["M"]
    for i in (4, 5, 10, 30, 59):
        expected = C[i - 4:i + 1].mean()  # 手算: 最近 5 根均值
        assert abs(out[i] - expected) < 1e-9, (i, out[i], expected)


def t2_std():
    out = run("S:STD(C,20);")["S"]
    for i in (19, 20, 30, 59):
        expected = np.std(C[i - 19:i + 1], ddof=0)  # 与 numpy.std(ddof=0) 一致
        assert abs(out[i] - expected) < 1e-9, (i, out[i], expected)


def t3_intpart():
    out = run("V:INTPART(-1.7);")["V"]
    assert out[0] == -1, out[0]  # 截断, 不是四舍五入(-1 而非 -2)


def t4_sign():
    out = run("V:SIGN(-0.001);")["V"]
    assert out[0] == -1, out[0]


def t5_undefined_ident():
    try:
        run("X:CLOES;")
        raise AssertionError("未定义标识符未抛错(静默返回 0 是禁止的)")
    except FormulaError as e:
        msg = str(e)
        assert "CLOES" in msg and "CLOSE" in msg, msg  # 提示最相近的已定义名


def t6_unsupported_func():
    try:
        run("X:FOO(C,5);")
        raise AssertionError("不支持函数未抛错")
    except FormulaError as e:
        msg = str(e)
        assert "FOO" in msg and "MA" in msg and "STD" in msg, msg  # 报函数名 + 已支持清单


def t7_zig_scan():
    res = future_scan.scan_formula("X:ZIG(3,5);")
    assert res.has_critical, "ZIG 未被判为高危"
    assert any(f.func == "ZIG" and f.level == "高危" for f in res.findings)


def t8_boll():
    boll = ("MID:MA(C,20);\n"
            "UPPER:MID+2*STD(C,20);\n"
            "LOWER:MID-2*STD(C,20);\n"
            "BUY:CROSS(C,LOWER);")
    out = run(boll)
    for k in ("MID", "UPPER", "LOWER", "BUY"):
        assert k in out and len(out[k]) == _N, k
    std = run("S:STD(C,20);")["S"]
    upper = out["UPPER"]
    for i in (19, 30, 59):
        # 含 STD 的 BOLL 上轨 = 中轨 + 2*STD, 且整条公式跑通
        expected = out["MID"][i] + 2 * std[i]
        assert abs(upper[i] - expected) < 1e-9, (i, upper[i], expected)
    assert np.isfinite(upper[19:]).all()


TESTS = [
    ("MA(C,5) 手算一致", t1_ma),
    ("STD(C,20) 与 numpy.std(ddof=0) 一致", t2_std),
    ("INTPART(-1.7) == -1", t3_intpart),
    ("SIGN(-0.001) == -1", t4_sign),
    ("未定义标识符 CLOES 抛错并提示 CLOSE", t5_undefined_ident),
    ("不支持函数 FOO() 抛错并列出已支持清单", t6_unsupported_func),
    ("ZIG(3,5) 被 scan 报高危", t7_zig_scan),
    ("BOLL 公式(含 STD)能跑通", t8_boll),
]


def main():
    print("=" * 56)
    print("tdx_engine selftest (numpy %s)" % np.__version__)
    print("=" * 56)
    passed = 0
    for name, fn in TESTS:
        try:
            fn()
            passed += 1
            print("[PASS] %s" % name)
        except Exception as e:
            print("[FAIL] %s -> %s: %s" % (name, type(e).__name__, e))
    print("-" * 56)
    print("结果: %d/%d 通过" % (passed, len(TESTS)))
    sys.exit(0 if passed == len(TESTS) else 1)


if __name__ == "__main__":
    main()
