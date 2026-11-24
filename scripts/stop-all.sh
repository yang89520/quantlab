#!/bin/sh
# 停止 QuantLab 三件套（与 start-all.sh 配对）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"
PORT="${PORT:-8848}"
GPORT="${GPORT:-7710}"

stop_pidfile() { # $1=名字 $2=pid 文件
  [ -f "$2" ] || return 0
  p=$(cat "$2" 2>/dev/null)
  if [ -n "${p:-}" ] && kill -0 "$p" 2>/dev/null; then
    kill "$p" 2>/dev/null; sleep 1
    kill -9 "$p" 2>/dev/null || true
    printf '  已停 %s (pid %s)\n' "$1" "$p"
  fi
  rm -f "$2"
}
stop_port() { # $1=端口
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
    printf '  已清理端口 %s\n' "$1"
  fi
}

printf '== 停止 QuantLab ==\n'
stop_pidfile 隧道 "$RUN/tunnel.pid"; stop_port ""
stop_pidfile 服务 "$RUN/server.pid"; stop_port "$PORT"
stop_pidfile 网关 "$RUN/gateway.pid"; stop_port "$GPORT"

# start-all.sh 用 nohup 起的子进程可能还有 cloudflared 残留
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null && printf '  已清理 cloudflared 残留\n'

printf '完成。公网地址已失效。\n'
