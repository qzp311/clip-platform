#!/usr/bin/env bash
# Clip API 单机上线控制脚本（不用 Docker / 不用 npm 挂前台）
#
# 推荐流程：
#   1) ./deploy/scripts/clip-api.sh build     # 只构建，不上线
#   2) ./deploy/scripts/clip-api.sh start     # nohup 后台常驻（关 SSH 不死）
#   或先装 systemd 后用 systemctl（开机自启，更稳）：
#   ./deploy/scripts/clip-api.sh install-systemd
#   sudo systemctl enable --now clip-api
#
# 用法: clip-api.sh {build|start|stop|restart|status|logs|start-fg|install-systemd}

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT/deploy/run"
LOG_DIR="$ROOT/deploy/logs"
PID_FILE="$RUN_DIR/clip-api.pid"
LOG_FILE="$LOG_DIR/clip-api.log"
ENTRY="$ROOT/apps/api-server/dist/index.js"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
export NODE_ENV="${NODE_ENV:-production}"
export CLIP_ENV="${CLIP_ENV:-production}"

ensure_dirs() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
}

is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE" || true
  fi
}

cmd_build() {
  echo "[clip-api] repo: $ROOT"
  echo "[clip-api] building workspace packages…"
  cd "$ROOT"
  npm run build -w @clip/sdk
  npm run build -w @clip/agent-core
  npm run build -w @clip/ffmpeg-templates
  npm run build -w @clip/api-server
  npm run build -w @clip/admin-web
  if [[ ! -f "$ENTRY" ]]; then
    echo "[clip-api] ERROR: missing $ENTRY" >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/apps/admin-web/dist" ]]; then
    echo "[clip-api] ERROR: missing apps/admin-web/dist" >&2
    exit 1
  fi
  echo "[clip-api] build ok"
}

cmd_status() {
  local pid
  pid="$(read_pid)"
  if is_pid_alive "$pid"; then
    echo "[clip-api] running pid=$pid"
    echo "[clip-api] log: $LOG_FILE"
    return 0
  fi
  if [[ -n "${pid:-}" ]]; then
    echo "[clip-api] stopped (stale pidfile pid=$pid)"
    return 1
  fi
  echo "[clip-api] stopped"
  return 1
}

cmd_stop() {
  local pid
  pid="$(read_pid)"
  if is_pid_alive "$pid"; then
    echo "[clip-api] stopping pid=$pid …"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! is_pid_alive "$pid"; then
        break
      fi
      sleep 0.5
    done
    if is_pid_alive "$pid"; then
      echo "[clip-api] force kill pid=$pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "[clip-api] stopped"
    return 0
  fi
  rm -f "$PID_FILE"

  # pid 文件丢了、但 8081 仍被旧 node 占用时，按端口补杀
  local port="${PORT:-8081}"
  local port_pids=""
  if command -v fuser >/dev/null 2>&1; then
    port_pids="$(fuser "${port}/tcp" 2>/dev/null | tr -s '[:space:]' ' ' | xargs || true)"
  elif command -v ss >/dev/null 2>&1; then
    port_pids="$(ss -lptn "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u | tr '\n' ' ')"
  fi
  if [[ -n "${port_pids// /}" ]]; then
    echo "[clip-api] pidfile 已空，但端口 ${port} 仍被占用: ${port_pids}"
    for p in $port_pids; do
      echo "[clip-api] killing port holder pid=$p"
      kill "$p" 2>/dev/null || true
    done
    sleep 1
    for p in $port_pids; do
      if is_pid_alive "$p"; then
        kill -9 "$p" 2>/dev/null || true
      fi
    done
    echo "[clip-api] stopped (by port ${port})"
    return 0
  fi

  echo "[clip-api] already stopped"
}

