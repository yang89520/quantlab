# 来源：tdx-backtest/tdxback/future_scan.py @ commit 95408fe
# 复制日期：2026-11-14
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。

"""未来函数检测(静态扫描公式 AST)。

回测最大的信任杀手是未来函数: 公式在 t 时刻引用了 t 之后的数据,
回测虚高, 实盘必然失效。本模块扫描 AST, 按风险等级报告:

- 高危: BACKSET / ZIG / ZIGA / FINDHIGH / FINDLOW 等"向未来看"的函数
- 中危: REF(X, 负数) / 副图引用主图未来段 / 常量数组(CONST 取全序列统计)
- 提示: 信号线本身依赖 HHV(0)(全历史最高)等, 会随未来数据回溯变化
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .parser import (Node, Number, Ident, Call, BinOp, UnaryOp,
                     AndOp, OrOp, NotOp, Assign, ExprStmt, parse)


# 通达信"向未来看"的函数 → 风险说明
FUTURE_FUNCS = {
    # 任务 §4.2 要求「实现但只用于可检测、出现即报高危」的未来函数族。
    # 本字典仅列高危项, 因此 has_critical 只由真未来函数触发(供 runner 拒绝 run)。
    "XMA":        ("高危", "XMA 偏移均线属未来函数, 回测虚高"),
    "ZIG":        ("高危", "ZIG 之字转向依赖后续走势确认拐点, 严重未来函数"),
    "ZIGA":       ("高危", "ZIGA 同 ZIG, 未来函数"),
    "PEAK":       ("高危", "PEAK 峰值需要未来数据确认, 未来函数"),
    "TROUGH":     ("高危", "TROUGH 谷值需要未来数据确认, 未来函数"),
    "PEAKBARS":   ("高危", "PEAKBARS 未来函数"),
    "TROUGHBARS": ("高危", "TROUGHBARS 未来函数"),
    "REFX":       ("高危", "REFX 反向引用未来数据, 未来函数"),
    "FINDHIGH":   ("高危", "FINDHIGH 向后搜索极值, 使用了未来数据"),
    "FINDLOW":    ("高危", "FINDLOW 向后搜索极值, 使用了未来数据"),
    # 说明: BACKSET / CONST / SUMBARS / REFDATE / VALUEWHEN 均为本项目已支持的
    # 常规函数(见 functions.py), 不纳入高危拒绝集, 避免与 run 计算冲突。
    # REF(X, 负数) 仍由 _walk 单独判为高危。
}

# 依赖全序列统计、结果随数据增长回溯变化的函数
LOOKBACK_MUTABLE = {
    "HHV": "HHV(X,0) 取全部历史最高, 每根新K都会改变历史信号",
    "LLV": "LLV(X,0) 取全部历史最低, 每根新K都会改变历史信号",
    "SUM": "SUM(X,0) 从上市累计, 历史值随时间漂移(通常可接受)",
}


@dataclass
class Finding:
    level: str          # 高危 / 中危 / 提示
    func: str
    detail: str
    stmt: str = ""      # 所在语句(输出名)


@dataclass
class ScanResult:
    findings: List[Finding] = field(default_factory=list)

    @property
    def has_critical(self) -> bool:
        return any(f.level == "高危" for f in self.findings)

    @property
    def has_warning(self) -> bool:
        return any(f.level == "中危" for f in self.findings)

    def summary(self) -> str:
        if not self.findings:
            return "未检测到未来函数 ✓"
        n_h = sum(1 for f in self.findings if f.level == "高危")
        n_m = sum(1 for f in self.findings if f.level == "中危")
        n_i = sum(1 for f in self.findings if f.level == "提示")
        parts = []
        if n_h: parts.append(f"{n_h} 项高危")
        if n_m: parts.append(f"{n_m} 项中危")
        if n_i: parts.append(f"{n_i} 项提示")
        return "、".join(parts)

    def verdict(self) -> str:
        if self.has_critical:
            return ("不可信: 公式含未来函数, 回测结果必然虚高, 请先移除标红函数后再评估")
        if self.has_warning:
            return ("存疑: 存在中风险写法, 回测结果可能偏乐观, 建议人工复核标黄项")
        return ("通过: 未发现典型未来函数, 可以进入回测评估")


def _walk(node: Node, out: List[Finding], stmt_name: str):
    if isinstance(node, Call):
        name = node.func
        if name in FUTURE_FUNCS:
            lvl, msg = FUTURE_FUNCS[name]
            out.append(Finding(lvl, name, msg, stmt_name))
        elif name in ("HHV", "LLV") and len(node.args) >= 2:
            # HHV(X, 0) → 全历史窗口, 信号会随新数据回溯变化
            n = node.args[1]
            if isinstance(n, Number) and n.value == 0:
                out.append(Finding("提示", name, LOOKBACK_MUTABLE[name], stmt_name))
        elif name == "SUM" and len(node.args) >= 2:
            n = node.args[1]
            if isinstance(n, Number) and n.value == 0:
                out.append(Finding("提示", "SUM", LOOKBACK_MUTABLE["SUM"], stmt_name))
        elif name == "REF" and len(node.args) >= 2:
            # REF(X, 负数) = 引用未来
            n = node.args[1]
            if isinstance(n, Number) and n.value < 0:
                out.append(Finding("高危", "REF",
                                   f"REF(X, {int(n.value)}) 引用了未来 {abs(int(n.value))} 根bar的数据",
                                   stmt_name))
            elif isinstance(n, UnaryOp) and n.op == "-" and isinstance(n.operand, Number):
                v = int(n.operand.value)
                out.append(Finding("高危", "REF",
                                   f"REF(X, -{v}) 引用了未来 {v} 根bar的数据", stmt_name))
        for a in node.args:
            _walk(a, out, stmt_name)
    elif isinstance(node, BinOp):
        _walk(node.left, out, stmt_name)
        _walk(node.right, out, stmt_name)
    elif isinstance(node, UnaryOp):
        _walk(node.operand, out, stmt_name)
    elif isinstance(node, (AndOp, OrOp)):
        _walk(node.left, out, stmt_name)
        _walk(node.right, out, stmt_name)
    elif isinstance(node, NotOp):
        _walk(node.operand, out, stmt_name)


def scan_formula(formula_text: str) -> ScanResult:
    """解析公式源码并扫描未来函数风险。语法错误时抛 SyntaxError。"""
    ast = parse(formula_text)
    result = ScanResult()
    for stmt in ast:
        name = stmt.name if isinstance(stmt, Assign) else "(表达式语句)"
        target = stmt.expr if isinstance(stmt, Assign) else stmt.expr
        _walk(target, result.findings, name)
    # 去重(同一函数同一语句只报一次)
    seen = set()
    dedup = []
    for f in result.findings:
        key = (f.level, f.func, f.stmt)
        if key not in seen:
            seen.add(key)
            dedup.append(f)
    result.findings = dedup
    return result


def format_scan(result: ScanResult) -> str:
    lines = ["=" * 60, "未来函数检测", "=" * 60]
    if not result.findings:
        lines.append("未检测到未来函数 ✓")
    else:
        icon = {"高危": "✗", "中危": "!", "提示": "?"}
        for f in result.findings:
            lines.append(f"[{icon[f.level]} {f.level}] {f.func}"
                         + (f" (语句: {f.stmt})" if f.stmt else ""))
            lines.append(f"        {f.detail}")
    lines.append("-" * 60)
    lines.append(f"结论: {result.verdict()}")
    return "\n".join(lines)
