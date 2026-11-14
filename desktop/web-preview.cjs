'use strict';
/**
 * Xem trước web nội bộ (Giai đoạn 3, mục 2): mở dev server của project trong một cửa sổ riêng và chụp màn hình để gửi lại cho Gemini.
 *
 * An toàn (tùy chọn và luôn hỏi quyền):
 *  - CHỈ http(s) tới localhost / 127.0.0.1 / [::1] / *.localhost; không file:, data:, javascript:, không có user:pass@ trong URL,
 *    không chuyển hướng sang host khác (will-navigate/will-redirect bị chặn), không mở cửa sổ phụ, không tải xuống.
 *  - Cửa sổ sandbox, contextIsolation, KHÔNG nodeIntegration, phiên (partition) trong bộ nhớ tách khỏi giao diện Studio:
 *    không dùng chung cookie/localStorage; mọi quyền (camera, vị trí, thông báo...) bị từ chối.
 *  - Mở trang và chụp màn hình do NGƯỜI DÙNG bấm, hoặc do agent đề xuất qua tool `preview_open` / `preview_screenshot` (kind 'exec' ⇒ luôn
 *    qua thẻ duyệt, không có chế độ tự duyệt). Ảnh chụp có thể chứa dữ liệu nhạy cảm của ứng dụng nên chỉ rời máy khi đã được duyệt.
 *  - Ảnh đi vào hệ thống đính kèm (attachments.cjs): kiểm tra magic bytes, giới hạn dung lượng, không ghi vào project.
 * Lớp này không import electron: BrowserWindow được truyền vào (factory) nên test được bằng cửa sổ giả.
 */

const PARTITION = 'gps-web-preview';   // không có tiền tố "persist:" → phiên trong bộ nhớ
const MAX_WIDTH = 1280;
const MAX_URL = 2000;

/** Chuẩn hoá + kiểm tra URL xem trước. Ném lỗi tiếng Việt nếu không phải localhost an toàn. */
function validateUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('Hãy nhập địa chỉ trang xem trước, ví dụ http://localhost:5173');
  if (raw.length > MAX_URL) throw new Error('Địa chỉ quá dài.');
  // "localhost:5173" không phải một scheme: dấu ':' theo sau bởi cổng (toàn chữ số) → thiếu scheme, thêm http://.
  // Mọi scheme thật (file:, javascript:, data:...) vẫn bị từ chối ở bước kiểm tra protocol/host bên dưới.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw) ? raw : `http://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error('Địa chỉ không hợp lệ.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Chỉ hỗ trợ http:// hoặc https:// tới máy này.');
  if (u.username || u.password) throw new Error('Địa chỉ không được chứa tên đăng nhập/mật khẩu.');
  if (!isLocalHost(u.hostname)) throw new Error('Chỉ xem trước được trang chạy trên máy này (localhost, 127.0.0.1 hoặc [::1]).');
  return u.href;
}

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/.test(h);
}

/** Điều hướng bên trong cửa sổ xem trước: cùng điều kiện như khi mở. */
function isAllowedNavigation(url) {
  try { validateUrl(url); return true; } catch { return false; }
}

class WebPreview {
  /**
   * @param deps { createWindow(options) -> window }  window cần: webContents{ session, setWindowOpenHandler, on, loadURL, capturePage, getTitle, getURL, isDestroyed }, on, close, isDestroyed
   */
  constructor(deps) {
    this.createWindow = deps.createWindow;
    this.win = null;
    this.url = '';
    this.onChange = deps.onChange || (() => {});
  }

  status() {
    const open = !!(this.win && !this.win.isDestroyed());
    return { open, url: open ? this.url : '' };
  }

  async open(url) {
    const target = validateUrl(url);
    if (!this.status().open) this._create();
    this.url = target;
    this.onChange(this.status());
    try { await this.win.webContents.loadURL(target); }
    catch (err) { throw new Error(`Không tải được ${target}: ${err && err.message ? err.message : err} (dev server đã chạy chưa?)`); }
    this.url = String(this.win.webContents.getURL() || target);
    this.onChange(this.status());
    return this.status();
  }

  _create() {
    const win = this.createWindow({
      width: 1100, height: 760, title: 'Xem trước web · Gemini Project Studio', autoHideMenuBar: true, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: PARTITION, spellcheck: false }
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => { if (!isAllowedNavigation(url)) event.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', event => event.preventDefault());
    const ses = wc.session;
    if (ses) {
      if (ses.setPermissionRequestHandler) ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      if (ses.setPermissionCheckHandler) ses.setPermissionCheckHandler(() => false);
      if (ses.on) ses.on('will-download', event => event.preventDefault());
    }
    win.on('closed', () => { this.win = null; this.url = ''; this.onChange(this.status()); });
    this.win = win;
  }

  /** Chụp trang hiện tại → PNG (thu nhỏ nếu rộng hơn 1280px). Người gọi PHẢI đã có sự duyệt. */
  async capture() {
    if (!this.status().open) throw new Error('Chưa mở trang xem trước. Hãy mở một địa chỉ localhost trước.');
    let img = await this.win.webContents.capturePage();
    if (!img || (img.isEmpty && img.isEmpty())) throw new Error('Không chụp được trang (trang trống hoặc cửa sổ bị ẩn).');
    let size = img.getSize();
    if (size.width > MAX_WIDTH) {
      img = img.resize({ width: MAX_WIDTH });
      size = img.getSize();
    }
    const png = img.toPNG();
    return { png, width: size.width, height: size.height, url: this.url, title: String(this.win.webContents.getTitle() || '').slice(0, 120) };
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.url = '';
    this.onChange(this.status());
  }
}

module.exports = { WebPreview, validateUrl, isLocalHost, isAllowedNavigation, PARTITION, MAX_WIDTH };
