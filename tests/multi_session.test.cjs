'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const { SessionStore } = require('../desktop/sessions.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }

const sample = goal => ({
  savedAt: 1, run: { id: 'run_' + goal, goal, status: 'waiting_user', turn: 1, conversationUrl: null, error: '', question: '' },
  steps: [], digest: [], meter: { chars: 1, turns: 1, chatIndex: 1, rotations: 0 }, ledger: {}, expiredApprovals: []
});

/* ---------- SessionStore: slot ---------- */
test('SessionStore keeps one independent saved session per slot; the main slot keeps its old path', () => {
  const store = new SessionStore(path.join(tmp('gps-ms-'), 's'));
  const root = '/proj/x';
  store.save(root, sample('chính'));
  store.save(root, sample('hai'), 's2');
  store.save(root, sample('ba'), 's3');
  assert.equal(store.load(root).run.goal, 'chính');
  assert.equal(store.load(root, 's2').run.goal, 'hai');
  assert.equal(store.load(root, 's3').run.goal, 'ba');
  assert.equal(store.load(root, 's9'), null);
  assert.ok(store._file(root).endsWith(path.join('session.json')) && !store._file(root).includes('slots'), 'main slot path unchanged (backward compatible)');
  store.clear(root, 's2');
  assert.equal(store.load(root, 's2'), null);
  assert.equal(store.load(root, 's3').run.goal, 'ba');
  store.clear(root);                       // xoá phiên chính KHÔNG đụng các slot khác
  assert.equal(store.load(root), null);
  assert.equal(store.load(root, 's3').run.goal, 'ba');
  for (const bad of ['../x', 's 2', 'S2', 'a'.repeat(9), '..', 'a/b']) assert.throws(() => store.save(root, sample('x'), bad), /Slot phiên không hợp lệ/, bad);
  assert.equal(store.load(root, '../x'), null, 'load never throws on a bad slot');
});

/* ---------- Bridge ---------- */
async function harness() {
  const bridge = new Bridge();
  await bridge.start();
  const { url, token } = bridge.info();
  const call2 = async (route, method = 'GET', body) => {
    const r = await fetch(url + route, { method, headers: { Authorization: 'Bearer ' + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.json();
  };
  return { bridge, call2 };
}
test('bridge: jobs carry sessionId/navigate to the extension; "navigating" re-queues the job at most 3 times', async () => {
  const { bridge, call2 } = await harness();
  try {
    const q = bridge.enqueue('q', 'p', [], { kind: 'agent', session: 's2', navigate: true, expectConversation: 'https://gemini.google.com/app/abc' });
    assert.equal(bridge.getJob(q.id).session, 's2');
    const first = (await call2('/v1/next')).job;
    assert.equal(first.sessionId, 's2');
    assert.equal(first.navigate, true);
    assert.equal(first.expectConversation, 'https://gemini.google.com/app/abc');
    for (let n = 1; n <= 3; n++) {
      const r = await call2('/v1/result', 'POST', { id: q.id, status: 'error', text: 'chuyển', code: 'navigating' });
      assert.equal(r.requeued, true, `navigation #${n}`);
      assert.equal(bridge.getJob(q.id).status, 'queued');
      assert.equal((await call2('/v1/next')).job.id, q.id, 'picked up again (by the freshly loaded page)');
    }
    const fourth = await call2('/v1/result', 'POST', { id: q.id, status: 'error', text: 'vẫn lệch', code: 'navigating' });
    assert.equal(fourth.requeued, undefined);
    assert.equal(bridge.getJob(q.id).status, 'error', 'gives up after 3 navigations instead of looping forever');
    // job đã huỷ không bị xếp lại; job thường không có navigate
    const c = bridge.enqueue('q2', 'p2', [], { kind: 'agent', session: 'main', navigate: true });
    await call2('/v1/next');
    bridge.cancel(c.id);
    const rc = await call2('/v1/result', 'POST', { id: c.id, status: 'error', text: 'x', code: 'navigating' });
    assert.equal(rc.cancelled, true);
    assert.equal(bridge.getJob(c.id).status, 'cancelled');
    const plain = bridge.enqueue('q3', 'p3', []);
    assert.equal((await call2('/v1/next')).job.navigate, false);
    assert.equal(bridge.getJob(plain.id).session, '');
  } finally { await bridge.stop(); }
});

test('content.js navigates only when the Studio allows it (multi-session) and only to a gemini.google.com URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
  assert.match(src, /if \(job\.navigate && \/\^https:\\\/\\\/gemini\\\.google\\\.com\\\/\/\.test\(job\.expectConversation\)\)/);
  assert.match(src, /code: 'navigating'/);
  assert.ok(src.indexOf("code: 'navigating'") < src.indexOf('location.href = job.expectConversation'), 'the Studio is told BEFORE the page reloads');
});

/* ---------- Nhiều runner chung một bridge ---------- */
function world(opts = {}) {
  const base = tmp('gps-multi-');
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const bridge = new Bridge();
  const checkpoints = new CheckpointStore(path.join(base, 'cp'));
  const store = new SessionStore(path.join(base, 'sessions'));
  const runners = new Map();
  const make = slot => {
    const r = new AgentRunner({ bridge, workspace, tools, checkpoints, getRoot: () => root, sessions: opts.persist ? store : null, detectChecks: () => [], slot, isMulti: () => runners.size > 1 });
    runners.set(slot || 'main', r);
    return r;
  };
  const log = [];       // mọi job gửi sang "Gemini": { session, prompt, newChat, expect, navigate }
  const conv = new Map();   // session -> số cuộc trò chuyện đã tạo
  let busy = 0, maxBusy = 0;
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const entry = { session: job.session, prompt: job.prompt, newChat: job.newChat, expect: job.expectConversation, navigate: job.navigate };
    log.push(entry);
    setImmediate(async () => {
      busy++; maxBusy = Math.max(maxBusy, busy);
      try {
        await sleep(5);
        const answer = await opts.script(entry, log.filter(x => x.session === entry.session).length - 1);
        if (answer == null || job.status === 'cancelled') return;
        const n = job.newChat ? (conv.set(job.session, (conv.get(job.session) || 0) + 1), conv.get(job.session)) : conv.get(job.session);
        bridge.setJob(job, { status: 'final', answer, conversationUrl: `https://gemini.google.com/app/${job.session || 'main'}-${n}` });
      } finally { busy--; }
    });
  });
  return { root, bridge, make, runners, log, store, maxBusy: () => maxBusy };
}
function until(runner, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => { const s = runner.snapshot(); if (pred(s)) { runner.removeListener('state', check); clearTimeout(t); resolve(s); } };
    const t = setTimeout(() => { runner.removeListener('state', check); reject(new Error('timeout; status=' + runner.snapshot().status)); }, ms);
    runner.on('state', check); check();
  });
}

