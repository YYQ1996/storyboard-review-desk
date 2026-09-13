#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
URL="http://127.0.0.1:43127/"

case "$(uname -m)" in
  arm64) NODE="$SCRIPT_DIR/runtime/darwin-arm64/bin/node" ;;
  x86_64) NODE="$SCRIPT_DIR/runtime/darwin-x64/bin/node" ;;
  *)
    echo "[失败] 暂不支持这台 Mac 的处理器：$(uname -m)"
    read -r -n 1 -s -p "按任意键关闭窗口。"
    echo
    exit 1
    ;;
esac

if [ ! -x "$NODE" ]; then
  echo "[失败] 工具包不完整，缺少 Mac 运行环境。"
  echo "请重新下载并完整解压 macOS 工具包。"
  read -r -n 1 -s -p "按任意键关闭窗口。"
  echo
  exit 1
fi

HEALTH="$(curl -fsS --max-time 2 "${URL}api/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  if printf '%s' "$HEALTH" | grep -q '"version":"0.1.12"'; then
    echo "分镜审核台 v0.1.12 已经在运行，正在打开页面。"
    open "$URL"
    sleep 2
    exit 0
  fi
  echo "[失败] 端口 43127 正在运行其他版本的分镜审核台。"
  echo "请先关闭旧版的 Terminal 启动窗口，再重新双击本文件。"
  if [ "${STORYBOARD_START_NONINTERACTIVE:-}" = "1" ]; then
    exit 2
  fi
  read -r -n 1 -s -p "按任意键关闭窗口。"
  echo
  exit 2
fi

echo "正在启动分镜审核台，请保持本窗口打开……"
(sleep 2; open "$URL") &
"$NODE" "$SCRIPT_DIR/server/server.mjs"
SERVER_EXIT=$?

echo
echo "分镜审核台已停止。"
if [ "${STORYBOARD_START_NONINTERACTIVE:-}" = "1" ]; then
  exit "$SERVER_EXIT"
fi
read -r -n 1 -s -p "按任意键关闭窗口。"
echo
exit "$SERVER_EXIT"
