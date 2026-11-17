@echo off
rem Opens Paper Reader as an app window (see Start-Paper-Reader.ps1); the server starts hidden if needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Paper-Reader.ps1"
if errorlevel 1 pause
