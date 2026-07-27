@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo 未找到 Python，无法构建免 Python 运行包。
  pause
  exit /b 1
)

echo 正在安装打包工具...
python -m pip install --disable-pip-version-check pyinstaller
if errorlevel 1 goto :failed

if exist "build\H30269-Advisor" rmdir /s /q "build\H30269-Advisor"
if exist "dist\H30269-Advisor" rmdir /s /q "dist\H30269-Advisor"

echo 正在构建免 Python 运行目录...
python -m PyInstaller --noconfirm --clean --onedir --windowed --contents-directory . ^
  --name "H30269-Advisor" ^
  --add-data "static;static" ^
  --add-data "config.json;." ^
  --add-data "cache;cache" ^
  --add-data "latest.json;." ^
  --add-data "latest.md;." ^
  webapp.py
if errorlevel 1 goto :failed

copy /y "portable_start.bat" "dist\H30269-Advisor\启动红利低波决策台.bat" >nul
copy /y "stop_webapp.bat" "dist\H30269-Advisor\停止红利低波决策台.bat" >nul
copy /y "PORTABLE_README.md" "dist\H30269-Advisor\使用说明.md" >nul

powershell -NoProfile -Command "Compress-Archive -Path 'dist\H30269-Advisor' -DestinationPath 'dist\H30269-Advisor-portable.zip' -Force"

echo.
echo 构建完成：
echo %CD%\dist\H30269-Advisor
echo %CD%\dist\H30269-Advisor-portable.zip
pause
exit /b 0

:failed
echo.
echo 构建失败，请查看上方错误信息。
pause
exit /b 1
