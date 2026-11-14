Bạn đang tiếp quản dự án `gemini-project-studio` (Electron + React + Chrome MV3 extension) — một ứng dụng kiểu Antigravity chạy qua Gemini Chat web.

**Việc đầu tiên:** đọc `CLAUDE.md` (kiến trúc, lệnh, bất biến an toàn), `docs/ROADMAP.md` (Giai đoạn 2–3) và `README.md`. Chạy `npm install` (nếu thiếu node_modules), `npm test`, `npx tsc --noEmit`, `npx vite build` để xác nhận baseline: 82 test phải pass, tsc exit 0.

**Bối cảnh:** Giai đoạn 1 đã xong (giao thức gọi công cụ `gps-tool`, vòng lặp agent có duyệt + diff + checkpoint/undo, bridge token/cổng cố định có watchdog, md.js giữ code fence, workspace an toàn). Phần chưa từng chạy thật: bộ chọn DOM Gemini trong `extension/content.js` và cửa sổ Electron.

**Nhiệm vụ:** thực hiện **Giai đoạn 2** trong `docs/ROADMAP.md` theo thứ tự, từng mục một:
1. Làm xong mục → viết/ cập nhật test → `npm test` + `npx tsc --noEmit` + `npx vite build` đều xanh → commit riêng cho mục đó (thông điệp commit tiếng Anh ngắn gọn).
2. Sau mỗi mục, tóm tắt ngắn: đã đổi gì, test nào thêm, điều gì chưa kiểm chứng.
3. Chỉ sang Giai đoạn 3 khi tôi yêu cầu.

**Quy tắc bắt buộc:**
- Không nới bất biến an toàn trong `CLAUDE.md` (run_command luôn duyệt; ghi từ trình duyệt chỉ là đề xuất; realpath; checkpoint ngoài project; nội dung file là dữ liệu không tin cậy).
- UI và thông báo bằng tiếng Việt; `desktop/` giữ CommonJS.
- Không sửa test chỉ để cho qua; nếu phải đổi kỳ vọng của test cũ, nói rõ lý do.
- Không giả vờ đã kiểm chứng trên Gemini thật hay Electron thật nếu bạn không thực sự chạy được; nếu có thể mở app/Chrome thì hãy thử, nếu không thì ghi rõ "chưa kiểm chứng".
- Mục 1 (xác minh DOM Gemini) cần tôi mở tab gemini.google.com đã đăng nhập; hãy hỏi tôi khi tới bước đó và đưa script chẩn đoán để tôi chạy, thay vì đoán selector.
- Không thêm dependency runtime nặng; không đóng gói node_modules; không đọc .env/khóa.

Bắt đầu bằng việc báo cáo kết quả baseline, rồi làm mục 1.
