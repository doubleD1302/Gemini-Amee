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
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [project] }), showMessageBox: async () => ({ response: global.__commitChoice === undefined ? 0 : global.__commitChoice }) },
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
  for (const ch of ['studio:init', 'studio:choose-folder', 'studio:read-file', 'studio:write-file', 'studio:search', 'studio:prepare', 'studio:send', 'studio:import-reply', 'agent:state', 'agent:start', 'agent:reply', 'agent:retry', 'agent:rotate-next', 'agent:previous', 'agent:open-in-editor', 'agent:resume', 'agent:discard-previous', 'preview:status', 'preview:open', 'preview:close', 'preview:capture-attach', 'term:list', 'term:start', 'term:read', 'term:send', 'term:stop', 'term:stop-all', 'git:status', 'git:diff', 'git:commit', 'rules:get', 'rules:save', 'rules:save-skill', 'rules:delete-skill', 'rules:trust', 'rules:revoke', 'agent:sessions', 'agent:new-session', 'agent:close-session', 'agent:attach', 'agent:detach', 'agent:cancel', 'agent:approve', 'agent:set-policy', 'agent:job-prompt', 'agent:checkpoints', 'agent:undo']) assert(handlers.has(ch), ch);
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

test('rules and attachment IPC: saving trusts the user\'s own text, the trust record lives in userData, attachments flow through the runner', async () => {
  const saved = await invoke('rules:save', 'Luôn trả lời bằng tiếng Việt.');
  assert.equal(saved.path, '.gps/rules.md');
  assert.equal(saved.status, 'trusted');
  assert.equal((await invoke('rules:get')).status, 'trusted');
  assert(fs.existsSync(path.join(userData, 'rules', 'rules-trust.json')), 'trust record is outside the project');
  assert.deepEqual(fs.readdirSync(project).filter(n => n.includes('trust')), []);
  fs.writeFileSync(path.join(project, '.gps', 'rules.md'), 'bị sửa từ bên ngoài');
  const review = await invoke('rules:get');
  assert.equal(review.status, 'review');
  await assert.rejects(async () => invoke('rules:trust', 'hash-cu'), /đã thay đổi/);
  assert.equal((await invoke('rules:trust', review.hash)).status, 'trusted');
  await invoke('rules:save-skill', 'demo', '---\ndescription: Thử\n---\n');
  assert.equal((await invoke('rules:get')).skills[0].description, 'Thử');
  assert.equal((await invoke('rules:delete-skill', 'demo')).skills.length, 0);
  await assert.rejects(async () => invoke('rules:save-skill', '../evil', 'x'), /Tên kỹ năng/);

  const att = await invoke('agent:attach', 'log.txt', Buffer.from('lỗi: x').toString('base64'));
  assert.equal(att.kind, 'text');
  assert.equal((await invoke('agent:state')).attachments.length, 1);
  await assert.rejects(async () => invoke('agent:attach', '.env', Buffer.from('K=1').toString('base64')), /nhạy cảm/);
  assert.equal(await invoke('agent:detach', att.id), true);
  assert.equal((await invoke('agent:state')).attachments.length, 0);
  const info = await invoke('studio:connection');
  assert.equal(info.protocol, 2);
  assert.equal('token' in info, false);
});

