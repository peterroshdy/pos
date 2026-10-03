@echo off
cd /d "%~dp0.."
where git.exe >nul 2>nul
if errorlevel 1 (
  echo Git for Windows is not installed or is not in PATH.
  pause
  exit /b 1
)
git pull --ff-only
if errorlevel 1 (
  echo The update could not be downloaded. No local data was removed.
  pause
  exit /b 1
)
call "%~dp0Install Talk & TASTE Native.cmd"
