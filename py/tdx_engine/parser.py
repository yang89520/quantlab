# 来源：tdx-backtest/tdxback/parser.py @ commit 95408fe
# 复制日期：2026-11-14
# 本文件已由本项目独立维护，不再与上游同步。
# 上游若有修复，需人工比对后手工移植。

"""通达信公式语言 词法 + 语法分析器。

把通达信公式源码解析成一串语句的 AST。语句形如:

    name := expr        # 中间变量(不输出)
    name : expr         # 输出变量(画线)
    expr                # 表达式语句(多为绘图函数调用, 如 DRAWKLINE(...))

绘制指令 (如 COLORRED/STICK/LINETHICK2/NODRAW/DOTLINE/DRAWNULL/LINESTICK 等)
位于表达式的逗号之后, 对回测无意义, 解析时段落整句即可。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Union

# ---------- 词法 ----------

@dataclass
class Token:
    kind: str            # NUMBER / STRING / IDENT / OP / NEWLINE / COLON / ASSIGN / COMMA / LPAR / RPAR / COMMENT
    value: str
    pos: int


_NUMBER_RE = re.compile(r"-?\d+(\.\d+)?([eE][+-]?\d+)?")
_NAME_RE = re.compile(r"[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5.]*")

# 运算符(按长度降序, 保证 := 先于 : ; <= >= 先于 < >)
_OP2 = (":=", "<=", ">=", "<>", "&&", "||")
_OP1 = (":", ">", "<", "=", "+", "-", "*", "/", ",", "(", ")", "%")


def tokenize(source: str) -> List[Token]:
    tokens: List[Token] = []
    i, n = 0, len(source)
    while i < n:
        c = source[i]
        # 注释: {} / /* */ / //
        if c == "{":
            j = source.find("}", i + 1)
            j = n if j < 0 else j
            tokens.append(Token("COMMENT", source[i:j + 1], i))
            i = j + 1
            continue
        if source.startswith("/*", i):
            j = source.find("*/", i + 2)
            j = n if j < 0 else j
            i = j + 2
            continue
        if source.startswith("//", i):
            j = source.find("\n", i + 2)
            j = n if j < 0 else j
            i = j
            continue
        if c in " \t\r\x0c":
            i += 1
            continue
        if c == ";" or c == "\n":
            tokens.append(Token("NEWLINE", c, i))
            i += 1
            continue
        m = _NUMBER_RE.match(source, i)
        if m:
            # 负号开头仅在单目位置(前一token是操作符/起始/分隔)才并入数字;
            # 否则是二元减法, 如 C-1 必须拆成 C - 1
            if m.group().startswith("-"):
                prev = None
                for t in reversed(tokens):
                    if t.kind != "COMMENT":
                        prev = t
                        break
                unary_pos = prev is None or prev.kind in (
                    "OP", "ASSIGN", "COMMA", "LPAR", "COLON", "NEWLINE")
                if not unary_pos:
                    m = None
        if m:
            tokens.append(Token("NUMBER", m.group(), i))
            i = m.end()
            continue
        two = source[i:i + 2]
        if two in _OP2:
            tokens.append(Token("ASSIGN" if two == ":=" else "OP", two, i))
            i += 2
            continue
        if c in _OP1:
            if c == ":":
                tokens.append(Token("COLON", ":", i))
            elif c == "(":
                tokens.append(Token("LPAR", "(", i))
            elif c == ")":
                tokens.append(Token("RPAR", ")", i))
            elif c == ",":
                tokens.append(Token("COMMA", ",", i))
            else:
                tokens.append(Token("OP", c, i))
            i += 1
            continue
        m = _NAME_RE.match(source, i)
        if m:
            tokens.append(Token("IDENT", m.group(), i))
            i = m.end()
            continue
        if c == "'":
            j = source.find("'", i + 1)
            j = n if j < 0 else j
            tokens.append(Token("STRING", source[i + 1:j], i))
            i = j + 1
            continue
        raise SyntaxError(f"无法识别的字符 '{c}' 在位置 {i}")
    tokens.append(Token("NEWLINE", "\n", n))
    return tokens


# ---------- AST ----------

class Node:
    pass

@dataclass
class Number(Node):
    value: float

@dataclass
class String(Node):
    value: str

@dataclass
class Ident(Node):
    name: str

@dataclass
class Call(Node):
    func: str
    args: List[Node]

@dataclass
class BinOp(Node):
    op: str
    left: Node
    right: Node

@dataclass
class UnaryOp(Node):
    op: str
    operand: Node

@dataclass
class AndOp(Node):
    left: Node
    right: Node

@dataclass
class OrOp(Node):
    left: Node
    right: Node

@dataclass
class NotOp(Node):
    operand: Node

@dataclass
class Assign(Node):
    name: str
    expr: Node
    output: bool              # True 表示 ':' 输出线
    draw: List[str] = field(default_factory=list)

@dataclass
class ExprStmt(Node):
    expr: Node


# ---------- 语法分析 ----------

class Parser:
    def __init__(self, tokens: List[Token]):
        self.toks = tokens
        self.pos = 0

    def peek(self) -> Token:
        if self.pos >= len(self.toks):
            return Token("NEWLINE", "\n", self.pos)
        while self.toks[self.pos].kind == "COMMENT":
            self.pos += 1
            if self.pos >= len(self.toks):
                return Token("NEWLINE", "\n", self.pos)
        return self.toks[self.pos]

    def next(self) -> Token:
        t = self.peek()
        self.pos += 1
        return t

    def at_end(self) -> bool:
        while self.toks[self.pos].kind == "COMMENT":
            self.pos += 1
        return self.toks[self.pos].kind == "NEWLINE" and self.pos >= len(self.toks) - 1

    def parse_program(self) -> List[Node]:
        stmts: List[Node] = []
        while True:
            # 跳过空行/注释
            while self.peek().kind == "NEWLINE" and self.pos < len(self.toks):
                self.next()
            if self.pos >= len(self.toks):
                break
            s = self.parse_statement()
            if s is not None:
                stmts.append(s)
            # 语句结束: 跳过分隔符直到下一个语句或文件尾
            while self.peek().kind in ("NEWLINE", "COMMENT") and self.pos < len(self.toks):
                self.next()
            if self.pos >= len(self.toks):
                break
        return stmts

    def parse_statement(self) -> Optional[Node]:
        # 尝试解析赋值: name (:=|:) expr [, 绘制指令...]
        save = self.pos
        t = self.peek()
        if t.kind == "IDENT":
            # 需要向前看是否为 := 或 :(后面是表达式开始)
            nxt = self.toks[self.pos + 1] if self.pos + 1 < len(self.toks) else None
            while nxt is not None and nxt.kind == "COMMENT":
                self.pos += 1
                nxt = self.toks[self.pos + 1] if self.pos + 1 < len(self.toks) else None
            if nxt is not None and nxt.kind in ("ASSIGN", "COLON"):
                name = self.next().value
                output = self.next().kind == "COLON"
                expr = self.parse_expr()
                draw: List[str] = []
                # 逗号后面的绘制指令
                while self.peek().kind == "COMMA":
                    self.next()
                    d = self.parse_draw()
                    if d:
                        draw.append(d)
                return Assign(name=name, expr=expr, output=output, draw=draw)
            self.pos = save
        # 表达式语句
        expr = self.parse_expr()
        # 吃掉可能多余的绘制指令
        while self.peek().kind == "COMMA":
            self.next()
            self.parse_draw()
        return ExprStmt(expr)

    def parse_draw(self) -> str:
        t = self.peek()
        if t.kind == "IDENT":
            self.next()
            # 可能带括号参数, 如 LINESTICK(MOVE) / DOTLINE(PRECISION)
            if self.peek().kind == "LPAR":
                self.parse_expr()
                if self.peek().kind == "RPAR":
                    self.next()
            return t.value
        if t.kind == "NUMBER":
            # 有些公式直接写数字颜色如 ,99
            self.next()
            return str(t.value)
        return ""

    # 优先级: OR(||) < AND(&&) < 比较 < 加减 < 乘除
    def parse_expr(self):
        return self.parse_or()

    def parse_or(self):
        node = self.parse_and()
        while True:
            t = self.peek()
            if t.kind == "IDENT" and t.value.upper() == "OR":
                self.next()
                node = OrOp(node, self.parse_and())
            elif t.kind == "OP" and t.value == "||":
                self.next()
                node = OrOp(node, self.parse_and())
            else:
                break
        return node

    def parse_and(self):
        node = self.parse_cmp()
        while True:
            t = self.peek()
            if t.kind == "IDENT" and t.value.upper() == "AND":
                self.next()
                node = AndOp(node, self.parse_cmp())
            elif t.kind == "OP" and t.value == "&&":
                self.next()
                node = AndOp(node, self.parse_cmp())
            else:
                break
        return node

    def parse_cmp(self):
        node = self.parse_add()
        while self.peek().kind == "OP" and self.peek().value in (">", "<", ">=", "<=", "=", "<>"):
            op = self.next().value
            node = BinOp(op, node, self.parse_add())
        return node

    def parse_add(self):
        node = self.parse_mul()
        while self.peek().kind == "OP" and self.peek().value in ("+", "-"):
            op = self.next().value
            node = BinOp(op, node, self.parse_mul())
        return node

    def parse_mul(self):
        node = self.parse_unary()
        while self.peek().kind == "OP" and self.peek().value in ("*", "/", "%"):
            op = self.next().value
            node = BinOp(op, node, self.parse_unary())
        return node

    def parse_unary(self):
        t = self.peek()
        if t.kind == "OP" and t.value in ("-", "+"):
            self.next()
            return UnaryOp(t.value, self.parse_unary())
        if t.kind == "IDENT" and t.value.upper() == "NOT":
            self.next()
            return NotOp(self.parse_unary())
        return self.parse_primary()

    def parse_primary(self):
        t = self.next()
        if t.kind == "NUMBER":
            return Number(float(t.value))
        if t.kind == "STRING":
            return String(t.value)
        if t.kind == "IDENT":
            # 函数调用?
            if self.peek().kind == "LPAR":
                self.next()
                args: List[Node] = []
                if self.peek().kind != "RPAR":
                    args.append(self.parse_expr())
                    while self.peek().kind == "COMMA":
                        self.next()
                        if self.peek().kind == "RPAR":
                            break
                        args.append(self.parse_expr())
                if self.peek().kind == "RPAR":
                    self.next()
                else:
                    # 有些公式少写右括号, 宽容处理
                    pass
                return Call(t.value.upper(), args)
            return Ident(t.value.upper())
        if t.kind == "LPAR":
            node = self.parse_expr()
            if self.peek().kind == "RPAR":
                self.next()
            return node
        # 错误/未知
        raise SyntaxError(f"位置 {t.pos} 处有无法解析的语法: {t.value!r}")


def parse(source: str) -> List[Node]:
    toks = tokenize(source)
    return Parser(toks).parse_program()