@echo off
REM Diagnostic run: drives the toolbox from inside the renderer and dumps the
REM result to _selftest.json (see scripts/selftest-renderer.js).
cd /d "%~dp0.."
del /q _selftest.json _st_out.txt _st_err.txt 2>nul
start "" /b "node_modules\electron\dist\electron.exe" . --selftest > _st_out.txt 2> _st_err.txt
ping -n 16 127.0.0.1 > nul
taskkill /IM electron.exe /F > nul 2>&1
echo SELFTEST_DONE >> _st_out.txt
