'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unifiedDiff, parseUnified, sideBySide, firstChangedLine, diffExtras } = require('../desktop/diff.cjs');

const lines = (...l) => l.join('\n') + '\n';
const diffOf = (a, b) => unifiedDiff(a, b, { label: 'f.txt' }).diff;

test('parseUnified gives every line its old/new line numbers', () => {
  const oldT = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
  const newT = lines('a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k');
  const hunks = parseUnified(diffOf(oldT, newT));
  assert.ok(hunks.length >= 1);
  const ln = hunks.flatMap(h => h.lines);
  const del = ln.find(x => x.t === '-');
  const add = ln.find(x => x.t === '+' && x.s === 'C');
  assert.deepEqual([del.s, del.o, del.n], ['c', 3, null]);
  assert.deepEqual([add.s, add.o, add.n], ['C', null, 3]);
  const tail = ln.filter(x => x.t === '+').pop();
  assert.deepEqual([tail.s, tail.n], ['k', 11]);
});

test('parseUnified ignores headers and the truncation note; a deleted "-- x" line is not mistaken for a header', () => {
  const oldT = lines('-- comment', 'select 1;');
  const newT = lines('select 1;');
  const hunks = parseUnified(diffOf(oldT, newT) + '\n… (diff cắt bớt, còn 12 dòng)');
  const dels = hunks.flatMap(h => h.lines).filter(x => x.t === '-');
  assert.deepEqual(dels.map(x => x.s), ['-- comment']);
  assert.equal(hunks.flatMap(h => h.lines).some(x => /diff cắt bớt/.test(x.s)), false);
  assert.deepEqual(parseUnified(''), []);
  assert.deepEqual(parseUnified('not a diff at all'), []);
});

test('sideBySide pairs changed lines, leaves unmatched ones empty on the other side, keeps context on both', () => {
  const oldT = lines('keep1', 'old1', 'old2', 'old3', 'keep2');
  const newT = lines('keep1', 'new1', 'keep2');
  const [h] = sideBySide(parseUnified(diffOf(oldT, newT)));
  const kinds = h.rows.map(r => r.k);
  assert.deepEqual(kinds, ['ctx', 'chg', 'del', 'del', 'ctx']);
  const chg = h.rows[1];
  assert.deepEqual([chg.l.s, chg.r.s], ['old1', 'new1']);
  assert.equal(h.rows[2].r, null);
  assert.equal(h.rows[0].l.s, 'keep1');
  assert.equal(h.rows[0].r.s, 'keep1');

  const [h2] = sideBySide(parseUnified(diffOf(lines('x'), lines('x', 'y', 'z'))));
  assert.deepEqual(h2.rows.map(r => r.k), ['ctx', 'add', 'add']);
  assert.ok(h2.rows.slice(1).every(r => r.l === null && r.r));
});

test('property: every side-by-side cell points at the right line of the old/new file', () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 40; round++) {
    const oldL = Array.from({ length: 5 + rnd(40) }, (_, i) => 'l' + i);
    const newL = oldL.slice();
    for (let k = 0; k < 1 + rnd(5); k++) {
      const at = rnd(newL.length + 1), op = rnd(3);
      if (op === 0) newL.splice(at, 0, 'ins' + round + k);
      else if (op === 1 && newL.length) newL.splice(Math.min(at, newL.length - 1), 1);
      else if (newL.length) newL[Math.min(at, newL.length - 1)] = 'chg' + round + k;
    }
    const oldT = oldL.join('\n') + '\n', newT = newL.join('\n') + '\n';
    const d = unifiedDiff(oldT, newT, { label: 'p', maxLines: 100000 });
    if (!d.changed) continue;
    const view = sideBySide(parseUnified(d.diff));
    for (const h of view) for (const r of h.rows) {
      if (r.l) assert.equal(oldL[r.l.n - 1], r.l.s, `old line ${r.l.n}`);
      if (r.r) assert.equal(newL[r.r.n - 1], r.r.s, `new line ${r.r.n}`);
      if (r.k === 'ctx') assert.equal(r.l.s, r.r.s);
      if (r.k === 'chg') assert.ok(r.l && r.r);
    }
    // Phần bên phải (không rỗng) ghép lại phải chứa mọi dòng đã thêm/đổi.
    const rightAll = view.flatMap(h => h.rows).filter(r => r.r).map(r => r.r.n);
    assert.equal(new Set(rightAll).size, rightAll.length, 'no duplicated new-line numbers');
  }
});

test('firstChangedLine points at the first changed line of the NEW file', () => {
  const base = Array.from({ length: 30 }, (_, i) => 'l' + (i + 1));
  const withEdit = (i, v) => { const x = base.slice(); x[i] = v; return x.join('\n') + '\n'; };
  const T = base.join('\n') + '\n';
  assert.equal(firstChangedLine(parseUnified(diffOf(T, withEdit(14, 'X')))), 15);
  assert.equal(firstChangedLine(parseUnified(diffOf(T, withEdit(0, 'X')))), 1);
  assert.equal(firstChangedLine(parseUnified(diffOf(T, T + 'tail\n'))), 31);
  const del = base.slice(0, 9).concat(base.slice(10)).join('\n') + '\n';   // xoá dòng 10
  assert.equal(firstChangedLine(parseUnified(diffOf(T, del))), 10);
  assert.equal(firstChangedLine([]), 1);
});

test('diffExtras returns view + line; new-file diffs are all additions', () => {
  const ex = diffExtras(diffOf('', lines('a', 'b')));
  assert.equal(ex.line, 1);
  assert.deepEqual(ex.view[0].rows.map(r => r.k), ['add', 'add']);
  assert.ok(ex.view[0].rows.every(r => r.l === null));
  assert.deepEqual(diffExtras(''), { view: [], line: 1 });
});
