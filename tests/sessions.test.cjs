'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const { SessionStore, sanitizeSession, VERSION } = require('../desktop/sessions.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }

/* ---------- SessionStore ---------- */
const sample = (over = {}) => ({
  savedAt: 1700000000000,
  run: { id: 'run_1', goal: 'Đổi a thành 2', status: 'waiting_approval', turn: 2, conversationUrl: 'https://gemini.google.com/app/abc', error: '', question: '' },
  steps: [{ id: 's1', at: 1, type: 'info', text: 'Mục tiêu: x' }, { id: 's2', at: 2, type: 'tool', tool: 'edit_file', label: 'src/a.ts', status: 'waiting_approval', diff: '+a' }],
  digest: ['read_file src/a.ts → ok'],
  meter: { chars: 1234, turns: 3, chatIndex: 2, rotations: 1 },
  ledger: { changed: [['src/a.ts', { created: false, ops: { edit_file: 2 } }]], read: ['src/a.ts'], commands: [{ cmd: 'npm test', ok: false, exit: 1 }], failures: [['npm test', 'FAIL']], rejected: [], userMessages: [], lastNote: 'Tiếp theo: README' },
  expiredApprovals: [{ tool: 'edit_file', label: 'src/a.ts', summary: 's', source: 'agent' }],
  ...over
});

test('SessionStore saves atomically per project and loads back a normalized session', () => {
  const store = new SessionStore(path.join(tmp('gps-sess-'), 'sessions'));
  store.save('/proj/one', sample());
  store.save('/proj/two', sample({ run: { ...sample().run, goal: 'khác' } }));
  const a = store.load('/proj/one');
  assert.equal(a.run.goal, 'Đổi a thành 2');
  assert.equal(a.steps.length, 2);
  assert.equal(a.meter.chatIndex, 2);
  assert.deepEqual(a.ledger.changed[0], ['src/a.ts', { created: false, ops: { edit_file: 2 } }]);
  assert.equal(store.load('/proj/two').run.goal, 'khác');
  assert.equal(store.load('/proj/none'), null);
  const leftovers = fs.readdirSync(path.dirname(store._file('/proj/one'))).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
  store.clear('/proj/one');
  assert.equal(store.load('/proj/one'), null);
  assert.ok(store.load('/proj/two'));
});

test('SessionStore rejects corrupt, wrong-version, wrong-root or oversized files instead of crashing', () => {
  const store = new SessionStore(path.join(tmp('gps-sess-'), 's'));
  store.save('/p', sample());
  const file = store._file('/p');
  fs.writeFileSync(file, '{ not json');
  assert.equal(store.load('/p'), null);
  fs.writeFileSync(file, JSON.stringify({ ...sample(), version: VERSION + 1, root: '/p' }));
  assert.equal(store.load('/p'), null);
  fs.writeFileSync(file, JSON.stringify({ ...sample(), version: VERSION, root: '/other' }));
  assert.equal(store.load('/p'), null, 'a session saved for another root is not offered');
  fs.writeFileSync(file, JSON.stringify({ ...sample(), version: VERSION, root: '/p', run: { id: 'x', goal: '   ' } }));
  assert.equal(store.load('/p'), null, 'empty goal is unusable');
  assert.throws(() => store.save('/p', sample({ steps: [{ id: 'big', at: 1, type: 'info', text: 'x' }], digest: new Array(5).fill('y'), meter: { chars: 1, turns: 1, chatIndex: 1, rotations: 0 }, junk: 'z'.repeat(7 * 1024 * 1024) })), /quá lớn/);
});

test('sanitizeSession drops unknown step types, clips long fields and ignores non-executable junk', () => {
  const s = sanitizeSession({
    version: VERSION, root: '/p', savedAt: 5,
    run: { id: 'r', goal: 'g', status: 'running', turn: -4 },
    steps: [{ id: 'a', at: 1, type: 'hack', text: 'x' }, { id: 'b', at: 2, type: 'tool', tool: 'run_command', label: 'rm -rf /', diff: 'd'.repeat(50000), status: 'waiting_approval', onload: 'evil()' }, 'junk', null],
    digest: [1, 'ok'], meter: { chars: 'NaN' },
    pending: [{ id: 'act_1', args: { command: 'rm -rf /' } }],
    policy: { autoEdits: true }
  });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].type, 'tool');
  assert.ok(s.steps[0].diff.length < 9000);
  assert.equal(s.steps[0].onload, undefined);
  assert.equal(s.run.turn, 0);
  assert.deepEqual(s.digest, ['ok']);
  assert.equal(s.meter.chars, 0);
  assert.equal('pending' in s, false, 'executable pending actions are never restored');
  assert.equal('policy' in s, false, 'auto-approve policy is never restored');
  assert.equal(sanitizeSession(null), null);
  assert.equal(sanitizeSession({ version: VERSION, run: {} }), null);
});

