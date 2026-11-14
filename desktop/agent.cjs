'use strict';
/**
 * Vòng lặp agent: gửi prompt qua bridge → chờ Gemini trả lời → parse khối gps-tool →
 * chạy tool đọc ngay, tool sửa/chạy lệnh chờ người dùng duyệt → gửi KẾT QUẢ ngược lại → lặp.
 *
 * An toàn:
 *  - run_command LUÔN cần duyệt (kể cả khi bật tự duyệt sửa file).
 *  - Khối tool bị cắt giữa chừng không bao giờ được thực thi.
 *  - Nội dung trả về từ tool được gắn nhãn là dữ liệu không đáng tin trong prompt.
 */
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const protocol = require('./agent-protocol.cjs');
const projectHints = require('./project-hints.cjs');
const { ContextMeter, Ledger } = require('./context.cjs');

const MAX_STEPS_KEPT = 200;
const CONVERSATION_RE = /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/[A-Za-z0-9_-]+/;

function clip(s, n) { return protocol.clip(s, n); }
let seq = 0;
const uid = p => `${p}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

class AgentRunner extends EventEmitter {
  /**
   * @param deps { bridge, workspace, tools, checkpoints, getRoot, maxTurns }
   */
  constructor(deps) {
    super();
    this.bridge = deps.bridge;
    this.ws = deps.workspace;
    this.tools = deps.tools;
    this.checkpoints = deps.checkpoints;
    this.getRoot = deps.getRoot;
    this.maxTurns = deps.maxTurns || 25;
    this.detectChecks = deps.detectChecks || null; // tuỳ chọn, để test ghi đè
    this.sessions = deps.sessions || null;         // SessionStore (tuỳ chọn): lưu bền phiên theo project, NGOÀI project
    this._runRoot = null;
    this._persistTimer = null;
    this._disposed = false;
    this._rotateReason = '';
    this.policy = { autoEdits: false };
    this.meter = new ContextMeter(deps.contextBudgetChars || undefined);
    this.ledger = new Ledger();
    this.steps = [];
    this.pending = [];
    this._digest = [];
    this._resetRun();
    this._lastEmit = 0;
    this._emitTimer = null;
    this._onJob = job => this.handleJob(job);
    this.bridge.on('job', this._onJob);
  }
  dispose() {
    this.bridge.removeListener('job', this._onJob);
    clearTimeout(this._emitTimer);
    this.flushSession();
    this._disposed = true;
  }

  _resetRun() {
    this.run = { id: null, goal: '', status: 'idle', turn: 0, conversationUrl: null, jobId: null, liveText: '', error: '', question: '' };
    this._running = false;
    this._cancelled = false;
    this._waiter = null;
    this._abort = null;
    this._lastPrompt = null;
    this._systemPrompt = '';
  }

  /* ---------- trạng thái ---------- */
  snapshot() {
    return {
      ...this.run,
      maxTurns: this.maxTurns,
      policy: { ...this.policy },
      context: this.meter.snapshot(),
      steps: this.steps.slice(-MAX_STEPS_KEPT),
      pending: this.pending.map(p => ({ id: p.id, tool: p.tool, label: p.label, summary: p.summary, diff: p.diff, kind: p.kind, source: p.source, createdAt: p.createdAt }))
    };
  }
  emitState(throttle = false) {
    this._schedulePersist();
    if (throttle) {
      const now = Date.now();
      if (now - this._lastEmit < 250) {
        if (!this._emitTimer) this._emitTimer = setTimeout(() => { this._emitTimer = null; this.emitState(); }, 260);
        return;
      }
    }
    this._lastEmit = Date.now();
    this.emit('state', this.snapshot());
  }
  setStatus(status, extra = {}) {
    Object.assign(this.run, { status }, extra);
    this.emitState();
  }
  pushStep(step) {
    const s = { id: uid('s'), at: Date.now(), ...step };
    this.steps.push(s);
    if (this.steps.length > MAX_STEPS_KEPT * 2) this.steps.splice(0, this.steps.length - MAX_STEPS_KEPT);
    this.emitState();
    return s;
  }
  setPolicy(p) {
    if (p && typeof p.autoEdits === 'boolean') this.policy.autoEdits = p.autoEdits;
    this.emitState();
    return { ...this.policy };
  }

  /* ---------- bridge ---------- */
  handleJob(job) {
    if (!job || job.id !== this.run.jobId) return;
    if (job.conversationUrl && CONVERSATION_RE.test(job.conversationUrl)) this.run.conversationUrl = job.conversationUrl.match(CONVERSATION_RE)[0];
    if (job.status === 'streaming' || job.status === 'sent') {
      if (job.status === 'streaming') this.run.liveText = job.answer || '';
      this.emitState(true);
    }
    if (['final', 'error', 'cancelled'].includes(job.status) && this._waiter && this._waiter.id === job.id) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve(job);
    }
  }
  _waitFor(jobId) {
    const existing = this.bridge.getJob(jobId);
    if (existing && ['final', 'error', 'cancelled'].includes(existing.status)) return Promise.resolve(this.bridge.publicJob(existing));
    return new Promise(resolve => { this._waiter = { id: jobId, resolve }; });
  }
  async _sendAndWait(prompt, { newChat }) {
    this._lastPrompt = { prompt, newChat };
    this.run.liveText = '';
    const job = this.bridge.enqueue(this.run.goal.slice(0, 120), prompt, [], {
      kind: 'agent', newChat, expectConversation: newChat ? null : this.run.conversationUrl
    });
    this.run.jobId = job.id;
    if (newChat) this.meter.startChat(prompt.length); else this.meter.addSent(prompt.length);
    this.setStatus('running');
    const result = await this._waitFor(job.id);
    if (result && result.answer) this.meter.addReceived(String(result.answer).length);
    this.emitState();
    return result;
  }

  /** Bản tóm tắt để mở chat Gemini mới: mục tiêu + sổ tiến độ do ứng dụng ghi + việc cần xử lý ngay. */
  _buildRecap(followUp, reason) {
    return protocol.buildRecap({
      systemPrompt: this._systemPrompt, goal: this.run.goal, steps: this._digest,
      ledgerText: this.ledger.render(), followUp, maxFollowUp: 24000, reason
    });
  }
  _makeSystemPrompt(root) {
    const index = this.ws.scanProject(root);
    let checks = [];
    try { checks = (this.detectChecks || projectHints.detectCheckCommands)(root); } catch { checks = []; }
    const systemPrompt = protocol.buildSystemPrompt({
      checks, specs: this.tools.specs(), projectName: index.name, fileCount: index.files.length, truncated: index.truncated,
      tree: this.ws.buildCondensedTree(index.files, 3500)
    });
    return { systemPrompt, checks };
  }

  /* ---------- lưu bền phiên ---------- */
  _schedulePersist() {
    if (!this.sessions || this._disposed || this._persistTimer) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.flushSession(); }, 400);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }
  _exportSession() {
    return {
      savedAt: Date.now(),
      run: { id: this.run.id, goal: this.run.goal, status: this.run.status, turn: this.run.turn, conversationUrl: this.run.conversationUrl, error: this.run.error, question: this.run.question },
      steps: this.steps.slice(-MAX_STEPS_KEPT),
      digest: this._digest.slice(-60),
      meter: { chars: this.meter.chars, turns: this.meter.turns, chatIndex: this.meter.chatIndex, rotations: this.meter.rotations },
      ledger: this.ledger.toJSON(),
      // Chỉ để báo "hết hạn" sau khi mở lại; KHÔNG lưu diff/đối số nên không thể thực thi lại.
      expiredApprovals: this.pending.map(p => ({ tool: p.tool, label: p.label, summary: p.summary, source: p.source }))
    };
  }
  /** Ghi phiên ngay (đồng bộ). Trả về true nếu đã ghi. */
  flushSession() {
    clearTimeout(this._persistTimer);
    this._persistTimer = null;
    if (!this.sessions || !this.run.id || !this._runRoot || this.run.status === 'idle') return false;
    try { this.sessions.save(this._runRoot, this._exportSession()); return true; } catch { return false; }
  }
  /** Tóm tắt phiên đã lưu của project hiện tại (null nếu không có hoặc phiên đó đang hoạt động trong bộ nhớ). */
  previousSession() {
    const root = this.getRoot();
    if (!root || !this.sessions) return null;
    if (this.run.id && this._runRoot === root) return null;
    const s = this.sessions.load(root);
    if (!s) return null;
    return {
      id: s.run.id, goal: s.run.goal, savedAt: s.savedAt, status: s.run.status, turn: s.run.turn, stepCount: s.steps.length,
      filesChanged: s.ledger.changed.map(([p]) => p),
      interrupted: ['running', 'waiting_approval'].includes(s.run.status),
      expiredApprovals: s.steps.filter(x => x.status === 'waiting_approval').length + s.expiredApprovals.filter(e => e.source === 'vibe').length,
      chatIndex: s.meter.chatIndex
    };
  }
  discardPrevious() {
    const root = this.getRoot();
    if (root && this.sessions && !(this.run.id && this._runRoot === root)) this.sessions.clear(root);
    return true;
  }
  /**
   * Khôi phục phiên đã lưu. Yêu cầu duyệt đang chờ lúc app đóng bị đánh dấu HẾT HẠN và không bao giờ tự chạy.
   * Chính sách tự duyệt KHÔNG được khôi phục (luôn tắt). Hội thoại Gemini cũ coi như mất: lần gửi kế tiếp mở chat mới kèm recap.
   * continueRun=true: gửi tiếp luôn; false: chỉ khôi phục để xem lại, chờ người dùng nhắn.
   */
  resume({ continueRun = true } = {}) {
    if (this._running) throw new Error('Agent đang chạy. Hãy dừng phiên hiện tại trước.');
    if (!this.sessions) throw new Error('Chưa bật lưu phiên.');
    const root = this.getRoot();
    if (!root) throw new Error('Hãy mở thư mục dự án trước.');
    const saved = this.sessions.load(root);
    if (!saved) throw new Error('Không có phiên trước để khôi phục cho project này.');
    const { systemPrompt } = this._makeSystemPrompt(root);

    const expired = [];
    const steps = saved.steps.map(st => {
      if (st.status === 'waiting_approval') { expired.push(`${st.tool || '?'} ${st.label || ''}`.trim()); return { ...st, status: 'expired' }; }
      if (st.status === 'running') return { ...st, status: 'interrupted' };
      return st;
    });
    for (const e of saved.expiredApprovals) if (e.source === 'vibe') expired.push(`${e.tool} ${e.label} (đề xuất từ trang Gemini)`.trim());

    const keepPending = this.pending.filter(p => p.source !== 'agent');
    this._resetRun();
    this._systemPrompt = systemPrompt;
    this._runRoot = root;
    this.pending = keepPending;
    this.steps = steps;
    this._digest = saved.digest.slice();
    this.ledger.load(saved.ledger);
    this.meter.restore(saved.meter);
    Object.assign(this.run, { id: saved.run.id, goal: saved.run.goal, turn: 0, conversationUrl: null, error: '', question: '' });
    this._rotateReason = 'ứng dụng được mở lại';
    this.meter.rotateRequested = true;

    const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('vi-VN') : 'không rõ';
    this.pushStep({ type: 'info', text: `Đã khôi phục phiên trước (lưu lúc ${when}).${expired.length ? ` ${expired.length} yêu cầu duyệt đang chờ khi ứng dụng đóng đã HẾT HẠN và KHÔNG được tự thực thi: ${expired.join('; ')}.` : ''}` });

    if (!continueRun) {
      const done = saved.run.status === 'done';
      this.setStatus(done ? 'done' : 'waiting_user', { question: done ? '' : 'Phiên được khôi phục để xem lại. Gõ tin nhắn để tiếp tục — sẽ mở chat Gemini mới kèm bản tóm tắt tiến độ.' });
      return this.snapshot();
    }
    this._running = true;
    this._cancelled = false;
    this.pushStep({ type: 'info', text: 'Tiếp tục phiên trước…' });
    this._loop('Ứng dụng vừa được mở lại và phiên làm việc được khôi phục. Các yêu cầu duyệt đang chờ ở phiên trước đã HẾT HẠN và CHƯA được thực thi' + (expired.length ? ' (' + expired.join('; ') + ')' : '') + '. Hãy kiểm tra trạng thái hiện tại bằng tool nếu cần (các file đã sửa nằm trong bản tóm tắt), rồi tiếp tục NHIỆM VỤ; nếu vẫn cần thao tác đã hết hạn, hãy đề xuất lại.', { newChat: false });
    return this.snapshot();
  }

  /** Người dùng yêu cầu: lần gửi kế tiếp sẽ mở chat Gemini mới kèm bản tóm tắt. */
  rotateNext() {
    if (!this.run.id) throw new Error('Chưa có phiên agent.');
    this.meter.rotateRequested = true;
    this.emitState();
    return this.snapshot();
  }
  /* ---------- API công khai ---------- */
  start(goal) {
    if (this._running) throw new Error('Agent đang chạy. Hãy dừng phiên hiện tại trước.');
    const text = String(goal || '').trim();
    if (!text) throw new Error('Hãy nhập mục tiêu cho agent.');
    const root = this.getRoot();
    if (!root) throw new Error('Hãy mở thư mục dự án trước.');
    const built = this._makeSystemPrompt(root);
    const checks = built.checks;
    this._systemPrompt = built.systemPrompt;
    const keepPending = this.pending.filter(p => p.source !== 'agent');
    this.steps = [];
    this.pending = keepPending;
    this._digest = [];
    this.ledger.clear();
    this.meter.resetAll();
    const systemPrompt = this._systemPrompt;
    this._resetRun();
    this._systemPrompt = systemPrompt;
    this._runRoot = root;
    this._rotateReason = '';
    this.run.id = uid('run');
    this.run.goal = text;
    this._running = true;
    this.pushStep({ type: 'info', text: `Mục tiêu: ${text}` });
    if (checks.length) this.pushStep({ type: 'info', text: `Lệnh kiểm tra gợi ý cho agent: ${checks.map(c => c.command).join(' · ')}` });
    this._loop(protocol.buildKickoff({ systemPrompt, goal: text }), { newChat: true });
    return this.snapshot();
  }
  /** Gửi tin nhắn tiếp theo (trả lời câu hỏi của agent hoặc giao thêm việc). */
  reply(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Tin nhắn trống.');
    if (this._running) throw new Error('Agent đang xử lý, hãy chờ hoặc dừng trước.');
    if (!this.run.id) throw new Error('Chưa có phiên agent. Hãy bắt đầu bằng một mục tiêu.');
    this._running = true;
    this._cancelled = false;
    this.run.error = '';
    this.pushStep({ type: 'user', text: t });
    this.ledger.recordUser(t);
    this._loop(`Tin nhắn mới từ người dùng:\n${t}`, { newChat: false });
    return this.snapshot();
  }
  /** Gửi lại prompt gần nhất (sau timeout/lỗi). */
  retry() {
    if (this._running) throw new Error('Agent đang chạy.');
    if (!this._lastPrompt) throw new Error('Không có gì để thử lại.');
    this._running = true;
    this._cancelled = false;
    this.run.error = '';
    this.pushStep({ type: 'info', text: 'Thử lại lượt vừa rồi…' });
    const { prompt, newChat } = this._lastPrompt;
    this._loop(prompt, { newChat });
    return this.snapshot();
  }
  cancel() {
    this._cancelled = true;
    if (this._abort) this._abort.abort();
    if (this.run.jobId) this.bridge.cancel(this.run.jobId);
    for (const p of [...this.pending]) if (p.source === 'agent') this._settle(p, 'reject', 'Đã dừng agent.');
    if (this._waiter) { const w = this._waiter; this._waiter = null; w.resolve({ id: w.id, status: 'cancelled', answer: '' }); }
    if (this.run.status !== 'idle' && this.run.status !== 'done') {
      this.pushStep({ type: 'info', text: 'Đã dừng.' });
      this.setStatus('cancelled');
    }
    return this.snapshot();
  }
  getJobPrompt(id) { return this.bridge.getPrompt(id); }

  /* ---------- vòng lặp ---------- */
  async _loop(firstPrompt, firstOpts) {
    let prompt = firstPrompt, opts = firstOpts;
    let formatRetries = 0, mismatchRetries = 0;
    try {
      while (!this._cancelled) {
        if (this.run.turn >= this.maxTurns) {
          this.pushStep({ type: 'error', text: `Đã đạt giới hạn ${this.maxTurns} lượt. Hãy kiểm tra kết quả hoặc gửi tin nhắn để tiếp tục.` });
          this.setStatus('waiting_user', { question: 'Đã đạt giới hạn số lượt. Bạn muốn agent tiếp tục không?' });
          this.run.turn = 0;
          return;
        }
        // Hội thoại Gemini quá dài (hoặc người dùng yêu cầu): chuyển sang chat mới kèm bản tóm tắt TRƯỚC khi gửi.
        if (!opts.newChat && this.meter.shouldRotate(prompt.length)) {
          const m = this.meter.snapshot();
          const manual = this.meter.rotateRequested;
          const restored = this._rotateReason;
          this._rotateReason = '';
          this.pushStep({ type: 'info', text: restored
            ? `Khôi phục phiên → mở chat Gemini mới kèm bản tóm tắt tiến độ (${restored}).`
            : manual
            ? 'Theo yêu cầu của bạn → chuyển sang chat Gemini mới kèm bản tóm tắt tiến độ.'
            : `Hội thoại Gemini đã dài (~${m.chars.toLocaleString('vi-VN')} ký tự ≈ ${m.tokens.toLocaleString('vi-VN')} token, ngân sách ${m.budgetChars.toLocaleString('vi-VN')}) → chuyển sang chat mới kèm bản tóm tắt tiến độ.` });
          prompt = this._buildRecap(prompt, restored ? 'phiên được khôi phục sau khi mở lại ứng dụng; hội thoại Gemini cũ không còn' : 'cuộc trò chuyện trước đã quá dài nên được chuyển sang chat mới');
          opts = { newChat: true };
          this.run.conversationUrl = null;
          this.meter.rotations++;
          this.meter.rotateRequested = false;
        }
        this.run.turn++;
        const job = await this._sendAndWait(prompt, opts);
        if (this._cancelled || job.status === 'cancelled') return;
        if (job.status === 'error') {
          if (job.code === 'conversation_mismatch' && mismatchRetries < 1) {
            mismatchRetries++;
            this.pushStep({ type: 'info', text: 'Tab Gemini đang ở cuộc trò chuyện khác → mở chat mới và gửi lại bản tóm tắt tiến độ.' });
            prompt = this._buildRecap(prompt, 'cuộc trò chuyện trước bị mất');
            opts = { newChat: true };
            this.run.conversationUrl = null;
            continue;
          }
          this.pushStep({ type: 'error', text: job.answer || 'Lỗi không rõ khi làm việc với Gemini.' });
          this.setStatus('error', { error: job.answer || 'Lỗi', liveText: '' });
          return;
        }
        const { calls, text } = protocol.parseToolCalls(job.answer || '');
        this.run.liveText = '';
        if (text) { this.pushStep({ type: 'assistant', text: clip(text, 6000) }); this.ledger.recordNote(text); }
        if (!calls.length) {
          const looksLikeAttempt = /gps-tool|(^|\n)\s*tool:\s*[a-z_]+/i.test(job.answer || '');
          if (looksLikeAttempt && formatRetries < 2) {
            formatRetries++;
            this.pushStep({ type: 'info', text: 'Không đọc được khối gps-tool hợp lệ → yêu cầu Gemini gửi lại đúng định dạng.' });
            prompt = 'Tôi không đọc được khối tool hợp lệ trong tin nhắn trước. Hãy gửi lại, mỗi khối bắt đầu bằng ```gps-tool và dòng đầu `tool: <tên>`, đóng bằng ```. Không thêm gì sau các khối tool.';
            opts = { newChat: false };
            continue;
          }
          // Trả lời bằng văn xuôi: coi như câu trả lời cho người dùng.
          this.setStatus('waiting_user', { question: '' });
          return;
        }
        formatRetries = 0;
        const outcome = await this._executeCalls(calls);
        if (this._cancelled) return;
        if (outcome.finished) { this.setStatus('done', { question: '' }); return; }
        if (outcome.question !== null) { this.setStatus('waiting_user', { question: outcome.question }); return; }
        prompt = protocol.formatToolResults(outcome.items);
        opts = { newChat: false };
      }
    } catch (err) {
      this.pushStep({ type: 'error', text: `Lỗi nội bộ: ${err && err.message ? err.message : err}` });
      this.setStatus('error', { error: String(err && err.message ? err.message : err) });
    } finally {
      this._running = false;
      this._abort = null;
      this.emitState();
    }
  }

  async _executeCalls(calls) {
    const root = this.getRoot();
    this._abort = new AbortController();
    const items = [];
    let finished = false, question = null, halted = false;
    for (const call of calls) {
      if (this._cancelled) break;
      const tool = this.tools.TOOLS[call.tool];
      const item = { tool: call.tool || '?', status: 'ok', output: '', label: '' };
      items.push(item);
      if (finished || question !== null) { item.status = 'skipped'; item.output = 'Bỏ qua: đã có finish/ask_user trước đó.'; continue; }
      if (!call.valid) { item.status = 'error'; item.output = call.error || 'Khối tool không hợp lệ.'; halted = true; this.pushStep({ type: 'tool', tool: item.tool, status: 'error', label: '', text: item.output }); continue; }
      if (!tool) { item.status = 'error'; item.output = `Tool "${call.tool}" không tồn tại. Các tool có sẵn: ${Object.keys(this.tools.TOOLS).join(', ')}.`; this.pushStep({ type: 'tool', tool: item.tool, status: 'error', text: item.output }); continue; }
      if (halted && tool.kind !== 'read' && tool.kind !== 'control') { item.status = 'skipped'; item.output = 'Bỏ qua vì một bước trước đó trong cùng tin nhắn đã lỗi. Hãy xử lý lỗi rồi gửi lại.'; continue; }
      const ctx = { root, checkpoints: this.checkpoints, signal: this._abort.signal, source: 'agent' };
      let prep;
      try { prep = tool.prepare(ctx, call.args); }
      catch (err) {
        item.status = 'error'; item.output = err.message || String(err); halted = true;
        this.pushStep({ type: 'tool', tool: call.tool, status: 'error', label: '', text: item.output });
        this._digest.push(`${call.tool} → lỗi: ${clip(item.output, 120)}`);
        continue;
      }
      item.label = prep.label || '';
      const step = this.pushStep({ type: 'tool', tool: call.tool, label: item.label, summary: prep.summary || '', diff: prep.diff || '', status: 'running' });
      const updateStep = patch => { Object.assign(step, patch); this.emitState(); };

      if (tool.kind === 'control') {
        const res = await tool.run(ctx, call.args);
        if (call.tool === 'finish') { finished = true; item.output = res.output; updateStep({ status: 'done', text: res.output }); this._digest.push(`finish: ${clip(res.output, 160)}`); }
        else { question = res.output || 'Agent cần thêm thông tin.'; item.output = 'Đang chờ người dùng trả lời.'; updateStep({ status: 'done', text: question }); }
        continue;
      }
      let go = true;
      if (tool.kind === 'exec' || (tool.kind === 'edit' && !this.policy.autoEdits)) {
        updateStep({ status: 'waiting_approval' });
        const decision = await this._requestApproval({ tool: call.tool, label: item.label, summary: prep.summary || '', diff: prep.diff || '', kind: tool.kind, source: 'agent', args: call.args, stepId: step.id });
        if (this._cancelled) break;
        if (decision.decision !== 'approve') {
          item.status = 'rejected';
          item.output = `Người dùng đã TỪ CHỐI thao tác này.${decision.reason ? ' Lý do: ' + decision.reason : ''} Đừng lặp lại y nguyên; hãy đề xuất hướng khác hoặc hỏi lại người dùng.`;
          updateStep({ status: 'rejected' });
          this._digest.push(`${call.tool} ${item.label} → bị từ chối`);
          this.ledger.recordRejected(`${call.tool} ${item.label}${decision.reason ? ' (lý do: ' + clip(decision.reason, 120) + ')' : ''}`);
          halted = true;
          go = false;
        }
      }
      if (!go) continue;
      try {
        updateStep({ status: 'running' });
        const res = await tool.run(ctx, call.args);
        item.output = res.output;
        const ok = res.ok !== false;
        item.status = ok ? 'ok' : 'failed';
        updateStep({ status: ok ? 'done' : 'failed', output: clip(res.output, 3000), checkpoint: res.checkpoint || undefined });
        this._digest.push(`${call.tool} ${item.label} → ${ok ? 'ok' : 'thất bại'}`);
        if (res.checkpoint) this.emit('checkpoint', res.checkpoint);
        if (res.path && tool.kind === 'edit') this.emit('file-written', { path: res.path });
        // Sổ tiến độ do ứng dụng ghi: chỉ ghi khi tool THỰC SỰ chạy xong.
        if (ok && tool.kind === 'edit') this.ledger.recordEdit(res.path || item.label, call.tool, !!prep.created);
        else if (tool.kind === 'exec') this.ledger.recordCommand(item.label, ok, res.exitCode, res.output);
        else if (ok && call.tool === 'read_file') this.ledger.recordRead(item.label);
        if (!ok && (tool.kind === 'exec')) { /* lệnh lỗi không dừng các bước sau; mô hình tự quyết */ }
      } catch (err) {
        item.status = 'error'; item.output = err.message || String(err); halted = true;
        updateStep({ status: 'failed', output: item.output });
        this._digest.push(`${call.tool} ${item.label} → lỗi: ${clip(item.output, 120)}`);
      }
    }
    return { items, finished, question };
  }

  /* ---------- duyệt ---------- */
  _requestApproval(action) {
    return new Promise(resolve => {
      const entry = { id: uid('act'), createdAt: Date.now(), ...action, resolve };
      this.pending.push(entry);
      this.setStatus('waiting_approval');
    });
  }
  _settle(entry, decision, reason = '') {
    const idx = this.pending.indexOf(entry);
    if (idx !== -1) this.pending.splice(idx, 1);
    if (entry.resolve) entry.resolve({ decision, reason });
  }
  /** decision: 'approve' | 'reject' | 'approve_all_edits' */
  async approve(actionId, decision = 'approve', reason = '') {
    const entry = this.pending.find(p => p.id === actionId);
    if (!entry) throw new Error('Yêu cầu duyệt không còn tồn tại.');
    if (decision === 'approve_all_edits') {
      if (entry.kind !== 'edit') throw new Error('Chỉ tự duyệt được thao tác sửa file, không áp dụng cho chạy lệnh.');
      this.policy.autoEdits = true;
      decision = 'approve';
    }
    if (entry.source === 'agent') {
      this._settle(entry, decision === 'approve' ? 'approve' : 'reject', reason);
      if (this.run.status === 'waiting_approval' && !this.pending.some(p => p.source === 'agent')) this.setStatus('running');
      else this.emitState();
      return { ok: true };
    }
    // Đề xuất từ nút Vibe trên trang Gemini
    this._settle(entry, decision === 'approve' ? 'approve' : 'reject', reason);
    if (decision !== 'approve') { this.pushStep({ type: 'tool', tool: entry.tool, label: entry.label, status: 'rejected', summary: 'Đề xuất từ trang Gemini bị từ chối' }); return { ok: true }; }
    const root = this.getRoot();
    const ctx = { root, checkpoints: this.checkpoints, source: 'vibe' };
    const step = this.pushStep({ type: 'tool', tool: entry.tool, label: entry.label, summary: entry.summary, diff: entry.diff, status: 'running' });
    try {
      const res = await this.tools.TOOLS.write_file.run(ctx, entry.args);
      Object.assign(step, { status: 'done', output: res.output, checkpoint: res.checkpoint || undefined });
      this.emit('file-written', { path: res.path });
    } catch (err) {
      Object.assign(step, { status: 'failed', output: err.message || String(err) });
    }
    this.emitState();
    return { ok: true };
  }
  /** Nút "Ghi vào Project" trên trang Gemini → chỉ tạo đề xuất chờ duyệt. */
  async proposeExternalWrite(relPath, content) {
    const root = this.getRoot();
    if (!root) throw new Error('Hãy mở thư mục dự án trong Studio trước.');
    const args = { path: String(relPath), body: String(content) };
    const ctx = { root, checkpoints: this.checkpoints, source: 'vibe' };
    const prep = this.tools.TOOLS.write_file.prepare(ctx, args); // ném lỗi nếu đường dẫn bị chặn
    const entry = { id: uid('act'), createdAt: Date.now(), tool: 'write_file', label: prep.label, summary: `Từ trang Gemini · ${prep.summary}`, diff: prep.diff, kind: 'edit', source: 'vibe', args, resolve: null };
    this.pending.push(entry);
    this.emitState();
    this.emit('attention', { id: entry.id, path: prep.label });
    return { id: entry.id, path: prep.label };
  }

  /* ---------- checkpoint ---------- */
  _io(root) {
    const ws = this.ws;
    return {
      read: rel => { const { dest } = ws.resolveWriteTarget(root, rel); return fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null; },
      write: (rel, text) => ws.writeProjectFile(root, rel, text),
      remove: rel => ws.removeProjectFile(root, rel)
    };
  }
  listCheckpoints() {
    const root = this.getRoot();
    return root ? this.checkpoints.list(root).slice(0, 100) : [];
  }
  undo(checkpointId, force = false) {
    const root = this.getRoot();
    if (!root) throw new Error('Hãy mở thư mục dự án trước.');
    const entry = this.checkpoints.undo(root, checkpointId, this._io(root), { force });
    this.pushStep({ type: 'info', text: `Đã hoàn tác ${entry.created ? 'việc tạo' : 'thay đổi'} ${entry.path}` });
    this.emit('file-written', { path: entry.path });
    return entry;
  }
}

module.exports = { AgentRunner };
