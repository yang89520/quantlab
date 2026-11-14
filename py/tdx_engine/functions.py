# 来源：tdx-backtest/tdxback/functions.py @ commit 95408fe
# 复制日期：2026-11-14
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。

"""通达信公式 解释器: AST -> 逐 bar 数组(基于 numpy)。

语义要点(尽力贴近通达信):
- 所有中间量/输出均为长度为 N 的浮点数组, N = 当前回测 bar 总数。
- 递归函数 EMA/SMA/DMA/WMA 起始值取首根的前值。
- REF/HHV/LLV/COUNT/SUM 等在起始不足段按通达信习惯处理(初值不参与/用 0)。
- CROSS 按上穿/下穿定义。
"""
from __future__ import annotations

import numpy as np

from .parser import (Node, Number, String, Ident, Call, BinOp, UnaryOp,
                     AndOp, OrOp, NotOp, Assign, ExprStmt)


_INVALID = np.nan


class FormulaError(ValueError):
    pass


class Interpreter:
    def __init__(self, ohlcv: dict, n: int):
        """ohlcv: {open/high/low/close/vol/amount/datetime}; n=bar 数"""
        self.n = n
        self.vars = {}
        self._push_data(ohlcv)

    # ---------- 数据序列 ----------
    def _push_data(self, d: dict):
        o = np.asarray(d["open"], dtype=float)
        h = np.asarray(d["high"], dtype=float)
        l = np.asarray(d["low"], dtype=float)
        c = np.asarray(d["close"], dtype=float)
        v = np.asarray(d["vol"], dtype=float)
        a = np.asarray(d.get("amount", 0.0), dtype=float)
        self.close = c
        self.open = o
        self.high = h
        self.low = l
        self.vol = v
        self.amount = a
        self._dates = d.get("datetime", None)
        binds = {
            "CLOSE": c, "C": c, "OPEN": o, "O": o,
            "HIGH": h, "H": h, "LOW": l, "L": l,
            "VOL": v, "V": v, "AMOUNT": a,
        }
        self.vars.update(binds)
        self._bind_dates()

    def _bind_dates(self):
        if self._dates is None:
            return
        yr = np.zeros(self.n, dtype=int)
        mo = np.zeros(self.n, dtype=int)
        dy = np.zeros(self.n, dtype=int)
        wd = np.zeros(self.n, dtype=int)
        for i, ts in enumerate(self._dates):
            dt = _coerce_date(ts)
            if dt is None:
                continue
            yr[i], mo[i], dy[i] = dt.year, dt.month, dt.day
            wd[i] = dt.weekday()
        self.vars.update({"YEAR": yr.astype(float), "MONTH": mo.astype(float),
                          "DAY": dy.astype(float), "WEEKDAY": wd.astype(float)})

    # ---------- 求值 ----------
    def eval(self, node: Node, assign: bool = False):
        if isinstance(node, Number):
            return _const(np.full(self.n, node.value, dtype=float))
        if isinstance(node, String):
            return _const(np.full(self.n, 0.0, dtype=float))
        if isinstance(node, Ident):
            if node.name in self.vars:
                return self.vars[node.name]
            # 未定义标识符: 绝不静默返回 0(拼写错误会变成"跑通但无信号", 极难排查)。
            # 给出编辑距离 <=2 的最相近已定义名称作为提示。
            hint = _closest_name(node.name, self.vars.keys())
            msg = f"未定义的标识符 {node.name}"
            if hint:
                msg += f"，是否想用 {hint}"
            raise FormulaError(msg)
        if isinstance(node, Call):
            return self._call(node)
        if isinstance(node, BinOp):
            a, b = self.eval(node.left), self.eval(node.right)
            return _binary(node.op, a, b)
        if isinstance(node, UnaryOp):
            a = self.eval(node.operand)
            if node.op == "-":
                return -a
            return a
        if isinstance(node, AndOp):
            return _truth(self.eval(node.left)) & _truth(self.eval(node.right))
        if isinstance(node, OrOp):
            return _truth(self.eval(node.left)) | _truth(self.eval(node.right))
        if isinstance(node, NotOp):
            return ~_truth(self.eval(node.operand))
        if isinstance(node, Assign):
            val = self.eval(node.expr)
            self.vars[node.name] = val
            return val
        raise FormulaError(f"无法求值的节点: {type(node).__name__}")

    def _call(self, node: Call):
        name = node.func
        args = node.args
        # 绘图/输出类函数: 回测忽略图形, 返回安全的数组
        if name in _DRAW_FUNCS:
            return _safe_draw_result(self, name, args)
        handler = _FUNCS.get(name)
        if handler is None:
            raise FormulaError(
                f"不支持的函数 {name}(). 已支持: {', '.join(sorted(set(_FUNCS) | set(_DRAW_FUNCS)))}")
        return handler(self, args)

    # 供函数族调用的参数求值
    def arg(self, args, i, default=None):
        if i < len(args):
            return self.eval(args[i])
        return default

    def arg_scalar(self, node, default=None):
        val = self.eval(node) if node is not None else default
        arr = np.asarray(val, dtype=float)
        if arr.ndim == 0:
            return float(arr)
        return float(arr[-1]) if len(arr) else default


