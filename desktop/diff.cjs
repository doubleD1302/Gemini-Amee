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

/**
 * Phân tích unified diff (do unifiedDiff tạo ra) thành hunk có số dòng cũ/mới cho từng dòng.
 * Bỏ qua dòng tiêu đề ---/+++ và mọi dòng lạ (ví dụ ghi chú "diff cắt bớt").
 * @returns {{header:string, oldStart:number, newStart:number, lines:{t:' '|'+'|'-', s:string, o:number|null, n:number|null}[]}[]}
 */
function parseUnified(text) {
  const hunks = [];
  let cur = null, o = 0, n = 0;
  for (const raw of String(text || '').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      o = Number(m[1]); n = Number(m[2]);
      cur = { header: raw, oldStart: o, newStart: n, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // tiêu đề ---/+++ nằm trước hunk đầu tiên; trong hunk, "--- x" là dòng xoá "-- x" hợp lệ
    const t = raw[0];
    if (t === ' ') { cur.lines.push({ t, s: raw.slice(1), o, n }); o++; n++; }
    else if (t === '-') { cur.lines.push({ t, s: raw.slice(1), o, n: null }); o++; }
    else if (t === '+') { cur.lines.push({ t, s: raw.slice(1), o: null, n }); n++; }
    // dòng khác (ví dụ "… (diff cắt bớt …)") bị bỏ qua
  }
  return hunks;
}

/**
 * Căn hàng cho diff cạnh nhau: mỗi cụm "-" liền "+" được ghép đôi từng dòng (k='chg'),
 * phần dư là xoá thuần ('del') hoặc thêm thuần ('add'); dòng giữ nguyên là 'ctx'.
 * @returns {{header:string, rows:{k:'ctx'|'chg'|'del'|'add', l:{n:number,s:string}|null, r:{n:number,s:string}|null}[]}[]}
 */
function sideBySide(hunks) {
  return hunks.map(h => {
    const rows = [];
    let i = 0;
    const L = x => ({ n: x.o, s: x.s });
    const R = x => ({ n: x.n, s: x.s });
    while (i < h.lines.length) {
      const ln = h.lines[i];
      if (ln.t === ' ') { rows.push({ k: 'ctx', l: L(ln), r: R(ln) }); i++; continue; }
      const dels = [], adds = [];
      while (i < h.lines.length && h.lines[i].t === '-') dels.push(h.lines[i++]);
      while (i < h.lines.length && h.lines[i].t === '+') adds.push(h.lines[i++]);
      const pairs = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const d = dels[k], a = adds[k];
        rows.push({ k: d && a ? 'chg' : d ? 'del' : 'add', l: d ? L(d) : null, r: a ? R(a) : null });
      }
    }
    return { header: h.header, rows };
  });
}

/** Số dòng (theo file MỚI) của thay đổi đầu tiên; dùng để mở editor đúng chỗ. 1 nếu không có hunk. */
function firstChangedLine(hunks) {
  for (const h of hunks) {
    let lastNew = h.newStart;
    for (const ln of h.lines) {
      if (ln.t === '+') return ln.n;
      if (ln.t === '-') return ln.n === null ? lastNew : ln.n;
      if (ln.n !== null) lastNew = ln.n + 1;
    }
  }
  return 1;
}

/** Từ văn bản unified diff → dữ liệu hiển thị cạnh nhau + dòng thay đổi đầu tiên. */
function diffExtras(diffText) {
  const hunks = parseUnified(diffText);
  return { view: sideBySide(hunks), line: firstChangedLine(hunks) };
}

module.exports = { unifiedDiff, splitLines, parseUnified, sideBySide, firstChangedLine, diffExtras };
