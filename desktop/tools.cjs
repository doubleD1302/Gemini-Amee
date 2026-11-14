'use strict';
/**
 * Bộ tool cho agent. Mỗi tool có:
 *   kind:    'read' (tự chạy) | 'edit' (cần duyệt, trừ khi bật tự duyệt sửa file) |
 *            'exec' (LUÔN cần duyệt) | 'control' (do vòng lặp xử lý)
 *   prepare: kiểm tra + tính trước (diff...) KHÔNG có tác dụng phụ
 *   run:     thực thi thật
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const workspace = require('./workspace.cjs');
const { unifiedDiff } = require('./diff.cjs');

const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 24_000;
const CMD_MAX_OUTPUT = 60_000;

function bool(v) { return /^(true|yes|1|on)$/i.test(String(v == null ? '' : v).trim()); }
function int(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function normPath(p) {
  return String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^["'`]|["'`]$/g, '');
}
function needPath(args) {
  const p = normPath(args.path);
  if (!p) throw new Error('Thiếu tham số "path".');
  return p;
}
function eolOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function toLF(text) { return text.replace(/\r\n/g, '\n'); }
function fromLF(text, eol) { return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text; }
function numbered(lines, startLine) {
  const width = String(startLine + lines.length).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, ' ')} | ${l}`).join('\n');
}

/* ---------- read_file ---------- */
const read_file = {
  name: 'read_file', kind: 'read',
  description: 'Đọc nội dung một file văn bản trong dự án (có số dòng). Tối đa 400 dòng mỗi lần; dùng start_line/end_line để đọc phần khác.',
  usage: 'tool: read_file\npath: src/App.tsx\nstart_line: 1      (tuỳ chọn)\nend_line: 200      (tuỳ chọn)',
  prepare(ctx, args) { return { label: needPath(args) }; },
  async run(ctx, args) {
    const rel = needPath(args);
    const { content } = workspace.readProjectFile(ctx.root, rel);
    const all = toLF(content).split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    const total = all.length;
    const start = int(args.start_line, 1, 1, Math.max(1, total));
    let end = int(args.end_line, Math.min(total, start + READ_MAX_LINES - 1), start, total || start);
    if (end - start + 1 > READ_MAX_LINES) end = start + READ_MAX_LINES - 1;
    let text = numbered(all.slice(start - 1, end), start);
    let note = '';
    if (text.length > READ_MAX_CHARS) { text = text.slice(0, READ_MAX_CHARS); note = ' (cắt theo giới hạn ký tự)'; }
    return { output: `FILE ${rel} · dòng ${start}-${Math.min(end, total)} / ${total}${end < total ? ' · còn nữa, dùng start_line để đọc tiếp' : ''}${note}\n${text}` };
  }
};

/* ---------- list_dir ---------- */
const list_dir = {
  name: 'list_dir', kind: 'read',
  description: 'Liệt kê file/thư mục dưới một thư mục (đã loại node_modules, file bí mật, mục trong .gitignore).',
  usage: 'tool: list_dir\npath: src          (tuỳ chọn, mặc định thư mục gốc)\ndepth: 2           (tuỳ chọn, 1-5)',
  prepare(ctx, args) { return { label: normPath(args.path) || '.' }; },
  async run(ctx, args) {
    const index = workspace.scanProject(ctx.root);
    const prefix = normPath(args.path).replace(/\/$/, '');
    const depth = int(args.depth, 2, 1, 5);
    const base = prefix === '.' ? '' : prefix;
    const dirs = new Map();
    const files = [];
    for (const f of index.files) {
      if (base && !(f.path === base || f.path.startsWith(base + '/'))) continue;
      const rel = base ? f.path.slice(base.length + 1) : f.path;
      if (!rel) continue;
      const parts = rel.split('/');
      if (parts.length <= depth) files.push({ rel, size: f.size });
      for (let i = 1; i < Math.min(parts.length, depth + 1); i++) {
        const d = parts.slice(0, i).join('/');
        dirs.set(d, (dirs.get(d) || 0) + 1);
      }
    }
    if (!files.length && !dirs.size) throw new Error(`Không có gì dưới "${base || '.'}" (hoặc bị loại trừ).`);
    const lines = [];
    for (const [d] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`${d}/`);
    for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) lines.push(`${f.rel}  (${f.size} B)`);
    const shown = lines.slice(0, 300);
    return { output: `${base || '.'}:\n${shown.join('\n')}${lines.length > shown.length ? `\n… và ${lines.length - shown.length} mục nữa` : ''}` };
  }
};