cmd_start() {
  ensure_dirs
  local pid
  pid="$(read_pid)"
  if is_pid_alive "$pid"; then
    echo "[clip-api] already running pid=$pid"
    return 0
  fi
  if [[ ! -f "$ENTRY" ]]; then
    echo "[clip-api] ERROR: 未找到 $ENTRY，请先执行: $0 build" >&2
    exit 1
  fi
  if [[ ! -f "$ROOT/deploy/.env.${CLIP_ENV}" ]]; then
    echo "[clip-api] WARN: deploy/.env.${CLIP_ENV} 不存在，将仅使用进程环境变量"
  fi

  local port="${PORT:-8081}"
  local busy=""
  if command -v ss >/dev/null 2>&1; then
    busy="$(ss -lptn "sport = :${port}" 2>/dev/null | grep -E ":${port}\\b" || true)"
  elif command -v fuser >/dev/null 2>&1; then
    busy="$(fuser "${port}/tcp" 2>/dev/null || true)"
  fi
  if [[ -n "${busy}" ]]; then
    echo "[clip-api] ERROR: 端口 ${port} 已被占用，不能再 start 一份。" >&2
    echo "[clip-api] 请先: $0 stop   或  $0 restart" >&2
    echo "[clip-api] 查占用: ss -lptn 'sport = :${port}'" >&2
    echo "$busy" >&2
    exit 1
  fi

  cd "$ROOT"
  # 直接跑 node，不用 npm：避免关终端 / npm 生命周期把子进程带走
  nohup env NODE_ENV="$NODE_ENV" CLIP_ENV="$CLIP_ENV" "$NODE_BIN" "$ENTRY" \
    >>"$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$PID_FILE"
  sleep 1
  if ! is_pid_alive "$new_pid"; then
    echo "[clip-api] ERROR: 进程启动后立刻退出，请看日志: $LOG_FILE" >&2
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
  # 脱离当前 shell 任务表，进一步避免 SIGHUP
  disown "$new_pid" 2>/dev/null || true
  echo "[clip-api] started pid=$new_pid"
  echo "[clip-api] NODE_ENV=$NODE_ENV CLIP_ENV=$CLIP_ENV"
  echo "[clip-api] log: $LOG_FILE"
}

cmd_start_fg() {
  if [[ ! -f "$ENTRY" ]]; then
    echo "[clip-api] ERROR: 未找到 $ENTRY，请先执行: $0 build" >&2
    exit 1
  fi
  cd "$ROOT"
  echo "[clip-api] foreground NODE_ENV=$NODE_ENV CLIP_ENV=$CLIP_ENV"
  exec env NODE_ENV="$NODE_ENV" CLIP_ENV="$CLIP_ENV" "$NODE_BIN" "$ENTRY"
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_logs() {
  ensure_dirs
  touch "$LOG_FILE"
  local lines="${1:-100}"
  if [[ "${1:-}" == "-f" ]] || [[ "${1:-}" == "--follow" ]]; then
    tail -n 50 -f "$LOG_FILE"
  else
    tail -n "$lines" "$LOG_FILE"
  fi
}

cmd_install_systemd() {
  local unit_src="$ROOT/deploy/systemd/clip-api.service"
  local unit_dst="/etc/systemd/system/clip-api.service"
  local node_abs
  node_abs="$(cd "$ROOT" && command -v node)"
  if [[ ! -x "$node_abs" ]]; then
    echo "[clip-api] ERROR: 找不到 node，请先安装 Node >=20 或设置 PATH" >&2
    exit 1
  fi
  if [[ ! -f "$unit_src" ]]; then
    echo "[clip-api] ERROR: missing $unit_src" >&2
    exit 1
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[clip-api] 需要 root 安装 systemd，请执行："
    echo "  sudo $0 install-systemd"
    echo ""
    echo "或手动："
    echo "  sudo sed -e \"s|__CLIP_ROOT__|$ROOT|g\" -e \"s|/usr/bin/env node|$node_abs|g\" $unit_src | sudo tee $unit_dst"
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl enable --now clip-api"
    exit 1
  fi
  # 若此前用 nohup 起过，先停掉，避免抢端口
  cmd_stop || true
  sed -e "s|__CLIP_ROOT__|$ROOT|g" -e "s|/usr/bin/env node|$node_abs|g" "$unit_src" >"$unit_dst"
  systemctl daemon-reload
  systemctl enable clip-api
  systemctl restart clip-api
  systemctl --no-pager --full status clip-api || true
  echo "[clip-api] systemd 已安装并启动: systemctl status clip-api"
  echo "[clip-api] node=$node_abs"
  echo "[clip-api] 日志: journalctl -u clip-api -f"
}

usage() {
  cat <<EOF
用法: $0 <command>

  build              构建 sdk / agent-core / ffmpeg-templates / api-server / admin-web
  start              nohup 后台启动（关 SSH 不退出）
  stop               停止后台进程
  restart            停止后启动
  status             查看是否在跑
  logs [N|-f]        看最近 N 行日志，或 -f 跟随
  start-fg           前台启动（调试用，关终端会退出）
  install-systemd    安装并启用 systemd 服务（推荐生产）

环境变量:
  NODE_BIN   指定 node 路径（默认 which node）
  CLIP_ENV   默认 production → 加载 deploy/.env.production
  NODE_ENV   默认 production
EOF
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    build) cmd_build "$@" ;;
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    start-fg) cmd_start_fg "$@" ;;
    install-systemd) cmd_install_systemd "$@" ;;
    ""|-h|--help|help) usage ;;
    *)
      echo "[clip-api] unknown command: $cmd" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