# ---------- 工具 ----------

def _const(arr):
    return arr


def _truth(a):
    arr = np.asarray(a, dtype=float)
    return arr > 0.0


def _f(a):
    return np.asarray(a, dtype=float)


def _binary(op, a, b):
    a, b = _f(a), _f(b)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.divide(a, b)   # 0 除 → inf/nan
    if op == "%":
        return np.mod(a, b)
    if op == "=":
        return a == b
    if op == "<>":
        return a != b
    if op == ">":
        return a > b
    if op == "<":
        return a < b
    if op == ">=":
        return a >= b
    if op == "<=":
        return a <= b
    if op == "&&":
        return _truth(a) & _truth(b)
    if op == "||":
        return _truth(a) | _truth(b)
    raise FormulaError(f"未知运算符 {op}")


# ---------- 滚动窗口(处理起始不足) ----------

def _valid_window(n) -> bool:
    return isinstance(n, (int, float)) and n > 0 and n != _INVALID


def _roll_window(X, N):
    """REF 语义: out[i] = X[i-N], 起始 N 根取 nan/无效。返回 (数组, 起始有效idx)。"""
    n = int(N)
    if n <= 0:
        return X, 0
    out = np.full(len(X), _INVALID, dtype=float)
    if n < len(X):
        out[n:] = X[:len(X) - n]
    return out, n


# ============ 函数实现 ============

def _MA(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 1)
    if N <= 0:
        N = 1
    out = np.full(len(X), _INVALID, dtype=float)
    # 窗口内 NaN 不参与求和与计数(与通达信"无效值不参与"一致)
    vcs = np.cumsum((~np.isnan(X)).astype(float))
    cs = np.cumsum(np.nan_to_num(X, nan=0.0))
    for i in range(len(X)):
        j0 = max(0, i - N + 1)
        cnt = vcs[i] - (vcs[j0 - 1] if j0 >= 1 else 0.0)
        s = cs[i] - (cs[j0 - 1] if j0 >= 1 else 0.0)
        out[i] = s / cnt if cnt > 0 else _INVALID
    return out


def _EMA(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 12)
    if N <= 0:
        N = 1
    alpha = 2.0 / (N + 1)
    out = np.full(len(X), _INVALID, dtype=float)
    if len(X) == 0:
        return out
    valid = np.flatnonzero(~np.isnan(X))
    if len(valid) == 0:
        return out
    s = int(valid[0])
    out[s] = X[s]
    for i in range(s + 1, len(X)):
        if np.isnan(X[i]):          # 无效值不参与, 沿用上一值
            out[i] = out[i - 1]
        else:
            out[i] = alpha * X[i] + (1 - alpha) * out[i - 1]
    return out


