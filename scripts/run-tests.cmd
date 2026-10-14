@echo off
REM Runs the MacroBoard test suite and writes a compact summary to _tests.txt.
REM Exists because PowerShell's redirect writes UTF-16 and its execution policy
REM blocks npm.ps1 on some machines - this stays plain and portable.
cd /d "%~dp0.."
node --test --test-reporter=spec "test/*.test.js" > _tests.txt 2>&1
echo. >> _tests.txt
echo EXITCODE=%ERRORLEVEL% >> _tests.txt
