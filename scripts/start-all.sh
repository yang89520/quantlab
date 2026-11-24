#!/bin/sh
# 一键启动 QuantLab 三件套（网关 / 服务 / 公网隧道）
#
# 为什么要有这个脚本：这三个进程原来靠会话托管，会话一结束就被回收，
# 公网地址跟着断。launchd 在本机被沙箱挡住（bootstrap 报 Input/output error），
# 所以改成在你自己的终端里跑——进程归属你的 shell 会话，不受我这边影响。
#
# 用法：
#   sh scripts/start-all.sh        # 启动（已在跑的会跳过）
#   sh scripts/stop-all.sh         # 停止
#   sh scripts/start-all.sh -f     # 强制重启
#
# 注意：这是 Cloudflare 的免账号 quick tunnel，每次重启地址都会变。
# 要固定域名得用命名隧道（需要自己的域名）。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"
LOG="$ROOT/logs"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CF_BIN="${CF_BIN:-$(command -v cloudflared)}"
PORT="${PORT:-8848}"
GPORT="${GPORT:-7710}"
FORCE=0
[ "${1:-}" = "-f" ] && FORCE=1
PASS_FILE="$ROOT/config.local.json"

mkdir -p "$RUN" "$LOG"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

alive() { # $1=pidfile
  [ -f "$1" ] || return 1
  p=$(cat "$1" 2>/dev/null)
  [ -n "${p:-}" ] && kill -0 "$p" 2>/dev/null
}

stop_one() { # $1=name $2=pidfile $3=port
  if alive "$2"; then
    p=$(cat "$2"); kill "$p" 2>/dev/null; sleep 1
    kill -9 "$p" 2>/dev/null || true
    say "  已停 $1 (pid $p)"
  fi
  if [ -n "${3:-}" ] && port_busy "$3"; then
    lsof -nP -iTCP:"$3" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
    sleep 1
    say "  已清理端口 $3 上的残留进程"
  fi
  rm -f "$2"
}

[ -x "$NODE_BIN" ] || command -v node >/dev/null 2>&1 || die "找不到 node"
[ -n "$CF_BIN" ] || die "找不到 cloudflared（brew install cloudflared）"
[ -x "$ROOT/tdx-gateway/bin/tdx-gateway" ] || die "网关二进制不存在，先跑：npm run tdx:build"
[ -f "$ROOT/config.local.json" ] || say "! config.local.json 不存在：公网访问会被拒绝（未配置访问密码）"

PASS=""
if [ -f "$PASS_FILE" ]; then
  PASS=$("$NODE_BIN" -e "try{const j=require('$PASS_FILE');console.log((j.auth&&j.auth.pass)||'')}catch(e){console.log('')}" 2>/dev/null)
fi

if [ "$FORCE" = "1" ]; then
  say "== 强制重启 =="
  stop_one 隧道 "$RUN/tunnel.pid" ""
  stop_one 服务 "$RUN/server.pid" "$PORT"
  stop_one 网关 "$RUN/gateway.pid" "$GPORT"
fi

# ---- 1. 通达信网关 ----
if port_busy "$GPORT"; then
  say "✓ 网关已在 :$GPORT"
else
  cd "$ROOT/tdx-gateway" || die "目录不存在"
  nohup ./bin/tdx-gateway -port "$GPORT" >> "$LOG/gateway.out" 2>&1 &
  echo $! > "$RUN/gateway.pid"
  cd "$ROOT"
  for i in $(seq 1 20); do port_busy "$GPORT" && break; sleep 0.5; done
  port_busy "$GPORT" && say "✓ 网关已启动 :$GPORT (pid $(cat "$RUN/gateway.pid"))" || say "! 网关可能未起来，看 $LOG/gateway.out"
fi

# ---- 2. Web 服务 ----
if port_busy "$PORT"; then
  say "✓ 服务已在 :$PORT"
else
  cd "$ROOT" || die "目录不存在"
  PORT="$PORT" nohup "$NODE_BIN" server.js >> "$LOG/server.out" 2>&1 &
  echo $! > "$RUN/server.pid"
  for i in $(seq 1 30); do port_busy "$PORT" && break; sleep 0.5; done
  if port_busy "$PORT"; then
    say "✓ 服务已启动 :$PORT (pid $(cat "$RUN/server.pid"))"
  else
    say "! 服务没起来，最近日志："
    tail -15 "$LOG/server.out"
    exit 1
  fi
fi

# ---- 3. 公网隧道 ----
if [ -f "$RUN/tunnel.pid" ] && alive "$RUN/tunnel.pid"; then
  say "✓ 隧道已在运行 (pid $(cat "$RUN/tunnel.pid"))"
  U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG/tunnel.out" 2>/dev/null | tail -1)
else
  say "… 正在申请 Cloudflare quick tunnel（偶尔会被限流，失败就再跑一次）"
  : > "$LOG/tunnel.out"
  nohup "$CF_BIN" tunnel --url "http://localhost:$PORT" --no-autoupdate >> "$LOG/tunnel.out" 2>&1 &
  echo $! > "$RUN/tunnel.pid"
  U=""
  for i in $(seq 1 40); do
    U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG/tunnel.out" 2>/dev/null | head -1)
    [ -n "$U" ] && grep -q "Registered tunnel connection" "$LOG/tunnel.out" && break
    sleep 1
  done
  if [ -n "$U" ]; then say "✓ 隧道已建立"; else say "! 隧道未建立，看 $LOG/tunnel.out"; fi
fi

say ""
say "──────────────────────────────────────────────"
if [ -n "${U:-}" ]; then
  say "  公网地址  $U"
  [ -n "$PASS" ] && say "  账号      quantlab"
  [ -n "$PASS" ] && say "  密码      $PASS"
else
  say "  公网地址  未取到"
fi
say "  本机      http://127.0.0.1:$PORT"
say "──────────────────────────────────────────────"
say "  停止：sh scripts/stop-all.sh"
say "  日志：$LOG/{gateway,server,tunnel}.out"
say "  注意：quick tunnel 每次重启都会换地址；要固定域名需命名隧道。"
