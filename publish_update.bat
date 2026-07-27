@echo off
setlocal
cd /d "%~dp0"

set "message=%~1"
if not "%message%"=="" goto stage

set /p "message=Commit message (blank uses Update H30269 advisor): "
if not "%message%"=="" goto stage
set "message=Update H30269 advisor"

:stage
git add -A
git diff --cached --quiet
if errorlevel 1 goto commit

echo No changes to upload.
pause
exit /b 0

:commit
git commit -m "%message%"
if errorlevel 1 goto failed

git push
if errorlevel 1 goto failed

echo Upload complete.
pause
exit /b 0

:failed
echo Upload did not complete. Review the message above.
pause
exit /b 1
