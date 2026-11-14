# Gemini Project Studio (0.2.0)

A **separate Electron + React coding assistant** for your own projects, using **Gemini Web** in normal Chrome via an opt-in extension. It does **not** call the Gemini API, use Google login cookies, bypass account limits, or require an API key.

> **Trạng thái (0.2.0):** Đã có **chế độ Agent** kiểu Antigravity chạy qua Gemini Web (vòng lặp đọc → sửa → chạy lệnh, có duyệt từng bước, hoàn tác). Logic lõi được test bằng Node (153 test, dùng Gemini giả). Bộ chọn DOM đã được chẩn đoán trên Gemini Web thật (giao diện tiếng Việt, 2026-11-14) nhưng **luồng gửi/nhận tự động end-to-end và cửa sổ Electron thật chưa được chạy** — selector có thể vỡ khi Gemini đổi giao diện; dùng nút "Kiểm tra bộ chọn" trên HUD để chẩn đoán. Luôn có đường dự phòng copy/paste thủ công.

## Chế độ Agent (mới)

Gemini Web không có MCP như ChatGPT, nên Studio dùng **giao thức gọi công cụ bằng văn bản**: model trả lời bằng các khối ```` ```gps-tool ````, Studio phân tích, thực thi, rồi gửi kết quả ngược lại cho tới khi model gọi `finish`.

- Công cụ đọc (tự chạy): `read_file`, `list_dir`, `grep`.
- Công cụ sửa (**cần duyệt**, trừ khi bật "tự duyệt sửa file"): `write_file`, `edit_file` (khối `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`).
- `run_command`: **luôn cần duyệt**, không thể tự duyệt (timeout 60s, tối đa 300s).
- `ask_user`, `finish`.
- Mọi thay đổi có **checkpoint** lưu NGOÀI project (thư mục userData của Electron); hoàn tác trong tab Agent, có kiểm tra xung đột nếu file đã bị sửa tiếp.
- Nội dung file và kết quả công cụ được coi là **dữ liệu không tin cậy** (chống prompt injection).
- Nút "Đề xuất ghi vào…" trên trình duyệt chỉ tạo **đề xuất**, bạn phải duyệt trong Studio.
- Bridge dùng **token + cổng cố định (47821)** nên không phải ghép nối lại mỗi lần mở app. Job kẹt sẽ được đưa vào hàng đợi lại 1 lần rồi báo timeout.
- **Sau khi cập nhật: tải lại extension trong chrome://extensions, rồi ghép nối lại một lần.**
- Cập nhật bản cài sẵn: chạy `npm run package:win` trước, rồi `cap-nhat-extension.bat` (nó chép từ `release\win-unpacked`; nếu không build lại thì vẫn là bản cũ).


## Requirements

- Windows 10/11, macOS, or Linux
- Node.js 22 LTS or newer, npm
- Chrome or Edge (Manifest V3), a Gemini Web account

## Quick start (Windows PowerShell)

Vietnamese instructions: open `START_HERE_VI.md`, or double-click `start-windows.bat` after installing Node.js.

```powershell
# Unzip the source archive, open PowerShell inside the project folder.
npm install
npm run dev
```

If the Electron binary download fails with `ECONNRESET`, run `repair-windows.bat` to clean incomplete dependencies and retry. See `WINDOWS_INSTALL_FIX.md`. The launcher now checks for the Windows Electron executable, not merely the package directory.

The Electron window opens after Vite starts. Click **Mở project** to select a source-code folder. Ở chế độ hỏi đáp ứng dụng chỉ đọc; chỉ tab **Agent** mới có thể ghi/chạy lệnh, và luôn qua bước duyệt của bạn.

## Connect Gemini Web

1. In Project Studio, open the **Bridge** tab (right inspector).
2. Click **Mở thư mục extension** to reveal the `extension` folder.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the **extension** folder.
4. In Studio, click **Copy pairing JSON**.
5. Click the Project Studio extension icon in Chrome, paste the JSON, then click **Lưu & kết nối**.
6. Open `https://gemini.google.com/app` in **ordinary Chrome**, sign into your Google account, and keep that tab open. Reload the tab if the extension was installed after the tab opened.
7. The app shows **Bridge connected** when the Gemini tab polls the local server. You can now ask a project question in the desktop app.

