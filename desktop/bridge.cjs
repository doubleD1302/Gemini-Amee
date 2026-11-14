'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const VERSION = '0.2.0';   // phải khớp package.json (có test)
// Số giao thức giữa Studio ↔ extension; tăng khi hợp đồng đổi (2: có tệp đính kèm trong job). Extension gửi kèm header mỗi lần gọi.
const PROTOCOL = 2;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,24}$/;
const DEFAULT_PORT = 47821;
const TERMINAL = new Set(['final', 'error', 'cancelled']);

/** Token + cổng được lưu lại để không phải ghép nối extension lại mỗi lần mở app. */
function loadOrCreateState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^[0-9a-f]{64}$/i.test(s.token) && Number.isInteger(s.port) && s.port > 1024 && s.port < 65536) return s;
  } catch { /* tạo mới */ }
  const state = { token: crypto.randomBytes(32).toString('hex'), port: DEFAULT_PORT };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  } catch { /* không lưu được thì vẫn chạy, chỉ phải ghép nối lại lần sau */ }
  return state;
}

class Bridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.token = opts.token || crypto.randomBytes(32).toString('hex');
    this.preferredPort = opts.port === undefined ? 0 : opts.port;
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 45_000;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 240_000;     // đã gửi, chưa có chữ nào (Gemini đang suy nghĩ)
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? 120_000; // đang stream mà đứng im
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.jobs = [];
    this.nextId = 1;
    this.lastSeen = 0;
    this.port = null;
    this.server = null;
    this.timer = null;
    this.extension = null;   // { version, protocol, seenAt } lần gần nhất extension tự báo; null = chưa thấy lần nào
    this.onProposeWrite = null;
    this.onGetWorkspace = null;
  }
  async start() {
    if (this.server) return;
    const listen = port => new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
    });
    try {
      this.server = await listen(this.preferredPort);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE' && this.preferredPort !== 0) {
        this.portFallback = true; // cổng cố định đang bận → dùng cổng ngẫu nhiên (phải ghép nối lại)
        this.server = await listen(0);
      } else throw err;
    }
    this.port = this.server.address().port;
    this.timer = setInterval(() => this.sweep(), 5000);
    if (this.timer.unref) this.timer.unref();
  }
  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.server) return;
    await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
  /** So khớp phiên bản/giao thức extension: 'unknown' (chưa thấy), 'ok', 'outdated' (extension cũ), 'newer' (Studio cũ hơn extension). */
  extensionStatus() {
    if (!this.extension) return { status: 'unknown', version: '', protocol: 0 };
    const { version, protocol } = this.extension;
    return { status: protocol === PROTOCOL ? 'ok' : protocol < PROTOCOL ? 'outdated' : 'newer', version, protocol };
  }
  noteExtension(headers) {
    const v = String(headers['x-gps-extension-version'] || '');
    const p = parseInt(String(headers['x-gps-protocol'] || ''), 10);
    this.extension = { version: VERSION_RE.test(v) ? v : '', protocol: Number.isInteger(p) && p > 0 && p < 1000 ? p : 0, seenAt: Date.now() };
  }
  info() { return { url: `http://127.0.0.1:${this.port}`, connected: Date.now() - this.lastSeen < 12000, token: this.token, appVersion: VERSION, protocol: PROTOCOL, extension: this.extensionStatus() }; }

  // Không bao giờ phát dữ liệu ảnh (base64) ra ngoài bridge/giao diện: chỉ số lượng.
  publicJob(job) { return { ...job, prompt: undefined, attachments: undefined, attachmentCount: (job.attachments || []).length }; }

  enqueue(question, prompt, included, opts = {}) {
    const job = {
      id: String(this.nextId++), question, prompt, included: included || [], status: 'queued', answer: '', updatedAt: Date.now(),
      kind: opts.kind || 'chat', newChat: !!opts.newChat, expectConversation: opts.expectConversation || null,
      conversationUrl: opts.expectConversation || null, attempts: 0, dispatchedAt: 0, code: '',
      session: typeof opts.session === 'string' ? opts.session.slice(0, 16) : '', navigate: !!opts.navigate, navigations: 0,
      attachments: Array.isArray(opts.attachments) ? opts.attachments.slice(0, 3) : []   // ảnh {name,mime,data(base64)} đã được attachments.cjs kiểm tra
    };
    this.jobs.push(job);
    while (this.jobs.length > 60) {
      const idx = this.jobs.findIndex(j => TERMINAL.has(j.status));
      this.jobs.splice(idx === -1 ? 0 : idx, 1);
    }
    this.emit('job', this.publicJob(job));
    return { id: job.id, question, included: job.included, status: job.status };
  }
  getJob(id) { return this.jobs.find(j => j.id === String(id)); }
  getPrompt(id) { const j = this.getJob(id); return j ? j.prompt : null; }

  setJob(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.emit('job', this.publicJob(job));
  }
  cancel(id) {
    const job = this.getJob(id);
    if (!job || TERMINAL.has(job.status)) return false;
    this.setJob(job, { status: 'cancelled', answer: job.answer || '', code: 'cancelled' });
    return true;
  }
  /** Đưa job về hàng đợi với prompt mới (dùng khi tab Gemini lệch cuộc trò chuyện). */
  requeue(id, { prompt, newChat, expectConversation = null, attachments }) {
    const job = this.getJob(id);
    if (!job) return false;
    this.setJob(job, { status: 'queued', prompt, newChat: !!newChat, expectConversation, conversationUrl: expectConversation, attempts: 0, code: '', answer: '', ...(attachments !== undefined ? { attachments } : {}) });
    return true;
  }
  /** Dán câu trả lời thủ công (không cần extension). Đi qua cùng luồng sự kiện nên vòng lặp agent vẫn chạy tiếp. */
  completeManually(id, text) {
    const job = this.getJob(id);
    if (!job) throw new Error('Conversation not found');
    if (job.status === 'final') return false;
    this.setJob(job, { status: 'final', answer: String(text).slice(0, 200_000), code: '' });
    return true;
  }
  /** Job kẹt → xếp hàng lại hoặc báo lỗi thay vì treo vĩnh viễn. */
  sweep(now = Date.now()) {
    for (const job of this.jobs) {
      if (job.status === 'dispatched' && now - job.dispatchedAt > this.dispatchTimeoutMs) {
        if (job.attempts < this.maxAttempts) this.setJob(job, { status: 'queued' });
        else this.setJob(job, { status: 'error', code: 'timeout', answer: 'Extension nhận việc nhưng không phản hồi. Kiểm tra tab Gemini rồi thử lại.' });
      } else if (job.status === 'sent' && now - job.updatedAt > this.waitTimeoutMs) {
        this.setJob(job, { status: 'error', code: 'timeout', answer: 'Gemini không trả lời trong thời gian cho phép.' });
      } else if (job.status === 'streaming' && now - job.updatedAt > this.streamIdleTimeoutMs) {
        // Giữ lại phần đã stream được để không mất công.
        this.setJob(job, { status: 'error', code: 'timeout', answer: job.answer || 'Phản hồi của Gemini bị đứng giữa chừng.' });
      }
    }
  }

  json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  async body(req) {
    let parts = [], length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 350_000) throw new Error('Payload too large');
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  async handle(req, res) {
    try {
      const given = String(req.headers.authorization || '');
      const want = `Bearer ${this.token}`;
      const ok = given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
      if (!ok) return this.json(res, 401, { error: 'Invalid bridge token' });
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      // Extension tự khai phiên bản/giao thức; extension cũ không gửi header → protocol 0 → 'outdated'.
      if (route === '/v1/health' || route === '/v1/next' || req.headers['x-gps-extension-version']) this.noteExtension(req.headers);
      if (req.method === 'GET' && route === '/v1/health') {
        this.lastSeen = Date.now();
        return this.json(res, 200, { ok: true, app: 'Gemini Project Studio', version: VERSION, protocol: PROTOCOL });
      }
      if (req.method === 'GET' && route === '/v1/next') {
        this.lastSeen = Date.now();
        this.sweep();
        this.emit('heartbeat');
        const job = this.jobs.find(j => j.status === 'queued');
        if (!job) return this.json(res, 200, { job: null });
        job.attempts++;
        job.dispatchedAt = Date.now();
        this.setJob(job, { status: 'dispatched' });
        return this.json(res, 200, { job: { id: job.id, prompt: job.prompt, newChat: job.newChat, expectConversation: job.expectConversation, attachments: job.attachments, sessionId: job.session, navigate: job.navigate } });
      }
      if (req.method === 'POST' && route === '/v1/result') {
        const body = await this.body(req);
        const job = this.getJob(body.id);
        if (!job) return this.json(res, 404, { error: 'Job not found' });
        if (!['sent', 'streaming', 'final', 'error'].includes(body.status)) return this.json(res, 400, { error: 'Bad status' });
        if (typeof body.text !== 'string') return this.json(res, 400, { error: 'Text must be a string' });
        // Extension phải chuyển sang đúng cuộc trò chuyện của phiên này (nhiều phiên song song): xếp hàng lại, tối đa 3 lần.
        if (body.status === 'error' && body.code === 'navigating' && job.status !== 'cancelled' && job.navigations < 3) {
          this.setJob(job, { status: 'queued', navigations: job.navigations + 1, attempts: 0, code: '' });
          return this.json(res, 200, { ok: true, requeued: true });
        }
        // Job đã huỷ: báo cho extension dừng chờ.
        if (job.status === 'cancelled') return this.json(res, 200, { ok: true, cancelled: true });
        // Cập nhật muộn/trùng không được ghi đè câu trả lời đã hoàn tất.
        if (job.status === 'final') return this.json(res, 200, { ok: true, duplicate: true });
        const patch = { status: body.status, answer: body.text.slice(0, 200_000), code: typeof body.code === 'string' ? body.code.slice(0, 40) : '' };
        if (typeof body.conversationUrl === 'string' && /^https:\/\/gemini\.google\.com\//.test(body.conversationUrl)) patch.conversationUrl = body.conversationUrl.slice(0, 300);
        this.setJob(job, patch);
        return this.json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/v1/write-file') {
        // Trình duyệt chỉ được ĐỀ XUẤT; việc ghi thật phải được duyệt trong Studio.
        const body = await this.body(req);
        if (!body.path || typeof body.content !== 'string') return this.json(res, 400, { error: 'path and content are required' });
        if (!this.onProposeWrite) return this.json(res, 503, { error: 'No workspace active in Gemini Project Studio' });
        try {
          const result = await this.onProposeWrite(String(body.path), body.content);
          return this.json(res, 200, { ok: true, pending: true, result });
        } catch (err) {
          return this.json(res, 400, { error: err.message || String(err) });
        }
      }
      if (req.method === 'GET' && route === '/v1/workspace') {
        this.lastSeen = Date.now();
        const ws = this.onGetWorkspace ? await this.onGetWorkspace() : null;
        return this.json(res, 200, { ok: true, workspace: ws });
      }
      return this.json(res, 404, { error: 'Unknown endpoint' });
    } catch (error) {
      return this.json(res, 400, { error: String(error.message || error) });
    }
  }
}
module.exports = { Bridge, loadOrCreateState, VERSION, PROTOCOL, DEFAULT_PORT };
