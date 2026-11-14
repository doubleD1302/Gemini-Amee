'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../extension/selectors.js');
const { build } = require('../scripts/make-diagnostic-snippet.cjs');

// ---- DOM giả: "scope" trả phần tử theo đúng chuỗi selector (kiểm thử logic chọn ứng viên, KHÔNG kiểm thử CSS engine).
function el(opts = {}) {
  const attrs = opts.attrs || {};
  return {
    tagName: (opts.tag || 'div').toUpperCase(),
    textContent: opts.text || '',
    parentElement: opts.parent || null,
    _closest: opts.closest || {},
    _table: opts.table || {},
    getBoundingClientRect: () => (opts.visible === false ? { width: 0, height: 0, top: 0 } : { width: 10, height: 10, top: opts.top == null ? 700 : opts.top }),
    getAttribute: n => (n in attrs ? attrs[n] : null),
    closest(sel) {
      const parts = sel.split(',').map(x => x.trim());
      for (const k of Object.keys(this._closest)) if (parts.includes(k)) return this._closest[k];
      return null;
    },
    querySelector(sel) { return (this._table[sel] || [])[0] || null; },
    querySelectorAll(sel) { return this._table[sel] || []; }
  };
}
function doc(table) {
  return {
    querySelectorAll(sel) {
      const v = table[sel];
      if (v instanceof Error) throw v;
      return v || [];
    }
  };
}

const finders = { composer: S.findComposer, stopButton: S.findStopButton, newChat: S.findNewChat };