/* ---------- grep ---------- */
const grep = {
  name: 'grep', kind: 'read',
  description: 'Tìm văn bản (hoặc regex) trong các file của dự án. Trả về path:dòng: nội dung.',
  usage: 'tool: grep\npattern: loginUser\nregex: false             (tuỳ chọn)\npath: src                (tuỳ chọn, giới hạn thư mục)\ncase_sensitive: false    (tuỳ chọn)\nmax: 40                  (tuỳ chọn, tối đa 100)',
  prepare(ctx, args) {
    if (!String(args.pattern || '').trim()) throw new Error('Thiếu tham số "pattern".');
    return { label: String(args.pattern).slice(0, 80) };
  },
  async run(ctx, args) {
    const max = int(args.max, 40, 1, 100);
    const results = await workspace.grepProject(ctx.root, args.pattern, {
      regex: bool(args.regex), caseSensitive: bool(args.case_sensitive), pathPrefix: normPath(args.path), max, signal: ctx.signal
    });
    if (!results.length) return { output: 'Không có kết quả khớp.' };
    return { output: results.map(r => r.line ? `${r.path}:${r.line}: ${r.snippet}` : `${r.path}: (tên file khớp)`).join('\n') + (results.length >= max ? `\n… đạt giới hạn ${max} kết quả` : '') };
  }
};

/* ---------- write_file ---------- */
function readIfExists(root, rel) {
  const { dest } = workspace.resolveWriteTarget(root, rel);
  if (!fs.existsSync(dest)) return { dest, existing: null };
  const st = fs.lstatSync(dest);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Đích không phải file thường.');
  if (st.size > workspace.limits.MAX_TEXT_BYTES * 4) throw new Error('File quá lớn để sửa qua agent.');
  const buf = fs.readFileSync(dest);
  if (buf.includes(0)) throw new Error('File nhị phân, không thể sửa.');
  return { dest, existing: buf.toString('utf8') };
}
function finalizeNewContent(body, existing) {
  let content = String(body == null ? '' : body);
  const eol = existing ? eolOf(existing) : '\n';
  content = toLF(content);
  const endsNl = existing === null ? true : /\n$/.test(existing);
  if (endsNl && !content.endsWith('\n') && content !== '') content += '\n';
  return fromLF(content, eol);
}
const write_file = {
  name: 'write_file', kind: 'edit',
  description: 'Tạo file mới hoặc VIẾT ĐÈ toàn bộ file. Cần người dùng duyệt. Với thay đổi nhỏ hãy dùng edit_file.',
  usage: 'tool: write_file\npath: src/new.ts\n---\n<toàn bộ nội dung file, viết nguyên văn, không escape>',
  prepare(ctx, args) {
    const rel = needPath(args);
    if (typeof args.body !== 'string') throw new Error('Thiếu nội dung: đặt dòng "---" rồi nội dung file ngay bên dưới.');
    const { existing } = readIfExists(ctx.root, rel);
    const next = finalizeNewContent(args.body, existing);
    const d = unifiedDiff(existing === null ? '' : toLF(existing), toLF(next), { label: rel });
    if (existing !== null && !d.changed) throw new Error('Nội dung giống hệt file hiện tại, không có gì để ghi.');
    return { label: rel, summary: existing === null ? `Tạo file mới (${next.length} ký tự)` : `Ghi đè file (+${d.added} −${d.removed})`, diff: d.diff, created: existing === null };
  },
  async run(ctx, args) {
    const rel = needPath(args);
    const { existing } = readIfExists(ctx.root, rel);
    const next = finalizeNewContent(args.body, existing);
    const res = workspace.writeProjectFile(ctx.root, rel, next);
    const cp = ctx.checkpoints ? ctx.checkpoints.record(ctx.root, res.path, res.previous, next, { source: ctx.source || 'agent', note: 'write_file' }) : null;
    return { output: `OK: đã ${res.created ? 'tạo' : 'ghi đè'} ${res.path} (${res.size} bytes)${cp ? ` · checkpoint=${cp.id}` : ''}`, checkpoint: cp ? cp.id : null, path: res.path };
  }
};

