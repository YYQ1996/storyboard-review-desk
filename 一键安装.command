#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

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

"$NODE" "$SCRIPT_DIR/scripts/install.mjs"
INSTALL_EXIT=$?

echo
if [ "$INSTALL_EXIT" -eq 0 ]; then
  echo "安装完成。请完整退出并重新打开 ChatGPT/Codex App，然后双击“一键启动.command”。"
else
  echo "安装未完成，请查看上方提示和同目录的 install-log.txt。"
fi

if [ "${STORYBOARD_INSTALL_NONINTERACTIVE:-}" = "1" ]; then
  exit "$INSTALL_EXIT"
fi
read -r -n 1 -s -p "按任意键关闭窗口。"
echo
exit "$INSTALL_EXIT"
