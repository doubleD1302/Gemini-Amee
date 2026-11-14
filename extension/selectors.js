'use strict';
/**
 * Bảng bộ chọn DOM của Gemini Web + logic tìm phần tử + chẩn đoán.
 * - Toàn bộ selector nằm trong SELECTORS (mỗi mục là danh sách ứng viên theo thứ tự ưu tiên).
 * - Các hàm find* nhận `doc` (document hoặc đối tượng giả có querySelectorAll) nên test được không cần jsdom.
 * - diagnose() thử TỪNG ứng viên và báo cái nào khớp/không khớp/lỗi cú pháp.
 * Lưu ý: các selector vẫn là phỏng đoán cho tới khi chạy trên Gemini thật — chạy "Kiểm tra bộ chọn".
 */
(function (root) {
  const SELECTORS = {
    composer: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"]',
      'textarea[aria-label*="prompt" i]'
    ],
    // Vùng bao quanh ô nhập, dùng để giới hạn tìm nút Gửi (closest).
    composerContainer: ['.chat-input-container', '.input-area-container', '.input-area', 'rich-textarea', 'form'],
    // UI của chính extension (HUD, nút "Đề xuất ghi"): KHÔNG BAO GIỜ được coi là phần tử của Gemini.
    // Lỗi thật đã gặp: nút HUD có title "Gửi câu trả lời…" bị khớp nhầm thành nút Gửi của Gemini.
    ownUi: '#gps-bridge-hud, #gps-bridge-diag, .gps-vibe-btn',
    // Nút Gửi và nút Dừng của Gemini có thể là CÙNG một nút (đổi nhãn khi đang tạo câu trả lời).
    stopLabelParts: ['stop', 'ngừng', 'dừng'],
    sendButton: [
      '[data-test-id="send-button-container"] button',
      'div[class*="send-button-container"] button',
      'div[class*="send-button-container"] [role="button"]',
      'button.send-button',
      'button[class*="send-button"]',
      'button[data-test-id="send-button"]',
      'button[data-testid="send-button"]',
      'button[data-test-id*="send"]',
      'button[data-testid*="send"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send" i]',
      'button[title*="Send" i]',
      'button[mattooltip*="Send" i]',
      'button[aria-label*="Gửi" i]',
      'button[title*="Gửi" i]',
      'button[mattooltip*="Gửi" i]',
      'button[aria-label*="Envoyer" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label*="Senden" i]',
      'button[aria-label*="送信" i]',
      'button[aria-label*="发送" i]',
      'button[aria-label*="發送" i]',
      'button[aria-label*="보내기" i]',
      'button[aria-label*="전송" i]',
      'button[aria-label*="Отправить" i]',
      'button[aria-label*="Invia" i]',
      'button[aria-label*="Submit" i]',
      '[role="button"][aria-label*="Send" i]',
      '[role="button"][aria-label*="Gửi" i]',
      '[role="button"][data-test-id*="send"]'
    ],
    // Dự phòng theo biểu tượng (mat-icon "send") và "nút cuối cùng không phải mic/đính kèm".
    sendIconSelector: 'mat-icon, .google-symbols, svg',
    sendIconTexts: ['send', 'send_spark'],
    sendIconNameIncludes: 'send',
    sendExcludeLabels: ['mic', 'audio', 'upload', 'file', 'attach', 'thêm', 'tệp', 'tải lên', 'giọng nói', 'công cụ', 'chế độ', 'tool', 'voice', 'mode', 'settings', 'cài đặt', 'ngừng', 'stop', 'dừng'],
    stopButton: [
      // Đã xác nhận trên Gemini tiếng Việt: aria-label "Ngừng tạo câu trả lời".
      'button[aria-label*="Ngừng tạo" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Dừng" i]',
      'button[title*="Stop" i]',
      'button[title*="Dừng" i]',
      'button[data-test-id*="stop"]',
      'button[data-testid*="stop"]',
      'button[aria-label*="Arrêter" i]',
      'button[aria-label*="Detener" i]',
      'button[aria-label*="停止" i]'
    ],
    response: ['model-response', '[data-test-id="model-response"]'],
    responseContent: ['message-content', '.model-response-text', '.markdown', '.markdown-main-panel'],
    newChat: [
      '[data-test-id="new-chat-button"]',
      'a[data-test-id="new-chat-button"]',
      'button[aria-label*="New chat" i]',
      'a[aria-label*="New chat" i]',
      '[aria-label*="Cuộc trò chuyện mới" i]',
      '[aria-label*="Chat mới" i]',
      'a[href="/app"]',
      'a[href$="/app"]'
    ],
    codeBlock: ['model-response pre', '.model-response-text pre', 'message-content pre', 'code-block'],
    // Đính kèm ảnh (Giai đoạn 2, mục 7). TOÀN BỘ ứng viên dưới đây là PHỎNG ĐOÁN, chưa kiểm chứng trên Gemini thật.
    // Xem trước tệp đã đính kèm trong vùng soạn tin (dùng để xác nhận upload thành công bằng cách đếm).
    attachmentPreview: [
      'uploader-file-preview',
      'uploader-file-preview-container [data-test-id*="preview"]',
      '[data-test-id*="file-preview"]',
      '[data-test-id*="image-preview"]',
      '.file-preview-container [role="listitem"]',
      '.attachment-preview',
      '[class*="file-preview"]',
      '[class*="image-preview"]'
    ],
    fileInput: ['input[type="file"]']
  };

  // Mô tả từng mục để HUD giải thích khi không tìm thấy.
  const TARGETS = [
    { key: 'composer', label: 'Ô nhập (composer)', needs: '' },
    { key: 'sendButton', label: 'Nút Gửi', needs: 'Nút Gửi thường chỉ hiện khi ô nhập có chữ — gõ vài ký tự rồi kiểm tra lại.' },
    { key: 'stopButton', label: 'Nút Dừng', needs: 'Chỉ hiện khi Gemini đang trả lời — bấm kiểm tra ngay khi nó đang viết.' },
    { key: 'response', label: 'Khối trả lời', needs: 'Cần có ít nhất một câu trả lời của Gemini trong chat.' },
    { key: 'responseContent', label: 'Nội dung trả lời', needs: 'Cần có ít nhất một câu trả lời của Gemini trong chat.' },
    { key: 'codeBlock', label: 'Khối code', needs: 'Cần có câu trả lời chứa khối code.' },
    { key: 'newChat', label: 'Nút chat mới', needs: 'Có thể nằm trong thanh bên đang thu gọn.' }
  ];

  function defaultVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // querySelectorAll không ném lỗi ra ngoài: selector sai cú pháp được ghi nhận.
  function safeAll(scope, selector) {
    try {
      return { list: Array.from(scope.querySelectorAll(selector)), error: '' };
    } catch (e) {
      return { list: [], error: String((e && e.message) || e) };
    }
  }

  /** Ứng viên đầu tiên có phần tử (đã lọc hiển thị). reverse: lấy phần tử cuối. */
  function isOwnUi(el) {
    try { return !!(el && typeof el.closest === 'function' && el.closest(SELECTORS.ownUi)); } catch (_) { return false; }
  }

  function labelOf(el) {
    const g = n => (el && typeof el.getAttribute === 'function' && el.getAttribute(n)) || '';
    return (g('aria-label') + ' ' + g('title') + ' ' + g('mattooltip')).toLowerCase();
  }

  function isStopLike(el) {
    const label = labelOf(el);
    return SELECTORS.stopLabelParts.some(x => label.includes(x));
  }

  function findFirst(scope, candidates, { isVisible = defaultVisible, reverse = false, requireVisible = true, accept = null } = {}) {
    for (let i = 0; i < candidates.length; i++) {
      let list = safeAll(scope, candidates[i]).list.filter(e => !isOwnUi(e));
      if (accept) list = list.filter(accept);
      if (requireVisible) list = list.filter(isVisible);
      if (reverse) list = list.slice().reverse();
      if (list.length) return { el: list[0], selector: candidates[i], index: i };
    }
    return null;
  }

  function findComposer(doc, opts) {
    return findFirst(doc, SELECTORS.composer, opts);
  }

  /** Danh sách khối trả lời theo ứng viên đầu tiên có kết quả (không gộp để tránh đếm đôi). */
  function findResponses(doc) {
    const hit = findFirst(doc, SELECTORS.response, { requireVisible: false });
    if (!hit) return { els: [], selector: '', index: -1 };
    return { els: safeAll(doc, hit.selector).list, selector: hit.selector, index: hit.index };
  }

  function findResponseContent(responseEl) {
    if (!responseEl) return null;
    return findFirst(responseEl, SELECTORS.responseContent, { requireVisible: false });
  }

  function findStopButton(doc, opts) {
    return findFirst(doc, SELECTORS.stopButton, opts);
  }

  /**
   * Nút chat mới. Khi thanh bên đang thu gọn, nút vẫn có trong DOM nhưng không hiển thị
   * (quan sát thật: khớp nhưng visible=0) → dự phòng: lấy phần tử ẩn đầu tiên (via = 'hidden').
   */
  function findNewChat(doc, opts) {
    const hit = findFirst(doc, SELECTORS.newChat, opts);
    if (hit) return hit;
    const hidden = findFirst(doc, SELECTORS.newChat, Object.assign({}, opts, { requireVisible: false }));
    return hidden ? Object.assign(hidden, { via: 'hidden' }) : null;
  }

  function findCodeBlocks(doc) {
    const hit = findFirst(doc, SELECTORS.codeBlock, { requireVisible: false });
    return hit ? { els: safeAll(doc, hit.selector).list, selector: hit.selector, index: hit.index } : { els: [], selector: '', index: -1 };
  }

  /**
   * Số xem trước tệp đính kèm đang có trong vùng soạn tin (0 nếu không thấy). Chỉ dùng ứng viên khớp ĐẦU TIÊN
   * để không đếm đôi (một xem trước thường khớp nhiều selector lồng nhau). Không tính UI của extension.
   */
  function countAttachmentPreviews(doc, opts = {}) {
    const scope = opts.scope || doc;
    for (const sel of SELECTORS.attachmentPreview) {
      const list = safeAll(scope, sel).list.filter(e => !isOwnUi(e));
      if (list.length) return list.length;
    }
    return 0;
  }

  /** Các <input type=file> trong trang (thường bị ẩn; không yêu cầu hiển thị). */
  function findFileInputs(doc) {
    const out = [];
    for (const sel of SELECTORS.fileInput) for (const e of safeAll(doc, sel).list) if (!isOwnUi(e) && !out.includes(e)) out.push(e);
    return out;
  }

  function isIconSend(icon) {
    const text = (icon.textContent || '').trim().toLowerCase();
    const iconName = ((icon.getAttribute && icon.getAttribute('data-mat-icon-name')) || '').toLowerCase();
    return SELECTORS.sendIconTexts.includes(text) || (iconName && iconName.includes(SELECTORS.sendIconNameIncludes));
  }

  /**
   * Nút Gửi. Trả về { el, via, selector } hoặc null.
   * via: container:selector | container:icon | container:last-button | global:selector | global:icon
   */
  function findSendButton(doc, opts = {}) {
    const isVisible = opts.isVisible || defaultVisible;
    const notStop = el => !isStopLike(el);
    const composer = opts.composer !== undefined ? opts.composer : (findComposer(doc, { isVisible }) || {}).el || null;
    let container = null;
    if (composer) {
      try { container = composer.closest(SELECTORS.composerContainer.join(', ')); } catch (_) { container = null; }
      if (!container) container = composer.parentElement && composer.parentElement.parentElement && composer.parentElement.parentElement.parentElement;
    }

    if (container) {
      const hit = findFirst(container, SELECTORS.sendButton, { isVisible, accept: notStop });
      if (hit) return { el: hit.el, via: 'container:selector', selector: hit.selector };
      for (const icon of safeAll(container, SELECTORS.sendIconSelector).list) {
        if (isIconSend(icon)) {
          const btn = icon.closest && icon.closest('button, [role="button"]');
          if (btn && isVisible(btn) && notStop(btn)) return { el: btn, via: 'container:icon', selector: SELECTORS.sendIconSelector };
        }
      }
      // Heuristic cuối: nút có nhãn, không thuộc nhóm mic/đính kèm/công cụ/dừng. Nút KHÔNG nhãn bị bỏ qua
      // (Gemini có nhiều nút không nhãn trong vùng nhập; bấm nhầm còn tệ hơn không tìm thấy).
      const buttons = safeAll(container, 'button, [role="button"]').list.filter(e => !isOwnUi(e) && isVisible(e)).reverse();
      const cand = buttons.find(b => {
        const label = labelOf(b).trim();
        return label && !SELECTORS.sendExcludeLabels.some(x => label.includes(x));
      });
      if (cand) return { el: cand, via: 'container:last-button', selector: 'button, [role="button"]' };
    }

    const hit = findFirst(doc, SELECTORS.sendButton, { isVisible, reverse: true, accept: notStop });
    if (hit) return { el: hit.el, via: 'global:selector', selector: hit.selector };
    for (const icon of safeAll(doc, SELECTORS.sendIconSelector).list.reverse()) {
      if (isIconSend(icon)) {
        const btn = icon.closest && icon.closest('button, [role="button"]');
        if (btn && isVisible(btn) && !isOwnUi(btn) && notStop(btn)) return { el: btn, via: 'global:icon', selector: SELECTORS.sendIconSelector };
      }
    }
    return null;
  }

  // ---- Chẩn đoán -----------------------------------------------------------

  function tryAll(scope, candidates, isVisible) {
    return candidates.map(selector => {
      const { list: raw, error } = safeAll(scope, selector);
      const list = raw.filter(e => !isOwnUi(e)); // không đếm UI của chính extension
      return { selector, matches: list.length, visible: list.filter(isVisible).length, error };
    });
  }

  function targetEntry(target, tried, winner, extra = {}) {
    return Object.assign({
      key: target.key,
      label: target.label,
      ok: !!winner,
      winner: winner ? { selector: winner.selector, index: winner.index, via: winner.via || 'selector' } : null,
      candidates: tried.length,
      tried,
      note: winner ? '' : target.needs
    }, extra);
  }

  /** Chạy toàn bộ kiểm tra. doc = document (hoặc giả). Không có tác dụng phụ lên trang. */
  function diagnose(doc, opts = {}) {
    const isVisible = opts.isVisible || defaultVisible;
    const results = {};
    const by = Object.fromEntries(TARGETS.map(t => [t.key, t]));

    const composer = findComposer(doc, { isVisible });
    results.composer = targetEntry(by.composer, tryAll(doc, SELECTORS.composer, isVisible), composer);

    const send = findSendButton(doc, { isVisible, composer: composer ? composer.el : null });
    results.sendButton = targetEntry(by.sendButton, tryAll(doc, SELECTORS.sendButton, isVisible), send && { selector: send.selector, index: SELECTORS.sendButton.indexOf(send.selector), via: send.via });

    const stop = findStopButton(doc, { isVisible });
    results.stopButton = targetEntry(by.stopButton, tryAll(doc, SELECTORS.stopButton, isVisible), stop);

    const resp = findResponses(doc);
    results.response = targetEntry(by.response, tryAll(doc, SELECTORS.response, () => true), resp.els.length ? { selector: resp.selector, index: resp.index } : null, { count: resp.els.length });

    const lastResp = resp.els[resp.els.length - 1];
    const content = lastResp ? findResponseContent(lastResp) : null;
    results.responseContent = targetEntry(by.responseContent, lastResp ? tryAll(lastResp, SELECTORS.responseContent, () => true) : SELECTORS.responseContent.map(selector => ({ selector, matches: 0, visible: 0, error: '' })), content);

    const code = findCodeBlocks(doc);
    results.codeBlock = targetEntry(by.codeBlock, tryAll(doc, SELECTORS.codeBlock, () => true), code.els.length ? { selector: code.selector, index: code.index } : null, { count: code.els.length });

    const nc = findNewChat(doc, { isVisible });
    results.newChat = targetEntry(by.newChat, tryAll(doc, SELECTORS.newChat, isVisible), nc);

    return {
      version: 1,
      at: new Date().toISOString(),
      path: sanitizePath(opts.pathname),
      results,
      // Mục cốt lõi để gửi tự động chạy được: ô nhập + nút Gửi (hoặc dự phòng Enter) + khối trả lời.
      coreOk: results.composer.ok
    };
  }

  function sanitizePath(p) {
    return String(p || '').replace(/\/app\/[A-Za-z0-9_-]+/, '/app/<id>').replace(/\/u\/\d+/, '/u/<n>');
  }

  /** Báo cáo dạng chữ (HUD + sao chép). Không chứa nội dung chat. */
  function formatReport(report) {
    const lines = [];
    for (const t of TARGETS) {
      const r = report.results[t.key];
      if (!r) continue;
      if (r.ok) {
        const via = r.winner.via && r.winner.via !== 'selector' ? ` (dự phòng: ${r.winner.via})` : ` (ứng viên #${r.winner.index + 1}/${r.candidates})`;
        lines.push(`✓ ${r.label}: ${r.winner.selector}${via}`);
      } else {
        const bad = r.tried.filter(x => x.error).length;
        lines.push(`✗ ${r.label}: 0/${r.candidates} ứng viên khớp${bad ? `, ${bad} selector lỗi cú pháp` : ''}${r.note ? ' — ' + r.note : ''}`);
      }
    }
    return lines.join('\n');
  }

  function scrub(s, max = 60) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (s.includes('@')) return '[ẩn]';
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /**
   * "Khung xương" HTML của một khối trả lời: chỉ tag, data-test-id, role, tối đa 3 class — KHÔNG có chữ.
   * Dùng để đối chiếu md.js (chuyển DOM → Markdown) với cấu trúc Gemini thật.
   * Ưu tiên khối trả lời có khối code; anh em cùng tag lặp quá 3 lần được gộp thành "…×N".
   */
  function skeletonOf(root) {
    const lines = [];
    const MAX_LINES = 220, MAX_DEPTH = 14;
    const kidsOf = n => (n && n.children ? Array.from(n.children) : []);
    function desc(n) {
      const g = a => (n.getAttribute && n.getAttribute(a)) || '';
      let d = String(n.tagName || '?').toLowerCase();
      const id = g('data-test-id'); if (id) d += '#' + scrub(id, 40);
      const role = g('role'); if (role) d += '[role=' + scrub(role, 20) + ']';
      const cls = g('class').split(/\s+/).filter(Boolean).slice(0, 3).map(c => scrub(c, 30));
      if (cls.length) d += '.' + cls.join('.');
      return d;
    }
    function walk(n, depth) {
      if (lines.length >= MAX_LINES) return;
      lines.push('  '.repeat(depth) + desc(n));
      if (depth >= MAX_DEPTH) return;
      const kids = kidsOf(n);
      let i = 0;
      while (i < kids.length && lines.length < MAX_LINES) {
        let j = i;
        while (j < kids.length && kids[j].tagName === kids[i].tagName) j++;
        const run = j - i;
        const show = run > 3 ? 2 : run;
        for (let k = 0; k < show; k++) walk(kids[i + k], depth + 1);
        if (run > show) lines.push('  '.repeat(depth + 1) + '…×' + (run - show) + ' ' + String(kids[i].tagName || '').toLowerCase() + ' nữa');
        i = j;
      }
    }
    walk(root, 0);
    return lines;
  }

  function collectResponseSkeleton(doc) {
    const resp = findResponses(doc).els;
    if (!resp.length) return [];
    const withCode = resp.slice().reverse().find(r => safeAll(r, 'pre, code-block').list.length > 0);
    // Gốc là message-content (phần md.js đọc), không phải model-response: bọc ngoài quá sâu (>10 tầng) và không liên quan.
    const target = withCode || resp[resp.length - 1];
    const content = findResponseContent(target);
    return skeletonOf(content ? content.el : target);
  }

  /**
   * Gợi ý cấu trúc DOM khi selector thất bại: tên custom element, data-test-id, và các nút ở nửa dưới màn hình.
   * Chỉ thu thuộc tính giao diện, KHÔNG thu nội dung chat; nhãn có '@' bị ẩn.
   */
  function collectHints(doc, opts = {}) {
    const isVisible = opts.isVisible || defaultVisible;
    const vh = opts.viewportHeight || 800;
    const all = safeAll(doc, '*').list.slice(0, 4000);
    const tags = {};
    const testIds = new Set();
    for (const el of all) {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag.includes('-')) tags[tag] = (tags[tag] || 0) + 1;
      const id = el.getAttribute && el.getAttribute('data-test-id');
      if (id) testIds.add(scrub(id, 80));
    }
    const buttons = safeAll(doc, 'button, [role="button"]').list.filter(b => !isOwnUi(b)).filter(isVisible).filter(b => {
      const r = b.getBoundingClientRect();
      return r.top > vh * 0.5;
    }).slice(0, 40).map(b => {
      const g = n => scrub(b.getAttribute && b.getAttribute(n));
      const icon = b.querySelector && b.querySelector('mat-icon, .google-symbols');
      return { tag: String(b.tagName || '').toLowerCase(), ariaLabel: g('aria-label'), title: g('title'), testId: g('data-test-id'), cls: scrub(b.getAttribute && b.getAttribute('class'), 80), icon: icon ? scrub(icon.textContent, 20) : '' };
    });
    const editables = safeAll(doc, '[contenteditable="true"], textarea').list.slice(0, 10).map(e => ({
      tag: String(e.tagName || '').toLowerCase(), role: scrub(e.getAttribute && e.getAttribute('role')), ariaLabel: scrub(e.getAttribute && e.getAttribute('aria-label')), cls: scrub(e.getAttribute && e.getAttribute('class'), 80), visible: isVisible(e)
    }));
    return {
      customElements: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([tag, n]) => `${tag}×${n}`),
      testIds: Array.from(testIds).slice(0, 60),
      editables,
      bottomButtons: buttons,
      responseSkeleton: collectResponseSkeleton(doc)
    };
  }

  const api = { SELECTORS, TARGETS, findFirst, findComposer, findResponses, findResponseContent, findStopButton, findNewChat, findCodeBlocks, findSendButton, countAttachmentPreviews, findFileInputs, diagnose, formatReport, collectHints, collectResponseSkeleton, skeletonOf, isOwnUi, isStopLike, defaultVisible };
  root.__gpsSelectors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
