#!/usr/bin/env bash
# 一键准备运行环境（幂等，可重复执行）。
#
# 做三件事：
#   1) 装 Node 依赖（express + @duckdb/node-api）
#   2) 建 Python 虚拟环境（DuckDB 公式引擎跑 TDX 指标用，只依赖 numpy）
#   3) 建 data/ 下的运行时目录
#
# 不做什么：
#   · 不下载行情库（38GB 的 market.db 是可选的，没有它系统照样跑，
#     板块强度会改用网络日线合成，快照会标 derived）
#   · 不自动跑收盘编排（那会打几百次上游接口，由你自己决定时机）
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

say "检查 Node"
node -v

say "安装 Node 依赖"
npm install --no-audit --no-fund

say "准备 Python 虚拟环境"
if [ ! -x py/.venv/bin/python ]; then
  # --system-site-packages：系统已有 numpy 时直接复用，省一次下载
  python3 -m venv --system-site-packages py/.venv
  echo "  已创建 py/.venv"
else
  echo "  py/.venv 已存在，跳过创建"
fi
py/.venv/bin/python -c "import numpy; print('  numpy', numpy.__version__)" \
  || { echo "  numpy 缺失，尝试安装…"; py/.venv/bin/pip install -q -r py/requirements.txt; }

say "建运行时目录"
mkdir -p data/cache logs data/sectors data/sources data/strategies data/watchpool

say "自检"
py/.venv/bin/python py/tdx_engine/selftest.py | tail -3

cat <<'EOF'

完成。接下来：

  npm start                     # 起服务 → http://localhost:3000
  npm run daily                 # 跑一次收盘编排（生成预判卡/板块强度/快照）
  npm test                      # 26 项冒烟
  npm run test:unit             # 单元 + 集成 + Python 自检
  npm run acceptance            # 63 条全量验收（需服务已启动）

EOF
