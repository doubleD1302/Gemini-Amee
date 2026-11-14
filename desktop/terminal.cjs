'use strict';
/**
 * Terminal tương tác có duyệt (Giai đoạn 3, mục 6): tiến trình chạy lâu (dev server, watcher, REPL...) với log xem trực tiếp,
 * gửi input và dừng được.
 *
 * An toàn:
 *  - Agent KHÔNG tự tạo tiến trình: tool process_start / process_send là kind 'exec' ⇒ luôn qua thẻ duyệt, như run_command
 *    (không có chế độ tự duyệt). Người dùng tự bấm trong giao diện Terminal = chính người dùng là bên duyệt.
 *  - Chỉ điều khiển các tiến trình do chính manager này tạo (id nội bộ); không có API "kill pid bất kỳ".
 *  - Giới hạn: tối đa 4 tiến trình đang chạy, lệnh ≤1000 ký tự, log vòng ≤200KB/tiến trình, input ≤4000 ký tự/lần.
 *  - Thư mục làm việc = gốc project; dừng toàn bộ khi đổi project hoặc thoát ứng dụng (không để tiến trình mồ côi).
 *  - Log là DỮ LIỆU không tin cậy khi đưa lại cho model (formatToolResults đã rào + gắn nhãn).
 */
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MAX_RUNNING = 4;
const MAX_COMMAND = 1000;
const MAX_LOG_CHARS = 200_000;
const MAX_INPUT = 4000;
const MAX_KEPT = 12;       // số tiến trình (kể cả đã kết thúc) giữ trong danh sách

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

let seq = 0;

class TerminalManager extends EventEmitter {
  /** @param opts { spawnFn } để test ghi đè */
  constructor(opts = {}) {
    super();
    this.spawnFn = opts.spawnFn || spawn;
    this.procs = new Map();
    this._timer = null;
    this._disposed = false;
  }

  _notify() {
    if (this._timer || this._disposed) return;
    this._timer = setTimeout(() => { this._timer = null; this.emit('update', this.list()); }, 150);
    if (this._timer.unref) this._timer.unref();
  }

