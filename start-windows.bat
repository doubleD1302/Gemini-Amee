@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ┌──────────────────────────────────────────────────────────────┐
echo │              GEMINI PROJECT STUDIO - KHỞI ĐỘNG               │
echo └──────────────────────────────────────────────────────────────┘
echo.

where node >nul 2>nul
if errorlevel 1 goto missing_node

where npm >nul 2>nul
if errorlevel 1 goto missing_node

rem Kiểm tra xem Electron và Vite đã được cài đặt đầy đủ chưa
if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "node_modules\.bin\vite.cmd" goto install
goto start

:install
echo [THÔNG BÁO] Đang chuẩn bị môi trường cho lần đầu tiên...
echo Quá trình này chỉ diễn ra một lần (khoảng 1 - 2 phút tùy mạng).
echo Xin vui lòng không tắt cửa sổ này.
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto install_failed
if not exist "node_modules\electron\dist\electron.exe" goto install_failed
if not exist "node_modules\.bin\vite.cmd" goto install_failed

:start
echo [THÀNH CÔNG] Đang khởi động Gemini Project Studio...
echo.
call npm run dev
if errorlevel 1 (
  echo.
  echo [LỖI] Ứng dụng đã dừng với mã lỗi.
  echo Nếu gặp lỗi kết nối hoặc file bị khóa, hãy nhấp đúp repair-windows.bat
  pause
  exit /b 1
)
exit /b 0

:missing_node
echo ==============================================================
echo [LỖI] Máy tính của bạn chưa cài đặt Node.js!
echo ==============================================================
echo Để chạy ứng dụng này, bạn cần cài đặt Node.js (phiên bản 22 LTS trở lên).
echo Quá trình cài đặt cực kỳ đơn giản và an toàn (chỉ mất khoảng 1 phút).
echo.
choice /C YN /M "Bạn có muốn mở trang tải Node.js chính thức ngay bây giờ? [Y/N]"
if errorlevel 2 goto exit_missing
start https://nodejs.org/en/download
echo.
echo Sau khi cài đặt Node.js xong, hãy nhấp đúp lại file start-windows.bat này!
pause
exit /b 1

:exit_missing
echo Vui lòng tải và cài đặt Node.js tại: https://nodejs.org/
pause
exit /b 1

:install_failed
echo.
echo ==============================================================
echo [LỖI] Quá trình tải thư viện chưa hoàn tất (thường do mạng chập chờn).
echo ==============================================================
echo [GIẢI PHÁP]:
echo 1. Hãy đóng cửa sổ này.
echo 2. Nhấp đúp vào file 'repair-windows.bat' trong thư mục này để sửa tự động.
echo 3. Bạn cũng có thể mở file 'HUONG_DAN_NHANH.html' để xem hướng dẫn chi tiết.
echo.
pause
exit /b 1
