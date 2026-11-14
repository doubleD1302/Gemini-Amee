# BẮT ĐẦU TẠI ĐÂY — CẨM NANG GEMINI PROJECT STUDIO (v0.2.0)

Chào mừng bạn đến với **Gemini Project Studio**! Đây là công cụ trợ lý mã nguồn thông minh trên máy tính (Desktop App), giúp bạn trò chuyện và tìm hiểu mọi khía cạnh về dự án mã nguồn của mình thông qua tài khoản **Gemini Web** miễn phí — **không cần API key, không tốn phí đăng ký, và an toàn 100% cho dữ liệu của bạn.**

> 💡 **Dành cho người mới:** Bạn có thể nhấp đúp mở file [`HUONG_DAN_NHANH.html`](file:///HUONG_DAN_NHANH.html) ngay trong trình duyệt Chrome hoặc Edge để xem cẩm nang trực quan với sơ đồ hình ảnh và checklist từng bước!

---

## 1. Cam kết an toàn tuyệt đối cho dự án của bạn (100% Read-Only)

Khi bạn mở một thư mục code bằng Gemini Project Studio:
- 🛡️ **Ứng dụng chỉ đọc nội dung (Read-Only):** Tuyệt đối không chỉnh sửa, không xóa và không ghi đè bất kỳ file nào của bạn.
- 🔒 **Tự động lọc bỏ bí mật:** Hệ thống tự động loại bỏ các file nhạy cảm (`.env`, mật khẩu database, SSH key, chứng chỉ...) cũng như các thư mục build nặng (`node_modules`, `.git`, `dist`...).
- 🌐 **Không gửi dữ liệu cho bên thứ ba:** Chỉ gửi nội dung câu hỏi và đoạn code liên quan trực tiếp đến tài khoản Gemini Web của bạn trên Google.

---

## 2. Cách khởi động ứng dụng trên Windows (Chỉ mất 2 phút)

### Bước 1: Cài đặt Node.js (Nếu máy chưa có)
Node.js là nền tảng giúp ứng dụng chạy được trên máy tính của bạn:
1. Truy cập trang chính thức: [https://nodejs.org/](https://nodejs.org/)
2. Bấm nút tải bản **LTS (Recommended for most users)**.
3. Mở file vừa tải về và bấm **Next** theo mặc định cho đến khi hoàn tất.

### Bước 2: Khởi động Studio
1. Giải nén toàn bộ thư mục ứng dụng vào máy tính.
2. Nhấp đúp chuột vào file **`start-windows.bat`**.
3. *Ở lần chạy đầu tiên*, ứng dụng sẽ tự động tải các gói thư viện cần thiết trong khoảng 1–2 phút. Sau đó, cửa sổ Gemini Project Studio sẽ tự động hiện lên!

> ⚠️ **Mẹo sửa lỗi:** Nếu bạn thấy báo lỗi mạng hoặc `ECONNRESET` khi cài đặt lần đầu, hãy đóng cửa sổ lại và nhấp đúp vào file **`repair-windows.bat`** để hệ thống tự động sửa lỗi và tải lại.

---

## 3. Hướng dẫn sử dụng — Bạn có 2 lựa chọn cực kỳ linh hoạt

Sau khi mở Studio, bạn bấm nút **"Chọn thư mục dự án"** (hoặc icon thư mục bên góc trái) để mở dự án bạn muốn tìm hiểu. Tiếp theo, hãy chọn một trong hai cách trò chuyện sau:

### Cách 1: Tự động qua Extension (Hỗ trợ cả Microsoft Edge & Google Chrome)
Extension giúp Studio tự động gửi câu hỏi sang tab Gemini và nhận câu trả lời về màn hình Studio:
1. Trong Studio, mở tab **Bridge** ở bảng bên phải và bấm **"Mở thư mục Extension trên máy"**.
2. **Nếu bạn dùng Microsoft Edge (có sẵn trên mọi máy Windows):**
   - Mở Edge, nhập: `edge://extensions`
   - Bật công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở menu bên trái.
   - Bấm nút **"Tải phần mở rộng chưa giải nén" (Load unpacked)** ở trên đầu rồi chọn thư mục `extension`.
3. **Nếu bạn dùng Google Chrome:**
   - Mở Chrome, nhập: `chrome://extensions`
   - Bật công tắc **"Developer mode"** ở góc trên bên phải.
   - Bấm nút **"Load unpacked"** rồi chọn thư mục `extension`.
4. Quay lại Studio, bấm **"Copy mã kết nối (Pairing JSON)"**.
5. Bấm vào biểu tượng Extension ✦ trên thanh công cụ trình duyệt (Edge hoặc Chrome), chọn **"⚡ Tự động dán"** rồi bấm **"Lưu & Kết nối"**.
6. Mở tab [https://gemini.google.com/app](https://gemini.google.com/app) trên Edge hoặc Chrome, đăng nhập tài khoản Google và giữ tab đó mở.
7. Đèn trạng thái trên Studio chuyển sang màu xanh lá **"Bridge connected"** — bạn đã sẵn sàng trò chuyện!

### Cách 2: Thủ công không cần cài gì (100% không lo lỗi)
Nếu bạn không muốn cài Extension hoặc máy công ty bị chặn quyền cài tiện ích:
1. Nhập câu hỏi bạn muốn hỏi vào ô chat trong Studio rồi bấm **Gửi** (hoặc bấm *Soạn context*).
2. Studio sẽ tự động chắt lọc các file code quan trọng nhất và **tự động sao chép toàn bộ prompt vào bộ nhớ tạm (Clipboard)** của bạn.
3. Bạn chỉ cần mở tab [gemini.google.com](https://gemini.google.com/app) và ấn **Ctrl + V** để dán câu hỏi.
4. Sau khi Gemini trả lời xong, bạn copy câu trả lời đó, quay lại Studio bấm **"Dán câu trả lời thủ công"** (hoặc bấm nút *⚡ Dán nhanh từ bộ nhớ tạm*).
5. Toàn bộ câu trả lời kèm các khối mã code sẽ được hiển thị ngay ngắn với định dạng đẹp mắt!

---

## 4. Những điểm cải tiến nổi bật trong phiên bản v0.2.0

- 📜 **Quản lý Lịch sử trò chuyện thông minh (Chuẩn Antigravity):**
  - Tự động lưu mọi phiên hỏi đáp theo thời gian thực vào bộ nhớ máy, không bao giờ bị mất khi khởi động lại.
  - Ngăn kéo **"Lịch sử trò chuyện"** (phím tắt `Ctrl + H`) phân nhóm khoa học theo mốc thời gian: *Hôm nay, Hôm qua, 7 ngày trước, 30 ngày trước, Cũ hơn*.
  - Nút **"+ Trò chuyện mới"** (phím tắt `Ctrl + N`) cho phép mở chủ đề trao đổi mới mà vẫn bảo toàn các cuộc trò chuyện cũ.
  - Tự động nhận diện và đặt tiêu đề thông minh từ nội dung câu hỏi; cho phép đổi tên trực tiếp bằng biểu tượng bút chì.
  - Tìm kiếm toàn văn (Full-text Search) theo tiêu đề và nội dung tin nhắn trong lịch sử.
  - Bộ lọc linh hoạt: xem các cuộc trò chuyện của riêng **Dự án hiện tại** hoặc **Tất cả dự án**.
  - Xuất cuộc trò chuyện ra file **Markdown (.md)** để lưu trữ làm tài liệu, hoặc xuất/nhập file **JSON backup**.
  - Khối **"Cuộc trò chuyện gần đây"** trên màn hình chính giúp mở lại ngay các chủ đề đang trao đổi dở dang chỉ với 1 cú click.
- 🎨 **Bộ nhận diện thương hiệu chuyên nghiệp & tối giản:** Icon và logo SVG tinh xảo, giao diện tông màu Deep Obsidian thanh lịch, hiện đại theo phong cách tối giản cao cấp.
- 💻 **Trình xem Code & Markdown chuyên nghiệp:** Câu trả lời từ Gemini được phân tách tiêu đề, danh sách và các khối code (JavaScript, Python, HTML, CSS...) có nút **"Sao chép mã"** riêng biệt và hiệu ứng trực quan.
- 🧭 **Hướng dẫn Onboarding tích hợp sẵn:** Nút **"Hướng dẫn người mới"** luôn hiển thị trên thanh tiêu đề để bạn mở lại cẩm nang bất cứ khi nào cần.
- ⚡ **Tiện ích sao chép thông minh:** Hỗ trợ đọc Clipboard tự động cả trên Desktop và Chrome Extension giúp giảm tối đa thao tác cho người dùng không rành công nghệ.
- 📂 **Bộ lọc file thông minh (File Filter Tabs):** Cho phép lọc nhanh giữa Code, Tài liệu (Markdown) và Cấu hình (JSON/YAML).
- 📖 **Trang cẩm nang ngoại tuyến `HUONG_DAN_NHANH.html`:** Mở được ngay bằng bất kỳ trình duyệt nào mà không cần cài đặt thêm phần mềm.

---

## 5. Mẫu câu hỏi thông minh cho người không chuyên (Nontech Prompts)

Dưới đây là những câu hỏi mẫu bạn có thể hỏi Gemini về dự án của mình:

| Mục tiêu | Câu hỏi mẫu |
| :--- | :--- |
| **Tìm hiểu chức năng** | *"Hãy giải thích tổng quan dự án này làm gì, giải quyết bài toán nào và dành cho đối tượng nào bằng ngôn ngữ dễ hiểu nhất."* |
| **Cách chạy app** | *"Hãy hướng dẫn tôi cách cài đặt và chạy thử dự án này trên máy tính Windows từng bước một từ A đến Z."* |
| **Khám phá cấu trúc** | *"Tôi không biết lập trình, hãy cho tôi biết cấu trúc thư mục này gồm những phần quan trọng nào và luồng dữ liệu chạy ra sao?"* |
| **Tìm lỗi & Review** | *"Phân tích các rủi ro, lỗi tiềm ẩn, vấn đề bảo mật và các điểm chưa tối ưu trong project này. Đưa ra giải pháp khắc phục cụ thể."* |
| **Tạo tài liệu** | *"Viết cho tôi một bản hướng dẫn sử dụng chi tiết (User Manual) cho người dùng cuối về toàn bộ các tính năng của dự án này."* |

---

## 6. Xử lý các sự cố thường gặp (Troubleshooting)

- **Lỗi: Không tìm thấy Node.js khi chạy `start-windows.bat`:**
  - *Giải pháp:* Tải và cài đặt Node.js 22 LTS từ [nodejs.org](https://nodejs.org/). Cài xong hãy tắt Command Prompt và mở lại.
- **Lỗi: Tải bị ngắt quãng `ECONNRESET` hoặc tải lâu:**
  - *Giải pháp:* Đóng mọi cửa sổ và nhấp đúp chạy file **`repair-windows.bat`**. Chọn nguồn số 1 hoặc số 2 để tải lại.
- **Extension báo "Chưa kết nối" (Offline):**
  - *Giải pháp:* Kiểm tra xem ứng dụng Desktop Studio có đang mở hay không. Bấm lại nút "Copy mã kết nối (Pairing JSON)" trong tab Bridge của Studio rồi dán lại vào Extension.
- **Lỗi: "Không thấy nút Send trên Gemini Web":**
  - *Nguyên nhân:* Giao diện Gemini Web dùng ngôn ngữ Tiếng Việt (`aria-label="Gửi tin nhắn"`), hoặc ngữ cảnh quá lớn khiến nút gửi cần thêm thời gian xử lý.
  - *Giải pháp:*
    1. Bản cập nhật mới đã hỗ trợ tự động nhận diện Tiếng Việt, bộ icon động và phím Enter dự phòng.
    2. Hãy vào `chrome://extensions` (hoặc `edge://extensions`), tìm tiện ích **Gemini Project Studio Bridge** và bấm vào **biểu tượng vòng xoay (Reload / Tải lại)** để áp dụng ngay.
    3. Bạn cũng có thể bấm ngay nút **"1. Copy lại prompt"** xuất hiện ngay trên thông báo lỗi trong Studio để dán thủ công sang Gemini Web nếu cần gấp.

---

*Gemini Project Studio — Đồng hành cùng bạn khám phá và làm chủ mọi dự án mã nguồn.*
