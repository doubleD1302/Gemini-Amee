'use strict';
/**
 * Chỉ mục tìm kiếm "ngữ nghĩa nhẹ" cho code: BM25 trên token đã chuẩn hoá + ký hiệu (tên hàm/lớp/kiểu) + đường dẫn.
 * Thuần JavaScript, không embedding, không mạng, không phụ thuộc workspace (việc đọc file do bên gọi lo).
 *
 *  - Token: chữ/số Unicode; tách camelCase/snake_case (giữ cả dạng nguyên); bỏ dấu tiếng Việt (đ→d) để "đăng nhập" ≈ "dang nhap".
 *  - Trường có trọng số kiểu BM25F đơn giản: thân file ×1, đường dẫn ×3, ký hiệu khai báo ×4.
 *  - Ký hiệu: bắt bằng regex theo dòng cho JS/TS, Python, Rust, Go, v.v. (xấp xỉ, không phải parser thật).
 *  - bestWindow: tìm đoạn (cửa sổ dòng) khớp nhất trong một file để trích thay vì cắt đầu file.
 */

const K1 = 1.4;
const B = 0.75;
const W_BODY = 1, W_PATH = 3, W_SYMBOL = 4;
const MAX_SYMBOLS = 200;
const MAX_SCAN_LINES = 6000;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'how', 'what', 'where', 'why', 'this', 'that', 'from', 'into', 'are', 'not', 'can', 'does', 'when', 'which', 'file', 'code',
  'va', 'cua', 'cho', 'la', 'cac', 'mot', 'trong', 'nay', 'khi', 'voi', 'nhung', 'duoc', 'khong', 'co', 'hay', 'sao', 'nao', 'gi', 'tai'
]);

const SYMBOL_RES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>|\{|\[|class\b)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|mod)\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async)\s+)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*$/,
  /^\s*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/
];
const NOT_SYMBOL = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'with', 'new', 'await', 'typeof', 'constructor']);

/** Bỏ dấu + chữ thường. */
function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/** Các token (đã fold) của một chuỗi: dạng nguyên + các phần camelCase/snake_case. Không lọc stopword. */
function tokenize(text) {
  const out = [];
  const words = String(text == null ? '' : text).match(/[\p{L}\p{N}_$]+/gu) || [];
  for (const raw of words) {
    if (raw.length > 60) continue;
    const whole = fold(raw).replace(/[_$]/g, '');
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/).map(fold).filter(p => p.length >= 2);
    if (whole.length >= 2 && parts.length !== 1) out.push(whole);
    for (const p of parts) out.push(p);
    if (parts.length === 1 && whole.length >= 2 && !out.includes(whole)) out.push(whole);
  }
  return out;
}

/** Token của câu hỏi: bỏ stopword, bỏ trùng. */
function queryTerms(query) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(String(query || '').slice(0, 2000))) {
    if (STOP.has(t) || t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

/** Ký hiệu khai báo [{ name, line }] (xấp xỉ bằng regex). */
function extractSymbols(text) {
  const out = [];
  const lines = String(text || '').split('\n', MAX_SCAN_LINES);
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const re of SYMBOL_RES) {
      const m = re.exec(line);
      if (m && m[1] && !NOT_SYMBOL.has(m[1])) { out.push({ name: m[1], line: i + 1 }); break; }
    }
  }
  return out;
}

class Bm25Index {
  constructor() { this.docs = new Map(); this.df = new Map(); this.totalLen = 0; }
  get size() { return this.docs.size; }
  sigOf(path) { const d = this.docs.get(path); return d ? d.sig : null; }
  _drop(path) {
    const d = this.docs.get(path);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) || 0) - 1;
      if (n > 0) this.df.set(t, n); else this.df.delete(t);
    }
    this.totalLen -= d.len;
    this.docs.delete(path);
  }
  /** Thêm/cập nhật một tài liệu. `sig` dùng để biết khi nào cần lập lại chỉ mục. */
  upsert(path, { sig = '', text = '' }) {
    this._drop(path);
    const tf = new Map();
    const add = (t, w) => tf.set(t, (tf.get(t) || 0) + w);
    const body = tokenize(text);
    for (const t of body) add(t, W_BODY);
    for (const t of tokenize(path)) add(t, W_PATH);
    const symbols = extractSymbols(text);
    for (const s of symbols) for (const t of tokenize(s.name)) add(t, W_SYMBOL);
    const len = Math.max(1, body.length);
    this.docs.set(path, { sig, tf, len, symbols });
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.totalLen += len;
  }
  remove(path) { this._drop(path); }
  /** Giữ lại đúng các đường dẫn trong `keep` (Set). */
  prune(keep) { for (const p of [...this.docs.keys()]) if (!keep.has(p)) this._drop(p); }
  idf(term) {
    const n = this.docs.size;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }
  /** @returns {Array<{path:string, score:number, symbols:Array<{name:string,line:number}>}>} giảm dần theo điểm */
  search(query, { limit = 20 } = {}) {
    const terms = Array.isArray(query) ? query : queryTerms(query);
    if (!terms.length || !this.docs.size) return [];
    const avg = this.totalLen / this.docs.size || 1;
    const idfs = terms.map(t => this.idf(t));
    const out = [];
    for (const [path, d] of this.docs) {
      let score = 0;
      for (let i = 0; i < terms.length; i++) {
        const f = d.tf.get(terms[i]);
        if (!f) continue;
        score += idfs[i] * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
      }
      if (score > 0) {
        const set = new Set(terms);
        const symbols = d.symbols.filter(s => tokenize(s.name).some(t => set.has(t))).slice(0, 5);
        out.push({ path, score, symbols });
      }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, limit);
  }
}

/**
 * Cửa sổ dòng khớp nhất với các từ khoá trong `text`.
 * @returns {{ start:number, end:number, score:number }|null} số dòng 1-based, bao gồm cả hai đầu.
 */
function bestWindow(text, terms, { size = 40, idf = () => 1 } = {}) {
  if (!terms || !terms.length) return null;
  const lines = String(text || '').split('\n', MAX_SCAN_LINES);
  if (!lines.length) return null;
  const set = new Map(terms.map(t => [t, idf(t)]));
  const per = lines.map(l => {
    if (l.length > 600) return 0;
    let s = 0;
    const seen = new Set();
    for (const t of tokenize(l)) if (set.has(t) && !seen.has(t)) { seen.add(t); s += set.get(t); }
    return s;
  });
  let cur = 0, best = 0, bestAt = 0;
  for (let i = 0; i < per.length; i++) {
    cur += per[i];
    if (i >= size) cur -= per[i - size];
    if (cur > best) { best = cur; bestAt = i; }
  }
  if (best <= 0) return null;
  const end = bestAt + 1;
  const start = Math.max(1, end - size + 1);
  // Co cửa sổ về dòng khớp đầu tiên/cuối cùng để không kèm dòng thừa.
  let a = start, z = end;
  while (a < z && per[a - 1] === 0) a++;
  while (z > a && per[z - 1] === 0) z--;
  return { start: a, end: z, score: best };
}

module.exports = { Bm25Index, tokenize, queryTerms, extractSymbols, bestWindow, fold, STOP };