Gemini Web does not provide a public, stable browser-agent API. The extension locates Gemini's composer, sends the prepared prompt, and watches for a reply in the DOM. If this breaks, copy the prepared prompt in Studio, paste it manually into Gemini, then click **Dán câu trả lời thủ công** to bring the answer back. You can still browse and search all local files without the extension.

## How project context is selected

- Recursively index up to **2,500** source files. Files over **180 KB** are skipped; nested directory depth max **11**.
- Ignore `node_modules`, `.git`, `dist`, build artifacts, virtualenvs, images/binaries, `.env` files, keys, credentials and symlinks.
- Generate a project tree and choose up to **12** relevant files (mặc định; chỉnh được), prioritizing the active file, repository metadata, and names related to the question; cap file contents at **48,000 characters** (plus tree/instructions).
- The **selected code snippets leave your computer when sent to Gemini Web**. Always review the data in your source code before sending it to a third-party service. Exclusion is best-effort, not a guarantee that your code contains no secrets.

## Security model

- The local bridge binds only to **127.0.0.1** on a fixed port (47821, random fallback) with a persisted **256-bit bearer token** (timing-safe compare).
- Only the trusted Electron main process can read the workspace; the browser bridge only receives **already-prepared prompts** and sends reply text.
- Every file read validates its real path against the project root; symlinks and common secret filenames are blocked.
- The extension only requests `http://127.0.0.1/*` host permissions and runs the content script on `gemini.google.com`.
- Ghi file và chạy lệnh chỉ xảy ra qua Agent với bước duyệt; ghi file kiểm tra realpath (chặn symlink/junction thoát khỏi project) và ghi nguyên tử.
- The extension uses DOM interaction, not cookie collection, Google internal endpoints, or OAuth token extraction.
- As with any tool that sends code to an LLM, source text can contain prompt injection. Code from project files is marked untrusted in the outgoing prompt.

## Development and tests

```powershell
npm run test       # 153 test Node: workspace, bridge, giao thức/công cụ agent, vòng lặp e2e với Gemini giả, md.js, lịch sử
npm run typecheck  # TypeScript checks after npm install
npm run build      # production Vite renderer
npm run start      # launch Electron with dist/ after building
```

**Optional Windows installer** (may require Windows build tools and download of Electron binaries):

```powershell
npm run package:win
```

After packaging, the bundled extension lives in the app's installed `resources/extension` directory. Use the **Bridge** tab in the installed app to find it.

## Folder structure

```text
src/             React + TypeScript desktop UI
  App.tsx        Chat, file explorer, search, preview, bridge settings
  styles.css     Dark Antigravity-inspired visual design
desktop/         Electron IPC, workspace, bridge, agent (agent/tools/protocol/checkpoints/diff)
extension/       Chrome Manifest V3 companion and DOM adapter
scripts/         Dev launch helper
tests/           No-dependency Node.js tests
```

## Current MVP limitations / next milestones

- The Gemini Web composer and response selectors are not a stable API. Auto-send/auto-capture must be verified on your current Gemini version.
- Chưa có: đính kèm ảnh, đếm token chính xác (chỉ có ước lượng thô ~3,5 ký tự/token), truy xuất ngữ nghĩa/embedding, tool song song, tự chạy test không cần duyệt (agent chỉ được gợi ý lệnh test của project, mỗi lệnh vẫn cần bạn duyệt). Xem `docs/ROADMAP.md`.
- Only the selected files are included inline. Gemini has no guarantee of fully comprehending a large codebase based on one snapshot.
- For users who prefer a supported official interface and predictable behavior, Gemini API or Gemini CLI is a more maintainable long-term option, but those are distinct from Gemini Web.

## Licensing

This starter is authored from scratch for this request. You can adapt it for private projects. Dependencies retain their own licenses; Google Gemini remains subject to Google's terms and product restrictions.
