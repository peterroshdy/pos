@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Support-TalkAndTaste.ps1"
if errorlevel 1 pause