def _SMA(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 3)
    M = _int(interp.arg_scalar(args[2]) if len(args) > 2 else 1)
    if N <= 0:
        N = 1
    out = np.full(len(X), _INVALID, dtype=float)
    if len(X) == 0:
        return out
    valid = np.flatnonzero(~np.isnan(X))
    if len(valid) == 0:
        return out
    s = int(valid[0])
    out[s] = X[s]
    for i in range(s + 1, len(X)):
        if np.isnan(X[i]):
            out[i] = out[i - 1]
        else:
            out[i] = (M * X[i] + (N - M) * out[i - 1]) / N
    return out


def _WMA(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 5)
    if N <= 0:
        N = 1
    out = np.full(len(X), _INVALID, dtype=float)
    weights = np.arange(N, 0, -1, dtype=float)
    for i in range(len(X)):
        if i < N:
            w = np.arange(i + 1, 0, -1, dtype=float)
            out[i] = np.dot(X[:i + 1], w) / np.sum(w)
        else:
            out[i] = np.dot(X[i - N + 1:i + 1], weights) / np.sum(weights)
    return out


def _DMA(interp, args):
    X = _f(interp.arg(args, 0))
    A = _f(interp.arg(args, 1))
    out = np.full(len(X), _INVALID, dtype=float)
    if len(X) == 0:
        return out
    out[0] = X[0]
    for i in range(1, len(X)):
        a = A[i]
        out[i] = a * X[i] + (1 - a) * out[i - 1]
    return out


def _REF(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 1)
    out, start = _roll_window(X, N)
    return out


