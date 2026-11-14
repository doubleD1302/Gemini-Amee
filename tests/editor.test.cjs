'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EDITORS, editorTarget, openInEditor, encodePath, cleanLine } = require('../desktop/editor.cjs');

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function proj(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-editor-'));
  cleanup.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('builds a vscode:// URL with the real path and the changed line', () => {
  const root = proj({ 'src/a.ts': 'x' });
  const t = editorTarget({ root, rel: 'src/a.ts', line: 12, editor: 'vscode' });
  assert.equal(t.kind, 'url');
  assert.equal(t.line, 12);
  const real = fs.realpathSync(path.join(root, 'src', 'a.ts')).replace(/\\/g, '/');
  const expectPath = real.startsWith('/') ? real.slice(1) : real;
  assert.ok(t.url.startsWith('vscode://file/'), t.url);
  assert.ok(t.url.endsWith(':12:1'), t.url);
  assert.equal(decodeURIComponent(t.url.slice('vscode://file/'.length, -':12:1'.length)), expectPath);
  for (const [id, scheme] of [['cursor', 'cursor'], ['windsurf', 'windsurf'], ['vscodium', 'vscodium'], ['vscode-insiders', 'vscode-insiders']]) {
    assert.ok(editorTarget({ root, rel: 'src/a.ts', editor: id }).url.startsWith(scheme + '://file/'), id);
  }
});

test('path segments are percent-encoded (spaces, #, ?, unicode) but a Windows drive colon is kept', () => {
  assert.equal(encodePath('C:\\Users\\Nguyễn Văn\\my proj\\a#b?.ts'), 'C:/Users/Nguy%E1%BB%85n%20V%C4%83n/my%20proj/a%23b%3F.ts');
  assert.equal(encodePath('/home/me/a b/c.ts'), '/home/me/a%20b/c.ts');
  const root = proj({ 'dir with space/tệp #1.ts': 'x' });
  const t = editorTarget({ root, rel: 'dir with space/tệp #1.ts', line: 3 });
  assert.ok(!/[ #?]/.test(t.url.replace('://', '')), t.url);
});

test('"default" editor returns the real path for shell.openPath; unknown editors cannot inject a scheme', () => {
  const root = proj({ 'a.ts': 'x' });
  const d = editorTarget({ root, rel: 'a.ts', editor: 'default' });
  assert.equal(d.kind, 'path');
  assert.equal(d.path, fs.realpathSync(path.join(root, 'a.ts')));
  for (const evil of ['javascript', 'file', 'http', 'vscode://x', '__proto__', 'constructor', '']) {
    const t = editorTarget({ root, rel: 'a.ts', editor: evil });
    assert.equal(t.editor, 'vscode', evil);
    assert.ok(t.url.startsWith('vscode://file/'));
  }
  assert.ok(Object.values(EDITORS).every(e => e.scheme === null || /^[a-z-]+$/.test(e.scheme)));
});

test('line numbers are sanitized', () => {
  assert.equal(cleanLine(7.9), 7);
  assert.equal(cleanLine('15'), 15);
  assert.equal(cleanLine(0), 1);
  assert.equal(cleanLine(-5), 1);
  assert.equal(cleanLine(NaN), 1);
  assert.equal(cleanLine(undefined), 1);
  assert.equal(cleanLine(1e12), 1_000_000);
  const root = proj({ 'a.ts': 'x' });
  const garbage = editorTarget({ root, rel: 'a.ts', line: '3; rm -rf /' });
  assert.ok(garbage.url.endsWith(':1:1'), 'non-numeric input falls back to line 1 and never reaches the URL');
  assert.ok(!garbage.url.includes('rm -rf') && !garbage.url.includes(';'));
});

test('refuses files outside the project, missing files, directories and empty paths', () => {
  const root = proj({ 'src/a.ts': 'x' });
  const outside = path.join(path.dirname(root), 'secret-outside.txt');
  fs.writeFileSync(outside, 's');
  cleanup.push(outside);
  assert.throws(() => editorTarget({ root, rel: '../secret-outside.txt' }));
  assert.throws(() => editorTarget({ root, rel: outside }));
  assert.throws(() => editorTarget({ root, rel: 'src/missing.ts' }));
  assert.throws(() => editorTarget({ root, rel: 'src' }));
  assert.throws(() => editorTarget({ root, rel: '' }), /Thiếu đường dẫn/);
  assert.throws(() => editorTarget({ root, rel: undefined }), /Thiếu đường dẫn/);
});

test('openInEditor: opens the URL; falls back to the default app when the URL fails; reports total failure', async () => {
  const root = proj({ 'a.ts': 'x' });
  const calls = [];
  const ok = { openExternal: async u => { calls.push(['url', u]); }, openPath: async p => { calls.push(['path', p]); return ''; } };
  let r = await openInEditor(ok, { root, rel: 'a.ts', line: 4, editor: 'cursor' });
  assert.deepEqual([r.opened, r.fallback, r.editor, r.line], ['url', false, 'cursor', 4]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].startsWith('cursor://file/'));

  calls.length = 0;
  const noEditor = { openExternal: async () => { throw new Error('no handler'); }, openPath: async p => { calls.push(['path', p]); return ''; } };
  r = await openInEditor(noEditor, { root, rel: 'a.ts', line: 4, editor: 'vscode' });
  assert.deepEqual([r.opened, r.fallback], ['path', true]);
  assert.equal(calls[0][1], fs.realpathSync(path.join(root, 'a.ts')));

  const broken = { openExternal: async () => { throw new Error('x'); }, openPath: async () => 'Failed to open' };
  r = await openInEditor(broken, { root, rel: 'a.ts', editor: 'vscode' });
  assert.equal(r.opened, 'none');
  assert.match(r.error, /Failed to open/);

  const def = { openExternal: async () => { throw new Error('must not be called'); }, openPath: async p => { calls.push(['p', p]); return ''; } };
  r = await openInEditor(def, { root, rel: 'a.ts', editor: 'default' });
  assert.deepEqual([r.opened, r.fallback], ['path', false]);
});
