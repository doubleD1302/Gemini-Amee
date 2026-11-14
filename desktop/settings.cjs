'use strict';
/**
 * Cài đặt ứng dụng (Giai đoạn 3, mục 7): cổng bridge, giới hạn số lượt/ngữ cảnh, thư mục checkpoint.
 * Lưu NGOÀI project (userData/settings.json), ghi nguyên tử; mọi giá trị đọc từ đĩa hoặc từ giao diện đều bị kẹp vào khoảng an toàn.
 * Không có cài đặt nào làm yếu bất biến an toàn (không có tuỳ chọn tự duyệt lệnh, tắt duyệt, v.v.).
 *
 * Áp dụng ngay: maxTurns, contextBudgetChars, contextFiles, contextChars.
 * Áp dụng khi mở lại ứng dụng: bridgePort (cần ghép nối lại extension), checkpointDir.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  maxTurns: 25, contextBudgetChars: 240000, contextFiles: 12, contextChars: 48000, bridgePort: 47821, checkpointDir: ''
});
const RANGES = Object.freeze({
  maxTurns: [5, 100], contextBudgetChars: [20000, 2000000], contextFiles: [1, 40], contextChars: [8000, 200000], bridgePort: [1025, 65535]
});
const RESTART_KEYS = Object.freeze(['bridgePort', 'checkpointDir']);
const MAX_FILE_BYTES = 64 * 1024;

function clampInt(v, [min, max], dflt) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Thư mục checkpoint: tuyệt đối, KHÔNG nằm trong project (bất biến: checkpoint ngoài project), không phải thư mục gốc ổ đĩa,
 * tạo được và ghi được. Trả về đường dẫn chuẩn hoá. Rỗng = dùng mặc định trong userData.
 */
function validateCheckpointDir(dir, projectRoot) {
  const raw = String(dir == null ? '' : dir).trim();
  if (!raw) return '';
  if (raw.includes('\0') || raw.length > 500) throw new Error('Đường dẫn thư mục checkpoint không hợp lệ.');
  if (!path.isAbsolute(raw)) throw new Error('Thư mục checkpoint phải là đường dẫn tuyệt đối.');
  const abs = path.resolve(raw);
  if (path.parse(abs).root === abs) throw new Error('Không dùng thư mục gốc của ổ đĩa làm nơi lưu checkpoint.');
  if (projectRoot) {
    let real;
    try { real = fs.realpathSync(projectRoot); } catch { real = projectRoot; }
    if (isInside(real, abs) || isInside(abs, real)) throw new Error('Thư mục checkpoint phải nằm NGOÀI thư mục dự án (và không được chứa dự án).');
  }
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, `.gps-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
  } catch (err) { throw new Error(`Không ghi được vào thư mục checkpoint: ${err.message}`); }
  return abs;
}

/** Chuẩn hoá một object cài đặt thô (không kiểm tra thư mục checkpoint trên đĩa; việc đó làm ở set()/khởi động). */
function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(RANGES)) out[k] = clampInt(r[k], RANGES[k], DEFAULTS[k]);
  out.checkpointDir = typeof r.checkpointDir === 'string' && r.checkpointDir.length <= 500 && !r.checkpointDir.includes('\0') ? r.checkpointDir.trim() : '';
  return out;
}

class SettingsStore {
  constructor(file) { this.file = file; this.value = this._read(); }
  _read() {
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) return { ...DEFAULTS };
      return sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { return { ...DEFAULTS }; }
  }
  get() { return { ...this.value }; }
  /**
   * Áp dụng một phần cài đặt. Giá trị số sai kiểu/ngoài khoảng bị từ chối bằng lỗi rõ ràng (không âm thầm kẹp).
   * @returns {{ settings: object, restartRequired: string[] }}
   */
  set(patch, { projectRoot = null } = {}) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...this.value };
    for (const k of Object.keys(p)) {
      if (!(k in DEFAULTS)) throw new Error(`Cài đặt không tồn tại: ${k}`);
      if (k === 'checkpointDir') { next.checkpointDir = validateCheckpointDir(p[k], projectRoot); continue; }
      const [min, max] = RANGES[k];
      const n = typeof p[k] === 'number' ? p[k] : typeof p[k] === 'string' && /^\s*\d+\s*$/.test(p[k]) ? parseInt(p[k], 10) : NaN;
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${LABELS[k]} phải là số nguyên từ ${min.toLocaleString('vi-VN')} đến ${max.toLocaleString('vi-VN')}.`);
      next[k] = n;
    }
    const restartRequired = RESTART_KEYS.filter(k => next[k] !== this.value[k]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this.value = next;
    return { settings: { ...next }, restartRequired };
  }
  reset() {
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
    this.value = { ...DEFAULTS };
    return this.get();
  }
}

const LABELS = {
  maxTurns: 'Số lượt tối đa mỗi lần chạy', contextBudgetChars: 'Ngân sách ngữ cảnh mỗi cuộc trò chuyện (ký tự)', contextFiles: 'Số file tối đa gửi kèm',
  contextChars: 'Số ký tự tối đa gửi kèm', bridgePort: 'Cổng bridge', checkpointDir: 'Thư mục checkpoint'
};

module.exports = { SettingsStore, DEFAULTS, RANGES, RESTART_KEYS, LABELS, sanitize, validateCheckpointDir, clampInt };
