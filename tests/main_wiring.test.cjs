'use strict';
// Chạy desktop/main.cjs với Electron giả để kiểm tra việc nối IPC <-> bridge <-> agent.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-ud-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-proj-'));
fs.mkdirSync(path.join(project, 'src'));
fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const answer = 42;\n');
const handlers = new Map(), appEvents = new Map(), sent = [];
let readyResolve;
const electronStub = {
  app: { whenReady: () => new Promise(r => { readyResolve = r; }), getPath: () => userData, on: (evt, fn) => appEvents.set(evt, fn), quit() {}, isPackaged: false },
  BrowserWindow: class {
    constructor() { this.webContents = { send: (ch, payload) => sent.push({ ch, payload }), setWindowOpenHandler() {}, on() {} }; }
    once() {} loadFile() {} loadURL() {} show() {} isDestroyed() { return false; } isFocused() { return true; } flashFrame() {}
    static getAllWindows() { return [{}]; }
  },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [project] }) },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  shell: { openExternal(url) { (global.__openedUrls = global.__openedUrls || []).push(url); }, openPath(p) { (global.__openedPaths = global.__openedPaths || []).push(p); return ''; }, showItemInFolder() {} },
  clipboard: { writeText() {}, readText: () => '' }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electronStub : origLoad.call(this, request, ...rest); };
require('../desktop/main.cjs');
Module._load = origLoad;

