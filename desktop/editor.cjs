'use strict';
/**
 * Mở một file của project trong editor tại dòng thay đổi.
 * An toàn:
 *  - Đường dẫn LUÔN đi qua workspace.resolveInside (realpath, chặn thoát project/symlink; file phải tồn tại).
 *  - Không chạy lệnh shell/spawn. Chỉ trả về một URL theo scheme nằm trong danh sách cố định của editor
 *    (vscode://file/<đường dẫn>:<dòng>:1) hoặc đường dẫn thật để shell.openPath mở bằng ứng dụng mặc định.
 *  - Scheme không bao giờ lấy từ dữ liệu của model/người dùng, chỉ từ bảng EDITORS.
 * CHƯA kiểm chứng trên máy thật: định dạng URL của từng editor theo tài liệu công khai; luôn có đường dự phòng mở bằng ứng dụng mặc định.
 */
const workspace = require('./workspace.cjs');

const EDITORS = {
  vscode: { label: 'VS Code', scheme: 'vscode' },
  'vscode-insiders': { label: 'VS Code Insiders', scheme: 'vscode-insiders' },
  cursor: { label: 'Cursor', scheme: 'cursor' },
  windsurf: { label: 'Windsurf', scheme: 'windsurf' },
  vscodium: { label: 'VSCodium', scheme: 'vscodium' },
  default: { label: 'Ứng dụng mặc định', scheme: null }
};

function cleanLine(line) {
  const n = Math.floor(Number(line));
  return Number.isFinite(n) ? Math.min(1_000_000, Math.max(1, n)) : 1;
}

/** Mã hoá từng đoạn đường dẫn nhưng giữ nguyên ổ đĩa kiểu "C:". */
function encodePath(p) {
  const norm = p.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.exec(norm);
  const rest = drive ? norm.slice(2) : norm;
  const enc = rest.split('/').map(encodeURIComponent).join('/');
  return (drive ? drive[0] : '') + enc;
}

/**
 * @returns {{kind:'url', url:string, path:string, line:number, editor:string} | {kind:'path', path:string, line:number, editor:string}}
 * @throws nếu đường dẫn ra ngoài project / không tồn tại / không phải file thường.
 */
function editorTarget({ root, rel, line = 1, editor = 'vscode' }) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('Thiếu đường dẫn file.');
  const { real, stat } = workspace.resolveInside(root, rel);
  if (!stat.isFile()) throw new Error('Đích không phải file thường.');
  const key = Object.prototype.hasOwnProperty.call(EDITORS, editor) ? editor : 'vscode';
  const ln = cleanLine(line);
  const def = EDITORS[key];
  if (!def.scheme) return { kind: 'path', path: real, line: ln, editor: key };
  const p = encodePath(real);
  const url = `${def.scheme}://file/${p.startsWith('/') ? p.slice(1) : p}:${ln}:1`;
  return { kind: 'url', url, path: real, line: ln, editor: key };
}

/**
 * Mở bằng shell của Electron. Nếu URL thất bại (editor chưa cài/scheme chưa đăng ký) → mở bằng ứng dụng mặc định.
 * @returns {{opened:'url'|'path'|'none', fallback:boolean, editor:string, line:number, error?:string}}
 */
async function openInEditor(shell, opts) {
  const t = editorTarget(opts);
  if (t.kind === 'url') {
    try { await shell.openExternal(t.url); return { opened: 'url', fallback: false, editor: t.editor, line: t.line }; }
    catch { /* rơi xuống dự phòng */ }
  }
  const err = await shell.openPath(t.path);
  if (err) return { opened: 'none', fallback: true, editor: t.editor, line: t.line, error: String(err) };
  return { opened: 'path', fallback: t.kind === 'url', editor: t.editor, line: t.line };
}

module.exports = { EDITORS, editorTarget, openInEditor, encodePath, cleanLine };
