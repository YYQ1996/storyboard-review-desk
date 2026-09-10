@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 分镜审核台 - 一键安装

if not exist "runtime\node.exe" (
  echo [失败] 工具包不完整：缺少 runtime\node.exe
  echo 请重新下载并完整解压 Windows 工具包。
  pause
  exit /b 1
)

"runtime\node.exe" "scripts\install.mjs"
if errorlevel 1 (
  echo.
  echo 安装未完成，请根据上方提示处理后重试。
  pause
  exit /b 1
)

echo.
echo 安装完成。请完整退出并重新打开 Codex，再双击“一键启动.cmd”。
pause
