'use strict';
/**
 * Git tích hợp (Giai đoạn 3, mục 4): xem status/diff, tạo commit CÓ CHỦ ĐÍCH.
 *
 * An toàn:
 *  - Chỉ chạy `git` bằng execFile với danh sách tham số cố định (không shell, không ghép chuỗi lệnh).
 *  - Các lệnh ĐỌC được làm cứng chống cấu hình độc trong repo lạ: `-c core.fsmonitor=false` (fsmonitor là một lệnh chạy khi
 *    `git status`), `--no-ext-diff --no-textconv` cho diff, không mở pager, không hỏi mật khẩu, GIT_OPTIONAL_LOCKS=0.
 *  - Không bao giờ: push, pull, fetch, reset, checkout, clean, rebase, merge, `add -A`, `--no-verify`.
 *  - Commit chỉ gồm các đường dẫn được liệt kê TƯỜNG MINH, phải có trong `git status` hiện tại, nằm trong project, không phải
 *    file nhạy cảm/bị chặn và không đi qua symlink ra ngoài. Dùng `git commit -- <paths>` nên KHÔNG kéo theo file khác đang staged.
 *  - Mặc định TẮT git hook của repo (hook là mã chạy tuỳ ý, có thể đến từ cấu hình repo lạ); người dùng phải bật rõ ràng.
 *  - Việc commit luôn cần người dùng duyệt (nút trong Studio, hoặc thẻ duyệt `run_command`-cấp cho tool git_commit của agent).
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workspace = require('./workspace.cjs');
const { unifiedDiff } = require('./diff.cjs');

const READ_TIMEOUT_MS = 20_000;
const COMMIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 60_000;
const MAX_FILES = 500;
const MAX_COMMIT_PATHS = 200;
const MAX_MESSAGE = 4000;

// Luôn áp dụng cho MỌI lệnh git: tắt cơ chế cấu hình repo có thể chạy lệnh ngoài.
const HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'protocol.ext.allow=never'];

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' };
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

function run(root, args, { timeout = READ_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...HARDEN, ...args], { cwd: root, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, env: env || gitEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('Không tìm thấy lệnh `git` trên máy. Hãy cài Git (git-scm.com) rồi mở lại Studio.'));
      if (err && err.killed) return reject(new Error('Lệnh git quá thời gian cho phép và đã bị dừng.'));
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
    });
  });
}

const CODE_LABEL = { M: 'sửa', A: 'thêm', D: 'xoá', R: 'đổi tên', C: 'sao chép', T: 'đổi kiểu', U: 'xung đột' };

/** Đường dẫn bị chặn vì nhạy cảm/không an toàn (cùng luật với workspace). */
function isBlockedPath(root, rel) {
  try { workspace.resolveWriteTarget(root, rel); return false; } catch { return true; }
}

