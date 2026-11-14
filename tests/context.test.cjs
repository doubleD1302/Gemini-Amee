'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const { ContextMeter, Ledger, estimateTokens, DEFAULT_BUDGET_CHARS } = require('../desktop/context.cjs');
const protocol = require('../desktop/agent-protocol.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });

/* ---------- ContextMeter ---------- */
test('ContextMeter counts sent/received chars, estimates tokens and resets per chat', () => {
  const m = new ContextMeter(1000);
  assert.equal(m.shouldRotate(10), false, 'no chat yet');
  m.startChat(400);
  m.addReceived(100);
  let s = m.snapshot();
  assert.equal(s.chars, 500);
  assert.equal(s.tokens, estimateTokens(500));
  assert.equal(s.tokens, Math.ceil(500 / 3.5));
  assert.equal(s.ratio, 0.5);
  assert.equal(s.chatIndex, 1);
  assert.equal(s.turnsInChat, 1);
  assert.equal(DEFAULT_BUDGET_CHARS > 0, true);
  m.addSent(300);
  assert.equal(m.shouldRotate(100), false, '900 <= 1000');
  assert.equal(m.shouldRotate(300), true, '1100 > 1000 and 2 turns done');
  m.startChat(50);
  s = m.snapshot();
  assert.deepEqual([s.chars, s.turnsInChat, s.chatIndex], [50, 1, 2]);
});

test('ContextMeter never rotates a chat that has had fewer than 2 sends (no endless rotation) unless the user asks', () => {
  const m = new ContextMeter(10);
  m.startChat(5000);
  assert.equal(m.shouldRotate(5000), false);
  m.rotateRequested = true;
  assert.equal(m.shouldRotate(1), true);
  assert.equal(m.snapshot().ratio, 1, 'ratio is capped at 1');
});

/* ---------- Ledger + recap ---------- */
test('Ledger renders changed files, commands, failures, rejections, notes and user messages; empty ledger renders nothing', () => {
  const l = new Ledger();
  assert.equal(l.render(), '');
  l.recordEdit('src/a.ts', 'edit_file', false);
  l.recordEdit('src/a.ts', 'edit_file', false);
  l.recordEdit('src/new.ts', 'write_file', true);
  l.recordRead('src/b.ts');
  l.recordCommand('npm test', false, 1, 'FAIL a.test\nExpected 2');
  l.recordCommand('npm run lint', true, 0, 'ok');
  l.recordRejected('run_command rm -rf build (lý do: nguy hiểm)');
  l.recordNote('Tiếp theo mình sẽ sửa b.ts và chạy lại test.');
  l.recordUser('nhớ giữ nguyên API cũ');
  const t = l.render();
  assert.match(t, /File đã sửa\/tạo/);
  assert.match(t, /- src\/a\.ts \(edit_file ×2\)/);
  assert.match(t, /- src\/new\.ts \(tạo mới; write_file\)/);
  assert.match(t, /- src\/b\.ts/);
  assert.match(t, /`npm test` → thất bại \(exit 1\)/);
  assert.match(t, /`npm run lint` → thành công/);
  assert.match(t, /TỪ CHỐI[\s\S]*rm -rf build/);
  assert.match(t, /Việc còn lại[\s\S]*Tiếp theo mình sẽ sửa b\.ts/);
  assert.match(t, /Lệnh `npm test` còn đang THẤT BẠI[\s\S]*Expected 2/);
  assert.match(t, /dữ liệu không đáng tin/);
  assert.match(t, /nhớ giữ nguyên API cũ/);
});

test('Ledger: a command that later succeeds is no longer listed as failing; command output is fenced safely', () => {
  const l = new Ledger();
  l.recordCommand('npm test', false, 1, 'boom ' + F + ' injected');
  assert.match(l.render(), /````text[\s\S]*boom/, 'fence longer than the ``` inside the output');
  l.recordCommand('npm test', true, 0, 'ok');
  assert.doesNotMatch(l.render(), /THẤT BẠI/);
});

test('Ledger is bounded (files, reads, commands, messages)', () => {
  const l = new Ledger();
  for (let i = 0; i < 100; i++) { l.recordEdit('f' + i, 'edit_file', false); l.recordRead('r' + i); l.recordCommand('c' + i, true, 0, ''); l.recordUser('m' + i); l.recordRejected('x' + i); }
  assert.ok(l.changed.size <= 40 && l.read.length <= 30 && l.commands.length <= 10 && l.userMessages.length <= 4 && l.rejected.length <= 6);
  assert.ok(l.render().length < 9000);
});

test('buildRecap keeps the goal, the changed files, what is left, and the pending follow-up (clipped when huge)', () => {
  const l = new Ledger();
  l.recordEdit('src/a.ts', 'edit_file', false);
  l.recordNote('Còn phải cập nhật README.');
  const recap = protocol.buildRecap({ systemPrompt: 'SYS', goal: 'Đổi tên hàm foo thành bar', steps: ['edit_file src/a.ts → ok'], ledgerText: l.render(), followUp: 'KẾT QUẢ TOOL', reason: 'đã quá dài' });
  assert.match(recap, /^SYS/);
  assert.match(recap, /NHIỆM VỤ CỦA NGƯỜI DÙNG\nĐổi tên hàm foo thành bar/);
  assert.match(recap, /đã quá dài/);
  assert.match(recap, /src\/a\.ts/);
  assert.match(recap, /Còn phải cập nhật README/);
  assert.match(recap, /VIỆC CẦN XỬ LÝ NGAY[^\n]*\nKẾT QUẢ TOOL/);
  assert.match(recap, /edit_file src\/a\.ts → ok/);
  const huge = protocol.buildRecap({ systemPrompt: 'S', goal: 'G', steps: [], followUp: 'x'.repeat(50000), maxFollowUp: 1000 });
  assert.match(huge, /đã cắt bớt/);
  assert.ok(huge.length < 2500);
});

/* ---------- Agent end-to-end với Gemini giả ---------- */
function setup(script, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-ctx-'));
  cleanup.push(base);
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(base, 'cp')), getRoot: () => root, contextBudgetChars: opts.budget, detectChecks: () => [] });
  const turns = [];
  let conv = 0;
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const info = { prompt: job.prompt, newChat: job.newChat, expectConversation: job.expectConversation };
    const idx = turns.push(info) - 1;
    setImmediate(async () => {
      if (job.status === 'cancelled') return;
      const answer = await script(info, idx);
      if (answer == null || job.status === 'cancelled') return;
      bridge.setJob(job, { status: 'final', answer, conversationUrl: `https://gemini.google.com/app/conv${job.newChat ? ++conv : conv}` });
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

test('e2e: a long conversation is summarized into a NEW chat that keeps the goal, the edited files and what is left', async () => {
  const goal = 'Đổi a thành 2 rồi tạo b.ts';
  const env = setup(async (t, i) => {
    if (i === 0) return `Đọc file.\n${call('tool: read_file\npath: src/a.ts')}`;
    if (i === 1) return `Đã đọc xong. Tiếp theo mình sẽ tạo src/b.ts rồi chạy test.\n${call('tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE')}`;
    if (i === 2) return `Tạo b.\n${call('tool: write_file\npath: src/b.ts\n---\nexport const b = 2;\n')}`;
    return call('tool: finish\n---\nxong');
  }, { budget: 3000 });
  env.runner.setPolicy({ autoEdits: true });
  env.runner.start(goal);
  await until(env.runner, s => s.status === 'done');

  assert.equal(env.turns.length, 4);
  // Lượt 0 và 1 cùng một chat; lượt 2 bị chuyển sang chat mới VÌ đã vượt ngân sách.
  assert.equal(env.turns[0].newChat, true);
  assert.equal(env.turns[1].newChat, false);
  assert.equal(env.turns[1].expectConversation, 'https://gemini.google.com/app/conv1');
  const rotated = env.turns[2];
  assert.equal(rotated.newChat, true, 'rotation opens a fresh Gemini chat');
  assert.equal(rotated.expectConversation, null);
  // Bản tóm tắt giữ nguyên: mục tiêu + file đã sửa + việc còn lại + kết quả tool chưa được model thấy + cú pháp tool.
  assert.match(rotated.prompt, /### edit_file/, 'system prompt (tool syntax) is resent');
  assert.ok(rotated.prompt.includes(goal), 'goal');
  assert.match(rotated.prompt, /File đã sửa\/tạo[\s\S]*- src\/a\.ts \(edit_file\)/, 'edited file');
  assert.match(rotated.prompt, /Việc còn lại[\s\S]*Tiếp theo mình sẽ tạo src\/b\.ts rồi chạy test/, 'what is left');
  assert.match(rotated.prompt, /VIỆC CẦN XỬ LÝ NGAY[\s\S]*OK: đã sửa src\/a\.ts/, 'tool result the model has not seen yet');
  assert.match(rotated.prompt, /File đã đọc[\s\S]*- src\/a\.ts/);
  // Sau khi chuyển, các lượt tiếp theo bám chat mới.
  assert.equal(env.turns[3].newChat, false);
  assert.equal(env.turns[3].expectConversation, 'https://gemini.google.com/app/conv2');
  // Công việc vẫn đúng và số liệu hiển thị cập nhật.
  assert.equal(env.file('src/a.ts'), 'export const a = 2;\n');
  assert.equal(env.file('src/b.ts'), 'export const b = 2;\n');
  const ctx = env.runner.snapshot().context;
  assert.equal(ctx.rotations, 1);
  assert.equal(ctx.chatIndex, 2);
  assert.ok(ctx.chars > 0 && ctx.tokens > 0);
  assert.ok(env.runner.snapshot().steps.some(s => s.type === 'info' && /Hội thoại Gemini đã dài/.test(s.text)));
});

test('e2e: with the default budget a normal run never rotates and the meter grows', async () => {
  const env = setup(async (t, i) => i === 0 ? call('tool: read_file\npath: src/a.ts') : call('tool: finish\n---\nok'));
  env.runner.start('x');
  await until(env.runner, s => s.status === 'done');
  const ctx = env.runner.snapshot().context;
  assert.equal(ctx.rotations, 0);
  assert.equal(ctx.chatIndex, 1);
  assert.equal(ctx.budgetChars, DEFAULT_BUDGET_CHARS);
  assert.ok(ctx.chars > 1000 && ctx.ratio > 0 && ctx.ratio < 1);
  assert.equal(env.turns.every(t => t.newChat === (t === env.turns[0])), true);
});

test('e2e: the user can request a new chat for the next turn; the recap carries their message', async () => {
  const env = setup(async (t, i) => i === 0 ? 'Mình cần biết bạn muốn đổi gì.' : call('tool: finish\n---\nok'));
  assert.throws(() => env.runner.rotateNext(), /Chưa có phiên/);
  env.runner.start('Mục tiêu ban đầu');
  await until(env.runner, s => s.status === 'waiting_user');
  const snap = env.runner.rotateNext();
  assert.equal(snap.context.rotateRequested, true);
  env.runner.reply('hãy đổi a thành 5');
  await until(env.runner, s => s.status === 'done');
  assert.equal(env.turns[1].newChat, true);
  assert.match(env.turns[1].prompt, /Mục tiêu ban đầu/);
  assert.match(env.turns[1].prompt, /Tin nhắn mới từ người dùng:\nhãy đổi a thành 5/);
  assert.match(env.turns[1].prompt, /Theo yêu cầu|Tin nhắn gần đây của người dùng[\s\S]*hãy đổi a thành 5/);
  const ctx = env.runner.snapshot().context;
  assert.equal(ctx.rotations, 1);
  assert.equal(ctx.rotateRequested, false, 'request is consumed');
});

test('e2e: a still-failing command shows up under "việc còn lại" after rotation; rotation does not loop forever with a tiny budget', async () => {
  const env = setup(async (t, i) => {
    if (i === 0) return call('tool: run_command\ncommand: node -e "console.log(\'BOOM-OUT\');process.exit(3)"');
    if (i === 1) return call('tool: read_file\npath: src/a.ts');
    if (i === 2) return call('tool: read_file\npath: src/a.ts');
    return call('tool: finish\n---\nxong');
  }, { budget: 1 });
  env.runner.start('chạy thử');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  await env.runner.approve(w.pending[0].id, 'approve');
  await until(env.runner, s => s.status === 'done');
  assert.equal(env.turns.length, 4);
  const rotated = env.turns.filter(t => t.newChat).slice(1);
  assert.ok(rotated.length >= 1 && rotated.length < env.turns.length - 1, 'rotated, but not on every turn');
  const first = rotated[0];
  assert.match(first.prompt, /`node -e [^`]*` → thất bại \(exit 3\)/);
  assert.match(first.prompt, /còn đang THẤT BẠI[\s\S]*BOOM-OUT/);
});
