#!/bin/sh
# 安装/卸载收盘任务的定时调度（docs/dev/01 §5「调度」）。
#
# 默认用 launchd（LaunchAgent）：macOS 上比 cron 可靠 —— 睡眠期间错过的任务
# 会在唤醒后补跑，且不依赖 Full Disk Access（crontab 在启用了 TCC 的机器上
# 反而会报 "operation not permitted"）。
#
# 用法：
#   sh tools/install-schedule.sh            # 安装（工作日 16:35）
#   sh tools/install-schedule.sh --uninstall
#   sh tools/install-schedule.sh --print    # 只打印等价 cron 行，不动系统
#   sh tools/install-schedule.sh --hour 17  # 改时间
#
# 只做一件事：到点跑 tools/daily-close.js。脚本本身幂等（upsert），
# 补跑不会产生重复数据，所以「多跑一次」永远比「漏跑一天」安全。
set -e

LABEL="cn.quantlab.daily-close"
HOUR=16
MIN=35
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall"; shift ;;
    --print) MODE="print"; shift ;;
    --hour) HOUR="$2"; shift 2 ;;
    --minute) MIN="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# 项目根目录 = 本脚本所在目录的上一级
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node ≥18" >&2
  exit 1
fi
# cron/launchd 的 PATH 很短，用能做符号链接的稳定路径，避免指向会被升级删掉的版本目录
if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/logs/daily.log"

if [ "$MODE" = "print" ]; then
  echo "# 等价的 cron 行（若你更想用 cron，把下面这行加进 crontab -e）"
  echo "$MIN $HOUR * * 1-5  cd $ROOT && $NODE tools/daily-close.js >> logs/daily.log 2>&1"
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$ROOT" &amp;&amp; "$NODE" tools/daily-close.js >> "$LOG" 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd-daily.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd-daily.err.log</string>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTEOF

# 先卸再装：重复执行不会产生两份
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true

# 必须回读确认，不能靠命令退出码 —— 实测在受限环境里 launchctl 会打印
# "Load failed: 5: Input/output error" 但退出码仍是 0，脚本会误报安装成功。
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  echo "已安装（launchd）→ 工作日 $HOUR:$(printf '%02d' "$MIN") 跑 daily-close"
  echo "  项目  $ROOT"
  echo "  节点  $NODE"
  echo "  日志  $LOG"
  echo "  查看  launchctl print gui/$(id -u)/$LABEL | head -30"
  exit 0
fi

echo "⚠ 调度未注册成功：launchctl 拒绝了本次注册（受限环境 / 缺少权限）。" >&2
echo "  plist 已写到：$PLIST" >&2
echo "  解决办法（任选其一）：" >&2
echo "    1) 在「终端」里执行一次：launchctl bootstrap gui/$(id -u) \"$PLIST\"" >&2
echo "    2) 改用手动 crontab：$0 --print 会打印可直接粘贴的行" >&2
echo "    3) 什么都不做 —— 服务端有收盘看门狗兜底（config.schedule.catchUp），" >&2
echo "       只要服务在跑，16:35 之后发现当天没有预判卡会自动补跑一次。" >&2
exit 1
