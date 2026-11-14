@echo off
setlocal
cd /d "%~dp0"
echo ==============================================================
echo   GEMINI PROJECT STUDIO - DONG BO CAP NHAT & VIBE CODING
echo ==============================================================
echo Dang kiem tra quyen Administrator...

net session >nul 2>&1
if %errorLevel% == 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-installed.ps1"
) else (
    echo Yeu cau cap quyen Administrator (UAC)...
    powershell.exe -NoProfile -Command "$s = Join-Path '%~dp0' 'scripts\update-installed.ps1'; Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s) -Verb RunAs"
)
