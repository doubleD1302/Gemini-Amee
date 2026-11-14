'use strict';
// Ghép extension/selectors.js + đoạn chạy chẩn đoán thành MỘT script dán được vào DevTools Console
// của tab gemini.google.com (Console chạy ở "main world" nên không thấy biến của extension).
// Dùng: node scripts/make-diagnostic-snippet.cjs  → docs/diagnose-gemini-dom.js
const fs = require('node:fs');
const path = require('node:path');

const RUNNER = `
;(() => {
  const S = globalThis.__gpsSelectors;
  const report = S.diagnose(document, { pathname: location.pathname });
  report.hints = S.collectHints(document, { viewportHeight: window.innerHeight });
  report.userAgent = navigator.userAgent;
  report.lang = document.documentElement.lang || '';
  console.log('=== Kiểm tra bộ chọn Gemini ===\\n' + S.formatReport(report));
  const json = JSON.stringify(report, null, 2);
  try { copy(json); console.log('Đã sao chép báo cáo JSON vào clipboard — dán lại cho Claude.'); }
  catch (_) { console.log(json); console.log('Không có hàm copy(): chọn JSON ở trên và sao chép thủ công.'); }
  return report;
})();
`;

function build() {
  const src = fs.readFileSync(path.join(__dirname, '../extension/selectors.js'), 'utf8');
  return '/* Tự sinh bởi scripts/make-diagnostic-snippet.cjs — đừng sửa tay. */\n' + src + RUNNER;
}

module.exports = { build };

if (require.main === module) {
  const out = path.join(__dirname, '../docs/diagnose-gemini-dom.js');
  fs.writeFileSync(out, build());
  console.log('Đã ghi ' + out);
}