/* ---------- edit_file ---------- */
function findExact(text, search) {
  const idxs = [];
  let at = text.indexOf(search);
  while (at !== -1) { idxs.push(at); at = text.indexOf(search, at + Math.max(1, search.length)); }
  return idxs;
}
function applyOne(text, edit, replaceAll) {
  const search = toLF(edit.search), replace = toLF(edit.replace);
  if (!search.trim()) throw new Error('Đoạn SEARCH rỗng. Dùng write_file để tạo file mới.');
  const exact = findExact(text, search);
  if (exact.length === 1 || (exact.length > 1 && replaceAll)) {
    let out = '', last = 0;
    for (const at of exact) { out += text.slice(last, at) + replace; last = at + search.length; }
    return { text: out + text.slice(last), count: exact.length };
  }
  if (exact.length > 1) throw new Error(`Đoạn SEARCH khớp ${exact.length} chỗ; hãy thêm ngữ cảnh để khớp duy nhất (hoặc đặt "replace_all: true").`);
  // Khớp "lỏng": bỏ khác biệt khoảng trắng cuối dòng và dòng trống đầu/cuối của khối SEARCH.
  const tl = text.split('\n');
  const norm = tl.map(l => l.replace(/\s+$/, ''));
  let sl = search.split('\n').map(l => l.replace(/\s+$/, ''));
  while (sl.length && sl[0] === '') sl.shift();
  while (sl.length && sl[sl.length - 1] === '') sl.pop();
  const starts = [];
  for (let i = 0; i + sl.length <= norm.length; i++) {
    let ok = true;
    for (let k = 0; k < sl.length; k++) if (norm[i + k] !== sl[k]) { ok = false; break; }
    if (ok) starts.push(i);
  }
  if (starts.length === 1 || (starts.length > 1 && replaceAll)) {
    let rl = replace.split('\n');
    while (rl.length && rl[rl.length - 1] === '' && replace.endsWith('\n')) rl.pop();
    let out = [], i = 0;
    const set = new Set(starts);
    while (i < tl.length) {
      if (set.has(i)) { out.push(...rl); i += sl.length; } else { out.push(tl[i]); i++; }
    }
    return { text: out.join('\n'), count: starts.length };
  }
  if (starts.length > 1) throw new Error(`Đoạn SEARCH khớp ${starts.length} chỗ (sau khi bỏ qua khoảng trắng cuối dòng); hãy thêm ngữ cảnh.`);
  const first = sl.find(l => l.trim()) || '';
  const hint = first.trim() ? ` Dòng đầu của SEARCH: "${first.trim().slice(0, 80)}". Hãy read_file lại để lấy đúng nội dung hiện tại.` : '';
  throw new Error('Không tìm thấy đoạn SEARCH trong file.' + hint);
}
function computeEdit(root, args) {
  const rel = needPath(args);
  if (!Array.isArray(args.edits) || !args.edits.length) {
    throw new Error('Thiếu khối <<<<<<< SEARCH / ======= / >>>>>>> REPLACE.');
  }
  const { existing } = readIfExists(root, rel);
  if (existing === null) throw new Error(`File "${rel}" không tồn tại. Dùng write_file để tạo mới.`);
  const eol = eolOf(existing);
  let text = toLF(existing);
  const replaceAll = bool(args.replace_all);
  let total = 0;
  args.edits.forEach((e, i) => {
    try { const r = applyOne(text, e, replaceAll); text = r.text; total += r.count; }
    catch (err) { throw new Error(`Chỉnh sửa #${i + 1}: ${err.message}`); }
  });
  const next = fromLF(text, eol);
  return { rel, existing, next, replaced: total };
}
const edit_file = {
  name: 'edit_file', kind: 'edit',
  description: 'Sửa file bằng một hoặc nhiều khối SEARCH/REPLACE (đoạn SEARCH phải khớp duy nhất trong file). Cần người dùng duyệt.',
  usage: 'tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nđoạn cũ nguyên văn\n=======\nđoạn mới\n>>>>>>> REPLACE\n(có thể lặp nhiều khối; thêm dòng "replace_all: true" ở header nếu muốn thay mọi chỗ khớp)',
  prepare(ctx, args) {
    const { rel, existing, next, replaced } = computeEdit(ctx.root, args);
    const d = unifiedDiff(toLF(existing), toLF(next), { label: rel });
    if (!d.changed) throw new Error('Sau khi áp dụng, nội dung không đổi.');
    return { label: rel, summary: `Sửa ${replaced} chỗ (+${d.added} −${d.removed})`, diff: d.diff };
  },
  async run(ctx, args) {
    const { rel, next } = computeEdit(ctx.root, args);
    const res = workspace.writeProjectFile(ctx.root, rel, next);
    const cp = ctx.checkpoints ? ctx.checkpoints.record(ctx.root, res.path, res.previous, next, { source: ctx.source || 'agent', note: 'edit_file' }) : null;
    return { output: `OK: đã sửa ${res.path}${cp ? ` · checkpoint=${cp.id}` : ''}`, checkpoint: cp ? cp.id : null, path: res.path };
  }
};

