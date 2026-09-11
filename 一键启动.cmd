@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 分镜审核台 v0.1.9

if not exist "runtime\node.exe" (
  echo [失败] 工具包不完整：缺少 runtime\node.exe
  echo 请重新下载并完整解压 Windows 工具包。
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:43127/api/health' -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:43127/"
  exit /b 0
)

echo 正在启动分镜审核台，请保持本窗口打开...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:43127/'"
"runtime\node.exe" "server\server.mjs"

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
