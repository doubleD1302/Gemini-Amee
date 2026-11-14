@echo off
setlocal
cd /d "%~dp0"
echo ==============================================================
echo   DANG KHOI DONG GEMINI PROJECT STUDIO (BAN VIBE CODING)...
echo ==============================================================

taskkill /F /IM "Gemini Project Studio.exe" >nul 2>&1
timeout /t 1 /nobreak >nul

if exist "%~dp0release\win-unpacked\Gemini Project Studio.exe" (
    start "" "%~dp0release\win-unpacked\Gemini Project Studio.exe"
) else (
    echo Khong tim thay ban release\win-unpacked. Dang khoi dong qua npm start...
    npm start
)