  /** Bắt đầu một tiến trình. Người gọi PHẢI đã có sự duyệt (thẻ duyệt của agent, hoặc người dùng bấm trong UI). */
  start(root, command, { name = '', source = 'user' } = {}) {
    const cmd = String(command == null ? '' : command).trim();
    if (!cmd) throw new Error('Thiếu lệnh.');
    if (cmd.length > MAX_COMMAND) throw new Error('Lệnh quá dài.');
    if (!root) throw new Error('Hãy mở thư mục dự án trước.');
    if ([...this.procs.values()].filter(p => p.status === 'running').length >= MAX_RUNNING) throw new Error(`Tối đa ${MAX_RUNNING} tiến trình chạy cùng lúc. Hãy dừng bớt một tiến trình.`);
    const id = `p${++seq}`;
    const child = this.spawnFn(cmd, { cwd: root, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const p = {
      id, name: String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || cmd.slice(0, 40), command: cmd, source, root,
      status: 'running', exitCode: null, startedAt: Date.now(), endedAt: 0,
      log: '', dropped: 0, total: 0, child, stopping: false
    };
    this.procs.set(id, p);
    const add = chunk => {
      const s = chunk.toString('utf8');
      p.total += s.length;
      p.log += s;
      if (p.log.length > MAX_LOG_CHARS) { const over = p.log.length - MAX_LOG_CHARS; p.log = p.log.slice(over); p.dropped += over; }
      this._notify();
    };
    if (child.stdout) child.stdout.on('data', add);
    if (child.stderr) child.stderr.on('data', add);
    if (child.stdin) child.stdin.on('error', () => { /* tiến trình đã đóng stdin */ });
    child.on('error', err => { add(`\n[không chạy được: ${err.message}]\n`); this._finish(p, null); });
    child.on('close', code => this._finish(p, code));
    // Giữ danh sách gọn: bỏ các tiến trình đã kết thúc cũ nhất.
    const done = [...this.procs.values()].filter(x => x.status !== 'running');
    for (const old of done.slice(0, Math.max(0, this.procs.size - MAX_KEPT))) this.procs.delete(old.id);
    this._notify();
    return this._pub(p);
  }

  _finish(p, code) {
    if (p.status !== 'running') return;
    p.status = p.stopping ? 'stopped' : 'exited';
    p.exitCode = code;
    p.endedAt = Date.now();
    this._notify();
  }

  _get(id) {
    const p = this.procs.get(String(id));
    if (!p) throw new Error(`Không có tiến trình "${id}" (có thể đã bị dọn khỏi danh sách).`);
    return p;
  }

  _pub(p) {
    return { id: p.id, name: p.name, command: p.command, source: p.source, status: p.status, exitCode: p.exitCode, startedAt: p.startedAt, endedAt: p.endedAt, total: p.total, dropped: p.dropped };
  }

  list() { return [...this.procs.values()].map(p => this._pub(p)); }

  /** Đọc log: `since` = vị trí tuyệt đối (số ký tự đã nhận) để lấy phần mới; không có since → đuôi `tail` ký tự. */
  read(id, { since = null, tail = 4000 } = {}) {
    const p = this._get(id);
    const t = Math.max(100, Math.min(20_000, Math.floor(Number(tail)) || 4000));
    const startAbs = p.total - p.log.length;      // vị trí tuyệt đối của ký tự đầu tiên còn giữ
    let from;
    if (since === null || since === undefined || !Number.isFinite(Number(since))) from = Math.max(startAbs, p.total - t);
    else from = Math.max(startAbs, Math.min(p.total, Number(since)));
    if (p.total - from > t) from = p.total - t;
    const lost = since !== null && since !== undefined && Number.isFinite(Number(since)) && Number(since) < from;   // một phần log giữa `since` và `from` đã bị bỏ
    return { ...this._pub(p), text: p.log.slice(from - startAbs), from, to: p.total, lost };
  }

  /** Gửi input vào stdin (người gọi phải đã có sự duyệt). `newline` mặc định thêm xuống dòng. */
  send(id, input, { newline = true } = {}) {
    const p = this._get(id);
    if (p.status !== 'running') throw new Error(`Tiến trình ${id} đã kết thúc.`);
    const s = String(input == null ? '' : input);
    if (s.length > MAX_INPUT) throw new Error(`Input quá dài (tối đa ${MAX_INPUT} ký tự).`);
    if (s.includes('\0')) throw new Error('Input không hợp lệ.');
    if (!p.child.stdin || p.child.stdin.destroyed || !p.child.stdin.writable) throw new Error('Tiến trình không nhận input (stdin đã đóng).');
    p.child.stdin.write(s + (newline ? '\n' : ''));
    return { id: p.id, sent: s.length };
  }

  stop(id) {
    const p = this._get(id);
    if (p.status === 'running') { p.stopping = true; killTree(p.child); }
    return this._pub(p);
  }

  /** Chờ tới khi có log mới, tiến trình kết thúc, hoặc hết `ms`. Dùng cho process_start (xem đầu ra ban đầu). */
  waitForOutput(id, ms) {
    const p = this._get(id);
    const start = p.total;
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => {
        if (p.status !== 'running' || p.total > start && Date.now() - t0 > 400 || Date.now() - t0 >= ms) return resolve();
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  stopAll() { for (const p of this.procs.values()) if (p.status === 'running') { p.stopping = true; killTree(p.child); } }

  dispose() {
    this._disposed = true;
    clearTimeout(this._timer);
    this.stopAll();
  }
}

module.exports = { TerminalManager, killTree, MAX_RUNNING, MAX_COMMAND, MAX_LOG_CHARS, MAX_INPUT };
