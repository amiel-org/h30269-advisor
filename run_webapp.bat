@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" /b pythonw webapp.py --open
exit /b 0
