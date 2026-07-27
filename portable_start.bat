@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "H30269-Advisor.exe" --open
exit /b 0