/* ---------- Runner: lưu bền + khôi phục ---------- */
function makeEnv({ base, store, script, files = true }) {
  const root = path.join(base, 'proj');
  if (files) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    if (!fs.existsSync(path.join(root, 'src', 'a.ts'))) fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  }
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(base, 'cp')), getRoot: () => root, sessions: store, detectChecks: () => [] });
  const turns = [];
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const info = { prompt: job.prompt, newChat: job.newChat, expectConversation: job.expectConversation };
    const idx = turns.push(info) - 1;
    setImmediate(async () => {
      if (job.status === 'cancelled') return;
      const answer = await script(info, idx);
      if (answer == null || job.status === 'cancelled') return;
      bridge.setJob(job, { status: 'final', answer, conversationUrl: `https://gemini.google.com/app/conv${job.newChat ? 'N' + turns.length : 'X'}` });
    });
  });
  return { root, runner, turns, bridge, file: rel => fs.readFileSync(path.join(root, rel), 'utf8') };
}
function until(runner, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => { const s = runner.snapshot(); if (pred(s)) { runner.removeListener('state', check); clearTimeout(t); resolve(s); } };
    const t = setTimeout(() => { runner.removeListener('state', check); reject(new Error('timeout; status=' + runner.snapshot().status)); }, ms);
    runner.on('state', check); check();
  });
}
const edit = (from, to) => call(`tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nexport const a = ${from};\n=======\nexport const a = ${to};\n>>>>>>> REPLACE`);

test('app closed while an approval is pending: restart restores the timeline, marks the approval EXPIRED and never executes it', async () => {
  const base = tmp('gps-sess-e2e-');
  const store = new SessionStore(path.join(base, 'sessions'));
  const A = makeEnv({ base, store, script: async (t, i) => (i === 0 ? `Sửa file.\n${edit(1, 2)}` : null) });
  A.runner.setPolicy({ autoEdits: true });                    // sẽ KHÔNG được khôi phục
  A.runner.setPolicy({ autoEdits: false });
  A.runner.start('Đổi a thành 2');
  const waiting = await until(A.runner, s => s.status === 'waiting_approval');
  const oldId = waiting.pending[0].id;
  assert.equal(A.runner.flushSession(), true);
  A.runner.dispose();                                          // "tắt app" khi chưa duyệt
  assert.equal(A.file('src/a.ts'), 'export const a = 1;\n');

  // Khởi động lại: runner mới, bridge mới, cùng thư mục lưu.
  const B = makeEnv({ base, store, script: async (t, i) => call('tool: finish\n---\nxong') });
  const prev = B.runner.previousSession();
  assert.equal(prev.goal, 'Đổi a thành 2');
  assert.equal(prev.interrupted, true);
  assert.equal(prev.expiredApprovals, 1);
  assert.equal(B.runner.snapshot().status, 'idle', 'nothing is restored until the user asks');

  const snap = B.runner.resume({ continueRun: false });
  assert.equal(snap.status, 'waiting_user');
  assert.equal(snap.goal, 'Đổi a thành 2');
  assert.equal(snap.pending.length, 0, 'no executable approval survives a restart');
  assert.equal(snap.policy.autoEdits, false);
  const toolStep = snap.steps.find(s => s.type === 'tool' && s.tool === 'edit_file');
  assert.equal(toolStep.status, 'expired');
  assert.ok(snap.steps.some(s => s.type === 'info' && /HẾT HẠN/.test(s.text) && /edit_file src\/a\.ts/.test(s.text)));
  await assert.rejects(() => B.runner.approve(oldId, 'approve'), /không còn tồn tại/);
  assert.equal(B.file('src/a.ts'), 'export const a = 1;\n', 'expired edit was never applied');
  assert.equal(B.runner.previousSession(), null, 'active in memory now');

  // Người dùng nhắn tiếp → chat Gemini MỚI kèm bản tóm tắt.
  B.runner.reply('hãy tiếp tục');
  await until(B.runner, s => s.status === 'done');
  assert.equal(B.turns[0].newChat, true);
  assert.equal(B.turns[0].expectConversation, null);
  assert.match(B.turns[0].prompt, /Đổi a thành 2/);
  assert.match(B.turns[0].prompt, /Tin nhắn mới từ người dùng:\nhãy tiếp tục/);
  assert.match(B.turns[0].prompt, /### edit_file/, 'system prompt rebuilt');
  assert.ok(B.runner.snapshot().steps.some(s => /Khôi phục phiên → mở chat Gemini mới/.test(s.text || '')));
  B.runner.dispose();
});

test('"Tiếp tục phiên trước" restores the ledger and continues in a new chat; auto-approve stays OFF and run_command still needs approval', async () => {
  const base = tmp('gps-sess-e2e-');
  const store = new SessionStore(path.join(base, 'sessions'));
  const A = makeEnv({ base, store, script: async (t, i) => (i === 0 ? `Mình sẽ sửa a rồi chạy test.\n${edit(1, 2)}` : i === 1 ? call('tool: ask_user\nquestion: tiếp theo làm gì?') : null) });
  A.runner.setPolicy({ autoEdits: true });
  A.runner.start('Đổi a thành 2 rồi chạy test');
  await until(A.runner, s => s.status === 'waiting_user');
  assert.equal(A.file('src/a.ts'), 'export const a = 2;\n');
  const checkpointsBefore = A.runner.listCheckpoints().length;
  A.runner.dispose();                                          // dispose = flush

  const B = makeEnv({ base, store, script: async (t, i) => (i === 0 ? call('tool: run_command\ncommand: node -e "process.exit(0)"') : call('tool: finish\n---\nxong')) });
  assert.equal(B.runner.policy.autoEdits, false);
  const prev = B.runner.previousSession();
  assert.deepEqual(prev.filesChanged, ['src/a.ts']);
  assert.equal(prev.interrupted, false);
  B.runner.resume({ continueRun: true });
  const w = await until(B.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending[0].kind, 'exec', 'run_command always needs approval, also after a restore');
  assert.equal(w.policy.autoEdits, false);
  // Lượt đầu sau khi khôi phục: chat mới + sổ tiến độ + mục tiêu + lời nhắn "ứng dụng vừa được mở lại".
  const first = B.turns[0];
  assert.equal(first.newChat, true);
  assert.match(first.prompt, /Đổi a thành 2 rồi chạy test/);
  assert.match(first.prompt, /File đã sửa\/tạo[\s\S]*- src\/a\.ts \(edit_file\)/);
  assert.match(first.prompt, /Ghi chú gần nhất[\s\S]*Mình sẽ sửa a rồi chạy test/);
  assert.match(first.prompt, /Ứng dụng vừa được mở lại/);
  await B.runner.approve(w.pending[0].id, 'approve');
  await until(B.runner, s => s.status === 'done');
  // Checkpoint của phiên trước vẫn còn (lưu theo project, ngoài project).
  assert.equal(B.runner.listCheckpoints().length, checkpointsBefore);
  B.runner.undo(B.runner.listCheckpoints()[0].id);
  assert.equal(B.file('src/a.ts'), 'export const a = 1;\n');
  B.runner.dispose();
});

test('state is saved shortly after changes (debounced) without an explicit flush, and outside the project folder', async () => {
  const base = tmp('gps-sess-e2e-');
  const store = new SessionStore(path.join(base, 'sessions'));
  const A = makeEnv({ base, store, script: async () => 'Chào bạn, mình cần thêm thông tin.' });
  A.runner.start('Mục tiêu debounce');
  await until(A.runner, s => s.status === 'waiting_user');
  await sleep(700);
  const saved = store.load(A.root);
  assert.ok(saved, 'written by the debounce timer');
  assert.equal(saved.run.goal, 'Mục tiêu debounce');
  assert.equal(saved.run.status, 'waiting_user');
  const inProject = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); inProject.push(path.relative(A.root, p)); if (e.isDirectory()) walk(p); } })(A.root);
  assert.deepEqual(inProject.sort(), ['src', path.join('src', 'a.ts')], 'no session files are created inside the user project');
  A.runner.dispose();
});

