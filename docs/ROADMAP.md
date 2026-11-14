# Lộ trình

## Giai đoạn 1 — Nền tảng agent (XONG, v0.2.0)
Giao thức gps-tool, vòng lặp agent, duyệt + diff, checkpoint/undo, bridge bền vững (token/cổng cố định, watchdog, cancel), md.js giữ code fence, workspace an toàn, lịch sử chat có cắt tỉa quota.

## Giai đoạn 2 — Trải nghiệm & độ tin cậy
Mỗi mục có tiêu chí nghiệm thu; thêm test cho mỗi mục.

1. **[XONG phần selector; còn kiểm thử luồng gửi thật] Xác minh DOM Gemini thật.** Thêm chế độ chẩn đoán trong extension (nút "Kiểm tra bộ chọn" ghi ra HUD: composer, nút gửi, khối trả lời, nút New chat tìm được hay không). Tách toàn bộ selector ra một bảng `SELECTORS` có nhiều ứng viên dự phòng. *Nghiệm thu:* test với DOM giả cho từng ứng viên; HUD báo rõ selector nào thất bại.
2. **[XONG] Tự động chạy test/lint sau khi sửa.** Tool `run_command` giữ nguyên luôn-duyệt; thêm gợi ý "chạy lệnh test của project" (đọc `package.json` scripts) vào kickoff. *Nghiệm thu:* test e2e agent sửa file → chạy lệnh (giả) → thấy kết quả.
3. **[XONG] Quản lý ngữ cảnh dài.** Khi hội thoại Gemini dài, tóm tắt lịch sử bước (recap) và chuyển sang chat mới có chủ đích trước khi chạm giới hạn; hiển thị ước lượng ký tự/token đã dùng trong tab Agent. *Nghiệm thu:* test recap giữ nguyên mục tiêu + file đã sửa + việc còn lại.
4. **[XONG] Phiên Agent lưu bền.** Lưu timeline/checkpoint theo project qua các lần mở app; nút "Tiếp tục phiên trước". *Nghiệm thu:* khởi động lại runner khôi phục state, các approval đang chờ bị đánh dấu hết hạn.
5. **[XONG] Diff/preview tốt hơn.** Diff cạnh nhau, mở file ở editor tại dòng thay đổi, xem trước trước khi duyệt nhiều edit cùng file.
6. **[XONG] Kế hoạch (Plan) hiển thị.** Cho model xuất danh sách việc (tool `plan`) hiển thị dạng checklist trong tab Agent; không tự thực thi gì thêm.
7. **[XONG phần Studio/bridge/UI; upload DOM Gemini CHƯA kiểm chứng] Đính kèm ảnh/tệp** (ảnh chụp lỗi) qua extension — chỉ nếu DOM upload của Gemini ổn định; nếu không, ghi rõ giới hạn.
8. **[XONG]** Dọn: cập nhật `cap-nhat-extension.bat`/`update-installed.ps1` (tên installer 0.2.0), thêm kiểm tra phiên bản extension ↔ app trong tab Bridge.

## Giai đoạn 3 — Gần Antigravity hơn
1. **[XONG phần Studio/bridge; tự chuyển cuộc trò chuyện trong extension CHƯA kiểm chứng] Nhiều agent/phiên song song** (mỗi phiên một chat Gemini, hàng đợi bridge theo `sessionId`).
2. **[XONG phần Studio; hiển thị cửa sổ Electron + upload ảnh lên Gemini CHƯA kiểm chứng] Trình duyệt nội bộ / xem trước web** cho dự án web (mở dev server, chụp màn hình gửi lại — tùy chọn, luôn hỏi quyền).
3. **[XONG] Quy tắc & kỹ năng theo project** (`.gps/rules.md`, `.gps/skills/*.md`) được nạp vào system prompt; có UI sửa.
4. **[XONG] Git tích hợp**: xem status/diff, tạo commit theo đề xuất (commit luôn cần duyệt; không push tự động).
5. **[XONG] Chỉ mục tìm kiếm ngữ nghĩa nhẹ** (BM25/ký hiệu đoạn mã) để chọn ngữ cảnh tốt hơn mà không cần embedding ngoài.
6. **[XONG] Terminal tương tác có duyệt** (tiến trình chạy lâu, xem log trực tiếp, dừng được).
7. Đóng gói/ký ứng dụng, tự cập nhật, trang cài đặt (cổng, giới hạn file/ký tự, thư mục checkpoint).

## Không làm
- Không gọi Gemini API/lấy cookie Google, không nới các bất biến an toàn trong CLAUDE.md.