def _HHV(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.copy(X)
    win = 0.0
    for i in range(len(X)):
        start = max(0, i - n + 1)
        out[i] = np.nanmax(X[start:i + 1])
    return out


def _LLV(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.copy(X)
    for i in range(len(X)):
        start = max(0, i - n + 1)
        out[i] = np.nanmin(X[start:i + 1])
    return out


def _HHVBARS(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        start = max(0, i - n + 1)
        seg = X[start:i + 1]
        if np.all(np.isnan(seg)):       # 全无效窗口不崩溃, 返回无效
            continue
        idx = int(np.nanargmax(seg))
        out[i] = (len(seg) - 1) - idx
    return out


def _LLVBARS(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        start = max(0, i - n + 1)
        seg = X[start:i + 1]
        if np.all(np.isnan(seg)):
            continue
        idx = int(np.nanargmin(seg))
        out[i] = (len(seg) - 1) - idx
    return out


def _SUM(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    cs = np.nancumsum(X)
    out = np.copy(cs)
    for i in range(len(X)):
        if i >= n:
            out[i] = cs[i] - cs[i - n]
    return out


def _COUNT(interp, args):
    C = _truth(interp.eval(args[0]));
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(C)
    cum = np.cumsum(C.astype(float))
    out = np.copy(cum)
    for i in range(len(C)):
        out[i] = cum[i] - (cum[i - n] if i >= n else 0.0)
    return out


def _CROSS(interp, args):
    X = _f(interp.eval(args[0]))
    Y = _f(interp.eval(args[1])) if len(args) > 1 else _const(np.zeros(len(X), dtype=float))
    up = np.zeros(len(X), dtype=bool)
    for i in range(1, len(X)):
        up[i] = X[i] > Y[i] and X[i - 1] <= Y[i - 1]
    return up


def _BARSLAST(interp, args):
    C = _truth(interp.eval(args[0]))
    out = np.zeros(len(C), dtype=float)
    last = -1
    for i in range(len(C)):
        if C[i]:
            last = i
        out[i] = float(i - last) if last >= 0 else float(i + 1)
    return out


def _BARSLASTCOUNT(interp, args):
    C = _truth(interp.eval(args[0]))
    out = np.zeros(len(C), dtype=float)
    cnt = 0
    for i in range(len(C)):
        cnt = cnt + 1 if C[i] else 0
        out[i] = float(cnt)
    return out


def _FILTER(interp, args):
    C = _truth(interp.eval(args[0]))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 5)
    out = np.zeros(len(C), dtype=bool)
    last_sig = -10 ** 9
    for i in range(len(C)):
        if C[i] and i - last_sig > N:
            out[i] = True
            last_sig = i
    return out


def _BACKSET(interp, args):
    # 通达信语义: 条件成立时, 把"当前及之前共N根"置1(向前回标)
    C = _truth(interp.eval(args[0]))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 1)
    out = np.zeros(len(C), dtype=bool)
    n = max(1, N)
    for i in range(len(C)):
        if C[i]:
            out[max(0, i - n + 1): i + 1] = True
    return out


def _EVERY(interp, args):
    C = _truth(interp.eval(args[0]))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(C)
    out = np.zeros(len(C), dtype=bool)
    for i in range(len(C)):
        start = max(0, i - n + 1)
        out[i] = bool(np.all(C[start:i + 1]))
    return out


def _IF(interp, args):
    cond = _truth(interp.eval(args[0]))
    a = _f(interp.eval(args[1]))
    b = _f(interp.eval(args[2])) if len(args) > 2 else np.zeros(len(cond))
    return np.where(cond, a, b)


def _ABS(interp, args): return np.abs(_f(interp.arg(args, 0)))
def _MAX(interp, args):
    a, b = _f(interp.arg(args, 0)), _f(interp.arg(args, 1))
    return np.maximum(a, b)
def _MIN(interp, args):
    a, b = _f(interp.arg(args, 0)), _f(interp.arg(args, 1))
    return np.minimum(a, b)
def _MOD(interp, args):
    a, b = _f(interp.arg(args, 0)), _f(interp.arg(args, 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.mod(a, b)
def _POW(interp, args):
    a, b = _f(interp.arg(args, 0)), _f(interp.arg(args, 1))
    with np.errstate(invalid="ignore"):
        return np.power(a, b)
def _SQRT(interp, args): return np.sqrt(_f(interp.arg(args, 0)))
def _LN(interp, args): return np.log(_f(interp.arg(args, 0)))
def _LOG(interp, args): return np.log10(_f(interp.arg(args, 0)))
def _EXP(interp, args): return np.exp(_f(interp.arg(args, 0)))
def _FLOOR(interp, args): return np.floor(_f(interp.arg(args, 0)))
def _CEILING(interp, args): return np.ceil(_f(interp.arg(args, 0)))
def _ROUND(interp, args): return np.round(_f(interp.arg(args, 0)))
def _CONST(interp, args): return _f(interp.arg(args, 0))


# ---------- 绘图/输出类函数(回测忽略, 安全求值) ----------

_DRAW_FUNCS = {
    "DRAWICON", "DRAWTEXT", "DRAWKLINE", "STICKLINE", "POLYLINE",
    "DRAWBAND", "PARTLINE", "DRAWNULL", "DRAWNUMBER", "DRAWLINE",
    "PLOYLINE", "STICK", "CROSSUP", "DOTLINE", "LINESTICK", "MODE",
    "PRECISION", "COLORMAGENTA", "COLORRED", "COLORWHITE", "COLORCYAN",
    "COLORGRAY", "COLORBLUE", "COLORGREEN", "COLORYELLOW", "NODRAW",
    "LINETHICK", "NOTEXT", "SHFT", "COLORBLACK",
}


def _safe_draw_result(interp, name, args):
    # 返回第一个输入数组, 保证赋值不断链; 无输入返回零数组
    if args:
        return _f(interp.eval(args[0]))
    return _const(np.zeros(interp.n, dtype=float))


# ============ 本项目扩充(§4.1 12 个常规函数 + §4.2 未来函数族) ============

# 未来函数族: 实现目的仅为「可检测」, 出现即报高危, 不可用于信号。
FUTURE_FUNC_NAMES = {
    "XMA", "ZIG", "ZIGA", "PEAK", "TROUGH",
    "PEAKBARS", "TROUGHBARS", "REFX",
}


def _reject_future(interp, args):
    raise FormulaError(
        "高危/未来函数不允许用于信号计算(仅可经 scan 检测), 请移除后重试")


def _edit_distance(a, b):
    # Levenshtein 编辑距离(传入已统一大写的名字)。
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _closest_name(name, defined):
    # 在已定义名(内置量 + 已赋值中间变量)中找编辑距离 <=2 的最相近者。
    best, best_d = None, 3
    for cand in defined:
        d = _edit_distance(name, cand)
        if d < best_d:
            best, best_d = cand, d
    return best


def _coerce_date(ts):
    # 把协议日期(字符串/数字/datetime)转为 datetime, 失败返回 None。
    from datetime import datetime as _dt, date as _date
    if hasattr(ts, "to_pydatetime"):
        return ts.to_pydatetime()
    if isinstance(ts, _dt):
        return ts
    if isinstance(ts, _date):
        return _dt(ts.year, ts.month, ts.day)
    s = str(ts)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d",
                "%Y-%m-%d %H:%M:%S", "%Y%m%d %H:%M:%S"):
        try:
            return _dt.strptime(s, fmt)
        except ValueError:
            pass
    try:
        x = float(ts)
        return _dt.fromtimestamp(x if x > 1e9 else x * 1000)
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def _rolling_valid(X, i, N):
    # 窗口 [i-N+1, i] 内的有效(非 NaN)值。
    j0 = max(0, i - N + 1)
    w = X[j0:i + 1]
    return w[~np.isnan(w)]


# ---- §4.1 必补: 12 个常规函数 ----

def _STD(interp, args):
    # N 周期标准差, 与 numpy.std(ddof=0) 一致(BOLL 必用)。
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        v = _rolling_valid(X, i, n)
        out[i] = np.std(v, ddof=0) if len(v) else _INVALID
    return out


def _VAR(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        v = _rolling_valid(X, i, n)
        out[i] = np.var(v, ddof=0) if len(v) else _INVALID
    return out


def _AVEDEV(interp, args):
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    out = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        v = _rolling_valid(X, i, n)
        out[i] = np.mean(np.abs(v - v.mean())) if len(v) else _INVALID
    return out


def _EXIST(interp, args):
    C = _truth(interp.eval(args[0]))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(C)
    out = np.zeros(len(C), dtype=bool)
    for i in range(len(C)):
        out[i] = bool(np.any(C[max(0, i - n + 1):i + 1]))
    return out


def _VALUEWHEN(interp, args):
    C = _truth(interp.eval(args[0]))
    X = _f(interp.eval(args[1])) if len(args) > 1 else np.zeros(len(C))
    out = np.zeros(len(C), dtype=float)
    last = 0.0
    for i in range(len(C)):
        if C[i]:
            last = X[i]
        out[i] = last
    return out


def _BARSSINCE(interp, args):
    C = _truth(interp.eval(args[0]))
    out = np.zeros(len(C), dtype=float)
    first = -1
    for i in range(len(C)):
        if C[i] and first < 0:
            first = i
        out[i] = float(i - first) if first >= 0 else 0.0
    return out


def _SIGN(interp, args):
    return np.sign(_f(interp.arg(args, 0)))


def _INTPART(interp, args):
    # 截断取整(向零), 不是四舍五入: INTPART(-1.7) == -1。
    return np.trunc(_f(interp.arg(args, 0)))


def _BETWEEN(interp, args):
    X = _f(interp.arg(args, 0))
    A = _f(interp.arg(args, 1))
    B = _f(interp.arg(args, 2))
    return (X >= A) & (X <= B)


def _linreg(interp, args):
    # 返回 (N 周期斜率数组, 当前 bar 线性回归拟合值数组)。
    X = _f(interp.arg(args, 0))
    N = _int(interp.arg_scalar(args[1]) if len(args) > 1 else 0)
    n = N if N > 0 else len(X)
    slope = np.full(len(X), _INVALID, dtype=float)
    fit = np.full(len(X), _INVALID, dtype=float)
    for i in range(len(X)):
        j0 = max(0, i - n + 1)
        y = X[j0:i + 1]
        m = len(y)
        if m < 2 or np.any(np.isnan(y)):
            continue
        x = np.arange(m, dtype=float)
        b, a = np.polyfit(x, y, 1)
        slope[i] = b
        fit[i] = a + b * (m - 1)
    return slope, fit


def _SLOPE(interp, args):
    return _linreg(interp, args)[0]


def _FORCAST(interp, args):
    # 通达信 FORCAST(X,N): N 周期线性回归在当前 bar 的预测值。
    return _linreg(interp, args)[1]


def _LONGCROSS(interp, args):
    A = _f(interp.eval(args[0]))
    B = _f(interp.eval(args[1]))
    N = _int(interp.arg_scalar(args[2]) if len(args) > 2 else 0)
    n = N if N > 0 else 1
    out = np.zeros(len(A), dtype=bool)
    for i in range(1, len(A)):
        if A[i] > B[i] and A[i - 1] <= B[i - 1]:
            j0 = max(0, i - n)
            if np.all(A[j0:i] < B[j0:i]):
                out[i] = True
    return out


def list_functions():
    # 返回已支持函数清单(分类), 供 runner 的 task:"funcs" 使用。
    normal = sorted(set(_FUNCS) - FUTURE_FUNC_NAMES)
    return {
        "functions": normal,
        "futureFunctions": sorted(FUTURE_FUNC_NAMES),
        "drawFunctions": sorted(_DRAW_FUNCS),
    }


def _int(v):
    if v is None or v != v or np.isnan(float(v)):
        return 0
    return int(round(float(v)))


_FUNCS = {
    "MA": _MA, "EMA": _EMA, "SMA": _SMA, "WMA": _WMA, "DMA": _DMA,
    "REF": _REF, "HHV": _HHV, "LLV": _LLV, "HHVBARS": _HHVBARS, "LLVBARS": _LLVBARS,
    "SUM": _SUM, "COUNT": _COUNT, "CROSS": _CROSS, "BARSLAST": _BARSLAST,
    "BARSLASTCOUNT": _BARSLASTCOUNT, "FILTER": _FILTER, "BACKSET": _BACKSET,
    "EVERY": _EVERY, "IF": _IF, "ABS": _ABS, "MAX": _MAX, "MIN": _MIN,
    "MOD": _MOD, "POW": _POW, "SQRT": _SQRT, "LN": _LN, "LOG": _LOG,
    "EXP": _EXP, "FLOOR": _FLOOR, "CEILING": _CEILING, "ROUND": _ROUND,
    "CONST": _CONST,
    # §4.1 扩充的 12 个常规函数
    "STD": _STD, "VAR": _VAR, "AVEDEV": _AVEDEV, "EXIST": _EXIST,
    "VALUEWHEN": _VALUEWHEN, "BARSSINCE": _BARSSINCE, "SIGN": _SIGN,
    "INTPART": _INTPART, "BETWEEN": _BETWEEN, "SLOPE": _SLOPE,
    "FORCAST": _FORCAST, "LONGCROSS": _LONGCROSS,
    # §4.2 未来函数族: 仅可检测, 调用即拒绝
    **{nm: _reject_future for nm in FUTURE_FUNC_NAMES},
}


def execute_named(formula_ast, interp, progress=None):
    """顺序执行语句, 返回 {输出名: 数组} 与 {所有名: 数组}。
    输出名 = 以 ':' 声明(非 ':= ') 的变量; 绘图函数语句被安全忽略。
    progress: 可选回调 fn(i, name), 每执行一条语句调用一次。
    """
    outputs = {}
    all_vars = dict(interp.vars)
    for i, stmt in enumerate(formula_ast):
        if isinstance(stmt, Assign):
            val = interp.eval(stmt)
            if progress:
                progress(i, stmt.name)
            if stmt.draw and "NODRAW" in [d.upper() for d in stmt.draw]:
                pass  # NODRAW 不画, 但仍然是中间量
            elif stmt.draw and any(d.upper() in _DRAW_FUNCS for d in stmt.draw):
                pass
            else:
                outputs[stmt.name] = val
        elif isinstance(stmt, ExprStmt):
            interp.eval(stmt.expr)   # 绘图函数副作用忽略
            if progress:
                progress(i, "(绘图语句)")
    return outputs, interp.vars