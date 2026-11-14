'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('extension content.js contains multi-language send selectors including Vietnamese', () => {
  // Selector đã chuyển sang extension/selectors.js (Giai đoạn 2 mục 1); kiểm tra trên cả hai file.
  const contentScript = ['selectors.js', 'content.js'].map(f => fs.readFileSync(path.join(__dirname, '../extension', f), 'utf8')).join('\n');

  // Multi-language send selectors
  assert.ok(contentScript.includes('button[aria-label*="Gửi" i]'), 'Must support Vietnamese aria-label="Gửi"');
  assert.ok(contentScript.includes('button[aria-label*="Send" i]'), 'Must support English aria-label="Send"');
  assert.ok(contentScript.includes('div[class*="send-button-container"] button'), 'Must support send-button-container wrapper');
  assert.ok(contentScript.includes('data-test-id="send-button"') || contentScript.includes('data-testid="send-button"'), 'Must support test IDs');

  // Retry polling & fallback mechanism
  assert.ok(contentScript.includes('waitForSendButton'), 'Must wait for button asynchronously');
  assert.ok(contentScript.includes('triggerEnter'), 'Must have Enter key trigger fallback');
  assert.ok(contentScript.includes('ClipboardEvent'), 'Must support synthetic clipboard paste for Quill');

  // Multi-language stop generating selectors
  assert.ok(contentScript.includes('button[aria-label*="Dừng" i]'), 'Must detect Vietnamese Stop button');
});