test('git over IPC: status/diff are read-only; a commit needs the native confirmation dialog and only includes the ticked paths', async () => {
  const { execFileSync } = require('node:child_process');
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return; }   // sin git: bỏ qua
  const G = (...a) => execFileSync('git', a, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  G('init', '-q'); G('config', 'user.name', 'T'); G('config', 'user.email', 't@e.c'); G('config', 'commit.gpgsign', 'false');
  G('add', '-A'); G('commit', '-q', '-m', 'init');
  const count = () => Number(G('rev-list', '--count', 'HEAD'));
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const answer = 1000;\n');
  fs.writeFileSync(path.join(project, 'src', 'extra.ts'), 'export const extra = 1;\n');

  const st = await invoke('git:status');
  assert.equal(st.repo, true);
  assert.deepEqual(st.files.map(f => f.path).sort(), ['src/app.ts', 'src/extra.ts']);
  assert.match((await invoke('git:diff', 'src/app.ts', false)).diff, /\+export const answer = 1000;/);
  await assert.rejects(async () => invoke('git:diff', '../../etc/passwd', false), /bị chặn/);

  const shown = [];
  let choice = 1;
  electronStub.dialog.showMessageBox = async (_win, opts) => { shown.push(opts); return { response: choice }; };
  try {
    // invalid requests fail BEFORE any dialog is shown
    await assert.rejects(async () => invoke('git:commit', { message: '', paths: ['src/app.ts'] }), /Thiếu thông điệp/);
    await assert.rejects(async () => invoke('git:commit', { message: 'm', paths: ['nope.ts'] }), /không có thay đổi nào/);
    await assert.rejects(async () => invoke('git:commit', null), /Thiếu thông điệp/);
    assert.equal(shown.length, 0);
    // người dùng bấm Huỷ trong hộp thoại hệ thống → không commit
    await assert.rejects(async () => invoke('git:commit', { message: 'Đổi answer', paths: ['src/app.ts'] }), /Đã huỷ commit/);
    assert.equal(shown.length, 1);
    assert.match(shown[0].detail, /Đổi answer[\s\S]*src\/app\.ts \(sửa\)[\s\S]*Git hook: tắt · Studio không push/);
    assert.ok(!shown[0].detail.includes('extra.ts'), 'unticked file is not part of the confirmation');
    assert.equal(count(), 1);
    // đồng ý → commit đúng một file
    choice = 0;
    const r = await invoke('git:commit', { message: 'Đổi answer', paths: ['src/app.ts'], hooks: 'yes-please' });
    assert.equal(r.ok, true);
    assert.equal(count(), 2);
    assert.match(shown[1].detail, /Git hook: tắt/, 'only the boolean true enables hooks');
    assert.deepEqual(G('show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).filter(Boolean), ['src/app.ts']);
    assert.deepEqual((await invoke('git:status')).files.map(f => f.path), ['src/extra.ts']);
  } finally { electronStub.dialog.showMessageBox = async () => ({ response: 0 }); }
});

test('terminal over IPC: user-started background process, log reads, input, stop; switching project stops everything', async () => {
  const echo = `node -e "console.log('ready');process.stdin.on('data',d=>console.log('echo:'+String(d).trim()))"`;
  const p = await invoke('term:start', echo, 'demo');
  assert.equal(p.status, 'running');
  assert.equal(p.source, 'user');
  for (let i = 0; i < 100 && !(await invoke('term:read', p.id)).text.includes('ready'); i++) await sleep(50);
  const first = await invoke('term:read', p.id);
  assert.match(first.text, /ready/);
  await invoke('term:send', p.id, 'xin chào');
  for (let i = 0; i < 100 && !(await invoke('term:read', p.id, first.to)).text.includes('echo:xin chào'); i++) await sleep(50);
  assert.match((await invoke('term:read', p.id, first.to)).text, /echo:xin chào/);
  assert.equal((await invoke('term:list')).length >= 1, true);
  assert(sent.some(s => s.ch === 'studio:terminal'), 'renderer receives live terminal updates');
  await assert.rejects(async () => invoke('term:read', 'p9999'), /Không có tiến trình/);
  await assert.rejects(async () => invoke('term:start', '   '), /Thiếu lệnh/);
  // đổi project → mọi tiến trình nền bị dừng
  await invoke('studio:choose-folder');
  for (let i = 0; i < 200 && (await invoke('term:list')).some(x => x.status === 'running'); i++) await sleep(50);
  assert.equal((await invoke('term:list')).some(x => x.status === 'running'), false);
  await sleep(1500);   // Windows: để taskkill nhả thư mục làm việc trước khi test dọn dẹp
});

test('parallel sessions over IPC: separate runners, sessionId on every state event, at most 3, main cannot be closed, project switch drops the extras', async () => {
  assert.deepEqual((await invoke('agent:sessions')).map(s => s.id), ['main']);
  const s2 = await invoke('agent:new-session');
  assert.equal(s2, 's2');
  const s3 = await invoke('agent:new-session');
  assert.equal(s3, 's3');
  await assert.rejects(async () => invoke('agent:new-session'), /Tối đa 3 phiên/);
  assert.deepEqual((await invoke('agent:sessions')).map(s => s.id), ['main', 's2', 's3']);
  // mỗi phiên có trạng thái riêng; sid vắng mặt = phiên chính
  const before = (await invoke('agent:state')).id;
  await invoke('agent:attach', 'ghi-chu.txt', Buffer.from('chỉ phiên 2').toString('base64'), 's2');
  assert.equal((await invoke('agent:state', 's2')).attachments.length, 1);
  assert.equal((await invoke('agent:state', 'main')).attachments.length, 0);
  assert.equal((await invoke('agent:state')).id, before);
  assert(sent.some(s => s.ch === 'studio:agent' && s.payload.sessionId === 's2'), 'state events carry the session id');
  assert(sent.some(s => s.ch === 'studio:sessions'), 'renderer is told when the session list changes');
  await assert.rejects(async () => invoke('agent:state', 's7'), /Phiên không tồn tại/);
  await assert.rejects(async () => invoke('agent:close-session', 'main'), /Không đóng được/);
  const left = await invoke('agent:close-session', 's3');
  assert.deepEqual(left.map(s => s.id), ['main', 's2']);
  await assert.rejects(async () => invoke('agent:state', 's3'), /Phiên không tồn tại/);
  // đổi project → phiên song song thuộc project cũ bị bỏ
  await invoke('studio:choose-folder');
  assert.deepEqual((await invoke('agent:sessions')).map(s => s.id), ['main']);
});

test('web preview over IPC: invalid or non-local URLs are refused before any window exists; capture needs an open page', async () => {
  assert.deepEqual(await invoke('preview:status'), { open: false, url: '' });
  await assert.rejects(async () => invoke('preview:open', 'https://evil.com'), /Chỉ xem trước được trang chạy trên máy này/);
  await assert.rejects(async () => invoke('preview:open', 'file:///etc/passwd'), /Chỉ hỗ trợ http/);
  await assert.rejects(async () => invoke('preview:capture-attach', 'main'), /Chưa mở trang xem trước/);
  assert.equal((await invoke('agent:state')).attachments.length, 0);
  assert.deepEqual(await invoke('preview:close'), { open: false, url: '' });
});
