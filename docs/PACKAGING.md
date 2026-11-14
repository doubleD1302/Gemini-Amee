# Đóng gói, ký và phát hành

## Build
```bash
npm test && npx tsc --noEmit
npm run package:win        # vite build + electron-builder --win → release/
```
Kết quả trong `release/` (đã nằm trong `.gitignore`):
- `Gemini Project Studio Setup <version>.exe` — bộ cài NSIS (tên lấy từ `package.json`; `cap-nhat-extension.bat` cũng đọc phiên bản từ đó).
- `Gemini Project Studio <version> Portable.exe` — bản chạy thẳng.
- `release/win-unpacked/` — dùng để kiểm tra nhanh nội dung đóng gói.

Quy tắc đóng gói (bất biến an toàn): chỉ `dist/`, `desktop/`, `public/`, `package.json` vào `app.asar`; **không** đóng gói `node_modules` runtime (ứng dụng không có dependency runtime ngoài Electron), không đóng gói `tests/`, `docs/`, file `.env`/khoá. `extension/` và `HUONG_DAN_NHANH.html` được chép vào `resources/` (extraResources) để người dùng nạp vào Chrome/Edge.

`build.publish` đặt `null` có chủ đích: `npm run package:win` **không bao giờ tự đăng** bản phát hành lên GitHub.

## Ký mã (code signing) — chưa thực hiện được trong repo này
Bộ cài chưa ký sẽ bị Windows SmartScreen cảnh báo. Để ký bạn cần chứng chỉ ký mã (OV/EV) của chính bạn; **không** commit chứng chỉ hay mật khẩu. electron-builder tự đọc biến môi trường:
```powershell
$env:CSC_LINK = "C:\secure\codesign.pfx"        # đường dẫn hoặc base64 của .pfx
$env:CSC_KEY_PASSWORD = "<mật khẩu>"             # chỉ đặt trong phiên shell / secret của CI
npm run package:win
```
Kiểm tra sau khi ký: `Get-AuthenticodeSignature "release\Gemini Project Studio Setup <version>.exe"` phải có `Status = Valid`.

## Cập nhật ứng dụng
- Studio **không tự cập nhật**. Trong Bridge → Cài đặt có nút "Kiểm tra bản cập nhật" (chỉ chạy khi bạn bấm) hỏi GitHub Releases của `doubleD1302/Gemini-Amee`, nếu có bản mới thì mở trang phát hành để bạn tự tải. Không tải hay chạy file nào một cách tự động.
- Tự cập nhật có chữ ký (electron-updater) cần: bản phát hành đã ký, kênh phát hành tin cậy và thêm một dependency runtime. Chỉ nên bật sau khi đã có chứng chỉ ký mã; khi đó thêm `publish` GitHub vào `build` và xác minh chữ ký trước khi cài.
- Extension (thư mục `extension/`) cập nhật bằng cách chép lại thư mục (hoặc chạy `cap-nhat-extension.bat`) rồi bấm Reload ở `chrome://extensions`. Tab Bridge cho biết extension có khớp phiên bản/giao thức với Studio hay không.

## Danh sách kiểm tra phát hành
1. `npm test` xanh, `npx tsc --noEmit` exit 0, `npx vite build` OK.
2. Tăng `version` trong `package.json` **và** `VERSION` trong `desktop/bridge.cjs` (có test bắt lệch); nếu đổi hợp đồng Studio ↔ extension thì tăng `PROTOCOL` (bridge) và `GPS_PROTOCOL` (extension/background.js) cùng lúc, và tăng `version` trong `extension/manifest.json`.
3. `npm run package:win`; mở `release/win-unpacked/Gemini Project Studio.exe` kiểm tra thủ công (giao diện Electron thật chưa được chạy trong CI).
4. Ký (nếu có chứng chỉ), tạo release trên GitHub, đính kèm bộ cài, ghi chú thay đổi.
