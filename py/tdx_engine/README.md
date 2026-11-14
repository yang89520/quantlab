# tdx_engine · 三期 Python 公式引擎

本目录文件由本项目**独立维护**，采用「复制不是引用」，不再与上游同步。

## 上游来源

- 源目录：外部参考项目 `tdx-backtest/tdxback/`（只读参考，未修改任何文件；路径由本机环境决定，不写入版本库）
- 上游 commit：`95408fe`
- 复制日期：2026-11-14

## 复制清单（5 个文件）

| 源文件 | 目标 | 上游依赖 | 本项目处理 |
|---|---|---|---|
| `parser.py` | `parser.py` | 无 | 原样复制 |
| `functions.py` | `functions.py` | numpy + `parser` | 扩充 12 个常规函数；未来函数族改为「可检测/拒绝」；未定义标识符改为抛错并提示相近名；`_bind_dates` 兼容字符串日期 |
| `signals.py` | `signals.py` | numpy | 原样复制 |
| `future_scan.py` | `future_scan.py` | `parser` | 补齐 `XMA`/`REFX` 高危项；重排高危集合，使 `has_critical` 只针对真未来函数 |
| `backtest.py` | `backtest.py` | numpy + pandas | **剥离 pandas**：接口由 `pd.DataFrame` 改为接收外部传入的 `ohlcv` dict，用 numpy + 标准库 `datetime` 替代 |

## 本项目新增文件

| 文件 | 说明 |
|---|---|
| `__init__.py` | 包初始化 |
| `requirements.txt`（位于 `py/`） | 仅 `numpy>=2.0`（不装 pandas / 网络库） |
| `runner.py` | stdin 单行 JSON → stdout 单行 JSON 协议（task: run/lines/scan/funcs） |
| `selftest.py` | 公式引擎自检（§9.1 用例） |

## 设计约束

- **复制不是引用**：5 个文件头均标注来源、commit、复制日期。
- **不造数据**：`runner.py` 只处理调用方传入的 `ohlcv`，不联网、不读数据库、不生成 K 线。
- **不静默失败**：未定义标识符 / 不支持函数 / 未来函数 / 数据异常均抛出结构化错误。
- **未来函数**：`XMA/ZIG/ZIGA/PEAK/TROUGH/PEAKBARS/TROUGHBARS/REFX` 实现目的仅为「可检测」，`scan` 报高危、`run` 拒绝执行，不用于信号。

## 运行

```bash
py/.venv/bin/python py/tdx_engine/selftest.py
printf '%s\n' '{"task":"funcs"}' | py/.venv/bin/python py/tdx_engine/runner.py
```