/** Parse đầu ra `git status --porcelain=v1 -z -b`. Thuần hàm để test. */
function parseStatus(raw, prefix = '') {
  const recs = String(raw || '').split('\0');
  const out = { branch: '', detached: false, ahead: 0, behind: 0, noCommits: false, files: [], outside: 0 };
  const pre = prefix ? prefix.replace(/\\/g, '/') : '';
  const strip = p => (pre ? (p.startsWith(pre) ? p.slice(pre.length) : null) : p);
  let i = 0;
  while (i < recs.length) {
    const rec = recs[i++];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const b = rec.slice(3);
      if (/^No commits yet on /.test(b)) { out.noCommits = true; out.branch = b.replace(/^No commits yet on /, ''); }
      else if (/^HEAD \(no branch\)/.test(b)) { out.detached = true; out.branch = 'HEAD (không thuộc nhánh nào)'; }
      else {
        out.branch = b.split('...')[0].split(' ')[0];
        const a = /ahead (\d+)/.exec(b), bh = /behind (\d+)/.exec(b);
        out.ahead = a ? parseInt(a[1], 10) : 0;
        out.behind = bh ? parseInt(bh[1], 10) : 0;
      }
      continue;
    }
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const full = rec.slice(3);
    let orig = null;
    if (/[RC]/.test(xy)) orig = recs[i++] || null;
    const p = strip(full);
    if (p === null) { out.outside++; continue; }
    const origRel = orig === null ? null : strip(orig);
    if (out.files.length >= MAX_FILES) { out.truncated = true; continue; }
    const untracked = xy === '??';
    const conflict = xy === 'DD' || xy === 'AU' || xy === 'UD' || xy === 'UA' || xy === 'DU' || xy === 'AA' || xy === 'UU';
    const code = untracked ? '??' : (xy[0] !== ' ' && xy[0] !== '?' ? xy[0] : xy[1]);
    out.files.push({
      path: p, origPath: origRel, xy, untracked, conflict,
      staged: !untracked && xy[0] !== ' ' && xy[0] !== '?',
      unstaged: !untracked && xy[1] !== ' ' && xy[1] !== '?',
      label: untracked ? 'mới (chưa theo dõi)' : conflict ? 'xung đột' : (CODE_LABEL[code] || code)
    });
  }
  return out;
}

async function repoInfo(root) {
  const inside = await run(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const pre = await run(root, ['rev-parse', '--show-prefix']);
  return { prefix: pre.code === 0 ? pre.stdout.trim() : '' };
}

/** Trạng thái kho: { repo:false } nếu không phải kho git. */
async function status(root) {
  const info = await repoInfo(root);
  if (!info) return { repo: false, files: [], reason: 'Thư mục dự án không nằm trong một kho git.' };
  const r = await run(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
  if (r.code !== 0) throw new Error(`git status lỗi: ${r.stderr.trim() || 'không rõ'}`);
  const s = parseStatus(r.stdout, info.prefix);
  s.files = s.files.map(f => ({ ...f, blocked: isBlockedPath(root, f.path) }));
  return { repo: true, prefix: info.prefix, ...s };
}

function clipDiff(text) {
  return text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) + `\n… [đã cắt ${text.length - MAX_DIFF_CHARS} ký tự]` : text;
}

/** Diff của một file (hoặc toàn bộ nếu không có path). File mới chưa theo dõi: dựng diff "từ rỗng". */
async function diff(root, { path: rel = '', staged = false } = {}) {
  const info = await repoInfo(root);
  if (!info) throw new Error('Thư mục dự án không nằm trong một kho git.');
  const relPath = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (relPath) {
    if (isBlockedPath(root, relPath)) throw new Error('Đường dẫn này bị chặn vì lý do riêng tư/an toàn.');
    const st = await status(root);
    const f = st.files.find(x => x.path === relPath);
    if (f && f.untracked) {
      const { content } = workspace.readProjectFile(root, relPath);
      const d = unifiedDiff('', content.replace(/\r\n/g, '\n'), { label: relPath });
      return { path: relPath, untracked: true, diff: clipDiff(d.diff) };
    }
  }
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), ...(relPath ? ['--', relPath] : [])];
  const r = await run(root, args);
  if (r.code !== 0) throw new Error(`git diff lỗi: ${r.stderr.trim() || 'không rõ'}`);
  return { path: relPath, untracked: false, diff: clipDiff(r.stdout) };
}

