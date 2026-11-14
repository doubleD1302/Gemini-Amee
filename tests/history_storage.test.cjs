'use strict';
// Biên dịch THẲNG src/utils/historyStorage.ts (không viết lại logic) để kiểm thử bản thật.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');

function loadModule(localStorage) {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/historyStorage.ts'), 'utf8');
  const out = ts.transpileModule(src, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const mod = {exports: {}};
  new Function('module', 'exports', 'localStorage', 'console', out)(mod, mod.exports, localStorage, console);
  return mod.exports;
}
function fakeStorage(limitChars = Infinity) {
  const data = new Map();
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { if (v.length > limitChars) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } data.set(k, v); },
    removeItem: k => data.delete(k)
  };
}
const session = (id, updatedAt, msgs) => ({id, title: id, createdAt: updatedAt, updatedAt, messages: msgs});
const msg = (i, big) => ({id: 'm' + i, role: i % 2 ? 'assistant' : 'user', text: 'hello ' + i, preparedPrompt: big ? 'P'.repeat(big) : undefined});

test('long prepared prompts are dropped from old messages but kept for the latest ones', () => {
  const m = loadModule(fakeStorage());
  const s = session('a', 1, Array.from({length: 6}, (_, i) => msg(i, 40000)));
  const [slim] = m.pruneSessionsForStorage([s]);
  assert.equal(slim.messages.filter(x => x.preparedPrompt).length, 2);
  assert.equal(slim.messages[5].preparedPrompt.length, 40000);
  assert.equal(slim.messages[0].preparedPrompt, undefined);
  assert.equal(s.messages[0].preparedPrompt.length, 40000, 'must not mutate the in-memory session');
});

test('oldest sessions are evicted when over budget; the newest session is never dropped', () => {
  const m = loadModule(fakeStorage());
  const sessions = [session('new', 300, [msg(0, 0)]), session('mid', 200, [msg(0, 0)]), session('old', 100, [msg(0, 0)])];
  sessions.forEach(s => { s.messages[0].text = 'x'.repeat(2000); });
  const kept = m.pruneSessionsForStorage(sessions, 4500).map(s => s.id);
  assert.deepEqual(kept.sort(), ['mid', 'new']);
  assert.deepEqual(m.pruneSessionsForStorage(sessions, 10).map(s => s.id), ['new'], 'always keeps at least the newest');
});

test('saveChatSessions survives a small quota by pruning instead of losing everything', () => {
  const store = fakeStorage(150_000);
  const m = loadModule(store);
  const sessions = Array.from({length: 40}, (_, i) => session('s' + i, i + 1, Array.from({length: 4}, (_, k) => msg(k, 20000))));
  m.saveChatSessions(sessions);
  const loaded = m.loadChatSessions();
  assert(loaded.length > 0, 'history must still be saved');
  assert.equal(loaded[0].id, 's39', 'most recent session first');
});
