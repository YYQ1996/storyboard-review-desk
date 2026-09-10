@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动分镜审核台...
echo 浏览器地址：http://127.0.0.1:43127
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:43127/'"
node server\server.mjs
pause
