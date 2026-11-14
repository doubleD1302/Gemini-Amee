# Gemini Project Studio — hướng dẫn cho Claude Code

Ứng dụng desktop (Electron + React + Chrome MV3 extension) kiểu **Antigravity** chạy qua **Gemini Chat web**. Cảm hứng: totec448-spec/chat-on-steroids (ChatGPT + MCP). Gemini web không có MCP ⇒ dùng **giao thức gọi công cụ bằng văn bản** (khối ```gps-tool).
Giao tiếp và UI bằng **tiếng Việt**. Không có API key Gemini; không lấy cookie Google.

## Kiến trúc
- `desktop/main.cjs` – Electron main, IPC (`studio:*`, `agent:*`), ráp bridge + AgentRunner + CheckpointStore.
- `desktop/bridge.cjs` – HTTP 127.0.0.1:47821 (token lưu bền). Job queue + watchdog (requeue 1 lần → timeout), cancel, completeManually. `/v1/write-file` chỉ tạo **đề xuất**.
- `desktop/agent.cjs` – `AgentRunner`: vòng lặp tối đa 25 lượt, retry định dạng ≤2, duyệt từng bước, policy `{autoEdits}`.
- `desktop/agent-protocol.cjs` – parse/format khối gps-tool, system prompt, kickoff, recap.
- `desktop/project-hints.cjs` – suy ra lệnh test/lint/typecheck/build từ package.json (+Cargo/go/pytest) để GỢI Ý trong system prompt; không chép thân script (dữ liệu không tin cậy).
- `desktop/tools.cjs` – read_file/list_dir/grep/write_file/edit_file/run_command/finish/ask_user (`prepare` không side-effect, `run` thực thi).
- `desktop/workspace.cjs` – truy cập file an toàn (realpath, ghi nguyên tử, .gitignore, chấm điểm ngữ cảnh).
- `desktop/checkpoints.cjs`, `desktop/diff.cjs` – hoàn tác (lưu ngoài project) và unified diff.
- `extension/` – `selectors.js` (bảng SELECTORS + find*/diagnose; nguồn của docs/diagnose-gemini-dom.js, sinh bằng `node scripts/make-diagnostic-snippet.cjs`), `md.js` (DOM→Markdown giữ ``` ), `content.js` (tự động hóa DOM Gemini), `background.js`, `popup.*`.
- `src/` – React UI; `src/components/AgentPanel.tsx` là tab Agent; `src/utils/historyStorage.ts` lưu lịch sử vào localStorage (có cắt tỉa theo quota).

## Lệnh
```
npm test                 # node --test tests/*.test.cjs  (115 test; KHÔNG dùng `node --test tests/`)
npx tsc --noEmit         # strict, phải exit 0
npx vite build
npm run package:win      # build bản Windows (cap-nhat-extension.bat chép từ release/win-unpacked)
```
`tests/main_wiring.test.cjs` chạy main.cjs với Electron giả; cần `--test-timeout` nếu treo.

## Quy ước
- `desktop/` là CommonJS (`.cjs`), không thêm dependency runtime nếu không cần.
- Tính năng mới phải có test; logic agent test bằng Gemini giả (xem `tests/agent.test.cjs`).
- Sửa test cho khớp hành vi mới chỉ khi hành vi cũ là sai có chủ đích; nêu rõ trong báo cáo.
- Mọi chuỗi UI tiếng Việt.

## Bất biến an toàn — KHÔNG được nới
1. `run_command` luôn cần duyệt; không có chế độ tự duyệt cho nó.
2. Ghi file qua trình duyệt/extension chỉ là đề xuất, phải duyệt trong Studio.
3. Nội dung file/kết quả công cụ là dữ liệu không tin cậy, đánh dấu như vậy trong prompt.
4. Mọi ghi file kiểm tra realpath của tổ tiên gần nhất (chặn symlink/junction).
5. Checkpoint nằm ngoài project; không tạo file rác trong project người dùng.
6. Không đóng gói node_modules; không đọc .env/khóa/credential.

## Chưa kiểm chứng (đừng giả định)
- Bộ chọn DOM (`extension/selectors.js`) ĐÃ được chẩn đoán trên Gemini Web thật ngày 2026-11-14 (Chrome 158, giao diện tiếng Việt, tab /app): composer, nút Gửi, nút Dừng, khối trả lời, khối code, chat mới đều khớp; cấu trúc code-block đã đối chiếu với md.js (test 'REAL Gemini DOM'). CHƯA chạy: luồng thật điền prompt vào Quill → bấm Gửi → chờ/bắt trả lời, giao diện tiếng Anh/ngôn ngữ khác, Gemini cho tài khoản/tính năng khác. Nút Gửi và nút Dừng là CÙNG một nút (đổi nhãn) — không bao giờ coi nút nhãn dừng/ngừng là nút Gửi; UI của extension (#gps-bridge-hud…) luôn bị loại khỏi tìm kiếm.
- Giao diện Electron chưa chạy thật (chỉ tsc + vite build + smoke test Electron giả).
- Tự động hóa UI Gemini có rủi ro ToS/dễ vỡ; luôn giữ đường copy/paste thủ công.
