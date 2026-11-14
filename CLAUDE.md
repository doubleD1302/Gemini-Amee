# Gemini Project Studio — hướng dẫn cho Claude Code

Ứng dụng desktop (Electron + React + Chrome MV3 extension) kiểu **Antigravity** chạy qua **Gemini Chat web**. Cảm hứng: totec448-spec/chat-on-steroids (ChatGPT + MCP). Gemini web không có MCP ⇒ dùng **giao thức gọi công cụ bằng văn bản** (khối ```gps-tool).
Giao tiếp và UI bằng **tiếng Việt**. Không có API key Gemini; không lấy cookie Google.

## Kiến trúc
- `desktop/main.cjs` – Electron main, IPC (`studio:*`, `agent:*`, `rules:*`, `git:*`, `term:*`, `preview:*`, `settings:*`), ráp bridge + nhiều `AgentRunner` (map `runners`: `main`, `s2`, `s3`) + CheckpointStore + RulesStore + TerminalManager + WebPreview + SettingsStore. Mọi IPC `agent:*` nhận `sessionId` ở tham số CUỐI (vắng = `main`); sự kiện `studio:agent` mang `sessionId`.
- `desktop/bridge.cjs` – HTTP 127.0.0.1 (cổng mặc định 47821, token lưu bền). Job queue + watchdog (requeue 1 lần → timeout), cancel, completeManually. `/v1/write-file` chỉ tạo **đề xuất**. Job mang `session`/`navigate`/ảnh đính kèm (không bao giờ phát bytes ảnh ra sự kiện `job`: chỉ `attachmentCount`). Extension báo phiên bản qua header `X-GPS-Extension-Version`/`X-GPS-Protocol`; `PROTOCOL` (hiện 2) phải khớp `GPS_PROTOCOL` trong `extension/background.js` (có test); `info().extension.status` = unknown/ok/outdated/newer hiển thị ở tab Bridge. Result `code:'navigating'` ⇒ job được xếp hàng lại (tối đa 3 lần).
- `desktop/agent.cjs` – `AgentRunner`: vòng lặp (mặc định 25 lượt, chỉnh được ở Cài đặt), retry định dạng ≤2, duyệt từng bước, policy `{autoEdits}`. `prepare` được `await` (tool git cần async). Mỗi runner có `slot` ('' = phiên chính) và `isMulti()`.
- `desktop/agent-protocol.cjs` – parse/format khối gps-tool, system prompt (có phần quy tắc project khi đã duyệt), kickoff, recap.
- `desktop/context.cjs` – `ContextMeter` (ước lượng ký tự/token của chat Gemini hiện tại; ngân sách mặc định 240k ký tự CHƯA kiểm chứng với giới hạn thật) và `Ledger` (sổ tiến độ do ỨNG DỤNG ghi từ các tool đã chạy: file đã sửa, lệnh, việc còn dở). Agent tự mở chat mới kèm recap khi vượt ngân sách hoặc khi người dùng bấm "Chat mới ở lượt sau".
- `desktop/sessions.cjs` – `SessionStore`: lưu bền phiên Agent theo project + **slot** (slot '' = đường dẫn cũ; `s2`,`s3` = phiên song song) trong userData (NGOÀI project, ghi nguyên tử, đọc lên được kiểm tra kiểu/độ dài). Lưu: mục tiêu, timeline, nhật ký, sổ tiến độ, kế hoạch (plan), số liệu ngữ cảnh. KHÔNG lưu/khôi phục: yêu cầu duyệt đang chờ (đánh dấu HẾT HẠN, không bao giờ tự chạy), chính sách tự duyệt (luôn tắt sau khi mở lại), system prompt (dựng lại), tệp đính kèm. Khôi phục luôn mở chat Gemini MỚI kèm recap.
- `desktop/editor.cjs` – mở file project trong editor tại dòng thay đổi: realpath qua `resolveInside`, KHÔNG spawn/shell; chỉ URL theo bảng scheme cố định hoặc `shell.openPath` làm dự phòng. Định dạng URL của từng editor CHƯA kiểm chứng trên máy thật.
- `desktop/project-hints.cjs` – suy ra lệnh test/lint/typecheck/build từ package.json (+Cargo/go/pytest) để GỢI Ý trong system prompt.
- `desktop/tools.cjs` – read_file/list_dir/grep/**search_code**/write_file/edit_file/run_command/**process_start/process_logs/process_send/process_stop**/**preview_open/preview_screenshot**/**git_status/git_diff/git_commit**/plan/finish/ask_user (`prepare` không side-effect, `run` thực thi). kind: `exec` = LUÔN cần duyệt (run_command, process_start, process_send, preview_open, preview_screenshot, git_commit); `plan` là kind 'control' nhưng KHÔNG kết thúc vòng lặp (xử lý riêng, chỉ ghi `run.plan`).
- `desktop/plan.cjs` – Kế hoạch (checklist) hiển thị: `parsePlanBody` (`- [ ]`/`- [~]`/`- [x]`; ≤30 mục, ≤200 ký tự, bỏ ký tự điều khiển/ẩn), `sanitizePlan`, `renderPlanForRecap` (chỉ mục CHƯA xong, rào `fenceFor`, nhãn dữ liệu không tin cậy). `run.plan` có trong `snapshot()`, xoá khi `start()`, lưu/khôi phục qua `sessions.cjs`, vào recap qua `Ledger.render(plan)`.
- `desktop/attachments.cjs` – tệp đính kèm (chỉ trong bộ nhớ): ảnh PNG/JPEG/GIF/WEBP nhận diện bằng magic bytes (≤4MB, ≤3 tệp) đi qua extension; tệp văn bản UTF-8 ≤100KB nhúng thẳng vào prompt trong rào + nhãn không tin cậy; tên nhạy cảm (.env, khoá…) bị chặn với tệp văn bản. Upload ảnh vào Gemini (extension: dán → thả → input file, xác nhận bằng số xem trước) CHƯA kiểm chứng; thất bại ⇒ code `attachment_failed`, KHÔNG lặng lẽ gửi thiếu ảnh, "Thử lại" gửi chỉ chữ kèm ghi chú cho model rằng nó không nhận được ảnh.
- `desktop/project-rules.cjs` – `.gps/rules.md` + `.gps/skills/*.md`. Chỉ nạp vào system prompt khi người dùng đã DUYỆT đúng nội dung (hash lưu NGOÀI project; đổi bên ngoài ⇒ `review`, không nạp). Lưu từ UI tự duyệt trừ khi đang `review`. Nằm SAU quy tắc bắt buộc và nói rõ không nới được chúng; thân kỹ năng không vào prompt (agent `read_file`).
- `desktop/git.cjs` – status/diff/commit. `execFile` (không shell) với `-c core.fsmonitor=false`, `--no-ext-diff --no-textconv` (chống cấu hình độc trong repo lạ). Không push/pull/reset/`add -A`/`--no-verify`. Commit: đường dẫn liệt kê tường minh, phải có trong status, không file chặn/symlink; `git commit -- paths`; hook mặc định TẮT. Nút Commit của UI cần hộp thoại xác nhận của hệ thống (main); `git_commit` của agent là kind `exec`.
- `desktop/bm25.cjs` + `workspace.searchCode/ensureBm25` – chỉ mục BM25 + ký hiệu + đường dẫn (bỏ dấu tiếng Việt, tách camelCase), trong bộ nhớ, lập lại theo `size:mtime`. Dùng cho `search_code` và cộng điểm/trích đoạn liên quan trong `buildContext` (lỗi chỉ mục ⇒ quay về xếp hạng cũ).
- `desktop/terminal.cjs` – `TerminalManager`: tiến trình nền (≤4 chạy, log vòng 200KB, input ≤4000, chỉ điều khiển tiến trình do chính nó tạo). Agent: process_start/process_send luôn qua thẻ duyệt; người dùng tự bấm trong UI = tự duyệt. Dừng hết khi đổi project/thoát.
- `desktop/web-preview.cjs` – cửa sổ xem trước CHỈ localhost (`validateUrl`), sandbox, partition trong bộ nhớ, chặn popup/điều hướng/quyền/tải xuống; chụp màn hình qua duyệt rồi đính kèm vào tin nhắn kế tiếp. Cửa sổ Electron thật chưa được xem.
- `desktop/settings.cjs` – `SettingsStore` (userData/settings.json): maxTurns, ngân sách ngữ cảnh, số file/ký tự gửi kèm (áp dụng ngay), cổng bridge và thư mục checkpoint (áp dụng khi mở lại). Kẹp khoảng an toàn; thư mục checkpoint phải ngoài project. KHÔNG có cài đặt nào nới cơ chế duyệt.
- `desktop/update-check.cjs` – kiểm tra bản mới trên GitHub Releases CHỈ khi người dùng bấm; không tự tải/cài; chỉ mở trang phát hành của đúng repo.
- `desktop/workspace.cjs` – truy cập file an toàn (realpath, ghi nguyên tử, .gitignore, chấm điểm ngữ cảnh, `configureContext`).
- `desktop/checkpoints.cjs`, `desktop/diff.cjs` – hoàn tác (lưu ngoài project), unified diff, `parseUnified/sideBySide/firstChangedLine/diffExtras`.
- `extension/` – `selectors.js` (bảng SELECTORS + find*/diagnose; nguồn của docs/diagnose-gemini-dom.js, sinh bằng `node scripts/make-diagnostic-snippet.cjs`), `md.js`, `content.js` (tự động hóa DOM Gemini, đính kèm ảnh, tự chuyển cuộc trò chuyện khi `job.navigate`), `background.js`, `popup.*`.
- `src/` – React UI; `AgentSessions.tsx` (tab phiên song song) → `AgentPanel.tsx` (tab Agent, gắn `sessionId`) cùng `RulesPanel`, `GitPanel`, `TerminalPanel`, `PreviewPanel`; `SettingsPanel` nằm trong tab Bridge; `src/utils/historyStorage.ts` lưu lịch sử vào localStorage.

