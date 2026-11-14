'use strict';
/* DOM adapter for Gemini Web: best effort, no private endpoints and no credential access. */
(() => {
  if (window.__gpsBridgeInjected) return;
  window.__gpsBridgeInjected = true;
  let active = null;
  let seenCount = 0;
  let lastText = '';
  let lastTextChangedAt = 0;
  let polling = false;
  let hudText;

  const S = globalThis.__gpsSelectors;
  if (!S) { console.warn('[GPS] selectors.js chưa được nạp'); return; }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getComposer() {
    const hit = S.findComposer(document, { isVisible: visible });
    return hit ? hit.el : null;
  }

  function responses() {
    return S.findResponses(document).els;
  }

  function latestResponse() {
    const els = responses();
    if (els.length <= seenCount) return '';
    const last = els[els.length - 1];
    const hit = S.findResponseContent(last);
    const content = hit ? hit.el : last;
    // Giữ nguyên rào chắn ``` của khối code (cần cho khối gps-tool); rơi về innerText nếu bộ chuyển lỗi/rỗng.
    let text = '';
    try { text = typeof globalThis.__gpsHtmlToMarkdown === 'function' ? globalThis.__gpsHtmlToMarkdown(content) : ''; } catch (_) { text = ''; }
    if (!text) text = (content.innerText || content.textContent || '').trim();
    return text;
  }

  function busyGenerating() {
    return !!S.findStopButton(document, { isVisible: visible });
  }

  function isButtonDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.classList.contains('mat-mdc-button-disabled') || el.classList.contains('disabled')) return true;
    return false;
  }

  function findSendButton() {
    const hit = S.findSendButton(document, { isVisible: visible });
    return hit ? hit.el : null;
  }

  async function waitForSendButton(timeoutMs = 6000) {
    const start = Date.now();
    let bestCandidate = null;
    while (Date.now() - start < timeoutMs) {
      const btn = findSendButton();
      if (btn) {
        bestCandidate = btn;
        if (!isButtonDisabled(btn)) {
          return btn;
        }
      }
      // Re-trigger input event on composer in case Angular was slow to detect changes
      const composer = getComposer();
      if (composer) {
        composer.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return bestCandidate;
  }

  function clickButton(btn) {
    if (!btn) return false;
    try {
      btn.focus();
      const opts = { bubbles: true, cancelable: true, view: window };
      btn.dispatchEvent(new PointerEvent('pointerdown', opts));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new PointerEvent('pointerup', opts));
      btn.dispatchEvent(new MouseEvent('mouseup', opts));
      btn.click();
      return true;
    } catch (_) {
      try { btn.click(); return true; } catch (__) {}
      return false;
    }
  }

  function triggerEnter(composer) {
    if (!composer) return false;
    try {
      composer.focus();
      const opts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };
      composer.dispatchEvent(new KeyboardEvent('keydown', opts));
      composer.dispatchEvent(new KeyboardEvent('keypress', opts));
      composer.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function checkGenerationStarted(prevCount, waitMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (busyGenerating() || responses().length > prevCount) {
        return true;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  }

  async function api(message) {
    return await chrome.runtime.sendMessage(message);
  }

  function appPath() {
    return location.pathname.replace(/^\/u\/\d+/, '');
  }
  function isFreshChat() {
    return /^\/app\/?$/.test(appPath()) && responses().length === 0;
  }
  function findNewChatButton() {
    const hit = S.findNewChat(document, { isVisible: visible });
    return hit ? (hit.el.closest('a, button, [role="button"]') || hit.el) : null;
  }
  async function ensureNewChat() {
    if (isFreshChat()) return true;
    const btn = findNewChatButton();
    if (btn) {
      clickButton(btn);
      const start = Date.now();
      while (Date.now() - start < 4000) {
        await new Promise(r => setTimeout(r, 150));
        if (isFreshChat()) return true;
      }
    }
    return isFreshChat();
  }
  function conversationUrlNow() {
    return /\/app\/[A-Za-z0-9_-]+/.test(location.pathname) ? location.href.split(/[?#]/)[0] : '';
  }
  function sameConversation(expectedUrl) {
    try { return new URL(expectedUrl).pathname.replace(/^\/u\/\d+/, '') === appPath(); } catch (_) { return true; }
  }

  function setBadge(message, status = 'idle') {
    if (!hudText) return;
    hudText.textContent = message;
    hudText.dataset.status = status;
  }

  function formatToSafeQuillHtml(text) {
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rawLines = text.split('\n');
    const blocks = [];
    let currentBlock = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.trim() === '' && currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      } else {
        currentBlock.push(line);
        if (currentBlock.length >= 25) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
      }
    }
    if (currentBlock.length > 0) blocks.push(currentBlock);

    return blocks.map(b => `<p>${b.map(escape).join('<br>') || '<br>'}</p>`).join('');
  }

  function insertPrompt(text) {
    const composer = getComposer();
    if (!composer) throw new Error('Không tìm thấy ô nhập Gemini. Hãy mở chat mới trên tab gemini.google.com hoặc dùng copy/paste thủ công.');
    composer.focus();

    if (composer.tagName === 'TEXTAREA') {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor?.set?.call(composer, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return composer;
    }

    // Contenteditable / Quill rich-text editor
    const safeHtml = formatToSafeQuillHtml(text);

    // Clear previous contents cleanly
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
    } catch (_) {}

    let injected = false;

    // Method 1: document.execCommand('insertHTML') - fastest, native browser command handled by Quill in one batch
    try {
      injected = document.execCommand('insertHTML', false, safeHtml);
      if (composer.textContent && composer.textContent.trim().length > 0) {
        injected = true;
      }
    } catch (_) {}

    // Method 2: Synthetic ClipboardEvent paste fallback (handles custom Quill clipboard listeners)
    if (!injected || !composer.textContent.trim()) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        dt.setData('text/html', safeHtml);
        const pasteEvt = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        composer.dispatchEvent(pasteEvt);
        if (composer.textContent && composer.textContent.trim().length > 0) {
          injected = true;
        }
      } catch (_) {}
    }

    // Method 3: Batched HTML block injection fallback (grouped into few paragraphs to prevent Quill UI freeze)
    if (!injected || !composer.textContent.trim()) {
      composer.innerHTML = safeHtml;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', composed: true }));
    }

    composer.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return composer;
  }

  // ---- Đính kèm ảnh (Giai đoạn 2, mục 7) — CHƯA kiểm chứng trên Gemini thật ----
  // Thử lần lượt: dán (paste) vào ô nhập → thả (drop) → <input type=file>. Thành công = số "xem trước tệp" tăng lên.
  // Không xác nhận được thì báo lỗi code 'attachment_failed' (Studio sẽ hướng dẫn gửi chỉ chữ hoặc đính kèm thủ công);
  // KHÔNG bao giờ lặng lẽ gửi tin nhắn thiếu ảnh.
  function b64ToFile(a) {
    const bin = atob(String(a.data || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], String(a.name || 'image.png'), { type: String(a.mime || 'image/png') });
  }
  async function previewsIncreased(before, ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (S.countAttachmentPreviews(document) > before) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }
  async function attachImages(list, composer) {
    const files = list.slice(0, 3).map(b64ToFile);
    const before = S.countAttachmentPreviews(document);
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const attempts = [
      () => { composer.focus(); composer.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); },
      () => { composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); },
      () => {
        const input = S.findFileInputs(document)[0];
        if (!input) return;
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    ];
    for (const attempt of attempts) {
      try { attempt(); } catch (_) { continue; }
      if (await previewsIncreased(before, 5000)) return true;
    }
    const err = new Error('Không đính kèm được ảnh vào Gemini (không thấy ảnh xem trước sau khi dán/thả/chọn tệp). Gửi chỉ phần chữ hoặc đính kèm ảnh thủ công trong tab Gemini.');
    err.code = 'attachment_failed';
    throw err;
  }

  async function report(status, text, extra = {}) {
    if (!active) return;
    const result = await api({ type: 'GPS_REPORT', id: active.id, status, text, conversationUrl: conversationUrlNow(), ...extra });
    if (result?.error) throw new Error(result.error);
    // Studio đã huỷ job này: dừng chờ câu trả lời.
    if (result?.data?.cancelled) {
      active = null;
      setBadge('Studio đã huỷ yêu cầu này', 'ready');
      return 'cancelled';
    }
  }

  async function processJob(job) {
    active = { id: job.id, started: Date.now(), completed: false, lastReportedStreaming: 0, lastKeepAlive: Date.now() };
    try {
      if (job.newChat) {
        setBadge('Đang mở cuộc trò chuyện mới…', 'working');
        const ok = await ensureNewChat();
        if (!ok) setBadge('Không tự mở được chat mới · vẫn gửi trong chat hiện tại', 'error');
      } else if (job.expectConversation && !sameConversation(job.expectConversation)) {
        setBadge('Tab Gemini đang ở cuộc trò chuyện khác', 'error');
        await report('error', 'Tab Gemini đang ở cuộc trò chuyện khác với phiên làm việc này.', { code: 'conversation_mismatch' });
        active = null;
        return;
      }
      seenCount = responses().length;
      lastText = '';
      lastTextChangedAt = Date.now();
      const composer = insertPrompt(job.prompt);
      const hasImages = Array.isArray(job.attachments) && job.attachments.length > 0;
      if (hasImages) {
        setBadge('Đang đính kèm ảnh…', 'working');
        await attachImages(job.attachments, composer);
      }

      // Wait for Send button to appear and enable (handles large prompts up to 6 seconds; ảnh cần thời gian tải lên)
      const button = await waitForSendButton(hasImages ? 15000 : 6000);
      let sent = false;

      if (button && !isButtonDisabled(button)) {
        clickButton(button);
        sent = await checkGenerationStarted(seenCount, 2800);
      }

      // If button didn't start generation or button was disabled, try Enter key on composer
      if (!sent && composer) {
        triggerEnter(composer);
        sent = await checkGenerationStarted(seenCount, 2200);
      }

      // If still not sent, retry clicking candidate button
      if (!sent && button) {
        button.removeAttribute('disabled');
        button.setAttribute('aria-disabled', 'false');
        clickButton(button);
        sent = await checkGenerationStarted(seenCount, 2000);
      }

      if (!sent) {
        setBadge('Chưa bấm được Gửi · bấm Gửi trên tab Gemini', 'error');
        await report('sent', 'Prompt đã được điền vào Gemini Web. Vui lòng bấm nút Gửi trên tab Gemini nếu câu hỏi chưa tự động gửi.');
      } else {
        await report('sent', 'Đã gửi prompt. Đang chờ Gemini phản hồi…');
        setBadge('Đang đợi Gemini trả lời…', 'working');
      }
    } catch (err) {
      await report('error', String(err.message || err), err && err.code ? { code: String(err.code).slice(0, 40) } : {}).catch(() => {});
      setBadge('Không gửi được · kiểm tra Gemini tab', 'error');
      active = null;
    }
  }

  async function capture(force = false) {
    if (!active || active.completed) return;
    const text = latestResponse();
    const isBusy = busyGenerating();
    if (!text) {
      // Gemini đang "suy nghĩ" chưa có chữ: báo tín hiệu sống để Studio không coi là treo.
      if (isBusy && Date.now() - (active.lastKeepAlive || 0) > 20000) {
        active.lastKeepAlive = Date.now();
        await report('sent', 'Gemini đang suy nghĩ…').catch(() => {});
      }
      return;
    }

    if (text !== lastText) {
      lastText = text;
      lastTextChangedAt = Date.now();
      // Real-time streaming update to Studio every ~1000ms
      if (Date.now() - (active.lastReportedStreaming || 0) > 1000) {
        active.lastReportedStreaming = Date.now();
        await report('streaming', text).catch(() => {});
        setBadge(`Gemini đang viết… (${text.length} ký tự)`, 'working');
      }
      return;
    }

    // Text hasn't changed. Check completion conditions:
    const isStable = Date.now() - lastTextChangedAt >= 2000;
    const hasRanMinTime = Date.now() - active.started >= 3000;

    if (!force) {
      if (isBusy) {
        return; // Still generating
      }
      if (!isStable || !hasRanMinTime) {
        return;
      }
    }

    active.completed = true;
    try {
      await report('final', text);
      setBadge('Đã chuyển câu trả lời về Studio ✓', 'done');
      active = null;
    } catch (err) {
      active.completed = false;
      setBadge('Lỗi chuyển phản hồi: ' + String(err.message || err), 'error');
    }
  }

  async function poll() {
    if (active || polling) return;
    polling = true;
    try {
      const result = await api({ type: 'GPS_POLL' });
      if (result?.data?.job) await processJob(result.data.job);
      else if (result?.error && !result.error.includes('Chưa cấu hình')) setBadge('Bridge chưa kết nối', 'error');
      else if (!result?.error) setBadge('Sẵn sàng nhận prompt', 'ready');
    } catch {
      setBadge('Bridge chưa sẵn sàng', 'error');
    } finally {
      polling = false;
    }
  }

  function addHud() {
    if (document.getElementById('gps-bridge-hud')) return;
    const div = document.createElement('div');
    div.id = 'gps-bridge-hud';
    Object.assign(div.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '999999',
      display: 'flex',
      alignItems: 'center',
      gap: '9px',
      padding: '9px 12px',
      borderRadius: '12px',
      background: '#161c2b',
      border: '1px solid #6a65a3',
      color: '#e5e7f3',
      font: '11px system-ui,sans-serif',
      boxShadow: '0 9px 34px #0005',
      maxWidth: '370px'
    });
    hudText = document.createElement('span');
    hudText.textContent = 'Project Studio · chưa ghép nối';
    const button = document.createElement('button');
    button.textContent = 'Gửi phản hồi';
    button.title = 'Gửi câu trả lời Gemini gần nhất về Studio';
    Object.assign(button.style, {
      color: 'white',
      background: '#655ed5',
      border: '0',
      borderRadius: '6px',
      padding: '7px 9px',
      cursor: 'pointer',
      font: '11px system-ui,sans-serif'
    });
    button.addEventListener('click', () => capture(true));
    const diagBtn = document.createElement('button');
    diagBtn.textContent = 'Kiểm tra bộ chọn';
    diagBtn.title = 'Kiểm tra các bộ chọn DOM của Gemini (không gửi gì, không đọc nội dung chat)';
    Object.assign(diagBtn.style, {
      color: '#e5e7f3',
      background: '#2b3350',
      border: '1px solid #6a65a3',
      borderRadius: '6px',
      padding: '7px 9px',
      cursor: 'pointer',
      font: '11px system-ui,sans-serif'
    });
    diagBtn.addEventListener('click', () => toggleDiagnostics(div));
    div.append(hudText, button, diagBtn);
    document.body.append(div);
  }

  // ---- Chẩn đoán bộ chọn (Giai đoạn 2, mục 1) ----
  let lastDiagnostics = null;
  function runDiagnostics() {
    const report = S.diagnose(document, { isVisible: visible, pathname: location.pathname });
    report.hints = S.collectHints(document, { isVisible: visible, viewportHeight: window.innerHeight });
    report.userAgent = navigator.userAgent;
    report.lang = document.documentElement.lang || '';
    lastDiagnostics = report;
    return report;
  }
  function toggleDiagnostics(hud) {
    let panel = document.getElementById('gps-bridge-diag');
    if (panel) { panel.remove(); return; }
    const report = runDiagnostics();
    panel = document.createElement('div');
    panel.id = 'gps-bridge-diag';
    Object.assign(panel.style, {
      position: 'fixed', right: '16px', bottom: '72px', zIndex: '999999', width: '460px', maxWidth: 'calc(100vw - 32px)',
      maxHeight: '60vh', overflow: 'auto', padding: '10px 12px', borderRadius: '12px', background: '#161c2b',
      border: '1px solid #6a65a3', color: '#e5e7f3', font: '11px/1.5 system-ui,sans-serif', boxShadow: '0 9px 34px #0005'
    });
    const title = document.createElement('div');
    title.textContent = 'Kiểm tra bộ chọn Gemini (' + (report.coreOk ? 'ô nhập OK' : 'KHÔNG tìm thấy ô nhập') + ')';
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    const pre = document.createElement('pre');
    pre.textContent = S.formatReport(report);
    Object.assign(pre.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0 0 8px', font: '11px/1.5 ui-monospace,monospace' });
    const note = document.createElement('div');
    note.textContent = 'Báo cáo chỉ gồm tên selector/thuộc tính giao diện, không có nội dung chat. Nhãn chứa "@" bị ẩn.';
    note.style.opacity = '0.7';
    note.style.marginBottom = '8px';
    const copy = document.createElement('button');
    copy.textContent = 'Sao chép báo cáo (JSON)';
    Object.assign(copy.style, { color: 'white', background: '#655ed5', border: '0', borderRadius: '6px', padding: '7px 9px', cursor: 'pointer', font: '11px system-ui,sans-serif', marginRight: '6px' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(lastDiagnostics, null, 2)); copy.textContent = 'Đã sao chép ✓'; }
      catch (_) {
        // Content script chạy trong "isolated world" nên Console của trang không thấy biến; hiện JSON để chọn + Ctrl+C.
        copy.textContent = 'Không tự sao chép được · chọn hết ô bên dưới rồi Ctrl+C';
        const ta = document.createElement('textarea');
        ta.value = JSON.stringify(lastDiagnostics, null, 2);
        ta.readOnly = true;
        Object.assign(ta.style, { display: 'block', width: '100%', height: '120px', marginTop: '8px', background: '#0e1320', color: '#e5e7f3', font: '10px ui-monospace,monospace' });
        panel.append(ta);
        ta.focus();
        ta.select();
      }
    });
    const rerun = document.createElement('button');
    rerun.textContent = 'Chạy lại';
    Object.assign(rerun.style, { color: '#e5e7f3', background: '#2b3350', border: '1px solid #6a65a3', borderRadius: '6px', padding: '7px 9px', cursor: 'pointer', font: '11px system-ui,sans-serif' });
    rerun.addEventListener('click', () => { panel.remove(); toggleDiagnostics(hud); });
    panel.append(title, pre, note, copy, rerun);
    document.body.append(panel);
  }

  function extractTargetFile(code, preEl) {
    const lines = code.split('\n');
    for (let j = 0; j < Math.min(lines.length, 5); j++) {
      const line = lines[j].trim();
      const match = line.match(/^(?:\/\/|#|\/\*|--)\s*(?:FILE|File|file|ĐƯỜNG DẪN|Đường dẫn):\s*([^\r\n*]+?)(?:\*\/)?$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    // Check preceding text elements
    let prev = preEl.previousElementSibling;
    let attempts = 0;
    while (prev && attempts < 3) {
      const text = prev.textContent || '';
      const match = text.match(/`([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]{1,10})`/) || text.match(/(?:file|tệp|tạo|sửa)\s*[:`'"]*([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]{1,10})/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      prev = prev.previousElementSibling;
      attempts++;
    }
    return '';
  }

  function injectVibeCodeButtons() {
    const codeBlocks = S.findCodeBlocks(document).els;
    codeBlocks.forEach(block => {
      if (block.querySelector('.gps-vibe-btn') || block.classList.contains('gps-vibe-injected')) return;
      
      const codeEl = block.querySelector('code') || block;
      const fullCode = (codeEl.innerText || codeEl.textContent || '').trim();
      if (!fullCode || fullCode.length < 10) return;

      const targetFile = extractTargetFile(fullCode, block);
      block.classList.add('gps-vibe-injected');

      const btn = document.createElement('button');
      btn.className = 'gps-vibe-btn';
      const targetBasename = targetFile ? (targetFile.split('/').pop().split('\\').pop()) : '';
      btn.innerHTML = targetFile ? `⚡ Đề xuất ghi vào <b>${targetBasename}</b>` : `⚡ Đề xuất ghi vào Project`;
      btn.title = targetFile ? `Gửi đề xuất ghi ${targetFile} sang Studio (bạn xem diff và duyệt trước khi ghi)` : `Gửi đề xuất ghi file sang Studio (bạn xem diff và duyệt trước khi ghi)`;

      Object.assign(btn.style, {
        position: 'absolute',
        top: '6px',
        right: '48px',
        zIndex: '15',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        background: '#4f46e5',
        color: '#ffffff',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: '6px',
        padding: '3px 8px',
        fontSize: '11px',
        fontWeight: '600',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'all 0.15s ease',
        lineHeight: '1.4'
      });

      // Ensure container has relative positioning
      const computedPos = window.getComputedStyle(block).position;
      if (computedPos === 'static') {
        block.style.position = 'relative';
      }

      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#4338ca';
        btn.style.transform = 'scale(1.02)';
      });
      btn.addEventListener('mouseleave', () => {
        if (!btn.disabled) btn.style.background = '#4f46e5';
        btn.style.transform = 'scale(1)';
      });

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        let dest = targetFile;
        if (!dest) {
          dest = prompt('Nhập đường dẫn file trong project (ví dụ: src/App.tsx):', '');
          if (!dest || !dest.trim()) return;
          dest = dest.trim();
        }

        let cleanCode = fullCode;
        const lines = cleanCode.split('\n');
        if (lines[0]?.trim().match(/^(?:\/\/|#|\/\*|--)\s*(?:FILE|File|file|ĐƯỜNG DẪN):\s*[^\r\n*]+/i)) {
          cleanCode = lines.slice(1).join('\n');
        }

        btn.disabled = true;
        btn.textContent = '⏳ Đang ghi...';
        btn.style.background = '#d97706';

        try {
          const resp = await api({ type: 'GPS_WRITE_FILE', path: dest, content: cleanCode });
          if (resp?.error) throw new Error(resp.error);
          // Không ghi trực tiếp: Studio hiện diff và chờ bạn bấm Duyệt.
          btn.innerHTML = `✓ Đã gửi đề xuất cho <b>${dest.split('/').pop()}</b> · duyệt trong Studio`;
          btn.style.background = '#059669';
          setBadge('Đề xuất ghi file đang chờ bạn duyệt trong Studio', 'ready');
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = targetFile ? `⚡ Đề xuất ghi vào <b>${targetBasename}</b>` : `⚡ Đề xuất ghi vào Project`;
            btn.style.background = '#4f46e5';
          }, 3500);
        } catch (err) {
          setBadge('Không gửi được đề xuất: ' + (err.message || String(err)), 'error');
          btn.disabled = false;
          btn.innerHTML = `❌ Lỗi`;
          btn.style.background = '#dc2626';
          setTimeout(() => {
            btn.innerHTML = targetFile ? `⚡ Đề xuất ghi vào <b>${targetBasename}</b>` : `⚡ Đề xuất ghi vào Project`;
            btn.style.background = '#4f46e5';
          }, 3000);
        }
      });

      block.appendChild(btn);
    });
  }

  addHud();
  setInterval(poll, 800);
  setInterval(() => { capture(false).catch(() => {}); }, 750);
  setInterval(injectVibeCodeButtons, 1200);
  void poll();
})();