/* ---------- run_command ---------- */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}
const run_command = {
  name: 'run_command', kind: 'exec',
  description: 'Chạy một lệnh shell trong thư mục gốc dự án (ví dụ chạy test, build, git status). LUÔN cần người dùng duyệt. Giới hạn thời gian mặc định 60 giây.',
  usage: 'tool: run_command\ncommand: npm test\ntimeout_sec: 60     (tuỳ chọn, tối đa 300)',
  prepare(ctx, args) {
    const command = String(args.command || args.body || '').trim();
    if (!command) throw new Error('Thiếu tham số "command".');
    if (command.length > 1000) throw new Error('Lệnh quá dài.');
    return { label: command.slice(0, 200), summary: `Chạy lệnh trong ${path.basename(ctx.root)}` };
  },
  run(ctx, args) {
    const command = String(args.command || args.body || '').trim();
    const timeoutMs = int(args.timeout_sec, 60, 1, 300) * 1000;
    return new Promise(resolve => {
      let out = '', truncated = false, timedOut = false, settled = false;
      const child = spawn(command, { cwd: ctx.root, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: process.env });
      const add = d => {
        if (out.length >= CMD_MAX_OUTPUT) { truncated = true; return; }
        out += d.toString('utf8');
        if (out.length > CMD_MAX_OUTPUT) { out = out.slice(0, CMD_MAX_OUTPUT); truncated = true; }
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const onAbort = () => { timedOut = true; killTree(child); };
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      const done = (code, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
        const head = err ? `Không chạy được lệnh: ${err.message}` : timedOut ? `Lệnh bị dừng (hết ${timeoutMs / 1000}s hoặc bị huỷ).` : `Exit code: ${code}`;
        resolve({ output: `${head}\n${out || '(không có output)'}${truncated ? '\n… [output bị cắt]' : ''}`, exitCode: code, ok: !err && !timedOut && code === 0 });
      };
      child.on('error', err => done(null, err));
      child.on('close', code => done(code));
    });
  }
};

/* ---------- control ---------- */
const finish = {
  name: 'finish', kind: 'control',
  description: 'Báo hoàn thành nhiệm vụ và tóm tắt những gì đã làm (file đã đổi, cách kiểm tra).',
  usage: 'tool: finish\n---\n<tóm tắt>',
  prepare(ctx, args) { return { label: 'finish' }; },
  async run(ctx, args) { return { output: String(args.summary || args.body || '').trim() || 'Hoàn thành.' }; }
};
const ask_user = {
  name: 'ask_user', kind: 'control',
  description: 'Hỏi người dùng khi thiếu thông tin quan trọng; vòng lặp tạm dừng cho tới khi họ trả lời.',
  usage: 'tool: ask_user\nquestion: Bạn muốn dùng thư viện nào?',
  prepare(ctx, args) { return { label: 'ask_user' }; },
  async run(ctx, args) { return { output: String(args.question || args.body || '').trim() }; }
};

const TOOLS = { read_file, list_dir, grep, write_file, edit_file, run_command, finish, ask_user };
const specs = () => Object.values(TOOLS).map(t => ({ name: t.name, description: t.description, usage: t.usage }));

module.exports = { TOOLS, specs, bool, computeEdit, unifiedDiff };
