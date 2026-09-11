@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Storyboard Review Desk - Installer

if not exist "runtime\node.exe" (
  echo [ERROR] Missing runtime\node.exe.
  echo Please download the complete Windows package and extract it before installation.
  goto :failed
)

"runtime\node.exe" "scripts\install.mjs"
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo Installation did not complete. See the message above and install-log.txt.
  goto :failed
)

echo.
echo Installation complete. Restart Codex, then run the one-click start script.
if "%STORYBOARD_INSTALL_NONINTERACTIVE%"=="1" exit /b 0
echo Press any key to close this window.
pause >nul
exit /b 0

:failed
echo.
echo The installer will stay open so you can photograph this error.
if "%STORYBOARD_INSTALL_NONINTERACTIVE%"=="1" exit /b 1
echo Press any key to close this window.
pause >nul
exit /b 1