const invoke = (ch, ...args) => { const h = handlers.get(ch); assert(h, 'missing IPC handler: ' + ch); return Promise.resolve(h({}, ...args)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bridgeInfo;

after(async () => {
  const quit = appEvents.get('before-quit');
  if (quit) quit();          // đúng như Electron: dừng runner + đóng server bridge
  await sleep(100);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

async function boot() {
  readyResolve();
  for (let i = 0; i < 100 && !handlers.has('studio:pair-info'); i++) await sleep(20);
  assert(handlers.has('studio:pair-info'), 'main.cjs did not finish booting');
  bridgeInfo = JSON.parse(await invoke('studio:pair-info'));
}
async function http(route, method = 'GET', body) {
  const res = await fetch(bridgeInfo.url + route, { method, headers: { Authorization: 'Bearer ' + bridgeInfo.token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res.json();
}
const jobUpdates = id => sent.filter(s => s.ch === 'studio:job' && s.payload.id === id).map(s => s.payload);

test('boots, registers every IPC channel, persists token/port for stable pairing', async () => {
  await boot();
  for (const ch of ['studio:init', 'studio:choose-folder', 'studio:read-file', 'studio:write-file', 'studio:search', 'studio:prepare', 'studio:send', 'studio:import-reply', 'agent:state', 'agent:start', 'agent:reply', 'agent:retry', 'agent:rotate-next', 'agent:previous', 'agent:open-in-editor', 'agent:resume', 'agent:discard-previous', 'agent:attach', 'agent:detach', 'agent:cancel', 'agent:approve', 'agent:set-policy', 'agent:job-prompt', 'agent:checkpoints', 'agent:undo']) assert(handlers.has(ch), ch);
  assert.match(bridgeInfo.token, /^[0-9a-f]{64}$/);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'bridge-state.json'), 'utf8'));
  assert.equal(saved.token, bridgeInfo.token);
  const ws = await invoke('studio:choose-folder');
  assert.equal(ws.files.some(f => f.path === 'src/app.ts'), true);
  assert.equal((await invoke('studio:init')).workspace.name, path.basename(project));
});

test('async search, editor save with an out-of-project checkpoint, and undo', async () => {
  const hits = await invoke('studio:search', 'answer');
  assert(hits.some(h => h.path === 'src/app.ts' && h.line === 1));
  const saved = await invoke('studio:write-file', 'src/app.ts', 'export const answer = 43;\n');
  assert(saved.checkpoint);
  assert.equal(fs.existsSync(path.join(project, '.gps_backups')), false, 'project must stay clean');
  const cps = await invoke('agent:checkpoints');
  assert.equal(cps[0].source, 'editor');
  await invoke('agent:undo', cps[0].id, false);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
});

test('open-in-editor goes through the project sandbox and Electron shell (URL with line, default-app fallback, outside paths refused)', async () => {
  global.__openedUrls = []; global.__openedPaths = [];
  const r = await invoke('agent:open-in-editor', 'src/app.ts', 1, 'cursor');
  assert.equal(r.opened, 'url');
  assert.equal(global.__openedUrls.length, 1);
  assert.ok(global.__openedUrls[0].startsWith('cursor://file/') && global.__openedUrls[0].endsWith('/src/app.ts:1:1'), global.__openedUrls[0]);
  const d = await invoke('agent:open-in-editor', 'src/app.ts', 5, 'default');
  assert.equal(d.opened, 'path');
  assert.equal(global.__openedPaths.length, 1);
  await assert.rejects(() => invoke('agent:open-in-editor', '../outside.txt', 1, 'vscode'));
  await assert.rejects(() => invoke('agent:open-in-editor', 'src/nope.ts', 1, 'vscode'));
  assert.equal(global.__openedUrls.length, 1, 'refused paths never reach the shell');
});

test('chat mode: new session opens a new Gemini chat; follow-up must stay in the same conversation; mismatch auto-resends full context', async () => {
  const j1 = await invoke('studio:send', 'Giải thích answer', '', false);
  let next = await http('/v1/next');
  assert.equal(next.job.id, j1.id);assert.equal(next.job.newChat, true);assert.match(next.job.prompt, /FILE TREE/);
  await http('/v1/result', 'POST', { id: j1.id, status: 'final', text: 'trả lời 1', conversationUrl: 'https://gemini.google.com/app/chat111' });

  const j2 = await invoke('studio:send', 'Còn gì nữa?', '', true);
  next = await http('/v1/next');
  assert.equal(next.job.id, j2.id);assert.equal(next.job.newChat, false);
  assert.equal(next.job.expectConversation, 'https://gemini.google.com/app/chat111');
  assert.match(next.job.prompt, /CONTINUING CONVERSATION/);

  // Tab Gemini đang ở chat khác → extension báo lệch → main tự gửi lại kèm toàn bộ ngữ cảnh trong chat mới
  const before = sent.length;
  await http('/v1/result', 'POST', { id: j2.id, status: 'error', text: 'lệch', code: 'conversation_mismatch' });
  next = await http('/v1/next');
  assert.equal(next.job.id, j2.id, 'same job id so the renderer keeps tracking it');
  assert.equal(next.job.newChat, true);assert.match(next.job.prompt, /FILE TREE/);assert.doesNotMatch(next.job.prompt, /CONTINUING CONVERSATION/);
  assert.equal(jobUpdates(j2.id).some(u => u.status === 'error'), false, 'UI must never see the transient mismatch error');
  assert(sent.length > before);
  await http('/v1/result', 'POST', { id: j2.id, status: 'final', text: 'trả lời 2', conversationUrl: 'https://gemini.google.com/app/chat222' });
  assert.equal(jobUpdates(j2.id).at(-1).status, 'final');

  // Lịch sử cũ sau khi khởi động lại app (isFollowUp=true nhưng chưa có chat đang hoạt động) → không được bỏ snapshot
  const fresh = await invoke('studio:send', 'Câu hỏi mới', '', false);
  await http('/v1/next');
  await http('/v1/result', 'POST', { id: fresh.id, status: 'error', text: 'x', code: 'timeout' });
  const j3 = await invoke('studio:send', 'Hỏi tiếp sau lỗi', '', true);
  next = await http('/v1/next');
  assert.equal(next.job.id, j3.id);
  assert.equal(next.job.newChat, true, 'no completed turn in this chain → must resend everything in a new chat');
  assert.match(next.job.prompt, /FILE TREE/);
});

test('manual paste (import-reply) completes the job and reaches the UI through the same event stream', async () => {
  const j = await invoke('studio:send', 'thủ công', '', false);
  assert.equal(await invoke('studio:import-reply', j.id, 'dán tay'), true);
  assert.equal(jobUpdates(j.id).at(-1).status, 'final');
  assert.equal(jobUpdates(j.id).at(-1).answer, 'dán tay');
  await http('/v1/next'); // dọn hàng đợi
});

test('agent over IPC: events stream to the renderer; approval gate; Gemini-page proposals need approval', async () => {
  // dọn các job chat còn lại trong hàng đợi
  for (let i = 0; i < 5; i++) { const n = await http('/v1/next'); if (!n.job) break; }
  const st = await invoke('agent:start', 'Đổi answer thành 7');
  assert.equal(st.status !== 'idle', true);
  let next;
  for (let i = 0; i < 50; i++) { next = await http('/v1/next'); if (next.job) break; await sleep(20); }
  assert.match(next.job.prompt, /### edit_file/);assert.equal(next.job.newChat, true);
  const F = '`'.repeat(3);
  await http('/v1/result', 'POST', { id: next.job.id, status: 'final', text: `${F}gps-tool\ntool: edit_file\npath: src/app.ts\n<<<<<<< SEARCH\nanswer = 42\n=======\nanswer = 7\n>>>>>>> REPLACE\n${F}`, conversationUrl: 'https://gemini.google.com/app/agent1' });
  let snap;
  for (let i = 0; i < 100; i++) { snap = await invoke('agent:state'); if (snap.status === 'waiting_approval') break; await sleep(20); }
  assert.equal(snap.status, 'waiting_approval');
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
  assert(sent.some(s => s.ch === 'studio:agent' && s.payload.pending.length === 1), 'renderer got the approval request');
  await invoke('agent:approve', snap.pending[0].id, 'approve', '');
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.ts'), 'utf8'), 'export const answer = 7;\n');
  assert(sent.some(s => s.ch === 'studio:file-written' && s.payload.path === 'src/app.ts'), 'renderer told to refresh the file');
  await invoke('agent:cancel');

  // Trang Gemini đề xuất ghi file → chỉ tạo yêu cầu duyệt, không ghi
  const r = await http('/v1/write-file', 'POST', { path: 'src/app.ts', content: 'export const answer = 99;\n' });
  assert.equal(r.pending, true);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.ts'), 'utf8'), 'export const answer = 7;\n');
  const bad = await fetch(bridgeInfo.url + '/v1/write-file', { method: 'POST', headers: { Authorization: 'Bearer ' + bridgeInfo.token }, body: JSON.stringify({ path: '../../x.ts', content: 'y' }) });
  assert.equal(bad.status, 400);
  const pending = (await invoke('agent:state')).pending;
  assert.equal(pending.length, 1);assert.equal(pending[0].source, 'vibe');
  await invoke('agent:approve', pending[0].id, 'reject', '');
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.ts'), 'utf8'), 'export const answer = 7;\n');
});
