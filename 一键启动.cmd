@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 分镜审核台 v0.1.12

if not exist "runtime\node.exe" (
  echo [失败] 工具包不完整：缺少 runtime\node.exe
  echo 请重新下载并完整解压 Windows 工具包。
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/api/health' -TimeoutSec 2; if ($health.version -eq '0.1.12') { exit 0 }; Write-Host ('[失败] 当前运行的是分镜审核台 v' + $health.version + '，不是 v0.1.12。'); exit 2 } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:43127/"
  exit /b 0
)
if "%ERRORLEVEL%"=="2" (
  echo 请先关闭旧版的黑色启动窗口，再重新双击本文件。
  pause
  exit /b 2
)

echo 正在启动分镜审核台，请保持本窗口打开...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:43127/'"
"runtime\node.exe" "server\server.mjs"

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
