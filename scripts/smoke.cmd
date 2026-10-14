@echo off
REM Smoke test: launch MacroBoard in --smoke mode (it screenshots the UI then
REM quits), and record whether the process was still alive mid-run.
cd /d "%~dp0.."
del /q _smoke_out.txt _smoke_err.txt _smoke_alive.txt _screenshot.png 2>nul
start "" /b "node_modules\electron\dist\electron.exe" . --smoke --enable-logging > _smoke_out.txt 2> _smoke_err.txt
ping -n 5 127.0.0.1 > nul
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | find /I "electron.exe" > _smoke_alive.txt
if errorlevel 1 (echo ELECTRON_NOT_RUNNING >> _smoke_alive.txt) else (echo ELECTRON_RUNNING >> _smoke_alive.txt)
ping -n 16 127.0.0.1 > nul
if exist _screenshot.png (echo SCREENSHOT_OK >> _smoke_alive.txt) else (echo SCREENSHOT_MISSING >> _smoke_alive.txt)
taskkill /IM electron.exe /F > nul 2>&1
echo SMOKE_DONE >> _smoke_alive.txt