/** Kiểm tra yêu cầu commit và trả về danh sách đường dẫn chính xác sẽ được commit. KHÔNG có tác dụng phụ. */
async function planCommit(root, { message, paths }) {
  const msg = String(message == null ? '' : message).replace(/\r\n/g, '\n').trim();
  if (!msg) throw new Error('Thiếu thông điệp commit.');
  if (msg.length > MAX_MESSAGE) throw new Error(`Thông điệp commit quá dài (tối đa ${MAX_MESSAGE} ký tự).`);
  if (msg.includes('\0')) throw new Error('Thông điệp commit không hợp lệ.');
  if (!Array.isArray(paths) || !paths.length) throw new Error('Hãy chọn ít nhất một file để commit (liệt kê tường minh từng đường dẫn).');
  if (paths.length > MAX_COMMIT_PATHS) throw new Error(`Tối đa ${MAX_COMMIT_PATHS} file mỗi commit.`);
  const st = await status(root);
  if (!st.repo) throw new Error(st.reason);
  const byPath = new Map(st.files.map(f => [f.path, f]));
  const chosen = [];       // đường dẫn đưa vào `git commit -- ...` (gồm cả phía cũ của đổi tên)
  const addPaths = [];     // chỉ những file còn thay đổi CHƯA staged/chưa theo dõi mới cần `git add` (đã staged hoàn toàn thì add sẽ lỗi pathspec)
  const seen = new Set();
  for (const raw of paths) {
    const p = String(raw == null ? '' : raw).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p || p.includes('\0')) throw new Error('Đường dẫn trống hoặc không hợp lệ.');
    const f = byPath.get(p);
    if (!f) throw new Error(`"${p}" không có thay đổi nào trong git status (hoặc nằm ngoài project).`);
    if (f.blocked) throw new Error(`"${p}" bị chặn vì lý do riêng tư/an toàn (file nhạy cảm hoặc đi qua symlink) nên không được commit qua Studio.`);
    if (f.conflict) throw new Error(`"${p}" đang xung đột; hãy giải quyết xung đột trước.`);
    for (const q of [p, f.origPath]) if (q && !seen.has(q)) { seen.add(q); chosen.push(q); }
    if ((f.untracked || f.unstaged) && !addPaths.includes(p)) addPaths.push(p);
  }
  return { message: msg, paths: chosen, addPaths, files: paths.map(p => byPath.get(String(p).trim().replace(/\\/g, '/').replace(/^\.\//, ''))), branch: st.branch, detached: st.detached };
}

let emptyHooksDir = null;
function noHooksDir() {
  if (!emptyHooksDir) {
    emptyHooksDir = path.join(os.tmpdir(), 'gps-empty-hooks');
    try { fs.mkdirSync(emptyHooksDir, { recursive: true }); } catch { /* dùng tạm đường dẫn này; git bỏ qua nếu không tồn tại */ }
  }
  return emptyHooksDir;
}

/**
 * Tạo commit. Người gọi PHẢI đã có sự duyệt của người dùng. Không push. Hook mặc định tắt (hooks=true để bật).
 * @returns {{ ok:boolean, hash:string, summary:string, output:string, files:number }}
 */
async function commit(root, { message, paths, hooks = false }) {
  const plan = await planCommit(root, { message, paths });
  if (plan.addPaths.length) {
    const add = await run(root, ['add', '--', ...plan.addPaths], { timeout: COMMIT_TIMEOUT_MS });
    if (add.code !== 0) throw new Error(`git add lỗi: ${add.stderr.trim() || add.stdout.trim() || 'không rõ'}`);
  }
  const hookArgs = hooks ? [] : ['-c', `core.hooksPath=${noHooksDir()}`];
  const c = await run(root, [...hookArgs, 'commit', '-m', plan.message, '--', ...plan.paths], { timeout: COMMIT_TIMEOUT_MS });
  const output = (c.stdout + (c.stderr ? '\n' + c.stderr : '')).trim();
  if (c.code !== 0) throw new Error(`git commit lỗi (exit ${c.code}): ${output || 'không rõ'}`);
  const head = await run(root, ['rev-parse', '--short', 'HEAD']);
  workspace.clearScanCache();
  return { ok: true, hash: head.code === 0 ? head.stdout.trim() : '', summary: plan.message.split('\n')[0].slice(0, 120), output: output.slice(0, 4000), files: plan.paths.length };
}

module.exports = { status, diff, planCommit, commit, parseStatus, isBlockedPath, HARDEN, MAX_COMMIT_PATHS, MAX_MESSAGE };
