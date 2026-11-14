@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ┌──────────────────────────────────────────────────────────────┐
echo │          GEMINI PROJECT STUDIO - CÔNG CỤ SỬA LỖI             │
echo └──────────────────────────────────────────────────────────────┘
echo.

where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node

echo Công cụ này sẽ dọn dẹp các file tải dở dang và cài đặt lại trơn tru.
echo Hãy chắc chắn bạn đã đóng cửa sổ Gemini Project Studio trước khi tiếp tục.
echo.
choice /C YN /M "Bạn có muốn tiếp tục sửa lỗi tự động? [Y/N]"
if errorlevel 2 exit /b 0

if exist "node_modules" (
  echo [1/3] Đang xóa bộ nhớ tạm node_modules cũ...
  rmdir /s /q "node_modules" 2>nul
  if exist "node_modules" goto locked
)

rem Cấu hình thời gian chờ và thử lại tối đa để tránh rớt mạng
set "npm_config_fetch_retries=5"
set "npm_config_fetch_retry_mintimeout=20000"
set "npm_config_fetch_retry_maxtimeout=120000"
set "npm_config_fetch_timeout=300000"

echo.
echo [2/3] Chọn nguồn tải gói Electron:
echo   1. Nguồn chính thức GitHub (Khuyên dùng)
echo   2. Nguồn Mirror dự phòng (Dùng nếu mạng quốc tế chậm)
choice /C 12 /N /M "Nhập số 1 hoặc 2: "
if errorlevel 2 goto mirror
set "ELECTRON_MIRROR="
goto do_install

:mirror
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
echo [LƯU Ý] Đang dùng nguồn mirror dự phòng.

:do_install
echo.
echo [3/3] Đang tải lại các thư viện cần thiết...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed
if not exist "node_modules\electron\dist\electron.exe" goto failed
if not exist "node_modules\.bin\vite.cmd" goto failed

echo.
echo ==============================================================
echo [THÀNH CÔNG] Đã sửa lỗi và cài đặt hoàn tất!
echo ==============================================================
choice /C YN /M "Bạn có muốn khởi động Gemini Project Studio ngay bây giờ? [Y/N]"
if errorlevel 2 exit /b 0
call npm run dev
if errorlevel 1 goto failed
exit /b 0

:locked
echo.
echo [LỖI] Windows không thể xóa thư mục 'node_modules' vì đang có ứng dụng mở file trong đó.
echo Vui lòng đóng VS Code, Terminal hoặc trình duyệt đang chạy trong thư mục này.
echo Sau đó hãy chạy lại file repair-windows.bat.
pause
exit /b 1

:failed
echo.
echo [LỖI] Quá trình tải vẫn gặp trục trặc do kết nối mạng.
echo Vui lòng kiểm tra lại đường truyền Internet hoặc chuyển sang nguồn mirror số 2.
echo Xem thêm chi tiết trong file WINDOWS_INSTALL_FIX.md hoặc HUONG_DAN_NHANH.html.
pause
exit /b 1

:missing_node
echo [LỖI] Máy tính chưa có Node.js. Hãy tải và cài đặt Node.js từ https://nodejs.org/
pause
exit /b 1
