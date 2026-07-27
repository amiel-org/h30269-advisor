@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist webapp.pid (
  echo 服务未运行或PID文件不存在。
  pause
  exit /b 1
)
set /p PID=<webapp.pid
powershell -NoProfile -Command "Stop-Process -Id %PID% -ErrorAction SilentlyContinue"
del /q webapp.pid 2>nul
echo 服务已停止。
pause