test('SELECTORS: every list is non-empty, free of duplicates and has balanced brackets/quotes', () => {
  for (const [k, v] of Object.entries(S.SELECTORS)) {
    const list = Array.isArray(v) ? v : [v];
    assert.ok(list.length > 0, k);
    if (Array.isArray(v)) assert.equal(new Set(v).size, v.length, `duplicate selector in ${k}`);
    for (const s of list) {
      if (typeof s !== 'string') continue;
      assert.equal((s.match(/\[/g) || []).length, (s.match(/\]/g) || []).length, `unbalanced [] in ${s}`);
      assert.equal((s.match(/"/g) || []).length % 2, 0, `odd quotes in ${s}`);
    }
  }
  for (const t of S.TARGETS) assert.ok(Array.isArray(S.SELECTORS[t.key]), `TARGETS.${t.key} has no selector list`);
});

for (const key of Object.keys(finders)) {
  test(`each ${key} candidate works on its own (fallback chain)`, () => {
    S.SELECTORS[key].forEach((sel, i) => {
      const node = el();
      const hit = finders[key](doc({ [sel]: [node] }));
      assert.ok(hit, `${key} candidate #${i} (${sel}) not found`);
      assert.equal(hit.index, i);
      assert.equal(hit.selector, sel);
      assert.equal(hit.el, node);
    });
    assert.equal(finders[key](doc({})), null);
  });
}

test('invisible elements are skipped and the next candidate wins', () => {
  const [a, b] = S.SELECTORS.composer;
  const hit = S.findComposer(doc({ [a]: [el({ visible: false })], [b]: [el()] }));
  assert.equal(hit.selector, b);
});

test('responses / content / code blocks: first matching candidate, no double counting', () => {
  const [r1, r2] = S.SELECTORS.response;
  const a = el();
  const b = el();
  const res = S.findResponses(doc({ [r1]: [a, b], [r2]: [a, b] }));
  assert.equal(res.els.length, 2);
  assert.equal(res.index, 0);
  assert.equal(S.findResponses(doc({ [r2]: [a] })).index, 1);
  S.SELECTORS.responseContent.forEach((sel, i) => {
    const content = el();
    const hit = S.findResponseContent(el({ table: { [sel]: [content] } }));
    assert.equal(hit.index, i);
    assert.equal(hit.el, content);
  });
  S.SELECTORS.codeBlock.forEach((sel, i) => assert.equal(S.findCodeBlocks(doc({ [sel]: [el()] })).index, i));
});

test('sendButton: every candidate is found globally (no composer)', () => {
  S.SELECTORS.sendButton.forEach((sel, i) => {
    const btn = el({ tag: 'button' });
    const hit = S.findSendButton(doc({ [sel]: [btn] }), { composer: null });
    assert.ok(hit, `send candidate #${i} (${sel}) not found`);
    assert.equal(hit.via, 'global:selector');
    assert.equal(hit.selector, sel);
    assert.equal(hit.el, btn);
  });
});

test('sendButton prefers the composer container, then icon, then last non-mic button', () => {
  const sel = S.SELECTORS.sendButton[4];
  const inside = el({ tag: 'button' });
  const outside = el({ tag: 'button' });
  const container = el({ table: { [sel]: [inside] } });
  const composer = el({ closest: { 'rich-textarea': container } });
  let hit = S.findSendButton(doc({ [sel]: [outside] }), { composer });
  assert.equal(hit.el, inside);
  assert.equal(hit.via, 'container:selector');

  const btn = el({ tag: 'button' });
  const icon = el({ tag: 'mat-icon', text: 'send', closest: { 'button': btn } });
  const c2 = el({ table: { [S.SELECTORS.sendIconSelector]: [icon] } });
  hit = S.findSendButton(doc({}), { composer: el({ closest: { form: c2 } }) });
  assert.equal(hit.via, 'container:icon');
  assert.equal(hit.el, btn);

  const mic = el({ tag: 'button', attrs: { 'aria-label': 'Microphone' } });
  const attach = el({ tag: 'button', attrs: { 'aria-label': 'Thêm tệp' } });
  const plain = el({ tag: 'button', attrs: { 'aria-label': 'Foo' } });
  const c3 = el({ table: { 'button, [role="button"]': [plain, attach, mic] } });
  hit = S.findSendButton(doc({}), { composer: el({ closest: { form: c3 } }) });
  assert.equal(hit.via, 'container:last-button');
  assert.equal(hit.el, plain);
});

test('a selector that throws is reported as an error instead of crashing', () => {
  const bad = S.SELECTORS.composer[0];
  const good = S.SELECTORS.composer[1];
  const d = doc({ [bad]: new Error('is not a valid selector'), [good]: [el()] });
  assert.equal(S.findComposer(d).selector, good);
  const rep = S.diagnose(d);
  assert.equal(rep.results.composer.tried[0].error, 'is not a valid selector');
  assert.match(S.formatReport(rep), /✓ Ô nhập/);
});

test('diagnose on an empty page names every failed target and explains conditional ones', () => {
  const rep = S.diagnose(doc({}), { pathname: '/app/abc123' });
  assert.equal(rep.coreOk, false);
  assert.equal(rep.path, '/app/<id>');
  for (const t of S.TARGETS) {
    const r = rep.results[t.key];
    assert.equal(r.ok, false, t.key);
    assert.equal(r.tried.length, S.SELECTORS[t.key].length, t.key);
    assert.ok(r.tried.every(x => x.matches === 0));
  }
  const text = S.formatReport(rep);
  for (const t of S.TARGETS) assert.ok(text.includes('✗ ' + t.label + ': 0/' + S.SELECTORS[t.key].length), t.label);
  assert.match(text, /Nút Gửi.*gõ vài ký tự/);
  assert.match(text, /Nút Dừng.*đang trả lời/);
});

test('diagnose tells which candidate won and which failed', () => {
  const sels = S.SELECTORS.composer;
  const rep = S.diagnose(doc({ [sels[2]]: [el()] }));
  const c = rep.results.composer;
  assert.equal(c.ok, true);
  assert.equal(c.winner.index, 2);
  assert.deepEqual(c.tried.map(t => t.matches), sels.map((_, i) => (i === 2 ? 1 : 0)));
  assert.equal(rep.coreOk, true);
  assert.match(S.formatReport(rep), /✓ Ô nhập \(composer\): .*ứng viên #3\/6/);
});

test('diagnose with a full page marks all targets ok', () => {
  const t = {
    [S.SELECTORS.composer[0]]: [el()],
    [S.SELECTORS.sendButton[0]]: [el({ tag: 'button' })],
    [S.SELECTORS.stopButton[0]]: [el({ tag: 'button' })],
    [S.SELECTORS.response[0]]: [el({ table: { [S.SELECTORS.responseContent[0]]: [el()] } })],
    [S.SELECTORS.codeBlock[0]]: [el()],
    [S.SELECTORS.newChat[0]]: [el()]
  };
  const rep = S.diagnose(doc(t));
  for (const k of Object.keys(rep.results)) assert.equal(rep.results[k].ok, true, k);
  assert.equal(rep.results.response.count, 1);
});

test('collectHints redacts labels containing "@" and never reads chat text', () => {
  const secret = el({ tag: 'button', attrs: { 'aria-label': 'Google Account: Ten (a@b.com)' }, top: 750, text: 'NOI DUNG CHAT BI MAT' });
  const send = el({ tag: 'button', attrs: { 'aria-label': 'Gửi tin nhắn', 'data-test-id': 'send-btn' }, top: 760 });
  const top = el({ tag: 'button', attrs: { 'aria-label': 'Menu chinh' }, top: 10 });
  const hints = S.collectHints(doc({
    '*': [el({ tag: 'rich-textarea' }), el({ tag: 'model-response' }), send],
    'button, [role="button"]': [secret, send, top]
  }), { viewportHeight: 800 });
  const json = JSON.stringify(hints);
  assert.ok(!json.includes('a@b.com'));
  assert.ok(!json.includes('NOI DUNG'));
  assert.ok(!json.includes('Menu chinh'), 'buttons in the top half are excluded');
  assert.ok(json.includes('Gửi tin nhắn'));
  assert.ok(hints.customElements.includes('model-response×1'));
  assert.deepEqual(hints.testIds, ['send-btn']);
});

test('standalone console snippet runs in a fresh context and copies a JSON report', () => {
  let copied = '';
  const logs = [];
  const d = doc({ [S.SELECTORS.composer[1]]: [el()] });
  d.documentElement = { lang: 'vi' };
  const sandbox = {
    document: d,
    location: { pathname: '/app/xyz' },
    window: { innerHeight: 800 },
    navigator: { userAgent: 'test' },
    console: { log: m => logs.push(String(m)) },
    copy: s => { copied = s; }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(build(), sandbox);
  assert.match(logs.join('\n'), /Kiểm tra bộ chọn Gemini/);
  assert.match(logs.join('\n'), /✓ Ô nhập/);
  const rep = JSON.parse(copied);
  assert.equal(rep.coreOk, true);
  assert.equal(rep.path, '/app/<id>');
  assert.equal(rep.lang, 'vi');
  assert.ok(Array.isArray(rep.hints.bottomButtons));
});

test('committed docs/diagnose-gemini-dom.js is up to date with selectors.js', () => {
  const committed = fs.readFileSync(path.join(__dirname, '../docs/diagnose-gemini-dom.js'), 'utf8');
  assert.equal(committed, build(), 'run: node scripts/make-diagnostic-snippet.cjs');
});

test('manifest loads selectors.js before content.js and content.js no longer hard-codes selectors', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('selectors.js') >= 0 && js.indexOf('selectors.js') < js.indexOf('content.js'));
  const content = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(content));
  assert.ok(!/querySelectorAll\(['"`](?:model-response|button\[|\.ql-editor)/.test(content));
  assert.ok(content.includes('Kiểm tra bộ chọn'));
});
