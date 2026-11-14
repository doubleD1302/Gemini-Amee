'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const { sanitizeSession, VERSION } = require('../desktop/sessions.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;
const edit = (file, from, to) => call(`tool: edit_file\npath: ${file}\n<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`);

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });

const A_TS = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', ''].join('\n');

function setup(script) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-prev-'));
  cleanup.push(base);
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), A_TS);
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(base, 'cp')), getRoot: () => root, detectChecks: () => [] });
  const turns = [];
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const info = { prompt: job.prompt };
    const idx = turns.push(info) - 1;
    setImmediate(async () => {
      const answer = await script(info, idx);
      if (answer == null || job.status === 'cancelled') return;
      bridge.setJob(job, { status: 'final', answer, conversationUrl: 'https://gemini.google.com/app/conv1' });
    });
  });
  return { root, runner, turns, file: rel => fs.readFileSync(path.join(root, rel), 'utf8') };
}
function until(runner, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => { const s = runner.snapshot(); if (pred(s)) { runner.removeListener('state', check); clearTimeout(t); resolve(s); } };
    const t = setTimeout(() => { runner.removeListener('state', check); reject(new Error('timeout; status=' + runner.snapshot().status)); }, ms);
    runner.on('state', check); check();
  });
}

test('every edit proposal carries a side-by-side view and the line to open in the editor', async () => {
  const env = setup(async (t, i) => (i === 0 ? edit('src/a.ts', 'export const c = 3;', 'export const c = 30;') : call('tool: finish\n---\nok')));
  env.runner.start('đổi c');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  const p = w.pending[0];
  assert.equal(p.line, 3);
  assert.ok(p.view.length >= 1);
  const row = p.view[0].rows.find(r => r.k === 'chg');
  assert.deepEqual([row.l.n, row.l.s, row.r.n, row.r.s], [3, 'export const c = 3;', 3, 'export const c = 30;']);
  assert.equal(p.group, null, 'a single edit has no group');
  const step = w.steps.find(s => s.type === 'tool');
  assert.equal(step.line, 3);
  assert.ok(step.view.length >= 1);
  assert.equal(env.file('src/a.ts'), A_TS, 'preview never touches the disk');
  await env.runner.approve(p.id, 'approve');
  await until(env.runner, s => s.status === 'done');
});

test('several edits to the same file in ONE message: combined preview first, "approve group" applies all with one click', async () => {
  const env = setup(async (t, i) => (i === 0
    ? `Sửa ba chỗ.\n${edit('src/a.ts', 'export const a = 1;', 'export const a = 10;')}\n${edit('src/a.ts', 'export const c = 3;', 'export const c = 30;')}\n${edit('src/a.ts', 'export const d = 4;', 'export const d = 40;')}`
    : call('tool: finish\n---\nxong')));
  env.runner.start('đổi nhiều');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending.length, 1);
  const g = w.pending[0].group;
  assert.equal(g.count, 3);
  assert.equal(g.path, 'src/a.ts');
  assert.equal(g.line, 1);
  assert.match(g.summary, /Gộp 3 thao tác trên src\/a\.ts/);
  for (const frag of ['+export const a = 10;', '+export const c = 30;', '+export const d = 40;']) assert.ok(g.diff.includes(frag), frag);
  assert.ok(g.view.flatMap(h => h.rows).filter(r => r.k === 'chg').length >= 3);
  // Tab "chỉ thao tác này" chỉ có thay đổi đầu tiên.
  assert.ok(w.pending[0].diff.includes('+export const a = 10;') && !w.pending[0].diff.includes('c = 30'));
  assert.equal(env.file('src/a.ts'), A_TS, 'nothing written while previewing');

  await env.runner.approve(w.pending[0].id, 'approve_group');
  const done = await until(env.runner, s => s.status === 'done');
  assert.equal(env.file('src/a.ts'), ['export const a = 10;', 'export const b = 2;', 'export const c = 30;', 'export const d = 40;', ''].join('\n'));
  assert.equal(done.pending.length, 0, 'no further prompts for the same file');
  const toolSteps = done.steps.filter(s => s.type === 'tool' && s.tool === 'edit_file');
  assert.equal(toolSteps.length, 3);
  assert.ok(toolSteps.slice(1).every(s => /đã duyệt theo nhóm/.test(s.summary)));
  assert.equal(env.runner.listCheckpoints().length, 3, 'each edit still gets its own checkpoint');
  // Hoàn tác từng bước vẫn hoạt động (mới nhất trước).
  env.runner.undo(env.runner.listCheckpoints()[0].id);
  assert.match(env.file('src/a.ts'), /d = 4;/);
  assert.match(env.file('src/a.ts'), /c = 30;/);
});