test('previousSession/resume/discard edge cases', async () => {
  const base = tmp('gps-sess-e2e-');
  const none = makeEnv({ base, store: null, script: async () => null });
  assert.equal(none.runner.previousSession(), null);
  assert.throws(() => none.runner.resume(), /Chưa bật lưu phiên/);
  none.runner.dispose();

  const store = new SessionStore(path.join(base, 'sessions'));
  const A = makeEnv({ base, store, script: async () => null });
  assert.equal(A.runner.previousSession(), null);
  assert.throws(() => A.runner.resume(), /Không có phiên trước/);
  store.save(A.root, sample());
  assert.equal(A.runner.previousSession().goal, 'Đổi a thành 2');
  A.runner.discardPrevious();
  assert.equal(A.runner.previousSession(), null);
  assert.equal(store.load(A.root), null);
  // Phiên của project khác không được đề nghị.
  store.save(path.join(base, 'other'), sample());
  assert.equal(A.runner.previousSession(), null);
  A.runner.dispose();
});

test('a session that already finished is restored as "done" for review, and expired vibe proposals are reported', async () => {
  const base = tmp('gps-sess-e2e-');
  const store = new SessionStore(path.join(base, 'sessions'));
  const A = makeEnv({ base, store, script: async () => null });
  store.save(A.root, sample({
    run: { ...sample().run, status: 'done' },
    steps: [{ id: 's1', at: 1, type: 'info', text: 'Mục tiêu: x' }, { id: 's2', at: 2, type: 'tool', tool: 'finish', status: 'done', text: 'xong' }],
    expiredApprovals: [{ tool: 'write_file', label: 'src/new.ts', summary: 'Từ trang Gemini', source: 'vibe' }]
  }));
  const prev = A.runner.previousSession();
  assert.equal(prev.interrupted, false);
  assert.equal(prev.expiredApprovals, 1);
  const snap = A.runner.resume({ continueRun: false });
  assert.equal(snap.status, 'done');
  assert.ok(snap.steps.some(s => /HẾT HẠN/.test(s.text || '') && /write_file src\/new\.ts \(đề xuất từ trang Gemini\)/.test(s.text)));
  A.runner.dispose();
});
