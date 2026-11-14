'use strict';
/**
 * Lưu bền phiên Agent theo project, NGOÀI thư mục project (userData của Electron) — giống checkpoint.
 * Chỉ lưu thứ an toàn để khôi phục: mục tiêu, timeline, nhật ký, sổ tiến độ, số liệu ngữ cảnh.
 * KHÔNG lưu và KHÔNG khôi phục: yêu cầu duyệt đang chờ (chỉ ghi lại để báo "hết hạn"), chính sách tự duyệt,
 * system prompt, bất kỳ thứ gì có thể tự thực thi.
 * File có thể bị sửa/hỏng: mọi thứ đọc lên đều được kiểm tra kiểu và cắt độ dài.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { clip } = require('./agent-protocol.cjs');
const { diffExtras } = require('./diff.cjs');

const VERSION = 1;
const MAX_STEPS = 400;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const STEP_TYPES = new Set(['info', 'user', 'assistant', 'tool', 'error']);
const STEP_STATUS = new Set(['running', 'waiting_approval', 'done', 'failed', 'rejected', 'error', 'expired', 'interrupted']);

const str = (v, max) => (typeof v === 'string' ? clip(v, max) : '');
const num = v => (Number.isFinite(v) ? v : 0);

function sanitizeStep(s) {
  if (!s || typeof s !== 'object' || !STEP_TYPES.has(s.type)) return null;
  const out = { id: str(s.id, 80) || `s_${Math.random().toString(36).slice(2)}`, at: num(s.at), type: s.type };
  if (s.text !== undefined) out.text = str(s.text, 8000);
  if (s.tool !== undefined) out.tool = str(s.tool, 40);
  if (s.label !== undefined) out.label = str(s.label, 400);
  if (s.summary !== undefined) out.summary = str(s.summary, 600);
  if (s.diff !== undefined) {
    out.diff = str(s.diff, 8000);
    if (out.diff) Object.assign(out, diffExtras(out.diff)); // view cạnh nhau + dòng đầu tiên được dựng lại từ diff, không tin dữ liệu lưu
  }
  if (s.output !== undefined) out.output = str(s.output, 3000);
  if (typeof s.status === 'string' && STEP_STATUS.has(s.status)) out.status = s.status;
  if (typeof s.checkpoint === 'string') out.checkpoint = str(s.checkpoint, 80);
  return out;
}

/** Chuẩn hoá dữ liệu đọc từ đĩa; trả null nếu không dùng được. */
function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return null;
  const run = raw.run;
  if (!run || typeof run.id !== 'string' || !run.id || typeof run.goal !== 'string' || !run.goal.trim()) return null;
  const arr = v => (Array.isArray(v) ? v : []);
  const strs = (v, n, max) => arr(v).filter(x => typeof x === 'string').slice(-n).map(x => clip(x, max));
  const ledger = raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {};
  return {
    version: VERSION,
    savedAt: num(raw.savedAt),
    root: str(raw.root, 1000),
    run: {
      id: str(run.id, 80), goal: str(run.goal, 4000), status: str(run.status, 30) || 'waiting_user', turn: Math.max(0, Math.floor(num(run.turn))),
      conversationUrl: typeof run.conversationUrl === 'string' ? str(run.conversationUrl, 300) : null,
      error: str(run.error, 1000), question: str(run.question, 2000)
    },
    steps: arr(raw.steps).slice(-MAX_STEPS).map(sanitizeStep).filter(Boolean),
    digest: strs(raw.digest, 80, 300),
    meter: {
      chars: Math.max(0, num(raw.meter && raw.meter.chars)), turns: Math.max(0, num(raw.meter && raw.meter.turns)),
      chatIndex: Math.max(0, Math.floor(num(raw.meter && raw.meter.chatIndex))), rotations: Math.max(0, Math.floor(num(raw.meter && raw.meter.rotations)))
    },
    ledger: {
      changed: arr(ledger.changed).filter(e => Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object').slice(-40)
        .map(([p, e]) => [clip(p, 400), { created: !!e.created, ops: Object.fromEntries(Object.entries(e.ops && typeof e.ops === 'object' ? e.ops : {}).filter(([, n]) => Number.isFinite(n)).slice(0, 6)) }]),
      read: strs(ledger.read, 30, 400),
      commands: arr(ledger.commands).filter(c => c && typeof c.cmd === 'string').slice(-10).map(c => ({ cmd: clip(c.cmd, 300), ok: !!c.ok, exit: Number.isFinite(c.exit) ? c.exit : null })),
      failures: arr(ledger.failures).filter(e => Array.isArray(e) && typeof e[0] === 'string').slice(-10).map(([c, t]) => [clip(c, 300), str(t, 600)]),
      rejected: strs(ledger.rejected, 6, 400),
      userMessages: strs(ledger.userMessages, 4, 300),
      lastNote: str(ledger.lastNote, 900)
    },
    expiredApprovals: arr(raw.expiredApprovals).filter(e => e && typeof e === 'object').slice(0, 20)
      .map(e => ({ tool: str(e.tool, 40), label: str(e.label, 300), summary: str(e.summary, 300), source: e.source === 'vibe' ? 'vibe' : 'agent' }))
  };
}

class SessionStore {
  constructor(dir) { this.dir = dir; }
  _file(root) {
    const key = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 16);
    return path.join(this.dir, key, 'session.json');
  }
  /** Ghi nguyên tử (tmp + rename). */
  save(root, data) {
    const file = this._file(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const json = JSON.stringify({ ...data, version: VERSION, root: String(root) });
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) throw new Error('Phiên quá lớn để lưu.');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
  }
  load(root) {
    try {
      const file = this._file(root);
      if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
      const s = sanitizeSession(JSON.parse(fs.readFileSync(file, 'utf8')));
      return s && (!s.root || s.root === String(root)) ? s : null;
    } catch { return null; }
  }
  clear(root) {
    try { fs.rmSync(path.dirname(this._file(root)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { SessionStore, sanitizeSession, VERSION };