test('plain "approve" on a grouped edit only applies that edit; the next one asks again on its own', async () => {
  const env = setup(async (t, i) => (i === 0
    ? `${edit('src/a.ts', 'export const a = 1;', 'export const a = 10;')}\n${edit('src/a.ts', 'export const c = 3;', 'export const c = 30;')}`
    : call('tool: finish\n---\nxong')));
  env.runner.start('x');
  let w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending[0].group.count, 2);
  await env.runner.approve(w.pending[0].id, 'approve');
  w = await until(env.runner, s => s.status === 'waiting_approval' && s.pending[0] && s.pending[0].diff.includes('c = 30'));
  assert.equal(w.pending[0].group, null, 'only the first call of a group carries the preview');
  assert.match(env.file('src/a.ts'), /a = 10;/);
  assert.match(env.file('src/a.ts'), /c = 3;/);
  await env.runner.approve(w.pending[0].id, 'approve');
  await until(env.runner, s => s.status === 'done');
});

test('no group when the simulation fails, when a run_command sits between the edits, or when auto-approve is on', async () => {
  // 1) hai edit nhưng edit thứ hai KHÔNG khớp sau edit thứ nhất → không có nhóm.
  let env = setup(async (t, i) => (i === 0
    ? `${edit('src/a.ts', 'export const a = 1;', 'export const a = 10;')}\n${edit('src/a.ts', 'export const a = 1;', 'export const a = 11;')}`
    : null));
  env.runner.start('x');
  let w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending[0].group, null);
  env.runner.cancel();

  // 2) run_command xen giữa hai edit → không gộp (lệnh có thể đổi file).
  env = setup(async (t, i) => (i === 0
    ? `${edit('src/a.ts', 'export const a = 1;', 'export const a = 10;')}\n${call('tool: run_command\ncommand: node -e "0"')}\n${edit('src/a.ts', 'export const c = 3;', 'export const c = 30;')}`
    : null));
  env.runner.start('x');
  w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending[0].group, null);
  env.runner.cancel();

  // 3) tự duyệt sửa file → không cần xem trước nhóm.
  env = setup(async (t, i) => (i === 0
    ? `${edit('src/a.ts', 'export const a = 1;', 'export const a = 10;')}\n${edit('src/a.ts', 'export const c = 3;', 'export const c = 30;')}`
    : call('tool: finish\n---\nok')));
  env.runner.setPolicy({ autoEdits: true });
  env.runner.start('x');
  await until(env.runner, s => s.status === 'done');
  assert.match(env.file('src/a.ts'), /a = 10;[\s\S]*c = 30;/);
});

test('"approve_group" is refused for run_command and for entries without a group; run_command still always asks', async () => {
  const env = setup(async (t, i) => (i === 0 ? call('tool: run_command\ncommand: node -e "0"') : call('tool: finish\n---\nok')));
  env.runner.start('x');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending[0].kind, 'exec');
  assert.equal(w.pending[0].group, null);
  await assert.rejects(() => env.runner.approve(w.pending[0].id, 'approve_group'), /Không có nhóm/);
  assert.equal(env.runner.snapshot().pending.length, 1, 'still pending after the refused shortcut');
  await env.runner.approve(w.pending[0].id, 'approve');
  await until(env.runner, s => s.status === 'done');

  const env2 = setup(async (t, i) => (i === 0 ? edit('src/a.ts', 'export const a = 1;', 'export const a = 2;') : null));
  env2.runner.start('x');
  const w2 = await until(env2.runner, s => s.status === 'waiting_approval');
  await assert.rejects(() => env2.runner.approve(w2.pending[0].id, 'approve_group'), /Không có nhóm/);
  env2.runner.cancel();
});

test('write_file then edit_file on the SAME new file in one message are previewed together (virtual overlay, nothing created yet)', async () => {
  const env = setup(async (t, i) => (i === 0
    ? `${call('tool: write_file\npath: src/new.ts\n---\nexport const n = 1;\nexport const m = 2;\n')}\n${edit('src/new.ts', 'export const m = 2;', 'export const m = 22;')}`
    : call('tool: finish\n---\nok')));
  env.runner.start('x');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  const g = w.pending[0].group;
  assert.equal(g.count, 2);
  assert.ok(g.diff.includes('+export const m = 22;'));
  assert.ok(!g.diff.includes('m = 2;\n'), 'final content only');
  assert.ok(g.view.flatMap(h => h.rows).every(r => r.k === 'add'), 'a new file is all additions');
  assert.equal(fs.existsSync(path.join(env.root, 'src', 'new.ts')), false, 'preview does not create the file');
  await env.runner.approve(w.pending[0].id, 'approve_group');
  await until(env.runner, s => s.status === 'done');
  assert.equal(env.file('src/new.ts'), 'export const n = 1;\nexport const m = 22;\n');
});

test('restored steps get their side-by-side view re-derived from the saved diff (not trusted from disk)', () => {
  const diff = '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c';
  const s = sanitizeSession({
    version: VERSION, root: '/p', savedAt: 1,
    run: { id: 'r', goal: 'g', status: 'done' },
    steps: [{ id: 's', at: 1, type: 'tool', tool: 'edit_file', label: 'f', diff, view: [{ header: 'EVIL', rows: [] }], line: 999 }]
  });
  const st = s.steps[0];
  assert.equal(st.line, 2);
  assert.equal(st.view[0].header, '@@ -1,3 +1,3 @@');
  assert.deepEqual(st.view[0].rows.map(r => r.k), ['ctx', 'chg', 'ctx']);
});
