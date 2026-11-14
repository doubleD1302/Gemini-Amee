'use strict';
/**
 * Diff theo dòng (LCS) tạo ra unified diff ngắn gọn để người dùng duyệt thay đổi.
 * Không phụ thuộc thư viện ngoài. Với file rất lớn sẽ rơi về chế độ "thay toàn bộ".
 */
const MAX_CELLS = 4_000_000;

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => l.replace(/\r$/, ''));
}

function lineOps(a, b) {
  // Cắt phần đầu/cuối giống nhau để DP chỉ chạy trên phần khác biệt.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', s: a[i] });
  if (midA.length * midB.length > MAX_CELLS) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const n = midA.length, m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ t: ' ', s: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', s: midA[i] }); i++; }
      else { ops.push({ t: '+', s: midB[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', s: midA[i++] });
    while (j < m) ops.push({ t: '+', s: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', s: a[i] });
  return ops;
}

function unifiedDiff(oldText, newText, { context = 3, label = 'file', maxLines = 400 } = {}) {
  const a = splitLines(oldText || ''), b = splitLines(newText || '');
  const ops = lineOps(a, b);
  let added = 0, removed = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
  if (!added && !removed) return { diff: '', added, removed, changed: false };

  // Gom thành hunk có `context` dòng ngữ cảnh.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.t === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let oldLine = 1, newLine = 1, idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].t !== '+') oldLine++;
      if (ops[idx].t !== '-') newLine++;
      idx++;
      continue;
    }
    const startOld = oldLine, startNew = newLine;
    const body = [];
    let oc = 0, nc = 0;
    while (idx < ops.length && keep[idx]) {
      const o = ops[idx];
      body.push(o.t + o.s);
      if (o.t !== '+') { oldLine++; oc++; }
      if (o.t !== '-') { newLine++; nc++; }
      idx++;
    }
    out.push(`@@ -${startOld},${oc} +${startNew},${nc} @@`);
    out.push(...body);
  }
  let diff = out;
  let truncated = false;
  if (out.length > maxLines) { diff = out.slice(0, maxLines); truncated = true; }
  return { diff: diff.join('\n') + (truncated ? `\n… (diff cắt bớt, còn ${out.length - maxLines} dòng)` : ''), added, removed, changed: true };
}

module.exports = { unifiedDiff, splitLines };
