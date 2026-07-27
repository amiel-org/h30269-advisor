@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo 未找到 Python。
  echo 请先安装 Python 3.11 或更高版本，并在安装时勾选 Add Python to PATH。
  echo 安装后重新双击本文件。
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo 正在创建独立运行环境...
  python -m venv .venv
  if errorlevel 1 goto :failed
)

echo 正在检查并安装依赖...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :failed

echo 正在启动红利低波决策台...
start "" ".venv\Scripts\pythonw.exe" webapp.py --open
exit /b 0

:failed
echo.
echo 安装或启动失败，请检查网络、Python 版本和上方错误信息。
pause
exit /b 1