## Lệnh
```
npm test                 # node --test tests/*.test.cjs  (249 test; KHÔNG dùng `node --test tests/`)
npx tsc --noEmit         # strict, phải exit 0
npx vite build
npm run package:win      # build bản Windows; xem docs/PACKAGING.md (ký mã, phát hành)
```
`tests/main_wiring.test.cjs` chạy main.cjs với Electron giả; cần `--test-timeout` nếu treo. Test git/terminal tạo repo/tiến trình thật (bỏ qua nếu thiếu `git`); trên Windows thư mục tạm có thể bị khoá vài giây sau khi dừng tiến trình.

## Quy ước
- `desktop/` là CommonJS (`.cjs`), không thêm dependency runtime (hiện KHÔNG có: react/lucide là devDependencies vì vite bundle, nên `app.asar` không chứa node_modules).
- Tính năng mới phải có test; logic agent test bằng Gemini giả (xem `tests/agent.test.cjs`).
- Sửa test cho khớp hành vi mới chỉ khi hành vi cũ là sai có chủ đích; nêu rõ trong báo cáo.
- Mọi chuỗi UI tiếng Việt.
- Công cụ ghi file của môi trường dev có thể làm mất dấu `\` trong heredoc/script; dùng Write/Edit cho mã có backslash hoặc escape unicode.

## Bất biến an toàn — KHÔNG được nới
1. `run_command` luôn cần duyệt; không có chế độ tự duyệt cho nó. Cùng quy tắc cho mọi tool `exec`: `process_start`, `process_send`, `preview_open`, `preview_screenshot`, `git_commit` (`approve_all_edits` bị từ chối với `exec`).
2. Ghi file qua trình duyệt/extension chỉ là đề xuất, phải duyệt trong Studio.
3. Nội dung file/kết quả công cụ/log tiến trình/tệp đính kèm/quy tắc project là dữ liệu không tin cậy, đánh dấu và rào (`fenceFor`) trong prompt.
4. Mọi ghi file kiểm tra realpath của tổ tiên gần nhất (chặn symlink/junction).
5. Checkpoint nằm ngoài project; không tạo file rác trong project người dùng (cài đặt, dấu duyệt quy tắc, phiên lưu đều ở userData).
6. Không đóng gói node_modules; không đọc .env/khóa/credential.
7. Xem trước gộp nhiều edit cùng file (`_planEditGroups`) chỉ mô phỏng trên overlay trong bộ nhớ, bỏ nhóm nếu có `run_command` xen giữa; `approve_group` chỉ cho thao tác sửa file.
8. Phiên khôi phục không bao giờ thực thi lại thao tác chờ duyệt cũ và không khôi phục tự duyệt.
9. Tool `plan` chỉ ghi trạng thái hiển thị; nội dung kế hoạch là dữ liệu không tin cậy (UI text thuần, recap có rào + nhãn, không kích hoạt tool).
10. Quy tắc project (`.gps`) chỉ có hiệu lực sau khi người dùng duyệt đúng nội dung; không nới được quy tắc bắt buộc.
11. Git: không push/pull/reset; commit chỉ gồm đường dẫn tường minh hợp lệ; lệnh đọc được làm cứng chống cấu hình repo độc; hook mặc định tắt.
12. Xem trước web chỉ localhost, sandbox; ảnh chụp chỉ rời máy khi đã duyệt và gửi tin nhắn. Kiểm tra cập nhật chỉ khi bấm, không tự tải/cài.
13. Mỗi phiên song song có runner/pending/plan/ledger riêng; một phiên không duyệt/thấy được yêu cầu của phiên khác.

## Chưa kiểm chứng (đừng giả định)
- Bộ chọn DOM (`extension/selectors.js`) ĐÃ được chẩn đoán trên Gemini Web thật ngày 2026-11-14 (Chrome 158, giao diện tiếng Việt, tab /app): composer, nút Gửi, nút Dừng, khối trả lời, khối code, chat mới đều khớp; cấu trúc code-block đã đối chiếu với md.js. CHƯA chạy: luồng thật điền prompt vào Quill → bấm Gửi → chờ/bắt trả lời, giao diện tiếng Anh/ngôn ngữ khác, Gemini cho tài khoản/tính năng khác. Nút Gửi và nút Dừng là CÙNG một nút (đổi nhãn) — không bao giờ coi nút nhãn dừng/ngừng là nút Gửi; UI của extension luôn bị loại khỏi tìm kiếm.
- Hoàn toàn PHỎNG ĐOÁN, chưa thử trên Gemini thật: selector `attachmentPreview`/`fileInput` và cách tải ảnh (dán/thả/input file); tự chuyển cuộc trò chuyện bằng `location.href` khi nhiều phiên (`navigating`); Gemini có tuân theo định dạng `plan` và cập nhật đều hay không.
- Electron: bản đóng gói (`--dir`) đã khởi động được và bridge trả lời (đã kiểm một lần), nhưng giao diện React trong cửa sổ Electron thật (checklist, tab phiên, các panel Git/Terminal/Quy tắc/Xem trước/Cài đặt), cửa sổ xem trước web và hộp thoại xác nhận commit CHƯA được nhìn/bấm thử bằng tay. Phần còn lại chỉ qua tsc + vite build + Electron giả.
- Ký mã và tự cập nhật CHƯA làm (cần chứng chỉ ký mã và kênh phát hành đã ký); xem docs/PACKAGING.md. Hiện chỉ có kiểm tra phiên bản theo yêu cầu.
- Tự động hóa UI Gemini có rủi ro ToS/dễ vỡ; luôn giữ đường copy/paste thủ công.
