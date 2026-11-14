'use strict';

const input = document.getElementById('pair');
const status = document.getElementById('status');
const statusBadge = document.getElementById('statusBadge');
const badgeText = document.getElementById('badgeText');
const btnQuickPaste = document.getElementById('btnQuickPaste');
const btnOpenGemini = document.getElementById('openGemini');

function updateStatus(text, type = 'normal') {
  status.textContent = text;
  status.className = 'status-msg';
  if (type === 'success') {
    status.classList.add('success');
    statusBadge.classList.add('connected');
    badgeText.textContent = 'Đã kết nối';
  } else if (type === 'error') {
    status.classList.add('error');
    statusBadge.classList.remove('connected');
    badgeText.textContent = 'Lỗi kết nối';
  } else {
    statusBadge.classList.remove('connected');
    badgeText.textContent = 'Chưa kết nối';
  }
}

async function checkConnection() {
  updateStatus('Đang kiểm tra kết nối với Studio Desktop...');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GPS_PING' });
    if (result?.error) throw new Error(result.error);
    const d = result?.data || {};
    if (d.protocol && d.extensionProtocol && d.protocol > d.extensionProtocol) {
      updateStatus('Đã kết nối nhưng extension (v' + d.extensionVersion + ') CŨ hơn Studio (v' + d.version + '). Chạy cap-nhat-extension.bat hoặc chép lại thư mục extension, rồi bấm Reload ở chrome://extensions.', 'error');
    } else if (d.protocol && d.extensionProtocol && d.protocol < d.extensionProtocol) {
      updateStatus('Đã kết nối nhưng Studio (v' + d.version + ') CŨ hơn extension (v' + d.extensionVersion + '). Hãy cập nhật ứng dụng Studio.', 'error');
    } else {
      updateStatus('✓ Đã kết nối với Gemini Project Studio' + (d.version ? ' v' + d.version : '') + '! Giữ tab Gemini Web mở để bắt đầu hỏi.', 'success');
    }
  } catch (err) {
    updateStatus('Chưa kết nối: ' + String(err.message || err), 'error');
  }
}

async function savePairing(text) {
  try {
    const cleanText = (text || '').trim();
    if (!cleanText) throw new Error('Vui lòng dán mã kết nối từ Studio.');
    let pairing;
    try {
      pairing = JSON.parse(cleanText);
    } catch {
      // Auto-recovery: If user accidentally copied/pasted incomplete JSON or missing braces
      const urlMatch = cleanText.match(/http:\/\/127\.0\.0\.1:\d+/);
      const tokenMatch = cleanText.match(/[0-9a-fA-F]{64}/);
      if (urlMatch && tokenMatch) {
        pairing = { url: urlMatch[0], token: tokenMatch[0] };
        input.value = JSON.stringify(pairing, null, 2);
      } else {
        throw new Error('Dữ liệu JSON không hợp lệ. Vui lòng bấm "Copy mã kết nối (Pairing JSON)" trong Studio rồi dán lại.');
      }
    }
    const url = new URL(pairing.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || !(/^[0-9a-f]{64}$/i.test(pairing.token))) {
      throw new Error('URL hoặc mã xác thực (token) không hợp lệ');
    }
    await chrome.storage.local.set({ pairing: { url: url.origin, token: pairing.token } });
    await checkConnection();
  } catch (err) {
    updateStatus('Lỗi định dạng: ' + String(err.message || err), 'error');
  }
}

// Load saved pairing
chrome.storage.local.get('pairing').then(data => {
  if (data.pairing) {
    input.value = JSON.stringify(data.pairing, null, 2);
    void checkConnection();
  }
});

// Event Listeners
document.getElementById('save').addEventListener('click', () => {
  void savePairing(input.value);
});

document.getElementById('check').addEventListener('click', () => {
  void checkConnection();
});

document.getElementById('reloadExt')?.addEventListener('click', () => {
  chrome.runtime.reload();
  window.close();
});

// Tự động bôi đen toàn bộ khi click vào ô nhập để tránh dán đè dở dang
input.addEventListener('focus', () => {
  input.select();
});

btnQuickPaste.addEventListener('click', async () => {
  try {
    const clipText = await navigator.clipboard.readText();
    if (clipText && (clipText.includes('127.0.0.1') || clipText.match(/[0-9a-fA-F]{64}/))) {
      input.value = clipText;
      await savePairing(clipText);
    } else {
      updateStatus('Bộ nhớ tạm không chứa mã kết nối hợp lệ. Hãy bấm "Copy pairing JSON" trong Studio trước.', 'error');
    }
  } catch {
    updateStatus('Không thể đọc bộ nhớ tạm tự động. Hãy dùng Ctrl+V để dán.', 'error');
  }
});

btnOpenGemini.addEventListener('click', () => {
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url: 'https://gemini.google.com/app' });
  } else {
    window.open('https://gemini.google.com/app', '_blank');
  }
});
