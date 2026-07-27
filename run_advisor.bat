@echo off
chcp 65001 >nul
cd /d "%~dp0"
python advisor.py
echo.
pause