test('two sessions run side by side on one bridge: own conversations, own plan/ledger/approvals, no cross-talk', async () => {
  const w = world({
    script: async (e, i) => {
      if (e.session === 'main') {
        if (i === 0) return `${call('tool: plan\n---\n- [~] Việc của phiên 1\n- [ ] Xong')}\n${call('tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE')}`;
        return call('tool: finish\n---\nphiên 1 xong');
      }
      if (i === 0) return `${call('tool: plan\n---\n- [x] Đọc\n- [~] Việc của phiên 2')}\n${call('tool: read_file\npath: src/a.ts')}`;
      if (i === 1) return call('tool: run_command\ncommand: node -e "process.exit(0)"');
      return call('tool: finish\n---\nphiên 2 xong');
    }
  });
  const A = w.make('');
  const B = w.make('s2');
  A.start('Mục tiêu A');
  B.start('Mục tiêu B');
  const wa = await until(A, s => s.status === 'waiting_approval');
  const wb = await until(B, s => s.status === 'waiting_approval');
  // phê duyệt độc lập: mỗi phiên chỉ thấy yêu cầu của mình
  assert.equal(wa.pending.length, 1); assert.equal(wa.pending[0].tool, 'edit_file');
  assert.equal(wb.pending.length, 1); assert.equal(wb.pending[0].tool, 'run_command');
  assert.deepEqual(wa.plan.items.map(i => i.text), ['Việc của phiên 1', 'Xong']);
  assert.deepEqual(wb.plan.items.map(i => i.text), ['Đọc', 'Việc của phiên 2']);
  assert.equal(wa.goal, 'Mục tiêu A'); assert.equal(wb.goal, 'Mục tiêu B');
  await assert.rejects(() => A.approve(wb.pending[0].id, 'approve'), /không còn tồn tại/, 'a session cannot approve another session\'s action');
  await B.approve(wb.pending[0].id, 'approve');
  assert.equal(fs.readFileSync(path.join(w.root, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n', 'A\'s edit is still waiting');
  await until(B, s => s.status === 'done');
  await A.approve(wa.pending[0].id, 'approve');
  await until(A, s => s.status === 'done');
  assert.equal(fs.readFileSync(path.join(w.root, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
  // mỗi phiên đi trong cuộc trò chuyện của mình và chỉ nhận kết quả của mình
  const ofA = w.log.filter(x => x.session === 'main'), ofB = w.log.filter(x => x.session === 's2');
  assert.equal(ofA.length, 2); assert.equal(ofB.length, 3);
  assert.ok(ofA[0].newChat && ofB[0].newChat);
  assert.equal(ofA[1].expect, 'https://gemini.google.com/app/main-1');
  assert.equal(ofB[1].expect, 'https://gemini.google.com/app/s2-1');
  assert.equal(ofB[2].expect, 'https://gemini.google.com/app/s2-1');
  assert.ok(ofA.every(x => x.navigate === true) && ofB.every(x => x.navigate === true), 'with >1 session the extension may navigate between conversations');
  assert.ok(!ofA.some(x => /phiên 2|Việc của phiên 2/.test(x.prompt)) && !ofB.some(x => /Mục tiêu A/.test(x.prompt)));
  assert.match(A.ledger.render(), /src\/a\.ts \(edit_file\)/);
  assert.equal(B.ledger.changed.size, 0, 'B changed no files, so its ledger has none');
  assert.equal(A.snapshot().conversationUrl, 'https://gemini.google.com/app/main-1');
  assert.equal(B.snapshot().conversationUrl, 'https://gemini.google.com/app/s2-1');
  A.dispose(); B.dispose();
});

test('a single session never asks the extension to navigate (old behaviour is unchanged)', async () => {
  const w = world({ script: async () => call('tool: finish\n---\nxong') });
  const A = w.make('');
  A.start('x');
  await until(A, s => s.status === 'done');
  assert.equal(w.log[0].navigate, false);
  A.dispose();
});

test('cancelling one session leaves the other running; each has its own checkpoints-free timeline', async () => {
  const w = world({
    script: async (e, i) => (e.session === 's2' ? (i === 0 ? call('tool: write_file\npath: src/b.ts\n---\nx') : call('tool: finish\n---\nxong')) : (i === 0 ? 'Cần thêm thông tin.' : call('tool: finish\n---\nxong')))
  });
  const A = w.make('');
  const B = w.make('s2');
  A.start('A'); B.start('B');
  await until(A, s => s.status === 'waiting_user');
  const wb = await until(B, s => s.status === 'waiting_approval');
  B.cancel();
  assert.equal(B.snapshot().status, 'cancelled');
  assert.equal(B.snapshot().pending.length, 0);
  assert.equal(A.snapshot().status, 'waiting_user', 'A is unaffected by B being cancelled');
  assert.ok(!fs.existsSync(path.join(w.root, 'src', 'b.ts')));
  assert.equal(wb.pending[0].tool, 'write_file');
  A.reply('tiếp'); await until(A, s => s.status === 'done');
  A.dispose(); B.dispose();
});

test('every session is saved in its own slot; each resumes independently after a restart', async () => {
  const w = world({ persist: true, script: async (e, i) => (e.session === 's2' ? 'Mình là phiên hai.' : 'Mình là phiên chính.') });
  const A = w.make('');
  const B = w.make('s2');
  A.start('Mục tiêu chính'); B.start('Mục tiêu phụ');
  await until(A, s => s.status === 'waiting_user'); await until(B, s => s.status === 'waiting_user');
  A.dispose(); B.dispose();                       // flush
  assert.equal(w.store.load(w.root).run.goal, 'Mục tiêu chính');
  assert.equal(w.store.load(w.root, 's2').run.goal, 'Mục tiêu phụ');
  // khởi động lại: runner mới cho mỗi slot
  const w2bridge = new Bridge();
  const mk = slot => new AgentRunner({ bridge: w2bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(path.dirname(w.root), 'cp')), getRoot: () => w.root, sessions: w.store, detectChecks: () => [], slot });
  const A2 = mk(''), B2 = mk('s2'), C2 = mk('s3');
  assert.equal(A2.previousSession().goal, 'Mục tiêu chính');
  assert.equal(B2.previousSession().goal, 'Mục tiêu phụ');
  assert.equal(C2.previousSession(), null);
  assert.equal(B2.resume({ continueRun: false }).goal, 'Mục tiêu phụ');
  assert.equal(A2.snapshot().goal, '', 'resuming one slot does not touch another');
  B2.discardPrevious();                           // phiên đang hoạt động trong bộ nhớ → không xoá
  assert.equal(w.store.load(w.root, 's2').run.goal, 'Mục tiêu phụ');
  A2.dispose(); B2.dispose(); C2.dispose();
});
